import { describe, it, expect } from "vitest"
import { PublicKey } from "@solana/web3.js"
import type { Listing } from "@ghost-bazaar/core"
import type { DiscoveredAgent } from "@ghost-bazaar/agents"
import { ListingStore } from "../src/registry/listing-store.js"
import { buildBuyerRegistrySignals } from "../src/strategy/buyer-registry-signals.js"

const SELLER_A_DID = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK"
const SELLER_B_DID = "did:key:z6MkwFKMCxFa3koeWKaEahRbauatWRMnFjE2GhJSpiY7bypz"

const LISTING_A: Listing = {
  listing_id: "listing-001",
  seller: SELLER_A_DID,
  registry_agent_id: "42",
  title: "GPT-4 Inference",
  category: "llm",
  service_type: "llm-inference",
  negotiation_endpoint: "https://seller-a.example.com/negotiate",
  payment_endpoint: "https://seller-a.example.com/pay",
  base_terms: {},
}

const LISTING_B: Listing = {
  listing_id: "listing-002",
  seller: SELLER_B_DID,
  title: "Claude Opus Inference",
  category: "llm",
  service_type: "llm-inference",
  negotiation_endpoint: "https://seller-b.example.com/negotiate",
  payment_endpoint: "https://seller-b.example.com/pay",
  base_terms: {},
}

const DISCOVERED_AGENT: DiscoveredAgent = {
  agentId: BigInt(42),
  name: "Registered Seller Agent",
  owner: new PublicKey(new Uint8Array(32)),
  did: SELLER_A_DID,
  uri: "https://example.com/metadata",
  reputationScore: 91,
  totalFeedbacks: 12,
}

describe("buildBuyerRegistrySignals", () => {
  it("maps seller DID to verified registry summary", async () => {
    const listingStore = new ListingStore()
    listingStore.add(LISTING_A)
    listingStore.add(LISTING_B)

    const signals = await buildBuyerRegistrySignals(
      [
        { seller: SELLER_A_DID, listing_id: "listing-001" },
        { seller: SELLER_B_DID, listing_id: "listing-002" },
      ] as any,
      listingStore,
      async (agentId) => agentId === "42" ? DISCOVERED_AGENT : null,
    )

    expect(signals).toEqual({
      [SELLER_A_DID]: {
        agentId: "42",
        reputationScore: 91,
        totalFeedbacks: 12,
      },
    })
  })

  it("normalizes persisted registry_agent_id before discovery", async () => {
    const listingStore = new ListingStore()
    listingStore.add({ ...LISTING_A, listing_id: "listing-003", registry_agent_id: "042" })

    const discover = async (agentId: string) => agentId === "42" ? DISCOVERED_AGENT : null

    const signals = await buildBuyerRegistrySignals(
      [{ seller: SELLER_A_DID, listing_id: "listing-003" }] as any,
      listingStore,
      discover,
    )

    expect(signals[SELLER_A_DID]).toEqual({
      agentId: "42",
      reputationScore: 91,
      totalFeedbacks: 12,
    })
  })

  it("ignores discovery results whose returned agent id does not match the requested registry_agent_id", async () => {
    const listingStore = new ListingStore()
    listingStore.add(LISTING_A)

    const signals = await buildBuyerRegistrySignals(
      [{ seller: SELLER_A_DID, listing_id: "listing-001" }] as any,
      listingStore,
      async () => ({ ...DISCOVERED_AGENT, agentId: BigInt(99) }),
    )

    expect(signals).toEqual({})
  })
})
