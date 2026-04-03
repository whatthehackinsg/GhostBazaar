/**
 * Ghost Bazaar Negotiation Engine — HTTP Server Entrypoint
 *
 * Wires all route factories, stores, and the deadline enforcer into a
 * running Hono HTTP server on @hono/node-server.
 *
 * Authentication:
 * - Write routes (POST/PUT): signature verified inside each route handler
 * - Read routes (GET /quote, GET /events): GhostBazaar-Ed25519 header auth
 *
 * ZK Budget Proof: real Groth16 verification via @ghost-bazaar/zk
 */

import { mkdirSync } from "node:fs"
import { serve } from "@hono/node-server"
import { cors } from "hono/cors"
import { createApp } from "./app.js"
import { EngineError } from "./middleware/error-handler.js"
import { SqliteEventStore } from "./state/sqlite-event-store.js"
import { SessionManager } from "./state/session-manager.js"
import { SqliteListingStore } from "./registry/sqlite-listing-store.js"
import { seedListingsIfMissing } from "./registry/listing-bootstrap.js"
import { EnvelopeTombstones } from "./security/control-envelope.js"
import { ConnectionTracker } from "./util/connection-tracker.js"
import { DeadlineEnforcer } from "./deadline-enforcer.js"
import { createRfqRoute } from "./routes/rfqs.js"
import { createOfferRoute } from "./routes/offers.js"
import { createCounterRoute } from "./routes/counters.js"
import { createAcceptRoute } from "./routes/accept.js"
import { createQuoteSignRoute } from "./routes/quote-sign.js"
import { createQuoteReadRoute } from "./routes/quote-read.js"
import { createCosignRoute } from "./routes/cosign.js"
import { createDeclineRoute } from "./routes/decline.js"
import { createEventsRoute } from "./routes/events.js"
import { createListingsRoute } from "./routes/listings.js"
import { createDashboardRoute } from "./routes/dashboard.js"
import { createAdminRoute } from "./routes/admin.js"
import { createExecuteRoute } from "./routes/execute.js"
import { createSettleReportRoute } from "./routes/settle-report.js"
import { StatsCollector } from "./stats/stats-collector.js"
import { EventBroadcaster } from "./stats/event-broadcaster.js"
import { discoverAgent } from "@ghost-bazaar/agents"
import { verifyBudgetProof } from "@ghost-bazaar/zk"
import { verifyEd25519, objectSigningPayload, didToPublicKey as coreDidToPublicKey } from "@ghost-bazaar/core"

// ---------------------------------------------------------------------------
// Configuration from environment
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT ?? "3000", 10)
const ENFORCER_INTERVAL_MS = parseInt(process.env.ENFORCER_INTERVAL_MS ?? "1000", 10)
const COSIGN_TIMEOUT_MS = parseInt(process.env.COSIGN_TIMEOUT_MS ?? "60000", 10)
const DATA_DIR = process.env.DATA_DIR ?? "./data"
const AGENT_REGISTRY_RPC_URL = process.env.AGENT_REGISTRY_RPC_URL
const REGISTRY_CACHE_TTL_MS = parseInt(process.env.REGISTRY_CACHE_TTL_MS ?? "60000", 10)
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com"
const USDC_MINT = process.env.USDC_MINT ?? "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"

// ---------------------------------------------------------------------------
// GhostBazaar-Ed25519 Header Authentication
//
// Format: "GhostBazaar-Ed25519 <did> <timestamp_iso> <signature>"
// The signature is computed over: canonical_json({ action: "authenticate",
//   did, timestamp }). Timestamp drift tolerance: 60 seconds.
//
// Used by read routes (GET /quote, GET /events) where no request body exists.
// Write routes authenticate via request body signatures in their handlers.
// ---------------------------------------------------------------------------

const MAX_AUTH_DRIFT_MS = 60_000

async function authenticateCaller(req: Request): Promise<string> {
  const header = req.headers.get("Authorization")
  if (!header) {
    throw new EngineError(401, "unauthorized", "Missing Authorization header")
  }

  if (!header.startsWith("GhostBazaar-Ed25519 ")) {
    throw new EngineError(401, "unauthorized", "Authorization must use GhostBazaar-Ed25519 scheme")
  }

  const parts = header.slice("GhostBazaar-Ed25519 ".length).split(" ")
  if (parts.length !== 3) {
    throw new EngineError(401, "unauthorized", "GhostBazaar-Ed25519 header must have 3 parts: <did> <timestamp> <signature>")
  }

  const [did, timestamp, signature] = parts

  // Validate DID format
  const pubkey = coreDidToPublicKey(did)
  if (!pubkey) {
    throw new EngineError(401, "unauthorized", "Invalid DID in Authorization header")
  }

  // Validate timestamp drift
  const authTime = new Date(timestamp).getTime()
  if (Number.isNaN(authTime)) {
    throw new EngineError(401, "unauthorized", "Invalid timestamp in Authorization header")
  }
  const drift = Math.abs(Date.now() - authTime)
  if (drift > MAX_AUTH_DRIFT_MS) {
    throw new EngineError(401, "unauthorized", "Authorization timestamp too far from server time")
  }

  // Verify Ed25519 signature over canonical auth payload
  const authPayload = objectSigningPayload({
    action: "authenticate",
    did,
    timestamp,
    signature: "",
  })
  const valid = await verifyEd25519(authPayload, signature, pubkey)
  if (!valid) {
    throw new EngineError(401, "unauthorized", "Invalid signature in Authorization header")
  }

  return did
}

// ---------------------------------------------------------------------------
// Infrastructure
// ---------------------------------------------------------------------------

mkdirSync(DATA_DIR, { recursive: true })
const eventStore = new SqliteEventStore(`${DATA_DIR}/engine.db`)
const sessionManager = new SessionManager(eventStore)
const listingStore = new SqliteListingStore(`${DATA_DIR}/engine.db`)
const tombstones = new EnvelopeTombstones()
const connectionTracker = new ConnectionTracker()

const registryCache = new Map<string, { readonly value: Awaited<ReturnType<typeof discoverAgent>>; readonly expiresAt: number }>()
async function discoverRegistryAgent(agentId: string) {
  const now = Date.now()
  const cached = registryCache.get(agentId)
  if (cached && cached.expiresAt > now) {
    return cached.value
  }

  const value = await discoverAgent(BigInt(agentId), AGENT_REGISTRY_RPC_URL)
  registryCache.set(agentId, {
    value,
    expiresAt: now + REGISTRY_CACHE_TTL_MS,
  })

  if (registryCache.size > 1024) {
    for (const [key, entry] of registryCache) {
      if (entry.expiresAt <= now) {
        registryCache.delete(key)
      }
    }
    while (registryCache.size > 1024) {
      const oldestKey = registryCache.keys().next().value
      if (!oldestKey) break
      registryCache.delete(oldestKey)
    }
  }

  return value
}

// StatsCollector — replays raw events on startup, then listens via onAppend()
const statsCollector = new StatsCollector(eventStore, listingStore.count())
const broadcaster = new EventBroadcaster()

// ---------------------------------------------------------------------------
// Seed Listings — demo scenario sellers (3 agents with different strategies)
//
// These match the engine-plan.md demo scenario:
// FirmSeller ($50, firm), FlexibleSeller ($38, flexible), CompetitiveSeller ($42, competitive)
//
// DID format uses valid did:key:z6Mk... pattern with deterministic suffixes.
// In production, sellers register their own listings via an API or Agent Registry.
// ---------------------------------------------------------------------------

const SEED_LISTINGS_ENABLED = process.env.SEED_LISTINGS !== "false"
const SEED_FIRM_SELLER_DID = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK"
const SEED_FLEXIBLE_SELLER_DID = "did:key:z6MkwFKMCxFa3koeWKaEahRbauatWRMnFjE2GhJSpiY7bypz"
const SEED_COMPETITIVE_SELLER_DID = "did:key:z6Mkmxb8wfHQ6TDHPzuvM8eb8JwA9h1ujCto3CmvLZtb3F6p"

if (SEED_LISTINGS_ENABLED) {
  const seedListings = [
    {
      listing_id: "listing-firm-seller",
      seller: SEED_FIRM_SELLER_DID,
      title: "Smart Contract Audit — Premium",
      category: "security",
      service_type: "smart-contract-audit",
      negotiation_endpoint: "https://firm-seller.example.com/negotiate",
      payment_endpoint: "https://firm-seller.example.com/execute",
      base_terms: { response_time: "24h", coverage: "full" },
      negotiation_profile: {
        style: "firm" as const,
        max_rounds: 2,
        accepts_counter: false,
      },
    },
    {
      listing_id: "listing-flexible-seller",
      seller: SEED_FLEXIBLE_SELLER_DID,
      title: "Smart Contract Audit — Standard",
      category: "security",
      service_type: "smart-contract-audit",
      negotiation_endpoint: "https://flexible-seller.example.com/negotiate",
      payment_endpoint: "https://flexible-seller.example.com/execute",
      base_terms: { response_time: "48h", coverage: "standard" },
      negotiation_profile: {
        style: "flexible" as const,
        max_rounds: 5,
        accepts_counter: true,
      },
    },
    {
      listing_id: "listing-competitive-seller",
      seller: SEED_COMPETITIVE_SELLER_DID,
      title: "Smart Contract Audit — Budget",
      category: "security",
      service_type: "smart-contract-audit",
      negotiation_endpoint: "https://competitive-seller.example.com/negotiate",
      payment_endpoint: "https://competitive-seller.example.com/execute",
      base_terms: { response_time: "72h", coverage: "basic" },
      negotiation_profile: {
        style: "competitive" as const,
        max_rounds: 8,
        accepts_counter: true,
      },
    },
  ]

  seedListingsIfMissing(listingStore, seedListings)
  statsCollector.setListingCount(listingStore.count())
}

// ---------------------------------------------------------------------------
// App + Routes
// ---------------------------------------------------------------------------

const app = createApp()

// ---------------------------------------------------------------------------
// CORS — allow frontend (Vercel) + localhost dev to call the engine API
//
// ALLOWED_ORIGINS env var: comma-separated list of allowed origins.
// Defaults to localhost dev server. In production, set to the Vercel domain.
// Example: ALLOWED_ORIGINS=https://ghost-bazaar.vercel.app,http://localhost:5173
// ---------------------------------------------------------------------------

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? "http://localhost:5173")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean)

app.use("/*", cors({
  origin: ALLOWED_ORIGINS,
  allowMethods: ["GET", "POST", "PUT", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization"],
  exposeHeaders: ["X-Request-Id"],
  credentials: true,
  maxAge: 3600,
}))

// Health check — lightweight, no auth, for load balancers / monitoring
app.get("/health", (c) => c.json({
  status: "ok",
  uptime: Math.floor(process.uptime()),
  sessions: sessionManager.getActiveSessionIds().length,
  listings: listingStore.count(),
}))

// Discovery
app.route("/", createListingsRoute({
  listingStore,
  discover: discoverRegistryAgent,
  onListingAdded: () => {
    statsCollector.setListingCount(listingStore.count())
  },
}))

// Negotiation — write routes (auth via request body signatures)
app.route("/", createRfqRoute(sessionManager))
app.route("/", createOfferRoute({ sessionManager, listingStore }))
app.route("/", createCounterRoute({ sessionManager, verifyBudgetProof }))
app.route("/", createAcceptRoute({ sessionManager, tombstones }))
app.route("/", createQuoteSignRoute({ sessionManager }))
app.route("/", createCosignRoute({ sessionManager }))
app.route("/", createDeclineRoute({ sessionManager, tombstones }))

// Negotiation — read routes (auth via GhostBazaar-Ed25519 header)
app.route("/", createQuoteReadRoute({ sessionManager, authenticateCaller }))
app.route("/", createEventsRoute({ sessionManager, eventStore, connectionTracker, authenticateCaller }))

// Settlement — engine-hosted verification + reporting
app.route("/", createExecuteRoute({
  sessionManager,
  eventStore,
  rpcUrl: SOLANA_RPC_URL,
  usdcMint: USDC_MINT,
}))
app.route("/", createSettleReportRoute({
  sessionManager,
  eventStore,
  rpcUrl: SOLANA_RPC_URL,
  usdcMint: USDC_MINT,
  authenticateCaller,
}))

// Dashboard — public, no auth (Track B)
app.route("/", createDashboardRoute({ statsCollector, broadcaster, eventStore, sessionManager }))

// Admin — session cookie auth
app.route("/", createAdminRoute({ sessionManager, eventStore, statsCollector, broadcaster }))

// Register StatsCollector + EventBroadcaster as the only 2 global append observers.
// All SSE fan-out goes through the broadcaster (1x serialize, Nx string copy).
sessionManager.onAppend((event, session) => statsCollector.onEvent(event, session))
sessionManager.onAppend((event, session) => broadcaster.onEvent(event, session))

// ---------------------------------------------------------------------------
// Deadline Enforcer
// ---------------------------------------------------------------------------

const enforcer = new DeadlineEnforcer({
  sessionManager,
  eventStore,
  connectionTracker,
  tombstones,
  intervalMs: ENFORCER_INTERVAL_MS,
  cosignTimeoutMs: COSIGN_TIMEOUT_MS,
})
enforcer.start()

// ---------------------------------------------------------------------------
// Start Server
// ---------------------------------------------------------------------------

const server = serve({
  fetch: app.fetch,
  port: PORT,
})

console.log(`Ghost Bazaar Engine running on http://localhost:${PORT}`)
console.log(`  Database: ${DATA_DIR}/engine.db`)
console.log(`  Enforcer interval: ${ENFORCER_INTERVAL_MS}ms`)
console.log(`  Cosign timeout: ${COSIGN_TIMEOUT_MS}ms`)

// ---------------------------------------------------------------------------
// Graceful Shutdown
// ---------------------------------------------------------------------------

function shutdown() {
  console.log("Shutting down...")
  enforcer.stop()
  server.close()
  listingStore.close()
  eventStore.close()
  process.exit(0)
}

process.on("SIGTERM", shutdown)
process.on("SIGINT", shutdown)
