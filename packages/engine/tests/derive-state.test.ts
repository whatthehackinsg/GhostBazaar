import { describe, it, expect, beforeEach } from "vitest"
import { deriveState } from "../src/state/session.js"
import { SessionState } from "../src/types.js"
import type { NegotiationEvent, EventType } from "../src/types.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BUYER = "did:key:z6MkBuyerAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
const SELLER_A = "did:key:z6MkSellerAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB"
const SELLER_B = "did:key:z6MkSellerBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
const RFQ_ID = "rfq-derive-001"

let seq = 0
function makeEvent(
  type: EventType,
  actor: string,
  payload: Record<string, unknown> = {},
): NegotiationEvent {
  return {
    event_id: `evt-${++seq}`,
    rfq_id: RFQ_ID,
    type,
    timestamp: new Date().toISOString(),
    actor,
    payload: { rfq_id: RFQ_ID, ...payload },
  }
}

function rfqCreated(): NegotiationEvent {
  return makeEvent("RFQ_CREATED", BUYER, {
    protocol: "ghost-bazaar-v4",
    buyer: BUYER,
    service_type: "llm-inference",
    spec: {},
    anchor_price: "30.00",
    currency: "USDC",
    deadline: new Date(Date.now() + 300_000).toISOString(),
    signature: "ed25519:AAAA",
  })
}

function offerSubmitted(seller: string, offerId: string = `offer-${++seq}`): NegotiationEvent {
  return makeEvent("OFFER_SUBMITTED", seller, {
    offer_id: offerId,
    seller,
    price: "28.50",
    currency: "USDC",
    valid_until: new Date(Date.now() + 60_000).toISOString(),
    signature: "ed25519:BBBB",
    listing_id: `listing-${seller}`,
    payment_endpoint: `https://${seller}.example.com/execute`,
  })
}

function counterSent(to: string): NegotiationEvent {
  return makeEvent("COUNTER_SENT", BUYER, {
    counter_id: `counter-${++seq}`,
    round: 1,
    from: BUYER,
    to,
    price: "27.00",
    currency: "USDC",
    valid_until: new Date(Date.now() + 60_000).toISOString(),
    signature: "ed25519:CCCC",
  })
}

function winnerSelected(seller: string, offerId: string): NegotiationEvent {
  return makeEvent("WINNER_SELECTED", BUYER, {
    seller,
    offer_id: offerId,
    quote: {
      quote_id: `quote-${++seq}`,
      rfq_id: RFQ_ID,
      buyer: BUYER,
      seller,
      service_type: "llm-inference",
      final_price: "28.50",
      currency: "USDC",
      payment_endpoint: `https://${seller}.example.com/execute`,
      expires_at: new Date(Date.now() + 300_000).toISOString(),
      nonce: "0x" + "ab".repeat(32),
      memo_policy: "quote_id_required",
      buyer_signature: "",
      seller_signature: "",
    },
  })
}

function quoteSigned(seller: string): NegotiationEvent {
  return makeEvent("QUOTE_SIGNED", BUYER, {
    seller,
    buyer_signature: "ed25519:DDDD",
  })
}

function quoteCommitted(seller: string): NegotiationEvent {
  return makeEvent("QUOTE_COMMITTED", seller, {
    seller,
    seller_signature: "ed25519:EEEE",
  })
}

function cosignDeclined(seller: string): NegotiationEvent {
  return makeEvent("COSIGN_DECLINED", seller, { seller })
}

function cosignTimeout(seller: string): NegotiationEvent {
  return makeEvent("COSIGN_TIMEOUT", BUYER, { seller })
}

function expired(): NegotiationEvent {
  return makeEvent("NEGOTIATION_EXPIRED", "system", {})
}

function cancelled(): NegotiationEvent {
  return makeEvent("NEGOTIATION_CANCELLED", BUYER, {})
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("deriveState", () => {
  beforeEach(() => {
    seq = 0
  })

  // --- Empty / initial ---

  it("returns null for empty event list", () => {
    expect(deriveState([])).toBeNull()
  })

  // --- OPEN state ---

  it("RFQ_CREATED → OPEN state", () => {
    const state = deriveState([rfqCreated()])
    expect(state).not.toBeNull()
    expect(state!.state).toBe(SessionState.OPEN)
    expect(state!.rfq.buyer).toBe(BUYER)
    expect(state!.offers).toHaveLength(0)
    expect(state!.counters).toHaveLength(0)
    expect(state!.selectedSeller).toBeNull()
    expect(state!.quoteRevision).toBe(0)
  })

  // --- NEGOTIATING state ---

  it("first offer → NEGOTIATING", () => {
    const state = deriveState([rfqCreated(), offerSubmitted(SELLER_A)])
    expect(state!.state).toBe(SessionState.NEGOTIATING)
    expect(state!.offers).toHaveLength(1)
    expect(state!.offers[0].seller).toBe(SELLER_A)
  })

  it("multiple offers stay NEGOTIATING", () => {
    const state = deriveState([
      rfqCreated(),
      offerSubmitted(SELLER_A),
      offerSubmitted(SELLER_B),
    ])
    expect(state!.state).toBe(SessionState.NEGOTIATING)
    expect(state!.offers).toHaveLength(2)
  })

  it("counter stays NEGOTIATING", () => {
    const state = deriveState([
      rfqCreated(),
      offerSubmitted(SELLER_A),
      counterSent(SELLER_A),
    ])
    expect(state!.state).toBe(SessionState.NEGOTIATING)
    expect(state!.counters).toHaveLength(1)
  })

  // --- COMMIT_PENDING state ---
  // WINNER_SELECTED transitions NEGOTIATING → COMMIT_PENDING in one step

  it("WINNER_SELECTED → COMMIT_PENDING", () => {
    const state = deriveState([
      rfqCreated(),
      offerSubmitted(SELLER_A, "offer-winner"),
      winnerSelected(SELLER_A, "offer-winner"),
    ])
    expect(state!.state).toBe(SessionState.COMMIT_PENDING)
    expect(state!.selectedSeller).toBe(SELLER_A)
    expect(state!.quoteRevision).toBe(1)
  })

  it("QUOTE_SIGNED stays COMMIT_PENDING", () => {
    const state = deriveState([
      rfqCreated(),
      offerSubmitted(SELLER_A, "offer-w"),
      winnerSelected(SELLER_A, "offer-w"),
      quoteSigned(SELLER_A),
    ])
    expect(state!.state).toBe(SessionState.COMMIT_PENDING)
  })

  // --- COMMITTED state ---

  it("QUOTE_COMMITTED → COMMITTED", () => {
    const state = deriveState([
      rfqCreated(),
      offerSubmitted(SELLER_A, "offer-w"),
      winnerSelected(SELLER_A, "offer-w"),
      quoteSigned(SELLER_A),
      quoteCommitted(SELLER_A),
    ])
    expect(state!.state).toBe(SessionState.COMMITTED)
  })

  // --- Rollback paths ---

  it("COSIGN_DECLINED → back to NEGOTIATING", () => {
    const state = deriveState([
      rfqCreated(),
      offerSubmitted(SELLER_A, "offer-w"),
      winnerSelected(SELLER_A, "offer-w"),
      cosignDeclined(SELLER_A),
    ])
    expect(state!.state).toBe(SessionState.NEGOTIATING)
    expect(state!.selectedSeller).toBeNull()
  })

  it("COSIGN_TIMEOUT → back to NEGOTIATING", () => {
    const state = deriveState([
      rfqCreated(),
      offerSubmitted(SELLER_A, "offer-w"),
      winnerSelected(SELLER_A, "offer-w"),
      cosignTimeout(SELLER_A),
    ])
    expect(state!.state).toBe(SessionState.NEGOTIATING)
    expect(state!.selectedSeller).toBeNull()
  })

  it("after rollback, buyer can re-select a different seller", () => {
    const state = deriveState([
      rfqCreated(),
      offerSubmitted(SELLER_A, "offer-a"),
      offerSubmitted(SELLER_B, "offer-b"),
      winnerSelected(SELLER_A, "offer-a"),
      cosignDeclined(SELLER_A),
      // Re-select seller B
      winnerSelected(SELLER_B, "offer-b"),
    ])
    expect(state!.state).toBe(SessionState.COMMIT_PENDING)
    expect(state!.selectedSeller).toBe(SELLER_B)
    expect(state!.quoteRevision).toBe(2)
  })

  // --- Terminal states ---

  it("NEGOTIATION_EXPIRED → EXPIRED from any active state", () => {
    const fromOpen = deriveState([rfqCreated(), expired()])
    expect(fromOpen!.state).toBe(SessionState.EXPIRED)

    const fromNeg = deriveState([rfqCreated(), offerSubmitted(SELLER_A), expired()])
    expect(fromNeg!.state).toBe(SessionState.EXPIRED)
  })

  it("NEGOTIATION_CANCELLED → CANCELLED", () => {
    const state = deriveState([rfqCreated(), cancelled()])
    expect(state!.state).toBe(SessionState.CANCELLED)
  })

  // --- Event replay determinism (AC7) ---

  it("replaying the same events produces identical state (deterministic)", () => {
    const events = [
      rfqCreated(),
      offerSubmitted(SELLER_A, "offer-a"),
      offerSubmitted(SELLER_B, "offer-b"),
      counterSent(SELLER_A),
      winnerSelected(SELLER_A, "offer-a"),
      quoteSigned(SELLER_A),
      quoteCommitted(SELLER_A),
    ]

    const state1 = deriveState(events)
    const state2 = deriveState(events)

    expect(state1).toEqual(state2)
  })

  // --- Offer/counter tracking ---

  it("tracks per-seller offer counts", () => {
    const state = deriveState([
      rfqCreated(),
      offerSubmitted(SELLER_A, "o1"),
      offerSubmitted(SELLER_A, "o2"),
      offerSubmitted(SELLER_B, "o3"),
    ])
    expect(state!.offerCountBySeller.get(SELLER_A)).toBe(2)
    expect(state!.offerCountBySeller.get(SELLER_B)).toBe(1)
  })

  it("tracks total offer count", () => {
    const state = deriveState([
      rfqCreated(),
      offerSubmitted(SELLER_A, "o1"),
      offerSubmitted(SELLER_B, "o2"),
      offerSubmitted(SELLER_A, "o3"),
    ])
    expect(state!.totalOfferCount).toBe(3)
  })

  it("tracks accept attempts per seller", () => {
    const state = deriveState([
      rfqCreated(),
      offerSubmitted(SELLER_A, "offer-a"),
      winnerSelected(SELLER_A, "offer-a"),
      cosignDeclined(SELLER_A),
      // Second attempt
      winnerSelected(SELLER_A, "offer-a"),
    ])
    expect(state!.acceptAttemptsBySeller.get(SELLER_A)).toBe(2)
    expect(state!.totalAcceptAttempts).toBe(2)
  })

  // --- Invalid transition throws ---

  it("throws on invalid transition (OPEN + COUNTER_SENT)", () => {
    expect(() =>
      deriveState([rfqCreated(), counterSent(SELLER_A)]),
    ).toThrow(/invalid.*transition/i)
  })

  it("throws on event after terminal state", () => {
    expect(() =>
      deriveState([rfqCreated(), expired(), offerSubmitted(SELLER_A)]),
    ).toThrow(/invalid.*transition/i)
  })

  // --- commitPendingAt tracking ---

  describe("commitPendingAt", () => {
    it("is null for OPEN sessions", () => {
      const state = deriveState([rfqCreated()])
      expect(state!.commitPendingAt).toBeNull()
    })

    it("is null for NEGOTIATING sessions", () => {
      const state = deriveState([rfqCreated(), offerSubmitted(SELLER_A)])
      expect(state!.commitPendingAt).toBeNull()
    })

    it("is set to WINNER_SELECTED event timestamp when entering COMMIT_PENDING", () => {
      const events = [
        rfqCreated(),
        offerSubmitted(SELLER_A, "offer-a"),
        winnerSelected(SELLER_A, "offer-a"),
      ]
      const state = deriveState(events)
      expect(state!.state).toBe(SessionState.COMMIT_PENDING)
      // commitPendingAt must equal the timestamp of the WINNER_SELECTED event (index 2)
      expect(state!.commitPendingAt).toBe(events[2].timestamp)
    })

    it("is cleared on COSIGN_DECLINED rollback", () => {
      const state = deriveState([
        rfqCreated(),
        offerSubmitted(SELLER_A, "offer-a"),
        winnerSelected(SELLER_A, "offer-a"),
        cosignDeclined(SELLER_A),
      ])
      expect(state!.state).toBe(SessionState.NEGOTIATING)
      expect(state!.commitPendingAt).toBeNull()
    })

    it("is cleared on COSIGN_TIMEOUT rollback", () => {
      const state = deriveState([
        rfqCreated(),
        offerSubmitted(SELLER_A, "offer-a"),
        winnerSelected(SELLER_A, "offer-a"),
        cosignTimeout(SELLER_A),
      ])
      expect(state!.state).toBe(SessionState.NEGOTIATING)
      expect(state!.commitPendingAt).toBeNull()
    })

    it("is re-set on second WINNER_SELECTED after rollback", () => {
      const events = [
        rfqCreated(),
        offerSubmitted(SELLER_A, "offer-a"),
        offerSubmitted(SELLER_B, "offer-b"),
        winnerSelected(SELLER_A, "offer-a"),
        cosignDeclined(SELLER_A),
        winnerSelected(SELLER_B, "offer-b"),
      ]
      const state = deriveState(events)
      expect(state!.state).toBe(SessionState.COMMIT_PENDING)
      // Must be the timestamp of the second WINNER_SELECTED (index 5), not the first
      expect(state!.commitPendingAt).toBe(events[5].timestamp)
    })
  })

  // --- Cross-event invariant checks ---

  describe("invariant checks", () => {
    it("OFFER_SUBMITTED rejects actor !== payload.seller", () => {
      const badOffer = makeEvent("OFFER_SUBMITTED", "did:key:attacker", {
        offer_id: "o-bad",
        seller: SELLER_A, // mismatches actor
        price: "28.50",
        currency: "USDC",
        valid_until: new Date(Date.now() + 60_000).toISOString(),
        listing_id: "listing-A",
        payment_endpoint: "https://a.example.com/execute",
      })
      expect(() => deriveState([rfqCreated(), badOffer])).toThrow(
        /actor.*seller/i,
      )
    })

    it("COUNTER_SENT rejects actor !== payload.from", () => {
      const badCounter = makeEvent("COUNTER_SENT", "did:key:attacker", {
        counter_id: "c-bad",
        round: 1,
        from: BUYER, // mismatches actor
        to: SELLER_A,
        price: "27.00",
        currency: "USDC",
        valid_until: new Date(Date.now() + 60_000).toISOString(),
      })
      expect(() =>
        deriveState([rfqCreated(), offerSubmitted(SELLER_A), badCounter]),
      ).toThrow(/actor.*from/i)
    })

    it("COUNTER_SENT rejects from !== rfq.buyer", () => {
      const badCounter = makeEvent("COUNTER_SENT", SELLER_A, {
        counter_id: "c-bad",
        round: 1,
        from: SELLER_A, // not the buyer
        to: SELLER_A,
        price: "27.00",
        currency: "USDC",
        valid_until: new Date(Date.now() + 60_000).toISOString(),
      })
      expect(() =>
        deriveState([rfqCreated(), offerSubmitted(SELLER_A), badCounter]),
      ).toThrow(/from.*buyer/i)
    })

    it("COUNTER_SENT rejects to seller with no offer", () => {
      const counter = makeEvent("COUNTER_SENT", BUYER, {
        counter_id: "c-bad",
        round: 1,
        from: BUYER,
        to: "did:key:unknown-seller", // no offer from this seller
        price: "27.00",
        currency: "USDC",
        valid_until: new Date(Date.now() + 60_000).toISOString(),
      })
      expect(() =>
        deriveState([rfqCreated(), offerSubmitted(SELLER_A), counter]),
      ).toThrow(/no recorded offer/i)
    })

    it("WINNER_SELECTED rejects actor !== rfq.buyer", () => {
      const badWinner = makeEvent("WINNER_SELECTED", SELLER_A, {
        seller: SELLER_A,
        offer_id: "offer-a",
      })
      expect(() =>
        deriveState([rfqCreated(), offerSubmitted(SELLER_A, "offer-a"), badWinner]),
      ).toThrow(/actor.*buyer/i)
    })

    it("WINNER_SELECTED rejects nonexistent offer_id", () => {
      const badWinner = makeEvent("WINNER_SELECTED", BUYER, {
        seller: SELLER_A,
        offer_id: "nonexistent-offer",
      })
      expect(() =>
        deriveState([rfqCreated(), offerSubmitted(SELLER_A, "offer-a"), badWinner]),
      ).toThrow(/not found/i)
    })

    it("WINNER_SELECTED rejects offer that belongs to different seller", () => {
      const badWinner = makeEvent("WINNER_SELECTED", BUYER, {
        seller: SELLER_B, // claims seller B
        offer_id: "offer-a", // but offer belongs to seller A
      })
      expect(() =>
        deriveState([
          rfqCreated(),
          offerSubmitted(SELLER_A, "offer-a"),
          offerSubmitted(SELLER_B, "offer-b"),
          badWinner,
        ]),
      ).toThrow(/offer owner/i)
    })

    it("COSIGN_DECLINED rejects wrong seller", () => {
      const badDecline = makeEvent("COSIGN_DECLINED", SELLER_B, {
        seller: SELLER_B, // not the selected seller
      })
      expect(() =>
        deriveState([
          rfqCreated(),
          offerSubmitted(SELLER_A, "offer-a"),
          winnerSelected(SELLER_A, "offer-a"),
          badDecline,
        ]),
      ).toThrow(/selectedSeller/i)
    })

    it("QUOTE_COMMITTED rejects wrong seller", () => {
      const badCommit = makeEvent("QUOTE_COMMITTED", SELLER_B, {
        seller: SELLER_B, // not the selected seller
      })
      expect(() =>
        deriveState([
          rfqCreated(),
          offerSubmitted(SELLER_A, "offer-a"),
          winnerSelected(SELLER_A, "offer-a"),
          quoteSigned(SELLER_A),
          badCommit,
        ]),
      ).toThrow(/selectedSeller/i)
    })
  })
})
