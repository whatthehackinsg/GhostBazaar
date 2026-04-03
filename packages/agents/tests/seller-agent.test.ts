import { describe, it, expect, vi, beforeEach } from "vitest"
import { Keypair } from "@solana/web3.js"
import Decimal from "decimal.js"
import { buildDid } from "@ghost-bazaar/core"
import type { SellerStrategy, SellerStrategyContext, SellerAction, SellerPrivate } from "@ghost-bazaar/strategy"
import { SellerAgent } from "../src/seller-agent.js"
import type { RFQ } from "@ghost-bazaar/core"

// Stub strategy that responds at target_price
class StubSellerStrategy implements SellerStrategy {
  onRfqReceived(ctx: SellerStrategyContext): SellerAction {
    return { type: "respond", price: ctx.private.target_price }
  }
  onCounterReceived(ctx: SellerStrategyContext): SellerAction {
    // Concede 10% toward counter
    const counter = ctx.latest_counter
    if (!counter) return { type: "hold" }
    const lastOwnPrice = ctx.own_offers.length > 0
      ? new Decimal(ctx.own_offers[ctx.own_offers.length - 1].price)
      : ctx.private.target_price
    const counterPrice = new Decimal(counter.price)
    const newPrice = lastOwnPrice.minus(lastOwnPrice.minus(counterPrice).times(0.1))
    return { type: "counter", price: newPrice }
  }
}

const mockResponses = new Map<string, any>()

function setupMockFetch() {
  globalThis.fetch = vi.fn(async (url: string, init?: any) => {
    const method = init?.method ?? "GET"
    const key = `${method} ${url}`

    for (const [pattern, response] of mockResponses) {
      if (key.includes(pattern) || url.includes(pattern)) {
        return {
          ok: true,
          status: 200,
          json: async () => response,
        } as Response
      }
    }

    return {
      ok: true,
      status: 200,
      json: async () => ({}),
    } as Response
  }) as any
}

function makeRfq(buyerDid: string): RFQ {
  return {
    rfq_id: "rfq-001",
    protocol: "ghost-bazaar-v4",
    buyer: buyerDid,
    service_type: "smart-contract-audit",
    spec: { language: "Solidity" },
    anchor_price: "25.00",
    currency: "USDC",
    deadline: new Date(Date.now() + 300_000).toISOString(),
    signature: "ed25519:fakebuyersig",
  }
}

describe("SellerAgent", () => {
  const keypair = Keypair.generate()
  const did = buildDid(keypair.publicKey)
  const buyerKeypair = Keypair.generate()
  const buyerDid = buildDid(buyerKeypair.publicKey)
  let agent: SellerAgent

  beforeEach(() => {
    mockResponses.clear()
    setupMockFetch()
    agent = new SellerAgent({
      keypair,
      strategy: new StubSellerStrategy(),
      floorPrice: "20.00",
      targetPrice: "45.00",
      engineUrl: "http://localhost:3000",
      listingId: "listing-test",
    })
  })

  it("has correct DID identity", () => {
    expect(agent.did).toBe(did)
    expect(agent.did).toMatch(/^did:key:z6Mk/)
  })

  it("responds to RFQ with signed offer", async () => {
    mockResponses.set("/offers", { offer_id: "offer-1" })

    const rfq = makeRfq(buyerDid)
    const session = await agent.respondToRfq(rfq)

    expect(session.rfqId).toBe("rfq-001")
    expect(session.ownOffers).toHaveLength(1)
    expect(session.ownOffers[0].seller).toBe(did)
    expect(session.ownOffers[0].price).toBe("45")
    expect(session.ownOffers[0].signature).toMatch(/^ed25519:/)
    expect(session.stopped).toBe(false)
  })

  it("poll processes counter events and responds", async () => {
    mockResponses.set("/offers", { offer_id: "offer-1" })

    const rfq = makeRfq(buyerDid)
    const session = await agent.respondToRfq(rfq)

    // Mock counter event from buyer
    mockResponses.set("/events", {
      events: [
        {
          event_id: "evt-1",
          rfq_id: rfq.rfq_id,
          type: "COUNTER_SENT",
          actor: buyerDid,
          payload: {
            counter_id: "counter-1",
            rfq_id: rfq.rfq_id,
            round: 1,
            from: buyerDid,
            to: did,
            price: "30.00",
            currency: "USDC",
            valid_until: rfq.deadline,
            signature: "ed25519:fake",
          },
          timestamp: new Date().toISOString(),
        },
      ],
    })

    await agent.poll(rfq.rfq_id)

    // Should have created a counter-offer
    expect(session.ownOffers.length).toBeGreaterThanOrEqual(2)
    expect(session.round).toBe(1)

    const eventCall = (fetch as any).mock.calls.find(([url]: [string]) => String(url).includes("/events"))
    expect(String(eventCall?.[0])).not.toContain("after=-1")
  })

  it("sanitizes offer price to floor_price", async () => {
    // Strategy that tries to price below floor
    const cheapStrategy: SellerStrategy = {
      onRfqReceived: () => ({ type: "respond", price: new Decimal("5.00") }),
      onCounterReceived: () => ({ type: "hold" }),
    }

    const cheapAgent = new SellerAgent({
      keypair,
      strategy: cheapStrategy,
      floorPrice: "20.00",
      targetPrice: "45.00",
      engineUrl: "http://localhost:3000",
      listingId: "listing-test",
    })

    mockResponses.set("/offers", { offer_id: "offer-1" })

    const rfq = makeRfq(buyerDid)
    const session = await cheapAgent.respondToRfq(rfq)

    // Price should be clamped to floor_price (20.00)
    expect(session.ownOffers).toHaveLength(1)
    expect(new Decimal(session.ownOffers[0].price).gte(new Decimal("20.00"))).toBe(true)
  })

  it("stops on decline action", async () => {
    const decliner: SellerStrategy = {
      onRfqReceived: () => ({ type: "decline" }),
      onCounterReceived: () => ({ type: "decline" }),
    }

    const decliningAgent = new SellerAgent({
      keypair,
      strategy: decliner,
      floorPrice: "20.00",
      targetPrice: "45.00",
      engineUrl: "http://localhost:3000",
      listingId: "listing-test",
    })

    const rfq = makeRfq(buyerDid)
    const session = await decliningAgent.respondToRfq(rfq)

    expect(session.stopped).toBe(true)
    expect(session.ownOffers).toHaveLength(0)
  })
})
