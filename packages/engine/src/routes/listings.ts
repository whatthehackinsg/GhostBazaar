import { Hono } from "hono"
import type { Listing } from "@ghost-bazaar/core"
import type { EngineEnv } from "../app.js"
import type { ListingStore } from "../registry/listing-store.js"
import { enrichListing, enrichListings } from "../registry/listing-enricher.js"
import { verifyRegistryAgentBinding } from "../registry/registry-binding.js"
import type { DiscoverRegistryAgentFn } from "../registry/registry-binding.js"
import { EngineError } from "../middleware/error-handler.js"
import { preCheckSignatureFormat, verifySignature } from "../middleware/validate-signature.js"

// ---------------------------------------------------------------------------
// Discovery Routes — GET /listings, GET /listings/:id
//
// Per Spec §8 Discovery: read-only endpoints for seller service discovery.
// No authentication required (public discovery).
// Optional 8004 registry enrichment adds reputation data.
// ---------------------------------------------------------------------------

export interface ListingsRouteConfig {
  readonly listingStore: ListingStore
  /** Optional 8004 discovery by persisted registry agent id. */
  readonly discover?: DiscoverRegistryAgentFn
  /** Optional callback after a listing is successfully added. */
  readonly onListingAdded?: () => void
}

type SignedListingRegistration = Listing & { signature: string }

const ALLOWED_LISTING_REGISTRATION_FIELDS = new Set([
  "listing_id",
  "seller",
  "title",
  "category",
  "service_type",
  "negotiation_endpoint",
  "payment_endpoint",
  "base_terms",
  "negotiation_profile",
  "registry_agent_id",
  "signature",
])

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function validateListingRegistrationShape(body: Record<string, unknown>): void {
  for (const field of Object.keys(body)) {
    if (!ALLOWED_LISTING_REGISTRATION_FIELDS.has(field)) {
      throw new EngineError(422, "invalid_listing", `Unexpected field "${field}" in listing registration`)
    }
  }

  const requiredStrings = [
    "listing_id",
    "seller",
    "title",
    "category",
    "service_type",
    "negotiation_endpoint",
    "payment_endpoint",
  ] as const

  for (const field of requiredStrings) {
    if (typeof body[field] !== "string" || (body[field] as string).trim() === "") {
      throw new EngineError(422, "invalid_listing", `${field} must be a non-empty string`)
    }
  }

  if (!isPlainObject(body.base_terms)) {
    throw new EngineError(422, "invalid_listing", "base_terms must be an object")
  }

  if (body.registry_agent_id !== undefined && typeof body.registry_agent_id !== "string") {
    throw new EngineError(422, "invalid_listing", "registry_agent_id must be a string when provided")
  }

  if (body.negotiation_profile !== undefined) {
    if (!isPlainObject(body.negotiation_profile)) {
      throw new EngineError(422, "invalid_listing", "negotiation_profile must be an object")
    }
    const profile = body.negotiation_profile
    const allowedStyles = new Set(["firm", "flexible", "competitive", "deadline-sensitive"])
    if (typeof profile.style !== "string" || !allowedStyles.has(profile.style)) {
      throw new EngineError(422, "invalid_listing", "negotiation_profile.style is invalid")
    }
    if (
      profile.max_rounds !== undefined &&
      (typeof profile.max_rounds !== "number" ||
        !Number.isInteger(profile.max_rounds) ||
        profile.max_rounds <= 0)
    ) {
      throw new EngineError(422, "invalid_listing", "negotiation_profile.max_rounds must be a positive integer")
    }
    if (
      profile.accepts_counter !== undefined &&
      typeof profile.accepts_counter !== "boolean"
    ) {
      throw new EngineError(422, "invalid_listing", "negotiation_profile.accepts_counter must be boolean")
    }
  }
}

function buildListingForStorage(
  body: Record<string, unknown>,
  verifiedRegistryAgentId: string | undefined,
): Listing {
  const listing: Listing = {
    listing_id: body.listing_id as string,
    seller: body.seller as string,
    title: body.title as string,
    category: body.category as string,
    service_type: body.service_type as string,
    negotiation_endpoint: body.negotiation_endpoint as string,
    payment_endpoint: body.payment_endpoint as string,
    base_terms: structuredClone(body.base_terms as Record<string, unknown>),
  }

  if (body.negotiation_profile !== undefined) {
    listing.negotiation_profile = structuredClone(body.negotiation_profile as Record<string, unknown>) as Listing["negotiation_profile"]
  }

  if (verifiedRegistryAgentId !== undefined) {
    listing.registry_agent_id = verifiedRegistryAgentId
  }

  return listing
}

function mapListingStoreError(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err)
  if (message.includes("duplicate listing_id")) {
    throw new EngineError(409, "duplicate_listing", message)
  }
  if (message.includes("capacity limit reached")) {
    throw new EngineError(503, "capacity_exceeded", message)
  }
  if (message.startsWith("ListingStore:")) {
    throw new EngineError(422, "invalid_listing", message)
  }
  throw err instanceof Error ? err : new Error(message)
}

export function createListingsRoute(
  config: ListingsRouteConfig | ListingStore,
): Hono<EngineEnv> {
  // Accept both config object and bare ListingStore for backward compat
  const { listingStore, discover, onListingAdded } =
    config instanceof Object && "listingStore" in config
      ? config
      : { listingStore: config, discover: undefined, onListingAdded: undefined }

  const router = new Hono<EngineEnv>()

  // POST /listings — seller registration with signed body
  router.post("/listings", async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      throw new EngineError(400, "malformed_payload", "Invalid JSON body")
    }

    if (!isPlainObject(body)) {
      throw new EngineError(400, "malformed_payload", "Listing body must be a plain object")
    }

    if (typeof body.signature !== "string") {
      throw new EngineError(400, "malformed_payload", "Missing or invalid signature")
    }

    validateListingRegistrationShape(body)
    preCheckSignatureFormat(body.signature, body.seller as string)

    await verifySignature(
      body,
      body.signature,
      body.seller as string,
      "invalid_seller_signature",
    )

    const signedBody = body as unknown as SignedListingRegistration
    const verifiedRegistryAgentId = await verifyRegistryAgentBinding(
      signedBody.registry_agent_id,
      signedBody.seller,
      discover,
    )
    const listing = buildListingForStorage(body, verifiedRegistryAgentId)
    try {
      listingStore.add(listing)
    } catch (err) {
      mapListingStoreError(err)
    }

    onListingAdded?.()
    return c.json(listing, 201)
  })

  // GET /listings — list all listings, optional service_type filter
  router.get("/listings", async (c) => {
    const serviceType = c.req.query("service_type")
    const listings = serviceType
      ? listingStore.filterByServiceType(serviceType)
      : listingStore.getAll()

    // Enrich with 8004 registry data if discover function is provided
    const result = discover
      ? await enrichListings(listings, discover)
      : listings

    return c.json({ listings: result })
  })

  // GET /listings/:id — get single listing by ID, optionally enriched
  router.get("/listings/:id", async (c) => {
    const listing = listingStore.getById(c.req.param("id"))
    if (!listing) {
      throw new EngineError(404, "listing_not_found", "Listing not found")
    }
    const result = discover
      ? await enrichListing(listing, discover)
      : listing
    return c.json(result)
  })

  return router
}
