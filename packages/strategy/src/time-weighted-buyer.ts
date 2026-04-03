import Decimal from "decimal.js"
import type { BuyerStrategy, BuyerAction, BuyerStrategyContext, BuyerPrivate, ServiceIntent } from "./interfaces.js"
import { selectBestBuyerOffer, selectLowestPricedBuyerOffer } from "./buyer-ranking.js"

interface TimeWeightedConfig {
  anchorRatio?: number            // opening anchor as fraction of budget_soft (default 0.75)
  maxRounds?: number              // rounds divisor for urgency calc (default 5)
  assumedRoundDurationMs?: number // estimated ms per round for urgency calc (default 1000)
}

export class TimeWeightedBuyer implements BuyerStrategy {
  private anchorRatio: number
  private maxRounds: number
  private assumedRoundDurationMs: number

  constructor(config?: TimeWeightedConfig) {
    this.anchorRatio = config?.anchorRatio ?? 0.75
    this.maxRounds = config?.maxRounds ?? 5
    this.assumedRoundDurationMs = config?.assumedRoundDurationMs ?? 1000
  }

  openingAnchor(_intent: ServiceIntent, priv: BuyerPrivate): Decimal {
    return priv.budget_soft.mul(this.anchorRatio)
  }

  onOffersReceived(ctx: BuyerStrategyContext): BuyerAction {
    if (ctx.current_offers.length === 0) return { type: "wait" }
    const cheapest = selectLowestPricedBuyerOffer(ctx.current_offers)
    const cheapestPrice = new Decimal(cheapest.price)
    if (cheapestPrice.lte(ctx.private.budget_soft)) {
      return { type: "accept", seller: cheapest.seller }
    }
    const best = selectBestBuyerOffer(ctx.current_offers, ctx.seller_registry ?? {})
    const urgency = Math.min(1, (ctx.round / this.maxRounds) + (1 - ctx.time_remaining_ms / Math.max(ctx.time_remaining_ms + ctx.round * this.assumedRoundDurationMs, 1)))
    const range = ctx.private.budget_hard.minus(new Decimal(ctx.rfq.anchor_price))
    const newPrice = new Decimal(ctx.rfq.anchor_price).plus(range.mul(urgency))
    const capped = Decimal.min(newPrice, ctx.private.budget_hard)
    return { type: "counter", seller: best.seller, price: capped }
  }
}
