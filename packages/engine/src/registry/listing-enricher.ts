import type { Listing } from "@ghost-bazaar/core"
import type { DiscoveredAgent } from "@ghost-bazaar/agents"
import { normalizeRegistryAgentId } from "./registry-binding.js"

// ---------------------------------------------------------------------------
// Listing Enricher — augments listings with 8004 Agent Registry data
//
// Best-effort: if discovery fails (no RPC, agent not registered), the
// listing is returned without the `registry` field. No hard dependency.
//
// SECURITY (plan M5): Registry data is from an external source (on-chain).
// All fields are sanitized before inclusion in the response:
// - HTML stripped from string fields
// - URLs validated (https only)
// - Reputation scores clamped to [0, 100]
// ---------------------------------------------------------------------------

/** Registry enrichment data attached to a listing. */
export interface RegistryEnrichment {
  readonly agentId: string // bigint serialized as string for JSON
  readonly name: string
  readonly reputationScore: number | null
  readonly totalFeedbacks: number
}

/** A listing with optional registry enrichment. */
export type EnrichedListing = Listing & {
  readonly registry?: RegistryEnrichment
}

// ---------------------------------------------------------------------------
// Sanitization helpers
// ---------------------------------------------------------------------------

/** Max length for sanitized string fields from on-chain data. */
const MAX_NAME_LENGTH = 200

/**
 * Sanitize a string from on-chain data.
 * Strips all HTML (including malformed/unclosed tags), HTML entities,
 * and truncates to a safe length. Only allows printable characters.
 */
function sanitizeString(input: string): string {
  return input
    .replace(/<[^>]*>?/g, "") // Strip HTML tags (including unclosed)
    .replace(/&[a-zA-Z0-9#]+;/g, "") // Strip HTML entities
    .replace(/[^\x20-\x7E\u00A0-\uFFFF]/g, "") // Only printable chars
    .trim()
    .slice(0, MAX_NAME_LENGTH)
}

/** Clamp a number to [min, max]. */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

// ---------------------------------------------------------------------------
// Enrichment
// ---------------------------------------------------------------------------

/**
 * Enrich a listing with 8004 registry data.
 * Returns the listing unchanged if discovery fails or agent is not found.
 *
 * @param listing - The listing to enrich
 * @param discover - Discovery function (injected for testability)
 */
export async function enrichListing(
  listing: Listing,
  discover: (agentId: string) => Promise<DiscoveredAgent | null>,
): Promise<EnrichedListing> {
  if (!listing.registry_agent_id) return listing

  try {
    const agentId = normalizeRegistryAgentId(listing.registry_agent_id)
    const agent = await discover(agentId)
    if (!agent) return listing
    if (agent.agentId.toString() !== agentId) return listing
    if (agent.did !== listing.seller) return listing

    const enrichment: RegistryEnrichment = {
      agentId: agent.agentId.toString(),
      // NOTE: agent.uri intentionally excluded from enrichment response.
      // Exposing on-chain URIs to HTTP clients creates an SSRF vector (plan M5).
      // URI is only used internally by the 8004-solana SDK for metadata resolution.
      name: sanitizeString(agent.name),
      reputationScore:
        agent.reputationScore !== null
          ? clamp(agent.reputationScore, 0, 100)
          : null,
      totalFeedbacks: Math.max(0, agent.totalFeedbacks),
    }

    return { ...listing, registry: enrichment }
  } catch {
    // Best-effort: return listing without registry data on any error
    return listing
  }
}

/**
 * Enrich multiple listings in parallel.
 * Each enrichment is independent — one failure does not affect others.
 */
export async function enrichListings(
  listings: readonly Listing[],
  discover: (agentId: string) => Promise<DiscoveredAgent | null>,
): Promise<readonly EnrichedListing[]> {
  return Promise.all(listings.map((l) => enrichListing(l, discover)))
}
