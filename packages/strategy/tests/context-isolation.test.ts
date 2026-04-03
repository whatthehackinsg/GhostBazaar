import { describe, it, expect } from "vitest"
import Decimal from "decimal.js"
import type { BuyerStrategyContext, SellerStrategyContext } from "../src/interfaces.js"

describe("Strategy context isolation", () => {
  it("BuyerStrategyContext has no seller private fields", () => {
    const ctx = {
      rfq: { anchor_price: "35.00" } as any,
      private: { budget_soft: new Decimal("40"), budget_hard: new Decimal("45") },
      current_offers: [],
      counters_sent: [],
      round: 1,
      time_remaining_ms: 30000,
      history: [],
      seller_registry: {
        "did:key:z6MkSeller": {
          agentId: "42",
          reputationScore: 91,
          totalFeedbacks: 12,
        },
      },
    } as BuyerStrategyContext
    const privKeys = Object.keys(ctx.private)
    expect(privKeys).toContain("budget_soft")
    expect(privKeys).toContain("budget_hard")
    expect(privKeys).not.toContain("floor_price")
    expect(privKeys).not.toContain("target_price")

    const registryKeys = Object.keys(ctx.seller_registry["did:key:z6MkSeller"] as Record<string, unknown>)
    expect(registryKeys).toContain("agentId")
    expect(registryKeys).toContain("reputationScore")
    expect(registryKeys).toContain("totalFeedbacks")
    expect(registryKeys).not.toContain("floor_price")
    expect(registryKeys).not.toContain("target_price")
  })

  it("SellerStrategyContext has no buyer private fields", () => {
    const ctx: SellerStrategyContext = {
      rfq: { anchor_price: "35.00" } as any,
      private: { floor_price: new Decimal("30"), target_price: new Decimal("42") },
      latest_counter: null,
      own_offers: [],
      round: 1,
      time_remaining_ms: 30000,
      competing_sellers: 0,
      seller_listing_profile: null,
    }
    const privKeys = Object.keys(ctx.private)
    expect(privKeys).toContain("floor_price")
    expect(privKeys).toContain("target_price")
    expect(privKeys).not.toContain("budget_soft")
    expect(privKeys).not.toContain("budget_hard")
  })
})
