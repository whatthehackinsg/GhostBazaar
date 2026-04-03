/**
 * Ghost Bazaar Agent Registry — 8004-Solana integration.
 *
 * Bridges Ghost Bazaar agent identity (did:key from Solana keypairs) with the
 * on-chain ERC-8004 Agent Registry on Solana. Provides registration,
 * discovery, and reputation feedback helpers.
 *
 * @see https://8004.qnt.sh/
 * @see https://eips.ethereum.org/EIPS/eip-8004
 */

import {
  SolanaSDK,
  IPFSClient,
  buildRegistrationFileJson,
  EndpointType,
  type Cluster,
  type SolanaSDKConfig,
  type SolanaAgentSummary,
} from "8004-solana"
import { createHash } from "node:crypto"
import { Keypair, PublicKey } from "@solana/web3.js"
import { buildDid, PROTOCOL_VERSION } from "@ghost-bazaar/core"

// ---------------------------------------------------------------------------
// Constants — Program IDs (informational; the 8004-solana SDK resolves internally)
// ---------------------------------------------------------------------------

/** Agent Registry program — mainnet. */
export const REGISTRY_PROGRAM_MAINNET = "8oo4dC4JvBLwy5tGgiH3WwK4B9PWxL9Z4XjA2jzkQMbQ"

/** Agent Registry program — devnet. */
export const REGISTRY_PROGRAM_DEVNET = "6MuHv4dY4p9E4hSCEPr9dgbCSpMhq8x1vrUexbMVjfw1"

/** ATOM reputation engine — mainnet. */
export const ATOM_ENGINE_MAINNET = "AToMw53aiPQ8j7iHVb4fGt6nzUNxUhcPc3tbPBZuzVVb"

/** ATOM reputation engine — devnet. */
export const ATOM_ENGINE_DEVNET = "6Mu7qj6tRDrqchxJJPjr9V1H2XQjCerVKixFEEMwC1Tf"

// ---------------------------------------------------------------------------
// Constants — Feedback
// ---------------------------------------------------------------------------

/** Default feedback score for successful settlements (0-100). */
export const FEEDBACK_SCORE_SUCCESS = 100

/** Default feedback score for failed settlements (0-100). */
export const FEEDBACK_SCORE_FAILURE = 0

/** ATOM feedback tag: category (identifies settlement feedback). */
export const FEEDBACK_TAG_CATEGORY = "settlement"

/** ATOM feedback tag: source protocol. */
export const FEEDBACK_TAG_SOURCE = "ghost-bazaar"

// ---------------------------------------------------------------------------
// Constants — OASF Taxonomy Defaults
// ---------------------------------------------------------------------------

/** Default OASF skill for Ghost Bazaar agents. Override via `RegisterAgentOpts.skills`. */
export const DEFAULT_SKILLS: readonly string[] = ["agent_orchestration/negotiation_resolution"]

/** Default OASF domain for Ghost Bazaar agents. Override via `RegisterAgentOpts.domains`. */
export const DEFAULT_DOMAINS: readonly string[] = ["finance_and_business/finance"]

// ---------------------------------------------------------------------------
// Constants — Metadata Keys
// ---------------------------------------------------------------------------

/** On-chain metadata key prefix for Ghost Bazaar-specific fields. */
export const METADATA_PREFIX = "ghost-bazaar:"

/** Metadata key for storing the agent's Ghost Bazaar service type value. */
export const METADATA_KEY_SERVICE_TYPE = `${METADATA_PREFIX}service_type`

/** Metadata key: negotiation profile hint (`"firm"` | `"flexible"` | `"competitive"` | `"deadline-sensitive"`). */
export const METADATA_KEY_NEGOTIATION_PROFILE = `${METADATA_PREFIX}negotiation_profile`

/** Metadata key: Ghost Bazaar `did:key` identity linking NFT to protocol identity. */
export const METADATA_KEY_DID = `${METADATA_PREFIX}did`

// ---------------------------------------------------------------------------
// Constants — Misc
// ---------------------------------------------------------------------------

/** IPFS URI prefix. */
const IPFS_URI_PREFIX = "ipfs://"

/** Default Solana cluster. SDK v0.3.0 only supports `"devnet"`. */
const DEFAULT_CLUSTER: Cluster = "devnet" as Cluster

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RegistryConfig {
  /** Solana keypair used to sign registry transactions. */
  signer: Keypair
  /** Pinata JWT for IPFS uploads. Falls back to `PINATA_JWT` env var. */
  pinataJwt?: string
  /** Custom RPC URL (recommended for write operations). */
  rpcUrl?: string
  /** Solana cluster. Defaults to `"devnet"`. SDK v0.3.0 only supports `"devnet"`. */
  cluster?: Cluster
}

export interface RegisterAgentOpts {
  /** Human-readable agent name shown in the registry. */
  name: string
  /** Short description of the agent's capabilities. */
  description: string
  /** Negotiation engine endpoint (maps to A2A endpoint). */
  negotiationEndpoint: string
  /** Settlement / payment endpoint (maps to MCP endpoint). */
  paymentEndpoint?: string
  /** IPFS CID or URL for an agent avatar image. */
  image?: string
  /** Ghost Bazaar service type, e.g. `"ghost-bazaar:services:smart-contract-audit"`. */
  serviceType?: string
  /** Negotiation profile hint: `"firm"` | `"flexible"` | `"competitive"` | `"deadline-sensitive"`. */
  negotiationProfile?: string
  /** OASF skill taxonomy entries. Defaults to `DEFAULT_SKILLS`. */
  skills?: string[]
  /** OASF domain taxonomy entries. Defaults to `DEFAULT_DOMAINS`. */
  domains?: string[]
}

export interface RegisteredAgent {
  /** On-chain agent ID (bigint). */
  agentId: bigint
  /** On-chain Metaplex Core NFT asset public key. */
  asset: PublicKey
  /** Ghost Bazaar `did:key` derived from the signer's public key. */
  did: string
  /** IPFS URI pointing to the full registration file. */
  registryUri: string
}

export interface DiscoveredAgent {
  /** On-chain agent ID. */
  agentId: bigint
  /** Agent name from on-chain account. */
  name: string
  /** Owner public key (Solana). */
  owner: PublicKey
  /** Ghost Bazaar `did:key` identity. */
  did: string
  /** Registration metadata URI. */
  uri: string
  /** ATOM reputation score (0-100 scale, or null if no feedback). */
  reputationScore: number | null
  /** Total feedback entries recorded on-chain. */
  totalFeedbacks: number
}

export interface DealFeedback {
  /** Whether the settlement completed successfully. */
  success: boolean
  /** Final settled amount as a decimal string (e.g. `"36.50"`). */
  settledAmount: string
  /** Feedback score (0-100). Defaults to 100 for success, 0 for failure. */
  score?: number
  /** Optional IPFS URI with extended feedback details. */
  feedbackUri?: string
  /** SHA-256 hash of the content at `feedbackUri` (32 bytes). Required when `feedbackUri` is provided. */
  feedbackContentHash?: Buffer
}

// ---------------------------------------------------------------------------
// SDK Factory
// ---------------------------------------------------------------------------

/**
 * Create the 8004-Solana SDK and IPFS client from a Ghost Bazaar registry config.
 */
export function createRegistrySDK(config: RegistryConfig): {
  sdk: SolanaSDK
  ipfs: IPFSClient
} {
  const jwt = config.pinataJwt ?? process.env.PINATA_JWT
  const ipfs = new IPFSClient({
    pinataEnabled: !!jwt,
    pinataJwt: jwt ?? "",
  })
  const sdkConfig: SolanaSDKConfig = {
    signer: config.signer,
    ipfsClient: ipfs,
    cluster: config.cluster ?? DEFAULT_CLUSTER,
  }
  if (config.rpcUrl) {
    sdkConfig.rpcUrl = config.rpcUrl
  }
  const sdk = new SolanaSDK(sdkConfig)
  return { sdk, ipfs }
}

/**
 * Create a read-only SDK (no signer needed).
 */
export function createReadOnlySDK(rpcUrl?: string, cluster?: Cluster): SolanaSDK {
  const config: SolanaSDKConfig = { cluster: cluster ?? DEFAULT_CLUSTER }
  if (rpcUrl) config.rpcUrl = rpcUrl
  return new SolanaSDK(config)
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register a Ghost Bazaar agent in the on-chain 8004 Agent Registry.
 *
 * This mints a Metaplex Core NFT whose metadata URI points to an IPFS-hosted
 * registration file containing the agent's negotiation and payment endpoints,
 * skill taxonomy, and domain classification.
 *
 * The same Solana keypair that powers Ghost Bazaar identity (`did:key`) is used
 * as the signer, ensuring a single-key bridge between Ghost Bazaar and the
 * Agent Registry.
 */
export async function registerAgent(
  config: RegistryConfig,
  opts: RegisterAgentOpts,
): Promise<RegisteredAgent> {
  const { sdk, ipfs } = createRegistrySDK(config)

  const endpoints = [
    { type: EndpointType.A2A, value: opts.negotiationEndpoint },
  ]
  if (opts.paymentEndpoint) {
    endpoints.push({ type: EndpointType.MCP, value: opts.paymentEndpoint })
  }

  // Build ERC-8004 compliant registration file
  const registrationFile = buildRegistrationFileJson({
    name: opts.name,
    description: opts.description,
    ...(opts.image ? { image: opts.image } : {}),
    endpoints,
    skills: opts.skills ? [...opts.skills] : [...DEFAULT_SKILLS],
    domains: opts.domains ? [...opts.domains] : [...DEFAULT_DOMAINS],
  })

  // Upload to IPFS
  const cid = await ipfs.addJson(registrationFile)
  const tokenUri = `${IPFS_URI_PREFIX}${cid}`

  // Build metadata key-value pairs for on-chain storage
  const metadata: Array<{ key: string; value: string }> = []
  if (opts.serviceType) {
    metadata.push({ key: METADATA_KEY_SERVICE_TYPE, value: opts.serviceType })
  }
  if (opts.negotiationProfile) {
    metadata.push({ key: METADATA_KEY_NEGOTIATION_PROFILE, value: opts.negotiationProfile })
  }
  metadata.push({ key: METADATA_KEY_DID, value: buildDid(config.signer.publicKey) })

  // Register on-chain
  const result = await sdk.registerAgent(tokenUri, metadata)

  if (result.agentId == null || result.asset == null) {
    throw new Error(
      "Agent registration transaction succeeded but did not return agentId/asset. " +
      "Check the transaction on-chain for confirmation.",
    )
  }

  return {
    agentId: result.agentId,
    asset: result.asset,
    did: buildDid(config.signer.publicKey),
    registryUri: tokenUri,
  }
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Load an agent from the registry by ID and return Ghost Bazaar-relevant fields
 * including reputation summary.
 */
export async function discoverAgent(
  agentId: bigint,
  rpcUrl?: string,
  cluster?: Cluster,
): Promise<DiscoveredAgent | null> {
  const sdk = createReadOnlySDK(rpcUrl, cluster)
  const agent = await sdk.loadAgent(agentId)
  if (!agent) return null

  const owner = agent.getOwnerPublicKey()

  let reputationScore: number | null = null
  let totalFeedbacks = 0
  try {
    const summary: SolanaAgentSummary = await sdk.getSummary(agentId)
    totalFeedbacks = summary.totalFeedbacks ?? 0
    reputationScore = totalFeedbacks > 0 ? summary.averageScore : null
  } catch {
    // Agent has no reputation account yet — score stays null
  }

  return {
    agentId,
    name: agent.nft_name,
    owner,
    did: buildDid(owner),
    uri: agent.agent_uri,
    reputationScore,
    totalFeedbacks,
  }
}

/**
 * Find all agents owned by a given public key.
 * Requires a non-default RPC (getProgramAccounts with memcmp).
 */
export async function discoverAgentsByOwner(
  owner: PublicKey,
  rpcUrl?: string,
  cluster?: Cluster,
): Promise<DiscoveredAgent[]> {
  const sdk = createReadOnlySDK(rpcUrl, cluster)
  const agents = await sdk.getAgentsByOwner(owner, { includeFeedbacks: true })

  return agents.map((a) => {
    const ownerKey = a.account.getOwnerPublicKey()
    const activeFeedbacks = (a.feedbacks ?? []).filter((f) => !f.revoked)
    const totalScore = activeFeedbacks.reduce((sum, f) => sum + f.score, 0)
    const avgScore = activeFeedbacks.length > 0 ? totalScore / activeFeedbacks.length : null

    return {
      agentId: a.account.agent_id,
      name: a.account.nft_name,
      owner: ownerKey,
      did: buildDid(ownerKey),
      uri: a.account.agent_uri,
      reputationScore: avgScore,
      totalFeedbacks: activeFeedbacks.length,
    }
  })
}

// ---------------------------------------------------------------------------
// Reputation Feedback
// ---------------------------------------------------------------------------

/**
 * Submit post-settlement reputation feedback for a counterparty agent.
 *
 * Called after the 17-step settlement verification completes. Records a
 * scored feedback entry in the ATOM reputation engine tied to the
 * counterparty's on-chain agent identity.
 *
 * @param config  Registry config (signer must be the feedback author).
 * @param counterpartyAgentId  The counterparty's on-chain agent ID.
 * @param feedback  Deal outcome details.
 */
export async function recordDealFeedback(
  config: RegistryConfig,
  counterpartyAgentId: bigint,
  feedback: DealFeedback,
): Promise<{ feedbackIndex?: bigint }> {
  const score = feedback.score ?? (feedback.success ? FEEDBACK_SCORE_SUCCESS : FEEDBACK_SCORE_FAILURE)

  let fileUri: string
  let fileHash: Buffer

  if (feedback.feedbackUri) {
    // Caller provides pre-uploaded feedback URI + content hash
    if (!feedback.feedbackContentHash) {
      throw new Error(
        "feedbackContentHash is required when feedbackUri is provided. " +
        "Provide the SHA-256 hash of the content at the URI.",
      )
    }
    fileUri = feedback.feedbackUri
    fileHash = feedback.feedbackContentHash
  } else {
    // Build and upload feedback file to IPFS (requires Pinata JWT)
    const jwt = config.pinataJwt ?? process.env.PINATA_JWT
    const ipfs = new IPFSClient({
      pinataEnabled: !!jwt,
      pinataJwt: jwt ?? "",
    })
    const feedbackContent = {
      protocol: PROTOCOL_VERSION,
      success: feedback.success,
      score,
      settled_amount: feedback.settledAmount,
      reviewer: buildDid(config.signer.publicKey),
      timestamp: new Date().toISOString(),
    }
    // Serialize once — upload and hash the exact same bytes
    const contentJson = JSON.stringify(feedbackContent)
    const cid = await ipfs.add(contentJson)
    fileUri = `${IPFS_URI_PREFIX}${cid}`
    fileHash = createHash("sha256").update(contentJson).digest()
  }

  // Create SDK for on-chain transaction (no IPFS needed)
  const sdk = new SolanaSDK({
    signer: config.signer,
    cluster: config.cluster ?? DEFAULT_CLUSTER,
    ...(config.rpcUrl ? { rpcUrl: config.rpcUrl } : {}),
  })

  const result = await sdk.giveFeedback(counterpartyAgentId, {
    score,
    tag1: FEEDBACK_TAG_CATEGORY,
    tag2: FEEDBACK_TAG_SOURCE,
    fileUri,
    fileHash,
  })

  return { feedbackIndex: "feedbackIndex" in result ? result.feedbackIndex : undefined }
}

// ---------------------------------------------------------------------------
// Agent Metadata
// ---------------------------------------------------------------------------

/**
 * Read a specific metadata value for an agent (e.g., `METADATA_KEY_DID`).
 */
export async function getAgentMetadata(
  agentId: bigint,
  key: string,
  rpcUrl?: string,
  cluster?: Cluster,
): Promise<string | null> {
  const sdk = createReadOnlySDK(rpcUrl, cluster)
  return sdk.getMetadata(agentId, key)
}

/**
 * Set a metadata entry for an agent (write operation).
 */
export async function setAgentMetadata(
  config: RegistryConfig,
  agentId: bigint,
  key: string,
  value: string,
): Promise<void> {
  const sdk = new SolanaSDK({
    signer: config.signer,
    cluster: config.cluster ?? DEFAULT_CLUSTER,
    ...(config.rpcUrl ? { rpcUrl: config.rpcUrl } : {}),
  })
  await sdk.setMetadata(agentId, key, value)
}
