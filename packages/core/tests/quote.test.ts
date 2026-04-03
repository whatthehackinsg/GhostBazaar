import { describe, it, expect } from "vitest"
import { Keypair } from "@solana/web3.js"
import { buildUnsignedQuote, signQuoteAsBuyer, signQuoteAsSeller, verifyQuote, didToPublicKey } from "../src/quote.js"
import { buildDid } from "../src/signing.js"

describe("Quote lifecycle", () => {
  const buyerKp = Keypair.generate()
  const sellerKp = Keypair.generate()
  const buyerDid = buildDid(buyerKp.publicKey)
  const sellerDid = buildDid(sellerKp.publicKey)

  it("build → sign buyer → sign seller → verify", async () => {
    const unsigned = buildUnsignedQuote({
      rfq_id: "550e8400-e29b-41d4-a716-446655440000",
      buyer: buyerDid,
      seller: sellerDid,
      service_type: "ghost-bazaar:services:audit",
      final_price: "36.50",
      currency: "USDC",
      payment_endpoint: "https://seller.example/execute",
      expires_seconds: 300,
    })

    expect(unsigned.buyer_signature).toBe("")
    expect(unsigned.seller_signature).toBe("")
    expect(unsigned.memo_policy).toBe("quote_id_required")
    expect(unsigned.nonce).toMatch(/^0x[0-9a-f]{64}$/)

    const buyerSigned = await signQuoteAsBuyer(unsigned, buyerKp)
    expect(buyerSigned.buyer_signature).toMatch(/^ed25519:/)
    expect(buyerSigned.seller_signature).toBe("")

    const fullySigned = await signQuoteAsSeller(buyerSigned, sellerKp)
    expect(fullySigned.seller_signature).toMatch(/^ed25519:/)

    const result = await verifyQuote(fullySigned)
    expect(result.ok).toBe(true)
  })

  it("fails verification on tampered price", async () => {
    const unsigned = buildUnsignedQuote({
      rfq_id: "550e8400-e29b-41d4-a716-446655440000",
      buyer: buyerDid,
      seller: sellerDid,
      service_type: "ghost-bazaar:services:audit",
      final_price: "36.50",
      currency: "USDC",
      payment_endpoint: "https://seller.example/execute",
      expires_seconds: 300,
    })

    const buyerSigned = await signQuoteAsBuyer(unsigned, buyerKp)
    const fullySigned = await signQuoteAsSeller(buyerSigned, sellerKp)

    const tampered = { ...fullySigned, final_price: "99.00" }
    const result = await verifyQuote(tampered)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe("invalid_buyer_signature")
  })

  it("fails verification on tampered seller", async () => {
    const unsigned = buildUnsignedQuote({
      rfq_id: "550e8400-e29b-41d4-a716-446655440000",
      buyer: buyerDid,
      seller: sellerDid,
      service_type: "ghost-bazaar:services:audit",
      final_price: "36.50",
      currency: "USDC",
      payment_endpoint: "https://seller.example/execute",
      expires_seconds: 300,
    })

    const buyerSigned = await signQuoteAsBuyer(unsigned, buyerKp)
    const fullySigned = await signQuoteAsSeller(buyerSigned, sellerKp)

    // Swap seller DID to a different key
    const fakeKp = Keypair.generate()
    const tampered = { ...fullySigned, seller: buildDid(fakeKp.publicKey) }
    const result = await verifyQuote(tampered)
    expect(result.ok).toBe(false)
  })

  it("rejects zero final_price", async () => {
    const unsigned = buildUnsignedQuote({
      rfq_id: "550e8400-e29b-41d4-a716-446655440000",
      buyer: buyerDid,
      seller: sellerDid,
      service_type: "ghost-bazaar:services:audit",
      final_price: "36.50",
      currency: "USDC",
      payment_endpoint: "https://seller.example/execute",
      expires_seconds: 300,
    })

    const buyerSigned = await signQuoteAsBuyer(unsigned, buyerKp)
    const fullySigned = await signQuoteAsSeller(buyerSigned, sellerKp)

    const tampered = { ...fullySigned, final_price: "0" }
    const result = await verifyQuote(tampered)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe("invalid_amount")
  })

  it("rejects negative final_price", async () => {
    const unsigned = buildUnsignedQuote({
      rfq_id: "550e8400-e29b-41d4-a716-446655440000",
      buyer: buyerDid,
      seller: sellerDid,
      service_type: "ghost-bazaar:services:audit",
      final_price: "36.50",
      currency: "USDC",
      payment_endpoint: "https://seller.example/execute",
      expires_seconds: 300,
    })

    const buyerSigned = await signQuoteAsBuyer(unsigned, buyerKp)
    const fullySigned = await signQuoteAsSeller(buyerSigned, sellerKp)

    const tampered = { ...fullySigned, final_price: "-10.00" }
    const result = await verifyQuote(tampered)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe("invalid_amount")
  })

  it("rejects invalid nonce format", async () => {
    const unsigned = buildUnsignedQuote({
      rfq_id: "550e8400-e29b-41d4-a716-446655440000",
      buyer: buyerDid,
      seller: sellerDid,
      service_type: "ghost-bazaar:services:audit",
      final_price: "36.50",
      currency: "USDC",
      payment_endpoint: "https://seller.example/execute",
      expires_seconds: 300,
    })

    const buyerSigned = await signQuoteAsBuyer(unsigned, buyerKp)
    const fullySigned = await signQuoteAsSeller(buyerSigned, sellerKp)

    // Uppercase hex nonce — must be rejected per v4 spec
    const badNonce = { ...fullySigned, nonce: "0x" + "A".repeat(64) }
    const result = await verifyQuote(badNonce)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe("invalid_nonce_format")
  })

  it("auto-computes spec_hash when spec provided", () => {
    const unsigned = buildUnsignedQuote({
      rfq_id: "550e8400-e29b-41d4-a716-446655440000",
      buyer: buyerDid,
      seller: sellerDid,
      service_type: "ghost-bazaar:services:audit",
      final_price: "36.50",
      currency: "USDC",
      payment_endpoint: "https://seller.example/execute",
      expires_seconds: 300,
      spec: { language: "solidity", lines: 500 },
    })
    expect(unsigned.spec_hash).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it("uses explicit spec_hash over auto-computed", () => {
    const unsigned = buildUnsignedQuote({
      rfq_id: "550e8400-e29b-41d4-a716-446655440000",
      buyer: buyerDid,
      seller: sellerDid,
      service_type: "ghost-bazaar:services:audit",
      final_price: "36.50",
      currency: "USDC",
      payment_endpoint: "https://seller.example/execute",
      expires_seconds: 300,
      spec_hash: "sha256:custom",
      spec: { language: "solidity" },
    })
    expect(unsigned.spec_hash).toBe("sha256:custom")
  })
})

describe("Quote expiry", () => {
  const buyerKp = Keypair.generate()
  const sellerKp = Keypair.generate()
  const buyerDid = buildDid(buyerKp.publicKey)
  const sellerDid = buildDid(sellerKp.publicKey)

  it("rejects expired quote", async () => {
    const unsigned = buildUnsignedQuote({
      rfq_id: "550e8400-e29b-41d4-a716-446655440000",
      buyer: buyerDid,
      seller: sellerDid,
      service_type: "ghost-bazaar:services:audit",
      final_price: "36.50",
      currency: "USDC",
      payment_endpoint: "https://seller.example/execute",
      expires_seconds: 300,
    })

    // Set expires_at to the past
    unsigned.expires_at = new Date(Date.now() - 60_000).toISOString()

    const buyerSigned = await signQuoteAsBuyer(unsigned, buyerKp)
    const fullySigned = await signQuoteAsSeller(buyerSigned, sellerKp)

    const result = await verifyQuote(fullySigned)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe("expired_quote")
  })

  it("rejects quote with invalid expires_at", async () => {
    const unsigned = buildUnsignedQuote({
      rfq_id: "550e8400-e29b-41d4-a716-446655440000",
      buyer: buyerDid,
      seller: sellerDid,
      service_type: "ghost-bazaar:services:audit",
      final_price: "36.50",
      currency: "USDC",
      payment_endpoint: "https://seller.example/execute",
      expires_seconds: 300,
    })

    unsigned.expires_at = "not-a-date"

    const buyerSigned = await signQuoteAsBuyer(unsigned, buyerKp)
    const fullySigned = await signQuoteAsSeller(buyerSigned, sellerKp)

    const result = await verifyQuote(fullySigned)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe("expired_quote")
  })
})

describe("Quote nonce edge cases", () => {
  const buyerKp = Keypair.generate()
  const sellerKp = Keypair.generate()
  const buyerDid = buildDid(buyerKp.publicKey)
  const sellerDid = buildDid(sellerKp.publicKey)

  async function makeSignedQuote(nonceOverride?: string) {
    const unsigned = buildUnsignedQuote({
      rfq_id: "550e8400-e29b-41d4-a716-446655440000",
      buyer: buyerDid,
      seller: sellerDid,
      service_type: "ghost-bazaar:services:audit",
      final_price: "36.50",
      currency: "USDC",
      payment_endpoint: "https://seller.example/execute",
      expires_seconds: 300,
    })
    if (nonceOverride) unsigned.nonce = nonceOverride
    const buyerSigned = await signQuoteAsBuyer(unsigned, buyerKp)
    return signQuoteAsSeller(buyerSigned, sellerKp)
  }

  it("rejects nonce missing 0x prefix", async () => {
    const quote = await makeSignedQuote("ab".repeat(32))
    const result = await verifyQuote(quote)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe("invalid_nonce_format")
  })

  it("rejects nonce too short", async () => {
    const quote = await makeSignedQuote("0x" + "ab".repeat(16))
    const result = await verifyQuote(quote)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe("invalid_nonce_format")
  })

  it("rejects nonce too long", async () => {
    const quote = await makeSignedQuote("0x" + "ab".repeat(64))
    const result = await verifyQuote(quote)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe("invalid_nonce_format")
  })
})

describe("Quote unsigned/empty signature", () => {
  const buyerKp = Keypair.generate()
  const sellerKp = Keypair.generate()
  const buyerDid = buildDid(buyerKp.publicKey)
  const sellerDid = buildDid(sellerKp.publicKey)

  it("rejects unsigned quote (both signatures empty)", async () => {
    const unsigned = buildUnsignedQuote({
      rfq_id: "550e8400-e29b-41d4-a716-446655440000",
      buyer: buyerDid,
      seller: sellerDid,
      service_type: "ghost-bazaar:services:audit",
      final_price: "36.50",
      currency: "USDC",
      payment_endpoint: "https://seller.example/execute",
      expires_seconds: 300,
    })
    const result = await verifyQuote(unsigned)
    expect(result.ok).toBe(false)
  })

  it("rejects quote with only buyer signature", async () => {
    const unsigned = buildUnsignedQuote({
      rfq_id: "550e8400-e29b-41d4-a716-446655440000",
      buyer: buyerDid,
      seller: sellerDid,
      service_type: "ghost-bazaar:services:audit",
      final_price: "36.50",
      currency: "USDC",
      payment_endpoint: "https://seller.example/execute",
      expires_seconds: 300,
    })
    const buyerSigned = await signQuoteAsBuyer(unsigned, buyerKp)
    const result = await verifyQuote(buyerSigned)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe("invalid_seller_signature")
  })
})

describe("Quote extension tampering", () => {
  const buyerKp = Keypair.generate()
  const sellerKp = Keypair.generate()
  const buyerDid = buildDid(buyerKp.publicKey)
  const sellerDid = buildDid(sellerKp.publicKey)

  it("tampering extensions invalidates signatures", async () => {
    const unsigned = buildUnsignedQuote({
      rfq_id: "550e8400-e29b-41d4-a716-446655440000",
      buyer: buyerDid,
      seller: sellerDid,
      service_type: "ghost-bazaar:services:audit",
      final_price: "36.50",
      currency: "USDC",
      payment_endpoint: "https://seller.example/execute",
      expires_seconds: 300,
    })
    // Add extensions before signing
    const withExt = { ...unsigned, extensions: { "x-acme:priority": "high" } }
    const buyerSigned = await signQuoteAsBuyer(withExt, buyerKp)
    const fullySigned = await signQuoteAsSeller(buyerSigned, sellerKp)

    // Verify original passes
    const okResult = await verifyQuote(fullySigned)
    expect(okResult.ok).toBe(true)

    // Tamper extensions
    const tampered = { ...fullySigned, extensions: { "x-acme:priority": "low" } }
    const badResult = await verifyQuote(tampered)
    expect(badResult.ok).toBe(false)
  })
})

describe("verifyQuote malformed DID", () => {
  const buyerKp = Keypair.generate()
  const sellerKp = Keypair.generate()
  const buyerDid = buildDid(buyerKp.publicKey)
  const sellerDid = buildDid(sellerKp.publicKey)

  it("returns malformed_quote for garbage buyer DID", async () => {
    const unsigned = buildUnsignedQuote({
      rfq_id: "550e8400-e29b-41d4-a716-446655440000",
      buyer: buyerDid,
      seller: sellerDid,
      service_type: "ghost-bazaar:services:audit",
      final_price: "36.50",
      currency: "USDC",
      payment_endpoint: "https://seller.example/execute",
      expires_seconds: 300,
    })
    const buyerSigned = await signQuoteAsBuyer(unsigned, buyerKp)
    const fullySigned = await signQuoteAsSeller(buyerSigned, sellerKp)

    const tampered = { ...fullySigned, buyer: "not-a-did" }
    const result = await verifyQuote(tampered)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe("malformed_quote")
  })

  it("returns malformed_quote for garbage seller DID", async () => {
    const unsigned = buildUnsignedQuote({
      rfq_id: "550e8400-e29b-41d4-a716-446655440000",
      buyer: buyerDid,
      seller: sellerDid,
      service_type: "ghost-bazaar:services:audit",
      final_price: "36.50",
      currency: "USDC",
      payment_endpoint: "https://seller.example/execute",
      expires_seconds: 300,
    })
    const buyerSigned = await signQuoteAsBuyer(unsigned, buyerKp)
    const fullySigned = await signQuoteAsSeller(buyerSigned, sellerKp)

    const tampered = { ...fullySigned, seller: "did:key:z5invalid" }
    const result = await verifyQuote(tampered)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe("malformed_quote")
  })
})

describe("buildUnsignedQuote memo_policy", () => {
  const buyerKp = Keypair.generate()
  const sellerKp = Keypair.generate()
  const buyerDid = buildDid(buyerKp.publicKey)
  const sellerDid = buildDid(sellerKp.publicKey)

  it("passes through custom memo_policy 'optional'", () => {
    const unsigned = buildUnsignedQuote({
      rfq_id: "550e8400-e29b-41d4-a716-446655440000",
      buyer: buyerDid,
      seller: sellerDid,
      service_type: "ghost-bazaar:services:audit",
      final_price: "36.50",
      currency: "USDC",
      payment_endpoint: "https://seller.example/execute",
      expires_seconds: 300,
      memo_policy: "optional",
    })
    expect(unsigned.memo_policy).toBe("optional")
  })

  it("passes through custom memo_policy 'hash_required'", () => {
    const unsigned = buildUnsignedQuote({
      rfq_id: "550e8400-e29b-41d4-a716-446655440000",
      buyer: buyerDid,
      seller: sellerDid,
      service_type: "ghost-bazaar:services:audit",
      final_price: "36.50",
      currency: "USDC",
      payment_endpoint: "https://seller.example/execute",
      expires_seconds: 300,
      memo_policy: "hash_required",
    })
    expect(unsigned.memo_policy).toBe("hash_required")
  })
})

describe("didToPublicKey", () => {
  it("round-trips through buildDid", () => {
    const kp = Keypair.generate()
    const did = buildDid(kp.publicKey)
    const recovered = didToPublicKey(did)
    expect(recovered).not.toBeNull()
    expect(recovered!.toBase58()).toBe(kp.publicKey.toBase58())
  })

  it("returns null for invalid DID", () => {
    expect(didToPublicKey("not-a-did")).toBeNull()
    expect(didToPublicKey("did:key:z5wrong")).toBeNull()
  })
})
