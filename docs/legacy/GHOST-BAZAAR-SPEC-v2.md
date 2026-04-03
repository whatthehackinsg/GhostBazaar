# Ghost Bazaar Protocol
### Draft v2: Negotiation-First Marketplace Profile (Off-Chain Negotiation + x402 Settlement)

**Status:** Draft v2 (Tentative rough flow, not finalized)  
**Date:** March 6, 2026  
**Supersedes:** `GHOST-BAZAAR-SPEC-v0.1.md` (draft baseline)

---

## Abstract

Ghost Bazaar v2 specifies a negotiation layer for agent-to-agent commerce where price is discovered before payment.
It preserves the Ghost Bazaar 4-phase model:

1. Discovery
2. Negotiation
3. Commitment
4. Settlement

Settlement remains on x402. Negotiation remains off-chain and time-bounded.
The protocol enables multi-seller competition, buyer budget privacy, and dual-signed quote commitment (`Signed Quote`) before payment execution.

---

## 1. What Is New In v2

Compared to v0.1, this draft v2 adds:

- Explicit marketplace profile for real-world domains:
  - C2C marketplace (Carousell-style)
  - Merchant marketplace (Amazon-style)
  - Services marketplace (Upwork-style)
- Explicit implementation split into 3 isolated duties:
  - Duty 1: Protocol Core
  - Duty 2: Negotiation Engine
  - Duty 3: Settlement + Agent Interface
- Normative state machine for negotiation lifecycle
- Normative settlement validation order and error codes
- Conformance-oriented API profile for MVP delivery

---

## 2. Scope And Non-Goals

### In Scope

- RFQ-based multi-seller negotiation
- Structured offer/counter-offer flow
- Dual-signature quote commitment
- x402 settlement compatibility via HTTP headers
- Replay and expiry protection

### Out Of Scope (v2 Draft)

- Delivery quality arbitration
- Escrow/dispute resolution
- On-chain negotiation logic
- Reputation/staking economics
- Multi-unit batch negotiation mechanisms

---

## 3. Roles

### Buyer Agent

- Maintains private `budget_hard` and `budget_soft`
- Broadcasts RFQ with `anchor_price` and `deadline`
- Runs seller selection and counter-offer strategy
- Co-signs final quote and initiates payment call

### Seller Agent

- Receives RFQ and returns signed offers
- Revises offers during negotiation rounds
- Co-signs final quote when acceptable
- Validates quote + x402 payment before execution

### Negotiation Runtime

- Holds session and event state
- Enforces deadline and transition rules
- Coordinates quote generation and signing handoff

---

## 4. Protocol Overview

```text
Phase 1: Discovery       Phase 2: Negotiation      Phase 3: Commitment       Phase 4: Settlement
Buyer broadcasts RFQ  -> Sellers return offers  -> Signed Quote co-signed -> x402 payment call
                         Buyer counter-offers      Price/terms locked        Seller verifies and executes
```

Normative requirements:

- Negotiation MUST stop at RFQ `deadline`.
- Settlement MUST fail if quote `expires_at` has elapsed.
- Seller MUST reject replayed `nonce`.
- `final_price` MUST match amount in x402 payment payload.

---

## 5. Canonical Objects

### 5.1 Listing Intent (Marketplace Extension)

This object is optional and marketplace-facing. It enables discoverability before RFQ.

```json
{
  "listing_id": "uuid-v4",
  "seller": "did:agent:seller_pubkey",
  "category": "services",
  "title": "Agent code review",
  "base_terms": {
    "currency": "USDC",
    "sla_hours": 24
  },
  "negotiation_endpoint": "https://seller.example.com/negotiate",
  "payment_endpoint": "https://seller.example.com/execute"
}
```

### 5.2 Request For Quote (RFQ)

```json
{
  "rfq_id": "uuid-v4",
  "buyer": "did:agent:buyer_pubkey",
  "service": "code-review",
  "spec": {
    "repo": "org/repo",
    "scope": "security-and-performance"
  },
  "anchor_price": "25.00",
  "currency": "USDC",
  "deadline": "2026-03-06T12:00:30Z",
  "signature": "ed25519:..."
}
```

RFQ rules:

- `anchor_price` MUST be > 0.
- `deadline` MUST be future at creation.
- Buyer MUST sign canonical RFQ payload.
- `budget_hard` MUST NOT appear in any RFQ field.

### 5.3 Seller Offer

```json
{
  "offer_id": "uuid-v4",
  "rfq_id": "uuid-v4",
  "seller": "did:agent:seller_a_pubkey",
  "price": "32.00",
  "currency": "USDC",
  "valid_until": "2026-03-06T12:00:20Z",
  "signature": "ed25519:..."
}
```

Offer rules:

- `price` MUST be > 0.
- `currency` MUST match RFQ currency.
- `valid_until` MUST be future at creation.
- Seller MUST sign canonical offer payload.

### 5.4 Signed Quote (Commitment Object)

```json
{
  "quote_id": "uuid-v4",
  "rfq_id": "uuid-v4",
  "buyer": "did:agent:buyer_pubkey",
  "seller": "did:agent:seller_a_pubkey",
  "service": "code-review",
  "final_price": "28.50",
  "currency": "USDC",
  "payment_endpoint": "https://seller.example.com/execute",
  "expires_at": "2026-03-06T12:01:00Z",
  "nonce": "0x000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
  "buyer_signature": "ed25519:...",
  "seller_signature": "ed25519:..."
}
```

Quote rules:

- `final_price` MUST be > 0.
- `expires_at` MUST be future at creation.
- `nonce` SHOULD be 32 random bytes (hex with `0x` prefix).
- Buyer and seller MUST sign identical canonical quote payload bytes.

---

## 6. Signing And Canonicalization Profile

Default profile:

- RFQ payload to sign: RFQ with `signature=""`
- Offer payload to sign: Offer with `signature=""`
- Quote payload to sign: Quote with `buyer_signature=""` and `seller_signature=""`

Rules:

- Canonical JSON serialization MUST be deterministic.
- Money fields SHOULD be decimal strings in transport.
- Implementations MUST NOT compare prices using floating point.
- A quote MUST use one signature scheme pair (`ed25519` or `eip712`) for both signatures in MVP.

---

## 7. Negotiation State Machine

States:

- `OPEN`
- `NEGOTIATING`
- `COMMIT_PENDING`
- `COMMITTED`
- `EXPIRED`
- `CANCELLED`

Allowed transitions:

- `OPEN -> NEGOTIATING`
- `NEGOTIATING -> COMMIT_PENDING`
- `COMMIT_PENDING -> COMMITTED`
- `OPEN|NEGOTIATING|COMMIT_PENDING -> EXPIRED`
- `OPEN|NEGOTIATING -> CANCELLED`

Invalid transitions MUST return `409`.

---

## 8. Duty Split (Isolated Ownership)

### Duty 1: Protocol Core

Owns:

- Object schemas and validators
- Signature build/verify
- Amount normalization helpers
- Error codes for malformed/invalid artifacts

Provides pure interfaces:

- `validateRfq`
- `validateOffer`
- `verifyQuote`
- `normalizeAmount`

### Duty 2: Negotiation Engine

Owns:

- RFQ/offer routes and session state
- Round progression and winner selection
- Event history append-only log
- Deadline enforcement

Depends on Duty 1 validators.

### Duty 3: Settlement + Agent Interface

Owns:

- `POST /execute`
- x402 payment payload verification
- quote-vs-payment amount check
- nonce consumption durability
- MCP tool interface for agent execution

Depends on Duty 1 quote verification and amount normalization.

---

## 9. HTTP Transport Profile (MVP)

### Discovery + Negotiation Endpoints

- `GET /listings`
- `GET /listings/:id`
- `POST /rfqs`
- `POST /rfqs/:id/offers`
- `POST /rfqs/:id/accept`
- `GET /rfqs/:id/events`

### Settlement Endpoint

- `POST /execute`

Headers required on settlement request:

- `PAYMENT-SIGNATURE`
- `X-Ghost-Bazaar-Quote`

Implementations SHOULD expose machine-readable JSON errors.

---

## 10. Settlement Validation (Normative Order)

On `POST /execute`, seller MUST validate in this order:

1. Parse and decode `X-Ghost-Bazaar-Quote`.
2. Verify buyer signature.
3. Verify seller signature.
4. Parse and verify x402 payment payload from `PAYMENT-SIGNATURE`.
5. Compare quote `final_price` to payment amount after normalization.
6. Check nonce is not consumed.
7. Check quote is not expired.
8. Execute service.
9. Persist nonce consumption atomically.

If any step fails, seller MUST reject execution.

---

## 11. Error Code Registry (MVP)

Protocol and settlement endpoints SHOULD use these stable codes:

- `malformed_payload`
- `malformed_quote`
- `invalid_signature`
- `invalid_buyer_signature`
- `invalid_seller_signature`
- `invalid_payment_signature`
- `currency_mismatch`
- `invalid_deadline`
- `invalid_expiry`
- `invalid_nonce_format`
- `invalid_amount`
- `price_mismatch`
- `nonce_replayed`
- `quote_expired`
- `invalid_state_transition`

---

## 12. Security Properties

| Property | Mechanism |
|---|---|
| Budget privacy | `budget_hard` never appears in RFQ/Offer/Quote |
| Price non-repudiation | Dual signatures on Signed Quote |
| Replay protection | Nonce + consumed nonce store |
| Time-boundedness | RFQ `deadline` + quote `expires_at` |
| Tamper evidence | Any post-signature mutation invalidates signatures |

---

## 13. Failure Modes

### No Deal Before Deadline

- Session transitions to `EXPIRED`
- No quote and no payment occur

### Seller Refuses Co-sign

- Buyer MAY select next-best valid offer
- Session remains `NEGOTIATING` until deadline

### Quote Expires Before Execute

- Settlement MUST reject with `quote_expired`
- Buyer must renegotiate or requote

### Payment Amount Mismatch

- Settlement MUST reject with `price_mismatch`
- Service MUST NOT execute

### Replay Attempt

- Settlement MUST reject with `nonce_replayed`

---

## 14. Conformance Tests (Minimum)

### Duty 1

- RFQ/Offer/Quote signature pass/fail vectors
- Canonicalization determinism test
- Quote tamper test
- Amount normalization tests

### Duty 2

- State transition matrix tests
- Deadline and offer validity enforcement
- Deterministic winner tie-break
- Event replay reconstruction

### Duty 3

- Valid settlement happy path
- Invalid signatures
- Amount mismatch
- Nonce replay
- Expired quote
- Nonce durability across restart simulation

---

## 15. Marketplace Profiles

### C2C Marketplace (Carousell-style)

Negotiated terms can include:

- `price`
- `delivery_mode`
- `shipping_cost`
- `item_condition`

### Merchant Marketplace (Amazon-style)

Negotiated terms can include:

- `unit_price`
- `bulk_discount`
- `shipping_eta`
- `return_window`

### Services Marketplace (Upwork-style)

Negotiated terms can include:

- `price`
- `deadline`
- `revision_limit`
- `deliverable_spec`

Recommended first production/demo profile: Services marketplace.

---

## 16. Migration Notes From v0.1

- Keep existing RFQ/Offer/Quote field names for compatibility.
- Prefer decimal-string prices in new implementations.
- Adopt explicit duty ownership boundaries to reduce integration ambiguity.
- Keep x402 settlement headers unchanged:
  - `PAYMENT-SIGNATURE`
  - `X-Ghost-Bazaar-Quote`

---

## 17. Open Questions (v2 Draft)

- Should counter-offers be standardized as a first-class message type in v2.1?
- Should `spec_hash` be mandatory in Signed Quote for strict parameter binding?
- Should mixed signature schemes be supported in a single quote?
- What nonce backend profile should be standardized (KV vs Redis vs SQL)?
- Should optional escrow/arbitration extension be introduced in a separate profile?

---

*End of Draft v2 (tentative rough flow).*
