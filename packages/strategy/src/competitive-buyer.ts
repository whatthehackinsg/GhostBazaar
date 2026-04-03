import Decimal from "decimal.js"
import type { BuyerStrategy, BuyerAction, BuyerStrategyContext, BuyerPrivate, ServiceIntent } from "./interfaces.js"
import { selectBestBuyerOffer, selectLowestPricedBuyerOffer } from "./buyer-ranking.js"

interface CompetitiveBuyerConfig {
  anchorRatio?: number          // opening anchor as fraction of budget_soft (default 0.7)
  maxRounds?: number            // concession steps (default 5)
  highCompThreshold?: number    // seller count for "high" competition (default 3)
  medCompThreshold?: number     // seller count for "medium" competition (default 2)
  highCompFactor?: number       // concession dampener at high competition (default 0.5)
  medCompFactor?: number        // concession dampener at medium competition (default 0.75)
  noCompFactor?: number         // concession dampener at no competition (default 1.0)
}

export class CompetitiveBuyer implements BuyerStrategy {
  private anchorRatio: number
  private maxRounds: number
  private highCompThreshold: number
  private medCompThreshold: number
  private highCompFactor: number
  private medCompFactor: number
  private noCompFactor: number

  constructor(config?: CompetitiveBuyerConfig) {
    this.anchorRatio = config?.anchorRatio ?? 0.7
    this.maxRounds = config?.maxRounds ?? 5
    this.highCompThreshold = config?.highCompThreshold ?? 3
    this.medCompThreshold = config?.medCompThreshold ?? 2
    this.highCompFactor = config?.highCompFactor ?? 0.5
    this.medCompFactor = config?.medCompFactor ?? 0.75
    this.noCompFactor = config?.noCompFactor ?? 1.0
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
    const sorted = [...ctx.current_offers].sort((a, b) =>
      new Decimal(a.price).minus(new Decimal(b.price)).toNumber()
    )
    const competitionFactor = sorted.length >= this.highCompThreshold
      ? this.highCompFactor
      : sorted.length >= this.medCompThreshold
        ? this.medCompFactor
        : this.noCompFactor
    const baseStep = ctx.private.budget_soft.minus(new Decimal(ctx.rfq.anchor_price)).div(this.maxRounds)
    const step = baseStep.mul(competitionFactor)
    const newPrice = new Decimal(ctx.rfq.anchor_price).plus(step.mul(ctx.round))
    const capped = Decimal.min(newPrice, ctx.private.budget_hard)
    return { type: "counter", seller: best.seller, price: capped }
  }
}
