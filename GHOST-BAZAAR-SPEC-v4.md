# Ghost Bazaar Protocol
### Specification v4: Solana-Native Agent Negotiation Standard

**Status:** Draft v4
**Date:** March 14, 2026
**Supersedes:** `GHOST-BAZAAR-SPEC-v3.md`, `GHOST-BAZAAR-SPEC-v2.md`, `GHOST-BAZAAR-SPEC-v0.1.md`

The key words MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY in this document are to be interpreted as described in RFC 2119.

---

## Abstract

Ghost Bazaar v4 specifies a negotiation protocol for agent-to-agent commerce on Solana. Agents discover services, negotiate prices autonomously, lock a dual-signed price commitment, and settle via Solana SPL token transfer.

Ghost Bazaar is complementary to x402. x402 is a protocol for HTTP-native payments — agents pay for services by attaching payment proof to HTTP requests, and servers verify payment before responding (see [x402.org](https://x402.org)). Ghost Bazaar adds the negotiation layer that comes *before* x402 payment: price discovery, competitive bidding, and cryptographic commitment. Once negotiation produces a dual-signed quote, settlement uses the x402 pattern (HTTP headers carrying payment proof) to execute the payment. Ghost Bazaar treats x402 as a blackbox settlement boundary — the negotiation protocol does not depend on x402 internals, but the settlement flow is designed to compose with any x402-compatible payment rail.

The protocol follows a four-phase model:

1. **Discovery** — buyer finds sellers via listings
2. **Negotiation** — offers and counter-offers, time-bounded by deadline
3. **Commitment** — dual-signed quote locks price and terms
4. **Settlement** — x402-compatible Solana payment + seller verification + service execution

Design principles:

- **Solana-native.** Ed25519 signing from Solana wallet keypairs. Agent identity is `did:key` derived directly from the wallet pubkey. Settlement verification uses on-chain Solana transaction proofs. Nonce consumption is backed by a Ghost Bazaar Anchor program.
- **x402-compatible settlement.** Settlement uses HTTP headers (`Payment-Signature`, `X-Ghost-Bazaar-Quote`) following the x402 pattern. The negotiated quote is the bridge between Ghost Bazaar negotiation and x402 payment execution.
- **Autonomous strategy.** Agents carry pluggable strategy modules. Strategy consumes protocol state and produces protocol actions. Private inputs (budget ceilings, floor prices) never appear in any wire message.
- **ZK budget proof.** Optional extension. Buyer publishes a Poseidon commitment to `budget_hard` in the RFQ. Every counter-offer carries a Groth16 proof that `counter_price ≤ budget_hard`. The engine and any seller can verify the proof without learning `budget_hard`.
- **Service type registry.** Namespaced service types enable interoperability across independent implementations.

---

## 1. What Is New In v4

Compared to v3:

- **ZK budget proof** promoted from "out of scope" to formally specified optional extension (Section 10).
- **Service type registry** with namespace convention for cross-implementation interoperability (Section 13).
- **Ghost Bazaar Anchor program** account schemas for on-chain deal receipts and nonce consumption (Section 12).
- **Duty split refined** to three duties: Protocol Core + Strategy + ZK, Negotiation Engine, Settlement. Agent runtime and agent interface bindings (MCP, function-calling, etc.) are implementation concerns, not protocol duties (Section 11).
- **`POST /execute` ownership** explicitly clarified: runs on the seller's server, not the negotiation engine (Section 9).
- **Counter-offer authorization** added: engine MUST verify `counter.from` equals `rfq.buyer` (Section 8).
- **Protocol version field** added to RFQ for forward compatibility.
- **Extension mechanism** on protocol objects via namespaced `extensions` map (Section 5.7).

---

## 2. Scope And Non-Goals

### In Scope

- RFQ-based multi-seller negotiation
- Structured offer, counter-offer, and accept flow
- Dual-signature quote commitment (Ed25519, Solana keypair)
- Settlement via Solana SPL token transfer with HTTP header verification
- Autonomous agent strategy interface and privacy boundary
- ZK budget range proof (optional extension)
- Service type namespace and registry
- On-chain deal receipt and nonce consumption via Anchor program
- Strategy style signaling in listing metadata

### Out Of Scope (v4)

- Delivery quality arbitration or escrow
- ~~Reputation or Sybil resistance mechanisms~~ → Now addressed via 8004 Agent Registry integration (see `packages/agents/src/registry.ts`). On-chain ATOM reputation engine provides Sybil-resistant, scored feedback post-settlement.
- On-chain negotiation logic
- Multi-unit or batch negotiation
- Cross-chain settlement
- Seller-side ZK floor price proof (candidate for v5)
- On-chain ZK verifier program (off-chain verification is sufficient)

---

## 3. Roles

### Buyer Agent

- Holds `budget_soft` and `budget_hard` in local private state; these MUST NOT appear in any protocol message
- Broadcasts RFQ with `anchor_price` and `deadline`
- Optionally publishes `budget_commitment` (Poseidon hash of `budget_hard`) in the RFQ
- Runs a strategy to decide counters, acceptance timing, and seller selection
- Co-signs the Signed Quote and initiates the Solana payment transaction

### Seller Agent

- Holds `floor_price` and `target_price` in local private state; these MUST NOT appear in any protocol message
- Reads RFQs and returns signed offers via a strategy
- Revises offers during counter rounds
- Co-signs the Signed Quote when terms are acceptable
- Validates the Signed Quote and Solana payment proof before executing the service
- Runs `POST /execute` on its own server

### Negotiation Runtime (Engine)

- Relays messages, enforces the state machine, persists the event log
- Does NOT select winners on behalf of buyers
- Enforces deadline and state transition rules
- If ZK budget commitment is present in the RFQ, verifies budget proofs on all counters
- Does NOT run settlement — settlement is the seller's responsibility

---

## 4. Protocol Overview

```
Phase 1: Discovery        Phase 2: Negotiation       Phase 3: Commitment        Phase 4: Settlement
─────────────────────     ──────────────────────     ──────────────────────     ──────────────────
Buyer broadcasts RFQ  ->  Sellers return offers  ->  Signed Quote co-signed ->  Solana tx + quote
                          Buyer strategy counters    Price/terms locked         Seller verifies,
                          Seller strategy responds                              executes service
```

Normative requirements:

- Negotiation MUST stop at RFQ `deadline`.
- Settlement MUST fail if quote `expires_at` has elapsed.
- Seller MUST reject a replayed nonce.
- `final_price` MUST match the SPL token transfer amount in the Solana payment transaction after decimal normalization.
- Strategy MUST NOT produce a counter price exceeding `budget_hard` (buyer) or below `floor_price` (seller).
- `budget_hard`, `budget_soft`, `floor_price`, and `target_price` MUST NOT appear in any protocol message.

---

## 5. Canonical Objects

### 5.1 Listing Intent

Published by a seller before any RFQ. Optional but enables pre-negotiation discovery.

```json
{
  "listing_id": "uuid-v4",
  "seller": "did:key:z6Mk<base58btc(0xed01 + pubkey_bytes)>",
  "category": "services",
  "service_type": "ghost-bazaar:services:code-review",
  "title": "Agent code review",
  "base_terms": {
    "currency": "USDC",
    "sla_hours": 24
  },
  "negotiation_endpoint": "https://engine.example.com",
  "payment_endpoint": "https://seller.example.com/execute",
  "negotiation_profile": {
    "style": "flexible",
    "max_rounds": 5,
    "accepts_counter": true
  }
}
```

**`service_type` field rules:**

- Format: `<namespace>:<category>:<type>` (see Section 13)
- SHOULD be included for cross-implementation interoperability
- If absent, agents rely on free-text `title` and `category` for matching

**`negotiation_profile` field rules:**

- `style`: MUST be one of `"firm"`, `"flexible"`, `"competitive"`, `"deadline-sensitive"`:
  - `"firm"` — seller rarely discounts
  - `"flexible"` — seller open to negotiation
  - `"competitive"` — buyer should expect multi-seller competition
  - `"deadline-sensitive"` — agent signals urgency
- `max_rounds`: advisory ceiling on counter rounds; enforcement is at seller discretion
- `accepts_counter`: `true` if the seller will respond to buyer counter-offers; `false` if seller offers are final

`negotiation_profile` is NON-BINDING. It is a hint, not a constraint. The state machine does not enforce round counts based on this field.

**`payment_endpoint`:** The seller's own HTTP endpoint for settlement (`POST /execute`). This is NOT the negotiation engine URL.

### 5.2 Request For Quote (RFQ)

```json
{
  "rfq_id": "uuid-v4",
  "protocol": "ghost-bazaar-v4",
  "buyer": "did:key:z6Mk...",
  "service_type": "ghost-bazaar:services:code-review",
  "spec": {
    "repo": "org/repo",
    "scope": "security-and-performance"
  },
  "anchor_price": "25.00",
  "currency": "USDC",
  "deadline": "2026-03-14T12:00:30Z",
  "budget_commitment": "poseidon:0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b",
  "signature": "ed25519:..."
}
```

Note: `extensions` is omitted from this example because it is empty. Per Section 5.7, empty or absent `extensions` MUST be omitted from canonical JSON.

Rules:

- `protocol` MUST be `"ghost-bazaar-v4"`. Receivers MUST reject unknown protocol versions.
- `anchor_price` MUST be > 0 and SHOULD be set below `budget_soft`
- `deadline` MUST be in the future at creation time
- Buyer MUST sign the canonical RFQ payload (see Section 6)
- `budget_hard` and `budget_soft` MUST NOT appear in any RFQ field
- `budget_commitment` is OPTIONAL. If present, format MUST be `"poseidon:<64-hex-chars>"` (zero-padded). If present, the engine MUST require `budget_proof` on all subsequent counters from this buyer for this RFQ (see Section 10).
- `service_type` SHOULD match a registered type (see Section 13)
- `extensions` is OPTIONAL. If present, MUST be an object with namespaced string keys. Included in canonical JSON for signing.

### 5.3 Seller Offer

```json
{
  "offer_id": "uuid-v4",
  "rfq_id": "uuid-v4",
  "seller": "did:key:z6Mk...",
  "price": "32.00",
  "currency": "USDC",
  "valid_until": "2026-03-14T12:00:20Z",
  "signature": "ed25519:..."
}
```

Rules:

- `price` MUST be > 0
- `currency` MUST match RFQ `currency`
- `valid_until` MUST be in the future at creation time
- Seller MUST sign the canonical offer payload

### 5.4 Counter-Offer

Counter-offers are first-class objects. Only the buyer sends counter-offers (via `POST /rfqs/:id/counter`). When a seller wants to revise their price in response, they submit a new offer via `POST /rfqs/:id/offers` — there is no separate seller-to-buyer counter endpoint.

```json
{
  "counter_id": "uuid-v4",
  "rfq_id": "uuid-v4",
  "round": 2,
  "from": "did:key:z6Mk...",
  "to": "did:key:z6Mk...",
  "price": "28.00",
  "currency": "USDC",
  "valid_until": "2026-03-14T12:00:25Z",
  "budget_proof": { "see": "Section 10.5 for proof format" },
  "signature": "ed25519:..."
}
```

Rules:

- `round` MUST be monotonically increasing per `rfq_id`
- `from` MUST equal the RFQ buyer DID (only the original buyer may counter)
- `to` MUST be a valid seller DID that has submitted an offer for this RFQ
- `price` MUST be > 0
- `currency` MUST match RFQ `currency`
- `valid_until` MUST be in the future at creation time
- Sender MUST sign the canonical counter payload
- `budget_proof` is REQUIRED if the RFQ has a `budget_commitment`. See Section 10 for format.

### 5.5 Signed Quote (Commitment Object)

```json
{
  "quote_id": "uuid-v4",
  "rfq_id": "uuid-v4",
  "buyer": "did:key:z6Mk...",
  "seller": "did:key:z6Mk...",
  "service_type": "ghost-bazaar:services:code-review",
  "spec_hash": "sha256:<hex>",
  "final_price": "28.50",
  "currency": "USDC",
  "payment_endpoint": "https://seller.example.com/execute",
  "expires_at": "2026-03-14T12:01:00Z",
  "nonce": "0x000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
  "memo_policy": "quote_id_required",
  "buyer_signature": "ed25519:...",
  "seller_signature": "ed25519:..."
}
```

Rules:

- `final_price` MUST be > 0
- `expires_at` MUST be in the future at creation time
- `nonce` MUST be 32 random bytes, lowercase hex, `0x` prefix
- Uppercase hex MUST be rejected
- `spec_hash` SHOULD be included: `sha256(canonical_json(rfq.spec))`, binds service parameters to the quote
- Buyer and seller MUST sign identical canonical quote payload bytes (see Section 6)
- `memo_policy`:
  - `"quote_id_required"` — Solana payment transaction MUST include `quote_id` in Memo instruction
  - `"hash_required"` — transaction MUST include `sha256(canonical_quote)` in Memo
  - `"optional"` — Memo is recommended but not enforced at settlement gate
  - Default: `"quote_id_required"`

### 5.6 Quote Construction Flow

**Accept request body** (`POST /rfqs/:id/accept`):

```json
{
  "seller": "did:key:z6Mk...",
  "offer_id": "uuid-v4"
}
```

**Buyer sign request body** (`PUT /rfqs/:id/quote/sign`):

```json
{
  "buyer_signature": "ed25519:..."
}
```

**Seller cosign request body** (`PUT /rfqs/:id/cosign`):

```json
{
  "seller_signature": "ed25519:..."
}
```

**Quote retrieval** (`GET /rfqs/:id/quote`): returns the current quote object. Returns `404` if no quote exists (state is `OPEN` or `NEGOTIATING` without a pending accept). The response includes whatever signatures are present: none (unsigned), `buyer_signature` only (partially-signed), or both (fully-signed).

**Flow:**

When `POST /rfqs/:id/accept` is called by the buyer:

1. Engine validates state is `NEGOTIATING` → `409 invalid_state_transition` if not
2. Verify request sender is `rfq.buyer` → `401 invalid_buyer_signature` if not (accept MUST be authenticated)
3. Verify `seller` DID has submitted at least one offer for this RFQ → `404` if not
4. Verify the referenced offer (`offer_id`) exists and `valid_until` is still in the future → `422 invalid_expiry` if expired
5. Engine transitions state to `COMMIT_PENDING`
6. Engine calls `buildUnsignedQuote(rfq, accepted_offer, buyer_did, seller_did)` (Duty 1)
7. Engine returns the unsigned quote to the buyer in the response body

Buyer signs locally → `buyer_signature`

When `PUT /rfqs/:id/quote/sign` is called by the buyer:

8. Engine validates state is `COMMIT_PENDING` → `409 invalid_state_transition` if not
9. Engine validates the buyer Ed25519 signature against the unsigned quote's canonical JSON → `401 invalid_buyer_signature` if invalid
10. Engine stores the partially-signed quote

When `PUT /rfqs/:id/cosign` is called by the seller:

11. Seller retrieves the partially-signed quote via `GET /rfqs/:id/quote`
12. Seller verifies the quote fields and buyer signature locally
13. Seller signs → `seller_signature`
14. Seller sends the `seller_signature` to the engine via `PUT /rfqs/:id/cosign`
15. Engine validates state is `COMMIT_PENDING` → `409 invalid_state_transition` if not
16. Engine validates the seller Ed25519 signature against the quote's canonical JSON → `401 invalid_seller_signature` if invalid
17. Engine transitions state to `COMMITTED`
18. Both parties can retrieve the fully-signed quote via `GET /rfqs/:id/quote`

If the seller declines to co-sign, the engine transitions back to `NEGOTIATING`.

### 5.7 Extension Mechanism

Every protocol object (RFQ, Offer, Counter, Quote) MAY include an `extensions` field:

```json
{
  "extensions": {
    "mycompany:audit:report-format": "pdf",
    "mycompany:custom:priority": "high"
  }
}
```

Rules:

- Keys MUST be namespaced strings in `<namespace>:<category>:<name>` format
- The `ghost-bazaar:` namespace is reserved for standard extensions
- Values may be any JSON-serializable type
- `extensions` MUST be included in canonical JSON serialization (sorted keys)
- `extensions` MUST be covered by the object's signature
- Implementations MUST preserve unknown extensions during relay (engine MUST NOT strip extensions it does not understand)
- Implementations MAY ignore unknown extensions for processing
- If `extensions` is absent or an empty object `{}`, it MUST be omitted from canonical JSON (not included as `"extensions":{}`). This ensures absent and empty produce the same signing bytes.

The `budget_commitment` and `budget_proof` fields defined in Sections 5.2 and 5.4 are top-level fields for the ZK extension, not placed inside `extensions`, because they affect engine validation behavior. The `extensions` map is for metadata that does not alter core protocol validation.

---

## 6. Signing And Canonicalization Profile

**Profile ID:** `ghost-bazaar-solana-ed25519-v4`

This profile is normative. Implementations that diverge from this serialization WILL fail interop.

### Canonical JSON Rules

- Object key ordering: recursively sort by Unicode codepoint order (lexicographic)
- Whitespace: none outside strings; separators are `,` and `:` (no spaces)
- Number encoding: price/amount fields MUST be decimal strings (e.g., `"28.50"`), not JSON numbers
- String encoding: UTF-8
- Null fields: omit entirely; do not include with null values
- `extensions`: included in canonical form; keys sorted like any other object

### Signing Input Construction

| Object | Signing input |
|---|---|
| RFQ | Canonical JSON with `"signature":""` |
| Seller Offer | Canonical JSON with `"signature":""` |
| Counter-Offer | Canonical JSON with `"signature":""` |
| Signed Quote | Canonical JSON with `"buyer_signature":""` and `"seller_signature":""` |

Both parties sign identical bytes. The signature field(s) are present in the payload, set to empty string `""`, not omitted.

### Signature Encoding

```
ed25519:<base64(raw_64_byte_signature)>
```

Where base64 is RFC 4648 Section 4 (standard alphabet, with `=` padding). No URL-safe variant.

### DID Derivation (Solana Wallet → did:key)

```
did:key:z<base58btc(0xed01 + raw_32_byte_pubkey)>
```

- `0xed01` = two raw bytes (unsigned-varint multicodec for Ed25519)
- `raw_32_byte_pubkey` = the Solana wallet's 32-byte Ed25519 public key
- `base58btc` = Bitcoin's base58 alphabet (same as Solana's base58 pubkey encoding)

A Solana wallet's base58 pubkey and its `did:key` representation encode the same 32 bytes. No separate key management is required.

### Nonce Format

- 32 random bytes
- Lowercase hex, `0x` prefix
- Example: `0x000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f`
- Uppercase hex MUST be rejected

---

## 7. Negotiation State Machine

States:

- `OPEN` — RFQ accepted, waiting for offers
- `NEGOTIATING` — offers and counter-offers in progress
- `COMMIT_PENDING` — buyer selected winner, awaiting seller co-sign
- `COMMITTED` — Signed Quote completed by both parties
- `EXPIRED` — deadline elapsed without committed quote
- `CANCELLED` — explicit cancellation by buyer

Allowed transitions:

```
OPEN              -> NEGOTIATING
NEGOTIATING       -> COMMIT_PENDING
COMMIT_PENDING    -> COMMITTED
COMMIT_PENDING    -> NEGOTIATING      (seller declines co-sign; buyer may re-select)
OPEN | NEGOTIATING | COMMIT_PENDING -> EXPIRED
OPEN | NEGOTIATING -> CANCELLED
```

Invalid transitions MUST return `409 Conflict` with error code `invalid_state_transition`.

Cancellation (`OPEN | NEGOTIATING -> CANCELLED`) is triggered by buyer strategy action routed through the engine internally (e.g., strategy produces `{ type: "cancel" }`). No public HTTP cancel endpoint is defined — cancellation is an engine-internal operation. Once in `COMMIT_PENDING`, cancellation is not allowed; the only exits are seller co-sign (`COMMITTED`), seller decline (return to `NEGOTIATING`), or deadline (`EXPIRED`).

The runtime does NOT select the winning seller. Buyer drives the `NEGOTIATING -> COMMIT_PENDING` transition by calling `POST /rfqs/:id/accept` with an explicit `seller` DID. If the selected seller declines to co-sign, session returns to `NEGOTIATING` and buyer may select a different seller.

---

## 8. HTTP Transport Profile

### Discovery and Negotiation Endpoints (Engine)

These routes run on the negotiation engine server:

- `GET /listings` — list available seller listings
- `GET /listings/:id` — get listing with `negotiation_profile`
- `POST /rfqs` — broadcast RFQ
- `POST /rfqs/:id/offers` — seller submits offer
- `POST /rfqs/:id/counter` — buyer sends counter to a specific seller
- `POST /rfqs/:id/accept` — buyer selects winner, receives unsigned quote
- `PUT /rfqs/:id/quote/sign` — buyer submits `buyer_signature` for the quote
- `PUT /rfqs/:id/cosign` — seller co-signs the quote
- `GET /rfqs/:id/quote` — retrieve current quote (unsigned, partially-signed, or fully-signed depending on state)
- `GET /rfqs/:id/events` — append-only event stream

### Settlement Endpoint (Seller)

This route runs on the **seller's own server**, NOT on the negotiation engine:

- `POST /execute` — seller validates payment and executes service

The seller's `payment_endpoint` is declared in the Listing Intent and carried into the Signed Quote.

### Request/Response Format

All endpoints MUST accept and return `application/json`.

All error responses MUST return a JSON body:

```json
{
  "error": "<error_code>",
  "message": "<human-readable description>"
}
```

### Settlement Request Headers

Required headers on `POST /execute`:

- `Payment-Signature` — base58-encoded Solana transaction signature
- `X-Ghost-Bazaar-Quote` — base64-encoded canonical JSON of the Signed Quote

### RFQ Submission Verification

When `POST /rfqs` is received, the engine MUST validate in this order:

1. Parse and validate RFQ schema → `400 malformed_payload` if invalid
2. Verify `rfq.protocol` equals `"ghost-bazaar-v4"` → `400 malformed_payload` if unknown version
3. Verify `rfq.anchor_price` is a valid positive decimal string → `422 invalid_amount` if not
4. Verify `rfq.deadline` is in the future → `422 invalid_deadline` if not
5. If `rfq.budget_commitment` is present, verify format is `"poseidon:<64-hex-chars>"` → `422 invalid_budget_commitment_format` if not
6. Verify `rfq.currency` is a supported currency → `422 currency_mismatch` if not
7. Validate buyer Ed25519 signature → `401 invalid_buyer_signature` if invalid
8. Create session in `OPEN` state, append event to log
9. Return `201`

### Offer Submission Verification

When `POST /rfqs/:id/offers` is received, the engine MUST validate in this order:

1. Parse and validate Offer schema → `400 malformed_payload` if invalid
2. Retrieve RFQ for `rfq_id` → `404` if not found
3. Verify `offer.price` is a valid positive decimal string → `422 invalid_amount` if not
4. Verify `offer.currency` matches `rfq.currency` → `422 currency_mismatch` if not
5. Verify `offer.valid_until` is in the future → `422 invalid_expiry` if not
6. Validate seller Ed25519 signature → `401 invalid_seller_signature` if invalid
7. Check state machine allows offer (state is `OPEN` or `NEGOTIATING`) → `409 invalid_state_transition` if not
8. If state is `OPEN`, transition to `NEGOTIATING`
9. Append event to log
10. Return `201`

### Counter-Offer Verification

When `POST /rfqs/:id/counter` is received, the engine MUST validate in this order:

1. Parse and validate CounterOffer schema → `400 malformed_payload` if invalid
2. Retrieve RFQ for `rfq_id` → `404` if not found
3. Verify `counter.price` is a valid positive decimal string → `422 invalid_amount` if not
4. Verify `counter.currency` matches `rfq.currency` → `422 currency_mismatch` if not
5. Verify `counter.valid_until` is in the future → `422 invalid_expiry` if not
6. Verify `counter.from` equals `rfq.buyer` (only the original RFQ buyer may counter) → `422 unauthorized_counter` if mismatch
7. If `rfq.budget_commitment` is present:
   a. Check `counter.budget_proof` is present → `422 missing_budget_proof` if absent
   b. Compute `expected_scaled = normalizeAmount(counter.price, mint_for(rfq.currency))` — resolve `rfq.currency` (e.g., `"USDC"`) to a mint address via the SPL Token Mint Table (Section 9), then normalize
   c. Check `counter.budget_proof.counter_price_scaled` equals `expected_scaled` → `422 proof_price_mismatch` if not equal
   d. Verify proof → `422 invalid_budget_proof` if verification fails
   If `rfq.budget_commitment` is absent and `counter.budget_proof` is present → `422 unexpected_budget_proof`
8. Validate buyer Ed25519 signature on CounterOffer → `401 invalid_buyer_signature` if invalid
9. Check state machine allows counter (state is `NEGOTIATING`) → `409 invalid_state_transition` if not
10. Validate `counter.round` is monotonically increasing per `rfq_id` → `422 invalid_round` if not
11. Append event to log
12. Return `201`

---

## 9. Settlement Validation (Normative Order)

Settlement follows the x402 pattern: the buyer's HTTP request carries payment proof in headers, and the seller validates before executing the service. Ghost Bazaar extends x402 by adding the `X-Ghost-Bazaar-Quote` header, which binds the payment to the negotiated terms. The seller verifies both the x402 payment and the Ghost Bazaar quote in a single validation pass.

On `POST /execute`, the seller MUST validate in this exact order:

1. Parse and base64-decode `X-Ghost-Bazaar-Quote` header → `malformed_quote` if decode fails
2. Verify buyer Ed25519 signature on quote canonical JSON → `invalid_buyer_signature` if invalid
3. Verify seller Ed25519 signature on quote canonical JSON → `invalid_seller_signature` if invalid
4. Base58-decode `Payment-Signature` header → `invalid_payment_signature` if decode fails
5. Call Solana JSON-RPC method `getTransaction` with the decoded signature, `commitment: "confirmed"`, and `maxSupportedTransactionVersion: 0` → `transaction_not_found` if null
6. Verify transaction status is `confirmed` or `finalized` → `transaction_not_confirmed` if pending; `transaction_failed` if failed
7. Extract SPL token transfer instruction(s) from transaction
8. Verify transfer destination matches `quote.seller` pubkey (derived from DID) → `transfer_destination_mismatch`
9. Verify transfer token mint matches expected USDC SPL mint for the declared network → `transfer_mint_mismatch`
10. Verify transfer amount equals `normalizeAmount(quote.final_price, usdc_mint)` (exact match) → `price_mismatch`
11. If `quote.memo_policy` is `"quote_id_required"`: verify Memo instruction contains `quote.quote_id` → `memo_missing` or `memo_mismatch`
12. If `quote.memo_policy` is `"hash_required"`: verify Memo contains `sha256(canonical_quote_json)` → `memo_missing` or `memo_mismatch`
13. Verify `quote.nonce` format is 32 bytes, lowercase hex, `0x` prefix → `invalid_nonce_format`
14. Check nonce is not consumed (Anchor program: check nonce PDA does not exist) → `nonce_replayed`
15. Verify `quote.expires_at` is in the future → `quote_expired`
16. Execute service → `execution_failed` if service fails
17. Consume nonce atomically with execution (Anchor program: create nonce PDA)

Note: when `memo_policy` is `"optional"`, neither step 11 nor step 12 applies — Memo verification is skipped entirely.

If any step fails, seller MUST return `4xx` and MUST NOT execute the service.

### SPL Token Mint Table

```
USDC mainnet: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v  (6 decimals)
USDC devnet:  4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU   (6 decimals)
```

`normalizeAmount("28.50", USDC_MINT)` = `28500000` (6 decimal places).

Implementations MUST use integer arithmetic on the decimal string — split at the decimal point, pad the fractional part to the mint's decimal count, concatenate. MUST NOT use floating-point conversion.

### Solana Memo Binding

The payment transaction SHOULD include a Solana Memo instruction (Memo Program v2: `MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr`). Implementations MUST use Memo v2, not v1 (`Memo1UhkJBfCR1EPHNqwLDxhZMM2Yfc3G2YfZeVMQwE1`).

Recommended memo payload for `memo_policy: "quote_id_required"`:

```
GhostBazaar:quote_id:<quote_id_uuid>
```

---

## 10. ZK Budget Range Proof (Optional Extension)

This section specifies the ZK budget proof extension. Implementations MAY support this extension. If an RFQ carries a `budget_commitment`, the engine MUST enforce proof verification on all counters for that RFQ.

### 10.1 Purpose

The buyer publishes a Poseidon commitment to `budget_hard` at RFQ time. On every counter-offer, the buyer attaches a Groth16 proof that `counter_price ≤ budget_hard`. The engine and any seller can verify this proof without learning `budget_hard`.

This provides a cryptographic guarantee that the buyer is negotiating within their declared budget ceiling, replacing the convention-only privacy model with a verifiable one.

### 10.2 Price Scaling

Circuit arithmetic operates on integers. All prices are scaled to micro-units before entering the circuit:

```
scaled = decimalString × 10^(mint_decimals)   (integer multiply, no float)

Examples (USDC, 6 decimals):
  "36.50"  →  36_500_000
  "100.00" →  100_000_000
  "0.01"   →  10_000
```

Maximum representable amount: 2^64 − 1 micro-units. The circuit uses 64-bit comparators.

### 10.3 Commitment Scheme

```
budget_commitment = Poseidon([budget_hard_scaled, commitment_salt])
```

- `commitment_salt`: random element in the BN254 scalar field (254 bits), generated once per buyer session, kept local
- Output encoded as `"poseidon:<64-hex-chars>"` (zero-padded to exactly 64 hex characters / 32 bytes)
- The Poseidon output is a BN254 scalar field element. To encode: convert to a 32-byte big-endian unsigned integer, then hex-encode with zero-padding to 64 characters.
- Poseidon provides computational hiding and binding over BN254 scalar field elements
- The commitment is included in the RFQ's canonical JSON and covered by the buyer's signature

### 10.4 Circuit Specification

```circom
pragma circom 2.0.0;
include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/comparators.circom";

template BudgetRangeProof() {
    // ── Public inputs ────────────────────────────────────────────
    signal input counter_price_scaled;   // counter price in micro-units
    signal input budget_commitment;      // Poseidon([budget_hard_scaled, salt])

    // ── Private inputs ───────────────────────────────────────────
    signal input budget_hard_scaled;     // budget ceiling in micro-units
    signal input commitment_salt;        // random field element, known only to buyer

    // ── Constraint 1: commitment integrity ───────────────────────
    component poseidon = Poseidon(2);
    poseidon.inputs[0] <== budget_hard_scaled;
    poseidon.inputs[1] <== commitment_salt;
    poseidon.out === budget_commitment;

    // ── Constraint 2: price within budget ────────────────────────
    component leq = LessEqThan(64);
    leq.in[0] <== counter_price_scaled;
    leq.in[1] <== budget_hard_scaled;
    leq.out === 1;
}

component main {public [counter_price_scaled, budget_commitment]} = BudgetRangeProof();
```

The circuit proves two things simultaneously:
1. The buyer knows a `budget_hard_scaled` and `salt` that hash to the published `budget_commitment`
2. The `counter_price_scaled` is less than or equal to `budget_hard_scaled`

`LessEqThan(64)` constrains both inputs to fit within 64 bits, enforcing a valid price range.

### 10.5 Proof Format

Proofs are transmitted as JSON objects within the `budget_proof` field of a CounterOffer:

```json
{
  "protocol": "groth16",
  "curve": "bn128",       // bn128 = BN254 (same curve; bn128 is the snarkjs convention)
  "counter_price_scaled": "36500000",
  "pi_a": ["<decimal>", "<decimal>", "1"],
  "pi_b": [["<decimal>", "<decimal>"], ["<decimal>", "<decimal>"], ["1", "0"]],
  "pi_c": ["<decimal>", "<decimal>", "1"]
}
```

All proof elements (`pi_a`, `pi_b`, `pi_c`) MUST be decimal strings. This matches snarkjs `fullProve` output format directly.

### 10.6 Verification

Verification requires:
- The proof object (`pi_a`, `pi_b`, `pi_c`)
- Public signals array with two decimal string elements, in this order:
  1. `counter_price_scaled` as a decimal string (e.g., `"36500000"`)
  2. The `budget_commitment` value converted to a decimal string: strip the 9-character `"poseidon:"` prefix, interpret the remaining 64 hex characters as a big-endian unsigned integer, convert to decimal string
- Signal order matches the circuit's `{public [counter_price_scaled, budget_commitment]}` declaration

The verification key (`vkey.json`) is generated during trusted setup and SHOULD be published alongside the circuit for independent verification.

### 10.7 Trusted Setup

Implementations supporting ZK budget proofs MUST perform a Groth16 trusted setup:

1. Download a Powers of Tau file (e.g., `powersOfTau28_hez_final_12.ptau` from Hermez ceremony)
2. Compile the circuit to R1CS
3. Generate the proving key (`.zkey`)
4. Export the verification key (`vkey.json`)

The `.ptau`, `.r1cs`, `.wasm`, and `.zkey` files are generated artifacts. The verification key SHOULD be committed to the repository or published for verifiers.

---

## 11. Duty Split

The protocol defines three duties. Each duty has a clear ownership boundary. Agent runtime orchestration and agent interface bindings (MCP, function-calling, CLI, etc.) are implementation concerns, not protocol duties.

### Duty 1: Protocol Core + Strategy + ZK

Owns:

- Canonical object schemas and validators (RFQ, Offer, Counter, Quote)
- Ed25519 signing and verification
- Canonical JSON serialization
- `normalizeAmount` (SPL mint decimal table)
- `spec_hash` computation
- Error code catalog for malformed artifacts
- ZK budget proof library: commitment generation, proof generation, proof verification (Section 10)
- Strategy interfaces: what information a strategy receives (context), what decisions it produces (actions)
- Private state types (`BuyerPrivate`, `SellerPrivate`)
- Strategy context types (`BuyerStrategyContext`, `SellerStrategyContext`)
- Privacy boundary enforcement (sanitizer functions)

Public interface:

- `validateRfq(rfq) -> {ok, code}`
- `validateOffer(offer, rfq) -> {ok, code}`
- `validateCounter(counter, rfq) -> {ok, code}`
- `buildUnsignedQuote(input) -> quote`
- `signQuoteAsBuyer(quote, keypair) -> quote`
- `signQuoteAsSeller(quote, keypair) -> quote`
- `verifyQuote(quote) -> {ok, code}`
- `normalizeAmount(amount, mint_address) -> bigint` — converts decimal string to integer micro-units using the mint's decimal count (e.g., USDC = 6 decimals). This is the single canonical function for all price-to-integer conversions, including ZK proof scaling. `normalizeAmount("28.50", USDC_MINT)` = `28500000`.
- `computeSpecHash(spec) -> hex_string`
- `generateBudgetCommitment(budget_hard, salt) -> string`
- `generateBudgetProof(counter_price, budget_hard, salt) -> proof`
- `verifyBudgetProof(proof, counter_price_scaled, commitment) -> boolean`

The strategy module MUST be importable as a standalone package. An agent running its own strategy MUST NOT need to import the negotiation engine or settlement code.

### Duty 2: Negotiation Engine

Owns:

- All negotiation HTTP routes (Section 8)
- Session state machine (Section 7)
- Event log (append-only)
- Deadline enforcement
- Counter-offer routing and authorization
- Counter-offer ZK proof verification (delegates to Duty 1 ZK library)
- Buyer-driven winner selection (server does not auto-select)

Depends on: Duty 1 validators and ZK verification library.

Does NOT own: strategy decisions, winner logic, private state, settlement.

### Duty 3: Settlement

Owns:

- `POST /execute` endpoint (runs on seller's server)
- Solana payment verification (Section 9)
- Nonce consumption via Anchor program (Section 12)
- Quote-vs-payment amount check after normalization
- Deal receipt creation via Anchor program (Section 12)

Depends on: Duty 1 quote verification and amount normalization.

Does NOT own: negotiation, strategy, agent orchestration.

### 11.1 Strategy Interface (Abstract)

The schemas below use TypeScript-style notation for readability. Implementations may use any language; what matters is the data shape and constraints.

**Buyer strategy receives:**

```
BuyerStrategyContext {
  rfq:               RFQ
  private:           BuyerPrivate           // local process only
  current_offers:    SellerOffer[]           // best current offer per seller
  counters_sent:     CounterOffer[]          // buyer's own counters this session
  round:             integer
  time_remaining_ms: integer                 // deadline - now
  history:           NegotiationEvent[]      // full append-only event log
}
```

**Buyer strategy produces:**

```
BuyerAction =
  | { type: "counter"; seller: DID; price: Decimal }
  | { type: "accept";  seller: DID }
  | { type: "wait" }
  | { type: "cancel" }
```

**Seller strategy receives:**

```
SellerStrategyContext {
  rfq:                  RFQ
  private:              SellerPrivate        // local process only
  latest_counter:       CounterOffer | null  // most recent buyer counter to this seller
  own_offers:           SellerOffer[]        // seller's own offer history
  round:                integer
  time_remaining_ms:    integer
  competing_sellers:    integer              // count of other active sellers
  seller_listing_profile: NegotiationProfile | null  // from seller's own listing
}
```

**Seller strategy produces:**

```
SellerAction =
  | { type: "respond"; price: Decimal }
  | { type: "counter"; price: Decimal }
  | { type: "hold" }
  | { type: "decline" }
```

### 11.2 Privacy Boundary Enforcement

Every action produced by any strategy MUST pass through a sanitizer before becoming a protocol message:

- Buyer: if action type is `"counter"`, `action.price` MUST be clamped to `min(action.price, budget_hard)`
- Seller: if action type is `"respond"` or `"counter"`, `action.price` MUST be clamped to `max(action.price, floor_price)`

This enforcement runs regardless of strategy type. A buggy strategy, a hallucinating LLM, or a malicious plugin cannot produce an action that violates the private boundary.

### 11.3 LLM Strategy Privacy Rules

When delegating strategy decisions to a language model:

- Private state (`budget_hard`, `budget_soft`, `floor_price`, `target_price`) MUST be injected as natural language constraints in the system prompt only
- Private state MUST NOT appear as structured fields in the user message or function-calling parameters
- The sanitizer MUST run after the LLM response, providing defense in depth

---

## 12. Ghost Bazaar Anchor Program

The Ghost Bazaar Anchor program provides on-chain nonce consumption and deal receipt storage. This section defines the account schemas and seeds. Implementation details (IDL, instruction layout) are left to implementations.

### 12.1 Nonce PDA

Purpose: at-most-once execution guarantee. If the nonce PDA exists, the nonce has been consumed.

**Seeds:**

```
["ghost_bazaar_nonce", quote_id_bytes]
```

Where `quote_id_bytes` is the 16-byte binary representation of `quote.quote_id` (UUID v4 with hyphens stripped, hex-decoded to 16 bytes).

**Account data:**

| Field | Type | Description |
|-------|------|-------------|
| `quote_id` | `[u8; 16]` | UUID bytes |
| `consumed_at_slot` | `u64` | Solana slot at consumption time |
| `buyer` | `Pubkey` | Buyer's Solana pubkey |
| `seller` | `Pubkey` | Seller's Solana pubkey |

**Behavior:**

- "Nonce not consumed" = this PDA account does NOT exist on-chain
- "Consume nonce" = create this PDA account, atomically with service execution
- Account creation is idempotent-guarded by Solana's account creation semantics — attempting to create an existing account fails

### 12.2 Deal Receipt PDA

Purpose: verifiable on-chain history of Ghost Bazaar deals. Enables ecosystem features: reputation, price oracles, analytics.

**Seeds:**

```
["ghost_bazaar_receipt", quote_id_bytes]
```

**Account data:**

| Field | Type | Description |
|-------|------|-------------|
| `quote_id` | `[u8; 16]` | UUID bytes |
| `rfq_id` | `[u8; 16]` | UUID bytes |
| `buyer` | `Pubkey` | Buyer's Solana pubkey |
| `seller` | `Pubkey` | Seller's Solana pubkey |
| `final_price` | `u64` | Price in micro-units (e.g., micro-USDC) |
| `currency_mint` | `Pubkey` | SPL token mint address |
| `service_type` | `String` | Namespaced service type |
| `settled_at_slot` | `u64` | Solana slot at settlement time |
| `payment_signature` | `[u8; 64]` | Solana transaction signature |

**Behavior:**

- Created atomically with nonce consumption during settlement
- Immutable after creation — no update or close instructions
- Anyone can read deal receipts via `getProgramAccounts` with appropriate filters

### 12.3 MVP Fallback

Implementations that do not deploy the Anchor program MAY use:

- **Nonce:** in-memory set keyed by `quote_id` string (matching the Anchor program's PDA key). Checked at step 14, consumed at step 17.
- **Deal receipt:** signed JSON object in the `POST /execute` 200 response body, plus `quote_id` in Solana Memo instruction as on-chain receipt anchor.

The Anchor program is the normative standard. The in-memory fallback is an acceptable MVP simplification but does not provide cross-restart durability or on-chain verifiability.

---

## 13. Service Type Registry

### 13.1 Namespace Convention

Service types follow the format:

```
<namespace>:<category>:<type>
```

- The `ghost-bazaar` namespace is reserved for standard types defined in this spec
- Organizations MAY define custom namespaces (e.g., `mycompany:ai:fine-tuning`)
- Namespaces, categories, and types MUST be lowercase alphanumeric with hyphens (`[a-z0-9-]+`)

### 13.2 Standard Types

```
ghost-bazaar:services:code-review
ghost-bazaar:services:smart-contract-audit
ghost-bazaar:services:data-analysis
ghost-bazaar:services:content-generation
ghost-bazaar:services:translation
ghost-bazaar:services:testing

ghost-bazaar:compute:inference
ghost-bazaar:compute:fine-tuning
ghost-bazaar:compute:batch-processing

ghost-bazaar:data:api-access
ghost-bazaar:data:dataset-query
ghost-bazaar:data:web-scraping
```

### 13.3 Spec Schema Convention

Each service type SHOULD publish a JSON Schema defining the expected fields in the RFQ `spec` object. This enables agents from different implementations to construct valid RFQs for the same service type.

Example for `ghost-bazaar:services:code-review`:

```json
{
  "type": "object",
  "required": ["repo", "scope"],
  "properties": {
    "repo": { "type": "string", "description": "Repository identifier (e.g., org/repo)" },
    "scope": { "type": "string", "enum": ["security", "performance", "full", "security-and-performance"] },
    "max_files": { "type": "integer", "description": "Maximum files to review" }
  }
}
```

The spec schema is advisory. Implementations SHOULD validate against it but MUST NOT reject RFQs with additional fields in `spec`.

---

## 14. Error Code Registry

All protocol and settlement endpoints MUST use these stable machine-readable codes in the `error` field of JSON error responses.

**Protocol validation (Duty 1):**

- `malformed_payload` — request body is not valid JSON or missing required fields
- `malformed_quote` — quote structure is invalid
- `invalid_signature` — generic signature verification failure (use when the signer role is unknown or irrelevant; prefer `invalid_buyer_signature` or `invalid_seller_signature` when the role is known)
- `invalid_buyer_signature` — buyer signature verification failed
- `invalid_seller_signature` — seller signature verification failed
- `currency_mismatch` — offer/counter currency does not match RFQ currency
- `invalid_deadline` — deadline is in the past or malformed
- `invalid_expiry` — `expires_at` or `valid_until` is in the past or malformed
- `invalid_nonce_format` — nonce is not 32 bytes, lowercase hex, `0x`-prefixed
- `invalid_amount` — price or amount is not a valid positive decimal string

**Negotiation (Duty 2):**

- `invalid_state_transition` — requested action is not valid for the current state
- `unauthorized_counter` — `counter.from` does not match `rfq.buyer`
- `invalid_round` — `counter.round` is not monotonically increasing

**Settlement (Duty 3):**

- `invalid_payment_signature` — `Payment-Signature` header is not valid base58
- `transaction_not_found` — Solana RPC returned null for the transaction signature
- `transaction_not_confirmed` — transaction exists but is not confirmed or finalized
- `transaction_failed` — transaction exists but execution failed
- `transfer_destination_mismatch` — SPL transfer destination does not match quote seller
- `transfer_mint_mismatch` — SPL transfer mint does not match expected USDC mint
- `price_mismatch` — transfer amount does not match `normalizeAmount(final_price, usdc_mint)`
- `memo_missing` — Memo instruction required by `memo_policy` but not found
- `memo_mismatch` — Memo content does not match expected value
- `nonce_replayed` — nonce has already been consumed
- `quote_expired` — `quote.expires_at` has elapsed
- `execution_failed` — service execution failed after validation passed

**ZK Budget Proof (optional extension):**

- `invalid_budget_proof` — Groth16 verification returned false
- `missing_budget_proof` — counter sent to RFQ with commitment but no proof attached
- `unexpected_budget_proof` — counter carries proof but RFQ has no commitment
- `invalid_budget_commitment_format` — `budget_commitment` is not `"poseidon:<64-hex-chars>"`
- `proof_price_mismatch` — `counter.price` does not match `budget_proof.counter_price_scaled` after scaling

---

## 15. Security Properties

| Property | Mechanism |
|----------|-----------|
| Budget privacy (hiding) | `budget_hard` never in protocol messages; Poseidon commitment is computationally hiding |
| Budget integrity (binding) | Groth16 proof on every counter proves `counter_price ≤ committed_budget_hard`; engine rejects counters without valid proof |
| Floor price privacy | `floor_price`/`target_price` never in protocol messages |
| Price non-repudiation | Dual Ed25519 signatures on Signed Quote |
| Payment–negotiation binding | Memo instruction links Solana tx to `quote_id` on-chain |
| Replay protection | Nonce PDA; creation is atomic and chain-final |
| Time-boundedness | RFQ `deadline` (negotiation) + `expires_at` (settlement window) |
| Tamper evidence | Any post-signature mutation invalidates Ed25519 signatures |
| Key unification | Agent DID, quote signing key, and Solana payment key are the same Ed25519 keypair |
| Strategy privacy | Sanitizer enforces private boundaries; LLM private state in system prompt only |
| Platform neutrality | Engine relays and verifies but cannot forge signatures; dual-sign is peer-to-peer |
| On-chain verifiability | Deal receipt PDA stores settlement proof readable by any observer |

---

## 16. Failure Modes

### No Deal Before Deadline

- Session transitions to `EXPIRED`
- No quote created, no payment occurs

### Seller Declines Co-Sign

- Session returns from `COMMIT_PENDING` to `NEGOTIATING`
- Buyer strategy may select next-best offer
- Session continues until deadline

### Quote Expires Before Settlement

- Seller MUST reject with `quote_expired`
- Buyer must renegotiate or restart RFQ

### Payment Amount Mismatch

- Seller MUST reject with `price_mismatch`
- Service MUST NOT execute

### Transaction Not Confirmed

- Seller MUST reject with `transaction_not_confirmed`
- Buyer should wait for finalization before retrying

### Nonce Replay

- Seller MUST reject with `nonce_replayed`
- No further action; replay was blocked

### Strategy Produces Out-Of-Bounds Price

- Sanitizer clamps to `budget_hard` (buyer) or `floor_price` (seller)
- No protocol error; sanitizer handles silently
- Runtime MAY log a warning (without logging the raw price)

### ZK Proof Invalid

- Engine MUST reject with `invalid_budget_proof`
- Counter is not appended to event log
- Buyer must regenerate proof with correct inputs

---

## 17. Conformance Tests

### Duty 1: Protocol Core + Strategy + ZK

- RFQ signature pass/fail vectors (canonical JSON round-trip)
- Offer signature pass/fail
- Quote dual-signature pass/fail
- Quote tamper test (single-field mutation)
- Counter-offer signature pass/fail
- `spec_hash` computation determinism
- `normalizeAmount` edge cases: `"0.1"`, `"28.50"`, `"1000000.00"`, high decimal precision
- Nonce format: lowercase hex pass, uppercase hex fail, missing `0x` fail
- Extension fields included in canonical JSON and covered by signature
- Empty `extensions` (`{}`) omitted from canonical JSON; signing bytes identical to absent `extensions`
- Buyer sanitizer: counter price exceeds `budget_hard` → clamped
- Buyer sanitizer: counter price at exactly `budget_hard` → passes unchanged
- Seller sanitizer: respond price below `floor_price` → clamped
- Strategy context contains no private fields from other party
- ZK: `generateBudgetCommitment` → `verifyBudgetProof` round-trip
- ZK: proof with wrong `counter_price_scaled` → verification fails

### Duty 2: Negotiation Engine

- State transition matrix (all valid transitions)
- Forbidden transition returns `409`
- Deadline expiry with no deal → `EXPIRED`
- Offer expiry rejection
- RFQ with unknown `protocol` version → rejected
- RFQ with `budget_commitment` in wrong format → `422 invalid_budget_commitment_format`
- Offer with `currency` not matching RFQ → `422 currency_mismatch`
- Counter-offer authorization: `counter.from !== rfq.buyer` → `422 unauthorized_counter`
- Counter-offer currency mismatch → `422 currency_mismatch`
- Counter-offer expired `valid_until` → `422 invalid_expiry`
- Counter-offer round monotonicity enforcement
- Accept with non-existent seller → `404`
- Accept with expired offer → `422 invalid_expiry`
- Accept by non-buyer DID → `401`
- Seller declines co-sign → return to `NEGOTIATING`
- Event replay reconstruction (full log → identical final state)
- ZK proof verification on counter (if budget_commitment present)
- Counter without proof when RFQ has commitment → `422`
- Counter with proof when RFQ has no commitment → `422`

### Duty 3: Settlement

- Happy path: valid quote + confirmed Solana tx → `200`, service executes, nonce PDA created
- Invalid buyer signature → `4xx`
- Invalid seller signature → `4xx`
- Transaction not confirmed → `4xx`
- Transaction failed → `4xx`
- Transfer destination mismatch → `4xx`
- Price mismatch → `4xx`
- Memo missing when `memo_policy: "quote_id_required"` → `4xx`
- Memo hash mismatch when `memo_policy: "hash_required"` → `4xx`
- Memo not checked when `memo_policy: "optional"` → `200` (no rejection)
- Invalid nonce format at settlement → `4xx`
- Nonce replay (PDA exists) → `4xx`
- Expired quote → `4xx`
- Deal receipt PDA created with correct fields after successful settlement
- Deal receipt PDA data matches quote fields (quote_id, buyer, seller, final_price)

---

## 18. Marketplace Profiles

### Services Marketplace — Recommended First Profile

Service types: `ghost-bazaar:services:*`

Negotiable terms in `spec`:
- `price`
- `deadline`
- `revision_limit`
- `deliverable_spec`

### Compute Marketplace

Service types: `ghost-bazaar:compute:*`

Negotiable terms in `spec`:
- `price`
- `gpu_type`
- `max_tokens` or `max_runtime_seconds`
- `model_id`

### Data Marketplace

Service types: `ghost-bazaar:data:*`

Negotiable terms in `spec`:
- `price`
- `query` or `endpoint`
- `rate_limit`
- `retention_days`

---

## 19. Migration Notes From v3

| v3 | v4 |
|---|---|
| No `protocol` field in RFQ | `"protocol": "ghost-bazaar-v4"` added |
| No `extensions` field | All objects gain `extensions` map |
| `service` field (free-text) | Renamed to `service_type` (namespaced). **Breaking change** to canonical JSON — signing bytes differ between v3 and v4 for RFQ and Quote objects |
| Nonce PDA seed: `[b"nonce", quote_id_bytes]` | Seed changed to `["ghost_bazaar_nonce", quote_id_bytes]`. **Breaking change** — v3 and v4 nonce PDAs derive to different addresses |
| Deal receipt: no program spec | Deal receipt PDA seed: `["ghost_bazaar_receipt", quote_id_bytes]` (new) |
| `buyer_profile` in SellerStrategyContext | Renamed to `seller_listing_profile` (semantic change: seller's own listing, not buyer's profile) |
| Reference strategies + LLM log schema in spec | Moved to implementation guidance; not normative in v4 |
| Signing profile `ghost-bazaar-solana-ed25519-v3` | Updated to `ghost-bazaar-solana-ed25519-v4` |
| `PUT /rfqs/:id/cosign` implicit | Explicit endpoint for seller co-signing |
| No buyer quote signing endpoint | `PUT /rfqs/:id/quote/sign` for buyer to submit `buyer_signature` (new) |
| No quote retrieval endpoint | `GET /rfqs/:id/quote` for retrieving quote at any stage (new) |
| `PAYMENT-SIGNATURE` / `Payment-Signature` mixed case | Normalized to `Payment-Signature` (title case) throughout |
| ZK budget proof out of scope | Formally specified as optional extension (Section 10) |
| No Anchor program spec | Account schemas for nonce + deal receipt PDA (Section 12) |
| 3 duties + strategy module | 3 duties (strategy + ZK merged into Protocol Core); agent runtime + bindings are implementation concerns |
| `POST /execute` ownership implicit | Explicitly on seller's server, not engine |
| No counter authorization check | `counter.from` equals `rfq.buyer` mandatory |
| `memo_policy` default `"optional"` | Default changed to `"quote_id_required"` (normative). **Breaking change** — v3 implementations omitting `memo_policy` will fail settlement against v4 sellers that enforce the new default |
| Error response format unspecified | `{"error": "<code>", "message": "<text>"}` required |
| No service type registry | Namespace convention + standard types (Section 13) |
| Strategy interfaces in TypeScript | Language-agnostic schemas |

v4 is mostly additive, with three breaking changes: (1) `service` → `service_type` field rename in RFQ and Quote objects — this changes canonical JSON serialization and signing bytes, so v3 and v4 implementations cannot cross-sign quotes without adapting; (2) nonce PDA seed prefix changed from `"nonce"` to `"ghost_bazaar_nonce"` — v3 and v4 PDAs derive to different addresses; (3) `memo_policy` default changed from `"optional"` to `"quote_id_required"` — v3 implementations that omit `memo_policy` will fail settlement against v4 sellers. All other v3 field names are preserved.

---

## 20. Open Questions (v4 Draft)

- **Seller-side ZK floor price proof.** Same circuit structure; seller proves `offer_price ≥ committed_floor` without revealing floor. Candidate for v5.
- **On-chain ZK verifier program.** Move proof verification into a Solana program for trustless verification without running the engine.
- **Strategy benchmark suite.** Standard negotiation scenarios for benchmarking strategy implementations against each other.
- **Escrow program.** Anchor program that locks buyer USDC into a PDA before RFQ broadcast, signaling solvency to sellers.
- **Multi-agent seller (threshold signatures).** t-of-n Solana multisig for quote co-signing by DAOs or collectives.
- **Agent reputation.** PDA-based reputation score derived from deal receipt history on-chain.
- **Price oracle.** Anonymized historical price aggregation from deal receipt PDAs for market rate discovery.
- **Discovery standard.** `.well-known/ghost-bazaar.json` endpoint convention for agent discoverability across engines.

---

*End of Draft v4.*
