import { SessionState } from "../types.js"
import type { NegotiationEvent } from "../types.js"
import { isValidTransition } from "./state-machine.js"

// ---------------------------------------------------------------------------
// Runtime payload extraction — prevents state poisoning from malformed events
// ---------------------------------------------------------------------------

function str(payload: Record<string, unknown>, key: string, eventId: string): string {
  const val = payload[key]
  if (typeof val !== "string") {
    throw new Error(`deriveState: event ${eventId} missing or invalid string field "${key}"`)
  }
  return val
}

function num(payload: Record<string, unknown>, key: string, eventId: string): number {
  const val = payload[key]
  if (typeof val !== "number") {
    throw new Error(`deriveState: event ${eventId} missing or invalid number field "${key}"`)
  }
  return val
}

function optStr(payload: Record<string, unknown>, key: string): string | undefined {
  const val = payload[key]
  if (val === undefined || val === null) return undefined
  if (typeof val !== "string") return undefined
  return val
}

// ---------------------------------------------------------------------------
// DerivedSession — the full session state derived from event replay
//
// This is NEVER stored. It is always computed by reducing the event log.
// This guarantees that replaying the same events always produces identical state.
// ---------------------------------------------------------------------------

/** A recorded offer extracted from OFFER_SUBMITTED events. */
export interface RecordedOffer {
  readonly offer_id: string
  readonly seller: string
  readonly price: string
  readonly currency: string
  readonly valid_until: string
  /** Server-resolved listing ID at offer time (anti-redirection provenance). */
  readonly listing_id: string
  /** Server-resolved payment endpoint at offer time (anti-redirection provenance). */
  readonly payment_endpoint: string
  /** Preserved per Spec §5.7. */
  readonly extensions?: Record<string, unknown>
}

/** A recorded counter extracted from COUNTER_SENT events. */
export interface RecordedCounter {
  readonly counter_id: string
  readonly round: number
  readonly from: string
  readonly to: string
  readonly price: string
}

export interface DerivedSession {
  readonly state: SessionState
  readonly rfq: {
    readonly buyer: string
    readonly rfq_id: string
    readonly anchor_price: string
    readonly currency: string
    readonly deadline: string
    readonly service_type: string
    readonly budget_commitment?: string
    /** RFQ spec for spec_hash computation (Spec §5.5 SHOULD). */
    readonly spec?: Record<string, unknown>
  }
  readonly offers: readonly RecordedOffer[]
  readonly counters: readonly RecordedCounter[]
  readonly selectedSeller: string | null
  readonly selectedOfferId: string | null
  readonly quoteRevision: number
  readonly totalOfferCount: number
  readonly offerCountBySeller: ReadonlyMap<string, number>
  readonly totalAcceptAttempts: number
  readonly acceptAttemptsBySeller: ReadonlyMap<string, number>
  readonly lastEventId: string
  // ---------------------------------------------------------------------------
  // Quote state — derived from WINNER_SELECTED / QUOTE_SIGNED / QUOTE_COMMITTED
  // All quote data lives in events. No separate mutable QuoteStore.
  // ---------------------------------------------------------------------------
  /** Full unsigned quote from WINNER_SELECTED event. Null if no active commitment. */
  readonly unsignedQuote: Record<string, unknown> | null
  /** Buyer signature from QUOTE_SIGNED event. Null if buyer hasn't signed yet. */
  readonly buyerSignature: string | null
  /** Seller signature from QUOTE_COMMITTED event. Null if seller hasn't cosigned. */
  readonly sellerSignature: string | null
  // ---------------------------------------------------------------------------
  // Commitment timing — used by deadline enforcer for cosign timeout
  // ---------------------------------------------------------------------------
  /** ISO timestamp when WINNER_SELECTED moved session to COMMIT_PENDING. Null otherwise. */
  readonly commitPendingAt: string | null
}

// ---------------------------------------------------------------------------
// deriveState — pure reducer over the event log
//
// Returns null for empty event list. Throws on invalid transitions.
// This function is the single source of truth for session state.
// ---------------------------------------------------------------------------

export function deriveState(
  events: readonly NegotiationEvent[],
): DerivedSession | null {
  if (events.length === 0) return null

  const first = events[0]
  if (first.type !== "RFQ_CREATED") {
    throw new Error(
      `deriveState: first event must be RFQ_CREATED, got ${first.type}`,
    )
  }

  // Extract RFQ fields with runtime validation — prevents state poisoning
  const p = first.payload
  const eid = first.event_id
  const specVal = p.spec
  const rfq = {
    buyer: str(p, "buyer", eid),
    rfq_id: str(p, "rfq_id", eid),
    anchor_price: str(p, "anchor_price", eid),
    currency: str(p, "currency", eid),
    deadline: str(p, "deadline", eid),
    service_type: str(p, "service_type", eid),
    budget_commitment: optStr(p, "budget_commitment"),
    ...(specVal !== undefined && specVal !== null && typeof specVal === "object"
      ? { spec: specVal as Record<string, unknown> }
      : {}),
  }

  let state: SessionState = SessionState.OPEN
  let offers: RecordedOffer[] = []
  let counters: RecordedCounter[] = []
  let selectedSeller: string | null = null
  let selectedOfferId: string | null = null
  let quoteRevision = 0
  const offerCountBySeller = new Map<string, number>()
  let totalOfferCount = 0
  const acceptAttemptsBySeller = new Map<string, number>()
  let totalAcceptAttempts = 0
  let lastEventId = first.event_id
  // Quote state — derived from WINNER_SELECTED / QUOTE_SIGNED / QUOTE_COMMITTED
  let unsignedQuote: Record<string, unknown> | null = null
  let buyerSignature: string | null = null
  let sellerSignature: string | null = null
  let commitPendingAt: string | null = null

  // Process remaining events (skip RFQ_CREATED which initialized state)
  for (let i = 1; i < events.length; i++) {
    const event = events[i]
    lastEventId = event.event_id

    // Validate transition
    const result = isValidTransition(state, event.type)
    if (!result.valid) {
      throw new Error(
        `deriveState: invalid transition ${state} + ${event.type} at event ${event.event_id}`,
      )
    }

    // Apply state transition
    state = result.nextState

    // Extract typed fields per event type with runtime validation
    const ep = event.payload
    const eId = event.event_id
    switch (event.type) {
      case "OFFER_SUBMITTED": {
        const ext = ep.extensions
        const offer: RecordedOffer = {
          offer_id: str(ep, "offer_id", eId),
          seller: str(ep, "seller", eId),
          price: str(ep, "price", eId),
          currency: str(ep, "currency", eId),
          valid_until: str(ep, "valid_until", eId),
          listing_id: str(ep, "listing_id", eId),
          payment_endpoint: str(ep, "payment_endpoint", eId),
          ...(ext !== undefined && ext !== null && typeof ext === "object"
            ? { extensions: ext as Record<string, unknown> }
            : {}),
        }
        // Invariant: event.actor must match payload.seller
        if (event.actor !== offer.seller) {
          throw new Error(
            `deriveState: OFFER_SUBMITTED actor "${event.actor}" !== payload.seller "${offer.seller}" at ${eId}`,
          )
        }
        offers.push(offer)
        totalOfferCount++
        offerCountBySeller.set(
          offer.seller,
          (offerCountBySeller.get(offer.seller) ?? 0) + 1,
        )
        break
      }

      case "COUNTER_SENT": {
        const counter: RecordedCounter = {
          counter_id: str(ep, "counter_id", eId),
          round: num(ep, "round", eId),
          from: str(ep, "from", eId),
          to: str(ep, "to", eId),
          price: str(ep, "price", eId),
        }
        // Invariant: actor === from === rfq.buyer (only buyer can counter)
        if (event.actor !== counter.from) {
          throw new Error(
            `deriveState: COUNTER_SENT actor "${event.actor}" !== payload.from "${counter.from}" at ${eId}`,
          )
        }
        if (counter.from !== rfq.buyer) {
          throw new Error(
            `deriveState: COUNTER_SENT from "${counter.from}" !== rfq.buyer "${rfq.buyer}" at ${eId}`,
          )
        }
        // Invariant: counter.to must be a seller who has submitted an offer
        if (!offers.some((o) => o.seller === counter.to)) {
          throw new Error(
            `deriveState: COUNTER_SENT to "${counter.to}" has no recorded offer at ${eId}`,
          )
        }
        counters.push(counter)
        break
      }

      case "WINNER_SELECTED": {
        const seller = str(ep, "seller", eId)
        const offerId = str(ep, "offer_id", eId)
        // Invariant: only buyer can select a winner
        if (event.actor !== rfq.buyer) {
          throw new Error(
            `deriveState: WINNER_SELECTED actor "${event.actor}" !== rfq.buyer "${rfq.buyer}" at ${eId}`,
          )
        }
        // Invariant: referenced offer must exist
        const matchingOffer = offers.find((o) => o.offer_id === offerId)
        if (!matchingOffer) {
          throw new Error(
            `deriveState: WINNER_SELECTED offer_id "${offerId}" not found in recorded offers at ${eId}`,
          )
        }
        // Invariant: offer must belong to the selected seller
        if (matchingOffer.seller !== seller) {
          throw new Error(
            `deriveState: WINNER_SELECTED seller "${seller}" !== offer owner "${matchingOffer.seller}" at ${eId}`,
          )
        }
        selectedSeller = seller
        selectedOfferId = offerId
        quoteRevision++
        totalAcceptAttempts++
        acceptAttemptsBySeller.set(
          selectedSeller,
          (acceptAttemptsBySeller.get(selectedSeller) ?? 0) + 1,
        )
        // Store the full unsigned quote from the event payload.
        // This is the canonical unsigned quote built by the engine at accept time.
        // It contains quote_id, nonce, expires_at, payment_endpoint, memo_policy —
        // everything needed for crash recovery without a separate QuoteStore.
        const quotePayload = ep.quote
        if (quotePayload !== undefined && quotePayload !== null && typeof quotePayload === "object") {
          unsignedQuote = quotePayload as Record<string, unknown>
        }
        commitPendingAt = event.timestamp
        // Clear any prior signatures from a previous accept cycle
        buyerSignature = null
        sellerSignature = null
        break
      }

      case "COMMIT_PENDING": {
        // COMMIT_PENDING as an event is a no-op for state derivation.
        // The state transition is handled by WINNER_SELECTED → COMMIT_PENDING state.
        break
      }

      case "COSIGN_DECLINED":
      case "COSIGN_TIMEOUT": {
        const seller = str(ep, "seller", eId)
        // Invariant: must target the currently selected seller
        if (seller !== selectedSeller) {
          throw new Error(
            `deriveState: ${event.type} seller "${seller}" !== selectedSeller "${selectedSeller}" at ${eId}`,
          )
        }
        // Invariant: COSIGN_DECLINED actor must be the selected seller
        // (COSIGN_TIMEOUT actor is the engine/deadline enforcer, so we only check DECLINED)
        if (event.type === "COSIGN_DECLINED" && event.actor !== selectedSeller) {
          throw new Error(
            `deriveState: COSIGN_DECLINED actor "${event.actor}" !== selectedSeller "${selectedSeller}" at ${eId}`,
          )
        }
        // Rollback — clear ALL commitment state including quote fields.
        // CRITICAL: must clear unsignedQuote/buyerSignature/sellerSignature
        // to prevent stale quote data from a previous accept cycle leaking
        // into a subsequent accept for a different seller.
        selectedSeller = null
        selectedOfferId = null
        unsignedQuote = null
        buyerSignature = null
        sellerSignature = null
        commitPendingAt = null
        break
      }

      case "QUOTE_SIGNED": {
        const seller = str(ep, "seller", eId)
        // Invariant: must match the currently selected seller
        if (seller !== selectedSeller) {
          throw new Error(
            `deriveState: QUOTE_SIGNED seller "${seller}" !== selectedSeller "${selectedSeller}" at ${eId}`,
          )
        }
        // Invariant: actor must be the buyer (only buyer can sign the quote)
        if (event.actor !== rfq.buyer) {
          throw new Error(
            `deriveState: QUOTE_SIGNED actor "${event.actor}" !== rfq.buyer "${rfq.buyer}" at ${eId}`,
          )
        }
        // Extract buyer_signature from the event payload
        buyerSignature = str(ep, "buyer_signature", eId)
        break
      }

      case "QUOTE_COMMITTED": {
        const seller = str(ep, "seller", eId)
        // Invariant: must match the currently selected seller
        if (seller !== selectedSeller) {
          throw new Error(
            `deriveState: QUOTE_COMMITTED seller "${seller}" !== selectedSeller "${selectedSeller}" at ${eId}`,
          )
        }
        // Invariant: actor must be the selected seller (only selected seller can cosign)
        if (event.actor !== selectedSeller) {
          throw new Error(
            `deriveState: QUOTE_COMMITTED actor "${event.actor}" !== selectedSeller "${selectedSeller}" at ${eId}`,
          )
        }
        // Extract seller_signature from the event payload
        sellerSignature = str(ep, "seller_signature", eId)
        break
      }

      case "SETTLEMENT_CONFIRMED":
        // Self-loop audit event on COMMITTED — records on-chain payment verification.
        // No state change, no additional invariants beyond seller match (handled by
        // state-machine transition validation).
        break

      case "NEGOTIATION_EXPIRED":
      case "NEGOTIATION_CANCELLED":
        // Terminal events — no additional invariants
        break
    }
  }

  return {
    state,
    rfq,
    offers,
    counters,
    selectedSeller,
    selectedOfferId,
    quoteRevision,
    totalOfferCount,
    offerCountBySeller,
    totalAcceptAttempts,
    acceptAttemptsBySeller,
    lastEventId,
    unsignedQuote,
    buyerSignature,
    sellerSignature,
    commitPendingAt,
  }
}
