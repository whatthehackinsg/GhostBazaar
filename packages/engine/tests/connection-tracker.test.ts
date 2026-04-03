import { describe, it, expect, vi } from "vitest"
import { ConnectionTracker } from "../src/util/connection-tracker.js"

const RFQ = "rfq-1"
const BUYER = "did:key:buyer"
const SELLER_A = "did:key:sellerA"
const SELLER_B = "did:key:sellerB"

function noop() {}

describe("ConnectionTracker", () => {
  it("allows connection within limits", () => {
    const tracker = new ConnectionTracker()
    const id = tracker.acquire({ rfqId: RFQ, callerDid: BUYER, isBuyer: true, close: noop })
    expect(id).not.toBeNull()
    expect(tracker.countForSession(RFQ)).toBe(1)
    expect(tracker.countForDid(RFQ, BUYER)).toBe(1)
  })

  it("rejects 4th connection from same DID", () => {
    const tracker = new ConnectionTracker()
    tracker.acquire({ rfqId: RFQ, callerDid: SELLER_A, isBuyer: false, close: noop })
    tracker.acquire({ rfqId: RFQ, callerDid: SELLER_A, isBuyer: false, close: noop })
    tracker.acquire({ rfqId: RFQ, callerDid: SELLER_A, isBuyer: false, close: noop })
    const fourth = tracker.acquire({ rfqId: RFQ, callerDid: SELLER_A, isBuyer: false, close: noop })
    expect(fourth).toBeNull()
  })

  it("rejects 11th total connection from non-buyer", () => {
    const tracker = new ConnectionTracker()
    for (let i = 0; i < 10; i++) {
      const did = `did:key:seller${i}`
      const id = tracker.acquire({ rfqId: RFQ, callerDid: did, isBuyer: false, close: noop })
      expect(id).not.toBeNull()
    }
    const eleventh = tracker.acquire({ rfqId: RFQ, callerDid: "did:key:seller10", isBuyer: false, close: noop })
    expect(eleventh).toBeNull()
    expect(tracker.countForSession(RFQ)).toBe(10)
  })

  it("buyer evicts oldest non-buyer when at capacity", () => {
    const tracker = new ConnectionTracker()
    const closeFns: Array<ReturnType<typeof vi.fn>> = []

    for (let i = 0; i < 10; i++) {
      const did = `did:key:seller${i}`
      const close = vi.fn()
      closeFns.push(close)
      tracker.acquire({ rfqId: RFQ, callerDid: did, isBuyer: false, close })
    }

    const buyerId = tracker.acquire({ rfqId: RFQ, callerDid: BUYER, isBuyer: true, close: noop })
    expect(buyerId).not.toBeNull()
    expect(closeFns[0]).toHaveBeenCalledOnce()
    expect(closeFns[1]).not.toHaveBeenCalled()
    expect(tracker.countForSession(RFQ)).toBe(10)
  })

  it("release frees a slot", () => {
    const tracker = new ConnectionTracker()
    const id = tracker.acquire({ rfqId: RFQ, callerDid: SELLER_A, isBuyer: false, close: noop })!
    expect(tracker.countForSession(RFQ)).toBe(1)
    tracker.release(id)
    expect(tracker.countForSession(RFQ)).toBe(0)
  })

  it("closeAll terminates all connections for a session", () => {
    const tracker = new ConnectionTracker()
    const close1 = vi.fn()
    const close2 = vi.fn()
    tracker.acquire({ rfqId: RFQ, callerDid: SELLER_A, isBuyer: false, close: close1 })
    tracker.acquire({ rfqId: RFQ, callerDid: SELLER_B, isBuyer: false, close: close2 })

    tracker.closeAll(RFQ)
    expect(close1).toHaveBeenCalledOnce()
    expect(close2).toHaveBeenCalledOnce()
    expect(tracker.countForSession(RFQ)).toBe(0)
  })

  it("separate sessions have independent limits", () => {
    const tracker = new ConnectionTracker()
    tracker.acquire({ rfqId: "rfq-1", callerDid: SELLER_A, isBuyer: false, close: noop })
    tracker.acquire({ rfqId: "rfq-2", callerDid: SELLER_A, isBuyer: false, close: noop })
    expect(tracker.countForSession("rfq-1")).toBe(1)
    expect(tracker.countForSession("rfq-2")).toBe(1)
    expect(tracker.countForDid("rfq-1", SELLER_A)).toBe(1)
    expect(tracker.countForDid("rfq-2", SELLER_A)).toBe(1)
  })
})
