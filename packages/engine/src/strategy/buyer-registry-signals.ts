import type { DiscoveredAgent } from "@ghost-bazaar/agents"
import type { ListingStore } from "../registry/listing-store.js"
import { normalizeRegistryAgentId } from "../registry/registry-binding.js"

export interface BuyerRegistrySignal {
  readonly agentId?: string
  readonly reputationScore: number | null
  readonly totalFeedbacks: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

export async function buildBuyerRegistrySignals(
  offers: ReadonlyArray<{ readonly seller: string; readonly listing_id: string }>,
  listingStore: Pick<ListingStore, "findBySellerAndId">,
  discover: (agentId: string) => Promise<DiscoveredAgent | null>,
): Promise<Record<string, BuyerRegistrySignal>> {
  const signals: Record<string, BuyerRegistrySignal> = {}

  for (const offer of offers) {
    if (signals[offer.seller]) continue

    const listing = listingStore.findBySellerAndId(offer.seller, offer.listing_id)
    if (!listing?.registry_agent_id) continue

    try {
      const agentId = normalizeRegistryAgentId(listing.registry_agent_id)
      const discovered = await discover(agentId)
      if (!discovered) continue
      if (discovered.agentId.toString() !== agentId) continue
      if (discovered.did !== offer.seller) continue

      signals[offer.seller] = {
        agentId: discovered.agentId.toString(),
        reputationScore:
          discovered.reputationScore !== null
            ? clamp(discovered.reputationScore, 0, 100)
            : null,
        totalFeedbacks: Math.max(0, discovered.totalFeedbacks),
      }
    } catch {
      // Best-effort: registry lookup failure should not break buyer decision flow.
    }
  }

  return signals
}
