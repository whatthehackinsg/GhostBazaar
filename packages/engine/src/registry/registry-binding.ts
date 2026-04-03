import type { DiscoveredAgent } from "@ghost-bazaar/agents"
import { EngineError } from "../middleware/error-handler.js"

export type DiscoverRegistryAgentFn = (agentId: string) => Promise<DiscoveredAgent | null>

export function normalizeRegistryAgentId(agentId: string): string {
  if (typeof agentId !== "string" || agentId.trim() === "") {
    throw new EngineError(422, "invalid_registry_agent_id", "registry_agent_id must be a non-empty decimal string")
  }
  if (!/^[0-9]+$/.test(agentId)) {
    throw new EngineError(422, "invalid_registry_agent_id", "registry_agent_id must be a decimal string")
  }

  const parsed = BigInt(agentId)
  if (parsed <= 0n) {
    throw new EngineError(422, "invalid_registry_agent_id", "registry_agent_id must be positive")
  }

  return parsed.toString()
}

export async function verifyRegistryAgentBinding(
  registryAgentId: string | undefined,
  sellerDid: string,
  discover?: DiscoverRegistryAgentFn,
): Promise<string | undefined> {
  if (registryAgentId === undefined) return undefined
  if (!discover) {
    throw new EngineError(503, "registry_unavailable", "Registry discovery is not configured")
  }

  const normalizedAgentId = normalizeRegistryAgentId(registryAgentId)

  let discovered: DiscoveredAgent | null
  try {
    discovered = await discover(normalizedAgentId)
  } catch {
    throw new EngineError(503, "registry_unavailable", "Registry discovery is unavailable")
  }

  if (!discovered) {
    throw new EngineError(422, "invalid_registry_agent_id", "Registry agent not found")
  }
  if (discovered.agentId.toString() !== normalizedAgentId) {
    throw new EngineError(422, "invalid_registry_agent_id", "Registry agent id does not match requested binding")
  }
  if (discovered.did !== sellerDid) {
    throw new EngineError(422, "registry_did_mismatch", "Registry agent DID does not match listing seller")
  }

  return normalizedAgentId
}
