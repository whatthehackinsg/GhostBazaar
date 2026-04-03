import { describe, it, expect, vi, beforeEach } from "vitest"
import { Keypair } from "@solana/web3.js"
import { defineBuyerTools, createBuyerState } from "../src/tools/buyer.js"
import type { McpConfig } from "../src/config.js"

const config: McpConfig = {
  keypair: Keypair.generate(),
  rpcUrl: "https://api.devnet.solana.com",
  engineUrl: "http://localhost:3000",
  usdcMint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
}

function setupMockFetch() {
  globalThis.fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({}),
  })) as any
}

describe("Privacy enforcement", () => {
  beforeEach(() => {
    setupMockFetch()
  })

  it("budget_hard NEVER appears in ghost_bazaar_post_rfq output", async () => {
    const state = createBuyerState()
    const tools = defineBuyerTools(config, state)

    const result = await tools.ghost_bazaar_post_rfq.handler({
      service_type: "audit",
      spec: {},
      anchor_price: "25.00",
      budget_soft: "35.00",
      budget_hard: "50.00",
      deadline_seconds: 300,
    })

    // Serialize entire output and check budget_hard never appears
    const outputText = JSON.stringify(result)
    expect(outputText).not.toContain("50.00")
    expect(outputText).not.toContain("budget_hard")
  })

  it("budget_soft is not exposed in output either", async () => {
    const state = createBuyerState()
    const tools = defineBuyerTools(config, state)

    const result = await tools.ghost_bazaar_post_rfq.handler({
      service_type: "audit",
      spec: {},
      anchor_price: "25.00",
      budget_soft: "35.00",
      budget_hard: "50.00",
      deadline_seconds: 300,
    })

    const outputText = JSON.stringify(result)
    expect(outputText).not.toContain("budget_soft")
  })

  it("budget_hard accepted as input but stored only in local state", async () => {
    const state = createBuyerState()
    const tools = defineBuyerTools(config, state)

    await tools.ghost_bazaar_post_rfq.handler({
      service_type: "audit",
      spec: {},
      anchor_price: "25.00",
      budget_soft: "35.00",
      budget_hard: "50.00",
      deadline_seconds: 300,
    })

    // budget_hard should be in local state
    expect(state.sessions.size).toBe(1)
    const session = [...state.sessions.values()][0]
    expect(session.budgetHard).toBe("50.00")
  })

  it("tool input schema accepts budget_hard as required field", () => {
    const state = createBuyerState()
    const tools = defineBuyerTools(config, state)
    const schema = tools.ghost_bazaar_post_rfq.inputSchema
    // Verify schema has budget_hard as a field (it's required for the tool to work)
    expect(schema.shape).toHaveProperty("budget_hard")
  })
})
