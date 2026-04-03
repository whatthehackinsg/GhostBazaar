import { Hono } from "hono"
import { validateOffer, normalizeAmount } from "@ghost-bazaar/core"
import type { RFQ } from "@ghost-bazaar/core"
import type { EngineEnv } from "../app.js"
import type { SessionManager } from "../state/session-manager.js"
import { EngineError } from "../middleware/error-handler.js"
import {
  preCheckSignatureFormat,
  verifySignature,
} from "../middleware/validate-signature.js"
import { assertState } from "../middleware/require-state.js"
import { SessionState } from "../types.js"
import { mintFor } from "../util/currency.js"
import type { ListingStore } from "../registry/listing-store.js"

// ---------------------------------------------------------------------------
// Offer admission control constants (anti-Sybil)
// ---------------------------------------------------------------------------

/** Maximum total offers per session (across all sellers). */
const MAX_OFFERS_PER_SESSION = 50

/** Maximum offers per seller DID per session. */
const MAX_OFFERS_PER_SELLER = 5

// ---------------------------------------------------------------------------
// Offer Route — POST /rfqs/:id/offers
//
// 10-step offer submission per Spec §8:
// 1. Parse JSON body → 400
// 2. Retrieve RFQ session → 404
// 3. validateOffer(offer, rfq) → 400/422
// 4. normalizeAmount(price, mint) > 0n → 422
// 5. Pre-check signature format (DoS filter)
// 6. Full Ed25519 verify: signer === offer.seller → 401
// 7. State guard: OPEN or NEGOTIATING → 409
// 8. Offer admission control (per-session + per-DID caps) → 422
// 9. Append OFFER_SUBMITTED event
// 10. Return 201
//
// NOTE: Signature verification runs BEFORE state guard (Spec §8 order).
// ---------------------------------------------------------------------------

/** Extract only known offer fields for signature verification. */
function extractOfferFields(body: Record<string, unknown>): Record<string, unknown> {
  const offer: Record<string, unknown> = {
    offer_id: body.offer_id,
    rfq_id: body.rfq_id,
    seller: body.seller,
    listing_id: body.listing_id,
    price: body.price,
    currency: body.currency,
    valid_until: body.valid_until,
    signature: body.signature,
  }
  if (body.extensions !== undefined) {
    offer.extensions = body.extensions
  }
  return offer
}

export interface OfferRouteConfig {
  readonly sessionManager: SessionManager
  /** Listing store for payment_endpoint provenance (plan line 296-300). Required. */
  readonly listingStore: ListingStore
}

export function createOfferRoute(config: OfferRouteConfig): Hono<EngineEnv> {
  const { sessionManager, listingStore } = config
  const router = new Hono<EngineEnv>()

  router.post("/rfqs/:id/offers", async (c) => {
    const rfqId = c.req.param("id")

    // Step 1: Parse JSON
    let body: Record<string, unknown>
    try {
      body = await c.req.json()
    } catch {
      throw new EngineError(400, "malformed_payload", "Invalid JSON body")
    }

    // Step 2: Retrieve RFQ session
    const session = sessionManager.getSession(rfqId)
    if (!session) {
      throw new EngineError(404, "session_not_found", "RFQ session not found")
    }

    // Build RFQ object for validateOffer
    const rfq = session.rfq as unknown as RFQ

    // Step 3: Validate offer schema
    const validation = validateOffer(body, rfq)
    if (!validation.ok) {
      const status =
        validation.code === "invalid_amount" ||
        validation.code === "currency_mismatch" ||
        validation.code === "invalid_expiry"
          ? 422
          : 400
      throw new EngineError(status, validation.code, `Offer validation failed: ${validation.code}`)
    }

    // Step 4: normalizeAmount check
    const mint = mintFor(rfq.currency)
    if (normalizeAmount(body.price as string, mint) <= 0n) {
      throw new EngineError(422, "invalid_amount", "Offer price normalizes to zero")
    }

    // Validate extensions if present
    if (body.extensions !== undefined) {
      if (typeof body.extensions !== "object" || body.extensions === null || Array.isArray(body.extensions)) {
        throw new EngineError(400, "malformed_payload", "extensions must be a plain object")
      }
      if (JSON.stringify(body.extensions).length > 4096) {
        throw new EngineError(400, "malformed_payload", "extensions exceeds 4096 bytes")
      }
    }

    // Defense-in-depth: explicit rfq_id binding check before sig verification
    if (body.rfq_id !== rfqId) {
      throw new EngineError(400, "rfq_id_mismatch", "Offer rfq_id does not match route")
    }

    // Step 5: Pre-check signature format
    preCheckSignatureFormat(body.signature as string, body.seller as string)

    // Step 6: Full Ed25519 signature verification
    const offerForSig = extractOfferFields(body)
    await verifySignature(
      offerForSig,
      body.signature as string,
      body.seller as string,
      "invalid_seller_signature",
    )

    // Steps 7-10: Inside lock for atomicity
    const updatedSession = await sessionManager.withLock(rfqId, async (lockedSession) => {
      if (!lockedSession) {
        throw new EngineError(404, "session_not_found", "RFQ session not found")
      }

      // Deadline check inside lock (plan line 320-323)
      // Must be the FIRST check — uses current wall clock, not lock acquisition time
      if (Date.now() >= new Date(lockedSession.rfq.deadline).getTime()) {
        throw new EngineError(409, "session_expired", "RFQ deadline has passed")
      }

      // Step 7: State guard (AFTER signature, per Spec order)
      assertState(lockedSession.state, SessionState.OPEN, SessionState.NEGOTIATING)

      // offer_id uniqueness (plan line 282-287)
      const offerId = body.offer_id as string
      if (lockedSession.offers.some((o) => o.offer_id === offerId)) {
        throw new EngineError(409, "duplicate_object_id", `Offer ${offerId} already exists`)
      }

      // Step 8: Offer admission control
      if (lockedSession.totalOfferCount >= MAX_OFFERS_PER_SESSION) {
        throw new EngineError(422, "session_offer_limit", `Session offer limit (${MAX_OFFERS_PER_SESSION}) exceeded`)
      }
      const sellerDid = body.seller as string
      const sellerCount = lockedSession.offerCountBySeller.get(sellerDid) ?? 0
      if (sellerCount >= MAX_OFFERS_PER_SELLER) {
        throw new EngineError(422, "seller_offer_limit", `Per-seller offer limit (${MAX_OFFERS_PER_SELLER}) exceeded`)
      }

      // Resolve listing provenance for payment_endpoint using signed listing_id.
      // SECURITY: listing_id is part of the signed offer payload, so the seller
      // cryptographically binds the offer to one exact registered listing.
      const listingId = body.listing_id as string
      const resolvedListing = listingStore.findBySellerAndId(sellerDid, listingId)
      if (!resolvedListing) {
        throw new EngineError(422, "missing_listing", "Seller has no registered listing")
      }
      if (!resolvedListing.payment_endpoint) {
        throw new EngineError(422, "missing_payment_endpoint", "Seller listing has no payment_endpoint")
      }

      // Step 9: Append event
      return sessionManager.appendEvent(rfqId, {
        event_id: crypto.randomUUID(),
        rfq_id: rfqId,
        type: "OFFER_SUBMITTED",
        timestamp: new Date().toISOString(),
        actor: sellerDid,
        payload: {
          rfq_id: rfqId,
          offer_id: body.offer_id as string,
          seller: sellerDid,
          price: body.price as string,
          currency: body.currency as string,
          valid_until: body.valid_until as string,
          signature: body.signature as string,
          // Listing provenance — signed by seller, verified by seller + listing_id lookup
          listing_id: listingId,
          payment_endpoint: resolvedListing.payment_endpoint,
          ...(body.extensions !== undefined
            ? { extensions: body.extensions }
            : {}),
        },
      })
    })

    // Step 10: Return 201
    return c.json(
      {
        offer_id: body.offer_id,
        rfq_id: rfqId,
        state: updatedSession.state,
        seller: body.seller,
        price: body.price,
      },
      201,
    )
  })

  return router
}
