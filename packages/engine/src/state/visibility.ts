/**
 * Shared utilities for EventStore implementations.
 *
 * SINGLE SOURCE OF TRUTH for event visibility, deep-freeze, and terminal detection.
 * Both InMemoryEventStore and SqliteEventStore import from here — no duplication.
 */

import type { RFQ } from "@ghost-bazaar/core"
import type { NegotiationEvent, EventType } from "../types.js"

// ---------------------------------------------------------------------------
// Deep-freeze utility — ensures event immutability at runtime
// ---------------------------------------------------------------------------

export function deepFreeze<T extends object>(obj: T): Readonly<T> {
  const frozen = Object.freeze(obj)
  for (const val of Object.values(frozen)) {
    if (val !== null && typeof val === "object" && !Object.isFrozen(val)) {
      deepFreeze(val as object)
    }
  }
  return frozen
}

// ---------------------------------------------------------------------------
// Terminal event types — trigger subscribeTerminal() notifications
// ---------------------------------------------------------------------------

export const TERMINAL_EVENT_TYPES: ReadonlySet<EventType> = new Set([
  "QUOTE_COMMITTED",
  "NEGOTIATION_EXPIRED",
  "NEGOTIATION_CANCELLED",
])

// ---------------------------------------------------------------------------
// Event visibility — determines which events a caller can see
//
// This is the security-critical filter. All read paths (getEvents, subscribe)
// delegate to this function. The filtering happens INSIDE the EventStore,
// not at the application layer — making it structurally impossible to
// accidentally return unfiltered events.
//
// IMPORTANT: callerDid must be a verified session participant before reaching
// this filter. Route-level middleware is responsible for rejecting third-party
// DIDs that have never participated in the session. This filter only handles
// buyer-vs-seller scoping among authenticated participants.
// ---------------------------------------------------------------------------

/**
 * Role-scoped event visibility filter.
 *
 * Buyer sees everything (protocol-intended information advantage).
 * Seller (verified participant) sees only events relevant to them:
 *   - RFQ_CREATED: always (needed to respond)
 *   - OFFER_SUBMITTED: only their own (actor match)
 *   - COUNTER_SENT: only counters addressed to them (payload.to match)
 *   - WINNER_SELECTED / COMMIT_PENDING: only when they are the selected seller
 *   - QUOTE_SIGNED / QUOTE_COMMITTED: only when they are the quote's seller
 *   - COSIGN_DECLINED / COSIGN_TIMEOUT: only when they are the affected seller
 *   - NEGOTIATION_EXPIRED / NEGOTIATION_CANCELLED: broadcast to all participants
 *
 * This function is the single security gate — every read path funnels through it.
 */
export function isEventVisibleTo(
  event: NegotiationEvent,
  callerDid: string,
  rfq: Pick<RFQ, "buyer">,
): boolean {
  // Buyer sees all events
  if (callerDid === rfq.buyer) return true

  // Seller visibility by event type
  switch (event.type) {
    // Always visible — seller needs the RFQ to submit offers
    case "RFQ_CREATED":
    // Terminal events — broadcast to all participants
    case "NEGOTIATION_EXPIRED":
    case "NEGOTIATION_CANCELLED":
      return true

    // Seller sees only their own offers
    case "OFFER_SUBMITTED":
      return event.actor === callerDid

    // Seller sees only counters addressed to them
    case "COUNTER_SENT": {
      const to = event.payload["to"]
      return typeof to === "string" && to === callerDid
    }

    // Quote-flow events — visible only to the selected seller
    case "WINNER_SELECTED":
    case "COMMIT_PENDING":
    case "QUOTE_SIGNED":
    case "QUOTE_COMMITTED":
    // Rollback events — visible only to the affected seller
    case "COSIGN_DECLINED":
    case "COSIGN_TIMEOUT":
    // Settlement audit event — visible to the selected seller
    case "SETTLEMENT_CONFIRMED": {
      const seller = event.payload["seller"]
      return typeof seller === "string" && seller === callerDid
    }

    default:
      // Unknown event types are hidden by default (deny-by-default)
      return false
  }
}
