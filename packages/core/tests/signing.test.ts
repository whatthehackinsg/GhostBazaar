import { describe, it, expect } from "vitest"
import { canonicalJson, signEd25519, verifyEd25519, buildDid, objectSigningPayload } from "../src/signing.js"

describe("canonicalJson", () => {
  it("sorts keys deterministically", () => {
    const bytes = canonicalJson({ z: 1, a: 2 })
    const str = new TextDecoder().decode(bytes)
    expect(str).toBe('{"a":2,"z":1}')
  })

  it("sorts nested keys", () => {
    const bytes = canonicalJson({ b: { z: 1, a: 2 }, a: 3 })
    const str = new TextDecoder().decode(bytes)
    expect(str).toBe('{"a":3,"b":{"a":2,"z":1}}')
  })

  it("omits empty extensions", () => {
    const bytes = canonicalJson({ a: 1, extensions: {} })
    const str = new TextDecoder().decode(bytes)
    expect(str).toBe('{"a":1}')
  })

  it("preserves non-empty extensions", () => {
    const bytes = canonicalJson({ a: 1, extensions: { "x-acme:priority": "high" } })
    const str = new TextDecoder().decode(bytes)
    expect(str).toContain('"extensions"')
  })

  it("no whitespace in output", () => {
    const bytes = canonicalJson({ hello: "world", num: 42 })
    const str = new TextDecoder().decode(bytes)
    expect(str).not.toMatch(/\s/)
  })

  it("handles arrays without sorting elements", () => {
    const bytes = canonicalJson({ arr: [3, 1, 2] })
    const str = new TextDecoder().decode(bytes)
    expect(str).toBe('{"arr":[3,1,2]}')
  })

  it("prices stay as strings not numbers", () => {
    const bytes = canonicalJson({ price: "36.50" })
    const str = new TextDecoder().decode(bytes)
    expect(str).toBe('{"price":"36.50"}')
  })
})

describe("objectSigningPayload", () => {
  it("sets signature to empty string", () => {
    const payload = objectSigningPayload({ a: 1, signature: "ed25519:abc123" })
    const str = new TextDecoder().decode(payload)
    expect(str).toContain('"signature":""')
    expect(str).not.toContain("abc123")
  })
})

describe("signEd25519 / verifyEd25519", () => {
  it("sign and verify round-trip", async () => {
    const { Keypair } = await import("@solana/web3.js")
    const kp = Keypair.generate()
    const payload = canonicalJson({ test: "data" })
    const sig = await signEd25519(payload, kp)
    expect(sig.startsWith("ed25519:")).toBe(true)
    const valid = await verifyEd25519(payload, sig, kp.publicKey)
    expect(valid).toBe(true)
  })

  it("fails verification on tampered data", async () => {
    const { Keypair } = await import("@solana/web3.js")
    const kp = Keypair.generate()
    const payload = canonicalJson({ test: "data" })
    const sig = await signEd25519(payload, kp)
    const tampered = canonicalJson({ test: "tampered" })
    const valid = await verifyEd25519(tampered, sig, kp.publicKey)
    expect(valid).toBe(false)
  })

  it("fails on wrong key", async () => {
    const { Keypair } = await import("@solana/web3.js")
    const kp1 = Keypair.generate()
    const kp2 = Keypair.generate()
    const payload = canonicalJson({ test: "data" })
    const sig = await signEd25519(payload, kp1)
    const valid = await verifyEd25519(payload, sig, kp2.publicKey)
    expect(valid).toBe(false)
  })

  it("rejects non-ed25519 prefixed signature", async () => {
    const { Keypair } = await import("@solana/web3.js")
    const kp = Keypair.generate()
    const payload = canonicalJson({ test: "data" })
    const valid = await verifyEd25519(payload, "wrong:prefix", kp.publicKey)
    expect(valid).toBe(false)
  })
})

describe("objectSigningPayload with protocol objects", () => {
  it("RFQ signing round-trip: sign with objectSigningPayload, verify", async () => {
    const { Keypair } = await import("@solana/web3.js")
    const kp = Keypair.generate()
    const rfq = {
      rfq_id: "550e8400-e29b-41d4-a716-446655440000",
      protocol: "ghost-bazaar-v4",
      buyer: "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
      service_type: "ghost-bazaar:services:audit",
      spec: { language: "solidity", lines: 500 },
      anchor_price: "35.00",
      currency: "USDC",
      deadline: "2026-12-01T00:00:00Z",
      signature: "",
    }
    const payload = objectSigningPayload(rfq)
    const sig = await signEd25519(payload, kp)
    // Verify with the same payload construction
    const verifyPayload = objectSigningPayload({ ...rfq, signature: sig })
    const valid = await verifyEd25519(verifyPayload, sig, kp.publicKey)
    expect(valid).toBe(true)
  })

  it("Offer signing round-trip", async () => {
    const { Keypair } = await import("@solana/web3.js")
    const kp = Keypair.generate()
    const offer = {
      offer_id: "660e8400-e29b-41d4-a716-446655440001",
      rfq_id: "550e8400-e29b-41d4-a716-446655440000",
      seller: "did:key:z6MksellerDID",
      price: "38.00",
      currency: "USDC",
      valid_until: "2026-12-01T00:00:00Z",
      signature: "",
    }
    const payload = objectSigningPayload(offer)
    const sig = await signEd25519(payload, kp)
    const verifyPayload = objectSigningPayload({ ...offer, signature: sig })
    const valid = await verifyEd25519(verifyPayload, sig, kp.publicKey)
    expect(valid).toBe(true)
  })
})

describe("extension signing", () => {
  it("non-empty extensions are covered by signature", async () => {
    const { Keypair } = await import("@solana/web3.js")
    const kp = Keypair.generate()
    const obj = {
      data: "test",
      extensions: { "x-acme:priority": "high" },
      signature: "",
    }
    const payload = objectSigningPayload(obj)
    const sig = await signEd25519(payload, kp)

    // Tamper the extensions
    const tampered = objectSigningPayload({
      ...obj,
      extensions: { "x-acme:priority": "low" },
      signature: sig,
    })
    const valid = await verifyEd25519(tampered, sig, kp.publicKey)
    expect(valid).toBe(false)
  })
})

describe("objectSigningPayload with CounterOffer", () => {
  it("CounterOffer signing round-trip", async () => {
    const { Keypair } = await import("@solana/web3.js")
    const kp = Keypair.generate()
    const counter = {
      counter_id: "770e8400-e29b-41d4-a716-446655440002",
      rfq_id: "550e8400-e29b-41d4-a716-446655440000",
      round: 1,
      from: "did:key:z6MkbuyerDID",
      to: "did:key:z6MksellerDID",
      price: "36.00",
      currency: "USDC",
      valid_until: "2026-12-01T00:00:00Z",
      signature: "",
    }
    const payload = objectSigningPayload(counter)
    const sig = await signEd25519(payload, kp)
    const verifyPayload = objectSigningPayload({ ...counter, signature: sig })
    const valid = await verifyEd25519(verifyPayload, sig, kp.publicKey)
    expect(valid).toBe(true)
  })
})

describe("canonicalJson determinism", () => {
  it("returns identical bytes for identical input across calls", () => {
    const input = { z: 1, a: "hello", nested: { b: 2, a: 1 } }
    const bytes1 = canonicalJson(input)
    const bytes2 = canonicalJson(input)
    expect(new TextDecoder().decode(bytes1)).toBe(new TextDecoder().decode(bytes2))
  })
})

describe("buildDid", () => {
  it("produces did:key:z6Mk... format", async () => {
    const { Keypair } = await import("@solana/web3.js")
    const kp = Keypair.generate()
    const did = buildDid(kp.publicKey)
    expect(did).toMatch(/^did:key:z6Mk/)
  })

  it("is deterministic for same key", async () => {
    const { Keypair } = await import("@solana/web3.js")
    const kp = Keypair.generate()
    expect(buildDid(kp.publicKey)).toBe(buildDid(kp.publicKey))
  })
})
