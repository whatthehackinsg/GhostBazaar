import { describe, it, expect } from "vitest"
import { Keypair } from "@solana/web3.js"
import { buildDid } from "@ghost-bazaar/core"
import { buildReceipt } from "../src/receipt.js"
import type { SignedQuote } from "@ghost-bazaar/core"

// Use real keypairs so DID → pubkey resolution works
const buyerKeypair = Keypair.generate()
const sellerKeypair = Keypair.generate()
const buyerDid = buildDid(buyerKeypair.publicKey)
const sellerDid = buildDid(sellerKeypair.publicKey)

describe("Deal receipt", () => {
  const mockQuote: SignedQuote = {
    quote_id: "550e8400-e29b-41d4-a716-446655440000",
    rfq_id: "660e8400-e29b-41d4-a716-446655440000",
    buyer: buyerDid,
    seller: sellerDid,
    service_type: "smart-contract-audit",
    final_price: "36.50",
    currency: "USDC",
    payment_endpoint: "https://seller.example/execute",
    expires_at: new Date(Date.now() + 600_000).toISOString(),
    nonce: "0x" + "ab".repeat(32),
    memo_policy: "quote_id_required",
    buyer_signature: "ed25519:fakesig==",
    seller_signature: "ed25519:fakesig==",
  }

  const txSig = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW"

  it("builds receipt with base58 pubkeys, not DIDs", () => {
    const result = buildReceipt(mockQuote, txSig, 412)

    expect(result.receipt.quote_id).toBe(mockQuote.quote_id)
    expect(result.receipt.final_price).toBe("36.50")
    // Should be base58 pubkeys, NOT did:key strings
    expect(result.receipt.buyer_pubkey).toBe(buyerKeypair.publicKey.toBase58())
    expect(result.receipt.seller_pubkey).toBe(sellerKeypair.publicKey.toBase58())
    expect(result.receipt.buyer_pubkey).not.toContain("did:key")
    expect(result.receipt.seller_pubkey).not.toContain("did:key")
    expect(result.receipt.settled_at).toBeDefined()
    expect(result.settlement_ms).toBe(412)
    expect(result.explorer_tx).toContain(txSig)
  })

  it("defaults to devnet cluster in explorer URL", () => {
    const result = buildReceipt(mockQuote, txSig, 100)
    expect(result.explorer_tx).toContain("?cluster=devnet")
  })

  it("mainnet-beta cluster omits cluster param", () => {
    const result = buildReceipt(mockQuote, txSig, 100, { cluster: "mainnet-beta" })
    expect(result.explorer_tx).not.toContain("?cluster=")
    expect(result.explorer_tx).toContain(txSig)
  })

  it("respects explicit cluster option", () => {
    const result = buildReceipt(mockQuote, txSig, 100, { cluster: "testnet" })
    expect(result.explorer_tx).toContain("?cluster=testnet")
  })

  it("settled_at is a valid ISO timestamp", () => {
    const result = buildReceipt(mockQuote, txSig, 100)
    const parsed = Date.parse(result.receipt.settled_at)
    expect(isNaN(parsed)).toBe(false)
  })
})
