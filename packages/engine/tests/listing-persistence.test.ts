import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { Listing } from "@ghost-bazaar/core"

const SELLER_DID = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK"

const LISTING_A: Listing = {
  listing_id: "listing-persist-001",
  seller: SELLER_DID,
  title: "Persistent Audit Listing",
  category: "security",
  service_type: "smart-contract-audit",
  negotiation_endpoint: "https://seller.example.com/negotiate",
  payment_endpoint: "https://seller.example.com/execute",
  base_terms: { turnaround: "48h", coverage: "full" },
  negotiation_profile: {
    style: "flexible",
    max_rounds: 4,
    accepts_counter: true,
  },
}

const LISTING_WITH_REGISTRY: Listing = {
  ...LISTING_A,
  listing_id: "listing-persist-003",
  registry_agent_id: "42",
}

const tempDirs: string[] = []

function makeDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "ghost-bazaar-listings-"))
  tempDirs.push(dir)
  return join(dir, "listings.db")
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe("SqliteListingStore", () => {
  it("persists listings across repository reopen", async () => {
    const { SqliteListingStore } = await import("../src/registry/sqlite-listing-store.js")
    const dbPath = makeDbPath()

    const store1 = new SqliteListingStore(dbPath)
    store1.add(LISTING_A)
    store1.close()

    const store2 = new SqliteListingStore(dbPath)
    expect(store2.getById(LISTING_A.listing_id)).toEqual(LISTING_A)
    expect(store2.getAll()).toEqual([LISTING_A])
    store2.close()
  })

  it("inserts seed listings only when missing", async () => {
    const { SqliteListingStore } = await import("../src/registry/sqlite-listing-store.js")
    const { seedListingsIfMissing } = await import("../src/registry/listing-bootstrap.js")
    const dbPath = makeDbPath()

    const listingB: Listing = {
      ...LISTING_A,
      listing_id: "listing-persist-002",
      title: "Persistent Inference Listing",
      service_type: "llm-inference",
      negotiation_endpoint: "https://seller.example.com/inference/negotiate",
      payment_endpoint: "https://seller.example.com/inference/execute",
    }

    const store1 = new SqliteListingStore(dbPath)
    seedListingsIfMissing(store1, [LISTING_A, listingB])
    expect(store1.getAll()).toHaveLength(2)
    store1.close()

    const store2 = new SqliteListingStore(dbPath)
    seedListingsIfMissing(store2, [LISTING_A, listingB])
    expect(store2.getAll()).toHaveLength(2)
    expect(store2.getAll()).toEqual([LISTING_A, listingB])
    store2.close()
  })

  it("preserves registry_agent_id across repository reopen", async () => {
    const { SqliteListingStore } = await import("../src/registry/sqlite-listing-store.js")
    const dbPath = makeDbPath()

    const store1 = new SqliteListingStore(dbPath)
    store1.add(LISTING_WITH_REGISTRY)
    store1.close()

    const store2 = new SqliteListingStore(dbPath)
    expect(store2.getById(LISTING_WITH_REGISTRY.listing_id)).toEqual(LISTING_WITH_REGISTRY)
    store2.close()
  })

  it("rejects malformed registry_agent_id during storage", async () => {
    const { SqliteListingStore } = await import("../src/registry/sqlite-listing-store.js")
    const dbPath = makeDbPath()

    const store = new SqliteListingStore(dbPath)
    expect(() =>
      store.add({ ...LISTING_A, listing_id: "listing-persist-bad-registry", registry_agent_id: "agent-42" }),
    ).toThrow(/registry_agent_id/i)
    store.close()
  })

  it("supports seller lookups after repository reopen", async () => {
    const { SqliteListingStore } = await import("../src/registry/sqlite-listing-store.js")
    const dbPath = makeDbPath()

    const listingB: Listing = {
      ...LISTING_A,
      listing_id: "listing-persist-004",
      title: "Second Seller Listing",
      service_type: "llm-inference",
      negotiation_endpoint: "https://seller.example.com/second/negotiate",
      payment_endpoint: "https://seller.example.com/second/execute",
    }

    const store1 = new SqliteListingStore(dbPath)
    store1.add(LISTING_A)
    store1.add(listingB)
    store1.close()

    const store2 = new SqliteListingStore(dbPath)
    expect(store2.findAllBySeller(SELLER_DID)).toEqual([LISTING_A, listingB])
    expect(store2.findBySellerAndId(SELLER_DID, listingB.listing_id)).toEqual(listingB)
    store2.close()
  })

  it("treats duplicate-on-insert during bootstrap as already seeded", async () => {
    const { seedListingsIfMissing } = await import("../src/registry/listing-bootstrap.js")

    const fakeStore = {
      getById: vi.fn().mockReturnValue(undefined),
      add: vi.fn().mockImplementation(() => {
        throw new Error(`ListingStore: duplicate listing_id "${LISTING_A.listing_id}"`)
      }),
    }

    expect(() =>
      seedListingsIfMissing(fakeStore as any, [LISTING_A]),
    ).not.toThrow()
    expect(fakeStore.add).toHaveBeenCalledTimes(1)
  })
})
