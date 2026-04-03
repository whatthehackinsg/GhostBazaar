import { describe, it, expect, vi, beforeEach } from "vitest"
import { Connection, Keypair } from "@solana/web3.js"
import { buildDid } from "@ghost-bazaar/core"
import * as agents from "@ghost-bazaar/agents"
import { defineBuyerTools, createBuyerState } from "../src/tools/buyer.js"
import { defineSellerTools } from "../src/tools/seller.js"
import type { McpConfig } from "../src/config.js"

const keypair = Keypair.generate()
const did = buildDid(keypair.publicKey)

const config: McpConfig = {
  keypair,
  rpcUrl: "https://api.devnet.solana.com",
  engineUrl: "http://localhost:3000",
  usdcMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
}

const registerAgentSpy = vi.spyOn(agents, "registerAgent")
const recordDealFeedbackSpy = vi.spyOn(agents, "recordDealFeedback")

// Mock fetch for engine calls
function setupMockFetch(responses: Record<string, any> = {}) {
  globalThis.fetch = vi.fn(async (url: string, init?: any) => {
    const urlStr = String(url)
    // Match longest pattern first
    const sorted = Object.entries(responses).sort((a, b) => b[0].length - a[0].length)
    for (const [pattern, response] of sorted) {
      if (urlStr.includes(pattern)) {
        return {
          ok: true,
          status: 200,
          json: async () => response,
        } as Response
      }
    }
    const method = init?.method ?? "GET"
    return { ok: true, status: 200, json: async () => (method === "GET" ? [] : {}) } as Response
  }) as any
}

describe("Buyer tools", () => {
  let tools: ReturnType<typeof defineBuyerTools>
  let state: ReturnType<typeof createBuyerState>

  beforeEach(() => {
    registerAgentSpy.mockReset()
    recordDealFeedbackSpy.mockReset()
    state = createBuyerState()
    tools = defineBuyerTools(config, state)
    setupMockFetch({
      "/listings": {
        listings: [{ listing_id: "l1", seller: "did:key:z6MkSeller", title: "Audit Service" }],
      },
      "/rfqs": { rfq_id: "rfq-001" },
      "events": [],
    })
  })

  it("defines all 6 buyer tools", () => {
    const toolNames = Object.keys(tools)
    expect(toolNames).toContain("ghost_bazaar_browse_listings")
    expect(toolNames).toContain("ghost_bazaar_post_rfq")
    expect(toolNames).toContain("ghost_bazaar_get_offers")
    expect(toolNames).toContain("ghost_bazaar_counter")
    expect(toolNames).toContain("ghost_bazaar_accept")
    expect(toolNames).toContain("ghost_bazaar_settle")
    expect(toolNames).toContain("ghost_bazaar_buyer_feedback")
    expect(toolNames).toHaveLength(7)
  })

  it("ghost_bazaar_browse_listings returns listings", async () => {
    const result = await tools.ghost_bazaar_browse_listings.handler({})
    expect(result.content).toHaveLength(1)
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed).toHaveLength(1)
    expect(parsed[0].title).toBe("Audit Service")
  })

  it("ghost_bazaar_browse_listings accepts optional service_type filter", async () => {
    await tools.ghost_bazaar_browse_listings.handler({ service_type: "smart-contract-audit" })
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("service_type=smart-contract-audit"),
    )
  })

  it("ghost_bazaar_get_offers returns offer events", async () => {
    setupMockFetch({
      "events": {
        events: [
          {
            event_id: "evt-1",
            rfq_id: "rfq-001",
            event_type: "offer",
            actor: "did:key:z6MkSeller",
            payload: { offer_id: "o1", price: "40.00" },
            timestamp: new Date().toISOString(),
          },
        ],
      },
    })
    const result = await tools.ghost_bazaar_get_offers.handler({ rfq_id: "rfq-001" })
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed).toHaveLength(1)
    expect(parsed[0].price).toBe("40.00")
  })

  it("ghost_bazaar_post_rfq auto-registers buyer when PINATA_JWT is configured", async () => {
    registerAgentSpy.mockResolvedValue({
      agentId: 101n,
      asset: keypair.publicKey,
      did,
      registryUri: "ipfs://buyer-101",
    })

    const buyerTools = defineBuyerTools({ ...config, pinataJwt: "pinata-test-jwt" }, createBuyerState())
    const result = await buyerTools.ghost_bazaar_post_rfq.handler({
      service_type: "smart-contract-audit",
      spec: { language: "Solidity" },
      anchor_price: "40.00",
      budget_soft: "35.00",
      budget_hard: "50.00",
      deadline_seconds: 300,
    })

    expect(registerAgentSpy).toHaveBeenCalledTimes(1)
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.registry_agent_id).toBe("101")
  })

  it("ghost_bazaar_buyer_feedback submits buyer-side reputation feedback", async () => {
    recordDealFeedbackSpy.mockResolvedValue({ feedbackIndex: 7n })

    const buyerTools = defineBuyerTools({ ...config, pinataJwt: "pinata-test-jwt" }, createBuyerState())
    const result = await buyerTools.ghost_bazaar_buyer_feedback.handler({
      counterparty_agent_id: "42",
      success: true,
      settled_amount: "36.50",
    })

    expect(recordDealFeedbackSpy).toHaveBeenCalledTimes(1)
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.feedback_submitted).toBe(true)
  })

  it("ghost_bazaar_settle auto-submits seller feedback when seller listing is registry-bound", async () => {
    const sellerKeypair = Keypair.generate()
    const sellerDid = buildDid(sellerKeypair.publicKey)
    const buyerState = createBuyerState()
    recordDealFeedbackSpy.mockResolvedValue({ feedbackIndex: 9n })

    const sendTxSpy = vi.spyOn(Connection.prototype, "sendTransaction").mockResolvedValue("tx-sig-123")
    const confirmTxSpy = vi.spyOn(Connection.prototype, "confirmTransaction").mockResolvedValue({ value: { err: null } } as any)

    const buyerTools = defineBuyerTools({ ...config, pinataJwt: "pinata-test-jwt" }, buyerState)
    buyerState.sessions.set("rfq-001", {
      budgetSoft: "35.00",
      budgetHard: "50.00",
      commitmentSalt: 1n,
      rfq: {
        rfq_id: "rfq-001",
        protocol: "ghost-bazaar-v4",
        buyer: did,
        service_type: "smart-contract-audit",
        spec: {},
        anchor_price: "40.00",
        currency: "USDC",
        deadline: new Date(Date.now() + 60_000).toISOString(),
        signature: "ed25519:test",
      },
      round: 0,
      selectedSellerDid: sellerDid,
      selectedOfferId: "offer-001",
    })

    globalThis.fetch = vi.fn(async (url: string) => {
      const urlStr = String(url)
      if (urlStr.includes("/rfqs/rfq-001/events")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            events: [
              {
                event_id: "evt-1",
                rfq_id: "rfq-001",
                event_type: "offer",
                actor: sellerDid,
                payload: {
                  offer_id: "offer-001",
                  seller: sellerDid,
                  listing_id: "listing-001",
                  price: "48.00",
                },
                timestamp: new Date().toISOString(),
              },
            ],
          }),
        } as Response
      }
      if (urlStr.includes("/listings/listing-001")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            listing_id: "listing-001",
            seller: sellerDid,
            registry_agent_id: "42",
          }),
        } as Response
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ receipt: { quote_id: "quote-001" } }),
      } as Response
    }) as any

    const result = await buyerTools.ghost_bazaar_settle.handler({
      quote: {
        quote_id: "quote-001",
        rfq_id: "rfq-001",
        buyer: did,
        seller: sellerDid,
        service_type: "smart-contract-audit",
        final_price: "48.00",
        currency: "USDC",
        payment_endpoint: "http://seller.example.com/execute",
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        nonce: "0x" + "ab".repeat(32),
        memo_policy: "quote_id_required",
        buyer_signature: "ed25519:buyer",
        seller_signature: "ed25519:seller",
      },
    })

    expect(recordDealFeedbackSpy).toHaveBeenCalledTimes(1)
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.feedback_submitted).toBe(true)
    expect(parsed.seller_registry_agent_id).toBe("42")

    sendTxSpy.mockRestore()
    confirmTxSpy.mockRestore()
  })
})

describe("Seller tools", () => {
  let tools: ReturnType<typeof defineSellerTools>

  beforeEach(() => {
    registerAgentSpy.mockReset()
    recordDealFeedbackSpy.mockReset()
    tools = defineSellerTools(config)
    setupMockFetch({
      "/listings": { listing_id: "l1" },
      "events": [],
      "/offers": { offer_id: "o1" },
    })
  })

  it("defines all 7 seller tools", () => {
    const toolNames = Object.keys(tools)
    expect(toolNames).toContain("ghost_bazaar_register_listing")
    expect(toolNames).toContain("ghost_bazaar_get_rfqs")
    expect(toolNames).toContain("ghost_bazaar_respond_offer")
    expect(toolNames).toContain("ghost_bazaar_respond_counter")
    expect(toolNames).toContain("ghost_bazaar_check_events")
    expect(toolNames).toContain("ghost_bazaar_cosign")
    expect(toolNames).toContain("ghost_bazaar_seller_feedback")
    expect(toolNames).toHaveLength(7)
  })

  it("ghost_bazaar_register_listing creates listing with seller DID", async () => {
    const result = await tools.ghost_bazaar_register_listing.handler({
      title: "Smart Contract Audit",
      category: "security",
      service_type: "smart-contract-audit",
      base_terms: { turnaround: "3 days" },
    })
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.seller).toBe(did)
  })

  it("ghost_bazaar_register_listing auto-registers seller and binds registry_agent_id when PINATA_JWT is configured", async () => {
    registerAgentSpy.mockResolvedValue({
      agentId: 42n,
      asset: keypair.publicKey,
      did,
      registryUri: "ipfs://seller-42",
    })

    tools = defineSellerTools({ ...config, pinataJwt: "pinata-test-jwt" })
    setupMockFetch({
      "/listings": { listing_id: "l1", registry_agent_id: "42" },
      "events": [],
      "/offers": { offer_id: "o1" },
    })

    const result = await tools.ghost_bazaar_register_listing.handler({
      title: "Smart Contract Audit",
      category: "security",
      service_type: "smart-contract-audit",
      base_terms: { turnaround: "3 days" },
    })

    expect(registerAgentSpy).toHaveBeenCalledTimes(1)
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.registry_agent_id).toBe("42")
  })

  it("ghost_bazaar_seller_feedback reputation feedback", async () => {
    recordDealFeedbackSpy.mockResolvedValue({ feedbackIndex: 8n })

    tools = defineSellerTools({ ...config, pinataJwt: "pinata-test-jwt" })
    const result = await tools.ghost_bazaar_seller_feedback.handler({
      counterparty_agent_id: "101",
      success: true,
      settled_amount: "48.00",
    })

    expect(recordDealFeedbackSpy).toHaveBeenCalledTimes(1)
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.feedback_submitted).toBe(true)
  })

  it("ghost_bazaar_respond_offer sends signed offer", async () => {
    // Register listing first so listing_id is available
    await tools.ghost_bazaar_register_listing.handler({
      title: "Test", category: "test", service_type: "test", base_terms: {},
    })
    const result = await tools.ghost_bazaar_respond_offer.handler({
      rfq_id: "rfq-001",
      price: "42.00",
    })
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed.offer_id).toBeDefined()
    expect(parsed.price).toBe("42.00")
  })

  it("ghost_bazaar_check_events returns event log", async () => {
    setupMockFetch({
      "events": [
        { event_id: 1, event_type: "rfq_created" },
        { event_id: 2, event_type: "offer" },
      ],
    })
    const result = await tools.ghost_bazaar_check_events.handler({ rfq_id: "rfq-001" })
    const parsed = JSON.parse(result.content[0].text)
    expect(parsed).toHaveLength(2)
  })
})
