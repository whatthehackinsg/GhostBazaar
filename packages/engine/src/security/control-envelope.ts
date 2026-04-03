/**
 * Signed Control Envelope — domain-separated authentication for state-changing actions.
 *
 * All state-changing actions (accept, decline, cancel) require a signed control envelope
 * that binds the action to a specific session, revision, and time window. This prevents:
 *
 * - Cross-session replay: rfq_id is signed
 * - Cross-action replay: action type is signed
 * - Within-window replay: envelope_id (UUID nonce) is tombstoned after first use
 * - Stale-state replay: session_revision is validated (CAS semantics)
 *
 * @see plans/engine-plan.md "Signed control envelopes (domain separation)"
 */

import { EngineError } from "../middleware/error-handler.js"
import {
  preCheckSignatureFormat,
  verifySignature,
} from "../middleware/validate-signature.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ControlAction = "accept" | "decline" | "cancel"

export interface ControlEnvelope {
  readonly envelope_id: string
  readonly action: ControlAction
  readonly rfq_id: string
  readonly session_revision: string
  readonly payload: Record<string, unknown>
  readonly issued_at: string
  readonly expires_at: string
  readonly signature: string
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum age of issued_at before rejection (60 seconds). */
const MAX_ISSUED_AGE_MS = 60_000

// ---------------------------------------------------------------------------
// Envelope ID Dedup — tombstone store for one-time-use envelope nonces
// ---------------------------------------------------------------------------

export class EnvelopeTombstones {
  private readonly tombstones = new Map<string, number>() // id → expiry timestamp
  /** Earliest expiry across all tombstones — enables O(1) sweep skip. */
  private nextExpiry = Infinity

  /** Check if an envelope_id has been used. */
  isUsed(envelopeId: string): boolean {
    return this.tombstones.has(envelopeId)
  }

  /** Mark an envelope_id as used. */
  use(envelopeId: string, retentionMs: number = 60 * 60 * 1000): void {
    const expiry = Date.now() + retentionMs
    this.tombstones.set(envelopeId, expiry)
    if (expiry < this.nextExpiry) this.nextExpiry = expiry
  }

  /** Prune expired tombstones. Called periodically by deadline enforcer. */
  sweep(): void {
    const now = Date.now()
    // Fast path: skip scan entirely if nothing has expired yet
    if (now < this.nextExpiry) return
    let minExpiry = Infinity
    for (const [id, expiry] of this.tombstones) {
      if (now >= expiry) {
        this.tombstones.delete(id)
      } else if (expiry < minExpiry) {
        minExpiry = expiry
      }
    }
    this.nextExpiry = minExpiry
  }

  get size(): number {
    return this.tombstones.size
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Parse and validate a control envelope from a raw request body.
 *
 * Validates: structure, action matches expected, rfq_id matches route,
 * issued_at within 60s, expires_at in future, envelope_id not reused,
 * and Ed25519 signature covers the canonical envelope.
 *
 * @returns The validated envelope with typed fields
 */
export async function validateControlEnvelope(
  body: Record<string, unknown>,
  expectedAction: ControlAction,
  expectedRfqId: string,
  expectedSignerDid: string,
  tombstones: EnvelopeTombstones,
  /** Error code for signature failures. Defaults to "invalid_buyer_signature". */
  signatureErrorCode: string = "invalid_buyer_signature",
): Promise<ControlEnvelope> {
  // --- Structure checks ---

  const envelopeId = body.envelope_id
  if (typeof envelopeId !== "string" || envelopeId.length === 0) {
    throw new EngineError(400, "malformed_payload", "Missing or invalid envelope_id")
  }

  const action = body.action
  if (action !== expectedAction) {
    throw new EngineError(
      400,
      "malformed_payload",
      `Expected action "${expectedAction}", got "${String(action)}"`,
    )
  }

  const rfqId = body.rfq_id
  if (rfqId !== expectedRfqId) {
    throw new EngineError(
      400,
      "rfq_id_mismatch",
      "Envelope rfq_id does not match route parameter",
    )
  }

  const sessionRevision = body.session_revision
  if (typeof sessionRevision !== "string" || sessionRevision.length === 0) {
    throw new EngineError(400, "malformed_payload", "Missing or invalid session_revision")
  }

  const payload = body.payload
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new EngineError(400, "malformed_payload", "Missing or invalid payload object")
  }

  const issuedAt = body.issued_at
  if (typeof issuedAt !== "string") {
    throw new EngineError(400, "malformed_payload", "Missing or invalid issued_at")
  }

  const expiresAt = body.expires_at
  if (typeof expiresAt !== "string") {
    throw new EngineError(400, "malformed_payload", "Missing or invalid expires_at")
  }

  const signature = body.signature
  if (typeof signature !== "string") {
    throw new EngineError(400, "malformed_payload", "Missing or invalid signature")
  }

  // --- Temporal checks ---

  const issuedMs = Date.parse(issuedAt)
  if (isNaN(issuedMs)) {
    throw new EngineError(400, "malformed_payload", "issued_at is not a valid ISO8601 date")
  }
  const age = Date.now() - issuedMs
  if (age > MAX_ISSUED_AGE_MS || age < -MAX_ISSUED_AGE_MS) {
    throw new EngineError(
      400,
      "malformed_payload",
      "issued_at is too old or too far in the future (max 60s drift)",
    )
  }

  const expiresMs = Date.parse(expiresAt)
  if (isNaN(expiresMs) || expiresMs <= Date.now()) {
    throw new EngineError(400, "malformed_payload", "expires_at must be in the future")
  }

  // --- Replay protection ---

  if (tombstones.isUsed(envelopeId)) {
    throw new EngineError(409, "duplicate_control_envelope", "This envelope has already been used")
  }

  // --- Signature pre-check + full verification ---

  preCheckSignatureFormat(signature, expectedSignerDid)

  // Build the envelope object for signature verification.
  // The signed payload is the canonical JSON with signature:"" (objectSigningPayload pattern).
  const envelopeForSig: Record<string, unknown> = {
    envelope_id: envelopeId,
    action,
    rfq_id: rfqId,
    session_revision: sessionRevision,
    payload,
    issued_at: issuedAt,
    expires_at: expiresAt,
    signature,
  }

  await verifySignature(envelopeForSig, signature, expectedSignerDid, signatureErrorCode)

  // --- Tombstone the envelope_id after successful verification ---
  tombstones.use(envelopeId)

  return {
    envelope_id: envelopeId,
    action: action as ControlAction,
    rfq_id: rfqId as string,
    session_revision: sessionRevision,
    payload: payload as Record<string, unknown>,
    issued_at: issuedAt,
    expires_at: expiresAt,
    signature,
  }
}
