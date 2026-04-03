/**
 * StatsCollector — in-memory aggregator for dashboard metrics.
 *
 * Architecture:
 *   - On startup: replays raw events from EventStore (NOT via SessionManager,
 *     to avoid filling the sessionCache with every historical session)
 *   - At runtime: registered via sessionManager.onAppend() for O(1) per-event updates
 *   - On read: pure memory access, zero queries
 *
 * Tracks a per-session ledger (Map<rfqId, SessionLedgerEntry>) for correct
 * state-transition counting. Without this, by_state counts would drift.
 */

import type { InternalEventStore, NegotiationEvent, EventType } from "../types.js"
import { SessionState } from "../types.js"
import type { DerivedSession } from "../state/session.js"

// ---------------------------------------------------------------------------
// Per-session ledger — tracks previous state for correct by_state counting
// ---------------------------------------------------------------------------

interface SessionLedgerEntry {
  state: string
  createdAt: string
  offerCount: number
  counterCount: number
  sellerDids: Set<string>
}

// ---------------------------------------------------------------------------
// Dashboard response types
// ---------------------------------------------------------------------------

export interface DashboardStats {
  readonly active_sessions: number
  readonly completed_deals: number
  readonly total_sessions: number
  readonly unique_buyers: number
  readonly unique_sellers: number
  readonly by_state: Readonly<Record<string, number>>
  readonly total_offers: number
  readonly total_counters: number
  readonly avg_offers_per_session: number
  readonly avg_rounds_per_session: number
  readonly avg_negotiation_duration_ms: number
  readonly success_rate: number
  readonly uptime: number
  readonly listings: number
}

export interface DashboardActivity {
  readonly events_per_minute: readonly number[]
  readonly new_sessions_last_hour: number
  readonly deals_last_hour: number
  readonly bucket_anchor_ms: number
}

// ---------------------------------------------------------------------------
// Circular buffer for per-minute event rates
// ---------------------------------------------------------------------------

const MINUTE_BUCKETS = 5
const MINUTE_MS = 60_000
const HOUR_MS = 3_600_000

// ---------------------------------------------------------------------------
// StatsCollector
// ---------------------------------------------------------------------------

const TERMINAL_STATES = new Set<string>([SessionState.COMMITTED, SessionState.EXPIRED, SessionState.CANCELLED])

export class StatsCollector {
  private readonly uniqueBuyers = new Set<string>()
  private readonly uniqueSellers = new Set<string>()
  private totalOffers = 0
  private totalCounters = 0
  private completedDeals = 0
  private terminalSessions = 0
  private totalDurationMs = 0
  private readonly byState: Record<string, number> = {
    [SessionState.OPEN]: 0,
    [SessionState.NEGOTIATING]: 0,
    [SessionState.COMMIT_PENDING]: 0,
    [SessionState.COMMITTED]: 0,
    [SessionState.EXPIRED]: 0,
    [SessionState.CANCELLED]: 0,
  }
  private readonly sessionLedger = new Map<string, SessionLedgerEntry>()

  // Per-minute event rate (circular buffer)
  private readonly minuteBuckets: number[] = new Array(MINUTE_BUCKETS).fill(0)
  private currentBucketIdx = 0
  private lastBucketRotation = Date.now()

  // Hourly counters (reset every hour)
  private newSessionsLastHour = 0
  private dealsLastHour = 0
  private lastHourlyReset = Date.now()

  private listingCount = 0

  /**
   * Initialize from raw events — does NOT go through SessionManager.
   * Avoids filling the sessionCache with every historical session.
   */
  constructor(eventStore: InternalEventStore, listingCount: number) {
    this.listingCount = listingCount
    for (const rfqId of eventStore.listSessionIds()) {
      const events = eventStore.getAllEvents(rfqId)
      for (const event of events) {
        this.processRawEvent(event)
      }
    }
  }

  /** Called on every successful append via sessionManager.onAppend() */
  onEvent(event: NegotiationEvent, session: DerivedSession): void {
    this.rotateMinuteBucket()
    this.rotateHourly()
    this.minuteBuckets[this.currentBucketIdx]++

    const rfqId = event.rfq_id
    const prev = this.sessionLedger.get(rfqId)

    if (!prev) {
      // New session
      this.sessionLedger.set(rfqId, {
        state: session.state,
        createdAt: event.timestamp,
        offerCount: 0,
        counterCount: 0,
        sellerDids: new Set(),
      })
      this.byState[session.state] = (this.byState[session.state] ?? 0) + 1
      this.newSessionsLastHour++
      this.uniqueBuyers.add(session.rfq.buyer)
    } else {
      // State transition
      if (prev.state !== session.state) {
        this.byState[prev.state] = Math.max(0, (this.byState[prev.state] ?? 0) - 1)
        this.byState[session.state] = (this.byState[session.state] ?? 0) + 1
        prev.state = session.state

        // Terminal state reached — compute duration + prune ledger entry
        if (TERMINAL_STATES.has(session.state)) {
          this.terminalSessions++
          const duration = new Date(event.timestamp).getTime() - new Date(prev.createdAt).getTime()
          if (duration > 0) this.totalDurationMs += duration
          if (session.state === SessionState.COMMITTED) {
            this.completedDeals++
            this.dealsLastHour++
          }
          // Free the sellerDids Set — no longer needed for terminal sessions.
          // Keep the entry itself for by_state counting (it's just a few scalars).
          prev.sellerDids.clear()
        }
      }
    }

    // Count offers and counters
    this.processEventType(event, rfqId)
  }

  getStats(): DashboardStats {
    const totalSessions = this.sessionLedger.size
    const activeCount = (this.byState[SessionState.OPEN] ?? 0) +
      (this.byState[SessionState.NEGOTIATING] ?? 0) +
      (this.byState[SessionState.COMMIT_PENDING] ?? 0)

    return {
      active_sessions: activeCount,
      completed_deals: this.completedDeals,
      total_sessions: totalSessions,
      unique_buyers: this.uniqueBuyers.size,
      unique_sellers: this.uniqueSellers.size,
      by_state: { ...this.byState },
      total_offers: this.totalOffers,
      total_counters: this.totalCounters,
      avg_offers_per_session: totalSessions > 0 ? Math.round((this.totalOffers / totalSessions) * 10) / 10 : 0,
      avg_rounds_per_session: totalSessions > 0 ? Math.round((this.totalCounters / totalSessions) * 10) / 10 : 0,
      avg_negotiation_duration_ms: this.terminalSessions > 0 ? Math.round(this.totalDurationMs / this.terminalSessions) : 0,
      success_rate: this.terminalSessions > 0 ? Math.round((this.completedDeals / this.terminalSessions) * 100) / 100 : 0,
      uptime: Math.floor(process.uptime()),
      listings: this.listingCount,
    }
  }

  getActivity(): DashboardActivity {
    this.rotateMinuteBucket()
    this.rotateHourly()
    // Return buckets from newest to oldest
    const buckets: number[] = []
    for (let i = 0; i < MINUTE_BUCKETS; i++) {
      const idx = (this.currentBucketIdx - i + MINUTE_BUCKETS) % MINUTE_BUCKETS
      buckets.push(this.minuteBuckets[idx])
    }
    return {
      events_per_minute: buckets,
      new_sessions_last_hour: this.newSessionsLastHour,
      deals_last_hour: this.dealsLastHour,
      bucket_anchor_ms: this.lastBucketRotation,
    }
  }

  setListingCount(count: number): void {
    this.listingCount = count
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  /** Process a raw event during startup replay (no DerivedSession available) */
  private processRawEvent(event: NegotiationEvent): void {
    const rfqId = event.rfq_id
    let entry = this.sessionLedger.get(rfqId)

    if (event.type === "RFQ_CREATED") {
      const buyer = event.actor
      this.uniqueBuyers.add(buyer)
      entry = {
        state: SessionState.OPEN,
        createdAt: event.timestamp,
        offerCount: 0,
        counterCount: 0,
        sellerDids: new Set(),
      }
      this.sessionLedger.set(rfqId, entry)
      this.byState[SessionState.OPEN] = (this.byState[SessionState.OPEN] ?? 0) + 1
    }

    if (!entry) return

    // State transitions (simplified replay — matches state-machine.ts transitions)
    const oldState = entry.state
    const newState = this.deriveNextState(oldState, event.type as EventType)
    if (newState && newState !== oldState) {
      this.byState[oldState] = Math.max(0, (this.byState[oldState] ?? 0) - 1)
      this.byState[newState] = (this.byState[newState] ?? 0) + 1
      entry.state = newState

      if (TERMINAL_STATES.has(newState)) {
        this.terminalSessions++
        const duration = new Date(event.timestamp).getTime() - new Date(entry.createdAt).getTime()
        if (duration > 0) this.totalDurationMs += duration
        if (newState === SessionState.COMMITTED) this.completedDeals++
        // Free seller DID set — same as live path (prevents memory growth on restart)
        entry.sellerDids.clear()
      }
    }

    this.processEventType(event, rfqId)
  }

  /** Update offer/counter/seller counts */
  private processEventType(event: NegotiationEvent, rfqId: string): void {
    const entry = this.sessionLedger.get(rfqId)
    if (event.type === "OFFER_SUBMITTED") {
      this.totalOffers++
      if (entry) {
        entry.offerCount++
        const seller = event.payload["seller"]
        if (typeof seller === "string") {
          entry.sellerDids.add(seller)
          this.uniqueSellers.add(seller)
        }
      }
    } else if (event.type === "COUNTER_SENT") {
      this.totalCounters++
      if (entry) entry.counterCount++
    }
  }

  /** Map event type to next state (simplified state machine for replay) */
  private deriveNextState(current: string, eventType: EventType): string | null {
    switch (eventType) {
      case "OFFER_SUBMITTED": return current === SessionState.OPEN ? SessionState.NEGOTIATING : null
      case "WINNER_SELECTED": return SessionState.COMMIT_PENDING
      case "QUOTE_COMMITTED": return SessionState.COMMITTED
      case "NEGOTIATION_EXPIRED": return SessionState.EXPIRED
      case "NEGOTIATION_CANCELLED": return SessionState.CANCELLED
      case "COSIGN_DECLINED":
      case "COSIGN_TIMEOUT": return current === SessionState.COMMIT_PENDING ? SessionState.NEGOTIATING : null
      default: return null
    }
  }

  /** Rotate minute bucket if needed */
  private rotateMinuteBucket(): void {
    const now = Date.now()
    const elapsed = now - this.lastBucketRotation
    if (elapsed >= MINUTE_MS) {
      const rotations = Math.min(Math.floor(elapsed / MINUTE_MS), MINUTE_BUCKETS)
      for (let i = 0; i < rotations; i++) {
        this.currentBucketIdx = (this.currentBucketIdx + 1) % MINUTE_BUCKETS
        this.minuteBuckets[this.currentBucketIdx] = 0
      }
      this.lastBucketRotation += rotations * MINUTE_MS
    }
  }

  /** Reset hourly counters if needed */
  private rotateHourly(): void {
    const now = Date.now()
    const elapsed = now - this.lastHourlyReset
    if (elapsed >= HOUR_MS) {
      this.newSessionsLastHour = 0
      this.dealsLastHour = 0
      this.lastHourlyReset += Math.floor(elapsed / HOUR_MS) * HOUR_MS
    }
  }
}
