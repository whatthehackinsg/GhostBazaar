# Duty 1: Protocol Core + Strategy + ZK (P1 — ZK Researcher)

## Mission

Deliver the canonical Ghost Bazaar protocol core, autonomous strategy SDK, and ZK budget proof system. Every other duty depends on Duty 1's schemas, validators, and ZK library.

**Owner:** P1 (ZK researcher)
**Packages:** `packages/core`, `packages/strategy`, `packages/zk`
**Spec baseline:** GHOST-BAZAAR-SPEC-v4.md (Sections 3-6, 10-11)

---

## Product Scope

In scope:

- Canonical object definitions aligned to GHOST BAZAAR-SPEC-v4
- Ed25519 signing/verification, DID derivation (`did:key:z6Mk...`)
- Canonical JSON serialization (keys sorted, no spaces, prices as decimal strings)
- `normalizeAmount(amount, mint_address) → bigint` — single canonical function for all price-to-integer conversions
- `computeSpecHash(spec) → "sha256:<hex>"`
- Shared error code catalog for malformed/invalid protocol artifacts
- Strategy interfaces (`BuyerStrategy`, `SellerStrategy`)
- Private state types (`BuyerPrivate`, `SellerPrivate`)
- Privacy sanitizer (non-bypassable, always runs after strategy)
- Rule-based strategies: LinearConcession, TimeWeighted, Competitive buyers; Firm, Flexible, Competitive sellers
- LLM-powered strategies (Claude API): `LLMBuyerStrategy`, `LLMSellerStrategy`
- ZK budget proof: Poseidon commitment, Groth16 proof generation/verification
- circom circuit (`BudgetRangeProof.circom`), trusted setup, snarkjs integration
- Test vectors and conformance tests

Out of scope:

- Negotiation engine HTTP routes (Duty 2)
- Settlement execution and Solana payment verification (Duty 3)
- Agent runtime orchestration and MCP server (Duty 3)

---

## Canonical Objects

### RFQ

Required fields:

- `rfq_id` (UUID v4)
- `protocol` (`"ghost-bazaar-v4"` — receivers MUST reject unknown versions)
- `buyer` (DID — `did:key:z6Mk...`)
- `service_type` (string, e.g., `"ghost-bazaar:services:smart-contract-audit"`)
- `spec` (JSON object)
- `anchor_price` (decimal string)
- `currency` (token symbol, e.g., `"USDC"`)
- `deadline` (ISO 8601 UTC)
- `signature` (`"ed25519:<base64>"`)

Optional fields:

- `budget_commitment` (`"poseidon:<64-hex-chars>"`) — required if buyer intends to send counters with ZK proofs
- `extensions` (object — omit entirely if empty, do NOT send `{}`)

Rules:

- `anchor_price > 0`
- `deadline` must be future at creation
- `signature` verifies against `buyer`
- If `budget_commitment` present, format MUST be `poseidon:<64-hex-chars>`

### Seller Offer

Required fields:

- `offer_id` (UUID v4)
- `rfq_id` (UUID v4)
- `seller` (DID)
- `price` (decimal string)
- `currency` (must match RFQ currency)
- `valid_until` (ISO 8601 UTC)
- `signature` (`"ed25519:<base64>"`)

Rules:

- `price > 0`
- `valid_until` must be future at creation
- `currency` MUST match RFQ's `currency`
- `signature` verifies against `seller`

### Counter-Offer

Required fields:

- `counter_id` (UUID v4)
- `rfq_id` (UUID v4)
- `round` (integer, monotonically increasing per RFQ)
- `from` (DID — must be `rfq.buyer`)
- `to` (DID — target seller)
- `price` (decimal string)
- `currency` (must match RFQ currency)
- `valid_until` (ISO 8601 UTC)
- `signature` (`"ed25519:<base64>"`)

Optional fields:

- `budget_proof` — required if RFQ has `budget_commitment`

### Signed Quote

Required fields:

- `quote_id` (UUID v4)
- `rfq_id` (UUID v4)
- `buyer` (DID)
- `seller` (DID)
- `service_type` (string)
- `final_price` (decimal string)
- `currency` (string)
- `payment_endpoint` (HTTPS URL)
- `expires_at` (ISO 8601 UTC)
- `nonce` (32 random bytes, lowercase hex, `0x` prefix — e.g., `"0x000102...1e1f"`)
- `memo_policy` (`"optional"` | `"quote_id_required"` | `"hash_required"` — default: `"quote_id_required"`)
- `buyer_signature` (`"ed25519:<base64>"`)
- `seller_signature` (`"ed25519:<base64>"`)

Rules:

- `final_price > 0`
- `expires_at` must be future at creation
- buyer and seller signatures verify over identical canonical JSON bytes
- `memo_policy` defaults to `"quote_id_required"` (breaking change from earlier specs where default was `"optional"`)

---

## Signing Profile

Canonical payload policy:

- All signing uses Ed25519 with Solana wallet keypairs
- Canonical JSON: keys sorted recursively, no whitespace, prices as decimal strings
- **RFQ/Offer/Counter:** set `signature: ""` before computing canonical bytes, then sign
- **Signed Quote:** set both `buyer_signature: ""` and `seller_signature: ""` before computing canonical bytes, then sign (both parties sign identical bytes)
- `canonicalJson(obj) → Uint8Array`
- `signEd25519(bytes, keypair) → "ed25519:<base64>"`
- `verifyEd25519(bytes, sig, pubkey) → boolean`
- `buildDid(solanaPublicKey) → "did:key:z6Mk..."` (multicodec `0xed01` + pubkey bytes, base58btc)

---

## Strategy SDK

### Interfaces

```typescript
interface BuyerStrategy {
  openingAnchor(intent: ServiceIntent, priv: BuyerPrivate): Decimal
  onOffersReceived(ctx: BuyerStrategyContext): BuyerAction | Promise<BuyerAction>
}

interface SellerStrategy {
  onRfqReceived(ctx: SellerStrategyContext): SellerAction | Promise<SellerAction>
  onCounterReceived(ctx: SellerStrategyContext): SellerAction | Promise<SellerAction>
}
```

### Privacy Sanitizer

Non-bypassable, runs after every strategy call:

- Buyer: `action.price` MUST NOT exceed `budget_hard`
- Seller: `action.price` MUST NOT go below `floor_price`
- ZK proof generation happens AFTER sanitization, in Agent Runtime

### Rule-Based Strategies

- `LinearConcessionBuyer` — moves anchor → budget_soft linearly
- `TimeWeightedBuyer` — urgency-aware, accelerates near deadline
- `CompetitiveBuyer` — exploits multi-seller competition
- `FirmSeller` — rarely discounts, holds near target
- `FlexibleSeller` — responds to pressure, concedes fast
- `CompetitiveSeller` — concedes faster when competing_sellers ≥ 2

### LLM Strategies

- Private state injected as system prompt constraints, never as structured JSON fields
- Sanitizer caps output; ZK proof enforces cryptographically

---

## ZK Budget Range Proof

### Commitment

```
budget_commitment = Poseidon([budget_hard_scaled, commitment_salt])
                  encoded as "poseidon:<64-hex-chars>"
```

- Salt: random 254-bit field element, generated once per BuyerAgent session
- `budget_hard_scaled = normalizeAmount(budget_hard, usdc_mint)`

### Circuit: BudgetRangeProof.circom

- Public inputs: `counter_price_scaled`, `budget_commitment`
- Private inputs: `budget_hard_scaled`, `commitment_salt`
- Constraint 1: commitment integrity (Poseidon hash check)
- Constraint 2: range check (`counter_price_scaled ≤ budget_hard_scaled`, 64-bit)
- ~300 R1CS constraints

### Proof Format

`budget_proof` on CounterOffer:

- `protocol`: `"groth16"`
- `curve`: `"bn128"`
- `counter_price_scaled`: decimal string matching `normalizeAmount(counter.price, usdc_mint).toString()`
- `pi_a`, `pi_b`, `pi_c`: Groth16 proof elements as decimal strings

### Public Interface

```typescript
generateBudgetCommitment(budget_hard: string, salt: bigint): string
generateBudgetProof(counter_price: string, budget_hard: string, salt: bigint): Promise<BudgetProof>
verifyBudgetProof(proof: BudgetProof, counter_price_scaled: bigint, commitment: string): Promise<boolean>
```

---

## Public Interface Contract

Duty 1 exports these pure APIs:

- `validateRfq(rfq) → {ok, code}`
- `validateOffer(offer, rfq) → {ok, code}`
- `validateCounter(counter, rfq) → {ok, code}`
- `buildUnsignedQuote(input) → quote`
- `signQuoteAsBuyer(quote, keypair) → quote`
- `signQuoteAsSeller(quote, keypair) → quote`
- `verifyQuote(quote) → {ok, code}`
- `normalizeAmount(amount, mint_address) → bigint`
- `computeSpecHash(spec) → hex_string`
- `generateBudgetCommitment(budget_hard, salt) → string`
- `generateBudgetProof(counter_price, budget_hard, salt) → proof`
- `verifyBudgetProof(proof, counter_price_scaled, commitment) → boolean`

Error codes (Duty 1 defines — Duty 2 engine surfaces these via HTTP):

- `malformed_payload` — missing/invalid required fields, bad UUID, bad DID, bad signature prefix
- `malformed_quote` — quote has unparseable DID (cannot extract public key)
- `rfq_id_mismatch` — offer or counter `rfq_id` does not match the RFQ
- `invalid_round` — counter `round` is not a positive integer (Duty 2 also checks monotonically increasing)
- `expired_quote` — `expires_at` is in the past or unparseable
- `invalid_signature` — generic signature verification failure (RFQ/Offer/Counter validators; Duty 2 maps to specific `invalid_buyer_signature` / `invalid_seller_signature` at the HTTP layer)
- `invalid_buyer_signature` — buyer signature on quote fails verification
- `invalid_seller_signature` — seller signature on quote fails verification
- `currency_mismatch` — offer/counter currency does not match RFQ currency
- `invalid_deadline` — RFQ `deadline` is in the past or unparseable
- `invalid_expiry` — offer/counter `valid_until` is in the past or unparseable
- `invalid_nonce_format` — quote nonce is not `0x` + 64 lowercase hex chars
- `invalid_amount` — price/amount is not a positive decimal
- `invalid_budget_commitment_format` — `budget_commitment` does not match `poseidon:<64-hex>`
- `invalid_budget_proof` — ZK proof structure invalid or verification failed
- `missing_budget_proof` — counter lacks `budget_proof` but RFQ has `budget_commitment`
- `proof_price_mismatch` — `budget_proof.counter_price_scaled` does not match normalized price
- `unexpected_budget_proof` — counter has `budget_proof` but RFQ has no `budget_commitment`

---

## Non-Functional Requirements

- Deterministic outputs for identical inputs
- No floating-point comparison for money
- Strategy module importable as standalone package (no engine or settlement dependency)
- 100% reproducible test vectors in CI
- ZK proof generation < 300ms target

---

## Acceptance Criteria

1. RFQ, Offer, Counter, Quote validators pass all positive vectors and fail all negative vectors.
2. Same payload produces same canonical bytes across environments.
3. Quote verification fails on any field mutation after signatures are applied.
4. Amount normalization is deterministic and safe for token decimals.
5. Privacy sanitizer clamps out-of-range prices on every call.
6. `generateBudgetCommitment` → `verifyBudgetProof` round-trip succeeds.
7. Proof with wrong `counter_price_scaled` → verification fails.

---

## Duty 1 Test Checklist

Protocol Core:

- RFQ signature pass/fail vectors (canonical JSON round-trip)
- Offer signature pass/fail
- Quote dual-signature pass/fail
- Counter-offer signature pass/fail
- Tamper-evidence (single-field mutation)
- `spec_hash` computation determinism
- `normalizeAmount` edge cases: `"0.1"`, `"28.50"`, `"1000000.00"`, high decimal precision
- Nonce format: lowercase hex pass, uppercase hex fail, missing `0x` fail
- Expired quote rejection
- Empty `extensions` (`{}`) omitted from canonical JSON
- Extension fields included in canonical JSON and covered by signature

Strategy:

- Buyer sanitizer: counter price exceeds `budget_hard` → clamped
- Buyer sanitizer: counter price at exactly `budget_hard` → passes unchanged
- Seller sanitizer: respond price below `floor_price` → clamped
- Seller sanitizer: respond price at exactly `floor_price` → passes unchanged
- Strategy context contains no private fields from other party

ZK:

- `generateBudgetCommitment` → `verifyBudgetProof` round-trip
- Proof with wrong `counter_price_scaled` → verification fails
- Proof at exactly `budget_hard` ceiling → passes
- Proof above `budget_hard` ceiling → fails

---

## Timeline (from Design Spec)

| Day | Tasks |
|-----|-------|
| 1-2 | core: schemas (with `budget_commitment` + `budget_proof` fields), canonical JSON, Ed25519 sign/verify, DID derivation |
| 3 | core: amounts normalization, verifyQuote; zk: circuit skeleton, scalePrice/unscalePrice |
| 4 | zk: BudgetRangeProof.circom complete, trusted setup (ptau + zkey + vkey export) |
| 5 | zk: prover.ts + verifier.ts wired to snarkjs; strategy: interfaces, sanitizer, all rule-based strategies |
| 6 | strategy: LLMBuyerStrategy, LLMSellerStrategy; zk: performance test (<300ms) |
| 7 | LLM strategy privacy audit; zk: edge cases (price at ceiling, zero price) |
| 8 | **Integration day** — all layers connected |
| 9 | Fix integration issues; zk: CI test for proof round-trip |

**Critical path:** P1 MUST export a working (even stubbed) `verifyBudgetProof` by end of day 3 so Duty 2 can integrate ZK verification in `/counter` route.
