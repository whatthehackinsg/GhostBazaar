/**
 * Integration tests for the settlement path.
 *
 * These test the real verifyAndExecute → nonce → receipt chain
 * without mocking settlement internals. The Solana RPC Connection
 * is still mocked since we can't hit devnet in CI.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { Keypair, PublicKey } from "@solana/web3.js"
import { getAssociatedTokenAddressSync } from "@solana/spl-token"
import bs58 from "bs58"
import {
  buildDid,
  buildUnsignedQuote,
  signQuoteAsBuyer,
  signQuoteAsSeller,
  normalizeAmount,
  canonicalJson,
} from "@ghost-bazaar/core"
import { sha256 } from "@noble/hashes/sha256"
import { verifyAndExecute, type SettlementRequest } from "../src/execute.js"
import { resetNonces, isNonceConsumed } from "../src/nonce.js"
import { SettlementError } from "../src/errors.js"

const USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"
const buyerKeypair = Keypair.generate()
const sellerKeypair = Keypair.generate()
const buyerDid = buildDid(buyerKeypair.publicKey)
const sellerDid = buildDid(sellerKeypair.publicKey)
const sellerAta = getAssociatedTokenAddressSync(new PublicKey(USDC_MINT), sellerKeypair.publicKey)
const FAKE_TX_SIG = bs58.encode(new Uint8Array(64).fill(1))

async function buildSignedQuote(memoPolicy: "optional" | "quote_id_required" | "hash_required" = "quote_id_required") {
  const quote = buildUnsignedQuote({
    rfq_id: "550e8400-e29b-41d4-a716-446655440000",
    buyer: buyerDid,
    seller: sellerDid,
    service_type: "audit",
    final_price: "36.50",
    currency: "USDC",
    payment_endpoint: "http://localhost/execute",
    expires_seconds: 600,
    memo_policy: memoPolicy,
  })
  return signQuoteAsSeller(await signQuoteAsBuyer(quote, buyerKeypair), sellerKeypair)
}

function buildTx(quote: any, opts?: { memo?: string | null }) {
  const amount = normalizeAmount(quote.final_price, USDC_MINT).toString()
  const instructions: any[] = [
    {
      programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
      program: "spl-token",
      parsed: {
        type: "transferChecked",
        info: {
          source: "FakeSourceATA",
          destination: sellerAta.toBase58(),
          tokenAmount: { amount },
          mint: USDC_MINT,
          authority: buyerKeypair.publicKey.toBase58(),
        },
      },
    },
  ]
  if (opts?.memo !== null) {
    instructions.push({
      programId: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
      program: "spl-memo",
      parsed: opts?.memo ?? `GhostBazaar:quote_id:${quote.quote_id}`,
    })
  }
  return {
    slot: 100,
    meta: { err: null, innerInstructions: [], logMessages: [] },
    transaction: { message: { instructions, accountKeys: [] } },
  }
}

// Mock Connection
let mockTxResponse: any = null
vi.mock("@solana/web3.js", async () => {
  const actual = await vi.importActual("@solana/web3.js") as any
  class MockConnection {
    constructor() {}
    async getTransaction() { return mockTxResponse }
  }
  return { ...actual, Connection: MockConnection }
})

function makeRequest(quote: any): SettlementRequest {
  return {
    quoteHeaderB64: Buffer.from(JSON.stringify(quote)).toString("base64"),
    paymentSignature: FAKE_TX_SIG,
    rpcUrl: "https://api.devnet.solana.com",
    usdcMint: USDC_MINT,
  }
}

describe("Settlement integration: memo handling", () => {
  beforeEach(() => { resetNonces() })

  it("quote_id_required — succeeds when memo contains quote_id", async () => {
    const quote = await buildSignedQuote("quote_id_required")
    mockTxResponse = buildTx(quote, { memo: `GhostBazaar:quote_id:${quote.quote_id}` })
    const result = await verifyAndExecute(makeRequest(quote), async () => {})
    expect(result.receipt.quote_id).toBe(quote.quote_id)
  })

  it("quote_id_required — fails when memo is missing", async () => {
    const quote = await buildSignedQuote("quote_id_required")
    mockTxResponse = buildTx(quote, { memo: null })
    await expect(verifyAndExecute(makeRequest(quote), async () => {}))
      .rejects.toMatchObject({ code: "memo_missing" })
  })

  it("quote_id_required — fails when memo has wrong quote_id", async () => {
    const quote = await buildSignedQuote("quote_id_required")
    mockTxResponse = buildTx(quote, { memo: "GhostBazaar:quote_id:wrong-id" })
    await expect(verifyAndExecute(makeRequest(quote), async () => {}))
      .rejects.toMatchObject({ code: "memo_mismatch" })
  })

  it("hash_required — succeeds when memo contains canonical hash", async () => {
    const quote = await buildSignedQuote("hash_required")
    const hash = Buffer.from(sha256(canonicalJson(quote as any))).toString("hex")
    mockTxResponse = buildTx(quote, { memo: hash })
    const result = await verifyAndExecute(makeRequest(quote), async () => {})
    expect(result.receipt.quote_id).toBe(quote.quote_id)
  })

  it("hash_required — fails when memo has wrong hash", async () => {
    const quote = await buildSignedQuote("hash_required")
    mockTxResponse = buildTx(quote, { memo: "deadbeef" })
    await expect(verifyAndExecute(makeRequest(quote), async () => {}))
      .rejects.toMatchObject({ code: "memo_mismatch" })
  })

  it("optional — succeeds even without memo", async () => {
    const quote = await buildSignedQuote("optional")
    mockTxResponse = buildTx(quote, { memo: null })
    const result = await verifyAndExecute(makeRequest(quote), async () => {})
    expect(result.receipt.quote_id).toBe(quote.quote_id)
  })
})

describe("Settlement integration: nonce replay protection", () => {
  beforeEach(() => { resetNonces() })

  it("first settlement succeeds and consumes nonce", async () => {
    const quote = await buildSignedQuote()
    mockTxResponse = buildTx(quote)
    const result = await verifyAndExecute(makeRequest(quote), async () => {})
    expect(result.receipt.quote_id).toBe(quote.quote_id)
    expect(isNonceConsumed(quote.quote_id)).toBe(true)
  })

  it("second settlement with same quote is rejected as replay", async () => {
    const quote = await buildSignedQuote()
    mockTxResponse = buildTx(quote)

    // First — succeeds
    await verifyAndExecute(makeRequest(quote), async () => {})

    // Second — rejected
    await expect(verifyAndExecute(makeRequest(quote), async () => {}))
      .rejects.toMatchObject({ code: "nonce_replayed", httpStatus: 409 })
  })

  it("nonce is NOT consumed when executor throws", async () => {
    const quote = await buildSignedQuote()
    mockTxResponse = buildTx(quote)
    const failing = async () => { throw new Error("service down") }

    await expect(verifyAndExecute(makeRequest(quote), failing))
      .rejects.toMatchObject({ code: "execution_failed" })

    // Nonce should NOT be consumed since execution failed
    expect(isNonceConsumed(quote.quote_id)).toBe(false)
  })
})

describe("Settlement integration: receipt correctness", () => {
  beforeEach(() => { resetNonces() })

  it("receipt contains base58 pubkeys, not DIDs", async () => {
    const quote = await buildSignedQuote()
    mockTxResponse = buildTx(quote)
    const result = await verifyAndExecute(makeRequest(quote), async () => {})

    expect(result.receipt.buyer_pubkey).toBe(buyerKeypair.publicKey.toBase58())
    expect(result.receipt.seller_pubkey).toBe(sellerKeypair.publicKey.toBase58())
    expect(result.receipt.buyer_pubkey).not.toContain("did:")
    expect(result.receipt.seller_pubkey).not.toContain("did:")
  })

  it("receipt includes correct settlement timing", async () => {
    const quote = await buildSignedQuote()
    mockTxResponse = buildTx(quote)
    const before = Date.now()
    const result = await verifyAndExecute(makeRequest(quote), async () => {})
    expect(result.settlement_ms).toBeGreaterThanOrEqual(0)
    expect(result.settlement_ms).toBeLessThan(5000)
    expect(Date.parse(result.receipt.settled_at)).toBeGreaterThanOrEqual(before)
  })

  it("explorer URL uses configured cluster", async () => {
    const quote = await buildSignedQuote()
    mockTxResponse = buildTx(quote)
    const req: SettlementRequest = {
      ...makeRequest(quote),
      cluster: "mainnet-beta",
    }
    const result = await verifyAndExecute(req, async () => {})
    expect(result.explorer_tx).not.toContain("?cluster=")
    expect(result.explorer_tx).toContain(FAKE_TX_SIG)
  })
})
