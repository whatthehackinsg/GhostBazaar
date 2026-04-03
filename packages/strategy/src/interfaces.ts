import Decimal from "decimal.js"
import type { RFQ, SellerOffer, CounterOffer } from "@ghost-bazaar/core"

export type BuyerPrivate = { budget_soft: Decimal; budget_hard: Decimal }
export type SellerPrivate = { floor_price: Decimal; target_price: Decimal }

export type NegotiationProfile = {
  style: "firm" | "flexible" | "competitive" | "deadline-sensitive"
  max_rounds?: number
  accepts_counter?: boolean
}

export interface NegotiationEvent {
  event_id: string | number
  rfq_id: string
  event_type: string
  actor: string
  payload: unknown
  timestamp: string
}

export type SellerRegistrySignal = {
  agentId?: string
  reputationScore: number | null
  totalFeedbacks: number
}

export type BuyerStrategyContext = {
  rfq: RFQ
  private: BuyerPrivate
  current_offers: SellerOffer[]
  seller_registry: Record<string, SellerRegistrySignal>
  counters_sent: CounterOffer[]
  round: number
  time_remaining_ms: number
  history: NegotiationEvent[]
}

export type SellerStrategyContext = {
  rfq: RFQ
  private: SellerPrivate
  latest_counter: CounterOffer | null
  own_offers: SellerOffer[]
  round: number
  time_remaining_ms: number
  competing_sellers: number
  seller_listing_profile: NegotiationProfile | null
}

export type ServiceIntent = {
  service_type: string
  spec: Record<string, unknown>
}

export type BuyerAction =
  | { type: "counter"; seller: string; price: Decimal }
  | { type: "accept"; seller: string }
  | { type: "wait" }
  | { type: "cancel" }

export type SellerAction =
  | { type: "respond"; price: Decimal }
  | { type: "counter"; price: Decimal }
  | { type: "hold" }
  | { type: "decline" }

export interface BuyerStrategy {
  openingAnchor(intent: ServiceIntent, priv: BuyerPrivate): Decimal
  onOffersReceived(ctx: BuyerStrategyContext): BuyerAction | Promise<BuyerAction>
}

export interface SellerStrategy {
  onRfqReceived(ctx: SellerStrategyContext): SellerAction | Promise<SellerAction>
  onCounterReceived(ctx: SellerStrategyContext): SellerAction | Promise<SellerAction>
}
