import { v4 as uuidv4 } from "uuid"
import { randomBytes } from "crypto"
import bs58 from "bs58"
import { PublicKey } from "@solana/web3.js"
import { canonicalJson } from "./canonical.js"
import { signEd25519, verifyEd25519 } from "./signing.js"
import { computeSpecHash } from "./amounts.js"
import { NONCE_RE, SUPPORTED_CURRENCIES, isValidDecimalPositive } from "./schemas.js"
import type { SignedQuote } from "./schemas.js"
import type { Keypair } from "@solana/web3.js"

export interface BuildQuoteInput {
  rfq_id: string
  buyer: string
  seller: string
  service_type: string
  final_price: string
  currency: string
  payment_endpoint: string
  expires_seconds: number
  memo_policy?: "optional" | "quote_id_required" | "hash_required"
  spec?: Record<string, unknown>
  spec_hash?: string
}

export function buildUnsignedQuote(input: BuildQuoteInput): SignedQuote {
  const nonce = "0x" + randomBytes(32).toString("hex")
  const expiresAt = new Date(Date.now() + input.expires_seconds * 1000).toISOString()

  return {
    quote_id: uuidv4(),
    rfq_id: input.rfq_id,
    buyer: input.buyer,
    seller: input.seller,
    service_type: input.service_type,
    final_price: input.final_price,
    currency: input.currency,
    payment_endpoint: input.payment_endpoint,
    expires_at: expiresAt,
    nonce,
    memo_policy: input.memo_policy ?? "quote_id_required",
    buyer_signature: "",
    seller_signature: "",
    spec_hash: input.spec_hash ?? (input.spec ? computeSpecHash(input.spec) : undefined),
  }
}

function quoteSigningPayload(quote: SignedQuote): Uint8Array {
  const obj = { ...quote, buyer_signature: "", seller_signature: "" } as Record<string, unknown>
  return canonicalJson(obj)
}

export async function signQuoteAsBuyer(quote: SignedQuote, keypair: Keypair): Promise<SignedQuote> {
  const payload = quoteSigningPayload(quote)
  const sig = await signEd25519(payload, keypair)
  return { ...quote, buyer_signature: sig }
}

export async function signQuoteAsSeller(quote: SignedQuote, keypair: Keypair): Promise<SignedQuote> {
  const payload = quoteSigningPayload(quote)
  const sig = await signEd25519(payload, keypair)
  return { ...quote, seller_signature: sig }
}

const VALID_MEMO_POLICIES = ["optional", "quote_id_required", "hash_required"] as const

export async function verifyQuote(quote: SignedQuote): Promise<{ ok: true } | { ok: false; code: string }> {
  // Validate final_price is positive
  if (!isValidDecimalPositive(quote.final_price)) return { ok: false, code: "invalid_amount" }

  // Validate currency is supported
  if (!SUPPORTED_CURRENCIES.includes(quote.currency)) return { ok: false, code: "unsupported_currency" }

  // Validate memo_policy is a known value
  if (!VALID_MEMO_POLICIES.includes(quote.memo_policy)) return { ok: false, code: "malformed_quote" }

  // Validate quote has not expired
  const expiresMs = Date.parse(quote.expires_at)
  if (isNaN(expiresMs) || expiresMs <= Date.now()) return { ok: false, code: "expired_quote" }

  // Validate nonce format (v4 §5.5: 32 bytes, lowercase hex, 0x prefix)
  if (!NONCE_RE.test(quote.nonce)) return { ok: false, code: "invalid_nonce_format" }

  const payload = quoteSigningPayload(quote)

  const buyerPubkey = didToPublicKey(quote.buyer)
  const sellerPubkey = didToPublicKey(quote.seller)

  if (!buyerPubkey || !sellerPubkey) return { ok: false, code: "malformed_quote" }

  const buyerOk = await verifyEd25519(payload, quote.buyer_signature, buyerPubkey)
  if (!buyerOk) return { ok: false, code: "invalid_buyer_signature" }

  const sellerOk = await verifyEd25519(payload, quote.seller_signature, sellerPubkey)
  if (!sellerOk) return { ok: false, code: "invalid_seller_signature" }

  return { ok: true }
}

const DID_KEY_PREFIX = "did:key:z"
const ED25519_MULTICODEC = [0xed, 0x01] as const

export function didToPublicKey(did: string): PublicKey | null {
  try {
    if (!did.startsWith(DID_KEY_PREFIX)) return null
    const decoded = bs58.decode(did.slice(DID_KEY_PREFIX.length))
    if (decoded[0] !== ED25519_MULTICODEC[0] || decoded[1] !== ED25519_MULTICODEC[1]) return null
    return new PublicKey(decoded.slice(2))
  } catch {
    return null
  }
}
