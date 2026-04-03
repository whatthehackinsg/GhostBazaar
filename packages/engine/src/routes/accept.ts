/**
 * Accept Route — POST /rfqs/:id/accept
 *
 * Spec §5.6 steps 1-7. Transitions: NEGOTIATING → COMMIT_PENDING.
 *
 * The buyer selects a winning seller and offer. The engine builds an unsigned
 * quote and stores it in the WINNER_SELECTED event (pure event sourcing —
 * no separate QuoteStore). The unsigned quote is returned to the buyer for
 * local signing.
 *
 * Authentication: Signed control envelope with CAS semantics.
 * Anti-griefing: Max 6 accepts per session, max 2 per seller.
 *
 * SECURITY: payment_endpoint is sourced from RecordedOffer (captured at offer
 * time from the seller's listing), NOT from the current ListingStore. This
 * prevents payment redirection attacks.
 */

import { Hono } from "hono"
import { normalizeAmount } from "@ghost-bazaar/core"
import type { EngineEnv } from "../app.js"
import type { SessionManager } from "../state/session-manager.js"
import { EngineError } from "../middleware/error-handler.js"
import { assertState } from "../middleware/require-state.js"
import { SessionState } from "../types.js"
import { mintFor } from "../util/currency.js"
import { buildQuoteFromSession } from "../util/quote-builder.js"
import type { QuoteBuilderConfig } from "../util/quote-builder.js"
import {
  validateControlEnvelope,
  type EnvelopeTombstones,
} from "../security/control-envelope.js"

// ---------------------------------------------------------------------------
// Accept limits — anti-griefing (plan line 296-300)
// ---------------------------------------------------------------------------

/** Maximum total accept attempts per session (across all sellers). */
const MAX_ACCEPTS_PER_SESSION = 6

/** Maximum accept attempts per seller DID per session. */
const MAX_ACCEPTS_PER_SELLER = 2

// ---------------------------------------------------------------------------
// Accept Route — POST /rfqs/:id/accept
//
// Validation order (Spec §5.6 compliant + security extensions):
//
// 1. Parse JSON body → 400
// 2. Validate signed control envelope → 400/401/409
// 3. Inside lock:
//    a. Deadline check (wall clock — first action in lock)
//    b. State === NEGOTIATING → 409
//    c. Signer === rfq.buyer → 401
//    d. payload.seller has submitted offers → 404
//    e. payload.offer_id exists and belongs to seller → 404
//    f. session_revision CAS → 409
//    g. Offer valid_until still in future → 422
//    h. Accept limits (global + per-seller) → 422
//    i. Build unsigned quote → full quote object
//    j. Validate final_price > 0 and normalizeAmount > 0n
//    k. Append WINNER_SELECTED event (payload: full unsigned quote)
// 4. Return 200 with unsigned quote
// ---------------------------------------------------------------------------

export interface AcceptRouteConfig {
  readonly sessionManager: SessionManager
  readonly tombstones: EnvelopeTombstones
  readonly quoteConfig?: QuoteBuilderConfig
}

export function createAcceptRoute(config: AcceptRouteConfig): Hono<EngineEnv> {
  const { sessionManager, tombstones, quoteConfig } = config
  const router = new Hono<EngineEnv>()

  router.post("/rfqs/:id/accept", async (c) => {
    const rfqId = c.req.param("id")

    // Step 1: Parse JSON
    let body: Record<string, unknown>
    try {
      body = await c.req.json()
    } catch {
      throw new EngineError(400, "malformed_payload", "Invalid JSON body")
    }

    // Step 2: Pre-lock session lookup (for envelope validation — need buyer DID)
    const preSession = sessionManager.getSession(rfqId)
    if (!preSession) {
      throw new EngineError(404, "session_not_found", "RFQ session not found")
    }

    // Step 3: Validate signed control envelope
    const envelope = await validateControlEnvelope(
      body,
      "accept",
      rfqId,
      preSession.rfq.buyer,
      tombstones,
    )

    // Extract accept-specific payload fields
    const sellerDid = envelope.payload.seller
    if (typeof sellerDid !== "string") {
      throw new EngineError(400, "malformed_payload", "Missing seller in envelope payload")
    }
    const offerId = envelope.payload.offer_id
    if (typeof offerId !== "string") {
      throw new EngineError(400, "malformed_payload", "Missing offer_id in envelope payload")
    }

    // Step 4: Inside lock — all state-dependent checks
    const result = await sessionManager.withLock(rfqId, async (session) => {
      if (!session) {
        throw new EngineError(404, "session_not_found", "RFQ session not found")
      }

      // 4a. Deadline check — wall clock, FIRST action in lock
      if (Date.now() >= new Date(session.rfq.deadline).getTime()) {
        throw new EngineError(409, "session_expired", "RFQ deadline has passed")
      }

      // 4b. State guard — NEGOTIATING only
      assertState(session.state, SessionState.NEGOTIATING)

      // 4c. Signer identity — must be rfq.buyer
      // Already verified by control envelope validation, but defense-in-depth:
      // the envelope validator checked signer DID, and we passed rfq.buyer as expected signer

      // 4d. Seller has submitted at least one offer (Spec §5.6 step 3)
      const sellerOffers = session.offers.filter((o) => o.seller === sellerDid)
      if (sellerOffers.length === 0) {
        throw new EngineError(
          404,
          "seller_not_found",
          `Seller ${sellerDid} has not submitted any offers for this RFQ`,
        )
      }

      // 4e. Offer exists and belongs to the seller
      const offer = session.offers.find(
        (o) => o.offer_id === offerId && o.seller === sellerDid,
      )
      if (!offer) {
        throw new EngineError(
          404,
          "offer_not_found",
          `Offer ${offerId} not found for seller ${sellerDid}`,
        )
      }

      // 4f. CAS — session_revision must match current lastEventId
      if (envelope.session_revision !== session.lastEventId) {
        throw new EngineError(
          409,
          "stale_revision",
          "Session has been modified since the accept envelope was signed",
        )
      }

      // 4g. Offer validity — valid_until must be in the future
      if (Date.now() >= new Date(offer.valid_until).getTime()) {
        throw new EngineError(422, "invalid_expiry", "The accepted offer has expired")
      }

      // 4h. Accept limits
      if (session.totalAcceptAttempts >= MAX_ACCEPTS_PER_SESSION) {
        throw new EngineError(
          422,
          "accept_limit_exceeded",
          `Session accept limit (${MAX_ACCEPTS_PER_SESSION}) exceeded`,
        )
      }
      const sellerAttempts = session.acceptAttemptsBySeller.get(sellerDid) ?? 0
      if (sellerAttempts >= MAX_ACCEPTS_PER_SELLER) {
        throw new EngineError(
          422,
          "accept_limit_exceeded",
          `Per-seller accept limit (${MAX_ACCEPTS_PER_SELLER}) exceeded for ${sellerDid}`,
        )
      }

      // 4i. Build unsigned quote
      const unsignedQuote = buildQuoteFromSession(session, offerId, quoteConfig)

      // 4j. Validate final_price > 0 and normalizeAmount > 0n (Spec §5.5 MUST)
      const mint = mintFor(session.rfq.currency)
      if (normalizeAmount(unsignedQuote.final_price, mint) <= 0n) {
        throw new EngineError(422, "invalid_amount", "Quote final_price normalizes to zero")
      }

      // 4k. Append WINNER_SELECTED event with full unsigned quote in payload
      // The quote is stored in the event for crash-recoverable pure event sourcing.
      sessionManager.appendEvent(rfqId, {
        event_id: crypto.randomUUID(),
        rfq_id: rfqId,
        type: "WINNER_SELECTED",
        timestamp: new Date().toISOString(),
        actor: session.rfq.buyer,
        payload: {
          seller: sellerDid,
          offer_id: offerId,
          quote: {
            quote_id: unsignedQuote.quote_id,
            rfq_id: unsignedQuote.rfq_id,
            buyer: unsignedQuote.buyer,
            seller: unsignedQuote.seller,
            service_type: unsignedQuote.service_type,
            final_price: unsignedQuote.final_price,
            currency: unsignedQuote.currency,
            payment_endpoint: unsignedQuote.payment_endpoint,
            expires_at: unsignedQuote.expires_at,
            nonce: unsignedQuote.nonce,
            memo_policy: unsignedQuote.memo_policy,
            buyer_signature: "",
            seller_signature: "",
            ...(unsignedQuote.spec_hash !== undefined
              ? { spec_hash: unsignedQuote.spec_hash }
              : {}),
          },
        },
      })

      return unsignedQuote
    })

    // Step 5: Return 200 with unsigned quote
    return c.json(
      {
        quote_id: result.quote_id,
        rfq_id: result.rfq_id,
        buyer: result.buyer,
        seller: result.seller,
        service_type: result.service_type,
        final_price: result.final_price,
        currency: result.currency,
        payment_endpoint: result.payment_endpoint,
        expires_at: result.expires_at,
        nonce: result.nonce,
        memo_policy: result.memo_policy,
        buyer_signature: "",
        seller_signature: "",
        ...(result.spec_hash !== undefined ? { spec_hash: result.spec_hash } : {}),
      },
      200,
    )
  })

  return router
}
