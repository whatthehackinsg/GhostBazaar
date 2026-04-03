import Decimal from "decimal.js"

// --- Types ---

export type ValidationResult = { ok: true } | { ok: false; code: string }

export interface RFQ {
  rfq_id: string
  protocol: string
  buyer: string
  service_type: string
  spec: Record<string, unknown>
  anchor_price: string
  currency: string
  deadline: string
  signature: string
  budget_commitment?: string
  extensions?: Record<string, unknown>
}

export interface SellerOffer {
  offer_id: string
  rfq_id: string
  seller: string
  listing_id: string
  price: string
  currency: string
  valid_until: string
  signature: string
  extensions?: Record<string, unknown>
}

export interface CounterOffer {
  counter_id: string
  rfq_id: string
  round: number
  from: string
  to: string
  price: string
  currency: string
  valid_until: string
  signature: string
  budget_proof?: BudgetProof
  extensions?: Record<string, unknown>
}

export interface BudgetProof {
  protocol: "groth16"
  curve: "bn128"
  counter_price_scaled: string
  pi_a: string[]
  pi_b: string[][]
  pi_c: string[]
}

export interface SignedQuote {
  quote_id: string
  rfq_id: string
  buyer: string
  seller: string
  service_type: string
  final_price: string
  currency: string
  payment_endpoint: string
  expires_at: string
  nonce: string
  memo_policy: "optional" | "quote_id_required" | "hash_required"
  buyer_signature: string
  seller_signature: string
  spec_hash?: string
  extensions?: Record<string, unknown>
}

export interface Listing {
  listing_id: string
  seller: string
  registry_agent_id?: string
  title: string
  category: string
  service_type: string
  negotiation_endpoint: string
  payment_endpoint: string
  base_terms: Record<string, unknown>
  negotiation_profile?: {
    style: "firm" | "flexible" | "competitive" | "deadline-sensitive"
    max_rounds?: number
    accepts_counter?: boolean
  }
}

export interface SignedListingRegistration extends Listing {
  signature: string
}

// --- Helpers ---

function isValidDecimalPositive(s: string): boolean {
  try {
    const d = new Decimal(s)
    return d.gt(0) && d.isFinite()
  } catch {
    return false
  }
}

function isUuidV4(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(s)
}

function isFutureISO(s: string): boolean {
  const t = Date.parse(s)
  return !isNaN(t) && t > Date.now()
}

function isDid(s: string): boolean {
  return typeof s === "string" && /^did:key:z6Mk/.test(s)
}

function isSignatureFormat(s: string): boolean {
  return typeof s === "string" && s.startsWith("ed25519:")
}

function isPositiveInteger(n: unknown): boolean {
  return typeof n === "number" && Number.isInteger(n) && n > 0
}

const BUDGET_COMMITMENT_RE = /^poseidon:[0-9a-f]{64}$/

const NONCE_RE = /^0x[0-9a-f]{64}$/

const PROTOCOL_VERSION = "ghost-bazaar-v4"
const SUPPORTED_CURRENCIES = ["USDC"]

// --- Validators ---

export function validateRfq(rfq: any): ValidationResult {
  if (!rfq || typeof rfq !== "object") return { ok: false, code: "malformed_payload" }

  const required = ["rfq_id", "protocol", "buyer", "service_type", "spec", "anchor_price", "currency", "deadline", "signature"]
  for (const field of required) {
    if (rfq[field] === undefined || rfq[field] === null) {
      return { ok: false, code: "malformed_payload" }
    }
  }

  if (!isUuidV4(rfq.rfq_id)) return { ok: false, code: "malformed_payload" }
  if (rfq.protocol !== PROTOCOL_VERSION) return { ok: false, code: "malformed_payload" }
  if (!isDid(rfq.buyer)) return { ok: false, code: "malformed_payload" }
  if (!isValidDecimalPositive(rfq.anchor_price)) return { ok: false, code: "invalid_amount" }
  if (!isFutureISO(rfq.deadline)) return { ok: false, code: "invalid_deadline" }
  if (!SUPPORTED_CURRENCIES.includes(rfq.currency)) return { ok: false, code: "unsupported_currency" }
  if (!isSignatureFormat(rfq.signature)) return { ok: false, code: "malformed_payload" }

  if (rfq.budget_commitment !== undefined) {
    if (!BUDGET_COMMITMENT_RE.test(rfq.budget_commitment)) {
      return { ok: false, code: "invalid_budget_commitment_format" }
    }
  }

  // NOTE: Signature verification is NOT done here (pure schema check).
  // The engine route MUST call verifyEd25519() on the RFQ after validateRfq().
  return { ok: true }
}

export function validateOffer(offer: any, rfq: RFQ): ValidationResult {
  if (!offer || typeof offer !== "object") return { ok: false, code: "malformed_payload" }

  const required = ["offer_id", "rfq_id", "seller", "listing_id", "price", "currency", "valid_until", "signature"]
  for (const field of required) {
    if (offer[field] === undefined || offer[field] === null) {
      return { ok: false, code: "malformed_payload" }
    }
  }

  if (!isUuidV4(offer.offer_id)) return { ok: false, code: "malformed_payload" }
  if (offer.rfq_id !== rfq.rfq_id) return { ok: false, code: "rfq_id_mismatch" }
  if (!isDid(offer.seller)) return { ok: false, code: "malformed_payload" }
  if (typeof offer.listing_id !== "string" || offer.listing_id.trim() === "") return { ok: false, code: "malformed_payload" }
  if (!isValidDecimalPositive(offer.price)) return { ok: false, code: "invalid_amount" }
  if (offer.currency !== rfq.currency) return { ok: false, code: "currency_mismatch" }
  if (!isFutureISO(offer.valid_until)) return { ok: false, code: "invalid_expiry" }
  if (!isSignatureFormat(offer.signature)) return { ok: false, code: "malformed_payload" }

  return { ok: true }
}

export function validateCounter(counter: any, rfq: RFQ): ValidationResult {
  if (!counter || typeof counter !== "object") return { ok: false, code: "malformed_payload" }

  const required = ["counter_id", "rfq_id", "round", "from", "to", "price", "currency", "valid_until", "signature"]
  for (const field of required) {
    if (counter[field] === undefined || counter[field] === null) {
      return { ok: false, code: "malformed_payload" }
    }
  }

  if (!isUuidV4(counter.counter_id)) return { ok: false, code: "malformed_payload" }
  if (counter.rfq_id !== rfq.rfq_id) return { ok: false, code: "rfq_id_mismatch" }
  if (!isPositiveInteger(counter.round)) return { ok: false, code: "invalid_round" }
  if (!isDid(counter.from)) return { ok: false, code: "malformed_payload" }
  if (!isDid(counter.to)) return { ok: false, code: "malformed_payload" }
  if (!isValidDecimalPositive(counter.price)) return { ok: false, code: "invalid_amount" }
  if (counter.currency !== rfq.currency) return { ok: false, code: "currency_mismatch" }
  if (!isFutureISO(counter.valid_until)) return { ok: false, code: "invalid_expiry" }
  if (!isSignatureFormat(counter.signature)) return { ok: false, code: "malformed_payload" }

  // ZK proof field structure validation (not proof verification — engine does that)
  if (rfq.budget_commitment) {
    if (!counter.budget_proof) return { ok: false, code: "missing_budget_proof" }
    if (counter.budget_proof.protocol !== "groth16") return { ok: false, code: "invalid_budget_proof" }
    if (counter.budget_proof.curve !== "bn128") return { ok: false, code: "invalid_budget_proof" }
  } else if (counter.budget_proof) {
    return { ok: false, code: "unexpected_budget_proof" }
  }

  // NOTE: The following checks happen in the ENGINE route, not here:
  // - counter.from === rfq.buyer (422 unauthorized_counter)
  // - counter.round monotonically increasing (422 invalid_round)
  // - budget_proof.counter_price_scaled === normalizeAmount(counter.price) (422 proof_price_mismatch)
  // - verifyBudgetProof() (422 invalid_budget_proof)
  // - Ed25519 signature verification (401 invalid_buyer_signature)
  return { ok: true }
}

export { isValidDecimalPositive, isUuidV4, isFutureISO, NONCE_RE, PROTOCOL_VERSION, SUPPORTED_CURRENCIES }
