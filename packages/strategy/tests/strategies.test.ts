import { describe, it, expect } from "vitest"
import Decimal from "decimal.js"
import { LinearConcessionBuyer } from "../src/linear-concession.js"
import { TimeWeightedBuyer } from "../src/time-weighted-buyer.js"
import { CompetitiveBuyer } from "../src/competitive-buyer.js"
import { CompetitiveSeller } from "../src/competitive-seller.js"
import { FirmSeller } from "../src/firm-seller.js"
import { FlexibleSeller } from "../src/flexible-seller.js"
import type { BuyerStrategyContext, SellerStrategyContext, BuyerPrivate, SellerPrivate } from "../src/interfaces.js"

const buyerPriv: BuyerPrivate = { budget_soft: new Decimal("40"), budget_hard: new Decimal("45") }
const sellerPriv: SellerPrivate = { floor_price: new Decimal("30"), target_price: new Decimal("42") }
const intent = { service_type: "ghost-bazaar:services:audit", spec: {} }

function makeBuyerCtx(overrides: Partial<BuyerStrategyContext> = {}): BuyerStrategyContext {
  return {
    rfq: { anchor_price: "32.00" } as any,
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
    rfq: { anchor_price: "32.00" } as any,
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

describe("LinearConcessionBuyer", () => {
  const buyer = new LinearConcessionBuyer()

  it("opening anchor = 80% of budget_soft", () => {
    const anchor = buyer.openingAnchor(intent, buyerPriv)
    expect(anchor.eq(new Decimal("32"))).toBe(true)
  })

  it("accepts offer at budget_soft", () => {
    const ctx = makeBuyerCtx({
      current_offers: [{ seller: "did:key:z6Mk...", price: "40.00" }] as any[],
    })
    const action = buyer.onOffersReceived(ctx)
    expect(action.type).toBe("accept")
  })

  it("accepts offer below budget_soft", () => {
    const ctx = makeBuyerCtx({
      current_offers: [{ seller: "did:key:z6Mk...", price: "38.00" }] as any[],
    })
    const action = buyer.onOffersReceived(ctx)
    expect(action.type).toBe("accept")
  })

  it("accepts the cheapest in-budget offer even when a pricier near-tie has better reputation", () => {
    const ctx = makeBuyerCtx({
      current_offers: [
        { seller: "sellerA", price: "39.80" },
        { seller: "sellerB", price: "40.60" },
      ] as any[],
      seller_registry: {
        sellerA: { agentId: "42", reputationScore: 10, totalFeedbacks: 1 },
        sellerB: { agentId: "43", reputationScore: 99, totalFeedbacks: 50 },
      } as any,
    })
    const action = buyer.onOffersReceived(ctx)
    expect(action).toEqual({ type: "accept", seller: "sellerA" })
  })

  it("counters when offer above budget_soft", () => {
    const ctx = makeBuyerCtx({
      current_offers: [{ seller: "did:key:z6Mk...", price: "43.00" }] as any[],
    })
    const action = buyer.onOffersReceived(ctx)
    expect(action.type).toBe("counter")
  })

  it("counter price increases with rounds", () => {
    const ctx1 = makeBuyerCtx({
      current_offers: [{ seller: "did:key:z6Mk...", price: "43.00" }] as any[],
      round: 1,
    })
    const ctx3 = makeBuyerCtx({
      current_offers: [{ seller: "did:key:z6Mk...", price: "43.00" }] as any[],
      round: 3,
    })
    const a1 = buyer.onOffersReceived(ctx1)
    const a3 = buyer.onOffersReceived(ctx3)
    expect(a1.type).toBe("counter")
    expect(a3.type).toBe("counter")
    if (a1.type === "counter" && a3.type === "counter") {
      expect(a3.price.gt(a1.price)).toBe(true)
    }
  })

  it("linear step = (budget_soft - anchor) / 5 per round", () => {
    const ctx = makeBuyerCtx({
      current_offers: [{ seller: "did:key:z6Mk...", price: "43.00" }] as any[],
      round: 1,
    })
    const action = buyer.onOffersReceived(ctx)
    // step = (40 - 32) / 5 = 1.6, price = 32 + 1.6*1 = 33.60
    if (action.type === "counter") expect(action.price.eq(new Decimal("33.6"))).toBe(true)
  })

  it("waits when no offers", () => {
    const ctx = makeBuyerCtx()
    expect(buyer.onOffersReceived(ctx).type).toBe("wait")
  })
})

describe("TimeWeightedBuyer", () => {
  const buyer = new TimeWeightedBuyer()

  it("opening anchor = 75% of budget_soft", () => {
    const anchor = buyer.openingAnchor(intent, buyerPriv)
    expect(anchor.eq(new Decimal("30"))).toBe(true)
  })

  it("accepts offer at budget_soft", () => {
    const ctx = makeBuyerCtx({
      current_offers: [{ seller: "did:key:z6Mk...", price: "40.00" }] as any[],
    })
    const action = buyer.onOffersReceived(ctx)
    expect(action.type).toBe("accept")
  })

  it("accepts the cheapest in-budget offer even when a pricier near-tie has better reputation", () => {
    const ctx = makeBuyerCtx({
      current_offers: [
        { seller: "sellerA", price: "39.80" },
        { seller: "sellerB", price: "40.60" },
      ] as any[],
      seller_registry: {
        sellerA: { agentId: "42", reputationScore: 10, totalFeedbacks: 1 },
        sellerB: { agentId: "43", reputationScore: 99, totalFeedbacks: 50 },
      } as any,
    })
    const action = buyer.onOffersReceived(ctx)
    expect(action).toEqual({ type: "accept", seller: "sellerA" })
  })

  it("concedes more in later rounds", () => {
    const ctx1 = makeBuyerCtx({
      current_offers: [{ seller: "did:key:z6Mk...", price: "43.00" }] as any[],
      round: 1,
    })
    const ctx4 = makeBuyerCtx({
      current_offers: [{ seller: "did:key:z6Mk...", price: "43.00" }] as any[],
      round: 4,
    })
    const a1 = buyer.onOffersReceived(ctx1)
    const a4 = buyer.onOffersReceived(ctx4)
    expect(a1.type).toBe("counter")
    expect(a4.type).toBe("counter")
    if (a1.type === "counter" && a4.type === "counter") {
      expect(a4.price.gt(a1.price)).toBe(true)
    }
  })

  it("counter price never exceeds budget_hard", () => {
    const ctx = makeBuyerCtx({
      current_offers: [{ seller: "did:key:z6Mk...", price: "50.00" }] as any[],
      round: 10,
    })
    const action = buyer.onOffersReceived(ctx)
    if (action.type === "counter") expect(action.price.lte(new Decimal("45"))).toBe(true)
  })

  it("waits when no offers", () => {
    const ctx = makeBuyerCtx()
    expect(buyer.onOffersReceived(ctx).type).toBe("wait")
  })
})

describe("CompetitiveBuyer", () => {
  const buyer = new CompetitiveBuyer()

  it("opening anchor = 70% of budget_soft", () => {
    const anchor = buyer.openingAnchor(intent, buyerPriv)
    expect(anchor.eq(new Decimal("28"))).toBe(true)
  })

  it("accepts best offer at budget_soft", () => {
    const ctx = makeBuyerCtx({
      current_offers: [{ seller: "did:key:z6Mk...", price: "40.00" }] as any[],
    })
    const action = buyer.onOffersReceived(ctx)
    expect(action.type).toBe("accept")
  })

  it("accepts the cheapest in-budget offer even when a pricier near-tie has better reputation", () => {
    const ctx = makeBuyerCtx({
      current_offers: [
        { seller: "sellerA", price: "39.80" },
        { seller: "sellerB", price: "40.60" },
      ] as any[],
      seller_registry: {
        sellerA: { agentId: "42", reputationScore: 10, totalFeedbacks: 1 },
        sellerB: { agentId: "43", reputationScore: 99, totalFeedbacks: 50 },
      } as any,
    })
    const action = buyer.onOffersReceived(ctx)
    expect(action).toEqual({ type: "accept", seller: "sellerA" })
  })

  it("concedes less with 3+ sellers", () => {
    const ctx1 = makeBuyerCtx({
      current_offers: [{ seller: "sellerA", price: "43.00" }] as any[],
      round: 1,
    })
    const ctx3 = makeBuyerCtx({
      current_offers: [
        { seller: "sellerA", price: "43.00" },
        { seller: "sellerB", price: "44.00" },
        { seller: "sellerC", price: "45.00" },
      ] as any[],
      round: 1,
    })
    const a1 = buyer.onOffersReceived(ctx1)
    const a3 = buyer.onOffersReceived(ctx3)
    expect(a1.type).toBe("counter")
    expect(a3.type).toBe("counter")
    if (a1.type === "counter" && a3.type === "counter") {
      expect(a3.price.lt(a1.price)).toBe(true)
    }
  })

  it("concedes less with 2 sellers vs 1", () => {
    const ctx1 = makeBuyerCtx({
      current_offers: [{ seller: "sellerA", price: "43.00" }] as any[],
      round: 1,
    })
    const ctx2 = makeBuyerCtx({
      current_offers: [
        { seller: "sellerA", price: "43.00" },
        { seller: "sellerB", price: "44.00" },
      ] as any[],
      round: 1,
    })
    const a1 = buyer.onOffersReceived(ctx1)
    const a2 = buyer.onOffersReceived(ctx2)
    expect(a1.type).toBe("counter")
    expect(a2.type).toBe("counter")
    if (a1.type === "counter" && a2.type === "counter") {
      expect(a2.price.lt(a1.price)).toBe(true)
    }
  })

  it("picks lowest-priced seller for counter", () => {
    const ctx = makeBuyerCtx({
      current_offers: [
        { seller: "sellerB", price: "44.00" },
        { seller: "sellerA", price: "41.00" },
      ] as any[],
      round: 1,
    })
    const action = buyer.onOffersReceived(ctx)
    if (action.type === "counter") expect(action.seller).toBe("sellerA")
  })

  it("breaks near price ties using higher reputation", () => {
    const ctx = makeBuyerCtx({
      current_offers: [
        { seller: "sellerA", price: "42.90" },
        { seller: "sellerB", price: "42.80" },
      ] as any[],
      seller_registry: {
        sellerA: { agentId: "42", reputationScore: 95, totalFeedbacks: 18 },
        sellerB: { agentId: "43", reputationScore: 20, totalFeedbacks: 2 },
      } as any,
    } as any)
    const action = buyer.onOffersReceived(ctx)
    expect(action.type).toBe("counter")
    if (action.type === "counter") expect(action.seller).toBe("sellerA")
  })

  it("still prefers meaningfully cheaper offer over better reputation", () => {
    const ctx = makeBuyerCtx({
      current_offers: [
        { seller: "sellerA", price: "43.50" },
        { seller: "sellerB", price: "41.00" },
      ] as any[],
      seller_registry: {
        sellerA: { agentId: "42", reputationScore: 99, totalFeedbacks: 50 },
        sellerB: { agentId: "43", reputationScore: 5, totalFeedbacks: 1 },
      } as any,
    } as any)
    const action = buyer.onOffersReceived(ctx)
    expect(action.type).toBe("counter")
    if (action.type === "counter") expect(action.seller).toBe("sellerB")
  })

  it("waits when no offers", () => {
    const ctx = makeBuyerCtx()
    expect(buyer.onOffersReceived(ctx).type).toBe("wait")
  })
})

describe("FirmSeller", () => {
  const seller = new FirmSeller()

  it("opens at target_price", () => {
    const ctx = makeSellerCtx()
    const action = seller.onRfqReceived(ctx)
    expect(action.type).toBe("respond")
    if (action.type === "respond") expect(action.price.eq(new Decimal("42"))).toBe(true)
  })

  it("concedes 5% of range per round", () => {
    const ctx = makeSellerCtx({ latest_counter: { price: "36" } as any, round: 1 })
    const action = seller.onCounterReceived(ctx)
    // range = 42 - 30 = 12, step = 12 * 0.05 = 0.6, price = 42 - 0.6 = 41.40
    if (action.type === "counter") expect(action.price.eq(new Decimal("41.4"))).toBe(true)
  })

  it("holds when no latest_counter", () => {
    const ctx = makeSellerCtx()
    expect(seller.onCounterReceived(ctx).type).toBe("hold")
  })

  it("never goes below floor_price", () => {
    const ctx = makeSellerCtx({ latest_counter: { price: "36" } as any, round: 100 })
    const action = seller.onCounterReceived(ctx)
    if (action.type === "counter") expect(action.price.gte(new Decimal("30"))).toBe(true)
  })
})

describe("FlexibleSeller", () => {
  const seller = new FlexibleSeller()

  it("opens at target_price", () => {
    const ctx = makeSellerCtx()
    const action = seller.onRfqReceived(ctx)
    expect(action.type).toBe("respond")
    if (action.type === "respond") expect(action.price.eq(new Decimal("42"))).toBe(true)
  })

  it("concedes 25% of range per round", () => {
    const ctx = makeSellerCtx({ latest_counter: { price: "36" } as any, round: 1 })
    const action = seller.onCounterReceived(ctx)
    // range = 12, step = 12 * 0.25 = 3, price = 42 - 3 = 39
    if (action.type === "counter") expect(action.price.eq(new Decimal("39"))).toBe(true)
  })

  it("reaches floor by round 4", () => {
    const ctx = makeSellerCtx({ latest_counter: { price: "36" } as any, round: 4 })
    const action = seller.onCounterReceived(ctx)
    // range = 12, step = 3, price = 42 - 3*4 = 30 exactly floor
    if (action.type === "counter") expect(action.price.eq(new Decimal("30"))).toBe(true)
  })

  it("never goes below floor_price", () => {
    const ctx = makeSellerCtx({ latest_counter: { price: "36" } as any, round: 5 })
    const action = seller.onCounterReceived(ctx)
    if (action.type === "counter") expect(action.price.eq(new Decimal("30"))).toBe(true)
  })

  it("holds when no latest_counter", () => {
    const ctx = makeSellerCtx()
    expect(seller.onCounterReceived(ctx).type).toBe("hold")
  })
})

describe("CompetitiveSeller", () => {
  const seller = new CompetitiveSeller()

  it("opens at target_price", () => {
    const ctx = makeSellerCtx()
    const action = seller.onRfqReceived(ctx)
    expect(action.type).toBe("respond")
    if (action.type === "respond") expect(action.price.eq(new Decimal("42"))).toBe(true)
  })

  it("concedes slower with 0-1 competitors", () => {
    const ctx = makeSellerCtx({ latest_counter: { price: "36" } as any, round: 1, competing_sellers: 0 })
    const action = seller.onCounterReceived(ctx)
    // range = 12, baseStep = 12/5 = 2.4, multiplier = 0.5, concession = 2.4*0.5 = 1.2
    // price = 42 - 1.2 = 40.80
    if (action.type === "counter") expect(action.price.eq(new Decimal("40.8"))).toBe(true)
  })

  it("concedes faster with 2+ competitors", () => {
    const ctx = makeSellerCtx({ latest_counter: { price: "36" } as any, round: 1, competing_sellers: 3 })
    const action = seller.onCounterReceived(ctx)
    // multiplier = 1.5, concession = 2.4*1.5 = 3.6, price = 42 - 3.6 = 38.40
    if (action.type === "counter") expect(action.price.eq(new Decimal("38.4"))).toBe(true)
  })

  it("competition makes price strictly lower", () => {
    const noComp = makeSellerCtx({ latest_counter: { price: "36" } as any, round: 1, competing_sellers: 0 })
    const withComp = makeSellerCtx({ latest_counter: { price: "36" } as any, round: 1, competing_sellers: 3 })
    const a1 = seller.onCounterReceived(noComp)
    const a2 = seller.onCounterReceived(withComp)
    expect(a1.type).toBe("counter")
    expect(a2.type).toBe("counter")
    if (a1.type === "counter" && a2.type === "counter") {
      expect(a2.price.lt(a1.price)).toBe(true)
    }
  })

  it("never goes below floor_price even with max competition", () => {
    const ctx = makeSellerCtx({ latest_counter: { price: "36" } as any, round: 5, competing_sellers: 10 })
    const action = seller.onCounterReceived(ctx)
    if (action.type === "counter") expect(action.price.gte(new Decimal("30"))).toBe(true)
  })

  it("holds when no latest_counter", () => {
    const ctx = makeSellerCtx()
    expect(seller.onCounterReceived(ctx).type).toBe("hold")
  })
})
