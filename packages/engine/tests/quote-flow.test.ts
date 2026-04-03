/**
 * Step 8: Quote Construction Flow — Integration Tests
 *
 * Tests the full accept → buyer sign → seller cosign → COMMITTED lifecycle,
 * including decline, rollback, CAS, deadline/expiry, and identity binding.
 */

import { describe, it, expect, beforeEach } from "vitest"
import { Hono } from "hono"
import { Keypair } from "@solana/web3.js"
import {
  buildDid,
  signEd25519,
  objectSigningPayload,
  canonicalJson,
} from "@ghost-bazaar/core"
import { createApp } from "../src/app.js"
import { createRfqRoute } from "../src/routes/rfqs.js"
import { createOfferRoute } from "../src/routes/offers.js"
import { createCounterRoute } from "../src/routes/counters.js"
import { createAcceptRoute } from "../src/routes/accept.js"
import { createQuoteSignRoute } from "../src/routes/quote-sign.js"
import { createQuoteReadRoute } from "../src/routes/quote-read.js"
import { createCosignRoute } from "../src/routes/cosign.js"
import { createDeclineRoute } from "../src/routes/decline.js"
import { InMemoryEventStore } from "../src/state/event-store.js"
import { SessionManager } from "../src/state/session-manager.js"
import { ListingStore } from "../src/registry/listing-store.js"
import { EnvelopeTombstones } from "../src/security/control-envelope.js"
import type { EngineEnv } from "../src/app.js"

// ---------------------------------------------------------------------------
// Key pairs
// ---------------------------------------------------------------------------

const BUYER_KP = Keypair.generate()
const BUYER_DID = buildDid(BUYER_KP.publicKey)
const SELLER_A_KP = Keypair.generate()
const SELLER_A_DID = buildDid(SELLER_A_KP.publicKey)
const SELLER_B_KP = Keypair.generate()
const SELLER_B_DID = buildDid(SELLER_B_KP.publicKey)

// ---------------------------------------------------------------------------
// Signing helpers
// ---------------------------------------------------------------------------

async function makeSignedRfq(overrides: Record<string, unknown> = {}) {
  const rfq: Record<string, unknown> = {
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
  rfq.signature = await signEd25519(payload, BUYER_KP)
  return rfq
}

async function makeSignedOffer(
  rfqId: string,
  sellerKp: Keypair,
  overrides: Record<string, unknown> = {},
) {
  const sellerDid = buildDid(sellerKp.publicKey)
  const offer: Record<string, unknown> = {
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
  offer.signature = await signEd25519(payload, sellerKp)
  return offer
}

async function makeAcceptEnvelope(
  rfqId: string,
  sessionRevision: string,
  seller: string,
  offerId: string,
  signerKp: Keypair = BUYER_KP,
) {
  const envelope: Record<string, unknown> = {
    envelope_id: crypto.randomUUID(),
    action: "accept",
    rfq_id: rfqId,
    session_revision: sessionRevision,
    payload: { seller, offer_id: offerId },
    issued_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    signature: "",
  }
  const sigPayload = objectSigningPayload(envelope)
  envelope.signature = await signEd25519(sigPayload, signerKp)
  return envelope
}

async function makeDeclineEnvelope(
  rfqId: string,
  sessionRevision: string,
  signerKp: Keypair,
) {
  const envelope: Record<string, unknown> = {
    envelope_id: crypto.randomUUID(),
    action: "decline",
    rfq_id: rfqId,
    session_revision: sessionRevision,
    payload: {},
    issued_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    signature: "",
  }
  const sigPayload = objectSigningPayload(envelope)
  envelope.signature = await signEd25519(sigPayload, signerKp)
  return envelope
}

/** Sign a quote as buyer — uses quoteSigningPayload (buyer_sig="" + seller_sig="") */
async function signQuoteAsBuyer(quote: Record<string, unknown>): Promise<string> {
  const obj: Record<string, unknown> = { ...quote, buyer_signature: "", seller_signature: "" }
  const bytes = canonicalJson(obj)
  return signEd25519(bytes, BUYER_KP)
}

/** Sign a quote as seller — uses quoteSigningPayload */
async function signQuoteAsSeller(
  quote: Record<string, unknown>,
  sellerKp: Keypair,
): Promise<string> {
  const obj: Record<string, unknown> = { ...quote, buyer_signature: "", seller_signature: "" }
  const bytes = canonicalJson(obj)
  return signEd25519(bytes, sellerKp)
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function submitRfq(app: Hono<EngineEnv>, rfq: Record<string, unknown>) {
  return app.request("/rfqs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(rfq),
  })
}

async function submitOffer(app: Hono<EngineEnv>, rfqId: string, offer: Record<string, unknown>) {
  return app.request(`/rfqs/${rfqId}/offers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(offer),
  })
}

async function submitAccept(app: Hono<EngineEnv>, rfqId: string, envelope: Record<string, unknown>) {
  return app.request(`/rfqs/${rfqId}/accept`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(envelope),
  })
}

async function submitQuoteSign(app: Hono<EngineEnv>, rfqId: string, buyerSignature: string) {
  return app.request(`/rfqs/${rfqId}/quote/sign`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ buyer_signature: buyerSignature }),
  })
}

async function submitCosign(app: Hono<EngineEnv>, rfqId: string, sellerSignature: string) {
  return app.request(`/rfqs/${rfqId}/cosign`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ seller_signature: sellerSignature }),
  })
}

async function submitDecline(app: Hono<EngineEnv>, rfqId: string, envelope: Record<string, unknown>) {
  return app.request(`/rfqs/${rfqId}/decline`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(envelope),
  })
}

async function getQuote(app: Hono<EngineEnv>, rfqId: string) {
  return app.request(`/rfqs/${rfqId}/quote`, { method: "GET" })
}

// ---------------------------------------------------------------------------
// App setup
// ---------------------------------------------------------------------------

function createTestApp() {
  const store = new InMemoryEventStore()
  const sessionManager = new SessionManager(store)
  const listingStore = new ListingStore()
  const tombstones = new EnvelopeTombstones()

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

  const noopVerifier = async () => true
  const app = createApp() as Hono<EngineEnv>
  app.route("/", createRfqRoute(sessionManager))
  app.route("/", createOfferRoute({ sessionManager, listingStore }))
  app.route("/", createCounterRoute({ sessionManager, verifyBudgetProof: noopVerifier }))
  app.route("/", createAcceptRoute({ sessionManager, tombstones }))
  app.route("/", createQuoteSignRoute({ sessionManager }))
  app.route(
    "/",
    createQuoteReadRoute({
      sessionManager,
      authenticateCaller: async () => BUYER_DID, // default: buyer reads
    }),
  )
  app.route("/", createCosignRoute({ sessionManager }))
  app.route("/", createDeclineRoute({ sessionManager, tombstones }))

  return { app, store, sessionManager, listingStore, tombstones }
}

/** Setup: RFQ + offer → NEGOTIATING. Returns session revision (lastEventId). */
async function setupNegotiatingSession(app: Hono<EngineEnv>) {
  const rfq = await makeSignedRfq()
  await submitRfq(app, rfq)
  const offer = await makeSignedOffer(rfq.rfq_id, SELLER_A_KP)
  await submitOffer(app, rfq.rfq_id, offer)
  return { rfq, offer }
}

/** Get current session revision (lastEventId) */
function getSessionRevision(sessionManager: SessionManager, rfqId: string): string {
  const session = sessionManager.getSession(rfqId)
  return session!.lastEventId
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Step 8: Quote Construction Flow", () => {
  let app: Hono<EngineEnv>
  let sessionManager: SessionManager
  let tombstones: EnvelopeTombstones

  beforeEach(() => {
    const ctx = createTestApp()
    app = ctx.app
    sessionManager = ctx.sessionManager
    tombstones = ctx.tombstones
  })

  // ---- Accept (POST /rfqs/:id/accept) ----

  describe("POST /rfqs/:id/accept", () => {
    it("accepts valid accept and returns unsigned quote", async () => {
      const { rfq, offer } = await setupNegotiatingSession(app)
      const rev = getSessionRevision(sessionManager, rfq.rfq_id)
      const envelope = await makeAcceptEnvelope(rfq.rfq_id, rev, SELLER_A_DID, offer.offer_id as string)

      const res = await submitAccept(app, rfq.rfq_id, envelope)

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.quote_id).toBeDefined()
      expect(body.buyer).toBe(BUYER_DID)
      expect(body.seller).toBe(SELLER_A_DID)
      expect(body.final_price).toBe(offer.price)
      expect(body.payment_endpoint).toBe("https://seller-a.example.com/pay")
      expect(body.buyer_signature).toBe("")
      expect(body.seller_signature).toBe("")
      expect(body.memo_policy).toBe("quote_id_required")
    })

    it("transitions session to COMMIT_PENDING", async () => {
      const { rfq, offer } = await setupNegotiatingSession(app)
      const rev = getSessionRevision(sessionManager, rfq.rfq_id)
      const envelope = await makeAcceptEnvelope(rfq.rfq_id, rev, SELLER_A_DID, offer.offer_id as string)

      await submitAccept(app, rfq.rfq_id, envelope)

      const session = sessionManager.getSession(rfq.rfq_id)
      expect(session!.state).toBe("COMMIT_PENDING")
      expect(session!.selectedSeller).toBe(SELLER_A_DID)
      expect(session!.unsignedQuote).not.toBeNull()
    })

    it("rejects accept with stale session_revision (CAS)", async () => {
      const { rfq, offer } = await setupNegotiatingSession(app)
      const envelope = await makeAcceptEnvelope(rfq.rfq_id, "stale-rev-id", SELLER_A_DID, offer.offer_id as string)

      const res = await submitAccept(app, rfq.rfq_id, envelope)

      expect(res.status).toBe(409)
      const body = await res.json()
      expect(body.error).toBe("stale_revision")
    })

    it("rejects accept from non-buyer", async () => {
      const { rfq, offer } = await setupNegotiatingSession(app)
      const rev = getSessionRevision(sessionManager, rfq.rfq_id)
      // Sign envelope with seller key instead of buyer
      const envelope = await makeAcceptEnvelope(rfq.rfq_id, rev, SELLER_A_DID, offer.offer_id as string, SELLER_A_KP)

      const res = await submitAccept(app, rfq.rfq_id, envelope)

      expect(res.status).toBe(401)
    })

    it("rejects accept for non-existent seller", async () => {
      const { rfq, offer } = await setupNegotiatingSession(app)
      const rev = getSessionRevision(sessionManager, rfq.rfq_id)
      const fakeSeller = "did:key:z6MkFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE"
      const envelope = await makeAcceptEnvelope(rfq.rfq_id, rev, fakeSeller, offer.offer_id as string)

      const res = await submitAccept(app, rfq.rfq_id, envelope)

      expect(res.status).toBe(404)
    })

    it("rejects accept when session is not NEGOTIATING", async () => {
      const rfq = await makeSignedRfq()
      await submitRfq(app, rfq) // Session is OPEN, not NEGOTIATING
      const rev = getSessionRevision(sessionManager, rfq.rfq_id)
      const envelope = await makeAcceptEnvelope(rfq.rfq_id, rev, SELLER_A_DID, "fake-offer-id")

      const res = await submitAccept(app, rfq.rfq_id, envelope)

      expect(res.status).toBe(409)
    })

    it("rejects duplicate envelope_id (replay protection)", async () => {
      const { rfq, offer } = await setupNegotiatingSession(app)
      const rev = getSessionRevision(sessionManager, rfq.rfq_id)
      const envelope = await makeAcceptEnvelope(rfq.rfq_id, rev, SELLER_A_DID, offer.offer_id as string)

      // First accept succeeds
      const res1 = await submitAccept(app, rfq.rfq_id, envelope)
      expect(res1.status).toBe(200)

      // Same envelope_id replayed → rejected
      const res2 = await submitAccept(app, rfq.rfq_id, envelope)
      expect(res2.status).toBe(409)
      const body2 = await res2.json()
      expect(body2.error).toBe("duplicate_control_envelope")
    })

    it("rejects accept with expired offer", async () => {
      const rfq = await makeSignedRfq()
      await submitRfq(app, rfq)
      // Offer with valid_until just barely in the future (1ms) — it'll expire by accept time
      // Actually, offers with past valid_until are rejected at submission.
      // Instead, submit a valid offer, then test that the accept route checks expiry.
      // We'll use a very short window and accept after it.
      const offer = await makeSignedOffer(rfq.rfq_id, SELLER_A_KP, {
        valid_until: new Date(Date.now() + 50).toISOString(), // expires in 50ms
      })
      await submitOffer(app, rfq.rfq_id, offer)

      // Wait for offer to expire
      await new Promise((r) => setTimeout(r, 100))

      const rev = getSessionRevision(sessionManager, rfq.rfq_id)
      const envelope = await makeAcceptEnvelope(rfq.rfq_id, rev, SELLER_A_DID, offer.offer_id as string)
      const res = await submitAccept(app, rfq.rfq_id, envelope)

      expect(res.status).toBe(422)
      const body = await res.json()
      expect(body.error).toBe("invalid_expiry")
    })
  })

  // ---- Buyer Sign (PUT /rfqs/:id/quote/sign) ----

  describe("PUT /rfqs/:id/quote/sign", () => {
    async function setupCommitPending(app: Hono<EngineEnv>, sm: SessionManager) {
      const { rfq, offer } = await setupNegotiatingSession(app)
      const rev = getSessionRevision(sm, rfq.rfq_id)
      const envelope = await makeAcceptEnvelope(rfq.rfq_id, rev, SELLER_A_DID, offer.offer_id as string)
      const acceptRes = await submitAccept(app, rfq.rfq_id, envelope)
      const quote = await acceptRes.json()
      return { rfq, offer, quote }
    }

    it("accepts valid buyer signature", async () => {
      const { rfq, quote } = await setupCommitPending(app, sessionManager)
      const buyerSig = await signQuoteAsBuyer(quote)

      const res = await submitQuoteSign(app, rfq.rfq_id, buyerSig)

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.buyer_signature).toBe(buyerSig)
      expect(body.seller_signature).toBe("")
    })

    it("stores buyerSignature in session via event", async () => {
      const { rfq, quote } = await setupCommitPending(app, sessionManager)
      const buyerSig = await signQuoteAsBuyer(quote)

      await submitQuoteSign(app, rfq.rfq_id, buyerSig)

      const session = sessionManager.getSession(rfq.rfq_id)
      expect(session!.buyerSignature).toBe(buyerSig)
      expect(session!.state).toBe("COMMIT_PENDING")
    })

    it("rejects invalid buyer signature", async () => {
      const { rfq } = await setupCommitPending(app, sessionManager)
      // Sign with seller key (wrong signer)
      const badSig = await signQuoteAsSeller(
        sessionManager.getSession(rfq.rfq_id)!.unsignedQuote!,
        SELLER_A_KP,
      )

      const res = await submitQuoteSign(app, rfq.rfq_id, badSig)

      expect(res.status).toBe(401)
      const body = await res.json()
      expect(body.error).toBe("invalid_buyer_signature")
    })

    it("rejects double sign", async () => {
      const { rfq, quote } = await setupCommitPending(app, sessionManager)
      const buyerSig = await signQuoteAsBuyer(quote)
      await submitQuoteSign(app, rfq.rfq_id, buyerSig)

      const res = await submitQuoteSign(app, rfq.rfq_id, buyerSig)

      expect(res.status).toBe(409)
      const body = await res.json()
      expect(body.error).toBe("already_signed")
    })

    it("rejects when session not in COMMIT_PENDING", async () => {
      const { rfq } = await setupNegotiatingSession(app) // NEGOTIATING, not COMMIT_PENDING
      // Create a properly formatted (but wrong) signature so pre-check passes
      const dummySig = await signQuoteAsBuyer({ dummy: "not-a-real-quote" })

      const res = await submitQuoteSign(app, rfq.rfq_id, dummySig)

      // Should fail at state guard (409) not pre-check (400)
      expect(res.status).toBe(409)
    })
  })

  // ---- Seller Cosign (PUT /rfqs/:id/cosign) ----

  describe("PUT /rfqs/:id/cosign", () => {
    async function setupBuyerSigned(app: Hono<EngineEnv>, sm: SessionManager) {
      const { rfq, offer } = await setupNegotiatingSession(app)
      const rev = getSessionRevision(sm, rfq.rfq_id)
      const envelope = await makeAcceptEnvelope(rfq.rfq_id, rev, SELLER_A_DID, offer.offer_id as string)
      const acceptRes = await submitAccept(app, rfq.rfq_id, envelope)
      const quote = await acceptRes.json()
      const buyerSig = await signQuoteAsBuyer(quote)
      await submitQuoteSign(app, rfq.rfq_id, buyerSig)
      return { rfq, offer, quote }
    }

    it("accepts valid seller cosign and transitions to COMMITTED", async () => {
      const { rfq, quote } = await setupBuyerSigned(app, sessionManager)
      const sellerSig = await signQuoteAsSeller(quote, SELLER_A_KP)

      const res = await submitCosign(app, rfq.rfq_id, sellerSig)

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.seller_signature).toBe(sellerSig)
      expect(body.buyer_signature).not.toBe("")

      const session = sessionManager.getSession(rfq.rfq_id)
      expect(session!.state).toBe("COMMITTED")
    })

    it("rejects cosign from non-selected seller", async () => {
      const { rfq, quote } = await setupBuyerSigned(app, sessionManager)
      // Seller B tries to cosign (not selected)
      const badSig = await signQuoteAsSeller(quote, SELLER_B_KP)

      const res = await submitCosign(app, rfq.rfq_id, badSig)

      expect(res.status).toBe(401)
      const body = await res.json()
      expect(body.error).toBe("invalid_seller_signature")
    })

    it("rejects cosign when buyer hasn't signed", async () => {
      const { rfq, offer } = await setupNegotiatingSession(app)
      const rev = getSessionRevision(sessionManager, rfq.rfq_id)
      const envelope = await makeAcceptEnvelope(rfq.rfq_id, rev, SELLER_A_DID, offer.offer_id as string)
      await submitAccept(app, rfq.rfq_id, envelope) // COMMIT_PENDING but no buyer sig

      // Use a properly formatted signature so pre-check passes
      const dummySig = await signQuoteAsSeller({ dummy: "not-a-real-quote" }, SELLER_A_KP)
      const res = await submitCosign(app, rfq.rfq_id, dummySig)

      expect(res.status).toBe(409)
      const body = await res.json()
      expect(body.error).toBe("buyer_not_signed")
    })
  })

  // ---- Full Flow: Accept → Sign → Cosign → COMMITTED ----

  describe("Full 18-step flow", () => {
    it("completes end-to-end: accept → sign → cosign → COMMITTED", async () => {
      const { rfq, offer } = await setupNegotiatingSession(app)

      // Step 1-7: Accept
      const rev = getSessionRevision(sessionManager, rfq.rfq_id)
      const envelope = await makeAcceptEnvelope(rfq.rfq_id, rev, SELLER_A_DID, offer.offer_id as string)
      const acceptRes = await submitAccept(app, rfq.rfq_id, envelope)
      expect(acceptRes.status).toBe(200)
      const quote = await acceptRes.json()

      // Step 8-10: Buyer signs
      const buyerSig = await signQuoteAsBuyer(quote)
      const signRes = await submitQuoteSign(app, rfq.rfq_id, buyerSig)
      expect(signRes.status).toBe(200)

      // Step 11-18: Seller cosigns
      const sellerSig = await signQuoteAsSeller(quote, SELLER_A_KP)
      const cosignRes = await submitCosign(app, rfq.rfq_id, sellerSig)
      expect(cosignRes.status).toBe(200)

      // Verify final state
      const session = sessionManager.getSession(rfq.rfq_id)
      expect(session!.state).toBe("COMMITTED")
      expect(session!.buyerSignature).toBe(buyerSig)
      expect(session!.sellerSignature).toBe(sellerSig)
      expect(session!.unsignedQuote).not.toBeNull()
    })
  })

  // ---- Decline Flow ----

  describe("PUT /rfqs/:id/decline", () => {
    it("seller declines → session reverts to NEGOTIATING", async () => {
      const { rfq, offer } = await setupNegotiatingSession(app)
      const rev = getSessionRevision(sessionManager, rfq.rfq_id)
      const acceptEnv = await makeAcceptEnvelope(rfq.rfq_id, rev, SELLER_A_DID, offer.offer_id as string)
      await submitAccept(app, rfq.rfq_id, acceptEnv)

      // Seller declines
      const declineRev = getSessionRevision(sessionManager, rfq.rfq_id)
      const declineEnv = await makeDeclineEnvelope(rfq.rfq_id, declineRev, SELLER_A_KP)
      const res = await submitDecline(app, rfq.rfq_id, declineEnv)

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.state).toBe("NEGOTIATING")

      // Verify quote state cleared
      const session = sessionManager.getSession(rfq.rfq_id)
      expect(session!.state).toBe("NEGOTIATING")
      expect(session!.selectedSeller).toBeNull()
      expect(session!.unsignedQuote).toBeNull()
      expect(session!.buyerSignature).toBeNull()
      expect(session!.sellerSignature).toBeNull()
    })

    it("decline then re-accept different seller works", async () => {
      // Setup: both sellers have offers
      const rfq = await makeSignedRfq()
      await submitRfq(app, rfq)
      const offerA = await makeSignedOffer(rfq.rfq_id, SELLER_A_KP)
      await submitOffer(app, rfq.rfq_id, offerA)
      const offerB = await makeSignedOffer(rfq.rfq_id, SELLER_B_KP)
      await submitOffer(app, rfq.rfq_id, offerB)

      // Accept seller A
      let rev = getSessionRevision(sessionManager, rfq.rfq_id)
      const acceptA = await makeAcceptEnvelope(rfq.rfq_id, rev, SELLER_A_DID, offerA.offer_id as string)
      await submitAccept(app, rfq.rfq_id, acceptA)

      // Decline seller A
      rev = getSessionRevision(sessionManager, rfq.rfq_id)
      const decline = await makeDeclineEnvelope(rfq.rfq_id, rev, SELLER_A_KP)
      await submitDecline(app, rfq.rfq_id, decline)

      // Now accept seller B
      rev = getSessionRevision(sessionManager, rfq.rfq_id)
      const acceptB = await makeAcceptEnvelope(rfq.rfq_id, rev, SELLER_B_DID, offerB.offer_id as string)
      const res = await submitAccept(app, rfq.rfq_id, acceptB)

      expect(res.status).toBe(200)
      const quote = await res.json()
      expect(quote.seller).toBe(SELLER_B_DID)
      expect(quote.payment_endpoint).toBe("https://seller-b.example.com/pay")
    })

    it("non-selected seller cannot decline", async () => {
      const { rfq, offer } = await setupNegotiatingSession(app)
      const rev = getSessionRevision(sessionManager, rfq.rfq_id)
      const acceptEnv = await makeAcceptEnvelope(rfq.rfq_id, rev, SELLER_A_DID, offer.offer_id as string)
      await submitAccept(app, rfq.rfq_id, acceptEnv)

      // Seller B tries to decline (not the selected seller)
      const declineRev = getSessionRevision(sessionManager, rfq.rfq_id)
      const declineEnv = await makeDeclineEnvelope(rfq.rfq_id, declineRev, SELLER_B_KP)
      const res = await submitDecline(app, rfq.rfq_id, declineEnv)

      expect(res.status).toBe(401)
    })

    it("rejects decline with stale session_revision (CAS)", async () => {
      const { rfq, offer } = await setupNegotiatingSession(app)
      const rev = getSessionRevision(sessionManager, rfq.rfq_id)
      const acceptEnv = await makeAcceptEnvelope(rfq.rfq_id, rev, SELLER_A_DID, offer.offer_id as string)
      const acceptRes = await submitAccept(app, rfq.rfq_id, acceptEnv)
      const quote = await acceptRes.json()

      // Buyer signs (changes session revision)
      const buyerSig = await signQuoteAsBuyer(quote)
      await submitQuoteSign(app, rfq.rfq_id, buyerSig)

      // Seller's decline uses the PRE-sign revision (stale)
      const staleRev = getSessionRevision(sessionManager, rfq.rfq_id)
      // Actually we need the revision BEFORE the sign — use the accept revision
      const declineEnv = await makeDeclineEnvelope(rfq.rfq_id, rev, SELLER_A_KP)
      // This should fail because rev is now stale (sign added an event)
      const res = await submitDecline(app, rfq.rfq_id, declineEnv)

      expect(res.status).toBe(409)
    })
  })

  // ---- Quote Read (GET /rfqs/:id/quote) ----

  describe("GET /rfqs/:id/quote", () => {
    it("returns unsigned quote after accept", async () => {
      const { rfq, offer } = await setupNegotiatingSession(app)
      const rev = getSessionRevision(sessionManager, rfq.rfq_id)
      const envelope = await makeAcceptEnvelope(rfq.rfq_id, rev, SELLER_A_DID, offer.offer_id as string)
      await submitAccept(app, rfq.rfq_id, envelope)

      const res = await getQuote(app, rfq.rfq_id)

      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.buyer_signature).toBe("")
      expect(body.seller_signature).toBe("")
    })

    it("returns 404 when session is NEGOTIATING (no quote)", async () => {
      const { rfq } = await setupNegotiatingSession(app)

      const res = await getQuote(app, rfq.rfq_id)

      expect(res.status).toBe(404)
    })
  })

  // ---- Payment Endpoint Provenance ----

  describe("payment_endpoint provenance", () => {
    it("quote payment_endpoint comes from listing, not offer body", async () => {
      const { rfq, offer } = await setupNegotiatingSession(app)
      const rev = getSessionRevision(sessionManager, rfq.rfq_id)
      const envelope = await makeAcceptEnvelope(rfq.rfq_id, rev, SELLER_A_DID, offer.offer_id as string)

      const res = await submitAccept(app, rfq.rfq_id, envelope)
      const quote = await res.json()

      // payment_endpoint should be from listing (registered in createTestApp),
      // not from any field in the offer body
      expect(quote.payment_endpoint).toBe("https://seller-a.example.com/pay")
    })
  })

  // ---- Reducer Quote State ----

  describe("reducer quote state", () => {
    it("unsignedQuote is set after WINNER_SELECTED", async () => {
      const { rfq, offer } = await setupNegotiatingSession(app)
      const rev = getSessionRevision(sessionManager, rfq.rfq_id)
      const envelope = await makeAcceptEnvelope(rfq.rfq_id, rev, SELLER_A_DID, offer.offer_id as string)
      await submitAccept(app, rfq.rfq_id, envelope)

      const session = sessionManager.getSession(rfq.rfq_id)
      expect(session!.unsignedQuote).not.toBeNull()
      expect((session!.unsignedQuote as any).quote_id).toBeDefined()
      expect((session!.unsignedQuote as any).nonce).toMatch(/^0x[0-9a-f]{64}$/)
    })

    it("quote state cleared after decline", async () => {
      const { rfq, offer } = await setupNegotiatingSession(app)
      const rev = getSessionRevision(sessionManager, rfq.rfq_id)
      const acceptEnv = await makeAcceptEnvelope(rfq.rfq_id, rev, SELLER_A_DID, offer.offer_id as string)
      const acceptRes = await submitAccept(app, rfq.rfq_id, acceptEnv)
      const quote = await acceptRes.json()

      // Buyer signs
      const buyerSig = await signQuoteAsBuyer(quote)
      await submitQuoteSign(app, rfq.rfq_id, buyerSig)

      // Then seller declines
      const decRev = getSessionRevision(sessionManager, rfq.rfq_id)
      const declineEnv = await makeDeclineEnvelope(rfq.rfq_id, decRev, SELLER_A_KP)
      await submitDecline(app, rfq.rfq_id, declineEnv)

      const session = sessionManager.getSession(rfq.rfq_id)
      expect(session!.unsignedQuote).toBeNull()
      expect(session!.buyerSignature).toBeNull()
      expect(session!.sellerSignature).toBeNull()
      expect(session!.selectedSeller).toBeNull()
    })

    it("quoteRevision increments on each accept", async () => {
      const rfq = await makeSignedRfq()
      await submitRfq(app, rfq)
      const offerA = await makeSignedOffer(rfq.rfq_id, SELLER_A_KP)
      await submitOffer(app, rfq.rfq_id, offerA)

      // First accept
      let rev = getSessionRevision(sessionManager, rfq.rfq_id)
      const accept1 = await makeAcceptEnvelope(rfq.rfq_id, rev, SELLER_A_DID, offerA.offer_id as string)
      await submitAccept(app, rfq.rfq_id, accept1)
      expect(sessionManager.getSession(rfq.rfq_id)!.quoteRevision).toBe(1)

      // Decline
      rev = getSessionRevision(sessionManager, rfq.rfq_id)
      const decline = await makeDeclineEnvelope(rfq.rfq_id, rev, SELLER_A_KP)
      await submitDecline(app, rfq.rfq_id, decline)

      // Second accept
      rev = getSessionRevision(sessionManager, rfq.rfq_id)
      const accept2 = await makeAcceptEnvelope(rfq.rfq_id, rev, SELLER_A_DID, offerA.offer_id as string)
      await submitAccept(app, rfq.rfq_id, accept2)
      expect(sessionManager.getSession(rfq.rfq_id)!.quoteRevision).toBe(2)
    })
  })

  // ---- Deadline & Expiry Edge Cases (Gemini missing tests) ----

  describe("deadline and expiry enforcement", () => {
    it("rejects accept when RFQ deadline has passed", async () => {
      const rfq = await makeSignedRfq({
        deadline: new Date(Date.now() + 100).toISOString(), // expires in 100ms
      })
      await submitRfq(app, rfq)
      const offer = await makeSignedOffer(rfq.rfq_id, SELLER_A_KP)
      await submitOffer(app, rfq.rfq_id, offer)

      await new Promise((r) => setTimeout(r, 150)) // wait for deadline

      const rev = getSessionRevision(sessionManager, rfq.rfq_id)
      const envelope = await makeAcceptEnvelope(rfq.rfq_id, rev, SELLER_A_DID, offer.offer_id as string)
      const res = await submitAccept(app, rfq.rfq_id, envelope)

      expect(res.status).toBe(409)
    })

    it("rejects cosign after COMMITTED (double cosign)", async () => {
      const { rfq, offer } = await setupNegotiatingSession(app)
      const rev = getSessionRevision(sessionManager, rfq.rfq_id)
      const envelope = await makeAcceptEnvelope(rfq.rfq_id, rev, SELLER_A_DID, offer.offer_id as string)
      const acceptRes = await submitAccept(app, rfq.rfq_id, envelope)
      const quote = await acceptRes.json()

      // Complete the full flow
      const buyerSig = await signQuoteAsBuyer(quote)
      await submitQuoteSign(app, rfq.rfq_id, buyerSig)
      const sellerSig = await signQuoteAsSeller(quote, SELLER_A_KP)
      await submitCosign(app, rfq.rfq_id, sellerSig)

      // Try to cosign again — should fail (state is COMMITTED, not COMMIT_PENDING)
      const res2 = await submitCosign(app, rfq.rfq_id, sellerSig)
      expect(res2.status).toBe(409)
    })
  })

  // ---- Accept Limits (anti-griefing) ----

  describe("accept limits", () => {
    it("enforces per-seller accept limit (max 2)", async () => {
      const rfq = await makeSignedRfq()
      await submitRfq(app, rfq)
      const offer = await makeSignedOffer(rfq.rfq_id, SELLER_A_KP)
      await submitOffer(app, rfq.rfq_id, offer)

      // Accept #1
      let rev = getSessionRevision(sessionManager, rfq.rfq_id)
      let env = await makeAcceptEnvelope(rfq.rfq_id, rev, SELLER_A_DID, offer.offer_id as string)
      await submitAccept(app, rfq.rfq_id, env)

      // Decline #1
      rev = getSessionRevision(sessionManager, rfq.rfq_id)
      let dec = await makeDeclineEnvelope(rfq.rfq_id, rev, SELLER_A_KP)
      await submitDecline(app, rfq.rfq_id, dec)

      // Accept #2
      rev = getSessionRevision(sessionManager, rfq.rfq_id)
      env = await makeAcceptEnvelope(rfq.rfq_id, rev, SELLER_A_DID, offer.offer_id as string)
      await submitAccept(app, rfq.rfq_id, env)

      // Decline #2
      rev = getSessionRevision(sessionManager, rfq.rfq_id)
      dec = await makeDeclineEnvelope(rfq.rfq_id, rev, SELLER_A_KP)
      await submitDecline(app, rfq.rfq_id, dec)

      // Accept #3 — should fail (max 2 per seller)
      rev = getSessionRevision(sessionManager, rfq.rfq_id)
      env = await makeAcceptEnvelope(rfq.rfq_id, rev, SELLER_A_DID, offer.offer_id as string)
      const res = await submitAccept(app, rfq.rfq_id, env)

      expect(res.status).toBe(422)
      const body = await res.json()
      expect(body.error).toBe("accept_limit_exceeded")
    })
  })
})
