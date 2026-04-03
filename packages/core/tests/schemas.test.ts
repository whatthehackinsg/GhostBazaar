import { describe, it, expect } from "vitest"
import { validateRfq, validateOffer, validateCounter, type RFQ } from "../src/schemas.js"

// --- RFQ validation ---

describe("validateRfq", () => {
  const validRfq = {
    rfq_id: "550e8400-e29b-41d4-a716-446655440000",
    protocol: "ghost-bazaar-v4",
    buyer: "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
    service_type: "ghost-bazaar:services:smart-contract-audit",
    spec: { language: "solidity", lines: 500 },
    anchor_price: "35.00",
    currency: "USDC",
    deadline: new Date(Date.now() + 60_000).toISOString(),
    signature: "ed25519:dGVzdA==",
  }

  it("accepts a valid RFQ", () => {
    const result = validateRfq(validRfq)
    expect(result.ok).toBe(true)
  })

  it("rejects unknown protocol version", () => {
    const result = validateRfq({ ...validRfq, protocol: "ghost-bazaar-v99" })
    expect(result.ok).toBe(false)
    expect(result.code).toBe("malformed_payload")
  })

  it("rejects non-positive anchor_price", () => {
    const result = validateRfq({ ...validRfq, anchor_price: "0" })
    expect(result.ok).toBe(false)
    expect(result.code).toBe("invalid_amount")
  })

  it("rejects negative anchor_price", () => {
    const result = validateRfq({ ...validRfq, anchor_price: "-5.00" })
    expect(result.ok).toBe(false)
    expect(result.code).toBe("invalid_amount")
  })

  it("rejects past deadline", () => {
    const result = validateRfq({ ...validRfq, deadline: "2020-01-01T00:00:00Z" })
    expect(result.ok).toBe(false)
    expect(result.code).toBe("invalid_deadline")
  })

  it("rejects invalid budget_commitment format", () => {
    const result = validateRfq({ ...validRfq, budget_commitment: "bad:format" })
    expect(result.ok).toBe(false)
    expect(result.code).toBe("invalid_budget_commitment_format")
  })

  it("accepts valid budget_commitment", () => {
    const commitment = "poseidon:" + "a".repeat(64)
    const result = validateRfq({ ...validRfq, budget_commitment: commitment })
    expect(result.ok).toBe(true)
  })

  it("rejects uppercase hex in budget_commitment", () => {
    const commitment = "poseidon:" + "A".repeat(64)
    const result = validateRfq({ ...validRfq, budget_commitment: commitment })
    expect(result.ok).toBe(false)
    expect(result.code).toBe("invalid_budget_commitment_format")
  })

  it("rejects missing required fields", () => {
    const { rfq_id, ...missing } = validRfq
    const result = validateRfq(missing as any)
    expect(result.ok).toBe(false)
    expect(result.code).toBe("malformed_payload")
  })

  it("rejects unsupported currency", () => {
    const result = validateRfq({ ...validRfq, currency: "BTC" })
    expect(result.ok).toBe(false)
    expect(result.code).toBe("unsupported_currency")
  })

  it("rejects non-numeric anchor_price", () => {
    const result = validateRfq({ ...validRfq, anchor_price: "not-a-number" })
    expect(result.ok).toBe(false)
    expect(result.code).toBe("invalid_amount")
  })

  it("rejects invalid UUID v4 rfq_id", () => {
    const result = validateRfq({ ...validRfq, rfq_id: "not-a-uuid" })
    expect(result.ok).toBe(false)
    expect(result.code).toBe("malformed_payload")
  })

  it("rejects non-DID buyer", () => {
    const result = validateRfq({ ...validRfq, buyer: "just-a-string" })
    expect(result.ok).toBe(false)
    expect(result.code).toBe("malformed_payload")
  })

  it("rejects signature without ed25519: prefix", () => {
    const result = validateRfq({ ...validRfq, signature: "badsig" })
    expect(result.ok).toBe(false)
    expect(result.code).toBe("malformed_payload")
  })
})

// --- Offer validation ---

const baseRfq: RFQ = {
  rfq_id: "550e8400-e29b-41d4-a716-446655440000",
  protocol: "ghost-bazaar-v4",
  buyer: "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
  service_type: "ghost-bazaar:services:audit",
  spec: {},
  anchor_price: "35.00",
  currency: "USDC",
  deadline: new Date(Date.now() + 60_000).toISOString(),
  signature: "ed25519:dGVzdA==",
}

describe("validateOffer", () => {
  const validOffer = {
    offer_id: "660e8400-e29b-41d4-a716-446655440001",
    rfq_id: baseRfq.rfq_id,
    seller: "did:key:z6MksellerDID",
    listing_id: "listing-seller-a",
    price: "38.00",
    currency: "USDC",
    valid_until: new Date(Date.now() + 30_000).toISOString(),
    signature: "ed25519:dGVzdA==",
  }

  it("accepts valid offer", () => {
    expect(validateOffer(validOffer, baseRfq).ok).toBe(true)
  })

  it("rejects currency mismatch", () => {
    const result = validateOffer({ ...validOffer, currency: "SOL" }, baseRfq)
    expect(result.ok).toBe(false)
    expect((result as any).code).toBe("currency_mismatch")
  })

  it("rejects expired offer", () => {
    const result = validateOffer({ ...validOffer, valid_until: "2020-01-01T00:00:00Z" }, baseRfq)
    expect(result.ok).toBe(false)
    expect((result as any).code).toBe("invalid_expiry")
  })

  it("rejects non-positive price", () => {
    const result = validateOffer({ ...validOffer, price: "0" }, baseRfq)
    expect(result.ok).toBe(false)
    expect((result as any).code).toBe("invalid_amount")
  })

  it("rejects missing required fields", () => {
    const { listing_id, ...missing } = validOffer
    const result = validateOffer(missing as any, baseRfq)
    expect(result.ok).toBe(false)
    expect((result as any).code).toBe("malformed_payload")
  })

  it("rejects empty listing_id", () => {
    const result = validateOffer({ ...validOffer, listing_id: "" }, baseRfq)
    expect(result.ok).toBe(false)
    expect((result as any).code).toBe("malformed_payload")
  })

  it("rejects rfq_id mismatch", () => {
    const result = validateOffer({ ...validOffer, rfq_id: "660e8400-e29b-41d4-a716-446655440099" }, baseRfq)
    expect(result.ok).toBe(false)
    expect((result as any).code).toBe("rfq_id_mismatch")
  })

  it("rejects invalid UUID v4 offer_id", () => {
    const result = validateOffer({ ...validOffer, offer_id: "bad-id" }, baseRfq)
    expect(result.ok).toBe(false)
    expect((result as any).code).toBe("malformed_payload")
  })

  it("rejects non-DID seller", () => {
    const result = validateOffer({ ...validOffer, seller: "not-a-did" }, baseRfq)
    expect(result.ok).toBe(false)
    expect((result as any).code).toBe("malformed_payload")
  })

  it("rejects signature without ed25519: prefix", () => {
    const result = validateOffer({ ...validOffer, signature: "badsig" }, baseRfq)
    expect(result.ok).toBe(false)
    expect((result as any).code).toBe("malformed_payload")
  })
})

// --- Counter validation ---

describe("validateCounter", () => {
  const validCounter = {
    counter_id: "770e8400-e29b-41d4-a716-446655440002",
    rfq_id: baseRfq.rfq_id,
    round: 1,
    from: baseRfq.buyer,
    to: "did:key:z6MksellerDID",
    price: "36.00",
    currency: "USDC",
    valid_until: new Date(Date.now() + 30_000).toISOString(),
    signature: "ed25519:dGVzdA==",
  }

  it("accepts valid counter (no ZK)", () => {
    expect(validateCounter(validCounter, baseRfq).ok).toBe(true)
  })

  it("rejects counter with proof when RFQ has no commitment", () => {
    const result = validateCounter({
      ...validCounter,
      budget_proof: { protocol: "groth16", curve: "bn128", counter_price_scaled: "36000000", pi_a: [], pi_b: [], pi_c: [] },
    }, baseRfq)
    expect(result.ok).toBe(false)
    expect((result as any).code).toBe("unexpected_budget_proof")
  })

  it("rejects counter without proof when RFQ has commitment", () => {
    const rfqWithCommitment = { ...baseRfq, budget_commitment: "poseidon:" + "a".repeat(64) }
    const result = validateCounter(validCounter, rfqWithCommitment)
    expect(result.ok).toBe(false)
    expect((result as any).code).toBe("missing_budget_proof")
  })

  it("accepts counter with valid proof when RFQ has commitment", () => {
    const rfqWithCommitment = { ...baseRfq, budget_commitment: "poseidon:" + "a".repeat(64) }
    const result = validateCounter({
      ...validCounter,
      budget_proof: { protocol: "groth16", curve: "bn128", counter_price_scaled: "36000000", pi_a: [], pi_b: [], pi_c: [] },
    }, rfqWithCommitment)
    expect(result.ok).toBe(true)
  })

  it("rejects counter with wrong proof protocol", () => {
    const rfqWithCommitment = { ...baseRfq, budget_commitment: "poseidon:" + "a".repeat(64) }
    const result = validateCounter({
      ...validCounter,
      budget_proof: { protocol: "plonk", curve: "bn128", counter_price_scaled: "36000000", pi_a: [], pi_b: [], pi_c: [] },
    }, rfqWithCommitment)
    expect(result.ok).toBe(false)
    expect((result as any).code).toBe("invalid_budget_proof")
  })

  it("rejects currency mismatch", () => {
    const result = validateCounter({ ...validCounter, currency: "SOL" }, baseRfq)
    expect(result.ok).toBe(false)
    expect((result as any).code).toBe("currency_mismatch")
  })

  it("rejects expired counter", () => {
    const result = validateCounter({ ...validCounter, valid_until: "2020-01-01T00:00:00Z" }, baseRfq)
    expect(result.ok).toBe(false)
    expect((result as any).code).toBe("invalid_expiry")
  })

  it("rejects missing required fields", () => {
    const { counter_id, ...missing } = validCounter
    const result = validateCounter(missing as any, baseRfq)
    expect(result.ok).toBe(false)
    expect((result as any).code).toBe("malformed_payload")
  })

  it("rejects non-positive price", () => {
    const result = validateCounter({ ...validCounter, price: "0" }, baseRfq)
    expect(result.ok).toBe(false)
    expect((result as any).code).toBe("invalid_amount")
  })

  it("rejects wrong proof curve", () => {
    const rfqWithCommitment = { ...baseRfq, budget_commitment: "poseidon:" + "a".repeat(64) }
    const result = validateCounter({
      ...validCounter,
      budget_proof: { protocol: "groth16", curve: "bls12-381", counter_price_scaled: "36000000", pi_a: [], pi_b: [], pi_c: [] },
    }, rfqWithCommitment)
    expect(result.ok).toBe(false)
    expect((result as any).code).toBe("invalid_budget_proof")
  })

  it("rejects rfq_id mismatch", () => {
    const result = validateCounter({ ...validCounter, rfq_id: "770e8400-e29b-41d4-a716-446655440099" }, baseRfq)
    expect(result.ok).toBe(false)
    expect((result as any).code).toBe("rfq_id_mismatch")
  })

  it("rejects invalid UUID v4 counter_id", () => {
    const result = validateCounter({ ...validCounter, counter_id: "bad-id" }, baseRfq)
    expect(result.ok).toBe(false)
    expect((result as any).code).toBe("malformed_payload")
  })

  it("rejects non-integer round", () => {
    const result = validateCounter({ ...validCounter, round: 1.5 }, baseRfq)
    expect(result.ok).toBe(false)
    expect((result as any).code).toBe("invalid_round")
  })

  it("rejects zero round", () => {
    const result = validateCounter({ ...validCounter, round: 0 }, baseRfq)
    expect(result.ok).toBe(false)
    expect((result as any).code).toBe("invalid_round")
  })

  it("rejects negative round", () => {
    const result = validateCounter({ ...validCounter, round: -1 }, baseRfq)
    expect(result.ok).toBe(false)
    expect((result as any).code).toBe("invalid_round")
  })

  it("rejects non-DID from field", () => {
    const result = validateCounter({ ...validCounter, from: "not-a-did" }, baseRfq)
    expect(result.ok).toBe(false)
    expect((result as any).code).toBe("malformed_payload")
  })

  it("rejects non-DID to field", () => {
    const result = validateCounter({ ...validCounter, to: "not-a-did" }, baseRfq)
    expect(result.ok).toBe(false)
    expect((result as any).code).toBe("malformed_payload")
  })

  it("rejects signature without ed25519: prefix", () => {
    const result = validateCounter({ ...validCounter, signature: "badsig" }, baseRfq)
    expect(result.ok).toBe(false)
    expect((result as any).code).toBe("malformed_payload")
  })
})
