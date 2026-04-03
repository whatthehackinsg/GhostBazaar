import { describe, it, expect, vi } from "vitest"
import Decimal from "decimal.js"
import { LLMBuyerStrategy } from "../src/llm-buyer.js"
import { LLMSellerStrategy } from "../src/llm-seller.js"
import type { BuyerStrategyContext, SellerStrategyContext } from "../src/interfaces.js"

// Mock Anthropic SDK to avoid real API calls
vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: class MockAnthropic {
      messages = {
        create: vi.fn(),
      }
    },
  }
})

const buyerPriv = { budget_soft: new Decimal("40"), budget_hard: new Decimal("45") }
const sellerPriv = { floor_price: new Decimal("30"), target_price: new Decimal("42") }

function makeBuyerCtx(overrides: Partial<BuyerStrategyContext> = {}): BuyerStrategyContext {
  return {
    rfq: { anchor_price: "32.00", service_type: "ghost-bazaar:services:audit", currency: "USDC" } as any,
    private: buyerPriv,
    current_offers: [],
    seller_registry: {},
    counters_sent: [],
    round: 1,
    time_remaining_ms: 30000,
    history: [],
    ...overrides,
  } as BuyerStrategyContext
}

function makeSellerCtx(overrides: Partial<SellerStrategyContext> = {}): SellerStrategyContext {
  return {
    rfq: { anchor_price: "32.00", service_type: "ghost-bazaar:services:audit", currency: "USDC" } as any,
    private: sellerPriv,
    latest_counter: null,
    own_offers: [],
    round: 1,
    time_remaining_ms: 30000,
    competing_sellers: 0,
    seller_listing_profile: null,
    ...overrides,
  }
}

describe("LLMBuyerStrategy", () => {
  it("opening anchor is 80% of budget_soft", () => {
    const buyer = new LLMBuyerStrategy({ apiKey: "fake-key" })
    const anchor = buyer.openingAnchor({ service_type: "test", spec: {} }, buyerPriv)
    expect(anchor.eq(new Decimal("32"))).toBe(true)
  })

  it("waits when no offers", async () => {
    const buyer = new LLMBuyerStrategy({ apiKey: "fake-key" })
    const ctx = makeBuyerCtx()
    const action = await buyer.onOffersReceived(ctx)
    expect(action.type).toBe("wait")
  })

  it("returns accept when LLM says accept", async () => {
    const buyer = new LLMBuyerStrategy({ apiKey: "fake-key" })
    const mockCreate = (buyer as any).client.messages.create
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: '{"action":"accept","seller":"did:key:z6MkSeller"}' }],
    })

    const ctx = makeBuyerCtx({
      current_offers: [{ seller: "did:key:z6MkSeller", price: "39.00" }] as any[],
    })
    const action = await buyer.onOffersReceived(ctx)
    expect(action.type).toBe("accept")
    if (action.type === "accept") expect(action.seller).toBe("did:key:z6MkSeller")
  })

  it("includes registry summary in prompt when available", async () => {
    const buyer = new LLMBuyerStrategy({ apiKey: "fake-key" })
    const mockCreate = (buyer as any).client.messages.create
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: '{"action":"wait"}' }],
    })

    const ctx = makeBuyerCtx({
      current_offers: [{ seller: "did:key:z6MkSeller", price: "43.00" }] as any[],
      seller_registry: {
        "did:key:z6MkSeller": {
          agentId: "42",
          reputationScore: 91,
          totalFeedbacks: 12,
        },
      } as any,
    } as any)

    await buyer.onOffersReceived(ctx)

    const call = mockCreate.mock.calls[0]?.[0]
    expect(call.messages[0].content).toContain("Registry signals")
    expect(call.messages[0].content).toContain("agentId=42")
    expect(call.messages[0].content).toContain("reputation=91")
    expect(call.messages[0].content).toContain("feedbacks=12")
  })

  it("returns counter with price when LLM says counter", async () => {
    const buyer = new LLMBuyerStrategy({ apiKey: "fake-key" })
    const mockCreate = (buyer as any).client.messages.create
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: '{"action":"counter","seller":"did:key:z6MkSeller","price":"37.50"}' }],
    })

    const ctx = makeBuyerCtx({
      current_offers: [{ seller: "did:key:z6MkSeller", price: "43.00" }] as any[],
    })
    const action = await buyer.onOffersReceived(ctx)
    expect(action.type).toBe("counter")
    if (action.type === "counter") {
      expect(action.price.eq(new Decimal("37.50"))).toBe(true)
      expect(action.seller).toBe("did:key:z6MkSeller")
    }
  })

  it("falls back to wait on API error with no acceptable offer", async () => {
    const buyer = new LLMBuyerStrategy({ apiKey: "fake-key" })
    const mockCreate = (buyer as any).client.messages.create
    mockCreate.mockRejectedValueOnce(new Error("API error"))

    const ctx = makeBuyerCtx({
      current_offers: [{ seller: "did:key:z6MkSeller", price: "43.00" }] as any[],
    })
    const action = await buyer.onOffersReceived(ctx)
    expect(action.type).toBe("wait")
  })

  it("falls back to accept on API error when offer within budget_soft", async () => {
    const buyer = new LLMBuyerStrategy({ apiKey: "fake-key" })
    const mockCreate = (buyer as any).client.messages.create
    mockCreate.mockRejectedValueOnce(new Error("API error"))

    const ctx = makeBuyerCtx({
      current_offers: [{ seller: "did:key:z6MkSeller", price: "38.00" }] as any[],
    })
    const action = await buyer.onOffersReceived(ctx)
    expect(action.type).toBe("accept")
  })

  it("handles malformed LLM response gracefully", async () => {
    const buyer = new LLMBuyerStrategy({ apiKey: "fake-key" })
    const mockCreate = (buyer as any).client.messages.create
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "I think you should accept the offer!" }],
    })

    const ctx = makeBuyerCtx({
      current_offers: [{ seller: "did:key:z6MkSeller", price: "43.00" }] as any[],
    })
    const action = await buyer.onOffersReceived(ctx)
    expect(action.type).toBe("wait")
  })

  it("handles LLM response with markdown code block", async () => {
    const buyer = new LLMBuyerStrategy({ apiKey: "fake-key" })
    const mockCreate = (buyer as any).client.messages.create
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: '```json\n{"action":"cancel"}\n```' }],
    })

    const ctx = makeBuyerCtx({
      current_offers: [{ seller: "did:key:z6MkSeller", price: "43.00" }] as any[],
    })
    const action = await buyer.onOffersReceived(ctx)
    expect(action.type).toBe("cancel")
  })

  it("rejects accept for seller not in current_offers", async () => {
    const buyer = new LLMBuyerStrategy({ apiKey: "fake-key" })
    const mockCreate = (buyer as any).client.messages.create
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: '{"action":"accept","seller":"did:key:z6MkUnknown"}' }],
    })

    const ctx = makeBuyerCtx({
      current_offers: [{ seller: "did:key:z6MkSeller", price: "39.00" }] as any[],
    })
    const action = await buyer.onOffersReceived(ctx)
    expect(action.type).toBe("wait")
  })

  it("handles invalid price string from LLM gracefully", async () => {
    const buyer = new LLMBuyerStrategy({ apiKey: "fake-key" })
    const mockCreate = (buyer as any).client.messages.create
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: '{"action":"counter","seller":"did:key:z6MkSeller","price":"garbage"}' }],
    })

    const ctx = makeBuyerCtx({
      current_offers: [{ seller: "did:key:z6MkSeller", price: "43.00" }] as any[],
    })
    const action = await buyer.onOffersReceived(ctx)
    // Decimal("garbage") throws, caught by parseResponse try/catch → wait
    expect(action.type).toBe("wait")
  })

  it("handles empty content array from API", async () => {
    const buyer = new LLMBuyerStrategy({ apiKey: "fake-key" })
    const mockCreate = (buyer as any).client.messages.create
    mockCreate.mockResolvedValueOnce({ content: [] })

    const ctx = makeBuyerCtx({
      current_offers: [{ seller: "did:key:z6MkSeller", price: "43.00" }] as any[],
    })
    const action = await buyer.onOffersReceived(ctx)
    expect(action.type).toBe("wait")
  })

  it("handles explicit wait action from LLM", async () => {
    const buyer = new LLMBuyerStrategy({ apiKey: "fake-key" })
    const mockCreate = (buyer as any).client.messages.create
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: '{"action":"wait"}' }],
    })

    const ctx = makeBuyerCtx({
      current_offers: [{ seller: "did:key:z6MkSeller", price: "43.00" }] as any[],
    })
    const action = await buyer.onOffersReceived(ctx)
    expect(action.type).toBe("wait")
  })
})

describe("LLMSellerStrategy", () => {
  it("returns respond with price when LLM responds to RFQ", async () => {
    const seller = new LLMSellerStrategy({ apiKey: "fake-key" })
    const mockCreate = (seller as any).client.messages.create
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: '{"action":"respond","price":"41.00"}' }],
    })

    const ctx = makeSellerCtx()
    const action = await seller.onRfqReceived(ctx)
    expect(action.type).toBe("respond")
    if (action.type === "respond") expect(action.price.eq(new Decimal("41"))).toBe(true)
  })

  it("returns counter with price when LLM counters", async () => {
    const seller = new LLMSellerStrategy({ apiKey: "fake-key" })
    const mockCreate = (seller as any).client.messages.create
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: '{"action":"counter","price":"39.50"}' }],
    })

    const ctx = makeSellerCtx({ latest_counter: { price: "36.00" } as any })
    const action = await seller.onCounterReceived(ctx)
    expect(action.type).toBe("counter")
    if (action.type === "counter") expect(action.price.eq(new Decimal("39.5"))).toBe(true)
  })

  it("holds when no latest_counter", async () => {
    const seller = new LLMSellerStrategy({ apiKey: "fake-key" })
    const ctx = makeSellerCtx()
    const action = await seller.onCounterReceived(ctx)
    expect(action.type).toBe("hold")
  })

  it("falls back to respond at target_price on API error for new RFQ", async () => {
    const seller = new LLMSellerStrategy({ apiKey: "fake-key" })
    const mockCreate = (seller as any).client.messages.create
    mockCreate.mockRejectedValueOnce(new Error("API error"))

    const ctx = makeSellerCtx()
    const action = await seller.onRfqReceived(ctx)
    expect(action.type).toBe("respond")
    if (action.type === "respond") expect(action.price.eq(new Decimal("42"))).toBe(true)
  })

  it("falls back to hold on API error for counter", async () => {
    const seller = new LLMSellerStrategy({ apiKey: "fake-key" })
    const mockCreate = (seller as any).client.messages.create
    mockCreate.mockRejectedValueOnce(new Error("API error"))

    const ctx = makeSellerCtx({ latest_counter: { price: "36.00" } as any })
    const action = await seller.onCounterReceived(ctx)
    expect(action.type).toBe("hold")
  })

  it("returns decline when LLM says decline", async () => {
    const seller = new LLMSellerStrategy({ apiKey: "fake-key" })
    const mockCreate = (seller as any).client.messages.create
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: '{"action":"decline"}' }],
    })

    const ctx = makeSellerCtx({ latest_counter: { price: "20.00" } as any })
    const action = await seller.onCounterReceived(ctx)
    expect(action.type).toBe("decline")
  })

  it("handles malformed LLM response gracefully", async () => {
    const seller = new LLMSellerStrategy({ apiKey: "fake-key" })
    const mockCreate = (seller as any).client.messages.create
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "Sure, I can help!" }],
    })

    const ctx = makeSellerCtx({ latest_counter: { price: "36.00" } as any })
    const action = await seller.onCounterReceived(ctx)
    expect(action.type).toBe("hold")
  })

  it("handles invalid price string from LLM gracefully", async () => {
    const seller = new LLMSellerStrategy({ apiKey: "fake-key" })
    const mockCreate = (seller as any).client.messages.create
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: '{"action":"respond","price":"not-a-number"}' }],
    })

    const ctx = makeSellerCtx()
    const action = await seller.onRfqReceived(ctx)
    // Decimal("not-a-number") throws, caught by parseResponse try/catch → hold
    expect(action.type).toBe("hold")
  })

  it("handles empty content array from API", async () => {
    const seller = new LLMSellerStrategy({ apiKey: "fake-key" })
    const mockCreate = (seller as any).client.messages.create
    mockCreate.mockResolvedValueOnce({ content: [] })

    const ctx = makeSellerCtx()
    const action = await seller.onRfqReceived(ctx)
    // Empty content → empty text → no JSON match → hold (fallback on error)
    expect(action.type).toBe("hold")
  })

  it("handles explicit hold action from LLM", async () => {
    const seller = new LLMSellerStrategy({ apiKey: "fake-key" })
    const mockCreate = (seller as any).client.messages.create
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: '{"action":"hold"}' }],
    })

    const ctx = makeSellerCtx({ latest_counter: { price: "36.00" } as any })
    const action = await seller.onCounterReceived(ctx)
    expect(action.type).toBe("hold")
  })
})
