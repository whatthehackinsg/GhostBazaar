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
} from "@ghost-bazaar/core"
import { verifySettlement, type SettlementRequest } from "../src/execute.js"
import { SettlementError } from "../src/errors.js"
import { isNonceConsumed } from "../src/nonce.js"

const USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"

const buyerKeypair = Keypair.generate()
const sellerKeypair = Keypair.generate()
const buyerDid = buildDid(buyerKeypair.publicKey)
const sellerDid = buildDid(sellerKeypair.publicKey)

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

function buildMockTx(quote: any) {
  const amount = normalizeAmount(quote.final_price, USDC_MINT).toString()
  return {
    slot: 12345,
    blockTime: Math.floor(Date.now() / 1000),
    meta: {
      err: null,
      innerInstructions: [],
      logMessages: [],
    },
    transaction: {
      message: {
        instructions: [
          {
            programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
            program: "spl-token",
            parsed: {
              type: "transferChecked",
              info: {
                source: "BuyerTokenAccount",
                destination: sellerAta.toBase58(),
                tokenAmount: { amount },
                mint: USDC_MINT,
              },
            },
          },
          {
            programId: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
            program: "spl-memo",
            parsed: `GhostBazaar:quote_id:${quote.quote_id}`,
          },
        ],
        accountKeys: [],
      },
    },
  }
}

// Mock Connection
vi.mock("@solana/web3.js", async () => {
  const actual = await vi.importActual("@solana/web3.js") as any
  let mockTxResponse: any = null

  class MockConnection {
    constructor() {}
    async getTransaction() { return mockTxResponse }
  }

  return {
    ...actual,
    Connection: MockConnection,
    __setMockTx: (tx: any) => { mockTxResponse = tx },
  }
})

const { __setMockTx } = await import("@solana/web3.js") as any

describe("verifySettlement", () => {
  it("returns VerificationResult with proof-carrying fields on valid tx", async () => {
    const quote = await buildSignedQuote()
    const mockTx = buildMockTx(quote)
    __setMockTx(mockTx)

    const request: SettlementRequest = {
      quoteHeaderB64: Buffer.from(JSON.stringify(quote)).toString("base64"),
      paymentSignature: FAKE_TX_SIG,
      rpcUrl: "https://api.devnet.solana.com",
      usdcMint: USDC_MINT,
    }

    const result = await verifySettlement(request)

    expect(result.valid).toBe(true)
    expect(result.tx_sig).toBe(FAKE_TX_SIG)
    expect(result.quote.quote_id).toBe(quote.quote_id)
    expect(result.verification.amount_matched).toBe(true)
    expect(result.verification.mint_matched).toBe(true)
    expect(result.verification.destination_matched).toBe(true)
    expect(result.verification.memo_matched).toBe(true)
    expect(result.verification.confirmations).toBeGreaterThan(0)
    expect(result.verification.solana_explorer).toContain(FAKE_TX_SIG)
  })

  it("does NOT consume nonce (safe to retry)", async () => {
    const quote = await buildSignedQuote()
    const mockTx = buildMockTx(quote)
    __setMockTx(mockTx)

    const request: SettlementRequest = {
      quoteHeaderB64: Buffer.from(JSON.stringify(quote)).toString("base64"),
      paymentSignature: FAKE_TX_SIG,
      rpcUrl: "https://api.devnet.solana.com",
      usdcMint: USDC_MINT,
    }

    await verifySettlement(request)

    // Nonce should NOT be consumed
    expect(isNonceConsumed(quote.quote_id)).toBe(false)
  })

  it("does NOT reject expired quotes (supports delayed callbacks)", async () => {
    const quote = await buildSignedQuote({ expires_seconds: -1 })
    const mockTx = buildMockTx(quote)
    __setMockTx(mockTx)

    const request: SettlementRequest = {
      quoteHeaderB64: Buffer.from(JSON.stringify(quote)).toString("base64"),
      paymentSignature: FAKE_TX_SIG,
      rpcUrl: "https://api.devnet.solana.com",
      usdcMint: USDC_MINT,
    }

    // Should succeed despite quote being expired
    const result = await verifySettlement(request)
    expect(result.valid).toBe(true)
  })

  it("rejects invalid payment signature", async () => {
    const quote = await buildSignedQuote()
    __setMockTx(null)

    const request: SettlementRequest = {
      quoteHeaderB64: Buffer.from(JSON.stringify(quote)).toString("base64"),
      paymentSignature: "invalid",
      rpcUrl: "https://api.devnet.solana.com",
      usdcMint: USDC_MINT,
    }

    await expect(verifySettlement(request)).rejects.toThrow(SettlementError)
  })

  it("rejects when transaction not found", async () => {
    const quote = await buildSignedQuote()
    __setMockTx(null)

    const request: SettlementRequest = {
      quoteHeaderB64: Buffer.from(JSON.stringify(quote)).toString("base64"),
      paymentSignature: FAKE_TX_SIG,
      rpcUrl: "https://api.devnet.solana.com",
      usdcMint: USDC_MINT,
    }

    await expect(verifySettlement(request)).rejects.toThrow(SettlementError)
  })

  it("rejects malformed quote header", async () => {
    const request: SettlementRequest = {
      quoteHeaderB64: "not-valid-base64-json",
      paymentSignature: FAKE_TX_SIG,
      rpcUrl: "https://api.devnet.solana.com",
      usdcMint: USDC_MINT,
    }

    await expect(verifySettlement(request)).rejects.toThrow(SettlementError)
  })
})
