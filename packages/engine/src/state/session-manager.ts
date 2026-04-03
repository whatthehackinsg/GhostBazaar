import type { InternalEventStore, NegotiationEvent } from "../types.js"
import { deriveState } from "./session.js"
import type { DerivedSession } from "./session.js"

// ---------------------------------------------------------------------------
// SessionLock — per-session FIFO mutex
//
// Implements a FIFO queue where only the request that acquired the lock can
// release the next waiter. Timed-out waiters unlink themselves without
// advancing the queue.
//
// DESIGN DECISION: The lock only timeouts on ACQUISITION (waiting for a
// previous holder to finish). There is NO execution timeout on fn().
// Rationale: JS cannot cancel a running async function. An execution timeout
// that releases the lock while fn() is still running breaks exclusivity —
// the timed-out fn() can still mutate state after the next waiter starts.
// If fn() hangs, the lock is held until the process is restarted. This is
// a bug in the route handler, not the lock. The lock's sole job is
// exclusivity, not business logic timeouts.
// ---------------------------------------------------------------------------

const DEFAULT_LOCK_TIMEOUT_MS = 5_000
const DEFAULT_MAX_QUEUE_SIZE = 10

class SessionLock {
  private running = false
  private readonly waiters: Array<{
    resolve: () => void
    settled: boolean
  }> = []

  constructor(
    private readonly lockTimeoutMs: number = DEFAULT_LOCK_TIMEOUT_MS,
    private readonly maxQueueSize: number = DEFAULT_MAX_QUEUE_SIZE,
  ) {}

  get pending(): number {
    return this.waiters.length
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.waiters.length >= this.maxQueueSize) {
      throw new SessionBusyError(
        `Session lock queue full (${this.maxQueueSize} pending)`,
      )
    }

    // If no one is running, acquire immediately
    if (!this.running) {
      this.running = true
      try {
        return await fn()
      } finally {
        this.release()
      }
    }

    // Queue and wait for our turn
    const acquired = await this.waitForTurn()
    if (!acquired) {
      throw new SessionBusyError(
        `Session lock timeout (${this.lockTimeoutMs}ms)`,
      )
    }

    try {
      return await fn()
    } finally {
      this.release()
    }
  }

  private waitForTurn(): Promise<boolean> {
    return new Promise<boolean>((outerResolve) => {
      let timeoutId: ReturnType<typeof setTimeout>

      const waiter = {
        settled: false,
        resolve: () => {
          if (waiter.settled) return
          waiter.settled = true
          clearTimeout(timeoutId)
          outerResolve(true)
        },
      }

      this.waiters.push(waiter)

      timeoutId = setTimeout(() => {
        if (waiter.settled) return
        waiter.settled = true
        // Remove ourselves from the queue without advancing it
        const idx = this.waiters.indexOf(waiter)
        if (idx !== -1) this.waiters.splice(idx, 1)
        outerResolve(false)
      }, this.lockTimeoutMs)

      // Prevent timeout from keeping Node alive during shutdown
      if (typeof timeoutId === "object" && "unref" in timeoutId) {
        timeoutId.unref()
      }
    })
  }

  private release(): void {
    // Advance the queue — wake the next waiter
    if (this.waiters.length > 0) {
      const next = this.waiters.shift()!
      // next waiter inherits the running state
      next.resolve()
    } else {
      this.running = false
    }
  }
}

// ---------------------------------------------------------------------------
// SessionBusyError — thrown when lock acquisition fails
// ---------------------------------------------------------------------------

export class SessionBusyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SessionBusyError"
  }
}

// ---------------------------------------------------------------------------
// SessionManager — manages sessions with per-session FIFO locks
//
// Wraps InternalEventStore + deriveState into a convenient API for route
// handlers. Each rfq_id has its own lock — operations on different sessions
// run in parallel, operations on the same session are serialized.
// ---------------------------------------------------------------------------

export interface SessionManagerConfig {
  readonly lockTimeoutMs?: number
  readonly maxQueueSize?: number
}

export class SessionManager {
  private readonly locks = new Map<string, SessionLock>()
  /** Tracks which rfqIds are currently inside a withLock callback */
  private readonly activeLocks = new Set<string>()
  /** deriveState cache — keyed by rfqId, invalidated when event count changes.
   *  Eliminates ~75% of redundant event replays (route pre-check, withLock,
   *  dry-run all call getSession per request).
   *  lastAccessedAt enables TTL-based eviction of abandoned sessions. */
  private readonly sessionCache = new Map<string, {
    eventCount: number; session: DerivedSession; lastAccessedAt: number
  }>()
  /** Global append observers — StatsCollector, SSE feeds register here.
   *  Uses Set for O(1) unsubscribe on SSE disconnect. */
  private readonly appendObservers = new Set<(event: NegotiationEvent, session: DerivedSession) => void>()

  constructor(
    private readonly eventStore: InternalEventStore,
    private readonly config: SessionManagerConfig = {},
  ) {}

  /**
   * Register a global append observer. Called after every successful appendEvent().
   * Returns an unsubscribe function — MUST be called on SSE disconnect to prevent leaks.
   */
  onAppend(fn: (event: NegotiationEvent, session: DerivedSession) => void): () => void {
    this.appendObservers.add(fn)
    return () => { this.appendObservers.delete(fn) }
  }

  /**
   * Get the derived state for a session by replaying its event log.
   * Returns null if the session doesn't exist.
   * Uses a cache keyed by event count — safe because events are append-only.
   */
  getSession(rfqId: string): DerivedSession | null {
    const eventCount = this.eventStore.size(rfqId)
    if (eventCount === 0) return null

    const cached = this.sessionCache.get(rfqId)
    if (cached && cached.eventCount === eventCount) {
      cached.lastAccessedAt = Date.now()
      return cached.session
    }

    const events = this.eventStore.getAllEvents(rfqId)
    const session = deriveState([...events])
    if (session) {
      this.sessionCache.set(rfqId, { eventCount, session, lastAccessedAt: Date.now() })
    }
    return session
  }

  /**
   * Execute a function with exclusive access to a session.
   * The function receives the current derived state (may be null for new sessions).
   * Operations on the same rfq_id are serialized; different rfq_ids run in parallel.
   */
  async withLock<T>(
    rfqId: string,
    fn: (session: DerivedSession | null) => Promise<T>,
  ): Promise<T> {
    const lock = this.getOrCreateLock(rfqId)
    return lock.run(async () => {
      this.activeLocks.add(rfqId)
      try {
        const session = this.getSession(rfqId)
        return await fn(session)
      } finally {
        this.activeLocks.delete(rfqId)
      }
    })
  }

  /**
   * Validate and append an event transactionally.
   *
   * Performs a FULL dry-run: derives state from [...currentEvents, event].
   * If deriveState succeeds (valid transition + valid payload), the event is
   * persisted. If it throws (invalid transition, malformed payload, missing
   * fields), the event NEVER enters the log.
   *
   * Must be called within a withLock context for safety.
   */
  appendEvent(rfqId: string, event: NegotiationEvent): DerivedSession {
    // Runtime enforcement: appendEvent must be called inside withLock
    if (!this.activeLocks.has(rfqId)) {
      throw new Error(
        `SessionManager.appendEvent: must be called within withLock("${rfqId}") context`,
      )
    }

    const currentEvents = [...this.eventStore.getAllEvents(rfqId)]

    // Dry-run: attempt to derive state with the candidate event appended.
    // If this throws (invalid transition, malformed payload, missing fields),
    // the event is NOT persisted — the log remains clean.
    const candidateState = deriveState([...currentEvents, event])
    if (!candidateState) {
      throw new Error(
        `SessionManager: deriveState returned null after append — should not happen`,
      )
    }

    // Dry-run passed — safe to persist
    this.eventStore.append(rfqId, event)

    // Update cache with the new state (avoids re-derive on next getSession)
    this.sessionCache.set(rfqId, {
      eventCount: this.eventStore.size(rfqId),
      session: candidateState,
      lastAccessedAt: Date.now(),
    })

    // Notify global observers (StatsCollector, SSE feeds)
    for (const obs of this.appendObservers) {
      try { obs(event, candidateState) } catch { /* observer failure must not break append */ }
    }

    return candidateState
  }

  /**
   * List all rfqIds that have at least one event. Used by deadline enforcer.
   */
  getActiveSessionIds(): readonly string[] {
    return this.eventStore.listSessionIds()
  }

  /**
   * Check if a session exists.
   */
  hasSession(rfqId: string): boolean {
    return this.eventStore.size(rfqId) > 0
  }

  /**
   * Remove the lock for a session (call when session reaches terminal state).
   * Refuses removal if:
   *   - A callback is currently holding the lock (activeLocks)
   *   - Waiters are still queued (lock.pending > 0)
   * Returns true if removed, false if skipped (lock still active).
   */
  removeLock(rfqId: string): boolean {
    if (this.activeLocks.has(rfqId)) return false
    const lock = this.locks.get(rfqId)
    if (!lock) return true
    if (lock.pending > 0) return false
    this.locks.delete(rfqId)
    this.sessionCache.delete(rfqId)
    return true
  }

  /**
   * Evict cache entries not accessed within maxAgeMs.
   * Called by DeadlineEnforcer to prevent abandoned sessions from leaking memory.
   */
  evictStaleCache(maxAgeMs: number): void {
    const cutoff = Date.now() - maxAgeMs
    for (const [rfqId, entry] of this.sessionCache) {
      if (entry.lastAccessedAt < cutoff) {
        this.sessionCache.delete(rfqId)
      }
    }
  }

  private getOrCreateLock(rfqId: string): SessionLock {
    let lock = this.locks.get(rfqId)
    if (!lock) {
      lock = new SessionLock(
        this.config.lockTimeoutMs,
        this.config.maxQueueSize,
      )
      this.locks.set(rfqId, lock)
    }
    return lock
  }
}
