/**
 * End-to-end negotiation test.
 *
 * Spins up a real engine in-process using Hono's app.request(),
 * generates buyer + seller keypairs, registers a seller listing,
 * then runs the full negotiation flow:
 *
 *   1. Buyer browses listings
 *   2. Buyer posts RFQ
 *   3. Seller posts offer
 *   4. Buyer counters
 *   5. Seller responds with revised offer
 *   6. Buyer accepts → engine builds unsigned quote
 *   7. Buyer signs quote
 *   8. Seller cosigns quote → COMMITTED
 *
 * No Solana, no devnet, no external services.
 */

import { describe, it, expect } from "vitest"
import type { Hono } from "hono"
import { Keypair } from "@solana/web3.js"
import {
  buildDid,
  objectSigningPayload,
  signEd25519,
  canonicalJson,
} from "@ghost-bazaar/core"
import {
  createApp,
  SessionManager,
  ListingStore,
  InMemoryEventStore,
  EnvelopeTombstones,
  createListingsRoute,
  createRfqRoute,
  createOfferRoute,
  createCounterRoute,
  createAcceptRoute,
  createQuoteSignRoute,
  createQuoteReadRoute,
  createCosignRoute,
  type EngineEnv,
} from "@ghost-bazaar/engine"

// ── Test keypairs ──
const buyerKp = Keypair.generate()
const sellerKp = Keypair.generate()
const buyerDid = buildDid(buyerKp.publicKey)
const sellerDid = buildDid(sellerKp.publicKey)

// ── Signing helpers ──

async function signObj(obj: Record<string, unknown>, kp: Keypair): Promise<string> {
  return signEd25519(objectSigningPayload(obj), kp)
}

async function signQuotePayload(quote: Record<string, unknown>, kp: Keypair): Promise<string> {
  const stripped = { ...quote, buyer_signature: "", seller_signature: "" }
  return signEd25519(canonicalJson(stripped), kp)
}

// ── Engine setup ──

function createTestEngine() {
  const eventStore = new InMemoryEventStore()
  const sessionManager = new SessionManager(eventStore)
  const listingStore = new ListingStore()
  const tombstones = new EnvelopeTombstones()

  listingStore.add({
    listing_id: "listing-e2e-seller",
    seller: sellerDid,
    title: "E2E Audit Service",
    category: "security",
    service_type: "smart-contract-audit",
    negotiation_endpoint: "https://test.example.com/negotiate",
    payment_endpoint: "https://test.example.com/execute",
    base_terms: { coverage: "full" },
    negotiation_profile: { style: "flexible", max_rounds: 5, accepts_counter: true },
  })

  let authDid = buyerDid
  const authenticateCaller = async () => authDid
  const setAuthCaller = (did: string) => { authDid = did }

  const app = createApp() as Hono<EngineEnv>
  app.route("/", createListingsRoute(listingStore))
  app.route("/", createRfqRoute(sessionManager))
  app.route("/", createOfferRoute({ sessionManager, listingStore }))
  app.route("/", createCounterRoute({ sessionManager, verifyBudgetProof: async () => true }))
  app.route("/", createAcceptRoute({ sessionManager, tombstones }))
  app.route("/", createQuoteSignRoute({ sessionManager }))
  app.route("/", createQuoteReadRoute({ sessionManager, authenticateCaller }))
  app.route("/", createCosignRoute({ sessionManager }))

  return { app, setAuthCaller, eventStore }
}

// ── HTTP helpers ──

async function post(app: Hono<EngineEnv>, path: string, body: any) {
  const res = await app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(`POST ${path} → ${res.status}: ${JSON.stringify(data)}`)
  return data as any
}

async function put(app: Hono<EngineEnv>, path: string, body: any) {
  const res = await app.request(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(`PUT ${path} → ${res.status}: ${JSON.stringify(data)}`)
  return data as any
}

async function get(app: Hono<EngineEnv>, path: string) {
  const res = await app.request(path, {
    headers: { Accept: "application/json" },
  })
  const data = await res.json()
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}: ${JSON.stringify(data)}`)
  return data as any
}

// ── Tests ──

describe("E2E: Full negotiation flow", () => {
  it("RFQ → offer → counter → revised offer → accept → sign → cosign → COMMITTED", async () => {
    const { app, setAuthCaller, eventStore } = createTestEngine()

    // ── 1: Browse listings ──
    const listingsRes = await get(app, "/listings")
    expect(listingsRes.listings).toHaveLength(1)
    expect(listingsRes.listings[0].seller).toBe(sellerDid)

    // ── 2: Buyer posts RFQ ──
    const rfqId = crypto.randomUUID()
    const deadline = new Date(Date.now() + 120_000).toISOString()
    const rfq: Record<string, unknown> = {
      rfq_id: rfqId,
      protocol: "ghost-bazaar-v4",
      buyer: buyerDid,
      service_type: "smart-contract-audit",
      spec: { language: "Solidity", lines: 500 },
      anchor_price: "40.00",
      currency: "USDC",
      deadline,
      signature: "",
    }
    rfq.signature = await signObj(rfq, buyerKp)
    const rfqRes = await post(app, "/rfqs", rfq)
    expect(rfqRes.rfq_id).toBe(rfqId)

    // ── 3: Seller offers $55 ──
    const offer1Id = crypto.randomUUID()
    const offer1: Record<string, unknown> = {
      offer_id: offer1Id, rfq_id: rfqId, seller: sellerDid, listing_id: "listing-e2e-seller",
      price: "55.00", currency: "USDC", valid_until: deadline, signature: "",
    }
    offer1.signature = await signObj(offer1, sellerKp)
    await post(app, `/rfqs/${rfqId}/offers`, offer1)

    // ── 4: Buyer counters at $42 ──
    const counter: Record<string, unknown> = {
      counter_id: crypto.randomUUID(), rfq_id: rfqId, round: 1,
      from: buyerDid, to: sellerDid, price: "42.00", currency: "USDC",
      valid_until: deadline, signature: "",
    }
    counter.signature = await signObj(counter, buyerKp)
    await post(app, `/rfqs/${rfqId}/counter`, counter)

    // ── 5: Seller revises to $48 ──
    const offer2Id = crypto.randomUUID()
    const offer2: Record<string, unknown> = {
      offer_id: offer2Id, rfq_id: rfqId, seller: sellerDid, listing_id: "listing-e2e-seller",
      price: "48.00", currency: "USDC", valid_until: deadline, signature: "",
    }
    offer2.signature = await signObj(offer2, sellerKp)
    await post(app, `/rfqs/${rfqId}/offers`, offer2)

    // ── 6: Buyer accepts the $48 offer ──
    // Get session revision from event store directly (events HTTP route not needed)
    const allEvents = eventStore.getEvents(rfqId, buyerDid, rfq as any)
    const lastEventId = allEvents.length > 0 ? String(allEvents[allEvents.length - 1].event_id) : "0"

    const envelope: Record<string, unknown> = {
      envelope_id: crypto.randomUUID(), action: "accept", rfq_id: rfqId,
      session_revision: lastEventId,
      payload: { seller: sellerDid, offer_id: offer2Id },
      issued_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      signature: "",
    }
    envelope.signature = await signObj(envelope, buyerKp)
    const unsignedQuote = await post(app, `/rfqs/${rfqId}/accept`, envelope)

    expect(unsignedQuote.quote_id).toBeDefined()
    expect(unsignedQuote.final_price).toBe("48.00")
    expect(unsignedQuote.buyer_signature).toBe("")
    expect(unsignedQuote.seller_signature).toBe("")

    // ── 7: Buyer signs quote ──
    const buyerSig = await signQuotePayload(unsignedQuote, buyerKp)
    const signedQuote = await put(app, `/rfqs/${rfqId}/quote/sign`, { buyer_signature: buyerSig })
    expect(signedQuote.buyer_signature).toMatch(/^ed25519:/)

    // ── 8: Seller cosigns → COMMITTED ──
    const sellerSig = await signQuotePayload(signedQuote, sellerKp)
    const committed = await put(app, `/rfqs/${rfqId}/cosign`, { seller_signature: sellerSig })

    expect(committed.buyer_signature).toMatch(/^ed25519:/)
    expect(committed.seller_signature).toMatch(/^ed25519:/)
    expect(committed.final_price).toBe("48.00")
    expect(committed.currency).toBe("USDC")
    expect(committed.nonce).toMatch(/^0x[0-9a-f]{64}$/)
    expect(committed.payment_endpoint).toBe("https://test.example.com/execute")

    console.log("\n  ═══ E2E Negotiation Complete ═══")
    console.log("  Quote:", committed.quote_id)
    console.log("  Price: $" + committed.final_price, "USDC")
    console.log("  Nonce:", committed.nonce.slice(0, 18) + "...")
    console.log("  → Ready for settlement at", committed.payment_endpoint)
  }, 15_000)
})
