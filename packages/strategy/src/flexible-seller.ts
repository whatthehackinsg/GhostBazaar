import Decimal from "decimal.js"
import type { SellerStrategy, SellerAction, SellerStrategyContext } from "./interfaces.js"

interface FlexibleSellerConfig {
  concessionRate?: number  // fraction of range conceded per round (default 0.25)
}

export class FlexibleSeller implements SellerStrategy {
  private concessionRate: number

  constructor(config?: FlexibleSellerConfig) {
    this.concessionRate = config?.concessionRate ?? 0.25
  }

  onRfqReceived(ctx: SellerStrategyContext): SellerAction {
    return { type: "respond", price: ctx.private.target_price }
  }

  onCounterReceived(ctx: SellerStrategyContext): SellerAction {
    if (!ctx.latest_counter) return { type: "hold" }
    const range = ctx.private.target_price.minus(ctx.private.floor_price)
    const step = range.mul(this.concessionRate)
    const newPrice = ctx.private.target_price.minus(step.mul(ctx.round))
    if (newPrice.lte(ctx.private.floor_price)) {
      return { type: "counter", price: ctx.private.floor_price }
    }
    return { type: "counter", price: newPrice }
  }
}
