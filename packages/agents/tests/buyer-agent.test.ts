import { describe, it, expect, vi, beforeEach } from "vitest"
import { Keypair } from "@solana/web3.js"
import Decimal from "decimal.js"
import { buildDid } from "@ghost-bazaar/core"
import type { BuyerStrategy, BuyerStrategyContext, BuyerAction, BuyerPrivate, ServiceIntent } from "@ghost-bazaar/strategy"
import { BuyerAgent } from "../src/buyer-agent.js"

// Stub strategy that always counters at budget_soft
class StubBuyerStrategy implements BuyerStrategy {
  openingAnchor(_intent: ServiceIntent, priv: BuyerPrivate): Decimal {
    return priv.budget_soft
  }
  onOffersReceived(ctx: BuyerStrategyContext): BuyerAction {
    if (ctx.current_offers.length === 0) return { type: "wait" }
    const seller = ctx.current_offers[0].seller
    return { type: "counter", seller, price: ctx.private.budget_soft }
  }
}

// Mock fetch for engine HTTP calls
const mockResponses = new Map<string, any>()

function setupMockFetch() {
  globalThis.fetch = vi.fn(async (url: string, init?: any) => {
    const method = init?.method ?? "GET"
    const urlStr = String(url)

    // Match most specific patterns first (longest match)
    const sorted = [...mockResponses.entries()].sort((a, b) => b[0].length - a[0].length)
    for (const [pattern, response] of sorted) {
      if (urlStr.includes(pattern)) {
        return {
          ok: true,
          status: 200,
          json: async () => response,
        } as Response
      }
    }

    // Default: return empty array for GET (events/listings), empty object for POST
    const isGet = method === "GET"
    return {
      ok: true,
      status: 200,
      json: async () => (isGet ? [] : {}),
    } as Response
  }) as any
}

describe("BuyerAgent", () => {
  const keypair = Keypair.generate()
  const did = buildDid(keypair.publicKey)
  let agent: BuyerAgent

  beforeEach(() => {
    mockResponses.clear()
    setupMockFetch()
    agent = new BuyerAgent({
      keypair,
      strategy: new StubBuyerStrategy(),
      budgetSoft: "30.00",
      budgetHard: "50.00",
      engineUrl: "http://localhost:3000",
    })
  })

  it("has correct DID identity", () => {
    expect(agent.did).toBe(did)
    expect(agent.did).toMatch(/^did:key:z6Mk/)
  })

  it("posts RFQ with signed payload", async () => {
    mockResponses.set("/rfqs", { rfq_id: "test-rfq" })

    const session = await agent.postRfq({
      serviceType: "smart-contract-audit",
      spec: { language: "Solidity" },
      anchorPrice: "25.00",
      deadlineSeconds: 300,
    })

    expect(session.rfqId).toBeDefined()
    expect(session.rfq.buyer).toBe(did)
    expect(session.rfq.protocol).toBe("ghost-bazaar-v4")
    expect(session.rfq.signature).toMatch(/^ed25519:/)
    expect(session.rfq.currency).toBe("USDC")
    expect(session.stopped).toBe(false)
  })

  it("postRfq generates budget_commitment when zkProver is provided", async () => {
    mockResponses.set("/rfqs", { rfq_id: "test-rfq" })

    const zkAgent = new BuyerAgent({
      keypair,
      strategy: new StubBuyerStrategy(),
      budgetSoft: "30.00",
      budgetHard: "50.00",
      engineUrl: "http://localhost:3000",
      zkProver: {
        generateBudgetCommitment: async () => "poseidon:" + "ab".repeat(32),
        generateBudgetProof: async () => ({ protocol: "groth16", curve: "bn128" }),
      },
    })

    const session = await zkAgent.postRfq({
      serviceType: "audit",
      spec: {},
      anchorPrice: "25.00",
      deadlineSeconds: 300,
    })

    expect(session.rfq.budget_commitment).toMatch(/^poseidon:[0-9a-f]{64}$/)
  })

  it("poll processes offer events and applies strategy", async () => {
    mockResponses.set("/rfqs", {})

    const session = await agent.postRfq({
      serviceType: "audit",
      spec: {},
      anchorPrice: "25.00",
      deadlineSeconds: 300,
    })

    const sellerDid = buildDid(Keypair.generate().publicKey)

    // Mock events endpoint returning an offer
    mockResponses.set("/events", {
      events: [
        {
          event_id: "evt-1",
          rfq_id: session.rfqId,
          type: "OFFER_SUBMITTED",
          actor: sellerDid,
          payload: {
            offer_id: "offer-1",
            rfq_id: session.rfqId,
            seller: sellerDid,
            price: "40.00",
            currency: "USDC",
            valid_until: new Date(Date.now() + 300_000).toISOString(),
            signature: "ed25519:fake",
          },
          timestamp: new Date().toISOString(),
        },
      ],
    })

    // Mock counter endpoint
    mockResponses.set("/counter", { counter_id: "counter-1" })

    await agent.poll(session.rfqId)

    expect(session.offers).toHaveLength(1)
    expect(session.offers[0].seller).toBe(sellerDid)
    // Strategy should have produced a counter
    expect(session.countersSent).toHaveLength(1)
    expect(session.countersSent[0].from).toBe(did)
    expect(session.countersSent[0].signature).toMatch(/^ed25519:/)

    const eventCall = (fetch as any).mock.calls.find(([url]: [string]) => String(url).includes("/events"))
    expect(String(eventCall?.[0])).not.toContain("after=-1")
  })

  it("does not poll stopped session", async () => {
    mockResponses.set("/rfqs", {})
    const session = await agent.postRfq({
      serviceType: "audit",
      spec: {},
      anchorPrice: "25.00",
      deadlineSeconds: 300,
    })
    session.stopped = true

    // Should be a no-op
    await agent.poll(session.rfqId)
    expect(session.events).toHaveLength(0)
  })

  it("sanitizes counter price to budget_hard", async () => {
    // Strategy that tries to counter above budget_hard
    const greedyStrategy: BuyerStrategy = {
      openingAnchor: () => new Decimal("25"),
      onOffersReceived: (ctx) => {
        if (ctx.current_offers.length === 0) return { type: "wait" }
        return {
          type: "counter",
          seller: ctx.current_offers[0].seller,
          price: new Decimal("999.99"), // Way above budget_hard
        }
      },
    }

    const greedyAgent = new BuyerAgent({
      keypair,
      strategy: greedyStrategy,
      budgetSoft: "30.00",
      budgetHard: "50.00",
      engineUrl: "http://localhost:3000",
    })

    mockResponses.set("/rfqs", {})
    const session = await greedyAgent.postRfq({
      serviceType: "audit",
      spec: {},
      anchorPrice: "25.00",
      deadlineSeconds: 300,
    })

    const sellerDid = buildDid(Keypair.generate().publicKey)
    mockResponses.set("/events", {
      events: [
        {
          event_id: "evt-1",
          rfq_id: session.rfqId,
          type: "OFFER_SUBMITTED",
          actor: sellerDid,
          payload: {
            offer_id: "offer-1",
            rfq_id: session.rfqId,
            seller: sellerDid,
            price: "60.00",
            currency: "USDC",
            valid_until: new Date(Date.now() + 300_000).toISOString(),
            signature: "ed25519:fake",
          },
          timestamp: new Date().toISOString(),
        },
      ],
    })
    mockResponses.set("/counter", { counter_id: "counter-1" })

    await greedyAgent.poll(session.rfqId)

    // Price should be clamped to budget_hard (50.00)
    expect(session.countersSent).toHaveLength(1)
    expect(new Decimal(session.countersSent[0].price).lte(new Decimal("50.00"))).toBe(true)
  })
})
