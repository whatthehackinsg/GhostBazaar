/**
 * DeadlineEnforcer — periodic scanner that auto-expires sessions.
 *
 * Two responsibilities:
 * 1. RFQ deadline: OPEN/NEGOTIATING/COMMIT_PENDING -> EXPIRED when rfq.deadline passes
 * 2. Cosign timeout: COMMIT_PENDING -> NEGOTIATING (via COSIGN_TIMEOUT) after timeout
 *
 * DEPLOYMENT: Single engine instance only. Uses process-local SessionManager locks.
 * Uses self-scheduling setTimeout to prevent overlapping scans.
 */

import type { SessionManager } from "./state/session-manager.js"
import { SessionBusyError } from "./state/session-manager.js"
import type { EventStore } from "./types.js"
import type { ConnectionTracker } from "./util/connection-tracker.js"

const TERMINAL_STATES: ReadonlySet<string> = new Set(["COMMITTED", "EXPIRED", "CANCELLED"])
const EXPIRABLE_STATES: ReadonlySet<string> = new Set(["OPEN", "NEGOTIATING", "COMMIT_PENDING"])

const DEFAULT_INTERVAL_MS = 1_000
const MIN_INTERVAL_MS = 500
const MAX_INTERVAL_MS = 10_000
const DEFAULT_COSIGN_TIMEOUT_MS = 60_000
const MIN_COSIGN_TIMEOUT_MS = 15_000
const MAX_COSIGN_TIMEOUT_MS = 120_000

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

export interface DeadlineEnforcerConfig {
  readonly sessionManager: SessionManager
  readonly eventStore: EventStore
  readonly connectionTracker: ConnectionTracker
  readonly tombstones?: { sweep(): void }
  readonly intervalMs?: number
  readonly cosignTimeoutMs?: number
}

export class DeadlineEnforcer {
  private readonly sessionManager: SessionManager
  private readonly eventStore: EventStore
  private readonly connectionTracker: ConnectionTracker
  private readonly tombstones: { sweep(): void } | undefined
  private readonly intervalMs: number
  private readonly cosignTimeoutMs: number
  private readonly cleanedUpSessions = new Set<string>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false

  constructor(config: DeadlineEnforcerConfig) {
    this.sessionManager = config.sessionManager
    this.eventStore = config.eventStore
    this.connectionTracker = config.connectionTracker
    this.tombstones = config.tombstones
    this.intervalMs = clamp(config.intervalMs ?? DEFAULT_INTERVAL_MS, MIN_INTERVAL_MS, MAX_INTERVAL_MS)
    this.cosignTimeoutMs = clamp(config.cosignTimeoutMs ?? DEFAULT_COSIGN_TIMEOUT_MS, MIN_COSIGN_TIMEOUT_MS, MAX_COSIGN_TIMEOUT_MS)
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.scheduleNext()
  }

  stop(): void {
    this.running = false
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private scheduleNext(): void {
    if (!this.running) return
    this.timer = setTimeout(async () => {
      try {
        await this.scan()
      } catch {
        // Unexpected error must not kill the enforcer loop
      }
      this.scheduleNext()
    }, this.intervalMs)
    if (typeof this.timer === "object" && "unref" in this.timer) {
      this.timer.unref()
    }
  }

  private async scan(): Promise<void> {
    const allIds = this.sessionManager.getActiveSessionIds()

    for (const rfqId of allIds) {
      if (!this.running) break
      if (this.cleanedUpSessions.has(rfqId)) continue

      // Per-session try/catch — one corrupted session must not abort enforcement
      // for all subsequent sessions in this scan tick. (Red Team F3 fix)
      try {
        const session = this.sessionManager.getSession(rfqId)
        if (!session) continue

        // Clean up already-terminal sessions
        if (TERMINAL_STATES.has(session.state)) {
          this.connectionTracker.closeAll(rfqId)
          if (this.sessionManager.removeLock(rfqId)) {
            this.cleanedUpSessions.add(rfqId)
          }
          continue
        }

        const now = Date.now()

        // Check 1: RFQ deadline expiry
        if (EXPIRABLE_STATES.has(session.state)) {
          const deadlineMs = new Date(session.rfq.deadline).getTime()
          if (now >= deadlineMs) {
            await this.tryExpire(rfqId)
            continue
          }
        }

        // Check 2: Cosign timeout
        if (session.state === "COMMIT_PENDING" && session.commitPendingAt !== null) {
          const commitMs = new Date(session.commitPendingAt).getTime()
          if (now - commitMs >= this.cosignTimeoutMs) {
            await this.tryCosignTimeout(rfqId)
          }
        }
      } catch {
        // Skip this session, continue scanning others.
        // In production this would be logged. The session will be retried next scan.
      }
    }

    // Sweep expired tombstones (Fix #2 — EnvelopeTombstones.sweep was never called)
    this.tombstones?.sweep()

    // Evict stale session cache entries (5 min TTL for non-terminal sessions)
    this.sessionManager.evictStaleCache(300_000)

    // Bound the cleanedUpSessions set to prevent unbounded growth (Fix #8).
    // Evict oldest half instead of full clear to avoid re-scanning all terminal
    // sessions on the next tick. Set iterates in insertion order per ES2015 spec.
    if (this.cleanedUpSessions.size > 10_000) {
      const toEvict = Math.floor(this.cleanedUpSessions.size / 2)
      let count = 0
      for (const id of this.cleanedUpSessions) {
        if (count >= toEvict) break
        this.cleanedUpSessions.delete(id)
        count++
      }
    }
  }

  private async tryExpire(rfqId: string): Promise<void> {
    try {
      await this.sessionManager.withLock(rfqId, async (lockedSession) => {
        if (!lockedSession) return
        if (TERMINAL_STATES.has(lockedSession.state)) return
        if (!EXPIRABLE_STATES.has(lockedSession.state)) return
        if (Date.now() < new Date(lockedSession.rfq.deadline).getTime()) return

        this.sessionManager.appendEvent(rfqId, {
          event_id: crypto.randomUUID(),
          rfq_id: rfqId,
          type: "NEGOTIATION_EXPIRED",
          timestamp: new Date().toISOString(),
          actor: "engine/deadline-enforcer",
          payload: {},
        })
      })
    } catch (e) {
      if (e instanceof SessionBusyError) return
      throw e
    }
  }

  private async tryCosignTimeout(rfqId: string): Promise<void> {
    try {
      await this.sessionManager.withLock(rfqId, async (lockedSession) => {
        if (!lockedSession) return
        if (lockedSession.state !== "COMMIT_PENDING") return
        if (!lockedSession.commitPendingAt) return
        if (Date.now() - new Date(lockedSession.commitPendingAt).getTime() < this.cosignTimeoutMs) return

        const seller = lockedSession.selectedSeller
        if (!seller) return

        this.sessionManager.appendEvent(rfqId, {
          event_id: crypto.randomUUID(),
          rfq_id: rfqId,
          type: "COSIGN_TIMEOUT",
          timestamp: new Date().toISOString(),
          actor: "engine/deadline-enforcer",
          payload: { seller },
        })
      })
    } catch (e) {
      if (e instanceof SessionBusyError) return
      throw e
    }
  }
}
