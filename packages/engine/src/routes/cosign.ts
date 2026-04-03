/**
 * Cosign Route — PUT /rfqs/:id/cosign
 *
 * Spec §5.6 steps 11-18. Transitions: COMMIT_PENDING → COMMITTED.
 *
 * The selected seller submits their Ed25519 signature over the quote.
 * The engine verifies the signature against didToPublicKey(quote.seller) —
 * which MUST be the seller selected in WINNER_SELECTED, not any seller.
 *
 * CRITICAL: Uses verifyQuoteSignature(), NOT verifySignature().
 * CRITICAL: Verifies signer is session.selectedSeller, not request sender.
 */

import { Hono } from "hono"
import type { EngineEnv } from "../app.js"
import type { SessionManager } from "../state/session-manager.js"
import { EngineError } from "../middleware/error-handler.js"
import { assertState } from "../middleware/require-state.js"
import {
  preCheckSignatureFormat,
  verifyQuoteSignature,
} from "../middleware/validate-signature.js"
import { SessionState } from "../types.js"

// ---------------------------------------------------------------------------
// Cosign Route — PUT /rfqs/:id/cosign
//
// Validation order:
// 1. Parse JSON body { seller_signature: "ed25519:..." } → 400
// 2. Pre-check signature format → 400
// 3. Inside lock:
//    a. Deadline check (rfq.deadline) → 409
//    b. Quote expiry check (quote.expires_at) → 422
//    c. State === COMMIT_PENDING → 409
//    d. unsignedQuote exists AND buyerSignature exists → 409
//    e. Verify seller_signature against didToPublicKey(quote.seller) → 401
//    f. CRITICAL: signer must be session.selectedSeller → 401
//    g. Append QUOTE_COMMITTED event
// 4. Return 200 with fully-signed quote
// ---------------------------------------------------------------------------

export interface CosignRouteConfig {
  readonly sessionManager: SessionManager
}

export function createCosignRoute(config: CosignRouteConfig): Hono<EngineEnv> {
  const { sessionManager } = config
  const router = new Hono<EngineEnv>()

  router.put("/rfqs/:id/cosign", async (c) => {
    const rfqId = c.req.param("id")

    // Step 1: Parse JSON body
    let body: Record<string, unknown>
    try {
      body = await c.req.json()
    } catch {
      throw new EngineError(400, "malformed_payload", "Invalid JSON body")
    }

    const sellerSignature = body.seller_signature
    if (typeof sellerSignature !== "string") {
      throw new EngineError(400, "malformed_payload", "Missing or invalid seller_signature")
    }

    // Step 2: Pre-check signature format
    // We need the selected seller DID from the session
    const preSession = sessionManager.getSession(rfqId)
    if (!preSession || !preSession.selectedSeller) {
      throw new EngineError(404, "session_not_found", "No active commitment found")
    }
    preCheckSignatureFormat(sellerSignature, preSession.selectedSeller)

    // Step 3: Inside lock
    const result = await sessionManager.withLock(rfqId, async (session) => {
      if (!session) {
        throw new EngineError(404, "session_not_found", "RFQ session not found")
      }

      // 3a. Deadline check
      if (Date.now() >= new Date(session.rfq.deadline).getTime()) {
        throw new EngineError(409, "session_expired", "RFQ deadline has passed")
      }

      // 3b. Quote expiry check
      if (session.unsignedQuote) {
        const expiresAt = session.unsignedQuote.expires_at
        if (typeof expiresAt === "string" && Date.now() >= new Date(expiresAt).getTime()) {
          throw new EngineError(422, "quote_expired", "Quote has expired before seller cosign")
        }
      }

      // 3c. State guard
      assertState(session.state, SessionState.COMMIT_PENDING)

      // 3d. Quote must exist and buyer must have signed
      if (!session.unsignedQuote) {
        throw new EngineError(404, "quote_not_found", "No quote exists for this session")
      }
      if (session.buyerSignature === null) {
        throw new EngineError(
          409,
          "buyer_not_signed",
          "Buyer has not signed the quote yet — buyer must sign before seller cosigns",
        )
      }

      // 3e. Verify seller signature against quote canonical bytes
      // CRITICAL: Uses verifyQuoteSignature, NOT verifySignature.
      await verifyQuoteSignature(
        session.unsignedQuote,
        sellerSignature,
        session.selectedSeller!,
        "invalid_seller_signature",
      )

      // 3f. CRITICAL: verify signer is the selected seller, not any seller
      // The verifyQuoteSignature above already verified against selectedSeller's DID.
      // This is the identity binding — a non-selected seller's signature would fail
      // at step 3e because their public key differs from didToPublicKey(selectedSeller).

      // 3g. Append QUOTE_COMMITTED event
      const newSession = sessionManager.appendEvent(rfqId, {
        event_id: crypto.randomUUID(),
        rfq_id: rfqId,
        type: "QUOTE_COMMITTED",
        timestamp: new Date().toISOString(),
        actor: session.selectedSeller!,
        payload: {
          seller: session.selectedSeller!,
          seller_signature: sellerSignature,
        },
      })

      return newSession
    })

    // Step 4: Return fully-signed quote
    const quote = result.unsignedQuote!
    return c.json(
      {
        ...quote,
        buyer_signature: result.buyerSignature ?? "",
        seller_signature: result.sellerSignature ?? "",
      },
      200,
    )
  })

  return router
}
