import { describe, it, expect } from "vitest"
import { Keypair, PublicKey } from "@solana/web3.js"
import { buildDid, PROTOCOL_VERSION } from "@ghost-bazaar/core"
import {
  REGISTRY_PROGRAM_MAINNET,
  REGISTRY_PROGRAM_DEVNET,
  ATOM_ENGINE_MAINNET,
  ATOM_ENGINE_DEVNET,
  FEEDBACK_SCORE_SUCCESS,
  FEEDBACK_SCORE_FAILURE,
  FEEDBACK_TAG_CATEGORY,
  FEEDBACK_TAG_SOURCE,
  DEFAULT_SKILLS,
  DEFAULT_DOMAINS,
  METADATA_PREFIX,
  METADATA_KEY_SERVICE_TYPE,
  METADATA_KEY_NEGOTIATION_PROFILE,
  METADATA_KEY_DID,
  createRegistrySDK,
  createReadOnlySDK,
} from "../src/index.js"

describe("registry constants", () => {
  it("exports valid program IDs", () => {
    expect(() => new PublicKey(REGISTRY_PROGRAM_MAINNET)).not.toThrow()
    expect(() => new PublicKey(REGISTRY_PROGRAM_DEVNET)).not.toThrow()
    expect(() => new PublicKey(ATOM_ENGINE_MAINNET)).not.toThrow()
    expect(() => new PublicKey(ATOM_ENGINE_DEVNET)).not.toThrow()
  })

  it("feedback scores are in valid range", () => {
    expect(FEEDBACK_SCORE_SUCCESS).toBe(100)
    expect(FEEDBACK_SCORE_FAILURE).toBe(0)
    expect(FEEDBACK_SCORE_SUCCESS).toBeGreaterThanOrEqual(0)
    expect(FEEDBACK_SCORE_SUCCESS).toBeLessThanOrEqual(100)
  })

  it("feedback tags are non-empty strings", () => {
    expect(FEEDBACK_TAG_CATEGORY).toBe("settlement")
    expect(FEEDBACK_TAG_SOURCE).toBe("ghost-bazaar")
  })

  it("OASF taxonomy defaults are non-empty arrays", () => {
    expect(DEFAULT_SKILLS.length).toBeGreaterThan(0)
    expect(DEFAULT_DOMAINS.length).toBeGreaterThan(0)
    expect(DEFAULT_SKILLS[0]).toContain("/")
    expect(DEFAULT_DOMAINS[0]).toContain("/")
  })

  it("metadata keys use consistent prefix", () => {
    expect(METADATA_KEY_SERVICE_TYPE).toMatch(new RegExp(`^${METADATA_PREFIX}`))
    expect(METADATA_KEY_NEGOTIATION_PROFILE).toMatch(new RegExp(`^${METADATA_PREFIX}`))
    expect(METADATA_KEY_DID).toMatch(new RegExp(`^${METADATA_PREFIX}`))
  })

  it("PROTOCOL_VERSION is re-exported from core", () => {
    expect(PROTOCOL_VERSION).toBe("ghost-bazaar-v4")
  })
})

describe("identity bridge", () => {
  it("derives consistent did:key from Solana keypair", () => {
    const keypair = Keypair.generate()
    const did = buildDid(keypair.publicKey)

    expect(did).toMatch(/^did:key:z6Mk/)
    // Same key always produces same DID
    expect(buildDid(keypair.publicKey)).toBe(did)
  })

  it("different keypairs produce different DIDs", () => {
    const k1 = Keypair.generate()
    const k2 = Keypair.generate()
    expect(buildDid(k1.publicKey)).not.toBe(buildDid(k2.publicKey))
  })
})

describe("createRegistrySDK", () => {
  it("creates SDK with signer and pinata JWT", () => {
    const keypair = Keypair.generate()
    const { sdk, ipfs } = createRegistrySDK({
      signer: keypair,
      pinataJwt: "test-jwt-token",
    })

    expect(sdk).toBeDefined()
    expect(sdk.canWrite).toBe(true)
    expect(ipfs).toBeDefined()
  })

  it("respects custom RPC URL", () => {
    const keypair = Keypair.generate()
    const customRpc = "https://custom-rpc.example.com"
    const { sdk } = createRegistrySDK({
      signer: keypair,
      pinataJwt: "test-jwt-token",
      rpcUrl: customRpc,
    })

    expect(sdk.getRpcUrl()).toBe(customRpc)
  })
})

describe("createReadOnlySDK", () => {
  it("creates read-only SDK without signer", () => {
    const sdk = createReadOnlySDK()

    expect(sdk).toBeDefined()
    expect(sdk.isReadOnly).toBe(true)
  })

  it("respects custom RPC URL", () => {
    const customRpc = "https://custom-rpc.example.com"
    const sdk = createReadOnlySDK(customRpc)

    expect(sdk.getRpcUrl()).toBe(customRpc)
  })
})
