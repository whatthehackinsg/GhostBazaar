import Decimal from "decimal.js"
import type { BuyerStrategy, BuyerAction, BuyerStrategyContext, BuyerPrivate, ServiceIntent } from "./interfaces.js"
import { selectBestBuyerOffer, selectLowestPricedBuyerOffer } from "./buyer-ranking.js"

interface LinearConcessionConfig {
  anchorRatio?: number   // opening anchor as fraction of budget_soft (default 0.8)
  maxRounds?: number     // concession steps to reach budget_soft (default 5)
}

export class LinearConcessionBuyer implements BuyerStrategy {
  private anchorRatio: number
  private maxRounds: number

  constructor(config?: LinearConcessionConfig) {
    this.anchorRatio = config?.anchorRatio ?? 0.8
    this.maxRounds = config?.maxRounds ?? 5
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
    const maxConcession = ctx.private.budget_soft.minus(new Decimal(ctx.rfq.anchor_price))
    const step = maxConcession.div(this.maxRounds)
    const newPrice = new Decimal(ctx.rfq.anchor_price).plus(step.mul(ctx.round))
    const capped = Decimal.min(newPrice, ctx.private.budget_hard)
    return { type: "counter", seller: best.seller, price: capped }
  }
}
