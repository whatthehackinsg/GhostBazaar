/**
 * Step 11b: E2E Integration Tests
 *
 * 10 end-to-end scenarios testing the full engine through HTTP routes.
 * Covers the complete negotiation lifecycle: RFQ → offer → accept → sign →
 * cosign → COMMITTED, plus multi-seller, counter-offers, decline/re-accept,
 * deadline expiry, cosign timeout, SSE events, replay consistency, privacy,
 * and cancellation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
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
import { createEventsRoute } from "../src/routes/events.js"
import { InMemoryEventStore } from "../src/state/event-store.js"
import { SessionManager } from "../src/state/session-manager.js"
import { ListingStore } from "../src/registry/listing-store.js"
import { EnvelopeTombstones } from "../src/security/control-envelope.js"
import { ConnectionTracker } from "../src/util/connection-tracker.js"
import { DeadlineEnforcer } from "../src/deadline-enforcer.js"
import { deriveState } from "../src/state/session.js"
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
// Signing helpers — mirrors quote-flow.test.ts patterns exactly
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

async function makeSignedCounter(
  rfqId: string,
  to: string,
  round: number,
  overrides: Record<string, unknown> = {},
) {
  const counter: Record<string, unknown> = {
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
  counter.signature = await signEd25519(payload, BUYER_KP)
  return counter
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

async function signQuoteAsBuyer(quote: Record<string, unknown>): Promise<string> {
  const obj: Record<string, unknown> = { ...quote, buyer_signature: "", seller_signature: "" }
  const bytes = canonicalJson(obj)
  return signEd25519(bytes, BUYER_KP)
}

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

async function submitCounter(app: Hono<EngineEnv>, rfqId: string, counter: Record<string, unknown>) {
  return app.request(`/rfqs/${rfqId}/counter`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(counter),
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

async function getEvents(app: Hono<EngineEnv>, rfqId: string) {
  return app.request(`/rfqs/${rfqId}/events`, {
    headers: { Accept: "application/json" },
  })
}

// ---------------------------------------------------------------------------
// SSE helpers
// ---------------------------------------------------------------------------

async function readSSEFrames(
  res: Response,
  maxFrames: number = 20,
  timeoutMs: number = 500,
): Promise<string[]> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  const frames: string[] = []

  const timeout = new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))
  let done = false

  const readLoop = async () => {
    while (!done && frames.length < maxFrames) {
      const result = await reader.read()
      if (result.done) {
        done = true
        break
      }
      const text = decoder.decode(result.value, { stream: true })
      frames.push(text)
    }
  }

  await Promise.race([readLoop(), timeout])
  if (!done) {
    try { reader.cancel() } catch { /* ignore */ }
  }
  return frames
}

// ---------------------------------------------------------------------------
// App factory — mounts ALL routes for full integration testing
// ---------------------------------------------------------------------------

function createTestApp(
  authenticateCaller: (req: Request) => Promise<string> = async () => BUYER_DID,
) {
  const store = new InMemoryEventStore()
  const sessionManager = new SessionManager(store)
  const listingStore = new ListingStore()
  const tombstones = new EnvelopeTombstones()
  const connectionTracker = new ConnectionTracker()
  const noopVerifier = async () => true

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
  app.route("/", createCounterRoute({ sessionManager, verifyBudgetProof: noopVerifier }))
  app.route("/", createAcceptRoute({ sessionManager, tombstones }))
  app.route("/", createQuoteSignRoute({ sessionManager }))
  app.route(
    "/",
    createQuoteReadRoute({
      sessionManager,
      authenticateCaller,
    }),
  )
  app.route("/", createCosignRoute({ sessionManager }))
  app.route("/", createDeclineRoute({ sessionManager, tombstones }))
  app.route(
    "/",
    createEventsRoute({
      sessionManager,
      eventStore: store,
      connectionTracker,
      authenticateCaller,
    }),
  )

  return { app, store, sessionManager, listingStore, tombstones, connectionTracker }
}

function getSessionRevision(sessionManager: SessionManager, rfqId: string): string {
  const session = sessionManager.getSession(rfqId)
  return session!.lastEventId
}

// ---------------------------------------------------------------------------
// PRIVATE_FIELDS — must never leak through any HTTP response
// ---------------------------------------------------------------------------

const PRIVATE_FIELDS = ["budget_hard", "budget_soft", "floor_price", "target_price"]

// ===========================================================================
// E2E Integration Tests
// ===========================================================================

describe("E2E Integration Tests", () => {
  // -------------------------------------------------------------------------
  // E2E-1: Happy path — RFQ → offer → accept → sign → cosign → COMMITTED
  // -------------------------------------------------------------------------

  describe("E2E-1: Happy path — full lifecycle to COMMITTED", () => {
    let app: Hono<EngineEnv>
    let sessionManager: SessionManager

    beforeEach(() => {
      const ctx = createTestApp()
      app = ctx.app
      sessionManager = ctx.sessionManager
    })

    it("completes RFQ → offer → accept → sign → cosign → COMMITTED", async () => {
      // Step 1: POST /rfqs → 201
      const rfq = await makeSignedRfq()
      const rfqRes = await submitRfq(app, rfq)
      expect(rfqRes.status).toBe(201)

      // Step 2: POST /rfqs/:id/offers (seller A) → 201
      const offer = await makeSignedOffer(rfq.rfq_id as string, SELLER_A_KP)
      const offerRes = await submitOffer(app, rfq.rfq_id as string, offer)
      expect(offerRes.status).toBe(201)

      // Step 3: POST /rfqs/:id/accept → 200, get unsigned quote
      const rev = getSessionRevision(sessionManager, rfq.rfq_id as string)
      const acceptEnv = await makeAcceptEnvelope(
        rfq.rfq_id as string,
        rev,
        SELLER_A_DID,
        offer.offer_id as string,
      )
      const acceptRes = await submitAccept(app, rfq.rfq_id as string, acceptEnv)
      expect(acceptRes.status).toBe(200)
      const quote = await acceptRes.json()
      expect(quote.buyer_signature).toBe("")
      expect(quote.seller_signature).toBe("")

      // Step 4: PUT /rfqs/:id/quote/sign → 200
      const buyerSig = await signQuoteAsBuyer(quote)
      const signRes = await submitQuoteSign(app, rfq.rfq_id as string, buyerSig)
      expect(signRes.status).toBe(200)

      // Step 5: PUT /rfqs/:id/cosign → 200
      const sellerSig = await signQuoteAsSeller(quote, SELLER_A_KP)
      const cosignRes = await submitCosign(app, rfq.rfq_id as string, sellerSig)
      expect(cosignRes.status).toBe(200)

      // Assert: session state === COMMITTED
      const session = sessionManager.getSession(rfq.rfq_id as string)
      expect(session!.state).toBe("COMMITTED")
      expect(session!.buyerSignature).toBe(buyerSig)
      expect(session!.sellerSignature).toBe(sellerSig)
    })
  })

  // -------------------------------------------------------------------------
  // E2E-2: Multi-seller — 2 sellers, buyer picks cheapest
  // -------------------------------------------------------------------------

  describe("E2E-2: Multi-seller — buyer picks cheapest", () => {
    let app: Hono<EngineEnv>
    let sessionManager: SessionManager

    beforeEach(() => {
      const ctx = createTestApp()
      app = ctx.app
      sessionManager = ctx.sessionManager
    })

    it("accepts cheapest seller offer and commits at that price", async () => {
      // POST /rfqs → 201
      const rfq = await makeSignedRfq()
      const rfqRes = await submitRfq(app, rfq)
      expect(rfqRes.status).toBe(201)

      // Offers from seller A ($35) and seller B ($28.50)
      const offerA = await makeSignedOffer(rfq.rfq_id as string, SELLER_A_KP, { price: "35.00" })
      const offerARes = await submitOffer(app, rfq.rfq_id as string, offerA)
      expect(offerARes.status).toBe(201)

      const offerB = await makeSignedOffer(rfq.rfq_id as string, SELLER_B_KP, { price: "28.50" })
      const offerBRes = await submitOffer(app, rfq.rfq_id as string, offerB)
      expect(offerBRes.status).toBe(201)

      // Accept seller B (cheapest) → sign → cosign → COMMITTED
      const rev = getSessionRevision(sessionManager, rfq.rfq_id as string)
      const acceptEnv = await makeAcceptEnvelope(
        rfq.rfq_id as string,
        rev,
        SELLER_B_DID,
        offerB.offer_id as string,
      )
      const acceptRes = await submitAccept(app, rfq.rfq_id as string, acceptEnv)
      expect(acceptRes.status).toBe(200)
      const quote = await acceptRes.json()

      const buyerSig = await signQuoteAsBuyer(quote)
      await submitQuoteSign(app, rfq.rfq_id as string, buyerSig)

      const sellerSig = await signQuoteAsSeller(quote, SELLER_B_KP)
      await submitCosign(app, rfq.rfq_id as string, sellerSig)

      // Assert: final_price === "28.50"
      const session = sessionManager.getSession(rfq.rfq_id as string)
      expect(session!.state).toBe("COMMITTED")
      expect(quote.final_price).toBe("28.50")
      expect(quote.seller).toBe(SELLER_B_DID)
    })
  })

  // -------------------------------------------------------------------------
  // E2E-3: Counter-offer flow
  // -------------------------------------------------------------------------

  describe("E2E-3: Counter-offer flow", () => {
    let app: Hono<EngineEnv>
    let sessionManager: SessionManager

    beforeEach(() => {
      const ctx = createTestApp()
      app = ctx.app
      sessionManager = ctx.sessionManager
    })

    it("RFQ → offer ($35) → counter ($30) → revised offer ($31) → accept → sign → cosign → COMMITTED", async () => {
      // POST /rfqs
      const rfq = await makeSignedRfq()
      await submitRfq(app, rfq)

      // Seller A offers $35
      const offer1 = await makeSignedOffer(rfq.rfq_id as string, SELLER_A_KP, { price: "35.00" })
      await submitOffer(app, rfq.rfq_id as string, offer1)

      // Buyer counters $30
      const counter = await makeSignedCounter(
        rfq.rfq_id as string,
        SELLER_A_DID,
        1,
        { price: "30.00" },
      )
      const counterRes = await submitCounter(app, rfq.rfq_id as string, counter)
      expect(counterRes.status).toBe(201)

      // Seller A revises to $31
      const offer2 = await makeSignedOffer(rfq.rfq_id as string, SELLER_A_KP, { price: "31.00" })
      await submitOffer(app, rfq.rfq_id as string, offer2)

      // Buyer accepts the revised offer
      const rev = getSessionRevision(sessionManager, rfq.rfq_id as string)
      const acceptEnv = await makeAcceptEnvelope(
        rfq.rfq_id as string,
        rev,
        SELLER_A_DID,
        offer2.offer_id as string,
      )
      const acceptRes = await submitAccept(app, rfq.rfq_id as string, acceptEnv)
      expect(acceptRes.status).toBe(200)
      const quote = await acceptRes.json()

      // Sign → cosign → COMMITTED
      const buyerSig = await signQuoteAsBuyer(quote)
      await submitQuoteSign(app, rfq.rfq_id as string, buyerSig)

      const sellerSig = await signQuoteAsSeller(quote, SELLER_A_KP)
      await submitCosign(app, rfq.rfq_id as string, sellerSig)

      const session = sessionManager.getSession(rfq.rfq_id as string)
      expect(session!.state).toBe("COMMITTED")
      expect(quote.final_price).toBe("31.00")
    })
  })

  // -------------------------------------------------------------------------
  // E2E-4: Decline + re-accept
  // -------------------------------------------------------------------------

  describe("E2E-4: Decline + re-accept different seller", () => {
    let app: Hono<EngineEnv>
    let sessionManager: SessionManager

    beforeEach(() => {
      const ctx = createTestApp()
      app = ctx.app
      sessionManager = ctx.sessionManager
    })

    it("accept A → sign → decline A → NEGOTIATING → accept B → sign → cosign → COMMITTED", async () => {
      // Setup: RFQ + offers from both sellers
      const rfq = await makeSignedRfq()
      await submitRfq(app, rfq)

      const offerA = await makeSignedOffer(rfq.rfq_id as string, SELLER_A_KP, { price: "35.00" })
      await submitOffer(app, rfq.rfq_id as string, offerA)

      const offerB = await makeSignedOffer(rfq.rfq_id as string, SELLER_B_KP, { price: "28.50" })
      await submitOffer(app, rfq.rfq_id as string, offerB)

      // Accept seller A
      let rev = getSessionRevision(sessionManager, rfq.rfq_id as string)
      const acceptA = await makeAcceptEnvelope(
        rfq.rfq_id as string,
        rev,
        SELLER_A_DID,
        offerA.offer_id as string,
      )
      const acceptARes = await submitAccept(app, rfq.rfq_id as string, acceptA)
      expect(acceptARes.status).toBe(200)
      const quoteA = await acceptARes.json()

      // Buyer signs quote for seller A
      const buyerSigA = await signQuoteAsBuyer(quoteA)
      await submitQuoteSign(app, rfq.rfq_id as string, buyerSigA)

      // Seller A declines (COMMIT_PENDING → NEGOTIATING)
      rev = getSessionRevision(sessionManager, rfq.rfq_id as string)
      const declineEnv = await makeDeclineEnvelope(rfq.rfq_id as string, rev, SELLER_A_KP)
      const declineRes = await submitDecline(app, rfq.rfq_id as string, declineEnv)
      expect(declineRes.status).toBe(200)

      const midSession = sessionManager.getSession(rfq.rfq_id as string)
      expect(midSession!.state).toBe("NEGOTIATING")

      // Now accept seller B
      rev = getSessionRevision(sessionManager, rfq.rfq_id as string)
      const acceptB = await makeAcceptEnvelope(
        rfq.rfq_id as string,
        rev,
        SELLER_B_DID,
        offerB.offer_id as string,
      )
      const acceptBRes = await submitAccept(app, rfq.rfq_id as string, acceptB)
      expect(acceptBRes.status).toBe(200)
      const quoteB = await acceptBRes.json()

      // Sign → cosign → COMMITTED
      const buyerSigB = await signQuoteAsBuyer(quoteB)
      await submitQuoteSign(app, rfq.rfq_id as string, buyerSigB)

      const sellerSigB = await signQuoteAsSeller(quoteB, SELLER_B_KP)
      await submitCosign(app, rfq.rfq_id as string, sellerSigB)

      const finalSession = sessionManager.getSession(rfq.rfq_id as string)
      expect(finalSession!.state).toBe("COMMITTED")
      expect(finalSession!.selectedSeller).toBe(SELLER_B_DID)
    })
  })

  // -------------------------------------------------------------------------
  // E2E-5: Deadline expiry (Step 10 E2E)
  // -------------------------------------------------------------------------

  describe("E2E-5: Deadline expiry", () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it("expires session after RFQ deadline passes", async () => {
      // Use real timers for HTTP operations, then switch to fake for enforcement
      vi.useRealTimers()
      const ctx = createTestApp()
      const { app, store, sessionManager, connectionTracker } = ctx

      // POST /rfqs with short deadline (500ms from now to survive RFQ submission)
      const deadline = new Date(Date.now() + 500).toISOString()
      const rfq = await makeSignedRfq({ deadline })
      const rfqRes = await submitRfq(app, rfq)
      expect(rfqRes.status).toBe(201)

      // Switch to fake timers for deadline enforcement
      vi.useFakeTimers({ now: Date.now() })

      const enforcer = new DeadlineEnforcer({
        sessionManager,
        eventStore: store,
        connectionTracker,
        intervalMs: 500,
        cosignTimeoutMs: 60_000,
      })
      enforcer.start()

      // Advance time past the deadline
      await vi.advanceTimersByTimeAsync(1_500)

      enforcer.stop()

      // Assert: state === EXPIRED
      const session = sessionManager.getSession(rfq.rfq_id as string)
      expect(session!.state).toBe("EXPIRED")
    })
  })

  // -------------------------------------------------------------------------
  // E2E-6: Cosign timeout (Step 10 E2E)
  // -------------------------------------------------------------------------

  describe("E2E-6: Cosign timeout", () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it("rolls back COMMIT_PENDING → NEGOTIATING after cosign timeout", async () => {
      // Use real timers for HTTP operations
      vi.useRealTimers()
      const ctx = createTestApp()
      const { app, store, sessionManager, connectionTracker } = ctx

      // POST /rfqs → offer → accept → sign → COMMIT_PENDING
      const rfq = await makeSignedRfq()
      await submitRfq(app, rfq)

      const offer = await makeSignedOffer(rfq.rfq_id as string, SELLER_A_KP)
      await submitOffer(app, rfq.rfq_id as string, offer)

      const rev = getSessionRevision(sessionManager, rfq.rfq_id as string)
      const acceptEnv = await makeAcceptEnvelope(
        rfq.rfq_id as string,
        rev,
        SELLER_A_DID,
        offer.offer_id as string,
      )
      const acceptRes = await submitAccept(app, rfq.rfq_id as string, acceptEnv)
      expect(acceptRes.status).toBe(200)
      const quote = await acceptRes.json()

      const buyerSig = await signQuoteAsBuyer(quote)
      await submitQuoteSign(app, rfq.rfq_id as string, buyerSig)

      // Verify we're in COMMIT_PENDING
      const midSession = sessionManager.getSession(rfq.rfq_id as string)
      expect(midSession!.state).toBe("COMMIT_PENDING")

      // Switch to fake timers for cosign timeout enforcement
      vi.useFakeTimers({ now: Date.now() })

      const enforcer = new DeadlineEnforcer({
        sessionManager,
        eventStore: store,
        connectionTracker,
        intervalMs: 500,
        cosignTimeoutMs: 15_000,  // minimum cosign timeout
      })
      enforcer.start()

      // Advance time past cosign timeout (15s + buffer)
      await vi.advanceTimersByTimeAsync(20_000)

      enforcer.stop()

      // Assert: state === NEGOTIATING (rolled back)
      const session = sessionManager.getSession(rfq.rfq_id as string)
      expect(session!.state).toBe("NEGOTIATING")
      expect(session!.selectedSeller).toBeNull()
      expect(session!.unsignedQuote).toBeNull()
    })
  })

  // -------------------------------------------------------------------------
  // E2E-7: SSE live event delivery (Step 9 E2E)
  // -------------------------------------------------------------------------

  describe("E2E-7: SSE live event delivery", () => {
    it("SSE stream contains RFQ_CREATED + OFFER_SUBMITTED events", async () => {
      const ctx = createTestApp()
      const { app } = ctx

      // POST /rfqs → get rfq_id
      const rfq = await makeSignedRfq()
      await submitRfq(app, rfq)

      // POST /rfqs/:id/offers → submit offer
      const offer = await makeSignedOffer(rfq.rfq_id as string, SELLER_A_KP)
      await submitOffer(app, rfq.rfq_id as string, offer)

      // GET /rfqs/:id/events with Accept: text/event-stream
      const res = await app.request(`/rfqs/${rfq.rfq_id}/events`, {
        headers: { Accept: "text/event-stream" },
      })

      expect(res.status).toBe(200)
      expect(res.headers.get("Content-Type")).toBe("text/event-stream")

      // Read and verify: stream contains RFQ_CREATED + OFFER_SUBMITTED events
      const frames = await readSSEFrames(res)
      const text = frames.join("")

      expect(text).toContain("RFQ_CREATED")
      expect(text).toContain("OFFER_SUBMITTED")
      expect(text).toContain("event: negotiation")
    })
  })

  // -------------------------------------------------------------------------
  // E2E-8: Event replay consistency
  // -------------------------------------------------------------------------

  describe("E2E-8: Event replay consistency", () => {
    let app: Hono<EngineEnv>
    let sessionManager: SessionManager

    beforeEach(() => {
      const ctx = createTestApp()
      app = ctx.app
      sessionManager = ctx.sessionManager
    })

    it("deriveState from replayed events matches session state after happy path", async () => {
      // Run happy path to COMMITTED
      const rfq = await makeSignedRfq()
      await submitRfq(app, rfq)

      const offer = await makeSignedOffer(rfq.rfq_id as string, SELLER_A_KP)
      await submitOffer(app, rfq.rfq_id as string, offer)

      const rev = getSessionRevision(sessionManager, rfq.rfq_id as string)
      const acceptEnv = await makeAcceptEnvelope(
        rfq.rfq_id as string,
        rev,
        SELLER_A_DID,
        offer.offer_id as string,
      )
      const acceptRes = await submitAccept(app, rfq.rfq_id as string, acceptEnv)
      const quote = await acceptRes.json()

      const buyerSig = await signQuoteAsBuyer(quote)
      await submitQuoteSign(app, rfq.rfq_id as string, buyerSig)

      const sellerSig = await signQuoteAsSeller(quote, SELLER_A_KP)
      await submitCosign(app, rfq.rfq_id as string, sellerSig)

      // GET /rfqs/:id/events (JSON mode) → all events
      const eventsRes = await getEvents(app, rfq.rfq_id as string)
      expect(eventsRes.status).toBe(200)
      const eventsBody = await eventsRes.json()

      // Feed events through deriveState()
      const derived = deriveState(eventsBody.events)

      // Assert: derived state matches session
      const session = sessionManager.getSession(rfq.rfq_id as string)
      expect(derived).not.toBeNull()
      expect(derived!.state).toBe(session!.state)
      expect(derived!.state).toBe("COMMITTED")
      expect(derived!.selectedSeller).toBe(session!.selectedSeller)
      expect(derived!.lastEventId).toBe(session!.lastEventId)
      expect(derived!.buyerSignature).toBe(session!.buyerSignature)
      expect(derived!.sellerSignature).toBe(session!.sellerSignature)
    })
  })

  // -------------------------------------------------------------------------
  // E2E-9: Privacy — no private fields leak
  // -------------------------------------------------------------------------

  describe("E2E-9: Privacy — no private fields leak in HTTP responses", () => {
    let app: Hono<EngineEnv>
    let sessionManager: SessionManager

    beforeEach(() => {
      const ctx = createTestApp()
      app = ctx.app
      sessionManager = ctx.sessionManager
    })

    it("no response body contains budget_hard, budget_soft, floor_price, or target_price", async () => {
      const responseTexts: string[] = []

      // RFQ
      const rfq = await makeSignedRfq()
      const rfqRes = await submitRfq(app, rfq)
      responseTexts.push(await rfqRes.text())

      // Offer from seller A
      const offer = await makeSignedOffer(rfq.rfq_id as string, SELLER_A_KP, { price: "35.00" })
      const offerRes = await submitOffer(app, rfq.rfq_id as string, offer)
      responseTexts.push(await offerRes.text())

      // Counter from buyer
      const counter = await makeSignedCounter(
        rfq.rfq_id as string,
        SELLER_A_DID,
        1,
        { price: "30.00" },
      )
      const counterRes = await submitCounter(app, rfq.rfq_id as string, counter)
      responseTexts.push(await counterRes.text())

      // Revised offer from seller A
      const offer2 = await makeSignedOffer(rfq.rfq_id as string, SELLER_A_KP, { price: "31.00" })
      const offer2Res = await submitOffer(app, rfq.rfq_id as string, offer2)
      responseTexts.push(await offer2Res.text())

      // Accept
      const rev = getSessionRevision(sessionManager, rfq.rfq_id as string)
      const acceptEnv = await makeAcceptEnvelope(
        rfq.rfq_id as string,
        rev,
        SELLER_A_DID,
        offer2.offer_id as string,
      )
      const acceptRes = await submitAccept(app, rfq.rfq_id as string, acceptEnv)
      responseTexts.push(await acceptRes.text())

      // Events (JSON mode)
      const eventsRes = await getEvents(app, rfq.rfq_id as string)
      responseTexts.push(await eventsRes.text())

      // Assert: no private fields in any response
      const allText = responseTexts.join("\n")
      for (const field of PRIVATE_FIELDS) {
        expect(allText).not.toContain(field)
      }
    })
  })

  // -------------------------------------------------------------------------
  // E2E-10: Cancellation
  // -------------------------------------------------------------------------

  describe("E2E-10: Cancellation", () => {
    let app: Hono<EngineEnv>
    let sessionManager: SessionManager

    beforeEach(() => {
      const ctx = createTestApp()
      app = ctx.app
      sessionManager = ctx.sessionManager
    })

    it("cancellation prevents further offers", async () => {
      // POST /rfqs → offer → NEGOTIATING
      const rfq = await makeSignedRfq()
      await submitRfq(app, rfq)

      const offer = await makeSignedOffer(rfq.rfq_id as string, SELLER_A_KP)
      await submitOffer(app, rfq.rfq_id as string, offer)

      expect(sessionManager.getSession(rfq.rfq_id as string)!.state).toBe("NEGOTIATING")

      // Append NEGOTIATION_CANCELLED via sessionManager.withLock + appendEvent
      await sessionManager.withLock(rfq.rfq_id as string, async () => {
        sessionManager.appendEvent(rfq.rfq_id as string, {
          event_id: crypto.randomUUID(),
          rfq_id: rfq.rfq_id as string,
          type: "NEGOTIATION_CANCELLED",
          timestamp: new Date().toISOString(),
          actor: BUYER_DID,
          payload: {
            rfq_id: rfq.rfq_id as string,
            reason: "buyer_cancelled",
          },
        })
      })

      // Assert: state === CANCELLED
      const session = sessionManager.getSession(rfq.rfq_id as string)
      expect(session!.state).toBe("CANCELLED")

      // Assert: subsequent POST /rfqs/:id/offers returns error
      const offer2 = await makeSignedOffer(rfq.rfq_id as string, SELLER_B_KP)
      const offerRes = await submitOffer(app, rfq.rfq_id as string, offer2)
      expect(offerRes.status).toBe(409)
    })
  })
})
