import type { Listing } from "@ghost-bazaar/core"
import { isDuplicateListingError, type ListingStore } from "./listing-store.js"

export function seedListingsIfMissing(
  listingStore: ListingStore,
  seedListings: readonly Listing[],
): number {
  let inserted = 0
  for (const listing of seedListings) {
    if (!listingStore.getById(listing.listing_id)) {
      try {
        listingStore.add(listing)
        inserted++
      } catch (err) {
        if (isDuplicateListingError(err)) continue
        throw err
      }
    }
  }
  return inserted
}
