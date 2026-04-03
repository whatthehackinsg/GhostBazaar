/**
 * Quote Sign Route — PUT /rfqs/:id/quote/sign
 *
 * Spec §5.6 steps 8-10. Stays in COMMIT_PENDING.
 *
 * The buyer submits their Ed25519 signature over the unsigned quote.
 * The engine verifies the signature against the stored quote's canonical bytes
 * using didToPublicKey(quote.buyer) — NOT the request sender's identity.
 *
 * CRITICAL: Uses verifyQuoteSignature(), NOT verifySignature().
 * Quote canonical form uses buyer_signature:"" + seller_signature:"",
 * which is different from the RFQ/Offer/Counter form (signature:"").
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
// Quote Sign Route — PUT /rfqs/:id/quote/sign
//
// Validation order:
// 1. Parse JSON body { buyer_signature: "ed25519:..." } → 400
// 2. Pre-check signature format → 400
// 3. Inside lock:
//    a. Deadline check (rfq.deadline)
//    b. Quote expiry check (quote.expires_at)
//    c. State === COMMIT_PENDING → 409
//    d. unsignedQuote exists → 404
//    e. buyerSignature is null (not yet signed) → 409
//    f. Verify buyer_signature against didToPublicKey(quote.buyer) → 401
//    g. Append QUOTE_SIGNED event
// 4. Return 200 with partially-signed quote
// ---------------------------------------------------------------------------

export interface QuoteSignRouteConfig {
  readonly sessionManager: SessionManager
}

export function createQuoteSignRoute(config: QuoteSignRouteConfig): Hono<EngineEnv> {
  const { sessionManager } = config
  const router = new Hono<EngineEnv>()

  router.put("/rfqs/:id/quote/sign", async (c) => {
    const rfqId = c.req.param("id")

    // Step 1: Parse JSON body
    let body: Record<string, unknown>
    try {
      body = await c.req.json()
    } catch {
      throw new EngineError(400, "malformed_payload", "Invalid JSON body")
    }

    const buyerSignature = body.buyer_signature
    if (typeof buyerSignature !== "string") {
      throw new EngineError(400, "malformed_payload", "Missing or invalid buyer_signature")
    }

    // Step 2: Pre-check signature format
    // We need the buyer DID from the session for the pre-check
    const preSession = sessionManager.getSession(rfqId)
    if (!preSession) {
      throw new EngineError(404, "session_not_found", "RFQ session not found")
    }
    preCheckSignatureFormat(buyerSignature, preSession.rfq.buyer)

    // Step 3: Inside lock
    const result = await sessionManager.withLock(rfqId, async (session) => {
      if (!session) {
        throw new EngineError(404, "session_not_found", "RFQ session not found")
      }

      // 3a. Deadline check
      if (Date.now() >= new Date(session.rfq.deadline).getTime()) {
        throw new EngineError(409, "session_expired", "RFQ deadline has passed")
      }

      // 3b. Quote expiry check (Gemini S3 fix)
      if (session.unsignedQuote) {
        const expiresAt = session.unsignedQuote.expires_at
        if (typeof expiresAt === "string" && Date.now() >= new Date(expiresAt).getTime()) {
          throw new EngineError(422, "quote_expired", "Quote has expired before buyer signature")
        }
      }

      // 3c. State guard
      assertState(session.state, SessionState.COMMIT_PENDING)

      // 3d. Unsigned quote must exist
      if (!session.unsignedQuote) {
        throw new EngineError(404, "quote_not_found", "No unsigned quote exists for this session")
      }

      // 3e. Buyer hasn't signed yet
      if (session.buyerSignature !== null) {
        throw new EngineError(409, "already_signed", "Buyer has already signed this quote")
      }

      // 3f. Verify buyer signature against quote canonical bytes
      // CRITICAL: Uses verifyQuoteSignature, NOT verifySignature.
      // Quote canonical: { ...quote, buyer_signature: "", seller_signature: "" }
      // RFQ/Offer canonical: { ...obj, signature: "" }
      // These produce DIFFERENT bytes. Using the wrong one rejects all legitimate sigs.
      await verifyQuoteSignature(
        session.unsignedQuote,
        buyerSignature,
        session.rfq.buyer,
        "invalid_buyer_signature",
      )

      // 3g. Append QUOTE_SIGNED event
      const newSession = sessionManager.appendEvent(rfqId, {
        event_id: crypto.randomUUID(),
        rfq_id: rfqId,
        type: "QUOTE_SIGNED",
        timestamp: new Date().toISOString(),
        actor: session.rfq.buyer,
        payload: {
          seller: session.selectedSeller!,
          buyer_signature: buyerSignature,
        },
      })

      return newSession
    })

    // Step 4: Return partially-signed quote
    const quote = result.unsignedQuote!
    return c.json(
      {
        ...quote,
        buyer_signature: result.buyerSignature ?? "",
        seller_signature: "",
      },
      200,
    )
  })

  return router
}
