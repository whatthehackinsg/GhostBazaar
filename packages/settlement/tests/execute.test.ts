import { describe, it, expect, beforeEach, vi } from "vitest"
import { Keypair, PublicKey } from "@solana/web3.js"
import { getAssociatedTokenAddressSync } from "@solana/spl-token"
import bs58 from "bs58"
import {
  buildDid,
  signQuoteAsBuyer,
  signQuoteAsSeller,
  buildUnsignedQuote,
  normalizeAmount,
  registerMint,
} from "@ghost-bazaar/core"
import { verifyAndExecute, type SettlementRequest } from "../src/execute.js"
import { resetNonces, consumeNonce } from "../src/nonce.js"
import { SettlementError } from "../src/errors.js"

// Test USDC mint (devnet)
const USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"

// Generate test keypairs
const buyerKeypair = Keypair.generate()
const sellerKeypair = Keypair.generate()
const buyerDid = buildDid(buyerKeypair.publicKey)
const sellerDid = buildDid(sellerKeypair.publicKey)

// Derive seller ATA
const sellerAta = getAssociatedTokenAddressSync(
  new PublicKey(USDC_MINT),
  sellerKeypair.publicKey,
)

const FAKE_TX_SIG = bs58.encode(new Uint8Array(64).fill(1))

async function buildSignedQuote(overrides?: Partial<Parameters<typeof buildUnsignedQuote>[0]>) {
  const quote = buildUnsignedQuote({
    rfq_id: "550e8400-e29b-41d4-a716-446655440000",
    buyer: buyerDid,
    seller: sellerDid,
    service_type: "smart-contract-audit",
    final_price: "36.50",
    currency: "USDC",
    payment_endpoint: "https://seller.example/execute",
    expires_seconds: 600,
    memo_policy: "quote_id_required",
    ...overrides,
  })
  const buyerSigned = await signQuoteAsBuyer(quote, buyerKeypair)
  return signQuoteAsSeller(buyerSigned, sellerKeypair)
}

function encodeQuoteHeader(quote: any): string {
  return Buffer.from(JSON.stringify(quote)).toString("base64")
}

function buildMockTx(quote: any, opts?: {
  amount?: string
  destination?: string
  mint?: string
  memo?: string | null
  failed?: boolean
  noTransfer?: boolean
  /** Use plain "transfer" instead of "transferChecked" (no mint field) */
  plainTransfer?: boolean
}) {
  const amount = opts?.amount ?? normalizeAmount(quote.final_price, USDC_MINT).toString()
  const destination = opts?.destination ?? sellerAta.toBase58()
  const mint = opts?.mint ?? USDC_MINT

  const instructions: any[] = []

  if (!opts?.noTransfer) {
    if (opts?.plainTransfer) {
      // Plain transfer — no mint in parsed info
      instructions.push({
        programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
        program: "spl-token",
        parsed: {
          type: "transfer",
          info: {
            source: "BuyerTokenAccount111111111111111111111111111",
            destination,
            amount,
            authority: buyerKeypair.publicKey.toBase58(),
          },
        },
      })
    } else {
      instructions.push({
        programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
        program: "spl-token",
        parsed: {
          type: "transferChecked",
          info: {
            source: "BuyerTokenAccount111111111111111111111111111",
            destination,
            tokenAmount: { amount },
            mint,
            authority: buyerKeypair.publicKey.toBase58(),
          },
        },
      })
    }
  }

  if (opts?.memo !== null) {
    const memoContent = opts?.memo ?? `GhostBazaar:quote_id:${quote.quote_id}`
    instructions.push({
      programId: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
      program: "spl-memo",
      parsed: memoContent,
    })
  }

  return {
    slot: 12345,
    meta: {
      err: opts?.failed ? { InstructionError: [0, "Custom"] } : null,
      innerInstructions: [],
      logMessages: [],
    },
    transaction: {
      message: {
        instructions,
        accountKeys: [],
      },
    },
  }
}

// Mock @solana/web3.js Connection
vi.mock("@solana/web3.js", async () => {
  const actual = await vi.importActual("@solana/web3.js") as any
  let mockTxResponse: any = null

  class MockConnection {
    constructor(_url: string, _commitment: string) {}
    async getTransaction(_sig: string, _opts: any) {
      return mockTxResponse
    }
  }

  return {
    ...actual,
    Connection: MockConnection,
    __setMockTx: (tx: any) => { mockTxResponse = tx },
  }
})

const { __setMockTx } = await import("@solana/web3.js") as any

const noopExecutor = async () => {}

function makeRequest(quoteHeaderB64: string, paymentSignature?: string): SettlementRequest {
  return {
    quoteHeaderB64,
    paymentSignature: paymentSignature ?? FAKE_TX_SIG,
    rpcUrl: "https://api.devnet.solana.com",
    usdcMint: USDC_MINT,
  }
}

describe("Settlement: 17-step validation", () => {
  beforeEach(() => {
    resetNonces()
    __setMockTx(null)
  })

  // ── Step 1: Quote header decoding ──

  it("rejects missing/empty quote header → malformed_quote_header", async () => {
    const req = makeRequest("")
    await expect(verifyAndExecute(req, noopExecutor)).rejects.toMatchObject({
      code: "malformed_quote_header",
      httpStatus: 400,
    })
  })

  it("rejects non-base64 quote header → malformed_quote_header", async () => {
    const req = makeRequest("not-valid-base64!!!")
    await expect(verifyAndExecute(req, noopExecutor)).rejects.toMatchObject({
      code: "malformed_quote_header",
      httpStatus: 400,
    })
  })

  it("rejects invalid JSON in quote header → malformed_quote_header", async () => {
    const req = makeRequest(Buffer.from("not json").toString("base64"))
    await expect(verifyAndExecute(req, noopExecutor)).rejects.toMatchObject({
      code: "malformed_quote_header",
      httpStatus: 400,
    })
  })

  // ── Steps 2-3: Signature verification ──

  it("rejects invalid buyer signature → invalid_buyer_signature", async () => {
    const quote = await buildSignedQuote()
    const tampered = { ...quote, buyer_signature: "ed25519:AAAA" }
    const req = makeRequest(encodeQuoteHeader(tampered))
    await expect(verifyAndExecute(req, noopExecutor)).rejects.toMatchObject({
      code: "invalid_buyer_signature",
      httpStatus: 401,
    })
  })

  it("rejects invalid seller signature → invalid_seller_signature", async () => {
    const quote = await buildSignedQuote()
    const tampered = { ...quote, seller_signature: "ed25519:AAAA" }
    const req = makeRequest(encodeQuoteHeader(tampered))
    await expect(verifyAndExecute(req, noopExecutor)).rejects.toMatchObject({
      code: "invalid_seller_signature",
      httpStatus: 401,
    })
  })

  // ── Step 4: Payment-Signature decoding ──

  it("rejects non-base58 payment signature → invalid_payment_signature", async () => {
    const quote = await buildSignedQuote()
    const req = makeRequest(encodeQuoteHeader(quote), "not-base58!!!")
    await expect(verifyAndExecute(req, noopExecutor)).rejects.toMatchObject({
      code: "invalid_payment_signature",
      httpStatus: 400,
    })
  })

  it("rejects payment signature with wrong length → invalid_payment_signature", async () => {
    const quote = await buildSignedQuote()
    const shortSig = bs58.encode(new Uint8Array(32).fill(1))
    const req = makeRequest(encodeQuoteHeader(quote), shortSig)
    await expect(verifyAndExecute(req, noopExecutor)).rejects.toMatchObject({
      code: "invalid_payment_signature",
      httpStatus: 400,
    })
  })

  // ── Step 5: Transaction not found ──

  it("rejects when transaction not found → transaction_not_found", async () => {
    const quote = await buildSignedQuote()
    __setMockTx(null)
    const req = makeRequest(encodeQuoteHeader(quote))
    await expect(verifyAndExecute(req, noopExecutor)).rejects.toMatchObject({
      code: "transaction_not_found",
      httpStatus: 404,
    })
  })

  // ── Step 6: Transaction failed ──

  it("rejects failed transaction → transaction_failed", async () => {
    const quote = await buildSignedQuote()
    __setMockTx(buildMockTx(quote, { failed: true }))
    const req = makeRequest(encodeQuoteHeader(quote))
    await expect(verifyAndExecute(req, noopExecutor)).rejects.toMatchObject({
      code: "transaction_failed",
      httpStatus: 422,
    })
  })

  // ── Step 7: No SPL transfer instruction ──

  it("rejects tx without SPL transfer → transfer_instruction_missing", async () => {
    const quote = await buildSignedQuote()
    __setMockTx(buildMockTx(quote, { noTransfer: true }))
    const req = makeRequest(encodeQuoteHeader(quote))
    await expect(verifyAndExecute(req, noopExecutor)).rejects.toMatchObject({
      code: "transfer_instruction_missing",
      httpStatus: 422,
    })
  })

  // ── Step 8: Destination mismatch ──

  it("rejects transfer to wrong destination → transfer_destination_mismatch", async () => {
    const quote = await buildSignedQuote()
    __setMockTx(buildMockTx(quote, {
      destination: Keypair.generate().publicKey.toBase58(),
    }))
    const req = makeRequest(encodeQuoteHeader(quote))
    await expect(verifyAndExecute(req, noopExecutor)).rejects.toMatchObject({
      code: "transfer_destination_mismatch",
      httpStatus: 422,
    })
  })

  // ── Step 9: Mint mismatch ──

  it("rejects wrong token mint → transfer_mint_mismatch", async () => {
    const quote = await buildSignedQuote()
    __setMockTx(buildMockTx(quote, {
      mint: Keypair.generate().publicKey.toBase58(),
    }))
    const req = makeRequest(encodeQuoteHeader(quote))
    await expect(verifyAndExecute(req, noopExecutor)).rejects.toMatchObject({
      code: "transfer_mint_mismatch",
      httpStatus: 422,
    })
  })

  it("rejects plain transfer without mint → transfer_mint_mismatch", async () => {
    const quote = await buildSignedQuote()
    __setMockTx(buildMockTx(quote, { plainTransfer: true }))
    const req = makeRequest(encodeQuoteHeader(quote))
    await expect(verifyAndExecute(req, noopExecutor)).rejects.toMatchObject({
      code: "transfer_mint_mismatch",
      httpStatus: 422,
    })
  })

  // ── Step 10: Price mismatch ──

  it("rejects amount mismatch → price_mismatch", async () => {
    const quote = await buildSignedQuote()
    __setMockTx(buildMockTx(quote, { amount: "999" }))
    const req = makeRequest(encodeQuoteHeader(quote))
    await expect(verifyAndExecute(req, noopExecutor)).rejects.toMatchObject({
      code: "price_mismatch",
      httpStatus: 422,
    })
  })

  // ── Step 11: Memo missing ──

  it("rejects missing memo when quote_id_required → memo_missing", async () => {
    const quote = await buildSignedQuote({ memo_policy: "quote_id_required" })
    __setMockTx(buildMockTx(quote, { memo: null }))
    const req = makeRequest(encodeQuoteHeader(quote))
    await expect(verifyAndExecute(req, noopExecutor)).rejects.toMatchObject({
      code: "memo_missing",
      httpStatus: 422,
    })
  })

  it("rejects memo with wrong quote_id → memo_mismatch", async () => {
    const quote = await buildSignedQuote({ memo_policy: "quote_id_required" })
    __setMockTx(buildMockTx(quote, { memo: "GhostBazaar:quote_id:wrong-id" }))
    const req = makeRequest(encodeQuoteHeader(quote))
    await expect(verifyAndExecute(req, noopExecutor)).rejects.toMatchObject({
      code: "memo_mismatch",
      httpStatus: 422,
    })
  })

  // ── Step 12: Memo hash ──

  it("rejects memo with wrong hash → memo_mismatch (hash_required)", async () => {
    const quote = await buildSignedQuote({ memo_policy: "hash_required" })
    __setMockTx(buildMockTx(quote, { memo: "wronghashvalue" }))
    const req = makeRequest(encodeQuoteHeader(quote))
    await expect(verifyAndExecute(req, noopExecutor)).rejects.toMatchObject({
      code: "memo_mismatch",
      httpStatus: 422,
    })
  })

  it("skips memo check when memo_policy is optional → 200", async () => {
    const quote = await buildSignedQuote({ memo_policy: "optional" })
    __setMockTx(buildMockTx(quote, { memo: null }))
    const req = makeRequest(encodeQuoteHeader(quote))
    const result = await verifyAndExecute(req, noopExecutor)
    expect(result.receipt.quote_id).toBe(quote.quote_id)
  })

  // ── Step 14: Nonce replay ──

  it("rejects replayed nonce → nonce_replayed", async () => {
    const quote = await buildSignedQuote()
    __setMockTx(buildMockTx(quote))
    consumeNonce(quote.quote_id)
    const req = makeRequest(encodeQuoteHeader(quote))
    await expect(verifyAndExecute(req, noopExecutor)).rejects.toMatchObject({
      code: "nonce_replayed",
      httpStatus: 409,
    })
  })

  // ── Step 16: Execution failure ──

  it("rejects when executor throws → execution_failed", async () => {
    const quote = await buildSignedQuote()
    __setMockTx(buildMockTx(quote))
    const req = makeRequest(encodeQuoteHeader(quote))
    const failingExecutor = async () => { throw new Error("service unavailable") }
    await expect(verifyAndExecute(req, failingExecutor)).rejects.toMatchObject({
      code: "execution_failed",
      httpStatus: 500,
    })
  })

  // ── Happy path ──

  it("valid settlement → 200 with receipt", async () => {
    const quote = await buildSignedQuote()
    __setMockTx(buildMockTx(quote))
    const req = makeRequest(encodeQuoteHeader(quote))

    let executedQuote: any = null
    const executor = async (q: any) => { executedQuote = q }

    const result = await verifyAndExecute(req, executor)

    expect(result.receipt.quote_id).toBe(quote.quote_id)
    expect(result.receipt.final_price).toBe("36.50")
    expect(result.receipt.buyer_pubkey).toBe(buyerKeypair.publicKey.toBase58())
    expect(result.receipt.seller_pubkey).toBe(sellerKeypair.publicKey.toBase58())
    expect(result.settlement_ms).toBeGreaterThanOrEqual(0)
    expect(result.explorer_tx).toContain(FAKE_TX_SIG)
    expect(executedQuote).not.toBeNull()
    expect(executedQuote.quote_id).toBe(quote.quote_id)
  })

  it("nonce is consumed after successful settlement", async () => {
    const quote = await buildSignedQuote()
    __setMockTx(buildMockTx(quote))
    const req = makeRequest(encodeQuoteHeader(quote))

    await verifyAndExecute(req, noopExecutor)

    // Second attempt should fail with nonce_replayed
    const quote2 = await buildSignedQuote()
    // Use same quote_id — nonce is keyed by quote_id
    __setMockTx(buildMockTx(quote))
    const req2 = makeRequest(encodeQuoteHeader(quote))
    await expect(verifyAndExecute(req2, noopExecutor)).rejects.toMatchObject({
      code: "nonce_replayed",
    })
  })

  it("SettlementError has correct properties", () => {
    const err = new SettlementError("test_code", 418, "test message")
    expect(err.code).toBe("test_code")
    expect(err.httpStatus).toBe(418)
    expect(err.message).toBe("test message")
    expect(err.name).toBe("SettlementError")
    expect(err).toBeInstanceOf(Error)
  })
})
