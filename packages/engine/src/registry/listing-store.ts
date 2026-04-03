import { didToPublicKey, type Listing } from "@ghost-bazaar/core"

function deepFreeze<T extends object>(obj: T): Readonly<T> {
  const frozen = Object.freeze(obj)
  for (const val of Object.values(frozen)) {
    if (val !== null && typeof val === "object" && !Object.isFrozen(val)) {
      deepFreeze(val as object)
    }
  }
  return frozen
}

// ---------------------------------------------------------------------------
// ListingStore — in-memory listing storage
//
// Simple Map-based store for seller listings. Listings are registered
// by sellers and discoverable by buyers via GET /listings.
// ---------------------------------------------------------------------------

/** Maximum number of listings to prevent unbounded growth / DoS. */
const MAX_LISTINGS = 10_000

/** HTTPS URL format */
const HTTPS_URL_RE = /^https:\/\/.+/

function normalizeRegistryAgentIdForStorage(agentId: string): string {
  if (typeof agentId !== "string" || agentId.trim() === "") {
    throw new Error("ListingStore: registry_agent_id must be a non-empty decimal string")
  }
  if (!/^[0-9]+$/.test(agentId)) {
    throw new Error("ListingStore: registry_agent_id must be a decimal string")
  }

  const parsed = BigInt(agentId)
  if (parsed <= 0n) {
    throw new Error("ListingStore: registry_agent_id must be positive")
  }

  return parsed.toString()
}

export function isDuplicateListingError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return message.includes("duplicate listing_id")
}

/**
 * Basic runtime validation for listing fields.
 * Prevents injection, payment redirection, and malformed data.
 */
export function normalizeListingForStorage(listing: Listing): Listing {
  if (!listing.listing_id || typeof listing.listing_id !== "string") {
    throw new Error("ListingStore: listing_id is required")
  }
  if (!didToPublicKey(listing.seller)) {
    throw new Error(`ListingStore: seller must be a valid did:key DID, got "${listing.seller}"`)
  }
  if (!HTTPS_URL_RE.test(listing.negotiation_endpoint)) {
    throw new Error("ListingStore: negotiation_endpoint must be an HTTPS URL")
  }
  if (!HTTPS_URL_RE.test(listing.payment_endpoint)) {
    throw new Error("ListingStore: payment_endpoint must be an HTTPS URL")
  }
  if (!listing.service_type || typeof listing.service_type !== "string") {
    throw new Error("ListingStore: service_type is required")
  }

  return listing.registry_agent_id !== undefined
    ? {
      ...listing,
      registry_agent_id: normalizeRegistryAgentIdForStorage(listing.registry_agent_id),
    }
    : listing
}

export class ListingStore {
  private readonly listings = new Map<string, Listing>()

  add(listing: Listing): void {
    if (this.listings.size >= MAX_LISTINGS) {
      throw new Error(`ListingStore: capacity limit reached (${MAX_LISTINGS})`)
    }
    const normalized = normalizeListingForStorage(listing)
    if (this.listings.has(normalized.listing_id)) {
      throw new Error(`ListingStore: duplicate listing_id "${normalized.listing_id}"`)
    }
    // Deep clone + freeze for full immutability (nested objects like base_terms)
    this.listings.set(normalized.listing_id, deepFreeze(structuredClone(normalized)))
  }

  count(): number {
    return this.listings.size
  }

  getById(listingId: string): Listing | undefined {
    return this.listings.get(listingId)
  }

  getAll(): readonly Listing[] {
    return [...this.listings.values()]
  }

  filterByServiceType(serviceType: string): readonly Listing[] {
    return [...this.listings.values()].filter(
      (l) => l.service_type === serviceType,
    )
  }

  /** Find all listings by seller DID */
  findAllBySeller(sellerDid: string): readonly Listing[] {
    return [...this.listings.values()].filter((l) => l.seller === sellerDid)
  }

  /**
   * Find the specific listing a seller offer is associated with.
   * Step 8 payment_endpoint provenance: resolves by seller DID + listing_id
   * to ensure the correct payment_endpoint for multi-listing sellers.
   */
  findBySellerAndId(sellerDid: string, listingId: string): Listing | undefined {
    const listing = this.listings.get(listingId)
    if (listing && listing.seller === sellerDid) return listing
    return undefined
  }
}
