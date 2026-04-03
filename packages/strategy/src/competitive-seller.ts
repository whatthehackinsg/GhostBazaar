import Decimal from "decimal.js"
import type { SellerStrategy, SellerAction, SellerStrategyContext } from "./interfaces.js"

interface CompetitiveSellerConfig {
  maxRounds?: number              // concession steps (default 5)
  competitionThreshold?: number   // seller count for high competition (default 2)
  lowCompMultiplier?: number      // multiplier when below threshold (default 0.5)
  highCompMultiplier?: number     // multiplier when at/above threshold (default 1.5)
}

export class CompetitiveSeller implements SellerStrategy {
  private maxRounds: number
  private competitionThreshold: number
  private lowCompMultiplier: number
  private highCompMultiplier: number

  constructor(config?: CompetitiveSellerConfig) {
    this.maxRounds = config?.maxRounds ?? 5
    this.competitionThreshold = config?.competitionThreshold ?? 2
    this.lowCompMultiplier = config?.lowCompMultiplier ?? 0.5
    this.highCompMultiplier = config?.highCompMultiplier ?? 1.5
  }

  onRfqReceived(ctx: SellerStrategyContext): SellerAction {
    return { type: "respond", price: ctx.private.target_price }
  }

  onCounterReceived(ctx: SellerStrategyContext): SellerAction {
    if (!ctx.latest_counter) return { type: "hold" }
    const maxConcession = ctx.private.target_price.minus(ctx.private.floor_price)
    const baseStep = maxConcession.div(this.maxRounds)
    const multiplier = ctx.competing_sellers >= this.competitionThreshold ? this.highCompMultiplier : this.lowCompMultiplier
    const concession = baseStep.mul(multiplier)
    const newPrice = ctx.private.target_price.minus(concession.mul(ctx.round))
    if (newPrice.lte(ctx.private.floor_price)) {
      return { type: "counter", price: ctx.private.floor_price }
    }
    return { type: "counter", price: newPrice }
  }
}
