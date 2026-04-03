import { describe, it, expect, beforeEach } from "vitest"
import { InMemoryEventStore } from "../src/state/event-store.js"
import { SessionManager, SessionBusyError } from "../src/state/session-manager.js"
import { SessionState } from "../src/types.js"
import type { NegotiationEvent, EventType } from "../src/types.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BUYER = "did:key:z6MkBuyerAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
const SELLER_A = "did:key:z6MkSellerAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB"
const RFQ_ID = "rfq-mgr-001"

let seq = 0
function makeEvent(
  type: EventType,
  actor: string,
  payload: Record<string, unknown> = {},
  rfqId: string = RFQ_ID,
): NegotiationEvent {
  return {
    event_id: `evt-mgr-${++seq}`,
    rfq_id: rfqId,
    type,
    timestamp: new Date().toISOString(),
    actor,
    payload: { rfq_id: rfqId, ...payload },
  }
}

function rfqEvent(rfqId: string = RFQ_ID): NegotiationEvent {
  return makeEvent("RFQ_CREATED", BUYER, {
    protocol: "ghost-bazaar-v4",
    buyer: BUYER,
    service_type: "llm-inference",
    spec: {},
    anchor_price: "30.00",
    currency: "USDC",
    deadline: new Date(Date.now() + 300_000).toISOString(),
    signature: "ed25519:AAAA",
  }, rfqId)
}

function offerEvent(seller: string, rfqId: string = RFQ_ID): NegotiationEvent {
  return makeEvent("OFFER_SUBMITTED", seller, {
    offer_id: `offer-${++seq}`,
    seller,
    price: "28.50",
    currency: "USDC",
    valid_until: new Date(Date.now() + 60_000).toISOString(),
    signature: "ed25519:BBBB",
    listing_id: `listing-${seller}`,
    payment_endpoint: `https://${seller}.example.com/execute`,
  }, rfqId)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SessionManager", () => {
  let store: InMemoryEventStore
  let manager: SessionManager

  beforeEach(() => {
    seq = 0
    store = new InMemoryEventStore()
    manager = new SessionManager(store)
  })

  // --- getSession ---

  describe("getSession", () => {
    it("returns null for non-existent session", () => {
      expect(manager.getSession("nonexistent")).toBeNull()
    })

    it("returns derived state after events are appended", async () => {
      await manager.withLock(RFQ_ID, async () => {
        manager.appendEvent(RFQ_ID, rfqEvent())
      })
      const session = manager.getSession(RFQ_ID)
      expect(session).not.toBeNull()
      expect(session!.state).toBe(SessionState.OPEN)
      expect(session!.rfq.buyer).toBe(BUYER)
    })
  })

  // --- appendEvent lock-context guard ---

  describe("appendEvent lock-context guard", () => {
    it("throws when called outside withLock", () => {
      expect(() =>
        manager.appendEvent(RFQ_ID, rfqEvent()),
      ).toThrow(/must be called within withLock/)
    })

    it("works when called inside withLock", async () => {
      await manager.withLock(RFQ_ID, async () => {
        const session = manager.appendEvent(RFQ_ID, rfqEvent())
        expect(session.state).toBe(SessionState.OPEN)
      })
    })
  })

  // --- appendEvent transactional safety ---

  describe("appendEvent transactional safety", () => {
    it("appends valid RFQ_CREATED as first event", async () => {
      await manager.withLock(RFQ_ID, async () => {
        const session = manager.appendEvent(RFQ_ID, rfqEvent())
        expect(session.state).toBe(SessionState.OPEN)
      })
    })

    it("appends valid OFFER_SUBMITTED after RFQ", async () => {
      await manager.withLock(RFQ_ID, async () => {
        manager.appendEvent(RFQ_ID, rfqEvent())
        const session = manager.appendEvent(RFQ_ID, offerEvent(SELLER_A))
        expect(session.state).toBe(SessionState.NEGOTIATING)
        expect(session.offers).toHaveLength(1)
      })
    })

    it("rejects non-RFQ_CREATED as first event", async () => {
      await manager.withLock(RFQ_ID, async () => {
        expect(() =>
          manager.appendEvent(RFQ_ID, offerEvent(SELLER_A)),
        ).toThrow(/first event must be RFQ_CREATED/)
      })
    })

    it("rejects invalid state transition", async () => {
      await manager.withLock(RFQ_ID, async () => {
        manager.appendEvent(RFQ_ID, rfqEvent())
        const counter = makeEvent("COUNTER_SENT", BUYER, {
          counter_id: "c1", round: 1, from: BUYER, to: SELLER_A,
          price: "27.00", currency: "USDC",
          valid_until: new Date(Date.now() + 60_000).toISOString(),
          signature: "ed25519:CCCC",
        })
        // OPEN + COUNTER_SENT is invalid
        expect(() => manager.appendEvent(RFQ_ID, counter)).toThrow(/invalid.*transition/i)
      })
    })

    it("does NOT persist event when transition is invalid", async () => {
      await manager.withLock(RFQ_ID, async () => {
        manager.appendEvent(RFQ_ID, rfqEvent())
        const counter = makeEvent("COUNTER_SENT", BUYER, {
          counter_id: "c1", round: 1, from: BUYER, to: SELLER_A,
          price: "27.00", currency: "USDC",
          valid_until: new Date(Date.now() + 60_000).toISOString(),
          signature: "ed25519:CCCC",
        })
        try { manager.appendEvent(RFQ_ID, counter) } catch { /* expected */ }
        expect(store.size(RFQ_ID)).toBe(1) // only RFQ_CREATED
      })
    })

    it("does NOT persist event when payload is malformed", async () => {
      await manager.withLock(RFQ_ID, async () => {
        manager.appendEvent(RFQ_ID, rfqEvent())
        // OFFER_SUBMITTED with missing required fields
        const badOffer = makeEvent("OFFER_SUBMITTED", SELLER_A, {})
        expect(() => manager.appendEvent(RFQ_ID, badOffer)).toThrow()
        expect(store.size(RFQ_ID)).toBe(1) // bad event NOT persisted
      })
    })

    it("session remains usable after rejected malformed event", async () => {
      await manager.withLock(RFQ_ID, async () => {
        manager.appendEvent(RFQ_ID, rfqEvent())
        // Try malformed
        const badOffer = makeEvent("OFFER_SUBMITTED", SELLER_A, {})
        try { manager.appendEvent(RFQ_ID, badOffer) } catch { /* expected */ }
        // Valid offer should still work
        const session = manager.appendEvent(RFQ_ID, offerEvent(SELLER_A))
        expect(session.state).toBe(SessionState.NEGOTIATING)
        expect(session.offers).toHaveLength(1)
      })
    })
  })

  // --- hasSession ---

  describe("hasSession", () => {
    it("returns false for non-existent session", () => {
      expect(manager.hasSession("nonexistent")).toBe(false)
    })

    it("returns true after event appended", async () => {
      await manager.withLock(RFQ_ID, async () => {
        manager.appendEvent(RFQ_ID, rfqEvent())
      })
      expect(manager.hasSession(RFQ_ID)).toBe(true)
    })
  })

  // --- withLock serialization ---

  describe("withLock", () => {
    it("serializes operations on the same rfqId", async () => {
      const order: number[] = []

      const op1 = manager.withLock(RFQ_ID, async () => {
        await new Promise((r) => setTimeout(r, 50))
        order.push(1)
      })

      const op2 = manager.withLock(RFQ_ID, async () => {
        order.push(2)
      })

      await Promise.all([op1, op2])
      expect(order).toEqual([1, 2])
    })

    it("allows parallel operations on different rfqIds", async () => {
      const rfq1 = "rfq-parallel-1"
      const rfq2 = "rfq-parallel-2"
      const order: string[] = []

      const op1 = manager.withLock(rfq1, async () => {
        await new Promise((r) => setTimeout(r, 50))
        order.push("rfq1")
      })

      const op2 = manager.withLock(rfq2, async () => {
        order.push("rfq2")
      })

      await Promise.all([op1, op2])
      expect(order[0]).toBe("rfq2")
    })

    it("provides current session state to callback", async () => {
      await manager.withLock(RFQ_ID, async () => {
        manager.appendEvent(RFQ_ID, rfqEvent())
        manager.appendEvent(RFQ_ID, offerEvent(SELLER_A))
      })

      await manager.withLock(RFQ_ID, async (session) => {
        expect(session).not.toBeNull()
        expect(session!.state).toBe(SessionState.NEGOTIATING)
      })
    })

    it("provides null for new session", async () => {
      await manager.withLock("new-rfq", async (session) => {
        expect(session).toBeNull()
      })
    })

    it("FIFO ordering preserved with 3 concurrent operations", async () => {
      const mgr = new SessionManager(store, { lockTimeoutMs: 500 })
      const order: number[] = []

      const op1 = mgr.withLock(RFQ_ID, async () => {
        await new Promise((r) => setTimeout(r, 100))
        order.push(1)
      })
      const op2 = mgr.withLock(RFQ_ID, async () => {
        order.push(2)
      })
      const op3 = mgr.withLock(RFQ_ID, async () => {
        order.push(3)
      })

      await Promise.all([op1, op2, op3])
      expect(order).toEqual([1, 2, 3])
    })
  })

  // --- Lock queue bound ---

  describe("lock queue bound", () => {
    it("rejects when queue is full", async () => {
      const mgr = new SessionManager(store, { maxQueueSize: 2 })

      const blocker = mgr.withLock(RFQ_ID, async () => {
        await new Promise((r) => setTimeout(r, 200))
      })

      const q1 = mgr.withLock(RFQ_ID, async () => {})
      const q2 = mgr.withLock(RFQ_ID, async () => {})

      await expect(
        mgr.withLock(RFQ_ID, async () => {}),
      ).rejects.toThrow(SessionBusyError)

      await blocker
      await q1
      await q2
    })
  })

  // --- Lock timeout ---

  describe("lock timeout", () => {
    it("throws SessionBusyError when lock acquisition times out", async () => {
      const mgr = new SessionManager(store, { lockTimeoutMs: 30 })

      const blocker = mgr.withLock(RFQ_ID, async () => {
        await new Promise((r) => setTimeout(r, 200))
      })

      await expect(
        mgr.withLock(RFQ_ID, async () => {}),
      ).rejects.toThrow(SessionBusyError)

      await blocker
    })
  })

  // --- removeLock ---

  describe("removeLock", () => {
    it("returns true when lock is removed", async () => {
      await manager.withLock(RFQ_ID, async () => {
        manager.appendEvent(RFQ_ID, rfqEvent())
      })
      expect(manager.removeLock(RFQ_ID)).toBe(true)
    })

    it("returns true for non-existent lock", () => {
      expect(manager.removeLock("nonexistent")).toBe(true)
    })

    it("returns false when waiters are queued (does not orphan them)", async () => {
      const mgr = new SessionManager(store, { lockTimeoutMs: 500 })

      // Hold lock with long operation
      const blocker = mgr.withLock(RFQ_ID, async () => {
        // While holding, try to remove — should fail because waiter is queued
        await new Promise((r) => setTimeout(r, 50))
      })

      // Queue a waiter
      const waiter = mgr.withLock(RFQ_ID, async () => {})

      // Give time for waiter to queue
      await new Promise((r) => setTimeout(r, 10))

      // removeLock should refuse because waiter is pending
      expect(mgr.removeLock(RFQ_ID)).toBe(false)

      await blocker
      await waiter
    })

    it("returns false when lock holder is active (no pending waiters)", async () => {
      let removedInside = false
      await manager.withLock(RFQ_ID, async () => {
        // Active holder, no pending waiters — removeLock should refuse
        removedInside = manager.removeLock(RFQ_ID)
      })
      expect(removedInside).toBe(false)
      // After withLock completes, lock can be removed
      expect(manager.removeLock(RFQ_ID)).toBe(true)
    })

    it("active-holder guard prevents concurrent access after removeLock", async () => {
      const order: number[] = []

      const op1 = manager.withLock(RFQ_ID, async () => {
        // Try to remove lock while holding it
        manager.removeLock(RFQ_ID) // should return false, lock stays
        await new Promise((r) => setTimeout(r, 50))
        order.push(1)
      })

      // op2 should queue behind op1 (same lock instance preserved)
      const op2 = manager.withLock(RFQ_ID, async () => {
        order.push(2)
      })

      await Promise.all([op1, op2])
      // FIFO preserved — removeLock inside op1 did NOT break serialization
      expect(order).toEqual([1, 2])
    })
  })
})
