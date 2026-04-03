import Decimal from "decimal.js"
import type { BuyerAction, SellerAction, BuyerPrivate, SellerPrivate } from "./interfaces.js"

const MIN_PRICE = new Decimal("0.000001")

export function sanitizeBuyerAction(action: BuyerAction, priv: BuyerPrivate): BuyerAction {
  if (action.type === "counter") {
    const clamped = Decimal.min(action.price, priv.budget_hard)
    return { ...action, price: Decimal.max(clamped, MIN_PRICE) }
  }
  return action
}

export function sanitizeSellerAction(action: SellerAction, priv: SellerPrivate): SellerAction {
  if (action.type === "respond" || action.type === "counter") {
    return { ...action, price: Decimal.max(action.price, priv.floor_price) }
  }
  return action
}
