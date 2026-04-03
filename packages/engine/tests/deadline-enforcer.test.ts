import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { InMemoryEventStore } from "../src/state/event-store.js"
import { SessionManager } from "../src/state/session-manager.js"
import { ConnectionTracker } from "../src/util/connection-tracker.js"
import { DeadlineEnforcer } from "../src/deadline-enforcer.js"
import type { NegotiationEvent, EventType } from "../src/types.js"

// ---------------------------------------------------------------------------
// Helpers — minimal fixtures that produce valid event sequences
// ---------------------------------------------------------------------------

const BUYER_DID = "did:key:z6MkBuyerAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
const SELLER_A_DID = "did:key:z6MkSellerAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB"
const RFQ_ID = "rfq-deadline-001"

function makeEvent(
  type: EventType,
  actor: string,
  payload: Record<string, unknown> = {},
  rfqId: string = RFQ_ID,
): NegotiationEvent {
  return {
    event_id: crypto.randomUUID(),
    rfq_id: rfqId,
    type,
    timestamp: new Date().toISOString(),
    actor,
    payload: { rfq_id: rfqId, ...payload },
  }
}

/**
 * Creates an RFQ_CREATED event with a configurable deadline.
 * deadlineMs: absolute time (Date.now() + offset) for the deadline.
 */
function makeRfqEvent(
  deadlineMs: number,
  rfqId: string = RFQ_ID,
): NegotiationEvent {
  return makeEvent("RFQ_CREATED", BUYER_DID, {
    protocol: "ghost-bazaar-v4",
    buyer: BUYER_DID,
    service_type: "llm-inference",
    spec: {},
    anchor_price: "30.00",
    currency: "USDC",
    deadline: new Date(deadlineMs).toISOString(),
    signature: "ed25519:AAAA",
  }, rfqId)
}

function makeOfferEvent(
  seller: string,
  rfqId: string = RFQ_ID,
): NegotiationEvent {
  return makeEvent("OFFER_SUBMITTED", seller, {
    offer_id: `offer-${crypto.randomUUID()}`,
    seller,
    price: "28.50",
    currency: "USDC",
    valid_until: new Date(Date.now() + 300_000).toISOString(),
    signature: "ed25519:BBBB",
    listing_id: "listing-001",
    payment_endpoint: "https://seller.example/pay",
  }, rfqId)
}

function makeWinnerSelectedEvent(
  seller: string,
  offerId: string,
  rfqId: string = RFQ_ID,
): NegotiationEvent {
  return makeEvent("WINNER_SELECTED", BUYER_DID, {
    seller,
    offer_id: offerId,
    quote: {
      quote_id: crypto.randomUUID(),
      nonce: crypto.randomUUID(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      payment_endpoint: "https://seller.example/pay",
    },
  }, rfqId)
}

function makeQuoteSignedEvent(
  seller: string,
  rfqId: string = RFQ_ID,
): NegotiationEvent {
  return makeEvent("QUOTE_SIGNED", BUYER_DID, {
    seller,
    buyer_signature: "ed25519:DDDD",
  }, rfqId)
}

function makeQuoteCommittedEvent(
  seller: string,
  rfqId: string = RFQ_ID,
): NegotiationEvent {
  return makeEvent("QUOTE_COMMITTED", seller, {
    seller,
    seller_signature: "ed25519:EEEE",
  }, rfqId)
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("DeadlineEnforcer", () => {
  let store: InMemoryEventStore
  let sessionManager: SessionManager
  let connectionTracker: ConnectionTracker
  let enforcer: DeadlineEnforcer

  // Short intervals for fast tests
  const SCAN_INTERVAL = 500 // minimum allowed
  const COSIGN_TIMEOUT = 15_000 // minimum allowed

  beforeEach(() => {
    vi.useFakeTimers()
    store = new InMemoryEventStore()
    sessionManager = new SessionManager(store)
    connectionTracker = new ConnectionTracker()
    enforcer = new DeadlineEnforcer({
      sessionManager,
      eventStore: store,
      connectionTracker,
      intervalMs: SCAN_INTERVAL,
      cosignTimeoutMs: COSIGN_TIMEOUT,
    })
  })

  afterEach(() => {
    enforcer.stop()
    vi.useRealTimers()
  })

  /**
   * Helper: sets up an RFQ with a short deadline and returns the offer ID
   * for use in WINNER_SELECTED events.
   */
  function setupRfqWithOffer(
    deadlineMs: number,
    rfqId: string = RFQ_ID,
  ): { offerId: string } {
    const rfqEvent = makeRfqEvent(deadlineMs, rfqId)
    store.append(rfqId, rfqEvent)

    const offerEvent = makeOfferEvent(SELLER_A_DID, rfqId)
    store.append(rfqId, offerEvent)

    const offerId = offerEvent.payload.offer_id as string
    return { offerId }
  }

  // --- RFQ Deadline Expiry ---

  it("expires OPEN session past deadline", async () => {
    // RFQ with deadline 100ms from now
    const deadline = Date.now() + 100
    const rfqEvent = makeRfqEvent(deadline)
    store.append(RFQ_ID, rfqEvent)

    // Session is OPEN (no offers yet)
    expect(sessionManager.getSession(RFQ_ID)!.state).toBe("OPEN")

    enforcer.start()

    // Advance past deadline + scan interval
    await vi.advanceTimersByTimeAsync(SCAN_INTERVAL + 200)

    const session = sessionManager.getSession(RFQ_ID)
    expect(session!.state).toBe("EXPIRED")
  })

  it("expires NEGOTIATING session past deadline", async () => {
    const deadline = Date.now() + 100
    const { offerId: _ } = setupRfqWithOffer(deadline)

    // Session is NEGOTIATING (has an offer)
    expect(sessionManager.getSession(RFQ_ID)!.state).toBe("NEGOTIATING")

    enforcer.start()

    await vi.advanceTimersByTimeAsync(SCAN_INTERVAL + 200)

    const session = sessionManager.getSession(RFQ_ID)
    expect(session!.state).toBe("EXPIRED")
  })

  it("expires COMMIT_PENDING session past deadline", async () => {
    const deadline = Date.now() + 100
    const { offerId } = setupRfqWithOffer(deadline)

    // Move to COMMIT_PENDING by selecting a winner
    const winnerEvent = makeWinnerSelectedEvent(SELLER_A_DID, offerId)
    store.append(RFQ_ID, winnerEvent)

    expect(sessionManager.getSession(RFQ_ID)!.state).toBe("COMMIT_PENDING")

    enforcer.start()

    await vi.advanceTimersByTimeAsync(SCAN_INTERVAL + 200)

    const session = sessionManager.getSession(RFQ_ID)
    expect(session!.state).toBe("EXPIRED")
  })

  // --- Cosign Timeout ---

  it("cosign timeout triggers COSIGN_TIMEOUT after timeout in COMMIT_PENDING", async () => {
    // Far-future deadline so expiry doesn't trigger
    const deadline = Date.now() + 300_000
    const { offerId } = setupRfqWithOffer(deadline)

    const winnerEvent = makeWinnerSelectedEvent(SELLER_A_DID, offerId)
    store.append(RFQ_ID, winnerEvent)

    expect(sessionManager.getSession(RFQ_ID)!.state).toBe("COMMIT_PENDING")

    enforcer.start()

    // Advance past cosign timeout + scan interval
    await vi.advanceTimersByTimeAsync(COSIGN_TIMEOUT + SCAN_INTERVAL + 100)

    const session = sessionManager.getSession(RFQ_ID)
    // COSIGN_TIMEOUT transitions COMMIT_PENDING -> NEGOTIATING
    expect(session!.state).toBe("NEGOTIATING")

    // Verify the COSIGN_TIMEOUT event was appended with seller in payload
    const events = store.getAllEvents(RFQ_ID)
    const timeoutEvent = events.find((e) => e.type === "COSIGN_TIMEOUT")
    expect(timeoutEvent).toBeDefined()
    expect(timeoutEvent!.payload.seller).toBe(SELLER_A_DID)
    expect(timeoutEvent!.actor).toBe("engine/deadline-enforcer")
  })

  // --- COMMITTED sessions should NOT be expired ---

  it("does NOT expire COMMITTED sessions", async () => {
    const deadline = Date.now() + 100
    const { offerId } = setupRfqWithOffer(deadline)

    // Move through COMMIT_PENDING -> COMMITTED
    const winnerEvent = makeWinnerSelectedEvent(SELLER_A_DID, offerId)
    store.append(RFQ_ID, winnerEvent)
    store.append(RFQ_ID, makeQuoteSignedEvent(SELLER_A_DID))
    store.append(RFQ_ID, makeQuoteCommittedEvent(SELLER_A_DID))

    expect(sessionManager.getSession(RFQ_ID)!.state).toBe("COMMITTED")

    enforcer.start()

    // Advance well past deadline
    await vi.advanceTimersByTimeAsync(SCAN_INTERVAL + 500)

    // Should remain COMMITTED, not re-expired
    const session = sessionManager.getSession(RFQ_ID)
    expect(session!.state).toBe("COMMITTED")
  })

  // --- stop() prevents further scanning ---

  it("stop() prevents further scanning", async () => {
    const deadline = Date.now() + 100
    const rfqEvent = makeRfqEvent(deadline)
    store.append(RFQ_ID, rfqEvent)

    enforcer.start()
    enforcer.stop()

    // Advance past deadline + scan interval
    await vi.advanceTimersByTimeAsync(SCAN_INTERVAL + 500)

    // Session should still be OPEN because enforcer was stopped
    const session = sessionManager.getSession(RFQ_ID)
    expect(session!.state).toBe("OPEN")
  })

  // --- Idempotent scans ---

  it("multiple scans are idempotent (already-expired session not re-processed)", async () => {
    const deadline = Date.now() + 100
    const rfqEvent = makeRfqEvent(deadline)
    store.append(RFQ_ID, rfqEvent)

    enforcer.start()

    // First scan: expires the session
    await vi.advanceTimersByTimeAsync(SCAN_INTERVAL + 200)
    expect(sessionManager.getSession(RFQ_ID)!.state).toBe("EXPIRED")

    const eventCountAfterFirstExpiry = store.size(RFQ_ID)

    // More scans: should not append duplicate expiry events
    await vi.advanceTimersByTimeAsync(SCAN_INTERVAL * 3)
    expect(store.size(RFQ_ID)).toBe(eventCountAfterFirstExpiry)
  })

  // --- Connection cleanup ---

  it("cleans up terminal session connections (connectionTracker.closeAll called)", async () => {
    const deadline = Date.now() + 100
    const rfqEvent = makeRfqEvent(deadline)
    store.append(RFQ_ID, rfqEvent)

    // Set up a connection to track
    const closeFn = vi.fn()
    connectionTracker.acquire({
      rfqId: RFQ_ID,
      callerDid: BUYER_DID,
      isBuyer: true,
      close: closeFn,
    })

    expect(connectionTracker.countForSession(RFQ_ID)).toBe(1)

    enforcer.start()

    // Advance past deadline + two scan intervals (first expires, second cleans up)
    await vi.advanceTimersByTimeAsync(SCAN_INTERVAL * 3 + 200)

    expect(closeFn).toHaveBeenCalled()
    expect(connectionTracker.countForSession(RFQ_ID)).toBe(0)
  })
})
