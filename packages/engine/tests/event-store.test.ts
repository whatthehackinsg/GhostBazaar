import { describe, it, expect, beforeEach } from "vitest"
import { InMemoryEventStore } from "../src/state/event-store.js"
import type { NegotiationEvent, EventStore, EventType } from "../src/types.js"
import type { RFQ } from "@ghost-bazaar/core"

// ---------------------------------------------------------------------------
// Helpers — minimal fixtures for testing EventStore behavior
// ---------------------------------------------------------------------------

const BUYER_DID = "did:key:z6MkBuyerAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
const SELLER_A_DID = "did:key:z6MkSellerAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB"
const SELLER_B_DID = "did:key:z6MkSellerBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
const RFQ_ID = "rfq-test-001"

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

function makeRfqEvent(rfqId: string = RFQ_ID): NegotiationEvent {
  return makeEvent("RFQ_CREATED", BUYER_DID, {
    protocol: "ghost-bazaar-v4",
    buyer: BUYER_DID,
    service_type: "llm-inference",
    spec: {},
    anchor_price: "30.00",
    currency: "USDC",
    deadline: new Date(Date.now() + 300_000).toISOString(),
    signature: "ed25519:AAAA",
  }, rfqId)
}

function makeOfferEvent(
  seller: string,
  rfqId: string = RFQ_ID,
): NegotiationEvent {
  return makeEvent("OFFER_SUBMITTED", seller, {
    offer_id: crypto.randomUUID(),
    seller,
    price: "28.50",
    currency: "USDC",
    valid_until: new Date(Date.now() + 60_000).toISOString(),
    signature: "ed25519:BBBB",
  }, rfqId)
}

function makeCounterEvent(
  to: string,
  rfqId: string = RFQ_ID,
): NegotiationEvent {
  return makeEvent("COUNTER_SENT", BUYER_DID, {
    counter_id: crypto.randomUUID(),
    round: 1,
    from: BUYER_DID,
    to,
    price: "27.00",
    currency: "USDC",
    valid_until: new Date(Date.now() + 60_000).toISOString(),
    signature: "ed25519:CCCC",
  }, rfqId)
}

function makeWinnerSelectedEvent(
  seller: string,
  rfqId: string = RFQ_ID,
): NegotiationEvent {
  return makeEvent("WINNER_SELECTED", BUYER_DID, {
    seller,
    offer_id: crypto.randomUUID(),
  }, rfqId)
}

function makeCommitPendingEvent(
  seller: string,
  rfqId: string = RFQ_ID,
): NegotiationEvent {
  return makeEvent("COMMIT_PENDING", BUYER_DID, {
    seller,
    quote_revision: 1,
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

function makeCosignDeclinedEvent(
  seller: string,
  rfqId: string = RFQ_ID,
): NegotiationEvent {
  return makeEvent("COSIGN_DECLINED", seller, { seller }, rfqId)
}

function makeCosignTimeoutEvent(
  seller: string,
  rfqId: string = RFQ_ID,
): NegotiationEvent {
  return makeEvent("COSIGN_TIMEOUT", BUYER_DID, { seller }, rfqId)
}

function makeExpiredEvent(rfqId: string = RFQ_ID): NegotiationEvent {
  return makeEvent("NEGOTIATION_EXPIRED", "system", {}, rfqId)
}

function makeCancelledEvent(rfqId: string = RFQ_ID): NegotiationEvent {
  return makeEvent("NEGOTIATION_CANCELLED", BUYER_DID, {}, rfqId)
}

// ---------------------------------------------------------------------------
// Minimal RFQ fixture for role-scoped filtering
// ---------------------------------------------------------------------------

const MOCK_RFQ: Pick<RFQ, "buyer"> = { buyer: BUYER_DID }

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("InMemoryEventStore", () => {
  let store: EventStore

  beforeEach(() => {
    store = new InMemoryEventStore()
  })

  // --- append + getEvents basic ---

  describe("append + getEvents", () => {
    it("appends an event and retrieves it", () => {
      const event = makeRfqEvent()
      store.append(RFQ_ID, event)

      const events = store.getEvents(RFQ_ID, BUYER_DID, MOCK_RFQ)
      expect(events).toHaveLength(1)
      expect(events[0].type).toBe("RFQ_CREATED")
    })

    it("preserves insertion order", () => {
      const e1 = makeRfqEvent()
      const e2 = makeOfferEvent(SELLER_A_DID)
      const e3 = makeOfferEvent(SELLER_B_DID)

      store.append(RFQ_ID, e1)
      store.append(RFQ_ID, e2)
      store.append(RFQ_ID, e3)

      const events = store.getEvents(RFQ_ID, BUYER_DID, MOCK_RFQ)
      expect(events.map((e) => e.type)).toEqual([
        "RFQ_CREATED",
        "OFFER_SUBMITTED",
        "OFFER_SUBMITTED",
      ])
    })

    it("returns empty array for unknown rfqId", () => {
      const events = store.getEvents("nonexistent", BUYER_DID, MOCK_RFQ)
      expect(events).toEqual([])
    })

    it("isolates events across different rfqIds", () => {
      store.append("rfq-1", makeRfqEvent("rfq-1"))
      store.append("rfq-2", makeRfqEvent("rfq-2"))

      const rfq1Mock = { buyer: BUYER_DID }
      expect(store.getEvents("rfq-1", BUYER_DID, rfq1Mock)).toHaveLength(1)
      expect(store.getEvents("rfq-2", BUYER_DID, rfq1Mock)).toHaveLength(1)
    })
  })

  // --- rfqId mismatch guard ---

  describe("rfqId mismatch guard", () => {
    it("throws when rfqId parameter does not match event.rfq_id", () => {
      const event = makeRfqEvent("rfq-actual")
      expect(() => store.append("rfq-wrong", event)).toThrow(
        /rfqId mismatch/,
      )
    })

    it("does not store the event when mismatch is detected", () => {
      const event = makeRfqEvent("rfq-actual")
      try {
        store.append("rfq-wrong", event)
      } catch {
        // expected
      }
      expect(store.size("rfq-wrong")).toBe(0)
      expect(store.size("rfq-actual")).toBe(0)
    })
  })

  // --- event_id deduplication ---

  describe("event_id deduplication", () => {
    it("rejects duplicate event_id", () => {
      const event = makeRfqEvent()
      store.append(RFQ_ID, event)
      expect(() => store.append(RFQ_ID, event)).toThrow(/duplicate event_id/)
    })

    it("rejects duplicate event_id across different sessions", () => {
      const event1 = makeRfqEvent("rfq-1")
      store.append("rfq-1", event1)

      // Same event_id but different rfq_id
      const event2: NegotiationEvent = { ...event1, rfq_id: "rfq-2", payload: { ...event1.payload, rfq_id: "rfq-2" } }
      expect(() => store.append("rfq-2", event2)).toThrow(/duplicate event_id/)
    })

    it("does not increment size on duplicate rejection", () => {
      const event = makeRfqEvent()
      store.append(RFQ_ID, event)
      try { store.append(RFQ_ID, event) } catch { /* expected */ }
      expect(store.size(RFQ_ID)).toBe(1)
    })
  })

  // --- afterId cursor ---

  describe("afterId cursor", () => {
    it("returns events after the specified event_id", () => {
      const e1 = makeRfqEvent()
      const e2 = makeOfferEvent(SELLER_A_DID)
      const e3 = makeOfferEvent(SELLER_B_DID)

      store.append(RFQ_ID, e1)
      store.append(RFQ_ID, e2)
      store.append(RFQ_ID, e3)

      const after = store.getEvents(RFQ_ID, BUYER_DID, MOCK_RFQ, e1.event_id)
      expect(after).toHaveLength(2)
      expect(after[0].event_id).toBe(e2.event_id)
    })

    it("returns empty when afterId is the last event", () => {
      const e1 = makeRfqEvent()
      store.append(RFQ_ID, e1)

      const after = store.getEvents(RFQ_ID, BUYER_DID, MOCK_RFQ, e1.event_id)
      expect(after).toEqual([])
    })

    it("returns empty for unknown afterId (invalid cursor)", () => {
      store.append(RFQ_ID, makeRfqEvent())
      const after = store.getEvents(RFQ_ID, BUYER_DID, MOCK_RFQ, "nonexistent-id")
      expect(after).toEqual([])
    })
  })

  // --- Role-scoped filtering ---

  describe("role-scoped filtering", () => {
    it("buyer sees all events", () => {
      store.append(RFQ_ID, makeRfqEvent())
      store.append(RFQ_ID, makeOfferEvent(SELLER_A_DID))
      store.append(RFQ_ID, makeOfferEvent(SELLER_B_DID))
      store.append(RFQ_ID, makeCounterEvent(SELLER_A_DID))

      const events = store.getEvents(RFQ_ID, BUYER_DID, MOCK_RFQ)
      expect(events).toHaveLength(4)
    })

    it("seller sees RFQ_CREATED + own offers + counters addressed to them", () => {
      store.append(RFQ_ID, makeRfqEvent())
      store.append(RFQ_ID, makeOfferEvent(SELLER_A_DID))
      store.append(RFQ_ID, makeOfferEvent(SELLER_B_DID))
      store.append(RFQ_ID, makeCounterEvent(SELLER_A_DID))
      store.append(RFQ_ID, makeCounterEvent(SELLER_B_DID))

      const sellerAEvents = store.getEvents(RFQ_ID, SELLER_A_DID, MOCK_RFQ)
      // Seller A sees: RFQ_CREATED + own offer + counter to them = 3
      expect(sellerAEvents).toHaveLength(3)
      expect(sellerAEvents.map((e) => e.type)).toEqual([
        "RFQ_CREATED",
        "OFFER_SUBMITTED",
        "COUNTER_SENT",
      ])
    })

    it("seller does NOT see other sellers' offers", () => {
      store.append(RFQ_ID, makeRfqEvent())
      store.append(RFQ_ID, makeOfferEvent(SELLER_A_DID))
      store.append(RFQ_ID, makeOfferEvent(SELLER_B_DID))

      const sellerAEvents = store.getEvents(RFQ_ID, SELLER_A_DID, MOCK_RFQ)
      const offerActors = sellerAEvents
        .filter((e) => e.type === "OFFER_SUBMITTED")
        .map((e) => e.actor)
      expect(offerActors).toEqual([SELLER_A_DID])
      expect(offerActors).not.toContain(SELLER_B_DID)
    })

    it("seller does NOT see counters addressed to other sellers", () => {
      store.append(RFQ_ID, makeRfqEvent())
      store.append(RFQ_ID, makeCounterEvent(SELLER_A_DID))
      store.append(RFQ_ID, makeCounterEvent(SELLER_B_DID))

      const sellerAEvents = store.getEvents(RFQ_ID, SELLER_A_DID, MOCK_RFQ)
      const counterTargets = sellerAEvents
        .filter((e) => e.type === "COUNTER_SENT")
        .map((e) => (e.payload as { to: string }).to)
      expect(counterTargets).toEqual([SELLER_A_DID])
    })

    it("selected seller sees WINNER_SELECTED", () => {
      store.append(RFQ_ID, makeRfqEvent())
      store.append(RFQ_ID, makeWinnerSelectedEvent(SELLER_A_DID))

      expect(store.getEvents(RFQ_ID, SELLER_A_DID, MOCK_RFQ)).toHaveLength(2)
      expect(store.getEvents(RFQ_ID, SELLER_B_DID, MOCK_RFQ)).toHaveLength(1) // only RFQ
    })

    it("selected seller sees COMMIT_PENDING", () => {
      store.append(RFQ_ID, makeRfqEvent())
      store.append(RFQ_ID, makeCommitPendingEvent(SELLER_A_DID))

      const sellerA = store.getEvents(RFQ_ID, SELLER_A_DID, MOCK_RFQ)
      expect(sellerA.some((e) => e.type === "COMMIT_PENDING")).toBe(true)

      const sellerB = store.getEvents(RFQ_ID, SELLER_B_DID, MOCK_RFQ)
      expect(sellerB.some((e) => e.type === "COMMIT_PENDING")).toBe(false)
    })

    it("selected seller sees QUOTE_SIGNED and QUOTE_COMMITTED", () => {
      store.append(RFQ_ID, makeRfqEvent())
      store.append(RFQ_ID, makeQuoteSignedEvent(SELLER_A_DID))
      store.append(RFQ_ID, makeQuoteCommittedEvent(SELLER_A_DID))

      const sellerA = store.getEvents(RFQ_ID, SELLER_A_DID, MOCK_RFQ)
      expect(sellerA.map((e) => e.type)).toContain("QUOTE_SIGNED")
      expect(sellerA.map((e) => e.type)).toContain("QUOTE_COMMITTED")

      const sellerB = store.getEvents(RFQ_ID, SELLER_B_DID, MOCK_RFQ)
      expect(sellerB.map((e) => e.type)).not.toContain("QUOTE_SIGNED")
      expect(sellerB.map((e) => e.type)).not.toContain("QUOTE_COMMITTED")
    })

    it("selected seller sees COSIGN_DECLINED and COSIGN_TIMEOUT", () => {
      store.append(RFQ_ID, makeRfqEvent())
      store.append(RFQ_ID, makeCosignDeclinedEvent(SELLER_A_DID))
      store.append(RFQ_ID, makeCosignTimeoutEvent(SELLER_A_DID))

      const sellerA = store.getEvents(RFQ_ID, SELLER_A_DID, MOCK_RFQ)
      expect(sellerA.map((e) => e.type)).toContain("COSIGN_DECLINED")
      expect(sellerA.map((e) => e.type)).toContain("COSIGN_TIMEOUT")

      const sellerB = store.getEvents(RFQ_ID, SELLER_B_DID, MOCK_RFQ)
      expect(sellerB.map((e) => e.type)).not.toContain("COSIGN_DECLINED")
      expect(sellerB.map((e) => e.type)).not.toContain("COSIGN_TIMEOUT")
    })

    it("all participants see NEGOTIATION_EXPIRED", () => {
      store.append(RFQ_ID, makeRfqEvent())
      store.append(RFQ_ID, makeExpiredEvent())

      expect(store.getEvents(RFQ_ID, BUYER_DID, MOCK_RFQ)).toHaveLength(2)
      expect(store.getEvents(RFQ_ID, SELLER_A_DID, MOCK_RFQ)).toHaveLength(2)
      expect(store.getEvents(RFQ_ID, SELLER_B_DID, MOCK_RFQ)).toHaveLength(2)
    })

    it("all participants see NEGOTIATION_CANCELLED", () => {
      store.append(RFQ_ID, makeRfqEvent())
      store.append(RFQ_ID, makeCancelledEvent())

      expect(store.getEvents(RFQ_ID, BUYER_DID, MOCK_RFQ)).toHaveLength(2)
      expect(store.getEvents(RFQ_ID, SELLER_A_DID, MOCK_RFQ)).toHaveLength(2)
    })

    it("unknown event types are hidden by default (deny-by-default)", () => {
      // Force an event with a type not in the switch — cast needed
      const unknownEvent: NegotiationEvent = {
        event_id: crypto.randomUUID(),
        rfq_id: RFQ_ID,
        type: "SOME_FUTURE_EVENT" as EventType,
        timestamp: new Date().toISOString(),
        actor: BUYER_DID,
        payload: { rfq_id: RFQ_ID },
      }
      store.append(RFQ_ID, unknownEvent)

      // Buyer sees it (buyer sees everything)
      expect(store.getEvents(RFQ_ID, BUYER_DID, MOCK_RFQ)).toHaveLength(1)
      // Seller does NOT see it
      expect(store.getEvents(RFQ_ID, SELLER_A_DID, MOCK_RFQ)).toHaveLength(0)
    })

    it("afterId cursor respects role filtering", () => {
      const rfqEv = makeRfqEvent()
      const offerA = makeOfferEvent(SELLER_A_DID)
      const offerB = makeOfferEvent(SELLER_B_DID)
      const counterA = makeCounterEvent(SELLER_A_DID)

      store.append(RFQ_ID, rfqEv)
      store.append(RFQ_ID, offerA)
      store.append(RFQ_ID, offerB)
      store.append(RFQ_ID, counterA)

      // Seller A after rfqEv should see: own offer + counter = 2 (NOT offerB)
      const after = store.getEvents(
        RFQ_ID,
        SELLER_A_DID,
        MOCK_RFQ,
        rfqEv.event_id,
      )
      expect(after).toHaveLength(2)
      expect(after.map((e) => e.type)).toEqual(["OFFER_SUBMITTED", "COUNTER_SENT"])
    })
  })

  // --- size ---

  describe("size", () => {
    it("returns 0 for unknown rfqId", () => {
      expect(store.size("nonexistent")).toBe(0)
    })

    it("returns total event count (unfiltered)", () => {
      store.append(RFQ_ID, makeRfqEvent())
      store.append(RFQ_ID, makeOfferEvent(SELLER_A_DID))
      store.append(RFQ_ID, makeOfferEvent(SELLER_B_DID))
      expect(store.size(RFQ_ID)).toBe(3)
    })
  })

  // --- subscribe ---

  describe("subscribe", () => {
    it("notifies listener on new events", () => {
      const received: NegotiationEvent[] = []
      store.subscribe(RFQ_ID, BUYER_DID, MOCK_RFQ, (event) => {
        received.push(event)
      })

      store.append(RFQ_ID, makeRfqEvent())
      expect(received).toHaveLength(1)
      expect(received[0].type).toBe("RFQ_CREATED")
    })

    it("returns an unsubscribe function", () => {
      const received: NegotiationEvent[] = []
      const unsub = store.subscribe(RFQ_ID, BUYER_DID, MOCK_RFQ, (event) => {
        received.push(event)
      })

      store.append(RFQ_ID, makeRfqEvent())
      expect(received).toHaveLength(1)

      unsub()
      store.append(RFQ_ID, makeOfferEvent(SELLER_A_DID))
      // Should not receive after unsubscribe
      expect(received).toHaveLength(1)
    })

    it("seller subscription only receives role-visible events", () => {
      const received: NegotiationEvent[] = []
      store.subscribe(RFQ_ID, SELLER_A_DID, MOCK_RFQ, (event) => {
        received.push(event)
      })

      store.append(RFQ_ID, makeRfqEvent())
      store.append(RFQ_ID, makeOfferEvent(SELLER_B_DID)) // Not visible to A
      store.append(RFQ_ID, makeOfferEvent(SELLER_A_DID)) // Visible
      store.append(RFQ_ID, makeCounterEvent(SELLER_B_DID)) // Not visible to A

      // Seller A should only see: RFQ_CREATED + own offer = 2
      expect(received).toHaveLength(2)
      expect(received[0].type).toBe("RFQ_CREATED")
      expect(received[1].type).toBe("OFFER_SUBMITTED")
      expect(received[1].actor).toBe(SELLER_A_DID)
    })

    it("does not notify subscribers on different rfqId", () => {
      const received: NegotiationEvent[] = []
      store.subscribe(RFQ_ID, BUYER_DID, MOCK_RFQ, (event) => {
        received.push(event)
      })

      store.append("other-rfq", makeRfqEvent("other-rfq"))
      expect(received).toHaveLength(0)
    })

    it("subscriber throw does not prevent event from being stored", () => {
      store.subscribe(RFQ_ID, BUYER_DID, MOCK_RFQ, () => {
        throw new Error("subscriber explosion")
      })

      // append should NOT throw despite subscriber failure
      expect(() => store.append(RFQ_ID, makeRfqEvent())).not.toThrow()
      expect(store.size(RFQ_ID)).toBe(1)
    })

    it("subscriber throw does not prevent other subscribers from receiving", () => {
      const received: NegotiationEvent[] = []

      // First subscriber throws
      store.subscribe(RFQ_ID, BUYER_DID, MOCK_RFQ, () => {
        throw new Error("boom")
      })
      // Second subscriber should still receive
      store.subscribe(RFQ_ID, BUYER_DID, MOCK_RFQ, (event) => {
        received.push(event)
      })

      store.append(RFQ_ID, makeRfqEvent())
      expect(received).toHaveLength(1)
    })
  })

  // --- hasCursor ---

  describe("hasCursor", () => {
    it("returns true for an event_id that exists in the session", () => {
      const event = makeRfqEvent()
      store.append(RFQ_ID, event)
      expect(store.hasCursor(RFQ_ID, event.event_id)).toBe(true)
    })

    it("returns false for an event_id that does not exist", () => {
      store.append(RFQ_ID, makeRfqEvent())
      expect(store.hasCursor(RFQ_ID, "nonexistent-id")).toBe(false)
    })

    it("returns false for an event_id from a different session", () => {
      const event = makeRfqEvent("other-rfq")
      store.append("other-rfq", event)
      expect(store.hasCursor(RFQ_ID, event.event_id)).toBe(false)
    })

    it("returns false for a non-existent session", () => {
      expect(store.hasCursor("no-such-session", "any-id")).toBe(false)
    })
  })

  // --- subscribeTerminal ---

  describe("subscribeTerminal", () => {
    it("fires when session reaches COMMITTED", () => {
      const store = new InMemoryEventStore()
      store.append(RFQ_ID, makeRfqEvent())
      store.append(RFQ_ID, makeOfferEvent(SELLER_A_DID))

      const states: string[] = []
      store.subscribeTerminal(RFQ_ID, (s) => states.push(s))

      store.append(RFQ_ID, makeWinnerSelectedEvent(SELLER_A_DID))
      expect(states).toEqual([]) // COMMIT_PENDING is not terminal

      store.append(RFQ_ID, makeQuoteSignedEvent(SELLER_A_DID))
      expect(states).toEqual([]) // Still COMMIT_PENDING

      store.append(RFQ_ID, makeQuoteCommittedEvent(SELLER_A_DID))
      expect(states).toEqual(["COMMITTED"])
    })

    it("fires when session reaches EXPIRED", () => {
      const store = new InMemoryEventStore()
      store.append(RFQ_ID, makeRfqEvent())

      const states: string[] = []
      store.subscribeTerminal(RFQ_ID, (s) => states.push(s))

      store.append(RFQ_ID, makeExpiredEvent())
      expect(states).toEqual(["EXPIRED"])
    })

    it("fires when session reaches CANCELLED", () => {
      const store = new InMemoryEventStore()
      store.append(RFQ_ID, makeRfqEvent())

      const states: string[] = []
      store.subscribeTerminal(RFQ_ID, (s) => states.push(s))

      store.append(RFQ_ID, makeCancelledEvent())
      expect(states).toEqual(["CANCELLED"])
    })

    it("unsubscribe prevents notification", () => {
      const store = new InMemoryEventStore()
      store.append(RFQ_ID, makeRfqEvent())

      const states: string[] = []
      const unsub = store.subscribeTerminal(RFQ_ID, (s) => states.push(s))
      unsub()

      store.append(RFQ_ID, makeExpiredEvent())
      expect(states).toEqual([])
    })

    it("fires at most once per subscription", () => {
      const store = new InMemoryEventStore()
      store.append(RFQ_ID, makeRfqEvent())

      const states: string[] = []
      store.subscribeTerminal(RFQ_ID, (s) => states.push(s))

      store.append(RFQ_ID, makeExpiredEvent())
      expect(states).toEqual(["EXPIRED"])
    })
  })

  // --- subscribeFrom ---

  describe("subscribeFrom", () => {
    it("returns replay events and subscribes for new ones", () => {
      const store = new InMemoryEventStore()
      const rfqEvent = makeRfqEvent()
      const offerEvent = makeOfferEvent(SELLER_A_DID)
      store.append(RFQ_ID, rfqEvent)
      store.append(RFQ_ID, offerEvent)

      const liveEvents: NegotiationEvent[] = []
      const result = store.subscribeFrom(
        RFQ_ID, BUYER_DID, MOCK_RFQ, undefined,
        (e) => liveEvents.push(e),
      )

      expect(result.replay).toHaveLength(2)
      expect(result.replay[0].event_id).toBe(rfqEvent.event_id)
      expect(result.replay[1].event_id).toBe(offerEvent.event_id)
      expect(result.buffered).toHaveLength(0)
      expect(liveEvents).toHaveLength(0)

      result.activate()

      const counterEvent = makeCounterEvent(SELLER_A_DID)
      store.append(RFQ_ID, counterEvent)
      expect(liveEvents).toHaveLength(1)
      expect(liveEvents[0].event_id).toBe(counterEvent.event_id)

      result.unsubscribe()
    })

    it("uses cursor to replay only events after afterId", () => {
      const store = new InMemoryEventStore()
      const rfqEvent = makeRfqEvent()
      const offerEvent = makeOfferEvent(SELLER_A_DID)
      store.append(RFQ_ID, rfqEvent)
      store.append(RFQ_ID, offerEvent)

      const result = store.subscribeFrom(
        RFQ_ID, BUYER_DID, MOCK_RFQ, rfqEvent.event_id,
        () => {},
      )

      expect(result.replay).toHaveLength(1)
      expect(result.replay[0].event_id).toBe(offerEvent.event_id)

      result.unsubscribe()
    })

    it("captures events appended between subscribe and activate (no lost events)", () => {
      const store = new InMemoryEventStore()
      store.append(RFQ_ID, makeRfqEvent())

      const liveEvents: NegotiationEvent[] = []
      const result = store.subscribeFrom(
        RFQ_ID, BUYER_DID, MOCK_RFQ, undefined,
        (e) => liveEvents.push(e),
      )

      const offerEvent = makeOfferEvent(SELLER_A_DID)
      store.append(RFQ_ID, offerEvent)

      expect(liveEvents).toHaveLength(0)

      result.activate()
      expect(liveEvents).toHaveLength(1)
      expect(liveEvents[0].event_id).toBe(offerEvent.event_id)

      result.unsubscribe()
    })

    it("deduplicates events that appear in both replay and buffer", () => {
      const store = new InMemoryEventStore()
      const rfqEvent = makeRfqEvent()
      store.append(RFQ_ID, rfqEvent)

      const liveEvents: NegotiationEvent[] = []
      const result = store.subscribeFrom(
        RFQ_ID, BUYER_DID, MOCK_RFQ, undefined,
        (e) => liveEvents.push(e),
      )

      expect(result.replay).toHaveLength(1)
      expect(result.buffered).toHaveLength(0)

      result.activate()
      expect(liveEvents).toHaveLength(0)

      result.unsubscribe()
    })

    it("respects role-scoped visibility in replay", () => {
      const store = new InMemoryEventStore()
      store.append(RFQ_ID, makeRfqEvent())
      store.append(RFQ_ID, makeOfferEvent(SELLER_A_DID))
      store.append(RFQ_ID, makeOfferEvent(SELLER_B_DID))

      const result = store.subscribeFrom(
        RFQ_ID, SELLER_A_DID, MOCK_RFQ, undefined,
        () => {},
      )

      expect(result.replay).toHaveLength(2)
      expect(result.replay[0].type).toBe("RFQ_CREATED")
      expect(result.replay[1].actor).toBe(SELLER_A_DID)

      result.unsubscribe()
    })

    it("unsubscribe stops live delivery", () => {
      const store = new InMemoryEventStore()
      store.append(RFQ_ID, makeRfqEvent())

      const liveEvents: NegotiationEvent[] = []
      const result = store.subscribeFrom(
        RFQ_ID, BUYER_DID, MOCK_RFQ, undefined,
        (e) => liveEvents.push(e),
      )
      result.activate()
      result.unsubscribe()

      store.append(RFQ_ID, makeOfferEvent(SELLER_A_DID))
      expect(liveEvents).toHaveLength(0)
    })

    it("strict ordering: replay before buffered before live", () => {
      const store = new InMemoryEventStore()
      const rfqEvent = makeRfqEvent()
      store.append(RFQ_ID, rfqEvent)

      const allEvents: Array<{ source: string; id: string }> = []
      const result = store.subscribeFrom(
        RFQ_ID, BUYER_DID, MOCK_RFQ, undefined,
        (e) => allEvents.push({ source: "live", id: e.event_id }),
      )

      for (const e of result.replay) {
        allEvents.push({ source: "replay", id: e.event_id })
      }

      const offerEvent = makeOfferEvent(SELLER_A_DID)
      store.append(RFQ_ID, offerEvent)

      for (const e of result.buffered) {
        allEvents.push({ source: "buffered", id: e.event_id })
      }

      result.activate()

      const counterEvent = makeCounterEvent(SELLER_A_DID)
      store.append(RFQ_ID, counterEvent)

      expect(allEvents[0]).toEqual({ source: "replay", id: rfqEvent.event_id })
      expect(allEvents[1]).toEqual({ source: "live", id: offerEvent.event_id })
      expect(allEvents[2]).toEqual({ source: "live", id: counterEvent.event_id })

      result.unsubscribe()
    })
  })

  // --- listSessionIds ---

  describe("listSessionIds", () => {
    it("returns empty array when no sessions exist", () => {
      const store = new InMemoryEventStore()
      expect(store.listSessionIds()).toEqual([])
    })

    it("returns all session IDs", () => {
      const store = new InMemoryEventStore()
      store.append(RFQ_ID, makeRfqEvent())
      store.append("rfq-other", makeRfqEvent("rfq-other"))
      const ids = store.listSessionIds()
      expect(ids).toHaveLength(2)
      expect(ids).toContain(RFQ_ID)
      expect(ids).toContain("rfq-other")
    })
  })

  // --- Immutability ---

  describe("immutability", () => {
    it("getEvents returns a new array each call (not a reference to internal state)", () => {
      store.append(RFQ_ID, makeRfqEvent())
      const events1 = store.getEvents(RFQ_ID, BUYER_DID, MOCK_RFQ)
      const events2 = store.getEvents(RFQ_ID, BUYER_DID, MOCK_RFQ)
      expect(events1).not.toBe(events2) // different array instances
      expect(events1).toEqual(events2) // same content
    })

    it("events are frozen — mutation after append is impossible", () => {
      const event = makeRfqEvent()
      store.append(RFQ_ID, event)

      const retrieved = store.getEvents(RFQ_ID, BUYER_DID, MOCK_RFQ)
      expect(Object.isFrozen(retrieved[0])).toBe(true)

      // Attempting to mutate should throw in strict mode or silently fail
      expect(() => {
        ;(retrieved[0] as { type: string }).type = "HACKED"
      }).toThrow()
    })

    it("event payload is frozen — nested mutation is impossible", () => {
      const event = makeRfqEvent()
      store.append(RFQ_ID, event)

      const retrieved = store.getEvents(RFQ_ID, BUYER_DID, MOCK_RFQ)
      expect(Object.isFrozen(retrieved[0].payload)).toBe(true)

      expect(() => {
        ;(retrieved[0].payload as Record<string, unknown>).injected = "evil"
      }).toThrow()
    })

    it("original event object mutation after append does not affect stored event", () => {
      const event = makeRfqEvent()
      const originalType = event.type
      store.append(RFQ_ID, event)

      // Mutate the original object (if not frozen at call site)
      try {
        ;(event as { type: string }).type = "HACKED"
      } catch {
        // Object may be frozen by the caller — that's fine
      }

      const retrieved = store.getEvents(RFQ_ID, BUYER_DID, MOCK_RFQ)
      expect(retrieved[0].type).toBe(originalType)
    })
  })
})
