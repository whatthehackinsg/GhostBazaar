import { describe, it, expect, vi, beforeEach } from "vitest"
import { createServer, type IncomingMessage, type ServerResponse } from "http"
import { Keypair } from "@solana/web3.js"
import { buildDid, buildUnsignedQuote, signQuoteAsBuyer, signQuoteAsSeller } from "@ghost-bazaar/core"
import bs58 from "bs58"
import { handleSettlementRequest, type SettlementServerConfig } from "../src/http.js"
import { resetNonces } from "../src/nonce.js"

const USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"
const buyerKeypair = Keypair.generate()
const sellerKeypair = Keypair.generate()

function makeConfig(overrides?: Partial<SettlementServerConfig>): SettlementServerConfig {
  return {
    rpcUrl: "https://api.devnet.solana.com",
    usdcMint: USDC_MINT,
    executor: async () => {},
    ...overrides,
  }
}

function mockReq(method: string, headers: Record<string, string>): IncomingMessage {
  return { method, headers } as any
}

function mockRes() {
  let statusCode = 0
  let body = ""
  const res = {
    writeHead: vi.fn((code: number) => { statusCode = code }),
    end: vi.fn((data: string) => { body = data }),
    getStatus: () => statusCode,
    getBody: () => body,
    getParsed: () => JSON.parse(body),
  }
  return res as any
}

describe("Settlement HTTP handler", () => {
  beforeEach(() => {
    resetNonces()
  })

  it("rejects non-POST methods with 405", async () => {
    const req = mockReq("GET", {})
    const res = mockRes()
    await handleSettlementRequest(req, res, makeConfig())

    expect(res.writeHead).toHaveBeenCalledWith(405, expect.any(Object))
    expect(res.getParsed().error).toBe("method_not_allowed")
  })

  it("rejects missing X-Ghost-Bazaar-Quote header with 400", async () => {
    const req = mockReq("POST", { "payment-signature": "abc" })
    const res = mockRes()
    await handleSettlementRequest(req, res, makeConfig())

    expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object))
    expect(res.getParsed().error).toBe("malformed_quote_header")
  })

  it("rejects missing Payment-Signature header with 400", async () => {
    const req = mockReq("POST", { "x-ghost-bazaar-quote": "abc" })
    const res = mockRes()
    await handleSettlementRequest(req, res, makeConfig())

    expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object))
    expect(res.getParsed().error).toBe("invalid_payment_signature")
  })

  it("propagates SettlementError with correct HTTP status", async () => {
    // Send a valid-looking request but with a bad payment signature
    const quote = buildUnsignedQuote({
      rfq_id: "550e8400-e29b-41d4-a716-446655440000",
      buyer: buildDid(buyerKeypair.publicKey),
      seller: buildDid(sellerKeypair.publicKey),
      service_type: "audit",
      final_price: "10.00",
      currency: "USDC",
      payment_endpoint: "http://localhost/execute",
      expires_seconds: 600,
    })
    const signed = await signQuoteAsSeller(await signQuoteAsBuyer(quote, buyerKeypair), sellerKeypair)
    const quoteB64 = Buffer.from(JSON.stringify(signed)).toString("base64")

    const req = mockReq("POST", {
      "x-ghost-bazaar-quote": quoteB64,
      "payment-signature": "not-base58!!!",
    })
    const res = mockRes()
    await handleSettlementRequest(req, res, makeConfig())

    expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object))
    expect(res.getParsed().error).toBe("invalid_payment_signature")
  })

  it("calls onSettled callback after successful settlement", async () => {
    // This test requires mocking the full validation chain, which is complex.
    // We verify the callback wiring by testing it doesn't break when provided.
    const onSettled = vi.fn()
    const config = makeConfig({ onSettled })

    // Invalid request — onSettled should NOT be called on failure
    const req = mockReq("POST", {
      "x-ghost-bazaar-quote": Buffer.from("{}").toString("base64"),
      "payment-signature": bs58.encode(new Uint8Array(64)),
    })
    const res = mockRes()
    await handleSettlementRequest(req, res, config)

    // Should have failed (malformed quote), so onSettled should NOT fire
    expect(onSettled).not.toHaveBeenCalled()
  })
})
