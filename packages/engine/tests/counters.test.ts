import { describe, it, expect, beforeEach, vi } from "vitest"
import { Hono } from "hono"
import { Keypair } from "@solana/web3.js"
import {
  buildDid,
  signEd25519,
  objectSigningPayload,
} from "@ghost-bazaar/core"
import { createApp } from "../src/app.js"
import { createRfqRoute } from "../src/routes/rfqs.js"
import { createOfferRoute } from "../src/routes/offers.js"
import { createCounterRoute } from "../src/routes/counters.js"
import { InMemoryEventStore } from "../src/state/event-store.js"
import { SessionManager } from "../src/state/session-manager.js"
import { ListingStore } from "../src/registry/listing-store.js"
import type { EngineEnv } from "../src/app.js"
import type { BudgetProofVerifier } from "../src/routes/counters.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BUYER_KP = Keypair.generate()
const BUYER_DID = buildDid(BUYER_KP.publicKey)
const SELLER_A_KP = Keypair.generate()
const SELLER_A_DID = buildDid(SELLER_A_KP.publicKey)
const SELLER_B_KP = Keypair.generate()
const SELLER_B_DID = buildDid(SELLER_B_KP.publicKey)

async function makeSignedRfq(overrides: Record<string, unknown> = {}) {
  const rfq = {
    rfq_id: crypto.randomUUID(),
    protocol: "ghost-bazaar-v4",
    buyer: BUYER_DID,
    service_type: "llm-inference",
    spec: { model: "gpt-4" },
    anchor_price: "30.00",
    currency: "USDC",
    deadline: new Date(Date.now() + 300_000).toISOString(),
    signature: "",
    ...overrides,
  }
  const payload = objectSigningPayload(rfq)
  const sig = await signEd25519(payload, BUYER_KP)
  return { ...rfq, signature: sig }
}

async function makeSignedOffer(
  rfqId: string,
  sellerKp: typeof SELLER_A_KP,
  overrides: Record<string, unknown> = {},
) {
  const sellerDid = buildDid(sellerKp.publicKey)
  const offer = {
    offer_id: crypto.randomUUID(),
    rfq_id: rfqId,
    seller: sellerDid,
    listing_id: sellerDid === SELLER_A_DID ? "listing-seller-a" : "listing-seller-b",
    price: "28.50",
    currency: "USDC",
    valid_until: new Date(Date.now() + 60_000).toISOString(),
    signature: "",
    ...overrides,
  }
  const payload = objectSigningPayload(offer)
  const sig = await signEd25519(payload, sellerKp)
  return { ...offer, signature: sig }
}

async function makeSignedCounter(
  rfqId: string,
  to: string,
  round: number,
  overrides: Record<string, unknown> = {},
) {
  const counter = {
    counter_id: crypto.randomUUID(),
    rfq_id: rfqId,
    round,
    from: BUYER_DID,
    to,
    price: "27.00",
    currency: "USDC",
    valid_until: new Date(Date.now() + 60_000).toISOString(),
    signature: "",
    ...overrides,
  }
  const payload = objectSigningPayload(counter)
  const sig = await signEd25519(payload, BUYER_KP)
  return { ...counter, signature: sig }
}

async function submitRfq(app: Hono<EngineEnv>, rfq: Record<string, unknown>) {
  return app.request("/rfqs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(rfq),
  })
}

async function submitOffer(
  app: Hono<EngineEnv>,
  rfqId: string,
  offer: Record<string, unknown>,
) {
  return app.request(`/rfqs/${rfqId}/offers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(offer),
  })
}

async function submitCounter(
  app: Hono<EngineEnv>,
  rfqId: string,
  counter: Record<string, unknown>,
) {
  return app.request(`/rfqs/${rfqId}/counter`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(counter),
  })
}

/** Sets up RFQ + offer so session is in NEGOTIATING state. */
async function setupNegotiatingSession(app: Hono<EngineEnv>) {
  const rfq = await makeSignedRfq()
  await submitRfq(app, rfq)
  const offer = await makeSignedOffer(rfq.rfq_id, SELLER_A_KP)
  await submitOffer(app, rfq.rfq_id, offer)
  return { rfq, offer }
}

/** No-op budget proof verifier (always passes). Used for non-ZK tests. */
const noopVerifier: BudgetProofVerifier = async () => true

/** Failing budget proof verifier (always rejects). */
const failingVerifier: BudgetProofVerifier = async () => false

function createTestApp(verifier: BudgetProofVerifier = noopVerifier) {
  const store = new InMemoryEventStore()
  const sessionManager = new SessionManager(store)
  const listingStore = new ListingStore()
  listingStore.add({
    listing_id: "listing-seller-a",
    seller: SELLER_A_DID,
    title: "Seller A Service",
    category: "llm",
    service_type: "llm-inference",
    negotiation_endpoint: "https://seller-a.example.com/negotiate",
    payment_endpoint: "https://seller-a.example.com/pay",
    base_terms: {},
  })
  listingStore.add({
    listing_id: "listing-seller-b",
    seller: SELLER_B_DID,
    title: "Seller B Service",
    category: "llm",
    service_type: "llm-inference",
    negotiation_endpoint: "https://seller-b.example.com/negotiate",
    payment_endpoint: "https://seller-b.example.com/pay",
    base_terms: {},
  })
  const app = createApp() as Hono<EngineEnv>
  app.route("/", createRfqRoute(sessionManager))
  app.route("/", createOfferRoute({ sessionManager, listingStore }))
  app.route("/", createCounterRoute({ sessionManager, verifyBudgetProof: verifier }))
  return { app, store, sessionManager, listingStore }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /rfqs/:id/counter", () => {
  let app: Hono<EngineEnv>
  let sessionManager: SessionManager

  beforeEach(() => {
    const ctx = createTestApp()
    app = ctx.app
    sessionManager = ctx.sessionManager
  })

  // --- Happy path ---

  it("accepts valid counter and returns 201", async () => {
    const { rfq, offer } = await setupNegotiatingSession(app)
    const counter = await makeSignedCounter(rfq.rfq_id, SELLER_A_DID, 1)

    const res = await submitCounter(app, rfq.rfq_id, counter)

    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.counter_id).toBe(counter.counter_id)
    expect(body.state).toBe("NEGOTIATING")
  })

  it("records counter in session state", async () => {
    const { rfq } = await setupNegotiatingSession(app)
    const counter = await makeSignedCounter(rfq.rfq_id, SELLER_A_DID, 1)

    await submitCounter(app, rfq.rfq_id, counter)

    const session = sessionManager.getSession(rfq.rfq_id)
    expect(session!.counters).toHaveLength(1)
    expect(session!.counters[0].counter_id).toBe(counter.counter_id)
    expect(session!.counters[0].round).toBe(1)
    expect(session!.counters[0].to).toBe(SELLER_A_DID)
  })

  it("allows multiple counters to different sellers", async () => {
    const rfq = await makeSignedRfq()
    await submitRfq(app, rfq)
    // Two sellers submit offers
    await submitOffer(app, rfq.rfq_id, await makeSignedOffer(rfq.rfq_id, SELLER_A_KP))
    await submitOffer(app, rfq.rfq_id, await makeSignedOffer(rfq.rfq_id, SELLER_B_KP))

    // Counter to seller A round 1
    const counter1 = await makeSignedCounter(rfq.rfq_id, SELLER_A_DID, 1)
    const res1 = await submitCounter(app, rfq.rfq_id, counter1)
    expect(res1.status).toBe(201)

    // Counter to seller B round 2
    const counter2 = await makeSignedCounter(rfq.rfq_id, SELLER_B_DID, 2)
    const res2 = await submitCounter(app, rfq.rfq_id, counter2)
    expect(res2.status).toBe(201)

    const session = sessionManager.getSession(rfq.rfq_id)
    expect(session!.counters).toHaveLength(2)
  })

  // --- Validation errors ---

  it("rejects malformed JSON with 400", async () => {
    const { rfq } = await setupNegotiatingSession(app)
    const res = await app.request(`/rfqs/${rfq.rfq_id}/counter`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    })

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe("malformed_payload")
  })

  it("rejects body with missing signature/from fields with 400 (not 500)", async () => {
    const { rfq } = await setupNegotiatingSession(app)
    const res = await app.request(`/rfqs/${rfq.rfq_id}/counter`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rfq_id: rfq.rfq_id }),
    })

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe("malformed_payload")
  })

  it("rejects non-object JSON body (string) with 400 (not 500)", async () => {
    const { rfq } = await setupNegotiatingSession(app)
    const res = await app.request(`/rfqs/${rfq.rfq_id}/counter`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify("just-a-string"),
    })

    // JSON.parse("\"just-a-string\"") is valid JSON but not an object.
    // preCheckSignatureFormat should reject with 400, not crash with 500.
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe("malformed_payload")
  })

  it("rejects counter for non-existent RFQ with 404", async () => {
    const counter = await makeSignedCounter("nonexistent-rfq", SELLER_A_DID, 1)
    const res = await submitCounter(app, "nonexistent-rfq", counter)
    expect(res.status).toBe(404)
  })

  it("rejects counter with mismatched rfq_id with 400", async () => {
    const { rfq } = await setupNegotiatingSession(app)
    const counter = await makeSignedCounter("different-rfq-id", SELLER_A_DID, 1)

    const res = await submitCounter(app, rfq.rfq_id, counter)
    expect(res.status).toBe(400)
  })

  it("rejects counter with mismatched currency with 422", async () => {
    const { rfq } = await setupNegotiatingSession(app)
    const counter = await makeSignedCounter(rfq.rfq_id, SELLER_A_DID, 1, {
      currency: "BTC",
    })

    const res = await submitCounter(app, rfq.rfq_id, counter)
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.error).toBe("currency_mismatch")
  })

  it("rejects counter with zero-normalizing price with 422", async () => {
    const { rfq } = await setupNegotiatingSession(app)
    const counter = await makeSignedCounter(rfq.rfq_id, SELLER_A_DID, 1, {
      price: "0.0000001",
    })

    const res = await submitCounter(app, rfq.rfq_id, counter)
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.error).toBe("invalid_amount")
  })

  // --- Authorization ---

  it("rejects counter from non-buyer (seller trying to counter) with 422", async () => {
    const { rfq } = await setupNegotiatingSession(app)
    // Build counter claiming from=SELLER_A_DID (not the buyer)
    const counter = {
      counter_id: crypto.randomUUID(),
      rfq_id: rfq.rfq_id,
      round: 1,
      from: SELLER_A_DID,
      to: SELLER_A_DID,
      price: "27.00",
      currency: "USDC",
      valid_until: new Date(Date.now() + 60_000).toISOString(),
      signature: "",
    }
    const payload = objectSigningPayload(counter)
    const sig = await signEd25519(payload, SELLER_A_KP)
    const signedCounter = { ...counter, signature: sig }

    const res = await submitCounter(app, rfq.rfq_id, signedCounter)
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.error).toBe("unauthorized_counter")
  })

  it("rejects counter to seller who has no offer with 422", async () => {
    const { rfq } = await setupNegotiatingSession(app) // only seller A has offer
    // Counter to seller B (who never submitted an offer)
    const counter = await makeSignedCounter(rfq.rfq_id, SELLER_B_DID, 1)

    const res = await submitCounter(app, rfq.rfq_id, counter)
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.error).toBe("unauthorized_counter")
  })

  // --- Signature verification ---

  it("rejects counter with invalid signature with 401", async () => {
    const { rfq } = await setupNegotiatingSession(app)
    const counter = await makeSignedCounter(rfq.rfq_id, SELLER_A_DID, 1)
    const badCounter = {
      ...counter,
      signature: "ed25519:" + Buffer.from(new Uint8Array(64)).toString("base64"),
    }

    const res = await submitCounter(app, rfq.rfq_id, badCounter)
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toBe("invalid_buyer_signature")
  })

  it("rejects counter signed by wrong key (impersonation) with 401", async () => {
    const { rfq } = await setupNegotiatingSession(app)
    // Build counter claiming to be from buyer but signed by seller's key
    const counter = {
      counter_id: crypto.randomUUID(),
      rfq_id: rfq.rfq_id,
      round: 1,
      from: BUYER_DID,
      to: SELLER_A_DID,
      price: "27.00",
      currency: "USDC",
      valid_until: new Date(Date.now() + 60_000).toISOString(),
      signature: "",
    }
    const payload = objectSigningPayload(counter)
    const sig = await signEd25519(payload, SELLER_A_KP) // wrong key!
    const signedCounter = { ...counter, signature: sig }

    const res = await submitCounter(app, rfq.rfq_id, signedCounter)
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toBe("invalid_buyer_signature")
  })

  // --- State guard ---

  it("rejects counter on OPEN session (no offers yet) with 422", async () => {
    const rfq = await makeSignedRfq()
    await submitRfq(app, rfq)
    // Session is OPEN — no offers submitted, so counter.to has no recorded offer
    // Per Spec §8 ordering, step 8 (recipient validation) fires before the
    // locked state guard at step 11, returning 422 unauthorized_counter.
    const counter = await makeSignedCounter(rfq.rfq_id, SELLER_A_DID, 1)

    const res = await submitCounter(app, rfq.rfq_id, counter)
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.error).toBe("unauthorized_counter")
  })

  it("rejects counter on COMMIT_PENDING session with 409", async () => {
    const { rfq, offer } = await setupNegotiatingSession(app)

    // Advance to COMMIT_PENDING
    await sessionManager.withLock(rfq.rfq_id, async () => {
      return sessionManager.appendEvent(rfq.rfq_id, {
        event_id: crypto.randomUUID(),
        rfq_id: rfq.rfq_id,
        type: "WINNER_SELECTED",
        timestamp: new Date().toISOString(),
        actor: BUYER_DID,
        payload: {
          rfq_id: rfq.rfq_id,
          seller: SELLER_A_DID,
          offer_id: offer.offer_id,
        },
      })
    })

    const counter = await makeSignedCounter(rfq.rfq_id, SELLER_A_DID, 1)
    const res = await submitCounter(app, rfq.rfq_id, counter)
    expect(res.status).toBe(409)
  })

  // --- Deadline check ---

  it("rejects counter after RFQ deadline with 409", async () => {
    // Create RFQ with very short deadline
    const rfq = await makeSignedRfq({
      deadline: new Date(Date.now() + 100).toISOString(),
    })
    await submitRfq(app, rfq)
    const offer = await makeSignedOffer(rfq.rfq_id, SELLER_A_KP)
    await submitOffer(app, rfq.rfq_id, offer)

    // Wait for deadline to pass
    await new Promise((r) => setTimeout(r, 150))

    const counter = await makeSignedCounter(rfq.rfq_id, SELLER_A_DID, 1)
    const res = await submitCounter(app, rfq.rfq_id, counter)
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toBe("session_expired")
  })

  // --- Round monotonicity ---

  it("rejects counter with non-increasing round with 422", async () => {
    const { rfq } = await setupNegotiatingSession(app)

    // Round 1 — succeeds
    const c1 = await makeSignedCounter(rfq.rfq_id, SELLER_A_DID, 1)
    const res1 = await submitCounter(app, rfq.rfq_id, c1)
    expect(res1.status).toBe(201)

    // Round 1 again — must fail (not increasing)
    const c2 = await makeSignedCounter(rfq.rfq_id, SELLER_A_DID, 1)
    const res2 = await submitCounter(app, rfq.rfq_id, c2)
    expect(res2.status).toBe(422)
    const body = await res2.json()
    expect(body.error).toBe("invalid_round")
  })

  it("rejects counter with decreasing round with 422", async () => {
    const { rfq } = await setupNegotiatingSession(app)

    const c1 = await makeSignedCounter(rfq.rfq_id, SELLER_A_DID, 3)
    expect((await submitCounter(app, rfq.rfq_id, c1)).status).toBe(201)

    // Round 2 < 3 — must fail
    const c2 = await makeSignedCounter(rfq.rfq_id, SELLER_A_DID, 2)
    const res = await submitCounter(app, rfq.rfq_id, c2)
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.error).toBe("invalid_round")
  })

  // --- Duplicate counter_id ---

  it("rejects duplicate counter_id with 409", async () => {
    const { rfq } = await setupNegotiatingSession(app)
    const counter = await makeSignedCounter(rfq.rfq_id, SELLER_A_DID, 1)

    const res1 = await submitCounter(app, rfq.rfq_id, counter)
    expect(res1.status).toBe(201)

    // Submit same counter_id again with higher round
    const dupCounter = await makeSignedCounter(rfq.rfq_id, SELLER_A_DID, 2, {
      counter_id: counter.counter_id,
    })
    const res2 = await submitCounter(app, rfq.rfq_id, dupCounter)
    expect(res2.status).toBe(409)
    const body = await res2.json()
    expect(body.error).toBe("duplicate_object_id")
  })

  // --- Extensions ---

  it("preserves extensions in counter event", async () => {
    const { rfq } = await setupNegotiatingSession(app)
    const counter = await makeSignedCounter(rfq.rfq_id, SELLER_A_DID, 1, {
      extensions: { reason: "price too high" },
    })

    const res = await submitCounter(app, rfq.rfq_id, counter)
    expect(res.status).toBe(201)
  })

  it("rejects extensions exceeding 4096 bytes with 400", async () => {
    const { rfq } = await setupNegotiatingSession(app)
    const counter = await makeSignedCounter(rfq.rfq_id, SELLER_A_DID, 1, {
      extensions: { data: "x".repeat(5000) },
    })

    const res = await submitCounter(app, rfq.rfq_id, counter)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe("malformed_payload")
  })

  it("rejects invalid extensions with 400", async () => {
    const { rfq } = await setupNegotiatingSession(app)
    const counter = await makeSignedCounter(rfq.rfq_id, SELLER_A_DID, 1, {
      extensions: "not-an-object",
    })

    const res = await submitCounter(app, rfq.rfq_id, counter)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe("malformed_payload")
  })

  // --- ZK proof verification ---

  describe("with budget_commitment", () => {
    const BUDGET_COMMITMENT = "poseidon:" + "ab".repeat(32)

    async function setupZkSession(testApp: Hono<EngineEnv>) {
      const rfq = await makeSignedRfq({
        budget_commitment: BUDGET_COMMITMENT,
      })
      await submitRfq(testApp, rfq)
      const offer = await makeSignedOffer(rfq.rfq_id, SELLER_A_KP)
      await submitOffer(testApp, rfq.rfq_id, offer)
      return { rfq, offer }
    }

    it("accepts counter with valid ZK proof", async () => {
      const mockVerifier: BudgetProofVerifier = vi.fn(async () => true)
      const ctx = createTestApp(mockVerifier)
      const { rfq } = await setupZkSession(ctx.app)

      const counter = await makeSignedCounter(rfq.rfq_id, SELLER_A_DID, 1, {
        budget_proof: {
          protocol: "groth16",
          curve: "bn128",
          counter_price_scaled: "27000000", // 27.00 * 10^6
          pi_a: ["1", "2"],
          pi_b: [["3", "4"], ["5", "6"]],
          pi_c: ["7", "8"],
        },
      })

      const res = await submitCounter(ctx.app, rfq.rfq_id, counter)
      expect(res.status).toBe(201)
      expect(mockVerifier).toHaveBeenCalledOnce()
    })

    it("rejects counter with missing ZK proof when budget_commitment present with 422", async () => {
      const ctx = createTestApp()
      const { rfq } = await setupZkSession(ctx.app)

      // Counter WITHOUT budget_proof
      const counter = await makeSignedCounter(rfq.rfq_id, SELLER_A_DID, 1)

      const res = await submitCounter(ctx.app, rfq.rfq_id, counter)
      expect(res.status).toBe(422)
      const body = await res.json()
      expect(body.error).toBe("missing_budget_proof")
    })

    it("rejects counter with proof_price_mismatch with 422", async () => {
      const mockVerifier: BudgetProofVerifier = vi.fn(async () => true)
      const ctx = createTestApp(mockVerifier)
      const { rfq } = await setupZkSession(ctx.app)

      const counter = await makeSignedCounter(rfq.rfq_id, SELLER_A_DID, 1, {
        budget_proof: {
          protocol: "groth16",
          curve: "bn128",
          counter_price_scaled: "99999999", // does NOT match counter.price
          pi_a: ["1", "2"],
          pi_b: [["3", "4"], ["5", "6"]],
          pi_c: ["7", "8"],
        },
      })

      const res = await submitCounter(ctx.app, rfq.rfq_id, counter)
      expect(res.status).toBe(422)
      const body = await res.json()
      expect(body.error).toBe("proof_price_mismatch")
      // Verifier should NOT have been called (price check fails first)
      expect(mockVerifier).not.toHaveBeenCalled()
    })

    it("rejects counter with invalid ZK proof with 422", async () => {
      const mockVerifier: BudgetProofVerifier = vi.fn(async () => false)
      const ctx = createTestApp(mockVerifier)
      const { rfq } = await setupZkSession(ctx.app)

      const counter = await makeSignedCounter(rfq.rfq_id, SELLER_A_DID, 1, {
        budget_proof: {
          protocol: "groth16",
          curve: "bn128",
          counter_price_scaled: "27000000",
          pi_a: ["1", "2"],
          pi_b: [["3", "4"], ["5", "6"]],
          pi_c: ["7", "8"],
        },
      })

      const res = await submitCounter(ctx.app, rfq.rfq_id, counter)
      expect(res.status).toBe(422)
      const body = await res.json()
      expect(body.error).toBe("invalid_budget_proof")
    })

    it("returns 422 (not 500) when verifier throws", async () => {
      const throwingVerifier: BudgetProofVerifier = async () => {
        throw new Error("snarkjs internal failure")
      }
      const ctx = createTestApp(throwingVerifier)
      const { rfq } = await setupZkSession(ctx.app)

      const counter = await makeSignedCounter(rfq.rfq_id, SELLER_A_DID, 1, {
        budget_proof: {
          protocol: "groth16",
          curve: "bn128",
          counter_price_scaled: "27000000",
          pi_a: ["1", "2"],
          pi_b: [["3", "4"], ["5", "6"]],
          pi_c: ["7", "8"],
        },
      })

      const res = await submitCounter(ctx.app, rfq.rfq_id, counter)
      expect(res.status).toBe(422)
      const body = await res.json()
      expect(body.error).toBe("invalid_budget_proof")
    })

    it("rejects unexpected budget_proof when no budget_commitment with 422", async () => {
      // Session WITHOUT budget_commitment (default)
      const { rfq } = await setupNegotiatingSession(app)
      const counter = await makeSignedCounter(rfq.rfq_id, SELLER_A_DID, 1, {
        budget_proof: {
          protocol: "groth16",
          curve: "bn128",
          counter_price_scaled: "27000000",
          pi_a: ["1", "2"],
          pi_b: [["3", "4"], ["5", "6"]],
          pi_c: ["7", "8"],
        },
      })

      const res = await submitCounter(app, rfq.rfq_id, counter)
      expect(res.status).toBe(422)
      const body = await res.json()
      expect(body.error).toBe("unexpected_budget_proof")
    })
  })
})
