import { describe, it, expect, vi, beforeEach } from "vitest"
import { Keypair } from "@solana/web3.js"
import Decimal from "decimal.js"
import { buildDid } from "@ghost-bazaar/core"
import type { SellerStrategy, SellerAction } from "@ghost-bazaar/strategy"
import { SellerAgent } from "../src/seller-agent.js"
import type { RFQ } from "@ghost-bazaar/core"

const simpleStrategy: SellerStrategy = {
  onRfqReceived: () => ({ type: "respond", price: new Decimal("40.00") }),
  onCounterReceived: () => ({ type: "hold" }),
}

const mockResponses = new Map<string, any>()

function setupMockFetch() {
  globalThis.fetch = vi.fn(async (url: string, init?: any) => {
    const method = init?.method ?? "GET"
    const urlStr = String(url)
    const sorted = [...mockResponses.entries()].sort((a, b) => b[0].length - a[0].length)
    for (const [pattern, response] of sorted) {
      if (urlStr.includes(pattern)) {
        return { ok: true, status: 200, json: async () => response } as Response
      }
    }
    const isGet = method === "GET"
    return { ok: true, status: 200, json: async () => (isGet ? [] : {}) } as Response
  }) as any
}

describe("SellerAgent.respondToRfqs", () => {
  const keypair = Keypair.generate()
  const buyerDid = buildDid(Keypair.generate().publicKey)
  let agent: SellerAgent

  beforeEach(() => {
    mockResponses.clear()
    setupMockFetch()
    agent = new SellerAgent({
      keypair,
      strategy: simpleStrategy,
      floorPrice: "20.00",
      targetPrice: "40.00",
      engineUrl: "http://localhost:3000",
      listingId: "listing-test",
    })
  })

  it("responds to a batch of RFQs", async () => {
    const rfq: RFQ = {
      rfq_id: "rfq-discover-1",
      protocol: "ghost-bazaar-v4",
      buyer: buyerDid,
      service_type: "audit",
      spec: {},
      anchor_price: "25.00",
      currency: "USDC",
      deadline: new Date(Date.now() + 300_000).toISOString(),
      signature: "ed25519:fake",
    }

    mockResponses.set("/offers", { offer_id: "o1" })

    const sessions = await agent.respondToRfqs([rfq])

    expect(sessions).toHaveLength(1)
    expect(sessions[0].rfqId).toBe("rfq-discover-1")
    expect(sessions[0].ownOffers).toHaveLength(1)
  })

  it("does not re-respond to already-tracked RFQs", async () => {
    const rfq: RFQ = {
      rfq_id: "rfq-dup-1",
      protocol: "ghost-bazaar-v4",
      buyer: buyerDid,
      service_type: "audit",
      spec: {},
      anchor_price: "25.00",
      currency: "USDC",
      deadline: new Date(Date.now() + 300_000).toISOString(),
      signature: "ed25519:fake",
    }

    mockResponses.set("/offers", { offer_id: "o1" })

    await agent.respondToRfqs([rfq])
    const second = await agent.respondToRfqs([rfq])

    expect(second).toHaveLength(0)
  })
})

describe("SellerAgent settlement timing", () => {
  const keypair = Keypair.generate()

  beforeEach(() => {
    mockResponses.clear()
    setupMockFetch()
  })

  it("settledAt is null after cosigning, set only via markSettled()", async () => {
    const agent = new SellerAgent({
      keypair,
      strategy: simpleStrategy,
      floorPrice: "20.00",
      targetPrice: "40.00",
      engineUrl: "http://localhost:3000",
      listingId: "listing-test",
    })

    const rfq: RFQ = {
      rfq_id: "rfq-settle-timing",
      protocol: "ghost-bazaar-v4",
      buyer: buildDid(Keypair.generate().publicKey),
      service_type: "audit",
      spec: {},
      anchor_price: "25.00",
      currency: "USDC",
      deadline: new Date(Date.now() + 300_000).toISOString(),
      signature: "ed25519:fake",
    }

    mockResponses.set("/offers", { offer_id: "o1" })
    const session = await agent.respondToRfq(rfq)

    expect(session.settledAt).toBeNull()

    agent.markSettled(rfq.rfq_id)
    expect(session.settledAt).toBeGreaterThan(0)
  })
})
