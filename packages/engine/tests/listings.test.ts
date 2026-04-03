import { describe, it, expect, beforeEach } from "vitest"
import { Hono } from "hono"
import { createApp } from "../src/app.js"
import { createListingsRoute } from "../src/routes/listings.js"
import { ListingStore } from "../src/registry/listing-store.js"
import { enrichListing, enrichListings } from "../src/registry/listing-enricher.js"
import type { EnrichedListing } from "../src/registry/listing-enricher.js"
import type { DiscoveredAgent } from "@ghost-bazaar/agents"
import { buildDid, signEd25519, objectSigningPayload } from "@ghost-bazaar/core"
import type { Listing } from "@ghost-bazaar/core"
import type { EngineEnv } from "../src/app.js"
import { Keypair, PublicKey } from "@solana/web3.js"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Valid did:key DIDs (real base58-encoded ed25519 multicodec keys)
const SELLER_A_DID = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK"
const SELLER_B_DID = "did:key:z6MkwFKMCxFa3koeWKaEahRbauatWRMnFjE2GhJSpiY7bypz"

const LISTING_A: Listing = {
  listing_id: "listing-001",
  seller: SELLER_A_DID,
  title: "GPT-4 Inference",
  category: "llm",
  service_type: "llm-inference",
  negotiation_endpoint: "https://seller-a.example.com/negotiate",
  payment_endpoint: "https://seller-a.example.com/pay",
  base_terms: { max_tokens: 4096, model: "gpt-4" },
}

const LISTING_B: Listing = {
  listing_id: "listing-002",
  seller: SELLER_B_DID,
  title: "Claude Opus Inference",
  category: "llm",
  service_type: "llm-inference",
  negotiation_endpoint: "https://seller-b.example.com/negotiate",
  payment_endpoint: "https://seller-b.example.com/pay",
  base_terms: { max_tokens: 200000, model: "claude-opus-4-6" },
}

const LISTING_A_REGISTERED: Listing = {
  ...LISTING_A,
  registry_agent_id: "42",
}

const LISTING_B_REGISTERED: Listing = {
  ...LISTING_B,
  registry_agent_id: "43",
}

const REGISTER_SELLER_KP = Keypair.generate()
const REGISTER_SELLER_DID = buildDid(REGISTER_SELLER_KP.publicKey)
const WRONG_SIGNER_KP = Keypair.generate()
const MOCK_REGISTERED_AGENT: DiscoveredAgent = {
  agentId: BigInt(42),
  name: "Registered Seller Agent",
  owner: new PublicKey(new Uint8Array(32)),
  did: REGISTER_SELLER_DID,
  uri: "https://example.com/metadata",
  reputationScore: 91,
  totalFeedbacks: 12,
}

async function makeSignedListing(
  overrides: Partial<Listing> = {},
  signer = REGISTER_SELLER_KP,
): Promise<Listing & { signature: string }> {
  const unsigned: Listing = {
    listing_id: "listing-register-001",
    seller: buildDid(signer.publicKey),
    title: "Registered Audit Service",
    category: "security",
    service_type: "smart-contract-audit",
    negotiation_endpoint: "https://registered-seller.example.com/negotiate",
    payment_endpoint: "https://registered-seller.example.com/execute",
    base_terms: { turnaround: "48h" },
    negotiation_profile: {
      style: "flexible",
      max_rounds: 4,
      accepts_counter: true,
    },
    ...overrides,
  }
  const signature = await signEd25519(objectSigningPayload(unsigned), signer)
  return { ...unsigned, signature }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /listings", () => {
  let app: Hono<EngineEnv>
  let listingStore: ListingStore

  beforeEach(() => {
    listingStore = new ListingStore()
    listingStore.add(LISTING_A)
    listingStore.add(LISTING_B)

    app = createApp() as Hono<EngineEnv>
    app.route("/", createListingsRoute(listingStore))
  })

  describe("GET /listings", () => {
    it("returns all listings", async () => {
      const res = await app.request("/listings")
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.listings).toHaveLength(2)
    })

    it("returns empty array when no listings exist", async () => {
      const emptyStore = new ListingStore()
      const emptyApp = createApp() as Hono<EngineEnv>
      emptyApp.route("/", createListingsRoute(emptyStore))

      const res = await emptyApp.request("/listings")
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.listings).toEqual([])
    })

    it("filters by service_type query param", async () => {
      const res = await app.request("/listings?service_type=llm-inference")
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.listings).toHaveLength(2)
    })

    it("returns empty for non-matching service_type filter", async () => {
      const res = await app.request("/listings?service_type=image-gen")
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.listings).toEqual([])
    })

    it("includes listing fields in response", async () => {
      const res = await app.request("/listings")
      const body = await res.json()
      const listing = body.listings.find(
        (l: Listing) => l.listing_id === "listing-001",
      )
      expect(listing).toBeDefined()
      expect(listing.seller).toBe(LISTING_A.seller)
      expect(listing.title).toBe(LISTING_A.title)
      expect(listing.payment_endpoint).toBe(LISTING_A.payment_endpoint)
    })
  })

  describe("GET /listings/:id", () => {
    it("returns a single listing by ID", async () => {
      const res = await app.request("/listings/listing-001")
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.listing_id).toBe("listing-001")
      expect(body.title).toBe("GPT-4 Inference")
    })

    it("returns 404 for non-existent listing", async () => {
      const res = await app.request("/listings/nonexistent")
      expect(res.status).toBe(404)
      const body = await res.json()
      expect(body.error).toBe("listing_not_found")
    })
  })
})

describe("POST /listings", () => {
  let app: Hono<EngineEnv>
  let listingStore: ListingStore

  beforeEach(() => {
    listingStore = new ListingStore()
    app = createApp() as Hono<EngineEnv>
    app.route("/", createListingsRoute(listingStore))
  })

  it("accepts a valid signed listing and returns 201", async () => {
    const listing = await makeSignedListing()

    const res = await app.request("/listings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(listing),
    })

    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.signature).toBeUndefined()
    expect(body.listing_id).toBe(listing.listing_id)
    expect(body.seller).toBe(REGISTER_SELLER_DID)

    const stored = await app.request(`/listings/${listing.listing_id}`)
    expect(stored.status).toBe(200)
    const storedBody = await stored.json()
    expect(storedBody.signature).toBeUndefined()
    expect(storedBody.listing_id).toBe(listing.listing_id)
  })

  it("rejects unexpected top-level fields instead of persisting forged public metadata", async () => {
    const base = await makeSignedListing({ listing_id: "listing-register-forged" })
    const { signature: _signature, ...unsigned } = base
    const forgedBody = {
      ...unsigned,
      registry: {
        agentId: "999",
        reputationScore: 100,
        totalFeedbacks: 9999,
      },
    }
    const signature = await signEd25519(objectSigningPayload(forgedBody), REGISTER_SELLER_KP)

    const res = await app.request("/listings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...forgedBody, signature }),
    })

    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.error).toBe("invalid_listing")

    const stored = await app.request(`/${["listings", forgedBody.listing_id].join("/")}`)
    expect(stored.status).toBe(404)
  })

  it("rejects malformed JSON", async () => {
    const res = await app.request("/listings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{invalid-json",
    })

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe("malformed_payload")
  })

  it("rejects non-object bodies", async () => {
    const res = await app.request("/listings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(["not", "an", "object"]),
    })

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe("malformed_payload")
  })

  it("rejects missing signature", async () => {
    const listing = await makeSignedListing()
    const { signature: _sig, ...unsigned } = listing

    const res = await app.request("/listings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(unsigned),
    })

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe("malformed_payload")
  })

  it("rejects malformed signature format", async () => {
    const listing = await makeSignedListing()
    const res = await app.request("/listings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...listing, signature: "not-ed25519" }),
    })

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe("malformed_payload")
  })

  it("rejects invalid seller signature", async () => {
    const listing = await makeSignedListing({}, WRONG_SIGNER_KP)
    const bodyWithWrongSeller = { ...listing, seller: REGISTER_SELLER_DID }

    const res = await app.request("/listings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bodyWithWrongSeller),
    })

    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toBe("invalid_seller_signature")
  })

  it("rejects duplicate listing_id", async () => {
    const listing = await makeSignedListing()

    const res1 = await app.request("/listings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(listing),
    })
    expect(res1.status).toBe(201)

    const res2 = await app.request("/listings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(listing),
    })

    expect(res2.status).toBe(409)
    const body = await res2.json()
    expect(body.error).toBe("duplicate_listing")
  })

  it("rejects invalid listing fields", async () => {
    const listing = await makeSignedListing({
      negotiation_endpoint: "http://insecure.example.com/negotiate",
    })

    const res = await app.request("/listings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(listing),
    })

    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.error).toBe("invalid_listing")
  })

  it("calls onListingAdded after successful insert", async () => {
    let count = 0
    const appWithCallback = createApp() as Hono<EngineEnv>
    appWithCallback.route("/", createListingsRoute({
      listingStore,
      onListingAdded: () => { count++ },
    }))

    const listing = await makeSignedListing()
    const res = await appWithCallback.request("/listings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(listing),
    })

    expect(res.status).toBe(201)
    expect(count).toBe(1)
  })

  it("accepts verified registry_agent_id and enriches subsequent reads", async () => {
    const appWithRegistry = createApp() as Hono<EngineEnv>
    appWithRegistry.route("/", createListingsRoute({
      listingStore,
      discover: async (agentId) => agentId === "42" ? MOCK_REGISTERED_AGENT : null,
    }))

    const listing = await makeSignedListing({ registry_agent_id: "42" })
    const createRes = await appWithRegistry.request("/listings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(listing),
    })

    expect(createRes.status).toBe(201)

    const readRes = await appWithRegistry.request(`/listings/${listing.listing_id}`)
    expect(readRes.status).toBe(200)
    const body = await readRes.json()
    expect(body.registry).toBeDefined()
    expect(body.registry.agentId).toBe("42")
    expect(body.registry.reputationScore).toBe(91)
    expect(body.registry.totalFeedbacks).toBe(12)
  })

  it("rejects registry_agent_id when registry discovery is unavailable", async () => {
    const listing = await makeSignedListing({ registry_agent_id: "42" })

    const res = await app.request("/listings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(listing),
    })

    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.error).toBe("registry_unavailable")
  })

  it("rejects malformed registry_agent_id", async () => {
    const appWithRegistry = createApp() as Hono<EngineEnv>
    appWithRegistry.route("/", createListingsRoute({
      listingStore,
      discover: async () => MOCK_REGISTERED_AGENT,
    }))

    const listing = await makeSignedListing({ registry_agent_id: "agent-42" })
    const res = await appWithRegistry.request("/listings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(listing),
    })

    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.error).toBe("invalid_registry_agent_id")
  })

  it("rejects unknown registry_agent_id", async () => {
    const appWithRegistry = createApp() as Hono<EngineEnv>
    appWithRegistry.route("/", createListingsRoute({
      listingStore,
      discover: async () => null,
    }))

    const listing = await makeSignedListing({ registry_agent_id: "42" })
    const res = await appWithRegistry.request("/listings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(listing),
    })

    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.error).toBe("invalid_registry_agent_id")
  })

  it("rejects registry_agent_id whose discovered DID does not match seller", async () => {
    const appWithRegistry = createApp() as Hono<EngineEnv>
    appWithRegistry.route("/", createListingsRoute({
      listingStore,
      discover: async () => ({ ...MOCK_REGISTERED_AGENT, did: SELLER_B_DID }),
    }))

    const listing = await makeSignedListing({ registry_agent_id: "42" })
    const res = await appWithRegistry.request("/listings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(listing),
    })

    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.error).toBe("registry_did_mismatch")
  })

  it("rejects registry_agent_id when discovered agent id does not match the requested binding", async () => {
    const appWithRegistry = createApp() as Hono<EngineEnv>
    appWithRegistry.route("/", createListingsRoute({
      listingStore,
      discover: async () => ({ ...MOCK_REGISTERED_AGENT, agentId: BigInt(99) }),
    }))

    const listing = await makeSignedListing({ registry_agent_id: "42" })
    const res = await appWithRegistry.request("/listings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(listing),
    })

    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.error).toBe("invalid_registry_agent_id")
  })
})

describe("ListingStore", () => {
  let store: ListingStore

  beforeEach(() => {
    store = new ListingStore()
  })

  it("add + getAll returns all listings", () => {
    store.add(LISTING_A)
    store.add(LISTING_B)
    expect(store.getAll()).toHaveLength(2)
  })

  it("getById returns correct listing", () => {
    store.add(LISTING_A)
    expect(store.getById("listing-001")).toEqual(LISTING_A)
  })

  it("getById returns undefined for missing ID", () => {
    expect(store.getById("missing")).toBeUndefined()
  })

  it("getAll returns a copy (immutability)", () => {
    store.add(LISTING_A)
    const list1 = store.getAll()
    const list2 = store.getAll()
    expect(list1).not.toBe(list2)
    expect(list1).toEqual(list2)
  })

  it("filterByServiceType returns matching listings", () => {
    store.add(LISTING_A)
    store.add(LISTING_B)
    expect(store.filterByServiceType("llm-inference")).toHaveLength(2)
    expect(store.filterByServiceType("image-gen")).toHaveLength(0)
  })

  it("rejects duplicate listing_id", () => {
    store.add(LISTING_A)
    expect(() => store.add(LISTING_A)).toThrow(/duplicate/)
  })

  // --- findAllBySeller / findBySellerAndId ---

  it("findAllBySeller returns all listings for a seller", () => {
    const listing2 = { ...LISTING_B, listing_id: "listing-003", seller: SELLER_A_DID }
    store.add(LISTING_A)
    store.add(listing2)
    expect(store.findAllBySeller(SELLER_A_DID)).toHaveLength(2)
  })

  it("findAllBySeller returns empty for unknown seller", () => {
    store.add(LISTING_A)
    expect(store.findAllBySeller("did:key:unknown")).toHaveLength(0)
  })

  it("findBySellerAndId returns correct listing", () => {
    store.add(LISTING_A)
    store.add(LISTING_B)
    expect(store.findBySellerAndId(LISTING_A.seller, "listing-001")).toEqual(LISTING_A)
  })

  it("findBySellerAndId returns undefined when seller doesn't match", () => {
    store.add(LISTING_A)
    expect(store.findBySellerAndId(LISTING_B.seller, "listing-001")).toBeUndefined()
  })

  it("findBySellerAndId returns undefined for unknown listing_id", () => {
    store.add(LISTING_A)
    expect(store.findBySellerAndId(LISTING_A.seller, "nonexistent")).toBeUndefined()
  })

  // --- Validation ---

  it("rejects listing with invalid seller DID", () => {
    expect(() =>
      store.add({ ...LISTING_A, listing_id: "new", seller: "not-a-did" }),
    ).toThrow(/did:key/)
  })

  it("rejects listing with HTTP (non-HTTPS) payment_endpoint", () => {
    expect(() =>
      store.add({ ...LISTING_A, listing_id: "new", payment_endpoint: "http://evil.com/pay" }),
    ).toThrow(/HTTPS/)
  })

  it("rejects listing with HTTP negotiation_endpoint", () => {
    expect(() =>
      store.add({ ...LISTING_A, listing_id: "new", negotiation_endpoint: "http://evil.com/neg" }),
    ).toThrow(/HTTPS/)
  })

  it("rejects listing with empty service_type", () => {
    expect(() =>
      store.add({ ...LISTING_A, listing_id: "new", service_type: "" }),
    ).toThrow(/service_type/)
  })
})

// ---------------------------------------------------------------------------
// Enricher
// ---------------------------------------------------------------------------

describe("enrichListing", () => {
  const MOCK_AGENT: DiscoveredAgent = {
    agentId: BigInt(42),
    name: "Test Agent",
    owner: new PublicKey(new Uint8Array(32)),
    did: LISTING_A.seller,
    uri: "https://example.com/metadata",
    reputationScore: 85,
    totalFeedbacks: 10,
  }

  it("enriches listing with registry data when agent found", async () => {
    const discover = async () => MOCK_AGENT
    const result = await enrichListing(LISTING_A_REGISTERED, discover) as EnrichedListing
    expect(result.registry).toBeDefined()
    expect(result.registry!.agentId).toBe("42")
    expect(result.registry!.name).toBe("Test Agent")
    expect(result.registry!.reputationScore).toBe(85)
    expect(result.registry!.totalFeedbacks).toBe(10)
  })

  it("returns listing unchanged when agent not found", async () => {
    const discover = async () => null
    const result = await enrichListing(LISTING_A_REGISTERED, discover)
    expect((result as EnrichedListing).registry).toBeUndefined()
  })

  it("returns listing unchanged when discover throws", async () => {
    const discover = async () => { throw new Error("RPC down") }
    const result = await enrichListing(LISTING_A_REGISTERED, discover)
    expect((result as EnrichedListing).registry).toBeUndefined()
  })

  it("strips HTML from agent name", async () => {
    const discover = async () => ({
      ...MOCK_AGENT,
      name: "<script>alert('xss')</script>Good Agent",
    })
    const result = await enrichListing(LISTING_A_REGISTERED, discover) as EnrichedListing
    expect(result.registry!.name).not.toContain("<script>")
    expect(result.registry!.name).toContain("Good Agent")
  })

  it("strips HTML entities from agent name", async () => {
    const discover = async () => ({
      ...MOCK_AGENT,
      name: "&lt;script&gt;alert(1)&lt;/script&gt;OK",
    })
    const result = await enrichListing(LISTING_A_REGISTERED, discover) as EnrichedListing
    expect(result.registry!.name).not.toContain("&lt;")
    expect(result.registry!.name).not.toContain("&gt;")
    // After entity stripping: "scriptalert(1)/scriptOK"
    expect(result.registry!.name).toBe("scriptalert(1)/scriptOK")
  })

  it("clamps reputation score to [0, 100]", async () => {
    const discover = async () => ({ ...MOCK_AGENT, reputationScore: 150 })
    const result = await enrichListing(LISTING_A_REGISTERED, discover) as EnrichedListing
    expect(result.registry!.reputationScore).toBe(100)

    const discover2 = async () => ({ ...MOCK_AGENT, reputationScore: -50 })
    const result2 = await enrichListing(LISTING_A_REGISTERED, discover2) as EnrichedListing
    expect(result2.registry!.reputationScore).toBe(0)
  })

  it("clamps negative totalFeedbacks to 0", async () => {
    const discover = async () => ({ ...MOCK_AGENT, totalFeedbacks: -5 })
    const result = await enrichListing(LISTING_A_REGISTERED, discover) as EnrichedListing
    expect(result.registry!.totalFeedbacks).toBe(0)
  })

  it("does NOT include uri in enrichment (SSRF prevention)", async () => {
    const discover = async () => MOCK_AGENT
    const result = await enrichListing(LISTING_A_REGISTERED, discover) as EnrichedListing
    expect(result.registry).toBeDefined()
    expect((result.registry as Record<string, unknown>)["uri"]).toBeUndefined()
  })

  it("does not enrich listings without a persisted registry_agent_id", async () => {
    const discover = async () => MOCK_AGENT
    const result = await enrichListing(LISTING_A, discover)
    expect((result as EnrichedListing).registry).toBeUndefined()
  })

  it("does not enrich listings when discovered agent id mismatches the persisted registry_agent_id", async () => {
    const discover = async () => ({ ...MOCK_AGENT, agentId: BigInt(99) })
    const result = await enrichListing(LISTING_A_REGISTERED, discover)
    expect((result as EnrichedListing).registry).toBeUndefined()
  })
})

describe("enrichListings (batch)", () => {
  it("enriches multiple listings in parallel", async () => {
    const discover = async (agentId: string) => ({
      agentId: BigInt(agentId),
      name: `Agent ${agentId}`,
      owner: new PublicKey(new Uint8Array(32)),
      did: agentId === "42" ? LISTING_A.seller : LISTING_B.seller,
      uri: "https://example.com",
      reputationScore: 50,
      totalFeedbacks: 5,
    })
    const results = await enrichListings([LISTING_A_REGISTERED, LISTING_B_REGISTERED], discover)
    expect(results).toHaveLength(2)
    expect((results[0] as EnrichedListing).registry).toBeDefined()
    expect((results[1] as EnrichedListing).registry).toBeDefined()
  })
})
