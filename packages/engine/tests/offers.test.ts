import { describe, it, expect, beforeEach } from "vitest"
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
import { InMemoryEventStore } from "../src/state/event-store.js"
import { SessionManager } from "../src/state/session-manager.js"
import { ListingStore } from "../src/registry/listing-store.js"
import type { EngineEnv } from "../src/app.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BUYER_KP = Keypair.generate()
const BUYER_DID = buildDid(BUYER_KP.publicKey)
const SELLER_A_KP = Keypair.generate()
const SELLER_A_DID = buildDid(SELLER_A_KP.publicKey)
const SELLER_B_KP = Keypair.generate()
const SELLER_B_DID = buildDid(SELLER_B_KP.publicKey)

async function makeSignedRfq() {
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

async function createRfqSession(app: Hono<EngineEnv>) {
  const rfq = await makeSignedRfq()
  await app.request("/rfqs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(rfq),
  })
  return rfq
}

function createTestApp() {
  const store = new InMemoryEventStore()
  const sessionManager = new SessionManager(store)
  const listingStore = new ListingStore()
  // Register listings for test sellers
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
  return { app, store, sessionManager, listingStore }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /rfqs/:id/offers", () => {
  let app: Hono<EngineEnv>
  let sessionManager: SessionManager

  beforeEach(() => {
    const ctx = createTestApp()
    app = ctx.app
    sessionManager = ctx.sessionManager
  })

  // --- Happy path ---

  it("accepts valid offer and returns 201", async () => {
    const rfq = await createRfqSession(app)
    const offer = await makeSignedOffer(rfq.rfq_id, SELLER_A_KP)

    const res = await app.request(`/rfqs/${rfq.rfq_id}/offers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(offer),
    })

    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.offer_id).toBe(offer.offer_id)
    expect(body.state).toBe("NEGOTIATING")
  })

  it("binds offer provenance to the signed listing_id", async () => {
    const rfq = await createRfqSession(app)
    const offer = await makeSignedOffer(rfq.rfq_id, SELLER_A_KP, {
      listing_id: "listing-seller-a",
    })

    const res = await app.request(`/rfqs/${rfq.rfq_id}/offers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(offer),
    })

    expect(res.status).toBe(201)
    const session = sessionManager.getSession(rfq.rfq_id)
    expect(session?.offers[0]?.listing_id).toBe("listing-seller-a")
    expect(session?.offers[0]?.payment_endpoint).toBe("https://seller-a.example.com/pay")
  })

  it("transitions OPEN → NEGOTIATING on first offer", async () => {
    const rfq = await createRfqSession(app)
    const offer = await makeSignedOffer(rfq.rfq_id, SELLER_A_KP)

    await app.request(`/rfqs/${rfq.rfq_id}/offers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(offer),
    })

    const session = sessionManager.getSession(rfq.rfq_id)
    expect(session!.state).toBe("NEGOTIATING")
    expect(session!.offers).toHaveLength(1)
  })

  it("stays NEGOTIATING on subsequent offers", async () => {
    const rfq = await createRfqSession(app)

    await app.request(`/rfqs/${rfq.rfq_id}/offers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(await makeSignedOffer(rfq.rfq_id, SELLER_A_KP)),
    })
    await app.request(`/rfqs/${rfq.rfq_id}/offers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(await makeSignedOffer(rfq.rfq_id, SELLER_B_KP)),
    })

    const session = sessionManager.getSession(rfq.rfq_id)
    expect(session!.state).toBe("NEGOTIATING")
    expect(session!.offers).toHaveLength(2)
  })

  // --- Validation errors ---

  it("rejects offer for non-existent RFQ with 404", async () => {
    const offer = await makeSignedOffer("nonexistent-rfq", SELLER_A_KP)
    const res = await app.request("/rfqs/nonexistent-rfq/offers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(offer),
    })

    expect(res.status).toBe(404)
  })

  it("rejects malformed JSON with 400", async () => {
    const rfq = await createRfqSession(app)
    const res = await app.request(`/rfqs/${rfq.rfq_id}/offers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    })

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe("malformed_payload")
  })

  it("rejects offer missing listing_id with 400", async () => {
    const rfq = await createRfqSession(app)
    const offer = await makeSignedOffer(rfq.rfq_id, SELLER_A_KP)
    const { listing_id: _listingId, ...missingListingId } = offer
    const missingListingIdPayload = {
      ...missingListingId,
      signature: "",
    }
    missingListingIdPayload.signature = await signEd25519(
      objectSigningPayload(missingListingIdPayload),
      SELLER_A_KP,
    )

    const res = await app.request(`/rfqs/${rfq.rfq_id}/offers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(missingListingIdPayload),
    })

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe("malformed_payload")
  })

  it("rejects offer with mismatched rfq_id with 400", async () => {
    const rfq = await createRfqSession(app)
    const offer = await makeSignedOffer("different-rfq-id", SELLER_A_KP)

    const res = await app.request(`/rfqs/${rfq.rfq_id}/offers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(offer),
    })

    expect(res.status).toBe(400)
  })

  it("rejects offer with wrong currency with 422", async () => {
    const rfq = await createRfqSession(app)
    // Can't sign with wrong currency because validateOffer catches it before sig
    const offer = await makeSignedOffer(rfq.rfq_id, SELLER_A_KP, { currency: "BTC" })

    const res = await app.request(`/rfqs/${rfq.rfq_id}/offers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(offer),
    })

    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.error).toBe("currency_mismatch")
  })

  it("rejects offer with price normalizing to zero with 422", async () => {
    const rfq = await createRfqSession(app)
    const offer = await makeSignedOffer(rfq.rfq_id, SELLER_A_KP, {
      price: "0.0000001",
    })

    const res = await app.request(`/rfqs/${rfq.rfq_id}/offers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(offer),
    })

    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.error).toBe("invalid_amount")
  })

  // --- Signature verification ---

  it("rejects offer with invalid signature with 401", async () => {
    const rfq = await createRfqSession(app)
    const offer = await makeSignedOffer(rfq.rfq_id, SELLER_A_KP)
    // Replace signature with zeros
    const badOffer = {
      ...offer,
      signature: "ed25519:" + Buffer.from(new Uint8Array(64)).toString("base64"),
    }

    const res = await app.request(`/rfqs/${rfq.rfq_id}/offers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(badOffer),
    })

    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toBe("invalid_seller_signature")
  })

  it("rejects offer signed by different seller than claimed (impersonation)", async () => {
    const rfq = await createRfqSession(app)
    // Build offer claiming to be from seller A but signed by seller B's key
    const offer = {
      offer_id: crypto.randomUUID(),
      rfq_id: rfq.rfq_id,
      seller: SELLER_A_DID, // claims seller A
      listing_id: "listing-seller-a",
      price: "28.50",
      currency: "USDC",
      valid_until: new Date(Date.now() + 60_000).toISOString(),
      signature: "",
    }
    const payload = objectSigningPayload(offer)
    const sig = await signEd25519(payload, SELLER_B_KP) // signed by B
    const signedOffer = { ...offer, signature: sig }

    const res = await app.request(`/rfqs/${rfq.rfq_id}/offers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(signedOffer),
    })

    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toBe("invalid_seller_signature")
  })

  // --- Offer admission control ---

  it("rejects when per-DID offer limit (5) exceeded with 422", async () => {
    const rfq = await createRfqSession(app)

    // Submit 5 offers from seller A (should all succeed)
    for (let i = 0; i < 5; i++) {
      const offer = await makeSignedOffer(rfq.rfq_id, SELLER_A_KP)
      const res = await app.request(`/rfqs/${rfq.rfq_id}/offers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(offer),
      })
      expect(res.status).toBe(201)
    }

    // 6th offer from seller A should be rejected
    const offer6 = await makeSignedOffer(rfq.rfq_id, SELLER_A_KP)
    const res = await app.request(`/rfqs/${rfq.rfq_id}/offers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(offer6),
    })

    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.error).toBe("seller_offer_limit")
  })

  // --- State guard ---

  it("rejects offer on COMMIT_PENDING session with 409", async () => {
    const rfq = await createRfqSession(app)

    // Submit offer + manually transition to COMMIT_PENDING via SessionManager
    const offer = await makeSignedOffer(rfq.rfq_id, SELLER_A_KP)
    await app.request(`/rfqs/${rfq.rfq_id}/offers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(offer),
    })

    // Manually advance to COMMIT_PENDING
    await sessionManager.withLock(rfq.rfq_id, async () => {
      sessionManager.appendEvent(rfq.rfq_id, {
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

    // New offer should be rejected (COMMIT_PENDING)
    const offer2 = await makeSignedOffer(rfq.rfq_id, SELLER_B_KP)
    const res = await app.request(`/rfqs/${rfq.rfq_id}/offers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(offer2),
    })

    expect(res.status).toBe(409)
  })

  // --- Deadline check ---

  it("rejects offer after RFQ deadline with 409", async () => {
    // Create RFQ with very short deadline
    const rfqBody = {
      rfq_id: crypto.randomUUID(),
      protocol: "ghost-bazaar-v4",
      buyer: BUYER_DID,
      service_type: "llm-inference",
      spec: { model: "gpt-4" },
      anchor_price: "30.00",
      currency: "USDC",
      deadline: new Date(Date.now() + 100).toISOString(), // 100ms deadline
      signature: "",
    }
    const payload = objectSigningPayload(rfqBody)
    const sig = await signEd25519(payload, BUYER_KP)
    const rfq = { ...rfqBody, signature: sig }

    await app.request("/rfqs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(rfq),
    })

    // Wait for deadline to pass
    await new Promise((r) => setTimeout(r, 150))

    const offer = await makeSignedOffer(rfq.rfq_id, SELLER_A_KP)
    const res = await app.request(`/rfqs/${rfq.rfq_id}/offers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(offer),
    })

    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toBe("session_expired")
  })

  // --- Duplicate offer_id ---

  it("rejects duplicate offer_id with 409", async () => {
    const rfq = await createRfqSession(app)
    const offer = await makeSignedOffer(rfq.rfq_id, SELLER_A_KP)

    await app.request(`/rfqs/${rfq.rfq_id}/offers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(offer),
    })

    // Submit same offer_id again (different event_id but same offer_id)
    const dupOffer = await makeSignedOffer(rfq.rfq_id, SELLER_A_KP, {
      offer_id: offer.offer_id,
    })
    const res = await app.request(`/rfqs/${rfq.rfq_id}/offers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(dupOffer),
    })

    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toBe("duplicate_object_id")
  })

  // --- Extensions ---

  it("preserves extensions in offer event", async () => {
    const rfq = await createRfqSession(app)
    const offer = await makeSignedOffer(rfq.rfq_id, SELLER_A_KP, {
      extensions: { sla: "99.9%" },
    })

    const res = await app.request(`/rfqs/${rfq.rfq_id}/offers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(offer),
    })

    expect(res.status).toBe(201)
  })

  it("rejects listing_id that is not owned by the signing seller", async () => {
    const rfq = await createRfqSession(app)
    const offer = await makeSignedOffer(rfq.rfq_id, SELLER_A_KP, {
      listing_id: "listing-seller-b",
    })

    const res = await app.request(`/rfqs/${rfq.rfq_id}/offers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(offer),
    })

    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.error).toBe("missing_listing")
  })
})
