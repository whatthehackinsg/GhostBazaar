/**
 * Demo scenario — 1 buyer vs 3 sellers, smart-contract-audit.
 *
 * Uses real protocol schema shapes with hardcoded values.
 * Simulates the full Ghost Bazaar negotiation lifecycle in ~8 seconds.
 */

export interface DemoEvent {
  readonly type: string
  readonly actor_role: "buyer" | "seller" | "system"
  readonly state_after: string
  readonly detail: string
  readonly delay: number // ms after previous event
}

export const DEMO_BUYER = "did:key:z6MkBuyerAgent1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
export const DEMO_SELLERS = {
  firm: "did:key:z6MkFirmSe11erAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  flexible: "did:key:z6MkF1exSe11erAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  competitive: "did:key:z6MkCompSe11erAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
}

export const DEMO_EVENTS: readonly DemoEvent[] = [
  // Phase 1: Discovery → RFQ
  {
    type: "RFQ_CREATED",
    actor_role: "buyer",
    state_after: "OPEN",
    detail: "RFQ for smart-contract-audit, anchor: 35.00 USDC, budget committed (ZK)",
    delay: 0,
  },
  // Phase 2: Offers from 3 sellers
  {
    type: "OFFER_SUBMITTED",
    actor_role: "seller",
    state_after: "NEGOTIATING",
    detail: "FirmSeller offers 50.00 USDC (style: firm, max 2 rounds)",
    delay: 800,
  },
  {
    type: "OFFER_SUBMITTED",
    actor_role: "seller",
    state_after: "NEGOTIATING",
    detail: "FlexibleSeller offers 38.00 USDC (style: flexible, max 5 rounds)",
    delay: 600,
  },
  {
    type: "OFFER_SUBMITTED",
    actor_role: "seller",
    state_after: "NEGOTIATING",
    detail: "CompetitiveSeller offers 42.00 USDC (style: competitive, max 8 rounds)",
    delay: 500,
  },
  // Phase 2: Counter-offers
  {
    type: "COUNTER_SENT",
    actor_role: "buyer",
    state_after: "NEGOTIATING",
    detail: "Counter to FlexibleSeller: 34.00 USDC + ZK budget proof ✓",
    delay: 1000,
  },
  {
    type: "OFFER_SUBMITTED",
    actor_role: "seller",
    state_after: "NEGOTIATING",
    detail: "FlexibleSeller counter-offers 36.50 USDC",
    delay: 700,
  },
  {
    type: "COUNTER_SENT",
    actor_role: "buyer",
    state_after: "NEGOTIATING",
    detail: "Counter to CompetitiveSeller: 35.00 USDC + ZK budget proof ✓",
    delay: 800,
  },
  {
    type: "OFFER_SUBMITTED",
    actor_role: "seller",
    state_after: "NEGOTIATING",
    detail: "CompetitiveSeller counter-offers 38.00 USDC",
    delay: 600,
  },
  // Phase 3: Accept winner
  {
    type: "WINNER_SELECTED",
    actor_role: "buyer",
    state_after: "COMMIT_PENDING",
    detail: "Buyer selects FlexibleSeller at 36.50 USDC",
    delay: 1200,
  },
  // Phase 3: Quote signing
  {
    type: "QUOTE_SIGNED",
    actor_role: "buyer",
    state_after: "COMMIT_PENDING",
    detail: "Buyer signs quote (Ed25519)",
    delay: 500,
  },
  {
    type: "QUOTE_COMMITTED",
    actor_role: "seller",
    state_after: "COMMITTED",
    detail: "FlexibleSeller co-signs → dual-signed quote locked at 36.50 USDC",
    delay: 800,
  },
  {
    type: "MOONPAY_SETTLEMENT",
    actor_role: "buyer",
    state_after: "SETTLED",
    detail: "36.50 USDC sent via MoonPay → tx confirmed on Solana",
    delay: 1000,
  },
]

export interface DemoMetrics {
  readonly negotiation_rounds: number
  readonly zk_proofs_verified: number
  readonly negotiation_time_ms: number
  readonly final_price: string
  readonly anchor_price: string
  readonly budget_hard: string
  readonly budget_soft: string
  readonly savings_vs_budget: string
  readonly savings_percent: string
  readonly seller_floor: string
  readonly privacy_score: number
  readonly privacy_max: number
}

export const DEMO_METRICS: DemoMetrics = {
  negotiation_rounds: 2,
  zk_proofs_verified: 2,
  negotiation_time_ms: 7500,
  final_price: "36.50",
  anchor_price: "35.00",
  budget_hard: "45.00",
  budget_soft: "40.00",
  savings_vs_budget: "8.50",
  savings_percent: "18.9",
  seller_floor: "30.00",
  privacy_score: 5,
  privacy_max: 6,
}

export interface PrivacyBreakdown {
  readonly label: string
  readonly private: boolean
  readonly mechanism: string
}

export const PRIVACY_BREAKDOWN: readonly PrivacyBreakdown[] = [
  { label: "Buyer budget (budget_hard)", private: true, mechanism: "ZK Poseidon commitment in RFQ" },
  { label: "Buyer soft target (budget_soft)", private: true, mechanism: "Never leaves local state" },
  { label: "Seller floor price", private: true, mechanism: "Never leaves local state" },
  { label: "Seller target price", private: true, mechanism: "Never leaves local state" },
  { label: "Counter budget compliance", private: true, mechanism: "ZK Groth16 proof" },
  { label: "Final settlement amount", private: false, mechanism: "Visible on-chain via MoonPay transfer" },
]
