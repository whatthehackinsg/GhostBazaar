import type { RFQ } from "@ghost-bazaar/core"

// ---------------------------------------------------------------------------
// Session State Machine — Spec §7
// ---------------------------------------------------------------------------

export const SessionState = {
  OPEN: "OPEN",
  NEGOTIATING: "NEGOTIATING",
  COMMIT_PENDING: "COMMIT_PENDING",
  COMMITTED: "COMMITTED",
  EXPIRED: "EXPIRED",
  CANCELLED: "CANCELLED",
} as const

export type SessionState = (typeof SessionState)[keyof typeof SessionState]

// ---------------------------------------------------------------------------
// Event Types — 11 events that drive the state machine
//
// 9 core events + 2 rollback events (COSIGN_DECLINED, COSIGN_TIMEOUT)
// that drive COMMIT_PENDING → NEGOTIATING transitions.
// ---------------------------------------------------------------------------

export const EVENT_TYPES = [
  "RFQ_CREATED",
  "OFFER_SUBMITTED",
  "COUNTER_SENT",
  "WINNER_SELECTED",
  "COMMIT_PENDING",
  "QUOTE_SIGNED",
  "QUOTE_COMMITTED",
  "COSIGN_DECLINED",
  "COSIGN_TIMEOUT",
  "NEGOTIATION_EXPIRED",
  "NEGOTIATION_CANCELLED",
  "SETTLEMENT_CONFIRMED",
] as const

export type EventType = (typeof EVENT_TYPES)[number]

// ---------------------------------------------------------------------------
// NegotiationEvent — the append-only event log entry
// ---------------------------------------------------------------------------

export interface NegotiationEvent {
  readonly event_id: string
  readonly rfq_id: string
  readonly type: EventType
  readonly timestamp: string
  readonly actor: string
  readonly payload: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// EventStore interface — persistence abstraction boundary
//
// All route and state machine code depends ONLY on this interface.
// InMemoryEventStore is the MVP implementation; future SqliteEventStore
// or PostgresEventStore can be swapped without changing route code.
//
// SECURITY: getEvents() and subscribe() require callerDid + rfq for
// role-scoped filtering. It is impossible to retrieve unfiltered events.
// ---------------------------------------------------------------------------

/**
 * Public EventStore interface — exposed to route handlers.
 * All read methods require caller context for role-scoped filtering.
 */
export interface EventStore {
  /** Append an event to the log for the given RFQ session. */
  append(rfqId: string, event: NegotiationEvent): void

  /**
   * Retrieve events for a session, filtered by the caller's role.
   *
   * - Buyer (callerDid === rfq.buyer): sees all events
   * - Seller: sees RFQ_CREATED + own offers/counters addressed to them +
   *   terminal events (WINNER_SELECTED when they're the winner, QUOTE_* when
   *   they're the selected seller, EXPIRED, CANCELLED)
   *
   * @param afterId - Optional cursor: return only events after this event_id
   */
  getEvents(
    rfqId: string,
    callerDid: string,
    rfq: Pick<RFQ, "buyer">,
    afterId?: string,
  ): readonly NegotiationEvent[]

  /**
   * Subscribe to new events, filtered by the caller's role.
   * The listener is only called for events the caller is authorized to see.
   *
   * @returns Unsubscribe function
   */
  subscribe(
    rfqId: string,
    callerDid: string,
    rfq: Pick<RFQ, "buyer">,
    listener: (event: NegotiationEvent) => void,
  ): () => void

  /**
   * Total event count for a session (unfiltered — for internal use only).
   * Used for enforcing the 500-event session cap.
   */
  size(rfqId: string): number

  /**
   * Check if an event_id exists in the session's event log.
   * Used for cursor validation — returns true only if the event_id
   * belongs to THIS session (not a global check).
   *
   * CRITICAL: Must be session-scoped. The global seenEventIds set
   * must NOT be used — it would accept cursors from other sessions.
   */
  hasCursor(rfqId: string, eventId: string): boolean

  /**
   * Atomically replay events after a cursor and subscribe for new ones.
   * Eliminates the race between getEvents() and subscribe().
   *
   * Two-phase design:
   * Phase 1 (this call): Subscribe + replay + buffer. Returns replay
   *   events and any buffered live events. The listener is NOT called.
   * Phase 2 (activate()): Route calls after flushing replay+buffered
   *   to the client. Only then does the listener receive new events.
   *
   * Ordering contract: [...replay, ...buffered, ...live] — strict append order.
   */
  subscribeFrom(
    rfqId: string,
    callerDid: string,
    rfq: Pick<RFQ, "buyer">,
    afterId: string | undefined,
    listener: (event: NegotiationEvent) => void,
  ): {
    readonly replay: readonly NegotiationEvent[]
    readonly buffered: readonly NegotiationEvent[]
    readonly activate: () => void
    readonly unsubscribe: () => void
  }

  /**
   * Subscribe to session terminal state notification.
   * Fires once when any event transitions the session to COMMITTED/EXPIRED/CANCELLED.
   * Not role-scoped — this is a lifecycle signal, not a data event.
   */
  subscribeTerminal(
    rfqId: string,
    listener: (terminalState: string) => void,
  ): () => void
}

/**
 * Internal EventStore interface — extends EventStore with unfiltered access.
 * ONLY used by SessionManager for deriveState(). Route handlers MUST NOT
 * receive this interface — they should only see EventStore.
 */
export interface InternalEventStore extends EventStore {
  /** Retrieve ALL events unfiltered. For deriveState() and state derivation only. */
  getAllEvents(rfqId: string): readonly NegotiationEvent[]

  /** List all rfqIds that have at least one event. Used by deadline enforcer. */
  listSessionIds(): readonly string[]
}
