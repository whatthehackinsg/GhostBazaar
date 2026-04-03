import { Hono } from "hono"
import { validateCounter, normalizeAmount } from "@ghost-bazaar/core"
import type { RFQ, BudgetProof } from "@ghost-bazaar/core"
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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Injectable ZK proof verifier — allows tests to mock expensive Groth16
 * verification (~50ms) without needing actual snarkjs circuits.
 *
 * Signature matches @ghost-bazaar/zk's verifyBudgetProof:
 *   (proof, counter_price_scaled, budget_commitment) → boolean
 */
export type BudgetProofVerifier = (
  proof: BudgetProof,
  counterPriceScaled: bigint,
  budgetCommitment: string,
) => Promise<boolean>

// ---------------------------------------------------------------------------
// Counter Route — POST /rfqs/:id/counter
//
// 12-step counter verification per Spec §8 (with pre-check step 0):
//
//  1. Parse JSON body → 400
//  0. Pre-check signature format (~0.1ms DoS filter) → 400
//     Runs immediately after parse, BEFORE any session lookup, schema
//     validation, or ZK verification. Rejects syntactically malformed
//     signatures before ANY expensive operation.
//  2. Retrieve RFQ session → 404
//  3. validateCounter(counter, rfq) → 400/422
//  4. normalizeAmount(price, mint) > 0n → 422
//  5. Validate extensions if present
//  6. Defense-in-depth: rfq_id binding check
//  7. Verify counter.from === rfq.buyer → 422 unauthorized_counter
//  8. Verify counter.to has submitted an offer → 422 unauthorized_counter
//  9. ZK proof verification (if budget_commitment present) → 422
// 10. Full Ed25519 signature verification → 401
// 11. State guard + round monotonicity + deadline (inside lock) → 409/422
// 12. Append COUNTER_SENT event + return 201
//
// NOTE: Per Spec §8, schema validation (steps 3-8) runs BEFORE signature
// verification (step 10). ZK proof verification (step 9) runs before sig
// to avoid wasting both ZK + Ed25519 CPU on invalid proofs.
//
// IMPORTANT: Steps 7-8 (buyer auth + recipient validation) run BEFORE
// signature verification. This is Spec §8 normative order: "MUST validate
// in this order" so clients get 422 unauthorized_counter before 401.
// The pre-check (step 0) ensures only syntactically valid signatures
// with well-formed DID reach any of these steps.
// ---------------------------------------------------------------------------

/** Extract only known counter fields for signature verification. */
function extractCounterFields(body: Record<string, unknown>): Record<string, unknown> {
  const counter: Record<string, unknown> = {
    counter_id: body.counter_id,
    rfq_id: body.rfq_id,
    round: body.round,
    from: body.from,
    to: body.to,
    price: body.price,
    currency: body.currency,
    valid_until: body.valid_until,
    signature: body.signature,
  }
  if (body.budget_proof !== undefined) {
    counter.budget_proof = body.budget_proof
  }
  if (body.extensions !== undefined) {
    counter.extensions = body.extensions
  }
  return counter
}

export interface CounterRouteConfig {
  readonly sessionManager: SessionManager
  /**
   * Injectable ZK budget proof verifier. In production, pass
   * `verifyBudgetProof` from `@ghost-bazaar/zk`. In tests, pass a mock.
   */
  readonly verifyBudgetProof: BudgetProofVerifier
}

export function createCounterRoute(config: CounterRouteConfig): Hono<EngineEnv> {
  const { sessionManager, verifyBudgetProof: zkVerify } = config
  const router = new Hono<EngineEnv>()

  router.post("/rfqs/:id/counter", async (c) => {
    const rfqId = c.req.param("id")

    // Step 1: Parse JSON
    let body: Record<string, unknown>
    try {
      body = await c.req.json()
    } catch {
      throw new EngineError(400, "malformed_payload", "Invalid JSON body")
    }

    // Step 0: Pre-check signature format (~0.1ms DoS filter)
    // MUST run before ANY expensive operation (ZK ~50ms, Ed25519 ~1ms).
    // Rejects syntactically malformed signatures immediately.
    preCheckSignatureFormat(body.signature as string, body.from as string)

    // Step 2: Retrieve RFQ session
    const session = sessionManager.getSession(rfqId)
    if (!session) {
      throw new EngineError(404, "session_not_found", "RFQ session not found")
    }

    // Build RFQ object for validateCounter
    const rfq = session.rfq as unknown as RFQ

    // Step 3: Validate counter schema (Spec §8 steps 1-5)
    const validation = validateCounter(body, rfq)
    if (!validation.ok) {
      const status =
        validation.code === "invalid_amount" ||
        validation.code === "currency_mismatch" ||
        validation.code === "invalid_expiry" ||
        validation.code === "invalid_round" ||
        validation.code === "missing_budget_proof" ||
        validation.code === "invalid_budget_proof" ||
        validation.code === "unexpected_budget_proof" ||
        validation.code === "unauthorized_counter"
          ? 422
          : 400
      throw new EngineError(status, validation.code, `Counter validation failed: ${validation.code}`)
    }

    // Step 4: normalizeAmount check
    const mint = mintFor(rfq.currency)
    if (normalizeAmount(body.price as string, mint) <= 0n) {
      throw new EngineError(422, "invalid_amount", "Counter price normalizes to zero")
    }

    // Step 5: Validate extensions if present
    if (body.extensions !== undefined) {
      if (typeof body.extensions !== "object" || body.extensions === null || Array.isArray(body.extensions)) {
        throw new EngineError(400, "malformed_payload", "extensions must be a plain object")
      }
      if (JSON.stringify(body.extensions).length > 4096) {
        throw new EngineError(400, "malformed_payload", "extensions exceeds 4096 bytes")
      }
    }

    // Step 6: Defense-in-depth — explicit rfq_id binding check
    if (body.rfq_id !== rfqId) {
      throw new EngineError(400, "rfq_id_mismatch", "Counter rfq_id does not match route")
    }

    // Step 7: Verify counter.from === rfq.buyer (Spec §8 — before sig verify)
    if (body.from !== rfq.buyer) {
      throw new EngineError(422, "unauthorized_counter", "Only the RFQ buyer can send counters")
    }

    // Step 8: Verify counter.to has submitted an offer
    // SECURITY NOTE: Steps 7-8 run before sig verify (step 10) per Spec §8
    // normative ordering. An attacker claiming to be the buyer (self-asserted
    // `from` field) could probe which sellers have offers by observing the
    // error code. This is an accepted tradeoff: (a) the pre-check at step 0
    // requires valid signature format + valid DID, (b) Spec §8 mandates this
    // ordering for correct client error code semantics, (c) offer
    // participation is semi-public in real-world negotiations. For stronger
    // isolation, production deployments should add per-IP rate limiting.
    if (!session.offers.some((o) => o.seller === body.to)) {
      throw new EngineError(422, "unauthorized_counter", "Counter recipient has no recorded offer")
    }

    // Step 9: ZK proof verification (if budget_commitment present)
    if (rfq.budget_commitment) {
      const budgetProof = body.budget_proof as BudgetProof | undefined
      if (!budgetProof) {
        throw new EngineError(422, "missing_budget_proof", "Budget proof required when RFQ has budget_commitment")
      }

      // Verify counter_price_scaled matches normalizeAmount(counter.price)
      const expectedScaled = normalizeAmount(body.price as string, mint)
      if (budgetProof.counter_price_scaled !== expectedScaled.toString()) {
        throw new EngineError(422, "proof_price_mismatch", "budget_proof.counter_price_scaled does not match normalized counter price")
      }

      // Verify Groth16 proof (~50ms)
      // Wrap in try/catch: verifier may throw on malformed proof material
      // or dependency failure. All verifier failures → 422, never 500.
      let proofValid: boolean
      try {
        proofValid = await zkVerify(budgetProof, expectedScaled, rfq.budget_commitment)
      } catch {
        proofValid = false
      }
      if (!proofValid) {
        throw new EngineError(422, "invalid_budget_proof", "Budget proof verification failed")
      }
    } else if (body.budget_proof !== undefined) {
      throw new EngineError(422, "unexpected_budget_proof", "Budget proof provided but RFQ has no budget_commitment")
    }

    // Step 10: Full Ed25519 signature verification
    const counterForSig = extractCounterFields(body)
    await verifySignature(
      counterForSig,
      body.signature as string,
      body.from as string,
      "invalid_buyer_signature",
    )

    // Steps 11-12: Inside lock for atomicity
    const updatedSession = await sessionManager.withLock(rfqId, async (lockedSession) => {
      if (!lockedSession) {
        throw new EngineError(404, "session_not_found", "RFQ session not found")
      }

      // Deadline check inside lock — FIRST check, uses current wall clock
      if (Date.now() >= new Date(lockedSession.rfq.deadline).getTime()) {
        throw new EngineError(409, "session_expired", "RFQ deadline has passed")
      }

      // Step 11a: State guard — only NEGOTIATING allows counters
      assertState(lockedSession.state, SessionState.NEGOTIATING)

      // Re-validate counter.to inside lock — prevents stale snapshot where
      // a concurrent offer from this seller was appended between the initial
      // read (step 8) and lock acquisition. Without this, the same counter
      // could be incorrectly rejected if the offer arrives concurrently.
      if (!lockedSession.offers.some((o) => o.seller === body.to)) {
        throw new EngineError(422, "unauthorized_counter", "Counter recipient has no recorded offer")
      }

      // counter_id uniqueness check
      const counterId = body.counter_id as string
      if (lockedSession.counters.some((ct) => ct.counter_id === counterId)) {
        throw new EngineError(409, "duplicate_object_id", `Counter ${counterId} already exists`)
      }

      // Step 11b: Round monotonicity — counter.round must exceed all existing rounds.
      // NOTE: This is GLOBAL per session, not per-recipient. If buyer sends
      // round 3 to seller A, they cannot send round 2 to seller B.
      // This is the stricter (safer) interpretation of Spec "monotonically
      // increasing per rfq_id". Per-seller monotonicity would require
      // maxRoundBySeller tracking — deferred to future protocol revision.
      const maxExistingRound = lockedSession.counters.reduce(
        (max, ct) => Math.max(max, ct.round),
        0,
      )
      const counterRound = body.round as number
      if (counterRound <= maxExistingRound) {
        throw new EngineError(422, "invalid_round", `Counter round ${counterRound} must exceed current max ${maxExistingRound}`)
      }

      // Step 12: Append COUNTER_SENT event
      return sessionManager.appendEvent(rfqId, {
        event_id: crypto.randomUUID(),
        rfq_id: rfqId,
        type: "COUNTER_SENT",
        timestamp: new Date().toISOString(),
        actor: body.from as string,
        payload: {
          rfq_id: rfqId,
          counter_id: body.counter_id as string,
          round: body.round as number,
          from: body.from as string,
          to: body.to as string,
          price: body.price as string,
          currency: body.currency as string,
          valid_until: body.valid_until as string,
          signature: body.signature as string,
          ...(body.budget_proof !== undefined
            ? { budget_proof: body.budget_proof }
            : {}),
          ...(body.extensions !== undefined
            ? { extensions: body.extensions }
            : {}),
        },
      })
    })

    // Return 201
    return c.json(
      {
        counter_id: body.counter_id,
        rfq_id: rfqId,
        state: updatedSession.state,
        round: body.round,
        from: body.from,
        to: body.to,
        price: body.price,
      },
      201,
    )
  })

  return router
}
