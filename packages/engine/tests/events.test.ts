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
import { createEventsRoute } from "../src/routes/events.js"
import { InMemoryEventStore } from "../src/state/event-store.js"
import { SessionManager } from "../src/state/session-manager.js"
import { ListingStore } from "../src/registry/listing-store.js"
import { ConnectionTracker } from "../src/util/connection-tracker.js"
import type { EngineEnv } from "../src/app.js"

// ---------------------------------------------------------------------------
// Helpers — mirrors offers.test.ts pattern
// ---------------------------------------------------------------------------

const BUYER_KP = Keypair.generate()
const BUYER_DID = buildDid(BUYER_KP.publicKey)
const SELLER_A_KP = Keypair.generate()
const SELLER_A_DID = buildDid(SELLER_A_KP.publicKey)
const SELLER_B_KP = Keypair.generate()
const SELLER_B_DID = buildDid(SELLER_B_KP.publicKey)
const OUTSIDER_KP = Keypair.generate()
const OUTSIDER_DID = buildDid(OUTSIDER_KP.publicKey)

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

function createTestApp(
  authenticateCaller: (req: Request) => Promise<string> = async () => BUYER_DID,
) {
  const store = new InMemoryEventStore()
  const sessionManager = new SessionManager(store)
  const listingStore = new ListingStore()
  const connectionTracker = new ConnectionTracker()

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
  app.route(
    "/",
    createEventsRoute({
      sessionManager,
      eventStore: store,
      connectionTracker,
      authenticateCaller,
    }),
  )
  return { app, store, sessionManager, listingStore, connectionTracker }
}

// ---------------------------------------------------------------------------
// SSE helpers — read stream frames
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

function parseSSEText(frames: string[]): string {
  return frames.join("")
}

// ---------------------------------------------------------------------------
// Tests — JSON mode
// ---------------------------------------------------------------------------

describe("GET /rfqs/:id/events — JSON mode", () => {
  let app: Hono<EngineEnv>
  let sessionManager: SessionManager

  beforeEach(() => {
    const ctx = createTestApp()
    app = ctx.app
    sessionManager = ctx.sessionManager
  })

  it("returns all events for buyer (no cursor) — 200 with RFQ_CREATED + OFFER_SUBMITTED", async () => {
    const rfq = await createRfqSession(app)
    const offer = await makeSignedOffer(rfq.rfq_id, SELLER_A_KP)
    await app.request(`/rfqs/${rfq.rfq_id}/offers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(offer),
    })

    const res = await app.request(`/rfqs/${rfq.rfq_id}/events`, {
      headers: { Accept: "application/json" },
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.rfq_id).toBe(rfq.rfq_id)
    expect(body.events).toHaveLength(2)
    expect(body.events[0].type).toBe("RFQ_CREATED")
    expect(body.events[1].type).toBe("OFFER_SUBMITTED")
    expect(body.cursor).toBe(body.events[1].event_id)
    expect(body.cursor_valid).toBe(true)
  })

  it("returns role-scoped events for seller — seller A sees RFQ + own offer, not seller B's", async () => {
    const rfq = await createRfqSession(app)

    // Submit offers from both sellers
    const offerA = await makeSignedOffer(rfq.rfq_id, SELLER_A_KP)
    await app.request(`/rfqs/${rfq.rfq_id}/offers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(offerA),
    })
    const offerB = await makeSignedOffer(rfq.rfq_id, SELLER_B_KP)
    await app.request(`/rfqs/${rfq.rfq_id}/offers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(offerB),
    })

    // Query events as seller A
    const ctxA = createTestApp(async () => SELLER_A_DID)
    // Need to share state — rebuild with same store
    const store = new InMemoryEventStore()
    const sm = new SessionManager(store)
    const ls = new ListingStore()
    const ct = new ConnectionTracker()
    ls.add({
      listing_id: "listing-seller-a",
      seller: SELLER_A_DID,
      title: "Seller A Service",
      category: "llm",
      service_type: "llm-inference",
      negotiation_endpoint: "https://seller-a.example.com/negotiate",
      payment_endpoint: "https://seller-a.example.com/pay",
      base_terms: {},
    })
    ls.add({
      listing_id: "listing-seller-b",
      seller: SELLER_B_DID,
      title: "Seller B Service",
      category: "llm",
      service_type: "llm-inference",
      negotiation_endpoint: "https://seller-b.example.com/negotiate",
      payment_endpoint: "https://seller-b.example.com/pay",
      base_terms: {},
    })
    const appShared = createApp() as Hono<EngineEnv>
    appShared.route("/", createRfqRoute(sm))
    appShared.route("/", createOfferRoute({ sessionManager: sm, listingStore: ls }))
    appShared.route(
      "/",
      createEventsRoute({
        sessionManager: sm,
        eventStore: store,
        connectionTracker: ct,
        authenticateCaller: async () => SELLER_A_DID,
      }),
    )

    // Create session and submit both offers
    const rfq2 = await makeSignedRfq()
    await appShared.request("/rfqs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(rfq2),
    })
    const ofA = await makeSignedOffer(rfq2.rfq_id, SELLER_A_KP)
    await appShared.request(`/rfqs/${rfq2.rfq_id}/offers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ofA),
    })
    const ofB = await makeSignedOffer(rfq2.rfq_id, SELLER_B_KP)
    await appShared.request(`/rfqs/${rfq2.rfq_id}/offers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ofB),
    })

    // Seller A queries events
    const res = await appShared.request(`/rfqs/${rfq2.rfq_id}/events`, {
      headers: { Accept: "application/json" },
    })

    expect(res.status).toBe(200)
    const body = await res.json()
    // Seller A sees RFQ_CREATED + own OFFER_SUBMITTED only
    expect(body.events).toHaveLength(2)
    expect(body.events[0].type).toBe("RFQ_CREATED")
    expect(body.events[1].type).toBe("OFFER_SUBMITTED")
    expect(body.events[1].actor).toBe(SELLER_A_DID)
  })

  it("cursor-based pagination returns only events after cursor", async () => {
    const rfq = await createRfqSession(app)
    const offer = await makeSignedOffer(rfq.rfq_id, SELLER_A_KP)
    await app.request(`/rfqs/${rfq.rfq_id}/offers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(offer),
    })

    // First request to get cursor at RFQ_CREATED
    const res1 = await app.request(`/rfqs/${rfq.rfq_id}/events`, {
      headers: { Accept: "application/json" },
    })
    const body1 = await res1.json()
    const cursorAtRfq = body1.events[0].event_id

    // Second request with cursor — should only return events after RFQ_CREATED
    const res2 = await app.request(
      `/rfqs/${rfq.rfq_id}/events?after=${cursorAtRfq}`,
      { headers: { Accept: "application/json" } },
    )

    expect(res2.status).toBe(200)
    const body2 = await res2.json()
    expect(body2.events).toHaveLength(1)
    expect(body2.events[0].type).toBe("OFFER_SUBMITTED")
    expect(body2.cursor).toBe(body2.events[0].event_id)
  })

  it("invalid cursor returns 400 invalid_cursor", async () => {
    const rfq = await createRfqSession(app)

    const res = await app.request(
      `/rfqs/${rfq.rfq_id}/events?after=nonexistent-cursor-id`,
      { headers: { Accept: "application/json" } },
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe("invalid_cursor")
  })

  it("non-participant gets 401", async () => {
    const ctx = createTestApp(async () => OUTSIDER_DID)
    const rfq = await createRfqSession(ctx.app)

    // Outsider is not authenticated as buyer in the events route
    const res = await ctx.app.request(`/rfqs/${rfq.rfq_id}/events`, {
      headers: { Accept: "application/json" },
    })

    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toBe("unauthorized")
  })

  it("non-existent session gets 404", async () => {
    const res = await app.request("/rfqs/nonexistent-rfq/events", {
      headers: { Accept: "application/json" },
    })

    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toBe("session_not_found")
  })

  it("valid cursor with no new events returns same cursor back + cursor_valid: true", async () => {
    const rfq = await createRfqSession(app)

    // Get the cursor for the only event (RFQ_CREATED)
    const res1 = await app.request(`/rfqs/${rfq.rfq_id}/events`, {
      headers: { Accept: "application/json" },
    })
    const body1 = await res1.json()
    const lastCursor = body1.cursor

    // Query with that cursor — no new events
    const res2 = await app.request(
      `/rfqs/${rfq.rfq_id}/events?after=${lastCursor}`,
      { headers: { Accept: "application/json" } },
    )

    expect(res2.status).toBe(200)
    const body2 = await res2.json()
    expect(body2.events).toHaveLength(0)
    expect(body2.cursor).toBe(lastCursor)
    expect(body2.cursor_valid).toBe(true)
  })

  it("cursor from different session is rejected (400)", async () => {
    const rfq1 = await createRfqSession(app)
    const rfq2 = await createRfqSession(app)

    // Get cursor from session 1
    const res1 = await app.request(`/rfqs/${rfq1.rfq_id}/events`, {
      headers: { Accept: "application/json" },
    })
    const body1 = await res1.json()
    const cursorFromSession1 = body1.cursor

    // Use it against session 2 — should be rejected (session-scoped)
    const res2 = await app.request(
      `/rfqs/${rfq2.rfq_id}/events?after=${cursorFromSession1}`,
      { headers: { Accept: "application/json" } },
    )

    expect(res2.status).toBe(400)
    const body2 = await res2.json()
    expect(body2.error).toBe("invalid_cursor")
  })
})

// ---------------------------------------------------------------------------
// Tests — SSE mode
// ---------------------------------------------------------------------------

describe("GET /rfqs/:id/events — SSE mode", () => {
  it("streams existing events with correct Content-Type", async () => {
    const ctx = createTestApp()
    const rfq = await createRfqSession(ctx.app)
    const offer = await makeSignedOffer(rfq.rfq_id, SELLER_A_KP)
    await ctx.app.request(`/rfqs/${rfq.rfq_id}/offers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(offer),
    })

    const res = await ctx.app.request(`/rfqs/${rfq.rfq_id}/events`, {
      headers: { Accept: "text/event-stream" },
    })

    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Type")).toBe("text/event-stream")
    expect(res.headers.get("Cache-Control")).toBe("no-cache")

    const frames = await readSSEFrames(res)
    const text = parseSSEText(frames)
    expect(text).toContain("RFQ_CREATED")
    expect(text).toContain("event: negotiation")
  })

  it("Last-Event-ID overrides ?after query param", async () => {
    const ctx = createTestApp()
    const rfq = await createRfqSession(ctx.app)
    const offer = await makeSignedOffer(rfq.rfq_id, SELLER_A_KP)
    await ctx.app.request(`/rfqs/${rfq.rfq_id}/offers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(offer),
    })

    // Get the RFQ_CREATED event_id to use as Last-Event-ID
    const jsonRes = await ctx.app.request(`/rfqs/${rfq.rfq_id}/events`, {
      headers: { Accept: "application/json" },
    })
    const jsonBody = await jsonRes.json()
    const rfqCreatedId = jsonBody.events[0].event_id
    const offerSubmittedId = jsonBody.events[1].event_id

    // SSE request with Last-Event-ID (should skip RFQ_CREATED)
    // Also pass ?after with a bogus value that would fail — proving Last-Event-ID wins
    const res = await ctx.app.request(
      `/rfqs/${rfq.rfq_id}/events?after=should-be-ignored`,
      {
        headers: {
          Accept: "text/event-stream",
          "Last-Event-ID": rfqCreatedId,
        },
      },
    )

    expect(res.status).toBe(200)
    const frames = await readSSEFrames(res)
    const text = parseSSEText(frames)

    // Should contain OFFER_SUBMITTED but NOT contain RFQ_CREATED as a data payload
    // (RFQ_CREATED should have been skipped by the cursor)
    expect(text).toContain("OFFER_SUBMITTED")
    expect(text).toContain(`id: ${offerSubmittedId}`)
  })

  it("invalid cursor returns error event and closes", async () => {
    const ctx = createTestApp()
    const rfq = await createRfqSession(ctx.app)

    const res = await ctx.app.request(
      `/rfqs/${rfq.rfq_id}/events?after=bogus-cursor`,
      { headers: { Accept: "text/event-stream" } },
    )

    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Type")).toBe("text/event-stream")

    const frames = await readSSEFrames(res)
    const text = parseSSEText(frames)
    expect(text).toContain("event: error")
    expect(text).toContain("invalid_cursor")
  })

  it("role-scoped: seller only sees own events in stream", async () => {
    // Build a shared app that authenticates as seller A
    const store = new InMemoryEventStore()
    const sm = new SessionManager(store)
    const ls = new ListingStore()
    const ct = new ConnectionTracker()
    ls.add({
      listing_id: "listing-seller-a",
      seller: SELLER_A_DID,
      title: "A",
      category: "llm",
      service_type: "llm-inference",
      negotiation_endpoint: "https://a.example.com/negotiate",
      payment_endpoint: "https://a.example.com/pay",
      base_terms: {},
    })
    ls.add({
      listing_id: "listing-seller-b",
      seller: SELLER_B_DID,
      title: "B",
      category: "llm",
      service_type: "llm-inference",
      negotiation_endpoint: "https://b.example.com/negotiate",
      payment_endpoint: "https://b.example.com/pay",
      base_terms: {},
    })

    // Use buyer auth for RFQ and offers submission
    const buyerApp = createApp() as Hono<EngineEnv>
    buyerApp.route("/", createRfqRoute(sm))
    buyerApp.route("/", createOfferRoute({ sessionManager: sm, listingStore: ls }))

    // Use seller A auth for events
    const sellerApp = createApp() as Hono<EngineEnv>
    sellerApp.route(
      "/",
      createEventsRoute({
        sessionManager: sm,
        eventStore: store,
        connectionTracker: ct,
        authenticateCaller: async () => SELLER_A_DID,
      }),
    )

    // Create session + both offers
    const rfq = await makeSignedRfq()
    await buyerApp.request("/rfqs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(rfq),
    })
    const ofA = await makeSignedOffer(rfq.rfq_id, SELLER_A_KP)
    await buyerApp.request(`/rfqs/${rfq.rfq_id}/offers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ofA),
    })
    const ofB = await makeSignedOffer(rfq.rfq_id, SELLER_B_KP)
    await buyerApp.request(`/rfqs/${rfq.rfq_id}/offers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ofB),
    })

    // Seller A subscribes via SSE
    const res = await sellerApp.request(`/rfqs/${rfq.rfq_id}/events`, {
      headers: { Accept: "text/event-stream" },
    })

    expect(res.status).toBe(200)
    const frames = await readSSEFrames(res)
    const text = parseSSEText(frames)

    // Seller A should see RFQ_CREATED + own offer, NOT seller B's offer
    expect(text).toContain("RFQ_CREATED")
    expect(text).toContain(SELLER_A_DID)
    expect(text).not.toContain(SELLER_B_DID)
  })
})

// ---------------------------------------------------------------------------
// Tests — Terminal close
// ---------------------------------------------------------------------------

describe("GET /rfqs/:id/events — terminal close", () => {
  it("already-terminal session: sends replay + terminal event, then closes", async () => {
    const store = new InMemoryEventStore()
    const sm = new SessionManager(store)
    const ls = new ListingStore()
    const ct = new ConnectionTracker()
    ls.add({
      listing_id: "listing-seller-a",
      seller: SELLER_A_DID,
      title: "A",
      category: "llm",
      service_type: "llm-inference",
      negotiation_endpoint: "https://a.example.com/negotiate",
      payment_endpoint: "https://a.example.com/pay",
      base_terms: {},
    })

    const buyerApp = createApp() as Hono<EngineEnv>
    buyerApp.route("/", createRfqRoute(sm))
    buyerApp.route("/", createOfferRoute({ sessionManager: sm, listingStore: ls }))
    buyerApp.route(
      "/",
      createEventsRoute({
        sessionManager: sm,
        eventStore: store,
        connectionTracker: ct,
        authenticateCaller: async () => BUYER_DID,
      }),
    )

    // Create session + offer
    const rfq = await makeSignedRfq()
    await buyerApp.request("/rfqs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(rfq),
    })
    const ofA = await makeSignedOffer(rfq.rfq_id, SELLER_A_KP)
    await buyerApp.request(`/rfqs/${rfq.rfq_id}/offers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ofA),
    })

    // Manually transition to EXPIRED via appendEvent
    await sm.withLock(rfq.rfq_id, async () => {
      sm.appendEvent(rfq.rfq_id, {
        event_id: crypto.randomUUID(),
        rfq_id: rfq.rfq_id,
        type: "NEGOTIATION_EXPIRED",
        timestamp: new Date().toISOString(),
        actor: "engine",
        payload: {
          rfq_id: rfq.rfq_id,
          reason: "deadline_passed",
        },
      })
    })

    // Verify session is terminal
    const session = sm.getSession(rfq.rfq_id)
    expect(session!.state).toBe("EXPIRED")

    // SSE request — should get replay + terminal event, then close
    const res = await buyerApp.request(`/rfqs/${rfq.rfq_id}/events`, {
      headers: { Accept: "text/event-stream" },
    })

    expect(res.status).toBe(200)
    const frames = await readSSEFrames(res)
    const text = parseSSEText(frames)

    // Should contain replay events
    expect(text).toContain("RFQ_CREATED")
    expect(text).toContain("OFFER_SUBMITTED")
    expect(text).toContain("NEGOTIATION_EXPIRED")

    // Should contain terminal event
    expect(text).toContain("event: terminal")
    expect(text).toContain('"state":"EXPIRED"')
  })
})

// ---------------------------------------------------------------------------
// Tests — Connection limits
// ---------------------------------------------------------------------------

describe("GET /rfqs/:id/events — connection limits", () => {
  it("rejects connection when per-DID limit exceeded", async () => {
    const store = new InMemoryEventStore()
    const sm = new SessionManager(store)
    const ls = new ListingStore()
    const ct = new ConnectionTracker()
    ls.add({
      listing_id: "listing-seller-a",
      seller: SELLER_A_DID,
      title: "A",
      category: "llm",
      service_type: "llm-inference",
      negotiation_endpoint: "https://a.example.com/negotiate",
      payment_endpoint: "https://a.example.com/pay",
      base_terms: {},
    })

    const buyerApp = createApp() as Hono<EngineEnv>
    buyerApp.route("/", createRfqRoute(sm))
    buyerApp.route("/", createOfferRoute({ sessionManager: sm, listingStore: ls }))
    buyerApp.route(
      "/",
      createEventsRoute({
        sessionManager: sm,
        eventStore: store,
        connectionTracker: ct,
        authenticateCaller: async () => BUYER_DID,
      }),
    )

    // Create a session
    const rfq = await makeSignedRfq()
    await buyerApp.request("/rfqs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(rfq),
    })

    // Pre-fill 3 connections for BUYER_DID (the per-DID limit)
    for (let i = 0; i < 3; i++) {
      ct.acquire({
        rfqId: rfq.rfq_id,
        callerDid: BUYER_DID,
        isBuyer: true,
        close: () => {},
      })
    }

    // Verify we filled the slots
    expect(ct.countForDid(rfq.rfq_id, BUYER_DID)).toBe(3)

    // 4th SSE connection should be rejected
    const res = await buyerApp.request(`/rfqs/${rfq.rfq_id}/events`, {
      headers: { Accept: "text/event-stream" },
    })

    expect(res.status).toBe(200)
    const frames = await readSSEFrames(res)
    const text = parseSSEText(frames)
    expect(text).toContain("event: error")
    expect(text).toContain("connection_limit")
  })
})
