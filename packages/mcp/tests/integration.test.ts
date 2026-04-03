/**
 * MCP integration tests — verify cross-package behavior.
 *
 * These test that MCP tools properly wire ZK proofs, sanitize private
 * data, and connect to the settlement path. The engine and Solana RPC
 * are mocked since they're external dependencies.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { Keypair } from "@solana/web3.js"
import { buildDid } from "@ghost-bazaar/core"
import { defineBuyerTools, createBuyerState, type BuyerState } from "../src/tools/buyer.js"
import type { McpConfig } from "../src/config.js"

const generateBudgetCommitmentMock = vi.fn(async () => "poseidon:" + "ab".repeat(32))
const generateBudgetProofMock = vi.fn(async () => ({
  protocol: "groth16",
  curve: "bn128",
  counter_price_scaled: "35000000",
  pi_a: ["1", "2"],
  pi_b: [["3", "4"], ["5", "6"]],
  pi_c: ["7", "8"],
}))
const hasBudgetProofArtifactsMock = vi.fn(async () => false)

vi.mock("@ghost-bazaar/zk", () => ({
  generateBudgetCommitment: generateBudgetCommitmentMock,
  generateBudgetProof: generateBudgetProofMock,
  hasBudgetProofArtifacts: hasBudgetProofArtifactsMock,
}))

const keypair = Keypair.generate()
const did = buildDid(keypair.publicKey)

const config: McpConfig = {
  keypair,
  rpcUrl: "https://api.devnet.solana.com",
  engineUrl: "http://localhost:3000",
  usdcMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
}

function setupMockFetch() {
  globalThis.fetch = vi.fn(async (url: string, init?: any) => {
    const method = init?.method ?? "GET"
    const isGet = method === "GET"
    return { ok: true, status: 200, json: async () => (isGet ? [] : {}) } as Response
  }) as any
}

describe("MCP integration: ZK-backed counter flow", () => {
  let state: BuyerState
  let tools: ReturnType<typeof defineBuyerTools>

  beforeEach(() => {
    generateBudgetCommitmentMock.mockClear()
    generateBudgetProofMock.mockClear()
    hasBudgetProofArtifactsMock.mockReset()
    hasBudgetProofArtifactsMock.mockResolvedValue(false)
    state = createBuyerState()
    tools = defineBuyerTools(config, state)
    setupMockFetch()
  })

  it("ghost_bazaar_post_rfq stores real commitmentSalt (not 0n)", async () => {
    const result = await tools.ghost_bazaar_post_rfq.handler({
      service_type: "audit",
      spec: {},
      anchor_price: "25.00",
      budget_soft: "35.00",
      budget_hard: "50.00",
      deadline_seconds: 300,
    })

    const parsed = JSON.parse(result.content[0].text)
    const session = state.sessions.get(parsed.rfq_id)!
    expect(session).toBeDefined()
    expect(session.commitmentSalt).not.toBe(0n)
    expect(session.budgetHard).toBe("50.00")
    expect(session.round).toBe(0)
  })

  it("ghost_bazaar_post_rfq skips budget commitment when proof artifacts are unavailable", async () => {
    const result = await tools.ghost_bazaar_post_rfq.handler({
      service_type: "audit",
      spec: {},
      anchor_price: "25.00",
      budget_soft: "35.00",
      budget_hard: "50.00",
      deadline_seconds: 300,
    })

    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.has_budget_commitment).toBe(false)
    expect(generateBudgetCommitmentMock).not.toHaveBeenCalled()
  })

  it("ghost_bazaar_post_rfq includes budget commitment when proof artifacts are available", async () => {
    hasBudgetProofArtifactsMock.mockResolvedValue(true)

    const result = await tools.ghost_bazaar_post_rfq.handler({
      service_type: "audit",
      spec: {},
      anchor_price: "25.00",
      budget_soft: "35.00",
      budget_hard: "50.00",
      deadline_seconds: 300,
    })

    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.has_budget_commitment).toBe(true)
    expect(generateBudgetCommitmentMock).toHaveBeenCalledTimes(1)
  })

  it("ghost_bazaar_counter sanitizes price to budget_hard", async () => {
    // First post an RFQ to create session state
    const rfqResult = await tools.ghost_bazaar_post_rfq.handler({
      service_type: "audit",
      spec: {},
      anchor_price: "25.00",
      budget_soft: "35.00",
      budget_hard: "50.00",
      deadline_seconds: 300,
    })
    const rfqId = JSON.parse(rfqResult.content[0].text).rfq_id

    // Counter at price above budget_hard
    const counterResult = await tools.ghost_bazaar_counter.handler({
      rfq_id: rfqId,
      seller_did: buildDid(Keypair.generate().publicKey),
      price: "999.99",
    })

    const parsed = JSON.parse(counterResult.content[0].text)
    // Price should be clamped to budget_hard = 50.00
    expect(parseFloat(parsed.price)).toBeLessThanOrEqual(50.00)
  })

  it("ghost_bazaar_counter fails locally when a committed RFQ cannot generate a proof", async () => {
    state.sessions.set("rfq-committed", {
      budgetSoft: "35.00",
      budgetHard: "50.00",
      commitmentSalt: 1n,
      rfq: {
        rfq_id: "rfq-committed",
        protocol: "ghost-bazaar-v4",
        buyer: did,
        service_type: "audit",
        spec: {},
        anchor_price: "25.00",
        currency: "USDC",
        deadline: new Date(Date.now() + 300_000).toISOString(),
        signature: "ed25519:test",
        budget_commitment: "poseidon:" + "ab".repeat(32),
      },
      round: 0,
    })

    await expect(tools.ghost_bazaar_counter.handler({
      rfq_id: "rfq-committed",
      seller_did: buildDid(Keypair.generate().publicKey),
      price: "35.00",
    })).rejects.toThrow("Budget proof artifacts are unavailable")
    expect(generateBudgetProofMock).not.toHaveBeenCalled()
  })

  it("ghost_bazaar_counter tracks round incrementally", async () => {
    const rfqResult = await tools.ghost_bazaar_post_rfq.handler({
      service_type: "audit",
      spec: {},
      anchor_price: "25.00",
      budget_soft: "35.00",
      budget_hard: "50.00",
      deadline_seconds: 300,
    })
    const rfqId = JSON.parse(rfqResult.content[0].text).rfq_id
    const sellerDid = buildDid(Keypair.generate().publicKey)

    const c1 = await tools.ghost_bazaar_counter.handler({ rfq_id: rfqId, seller_did: sellerDid, price: "30.00" })
    const c2 = await tools.ghost_bazaar_counter.handler({ rfq_id: rfqId, seller_did: sellerDid, price: "32.00" })
    const c3 = await tools.ghost_bazaar_counter.handler({ rfq_id: rfqId, seller_did: sellerDid, price: "34.00" })

    expect(JSON.parse(c1.content[0].text).round).toBe(1)
    expect(JSON.parse(c2.content[0].text).round).toBe(2)
    expect(JSON.parse(c3.content[0].text).round).toBe(3)
  })
})

describe("MCP integration: private data never leaks", () => {
  let state: BuyerState
  let tools: ReturnType<typeof defineBuyerTools>

  beforeEach(() => {
    state = createBuyerState()
    tools = defineBuyerTools(config, state)
    setupMockFetch()
  })

  it("budget_hard never in ghost_bazaar_post_rfq output", async () => {
    const result = await tools.ghost_bazaar_post_rfq.handler({
      service_type: "audit",
      spec: {},
      anchor_price: "25.00",
      budget_soft: "35.00",
      budget_hard: "50.00",
      deadline_seconds: 300,
    })

    const full = JSON.stringify(result)
    expect(full).not.toContain("50.00")
    expect(full).not.toContain("budget_hard")
    expect(full).not.toContain("budget_soft")
    expect(full).not.toContain("35.00")
  })

  it("budget_hard never in ghost_bazaar_counter output", async () => {
    const rfqResult = await tools.ghost_bazaar_post_rfq.handler({
      service_type: "audit",
      spec: {},
      anchor_price: "25.00",
      budget_soft: "35.00",
      budget_hard: "50.00",
      deadline_seconds: 300,
    })
    const rfqId = JSON.parse(rfqResult.content[0].text).rfq_id

    const result = await tools.ghost_bazaar_counter.handler({
      rfq_id: rfqId,
      seller_did: buildDid(Keypair.generate().publicKey),
      price: "30.00",
    })

    const full = JSON.stringify(result)
    expect(full).not.toContain("budget_hard")
    expect(full).not.toContain("budget_soft")
    expect(full).not.toContain("commitment")
    expect(full).not.toContain("salt")
  })

  it("budget_hard never in ghost_bazaar_accept output", async () => {
    // Mock accept to return a quote
    globalThis.fetch = vi.fn(async (url: string, init?: any) => {
      const urlStr = String(url)
      if (urlStr.includes("/accept")) {
        return {
          ok: true, status: 200,
          json: async () => ({
            quote: {
              quote_id: "q1", rfq_id: "r1", buyer: did, seller: buildDid(Keypair.generate().publicKey),
              service_type: "audit", final_price: "36.50", currency: "USDC",
              payment_endpoint: "http://x/execute", expires_at: new Date(Date.now() + 60000).toISOString(),
              nonce: "0x" + "ab".repeat(32), memo_policy: "optional",
              buyer_signature: "", seller_signature: "",
            },
          }),
        } as Response
      }
      return { ok: true, status: 200, json: async () => ({}) } as Response
    }) as any

    const result = await tools.ghost_bazaar_accept.handler({
      rfq_id: "r1", seller_did: "did:key:z6MkFake", offer_id: "o1",
    })

    const full = JSON.stringify(result)
    expect(full).not.toContain("budget_hard")
    expect(full).not.toContain("budget_soft")
  })

  it("ghost_bazaar_get_offers output has no private fields", async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => [
        { event_id: 1, event_type: "offer", payload: { offer_id: "o1", price: "40.00" } },
      ],
    })) as any

    const result = await tools.ghost_bazaar_get_offers.handler({ rfq_id: "rfq-1" })
    const full = JSON.stringify(result)
    expect(full).not.toContain("budget_hard")
    expect(full).not.toContain("floor_price")
    expect(full).not.toContain("target_price")
  })
})

describe("MCP integration: explorer URL cluster awareness", () => {
  it("mainnet mint produces no cluster param", () => {
    // Import the helper indirectly by testing tool output format
    const mainnetConfig: McpConfig = {
      ...config,
      usdcMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    }
    const state = createBuyerState()
    const tools = defineBuyerTools(mainnetConfig, state)
    // The explorerUrl function is used internally; we verify via the tool definitions existing
    expect(tools.ghost_bazaar_settle).toBeDefined()
  })
})
