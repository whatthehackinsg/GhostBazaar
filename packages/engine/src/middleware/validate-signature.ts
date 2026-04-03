import {
  verifyEd25519,
  objectSigningPayload,
  didToPublicKey as coreDidToPublicKey,
  canonicalJson,
} from "@ghost-bazaar/core"
import { EngineError } from "./error-handler.js"

// ---------------------------------------------------------------------------
// Signature verification helpers
//
// Per Spec §8 data flow, signature verification runs as part of route
// handler validation (not as top-level middleware), because different
// routes verify different signers (buyer for RFQ/counter/accept,
// seller for offers, etc.).
//
// Pre-check (step 0): Lightweight DID key + base64 format check (~0.1ms)
// Full verify: Ed25519 cryptographic verification via @ghost-bazaar/core (~1ms)
// ---------------------------------------------------------------------------

/**
 * Extract the Ed25519 public key from a did:key DID.
 * Wraps core's didToPublicKey with EngineError on failure.
 */
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
export function didToPublicKey(did: string) {
  const pubkey = coreDidToPublicKey(did)
  if (!pubkey) {
    throw new EngineError(400, "malformed_payload", `Invalid or non-Ed25519 DID: ${did}`)
  }
  return pubkey
}

/**
 * Pre-check: Verify signature format without full cryptographic verification.
 * Rejects garbage requests before expensive operations (~0.1ms).
 *
 * Checks:
 * - Signature starts with "ed25519:"
 * - Base64 payload decodes to exactly 64 bytes (Ed25519 signature size)
 * - Signer DID public key bytes exist and are extractable
 *
 * NOTE: Plan step 0b describes comparing DID pubkey bytes with signature
 * pubkey bytes. Raw Ed25519 signatures are 64 bytes with no embedded public
 * key, so this comparison is not possible without full verification. The
 * full identity check happens in verifySignature() at the Spec validation step.
 */
// Base64 charset validation — Buffer.from(str, "base64") silently ignores
// invalid characters, so we must validate the charset explicitly.
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/

export function preCheckSignatureFormat(signature: string, signerDid: string): void {
  // Null/type guard: when called before schema validation, inputs may be
  // undefined or non-string from malformed JSON bodies. Reject cleanly
  // as 400 instead of letting TypeError propagate as 500.
  if (typeof signature !== "string") {
    throw new EngineError(400, "malformed_payload", "Missing or non-string signature")
  }
  if (typeof signerDid !== "string") {
    throw new EngineError(400, "malformed_payload", "Missing or non-string signer DID")
  }
  if (!signature.startsWith("ed25519:")) {
    throw new EngineError(400, "malformed_payload", "Signature must start with 'ed25519:'")
  }
  const b64 = signature.slice(8)
  if (!BASE64_RE.test(b64)) {
    throw new EngineError(400, "malformed_payload", "Signature contains invalid base64 characters")
  }
  const sigBytes = Buffer.from(b64, "base64")
  if (sigBytes.length !== 64) {
    throw new EngineError(
      400,
      "malformed_payload",
      `Signature must be 64 bytes, got ${sigBytes.length}`,
    )
  }
  // Verify DID is extractable (throws EngineError if malformed)
  didToPublicKey(signerDid)
}

/**
 * Full Ed25519 signature verification.
 * Verifies that the signature was produced by the signer's private key
 * over the canonical JSON of the protocol object.
 *
 * @param obj - The protocol object (RFQ, Offer, Counter, etc.)
 * @param signature - The "ed25519:..." signature string
 * @param signerDid - The DID of the expected signer
 * @param errorCode - The error code to return on failure (e.g., "invalid_buyer_signature")
 */
export async function verifySignature(
  obj: Record<string, unknown>,
  signature: string,
  signerDid: string,
  errorCode: string,
): Promise<void> {
  const pubkey = didToPublicKey(signerDid)
  const payload = objectSigningPayload(obj)
  const valid = await verifyEd25519(payload, signature, pubkey)
  if (!valid) {
    throw new EngineError(401, errorCode, "Ed25519 signature verification failed")
  }
}

// ---------------------------------------------------------------------------
// Quote Signature Verification — MUST use this instead of verifySignature()
//
// CRITICAL: Quote signing uses a DIFFERENT canonical form than RFQ/Offer/Counter.
// - RFQ/Offer/Counter: objectSigningPayload() sets { ...obj, signature: "" }
// - Quote: quoteSigningPayload() sets { ...obj, buyer_signature: "", seller_signature: "" }
//
// Using verifySignature() on a quote would inject signature:"" into canonical JSON,
// producing DIFFERENT bytes from what the buyer/seller actually signed.
// This would reject ALL legitimate signatures (DoS by implementation mistake).
//
// The Red Team audit identified this as a HIGH-severity implementation trap.
// ---------------------------------------------------------------------------

/**
 * Construct the signing payload for a SignedQuote.
 * Per Spec §6: both signature fields present, set to empty string "".
 */
function quoteSigningPayload(quote: Record<string, unknown>): Uint8Array {
  // MUST match core's quoteSigningPayload (packages/core/src/quote.ts:48-51) exactly.
  // Both set buyer_signature:"" and seller_signature:"", then canonicalize.
  //
  // NOTE: Do NOT delete obj.signature here — core's signer does not delete it.
  // If we did, a quote object with a spurious `signature` key would produce
  // different canonical bytes in engine vs core, causing all legitimate signatures
  // to be rejected (Red Team Finding 8). The invariant is: unsigned quotes
  // MUST NEVER have a `signature` field. This is enforced by buildUnsignedQuote
  // in core, which does not set one.
  const obj: Record<string, unknown> = { ...quote, buyer_signature: "", seller_signature: "" }
  return canonicalJson(obj)
}

/**
 * Verify an Ed25519 signature over a quote's canonical bytes.
 *
 * MUST be used for all quote signature verifications (buyer sign + seller cosign).
 * MUST NOT use verifySignature() for quotes — different canonical form.
 *
 * @param quote - The unsigned quote fields (all fields that go into canonical JSON)
 * @param signature - The "ed25519:..." signature string to verify
 * @param expectedSignerDid - The DID that MUST have produced this signature
 * @param errorCode - Error code on failure (e.g., "invalid_buyer_signature")
 */
export async function verifyQuoteSignature(
  quote: Record<string, unknown>,
  signature: string,
  expectedSignerDid: string,
  errorCode: string,
): Promise<void> {
  const pubkey = didToPublicKey(expectedSignerDid)
  const payload = quoteSigningPayload(quote)
  const valid = await verifyEd25519(payload, signature, pubkey)
  if (!valid) {
    throw new EngineError(401, errorCode, "Quote signature verification failed")
  }
}
