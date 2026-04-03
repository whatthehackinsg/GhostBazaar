/**
 * Quote Read Route — GET /rfqs/:id/quote
 *
 * Spec §5.6 quote retrieval. Read-only, no state change.
 *
 * Returns the current quote state:
 * - Unsigned (buyer_signature="" + seller_signature="") after accept
 * - Partially-signed (buyer_signature set) after buyer sign
 * - Fully-signed (both set) after seller cosign
 *
 * Access control: only the rfq.buyer or the selected seller can read.
 * Authentication: GhostBazaar-Ed25519 header (did + timestamp + signature).
 *
 * The quote is assembled from DerivedSession fields, not a separate store.
 */

import { Hono } from "hono"
import type { EngineEnv } from "../app.js"
import type { SessionManager } from "../state/session-manager.js"
import { EngineError } from "../middleware/error-handler.js"
import { SessionState } from "../types.js"

// ---------------------------------------------------------------------------
// Quote Read Route — GET /rfqs/:id/quote
//
// 1. Extract caller DID from request (GhostBazaar-Ed25519 auth)
// 2. Session must exist → 404
// 3. State must be COMMIT_PENDING or COMMITTED → 404
// 4. Caller must be rfq.buyer or selectedSeller → 401
// 5. Return current quote state assembled from session fields
// ---------------------------------------------------------------------------

export interface QuoteReadRouteConfig {
  readonly sessionManager: SessionManager
  /**
   * Extract and verify caller DID from the request.
   * Injectable for testing. In production, validates GhostBazaar-Ed25519 header.
   * Returns the authenticated DID string, or throws EngineError(401).
   */
  readonly authenticateCaller: (req: Request) => Promise<string>
}

export function createQuoteReadRoute(config: QuoteReadRouteConfig): Hono<EngineEnv> {
  const { sessionManager, authenticateCaller } = config
  const router = new Hono<EngineEnv>()

  router.get("/rfqs/:id/quote", async (c) => {
    const rfqId = c.req.param("id")

    // Step 1: Authenticate caller
    const callerDid = await authenticateCaller(c.req.raw)

    // Step 2-5: Inside lock for consistent read
    const result = await sessionManager.withLock(rfqId, async (session) => {
      // Step 2: Session must exist
      if (!session) {
        throw new EngineError(404, "session_not_found", "RFQ session not found")
      }

      // Step 3: State must be COMMIT_PENDING or COMMITTED
      if (
        session.state !== SessionState.COMMIT_PENDING &&
        session.state !== SessionState.COMMITTED
      ) {
        throw new EngineError(404, "quote_not_found", "No quote exists in the current state")
      }

      // Step 4: Caller must be buyer or selected seller
      if (callerDid !== session.rfq.buyer && callerDid !== session.selectedSeller) {
        throw new EngineError(
          401,
          "unauthorized",
          "Only the buyer or selected seller can read the quote",
        )
      }

      // Step 5: Assemble quote from session fields
      if (!session.unsignedQuote) {
        throw new EngineError(404, "quote_not_found", "Quote data not found in session")
      }

      return {
        ...session.unsignedQuote,
        buyer_signature: session.buyerSignature ?? "",
        seller_signature: session.sellerSignature ?? "",
      }
    })

    return c.json(result, 200)
  })

  return router
}
