/**
 * Decline Route — PUT /rfqs/:id/decline
 *
 * Engine extension (not in Spec §7). Allows the selected seller to explicitly
 * decline cosigning, reverting COMMIT_PENDING → NEGOTIATING immediately
 * instead of waiting for the 60s commitment timeout.
 *
 * Authentication: Signed control envelope with action="decline".
 * Only the selected seller can decline.
 */

import { Hono } from "hono"
import type { EngineEnv } from "../app.js"
import type { SessionManager } from "../state/session-manager.js"
import { EngineError } from "../middleware/error-handler.js"
import { assertState } from "../middleware/require-state.js"
import { SessionState } from "../types.js"
import {
  validateControlEnvelope,
  type EnvelopeTombstones,
} from "../security/control-envelope.js"

// ---------------------------------------------------------------------------
// Decline Route — PUT /rfqs/:id/decline
//
// Validation order:
// 1. Parse JSON body → 400
// 2. Validate signed control envelope (action="decline") → 400/401
// 3. Inside lock:
//    a. Deadline check → 409
//    b. State === COMMIT_PENDING → 409
//    c. Signer === selectedSeller → 401
//    d. Append COSIGN_DECLINED event (reducer clears quote state)
// 4. Return 200 { state: "NEGOTIATING" }
// ---------------------------------------------------------------------------

export interface DeclineRouteConfig {
  readonly sessionManager: SessionManager
  readonly tombstones: EnvelopeTombstones
}

export function createDeclineRoute(config: DeclineRouteConfig): Hono<EngineEnv> {
  const { sessionManager, tombstones } = config
  const router = new Hono<EngineEnv>()

  router.put("/rfqs/:id/decline", async (c) => {
    const rfqId = c.req.param("id")

    // Step 1: Parse JSON body
    let body: Record<string, unknown>
    try {
      body = await c.req.json()
    } catch {
      throw new EngineError(400, "malformed_payload", "Invalid JSON body")
    }

    // Pre-lock: get session to find the selected seller DID
    const preSession = sessionManager.getSession(rfqId)
    if (!preSession || !preSession.selectedSeller) {
      throw new EngineError(404, "session_not_found", "No active commitment found")
    }

    // Step 2: Validate signed control envelope — signer must be the selected seller
    const envelope = await validateControlEnvelope(
      body,
      "decline",
      rfqId,
      preSession.selectedSeller,
      tombstones,
      "invalid_seller_signature",  // Codex F2: seller-appropriate error code
    )

    // Step 3: Inside lock
    const result = await sessionManager.withLock(rfqId, async (session) => {
      if (!session) {
        throw new EngineError(404, "session_not_found", "RFQ session not found")
      }

      // 3a. Deadline check
      if (Date.now() >= new Date(session.rfq.deadline).getTime()) {
        throw new EngineError(409, "session_expired", "RFQ deadline has passed")
      }

      // 3b. State guard
      assertState(session.state, SessionState.COMMIT_PENDING)

      // 3c. Signer must be the CURRENT selected seller (re-check inside lock).
      // TOCTOU defense: the pre-lock envelope was validated against the selectedSeller
      // at pre-lock time. A concurrent accept could have changed selectedSeller since.
      // Re-verify that the current selectedSeller matches the envelope signer.
      if (!session.selectedSeller) {
        throw new EngineError(409, "invalid_state_transition", "No seller selected")
      }
      if (session.selectedSeller !== preSession.selectedSeller) {
        throw new EngineError(
          409,
          "stale_revision",
          "Selected seller changed since decline envelope was signed",
        )
      }

      // CAS check — session_revision must match (Codex F1 fix)
      if (envelope.session_revision !== session.lastEventId) {
        throw new EngineError(
          409,
          "stale_revision",
          "Session has been modified since the decline envelope was signed",
        )
      }

      // 3d. Append COSIGN_DECLINED event
      // The reducer clears unsignedQuote/buyerSignature/sellerSignature and
      // reverts selectedSeller/selectedOfferId to null (→ NEGOTIATING state)
      return sessionManager.appendEvent(rfqId, {
        event_id: crypto.randomUUID(),
        rfq_id: rfqId,
        type: "COSIGN_DECLINED",
        timestamp: new Date().toISOString(),
        actor: session.selectedSeller,
        payload: {
          seller: session.selectedSeller,
        },
      })
    })

    // Step 4: Return 200
    return c.json(
      {
        rfq_id: rfqId,
        state: result.state,
      },
      200,
    )
  })

  return router
}
