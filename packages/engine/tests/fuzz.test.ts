/**
 * Step 11c: Property-Based Fuzz Tests for State Machine
 *
 * Uses fast-check to generate random action sequences against the negotiation
 * engine, verifying 8 invariants hold after every action:
 *
 *   1. State is always valid
 *   2. Event replay produces identical derived state
 *   3. Event count matches store size
 *   4. No private fields leak into events (post-loop)
 *   5. Terminal states absorb — once terminal, stays terminal
 *   6. Quote fields only populated in COMMIT_PENDING/COMMITTED
 *   7. Signatures only populated in COMMIT_PENDING/COMMITTED
 *   8. Selected seller only populated in COMMIT_PENDING/COMMITTED
 *
 * The test creates 3 sellers, a buyer, and runs weighted random actions
 * (offer, counter, accept, sign, cosign, decline, cancel, expire, cosignTimeout)
 * against a fresh RFQ session per property run.
 */

import { describe, it, expect } from "vitest"
import * as fc from "fast-check"
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
import { createCosignRoute } from "../src/routes/cosign.js"
import { createDeclineRoute } from "../src/routes/decline.js"
import { InMemoryEventStore } from "../src/state/event-store.js"
import { SessionManager } from "../src/state/session-manager.js"
import { ListingStore } from "../src/registry/listing-store.js"
import { EnvelopeTombstones } from "../src/security/control-envelope.js"
import { deriveState } from "../src/state/session.js"
import type { EngineEnv } from "../src/app.js"

// ---------------------------------------------------------------------------
// Key pairs — buyer + 3 sellers
// ---------------------------------------------------------------------------

const BUYER_KP = Keypair.generate()
const BUYER_DID = buildDid(BUYER_KP.publicKey)

const SELLER_A_KP = Keypair.generate()
const SELLER_A_DID = buildDid(SELLER_A_KP.publicKey)
const SELLER_B_KP = Keypair.generate()
const SELLER_B_DID = buildDid(SELLER_B_KP.publicKey)
const SELLER_C_KP = Keypair.generate()
const SELLER_C_DID = buildDid(SELLER_C_KP.publicKey)

const SELLERS = [
  { kp: SELLER_A_KP, did: SELLER_A_DID },
  { kp: SELLER_B_KP, did: SELLER_B_DID },
  { kp: SELLER_C_KP, did: SELLER_C_DID },
]

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Price as decimal string — avoids IEEE 754 float traps. */
const priceArb = fc.tuple(
  fc.integer({ min: 1, max: 999 }),
  fc.integer({ min: 0, max: 99 }),
).map(([whole, frac]) => `${whole}.${String(frac).padStart(2, "0")}`)

// Action types for the fuzz

type OfferAction = { readonly type: "offer"; readonly seller: number; readonly price: string }
type CounterAction = { readonly type: "counter"; readonly seller: number; readonly price: string }
type AcceptAction = { readonly type: "accept"; readonly offerIdx: number }
type SignAction = { readonly type: "sign" }
type CosignAction = { readonly type: "cosign" }
type DeclineAction = { readonly type: "decline" }
type CancelAction = { readonly type: "cancel" }
type ExpireAction = { readonly type: "expire" }
type CosignTimeoutAction = { readonly type: "cosignTimeout" }

type FuzzAction =
  | OfferAction
  | CounterAction
  | AcceptAction
  | SignAction
  | CosignAction
  | DeclineAction
  | CancelAction
  | ExpireAction
  | CosignTimeoutAction

/** Weighted action distribution — offers most common, system events rare. */
const actionArb: fc.Arbitrary<FuzzAction> = fc.oneof(
  { weight: 5, arbitrary: fc.record({ type: fc.constant("offer" as const), seller: fc.integer({ min: 0, max: 2 }), price: priceArb }) },
  { weight: 3, arbitrary: fc.record({ type: fc.constant("counter" as const), seller: fc.integer({ min: 0, max: 2 }), price: priceArb }) },
  { weight: 2, arbitrary: fc.record({ type: fc.constant("accept" as const), offerIdx: fc.nat({ max: 10 }) }) },
  { weight: 2, arbitrary: fc.record({ type: fc.constant("sign" as const) }) },
  { weight: 2, arbitrary: fc.record({ type: fc.constant("cosign" as const) }) },
  { weight: 2, arbitrary: fc.record({ type: fc.constant("decline" as const) }) },
  { weight: 1, arbitrary: fc.record({ type: fc.constant("cancel" as const) }) },
  { weight: 1, arbitrary: fc.record({ type: fc.constant("expire" as const) }) },
  { weight: 1, arbitrary: fc.record({ type: fc.constant("cosignTimeout" as const) }) },
)

// ---------------------------------------------------------------------------
// Signing helpers — match patterns from quote-flow.test.ts exactly
// ---------------------------------------------------------------------------

async function makeSignedRfq() {
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
  }
  const payload = objectSigningPayload(rfq)
  rfq.signature = await signEd25519(payload, BUYER_KP)
  return rfq
}

async function makeSignedOffer(
  rfqId: string,
  sellerKp: Keypair,
  price: string,
) {
  const sellerDid = buildDid(sellerKp.publicKey)
  const sellerIndex = SELLERS.findIndex((entry) => entry.did === sellerDid)
  if (sellerIndex === -1) {
    throw new Error(`Unknown fuzz seller DID: ${sellerDid}`)
  }
  const offer: Record<string, unknown> = {
    offer_id: crypto.randomUUID(),
    rfq_id: rfqId,
    seller: sellerDid,
    listing_id: `listing-seller-${sellerIndex}`,
    price,
    currency: "USDC",
    valid_until: new Date(Date.now() + 60_000).toISOString(),
    signature: "",
  }
  const payload = objectSigningPayload(offer)
  offer.signature = await signEd25519(payload, sellerKp)
  return offer
}

async function makeSignedCounter(
  rfqId: string,
  to: string,
  price: string,
  round: number,
) {
  const counter: Record<string, unknown> = {
    counter_id: crypto.randomUUID(),
    rfq_id: rfqId,
    round,
    from: BUYER_DID,
    to,
    price,
    currency: "USDC",
    valid_until: new Date(Date.now() + 60_000).toISOString(),
    signature: "",
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
  envelope.signature = await signEd25519(sigPayload, BUYER_KP)
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

/** Sign a quote as buyer — quoteSigningPayload: buyer_signature="" + seller_signature="" */
async function signQuoteAsBuyer(quote: Record<string, unknown>): Promise<string> {
  const obj: Record<string, unknown> = { ...quote, buyer_signature: "", seller_signature: "" }
  const bytes = canonicalJson(obj)
  return signEd25519(bytes, BUYER_KP)
}

/** Sign a quote as seller — quoteSigningPayload: buyer_signature="" + seller_signature="" */
async function signQuoteAsSeller(
  quote: Record<string, unknown>,
  sellerKp: Keypair,
): Promise<string> {
  const obj: Record<string, unknown> = { ...quote, buyer_signature: "", seller_signature: "" }
  const bytes = canonicalJson(obj)
  return signEd25519(bytes, sellerKp)
}

// ---------------------------------------------------------------------------
// Test app factory
// ---------------------------------------------------------------------------

function createFuzzTestApp() {
  const store = new InMemoryEventStore()
  const sessionManager = new SessionManager(store)
  const listingStore = new ListingStore()
  const tombstones = new EnvelopeTombstones()

  // Register listings for all 3 sellers
  for (let i = 0; i < SELLERS.length; i++) {
    listingStore.add({
      listing_id: `listing-seller-${i}`,
      seller: SELLERS[i].did,
      title: `Seller ${i} Service`,
      category: "llm",
      service_type: "llm-inference",
      negotiation_endpoint: `https://seller-${i}.example.com/negotiate`,
      payment_endpoint: `https://seller-${i}.example.com/pay`,
      base_terms: {},
    })
  }

  const noopVerifier = async () => true
  const app = createApp() as Hono<EngineEnv>
  app.route("/", createRfqRoute(sessionManager))
  app.route("/", createOfferRoute({ sessionManager, listingStore }))
  app.route("/", createCounterRoute({ sessionManager, verifyBudgetProof: noopVerifier }))
  app.route("/", createAcceptRoute({ sessionManager, tombstones }))
  app.route("/", createQuoteSignRoute({ sessionManager }))
  app.route("/", createCosignRoute({ sessionManager }))
  app.route("/", createDeclineRoute({ sessionManager, tombstones }))

  return { app, store, sessionManager }
}

// ---------------------------------------------------------------------------
// RFQ session bootstrap
// ---------------------------------------------------------------------------

async function createFuzzRfqSession(app: Hono<EngineEnv>): Promise<string> {
  const rfq = await makeSignedRfq()
  await app.request("/rfqs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(rfq),
  })
  return rfq.rfq_id as string
}

// ---------------------------------------------------------------------------
// Action executor — swallows all expected HTTP errors
// ---------------------------------------------------------------------------

async function executeAction(
  app: Hono<EngineEnv>,
  rfqId: string,
  action: FuzzAction,
  sessionManager: SessionManager,
  store: InMemoryEventStore,
): Promise<void> {
  const session = sessionManager.getSession(rfqId)

  switch (action.type) {
    // ---- HTTP actions ----

    case "offer": {
      const seller = SELLERS[action.seller]
      const offer = await makeSignedOffer(rfqId, seller.kp, action.price)
      const res = await app.request(`/rfqs/${rfqId}/offers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(offer),
      })
      // 4xx is expected (invalid transitions), 5xx is a bug
      expect(res.status).toBeLessThan(500)
      break
    }

    case "counter": {
      if (!session || session.offers.length === 0) break
      const targetSeller = SELLERS[action.seller]
      // Only counter if the seller has an offer
      const hasOffer = session.offers.some((o) => o.seller === targetSeller.did)
      if (!hasOffer) break
      const round = session.counters.length + 1
      const counter = await makeSignedCounter(rfqId, targetSeller.did, action.price, round)
      const res = await app.request(`/rfqs/${rfqId}/counter`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(counter),
      })
      expect(res.status).toBeLessThan(500)
      break
    }

    case "accept": {
      if (!session || session.offers.length === 0) break
      const idx = action.offerIdx % session.offers.length
      const offer = session.offers[idx]
      const rev = session.lastEventId
      const envelope = await makeAcceptEnvelope(rfqId, rev, offer.seller, offer.offer_id)
      const res = await app.request(`/rfqs/${rfqId}/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(envelope),
      })
      expect(res.status).toBeLessThan(500)
      break
    }

    case "sign": {
      if (!session || !session.unsignedQuote) break
      const buyerSig = await signQuoteAsBuyer(session.unsignedQuote)
      const res = await app.request(`/rfqs/${rfqId}/quote/sign`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ buyer_signature: buyerSig }),
      })
      expect(res.status).toBeLessThan(500)
      break
    }

    case "cosign": {
      if (!session || !session.unsignedQuote || !session.selectedSeller) break
      // Find the seller keypair matching the selected seller
      const sellerEntry = SELLERS.find((s) => s.did === session.selectedSeller)
      if (!sellerEntry) break
      const sellerSig = await signQuoteAsSeller(session.unsignedQuote, sellerEntry.kp)
      const res = await app.request(`/rfqs/${rfqId}/cosign`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seller_signature: sellerSig }),
      })
      expect(res.status).toBeLessThan(500)
      break
    }

    case "decline": {
      if (!session || !session.selectedSeller) break
      const sellerEntry2 = SELLERS.find((s) => s.did === session.selectedSeller)
      if (!sellerEntry2) break
      const rev = session.lastEventId
      const envelope = await makeDeclineEnvelope(rfqId, rev, sellerEntry2.kp)
      const res = await app.request(`/rfqs/${rfqId}/decline`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(envelope),
      })
      expect(res.status).toBeLessThan(500)
      break
    }

    // ---- System events (direct append, not HTTP) ----

    case "cancel": {
      try {
        await sessionManager.withLock(rfqId, async () => {
          sessionManager.appendEvent(rfqId, {
            event_id: crypto.randomUUID(),
            rfq_id: rfqId,
            type: "NEGOTIATION_CANCELLED",
            timestamp: new Date().toISOString(),
            actor: BUYER_DID,
            payload: { rfq_id: rfqId, reason: "fuzz_cancel" },
          })
        })
      } catch (e) {
        // Only swallow expected transition/busy errors. Unexpected errors are real bugs.
        if (!(e instanceof Error && (e.message.includes("invalid transition") || e.message.includes("Session lock")))) throw e
      }
      break
    }

    case "expire": {
      try {
        await sessionManager.withLock(rfqId, async () => {
          sessionManager.appendEvent(rfqId, {
            event_id: crypto.randomUUID(),
            rfq_id: rfqId,
            type: "NEGOTIATION_EXPIRED",
            timestamp: new Date().toISOString(),
            actor: "engine/deadline-enforcer",
            payload: { rfq_id: rfqId },
          })
        })
      } catch (e) {
        if (!(e instanceof Error && (e.message.includes("invalid transition") || e.message.includes("Session lock")))) throw e
      }
      break
    }

    case "cosignTimeout": {
      if (!session || session.state !== "COMMIT_PENDING" || !session.selectedSeller) break
      try {
        await sessionManager.withLock(rfqId, async () => {
          sessionManager.appendEvent(rfqId, {
            event_id: crypto.randomUUID(),
            rfq_id: rfqId,
            type: "COSIGN_TIMEOUT",
            timestamp: new Date().toISOString(),
            actor: "engine/deadline-enforcer",
            payload: { rfq_id: rfqId, seller: session.selectedSeller },
          })
        })
      } catch (e) {
        if (!(e instanceof Error && (e.message.includes("invalid transition") || e.message.includes("Session lock")))) throw e
      }
      break
    }
  }
}

// ---------------------------------------------------------------------------
// Invariant constants
// ---------------------------------------------------------------------------

const VALID_STATES = ["OPEN", "NEGOTIATING", "COMMIT_PENDING", "COMMITTED", "EXPIRED", "CANCELLED"]
const TERMINAL = new Set(["COMMITTED", "EXPIRED", "CANCELLED"])
const PRIVACY_FIELDS = ["budget_hard", "budget_soft", "floor_price", "target_price"]

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Property-based fuzz: state machine invariants", () => {
  it("holds 8 invariants across random action sequences", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(actionArb, { minLength: 1, maxLength: 30 }),
        async (actions) => {
          const { app, store, sessionManager } = createFuzzTestApp()
          const rfqId = await createFuzzRfqSession(app)

          let prevTerminal: string | null = null

          for (const action of actions) {
            await executeAction(app, rfqId, action, sessionManager, store)

            const session = sessionManager.getSession(rfqId)
            if (!session) continue

            // --- Invariant 1: Valid state ---
            expect(VALID_STATES).toContain(session.state)

            // --- Invariant 2: Event replay = key field equality ---
            const events = store.getAllEvents(rfqId)
            const derived = deriveState([...events])
            expect(derived).not.toBeNull()
            expect(derived!.state).toBe(session.state)
            expect(derived!.selectedSeller).toBe(session.selectedSeller)
            expect(derived!.selectedOfferId).toBe(session.selectedOfferId)
            expect(derived!.commitPendingAt).toBe(session.commitPendingAt)
            expect(derived!.buyerSignature).toBe(session.buyerSignature)
            expect(derived!.sellerSignature).toBe(session.sellerSignature)
            expect(derived!.totalOfferCount).toBe(session.totalOfferCount)
            expect(derived!.quoteRevision).toBe(session.quoteRevision)
            expect(derived!.lastEventId).toBe(session.lastEventId)

            // --- Invariant 3: Event count ---
            expect(events.length).toBe(store.size(rfqId))

            // --- Invariant 5: Terminal absorption ---
            if (prevTerminal) {
              expect(session.state).toBe(prevTerminal)
            }
            if (TERMINAL.has(session.state)) {
              prevTerminal = session.state
            }

            // --- Invariant 6: Quote field coherence ---
            // In OPEN/NEGOTIATING, quote fields must be null (cleared on rollback).
            // Terminal states (EXPIRED/CANCELLED) may preserve fields from COMMIT_PENDING.
            if (["OPEN", "NEGOTIATING"].includes(session.state)) {
              expect(session.unsignedQuote).toBeNull()
            }

            // --- Invariant 7: Signature coherence ---
            // buyerSignature null in OPEN/NEGOTIATING; terminal states may preserve.
            if (["OPEN", "NEGOTIATING"].includes(session.state)) {
              expect(session.buyerSignature).toBeNull()
            }
            // sellerSignature only non-null in COMMITTED (cosign completes the deal).
            // Terminal states reached from COMMIT_PENDING before cosign keep it null.
            if (session.state !== "COMMITTED") {
              expect(session.sellerSignature).toBeNull()
            }

            // --- Invariant 8: Selected seller consistency ---
            // OPEN/NEGOTIATING must have null selectedSeller.
            // Terminal states may preserve from COMMIT_PENDING.
            if (["OPEN", "NEGOTIATING"].includes(session.state)) {
              expect(session.selectedSeller).toBeNull()
            }
          }

          // --- Invariant 4: Privacy (post-loop) ---
          const eventsJson = JSON.stringify(store.getAllEvents(rfqId))
          for (const field of PRIVACY_FIELDS) {
            expect(eventsJson).not.toContain(field)
          }
        },
      ),
      { seed: 42, numRuns: 200, endOnFailure: true, verbose: 1 },
    )
  })
})
