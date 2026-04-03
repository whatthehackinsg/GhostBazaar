# Ghost Bazaar Protocol
### Specification v3: Solana-Native Agent Negotiation with Autonomous Strategy

**Status:** Draft v3
**Date:** March 13, 2026
**Supersedes:** `GHOST-BAZAAR-SPEC-v2.md`, `GHOST-BAZAAR-SPEC-v0.1.md`

---

## Abstract

Ghost Bazaar v3 specifies a negotiation layer for agent-to-agent commerce on Solana. It preserves the core four-phase model — Discovery, Negotiation, Commitment, Settlement — and the x402 blackbox settlement boundary that makes Ghost Bazaar composable with any HTTP-based payment rail.

Three design decisions distinguish v3:

1. **Solana-native.** Ed25519 is the only signature scheme. Agent identity derives directly from Solana wallet keypairs. Settlement verification uses on-chain Solana transaction proofs rather than EVM payment payloads. Nonce consumption is backed by Program Derived Addresses.

2. **Autonomous strategy.** Agents carry pluggable strategy modules that reason about when and how much to bid. Strategy is isolated from the protocol: it consumes protocol state and produces protocol actions, but its private inputs (budget ceilings, floor prices) never appear in any wire message.

3. **Strategy signaling.** Agents may publish a negotiation style hint in their listing. This is non-binding but informs counterparts about expected negotiation behavior, allowing more efficient round allocation.

Settlement remains on x402. Negotiation remains off-chain and time-bounded. The dual-signed `Signed Quote` remains the cryptographic commitment object.

---

## 1. What Is New In v3

Compared to v2:

- **Drop EIP-712.** Ed25519 is the only signing profile. Mixed-scheme quotes are not supported.
- **Solana identity.** Agent DIDs use `did:key` derived from Solana Ed25519 wallet pubkeys (same bytes, no separate key management).
- **Solana x402 settlement.** `PAYMENT-SIGNATURE` carries a base58-encoded Solana transaction signature. Seller verifies on-chain via `getTransaction` RPC.
- **SPL USDC normalization.** `normalizeAmount` uses SPL token mint decimal tables, not symbol-only lookup.
- **Solana Memo binding.** Payment transaction SHOULD include `quote_id` as a Solana Memo instruction, creating an immutable on-chain receipt linking payment to negotiated terms.
- **PDA nonce consumption.** Nonce consumption is backed by a Solana Program Derived Address, eliminating the open question of nonce backend (KV vs Redis vs SQL).
- **Counter-offer as first-class message.** `POST /rfqs/:id/counter` is a normative endpoint. Buyer drives winner selection through explicit accept; server does not auto-select.
- **Strategy module.** New `Strategy` layer sits above the protocol. Defines `BuyerStrategy` and `SellerStrategy` interfaces, `StrategyContext` input types, `StrategyAction` output types, reference implementations, and privacy boundary rules.
- **Strategy signaling.** `ListingIntent` gains a `negotiation_profile` field for advertising negotiation style.
- **LLM action logging.** Normative privacy-preserving log schema for LLM strategy decisions: action type and context fingerprint only; no prices, no private state.

---

## 2. Scope And Non-Goals

### In Scope

- RFQ-based multi-seller negotiation
- Structured offer, counter-offer, and accept flow
- Dual-signature quote commitment (Ed25519, Solana keypair)
- x402 settlement compatibility via HTTP headers
- Solana on-chain payment verification and nonce consumption
- Autonomous agent strategy interface and reference implementations
- Privacy-preserving strategy action audit logging
- Strategy style signaling in listing metadata

### Out Of Scope (v3)

- Delivery quality arbitration or escrow
- Reputation or Sybil resistance mechanisms
- On-chain negotiation logic
- Multi-unit or batch negotiation
- ZK budget proofs (noted as future extension)
- Cross-chain settlement other than Solana

---

## 3. Roles

### Buyer Agent

- Holds `budget_soft` and `budget_hard` in local private state; these never appear in protocol messages
- Broadcasts RFQ with `anchor_price` and `deadline`
- Runs a `BuyerStrategy` to decide counters, acceptance timing, and seller selection
- Co-signs the Signed Quote and initiates the Solana payment transaction
- Attaches quote and payment to the HTTP settlement call

### Seller Agent

- Holds `floor_price` and `target_price` in local private state
- Reads listing RFQs and returns signed offers via a `SellerStrategy`
- Revises offers during counter rounds
- Co-signs the Signed Quote when terms are acceptable
- Validates the Signed Quote and Solana payment proof before executing the service

### Negotiation Runtime

- Stateless relative to strategy: it relays messages, enforces the state machine, and persists the event log
- Does NOT select winners on behalf of buyers
- Enforces deadline and state transition rules
- Coordinates quote generation and co-sign handoff

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
- Seller MUST reject a replayed `nonce` (PDA account already exists).
- `final_price` MUST match the SPL token transfer amount in the Solana payment transaction after decimal normalization.
- Buyer strategy MUST NOT produce a counter price exceeding `budget_hard`.
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
  "title": "Agent code review",
  "base_terms": {
    "currency": "USDC",
    "sla_hours": 24
  },
  "negotiation_endpoint": "https://seller.example.com/negotiate",
  "payment_endpoint": "https://seller.example.com/execute",
  "negotiation_profile": {
    "style": "flexible",
    "max_rounds": 5,
    "accepts_counter": true
  }
}
```

**`negotiation_profile` field rules:**

- `style`: MUST be one of `"firm"`, `"flexible"`, `"competitive"`, `"deadline-sensitive"`. Definitions:
  - `"firm"` — seller rarely discounts; buyer should expect fewer productive rounds
  - `"flexible"` — seller open to negotiation; more rounds likely to improve price
  - `"competitive"` — buyer signals preference for multi-seller competition; sellers should not expect exclusive treatment
  - `"deadline-sensitive"` — agent signals urgency; counterpart may extract higher price late in the window
- `max_rounds`: advisory ceiling on counter rounds; enforcement is at seller discretion
- `accepts_counter`: `true` if the seller will respond to buyer counter-offers; `false` if seller offers are final

`negotiation_profile` is NON-BINDING. It is a hint, not a constraint. The state machine does not enforce round counts based on this field.

### 5.2 Request For Quote (RFQ)

```json
{
  "rfq_id": "uuid-v4",
  "buyer": "did:key:z6Mk...",
  "service": "code-review",
  "spec": {
    "repo": "org/repo",
    "scope": "security-and-performance"
  },
  "anchor_price": "25.00",
  "currency": "USDC",
  "deadline": "2026-03-13T12:00:30Z",
  "signature": "ed25519:..."
}
```

Rules:

- `anchor_price` MUST be > 0 and SHOULD be set below `budget_soft` (anchoring heuristic: ~65% of soft target is a reasonable default)
- `deadline` MUST be in the future at creation time
- Buyer MUST sign the canonical RFQ payload (see Section 6)
- `budget_hard` and `budget_soft` MUST NOT appear in any RFQ field

### 5.3 Seller Offer

```json
{
  "offer_id": "uuid-v4",
  "rfq_id": "uuid-v4",
  "seller": "did:key:z6Mk...",
  "price": "32.00",
  "currency": "USDC",
  "valid_until": "2026-03-13T12:00:20Z",
  "signature": "ed25519:..."
}
```

Rules:

- `price` MUST be > 0
- `currency` MUST match RFQ `currency`
- `valid_until` MUST be in the future at creation time
- Seller MUST sign the canonical offer payload

### 5.4 Counter-Offer

Counter-offers are first-class objects in v3. Buyer sends a counter to a specific seller; seller may respond with a revised offer.

```json
{
  "counter_id": "uuid-v4",
  "rfq_id": "uuid-v4",
  "round": 2,
  "from": "did:key:z6Mk...",
  "to": "did:key:z6Mk...",
  "price": "28.00",
  "currency": "USDC",
  "valid_until": "2026-03-13T12:00:25Z",
  "signature": "ed25519:..."
}
```

Rules:

- `round` MUST be monotonically increasing per `rfq_id`
- `from` and `to` MUST be valid agent DIDs
- `price` MUST be > 0 and MUST NOT exceed `budget_hard` (enforced by strategy sanitizer, never by protocol parser)
- Sender MUST sign the canonical counter payload

### 5.5 Signed Quote (Commitment Object)

```json
{
  "quote_id": "uuid-v4",
  "rfq_id": "uuid-v4",
  "buyer": "did:key:z6Mk...",
  "seller": "did:key:z6Mk...",
  "service": "code-review",
  "spec_hash": "sha256:<hex>",
  "final_price": "28.50",
  "currency": "USDC",
  "payment_endpoint": "https://seller.example.com/execute",
  "expires_at": "2026-03-13T12:01:00Z",
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
- `spec_hash` SHOULD be included: `sha256(canonical_json(rfq.spec))`, binds service parameters to the quote
- Buyer and seller MUST sign identical canonical quote payload bytes (see Section 6)
- `memo_policy`:
  - `"quote_id_required"` — Solana payment transaction MUST include `quote_id` in Memo instruction
  - `"hash_required"` — transaction MUST include `sha256(canonical_quote)` in Memo
  - `"optional"` — Memo is recommended but not enforced at settlement gate
  - If absent, defaults to `"optional"` in MVP; implementations SHOULD default to `"quote_id_required"`

---

## 6. Signing And Canonicalization Profile

**Profile ID:** `ghost-bazaar-solana-ed25519-v3`

This profile is normative. Implementations that diverge from this serialization WILL fail interop.

### Canonical JSON Rules

- Object key ordering: recursively sort by Unicode codepoint order (lexicographic)
- Whitespace: none outside strings; separators are `,` and `:` (no spaces)
- Number encoding: price/amount fields MUST be decimal strings (e.g., `"28.50"`), not JSON numbers
- String encoding: UTF-8
- Null fields: omit entirely; do not include with null values

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
did:key:z<base58btc(0xed 0x01 + raw_32_byte_pubkey)>
```

- `0xed 0x01` = two raw bytes (unsigned-varint multicodec for Ed25519)
- `raw_32_byte_pubkey` = the Solana wallet's 32-byte Ed25519 public key
- `base58btc` = Bitcoin's base58 alphabet (same as Solana's base58 pubkey encoding)

This means a Solana wallet's base58 pubkey and its `did:key` representation encode the same 32 bytes. No separate key management is required.

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
- `CANCELLED` — explicit cancellation by buyer or seller

Allowed transitions:

```
OPEN              -> NEGOTIATING
NEGOTIATING       -> COMMIT_PENDING
COMMIT_PENDING    -> COMMITTED
COMMIT_PENDING    -> NEGOTIATING      (seller declines co-sign; buyer may re-select)
OPEN | NEGOTIATING | COMMIT_PENDING -> EXPIRED
OPEN | NEGOTIATING -> CANCELLED
```

Invalid transitions MUST return `409 Conflict`.

The runtime does NOT select the winning seller. Buyer drives the `NEGOTIATING -> COMMIT_PENDING` transition by calling `POST /rfqs/:id/accept` with an explicit `seller` DID. If the selected seller declines to co-sign, session returns to `NEGOTIATING` and buyer may select a different seller.

---

## 8. HTTP Transport Profile

### Discovery and Negotiation Endpoints

- `GET /listings` — list available seller listings
- `GET /listings/:id` — get listing with `negotiation_profile`
- `POST /rfqs` — broadcast RFQ
- `POST /rfqs/:id/offers` — seller submits offer
- `POST /rfqs/:id/counter` — buyer sends counter to a specific seller (NEW)
- `POST /rfqs/:id/accept` — buyer selects winner and initiates quote co-sign
- `GET /rfqs/:id/events` — append-only event stream

### Settlement Endpoint

- `POST /execute`

Required headers on settlement request:

- `Payment-Signature` — base58-encoded Solana transaction signature
- `X-Ghost-Bazaar-Quote` — base64-encoded canonical JSON of the Signed Quote

Implementations MUST return machine-readable JSON error bodies on all 4xx responses.

---

## 9. Strategy Layer

The strategy layer is architecturally isolated from the protocol. It consumes protocol state (public, on-wire data) plus local private state, and produces typed action decisions. Private state never crosses the protocol boundary.

### 9.1 Private State (Never On Wire)

```
BuyerPrivate {
  budget_soft:  Decimal   // "I want to pay no more than this"
  budget_hard:  Decimal   // "I will not pay more than this under any circumstances"
}

SellerPrivate {
  floor_price:  Decimal   // "I will not go below this"
  target_price: Decimal   // "I want to earn this"
}
```

These values MUST NOT appear in any protocol message, log entry, or observable output. They are inputs to strategy functions only.

### 9.2 Strategy Context Objects

What a strategy function receives to make a decision:

```
BuyerStrategyContext {
  rfq:               RFQ
  private:           BuyerPrivate          // local process only
  current_offers:    SellerOffer[]          // best current offer per seller
  counters_sent:     CounterOffer[]         // buyer's own counters this session
  round:             integer
  time_remaining_ms: integer                // deadline - now
  history:           NegotiationEvent[]     // full append-only event log
}

SellerStrategyContext {
  rfq:                  RFQ
  private:              SellerPrivate       // local process only
  latest_counter:       CounterOffer | null // most recent buyer counter to this seller
  own_offers:           SellerOffer[]       // seller's own offer history
  round:                integer
  time_remaining_ms:    integer
  competing_sellers:    integer             // count of other active sellers (visible from event log)
  buyer_profile:        NegotiationProfile | null // from buyer's RFQ if provided
}
```

### 9.3 Strategy Action Types

```
BuyerAction =
  | { type: "counter"; seller: DID; price: Decimal }
  | { type: "accept";  seller: DID }
  | { type: "wait" }
  | { type: "cancel" }

SellerAction =
  | { type: "respond"; price: Decimal }
  | { type: "counter"; price: Decimal }
  | { type: "hold" }
  | { type: "decline" }
```

### 9.4 Strategy Interface

```typescript
interface BuyerStrategy {
  // Called before broadcasting RFQ. Returns anchor price to use.
  openingAnchor(intent: ServiceIntent, priv: BuyerPrivate): Decimal

  // Called when offers or counter responses arrive.
  onOffersReceived(ctx: BuyerStrategyContext): BuyerAction
}

interface SellerStrategy {
  // Called when an RFQ arrives. Returns initial response.
  onRfqReceived(ctx: SellerStrategyContext): SellerAction

  // Called when a buyer counter-offer arrives.
  onCounterReceived(ctx: SellerStrategyContext): SellerAction
}
```

Implementations may be synchronous or asynchronous. LLM-delegated implementations are expected to be async.

### 9.5 Privacy Boundary Enforcement

Every `BuyerAction` produced by any strategy MUST pass through a sanitizer before becoming a protocol message:

```typescript
function sanitizeBuyerAction(action: BuyerAction, priv: BuyerPrivate): BuyerAction {
  if (action.type === "counter") {
    // Hard cap: strategy must never exceed budget_hard
    const safe_price = Decimal.min(action.price, priv.budget_hard)
    return { ...action, price: safe_price }
  }
  return action
}
```

This enforcer runs regardless of strategy type. A buggy rule-based strategy, a hallucinating LLM, or a malicious plugin cannot produce a counter that exceeds `budget_hard`.

Equivalent enforcement applies on the seller side: `SellerAction` of type `"respond"` or `"counter"` MUST have `price >= floor_price` after sanitization.

### 9.6 Reference Strategy Implementations

**LinearConcession (buyer)**

Moves anchor price toward `budget_soft` linearly, one step per round. Does not approach `budget_hard` unless urgency threshold triggers.

```
concession_step   = (budget_soft - anchor_price) / expected_rounds
price_at_round[n] = anchor_price + (concession_step * n)
if time_remaining < urgency_threshold:
    price_at_round[n] = budget_soft   // jump to soft target under pressure
```

**TimeWeighted (buyer)**

Concession rate is a function of elapsed deadline fraction. Concessions accelerate naturally as time runs out.

```
urgency           = 1 - (time_remaining_ms / total_window_ms)   // [0.0, 1.0]
price_at_time     = anchor_price + (budget_soft - anchor_price) * urgency^2
```

**Competitive (buyer)**

Exploits seller competition. Holds firm when multiple sellers compete; concedes faster when sole responder remains.

```
if competing_sellers >= 3: concession_multiplier = 0.5
if competing_sellers == 1: concession_multiplier = 1.5
apply concession_multiplier to base concession_step
```

**FloorDefend (seller)**

Opens at `target_price`, concedes toward `floor_price` over rounds, never crosses floor.

```
max_concession    = target_price - floor_price
concession_step   = max_concession / max_rounds
offer_at_round[n] = max(target_price - (concession_step * n), floor_price)
```

**LLMDelegate (buyer or seller)**

Delegates the decision to a language model. The model receives a structured prompt containing public context only. Private state is injected as constraints in the system prompt, not as data fields.

```typescript
async function onOffersReceived(ctx: BuyerStrategyContext): Promise<BuyerAction> {
  const system_prompt = `You are a buyer agent negotiating for: ${ctx.rfq.service}.
Your price target is ${ctx.private.budget_soft} USDC.
Do not exceed ${ctx.private.budget_hard} USDC under any circumstances.
Return a JSON object matching BuyerAction schema.`

  const user_context = {
    round: ctx.round,
    time_remaining_seconds: Math.floor(ctx.time_remaining_ms / 1000),
    current_offers: ctx.current_offers.map(o => ({
      seller: o.seller,
      price: o.price,
      valid_until: o.valid_until
    }))
    // NOTE: budget_hard and budget_soft NEVER included in this object
  }

  return await llm.complete([system_prompt, JSON.stringify(user_context)], {
    response_schema: BuyerActionSchema
  })
}
```

The LLM sees `budget_hard` as a constraint statement in the system prompt, never as a structured field it could inadvertently expose. The `sanitizeBuyerAction` pass runs after the LLM response, providing defense in depth.

### 9.7 LLM Strategy Action Logging (Privacy-Preserving)

Agent runtimes MAY log LLM strategy decisions for audit, debugging, and strategy improvement. Logging MUST follow this schema — no fields beyond what is specified here may be added to a log entry:

```json
{
  "log_id": "uuid-v4",
  "rfq_id": "uuid-v4",
  "quote_id": "uuid-v4 | null",
  "actor": "did:key:z6Mk...",
  "strategy_type": "llm-delegate",
  "action_type": "counter",
  "round": 2,
  "time_remaining_seconds": 18,
  "competing_count": 3,
  "context_fingerprint": "sha256:<hex of canonical public context JSON>",
  "timestamp": "2026-03-13T12:00:12Z"
}
```

**What MUST NOT appear in log entries:**

- `price`, `final_price`, `anchor_price`, or any price field
- `budget_hard`, `budget_soft`, `floor_price`, `target_price`
- LLM prompt text or completion text
- Any private state field

**What the log records:**

- `action_type` — the decision category (`counter`, `accept`, `wait`, `cancel`, `respond`, `decline`, `hold`)
- `context_fingerprint` — `sha256` of the canonical JSON of the public portion of `StrategyContext` (excluding the `private` field). This allows an auditor to reconstruct what public information the agent had when it made its decision, without exposing private values.
- `round`, `time_remaining_seconds`, `competing_count` — structural context metrics; no prices

**Relative position signal (optional, additive only):**

An implementation MAY add a `relative_position` field with one of these values:

- `"below_anchor"` — action price was below anchor (unexpected; may indicate data issue)
- `"at_anchor"` — action price equals anchor
- `"between_anchor_and_soft"` — normal negotiation range
- `"at_soft"` — at soft target
- `"above_soft"` — above soft target (urgency range)

This communicates strategic position category without revealing absolute prices. If added, it MUST be one of the five enumerated values above; it MUST NOT be a raw price or a computed delta.

---

## 10. Duty Split

### Duty 1: Protocol Core

Owns:

- Canonical object schemas and validators (RFQ, Offer, Counter, Quote)
- Ed25519 signing and verification
- Canonical JSON serialization
- `normalizeAmount` (SPL mint decimal table)
- `spec_hash` computation
- Error code catalog for malformed artifacts

Public interface:

- `validateRfq(rfq) -> {ok, code}`
- `validateOffer(offer, rfq) -> {ok, code}`
- `validateCounter(counter, rfq) -> {ok, code}`
- `buildUnsignedQuote(input) -> quote`
- `signQuoteAsBuyer(quote, keypair) -> quote`
- `signQuoteAsSeller(quote, keypair) -> quote`
- `verifyQuote(quote) -> {ok, code}`
- `normalizeAmount(amount, mint_address) -> bigint`
- `computeSpecHash(spec) -> hex`

### Duty 2: Negotiation Engine

Owns:

- All negotiation HTTP routes
- Session state machine
- Event log (append-only)
- Deadline enforcement
- Counter-offer routing (`POST /rfqs/:id/counter`)
- Buyer-driven winner selection (server does not auto-select)

Depends on: Duty 1 validators only.

Does NOT own: strategy decisions, winner logic, private state.

### Duty 3: Settlement + Agent Interface

Owns:

- `POST /execute` endpoint
- Solana payment verification (Section 11)
- PDA nonce consumption
- Quote-vs-payment amount check after normalization
- MCP tool interface for autonomous agents

Depends on: Duty 1 quote verification and amount normalization.

### Strategy Module

Owns:

- `BuyerStrategy` and `SellerStrategy` interfaces
- `BuyerPrivate` and `SellerPrivate` types
- `BuyerStrategyContext` and `SellerStrategyContext` types
- `sanitizeBuyerAction` and `sanitizeSellerAction` enforcement functions
- Reference implementations (LinearConcession, TimeWeighted, Competitive, FloorDefend, LLMDelegate)
- Privacy-preserving action log writer

Depends on: Duty 1 canonical types only. No dependency on Duty 2 or Duty 3 internals.

The strategy module MUST be importable as a standalone package. An agent running its own strategy instance must not need to import the negotiation engine or settlement code.

---

## 11. Solana-Native Settlement

### 11.1 PAYMENT-SIGNATURE Format

`Payment-Signature` header carries the base58-encoded Solana transaction signature (64 bytes):

```
Payment-Signature: 5j7s...Kx9  (base58, no prefix)
```

This is the transaction signature returned by `sendTransaction` / `sendAndConfirmTransaction`. It uniquely identifies the transaction on-chain.

### 11.2 Settlement Validation Order (Normative)

On `POST /execute`, seller MUST validate in this exact order:

1. Parse and base64-decode `X-Ghost-Bazaar-Quote` header
2. Verify buyer Ed25519 signature on quote canonical JSON (Duty 1)
3. Verify seller Ed25519 signature on quote canonical JSON (Duty 1)
4. Base58-decode `Payment-Signature` header
5. Call Solana RPC: `getTransaction(signature, { commitment: "confirmed" })`
6. Verify transaction status is `confirmed` or `finalized` (not `null`, not failed)
7. Extract SPL token transfer instruction(s) from transaction
8. Verify transfer destination matches `quote.seller` pubkey (derived from DID)
9. Verify transfer token mint matches expected USDC SPL mint for the declared network
10. Verify transfer amount equals `normalizeAmount(quote.final_price, usdc_mint)` (exact match)
11. If `quote.memo_policy` is `"quote_id_required"`: verify Memo instruction contains `quote.quote_id`
12. If `quote.memo_policy` is `"hash_required"`: verify Memo contains `sha256(canonical_quote_json)`
13. Check PDA nonce account does NOT exist (nonce not consumed)
14. Check `quote.expires_at` is in the future
15. Execute service
16. Create PDA nonce account atomically with execution (marks nonce consumed)

If any step fails, seller MUST return 4xx and MUST NOT execute the service.

### 11.3 SPL Token Mint Table (MVP)

```
USDC mainnet: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v  (6 decimals)
USDC devnet:  4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU   (6 decimals)
```

`normalizeAmount("28.50", USDC_MINT)` = `28500000` (6 decimal places).

### 11.4 PDA Nonce Account

Nonce consumption uses a Program Derived Address seeded by `[b"nonce", quote_id_bytes]`:

```
nonce_pda = findProgramAddressSync(
  [Buffer.from("nonce"), uuid_to_bytes(quote.quote_id)],
  GHOST_BAZAAR_PROGRAM_ID
)
```

- "Nonce not consumed" check = this PDA account does NOT exist on-chain
- "Consume nonce" = create this PDA account, atomically with service execution
- Account creation is idempotent-guarded by Solana's account creation semantics
- TTL: rent-exempt accounts persist until closed; lamport expiry is not relied upon for nonce security

This replaces the open question from v2 ("KV vs Redis vs SQL"). The chain IS the nonce store.

### 11.5 Solana Memo Binding

The payment transaction SHOULD include a Solana Memo instruction (Memo Program: `MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr`).

Recommended memo payload for `memo_policy: "quote_id_required"`:

```
GhostBazaar:quote_id:<quote_id_uuid>
```

This creates a permanent, zero-cost on-chain receipt linking the Solana transaction to the off-chain negotiation. Any observer can verify which negotiation session this payment corresponds to.

---

## 12. Error Code Registry

All protocol and settlement endpoints MUST use these stable machine-readable codes:

**Protocol validation (Duty 1):**
- `malformed_payload`
- `malformed_quote`
- `invalid_signature`
- `invalid_buyer_signature`
- `invalid_seller_signature`
- `currency_mismatch`
- `invalid_deadline`
- `invalid_expiry`
- `invalid_nonce_format`
- `invalid_amount`

**Settlement (Duty 3):**
- `invalid_payment_signature`
- `transaction_not_found`
- `transaction_not_confirmed`
- `transaction_failed`
- `transfer_destination_mismatch`
- `transfer_mint_mismatch`
- `price_mismatch`
- `memo_missing`
- `memo_quote_id_mismatch`
- `nonce_replayed`
- `quote_expired`
- `execution_failed`

**State machine (Duty 2):**
- `invalid_state_transition`

---

## 13. Security Properties

| Property | Mechanism |
|---|---|
| Budget privacy | `budget_hard`/`budget_soft` local only; strategy sanitizer enforces at output boundary |
| Price non-repudiation | Dual Ed25519 signatures on Signed Quote |
| Payment–negotiation binding | Memo instruction links Solana tx to `quote_id` on-chain |
| Replay protection | PDA nonce account; creation is atomic and chain-final |
| Time-boundedness | RFQ `deadline` (negotiation) + `expires_at` (settlement window) |
| Tamper evidence | Any post-signature mutation invalidates both Ed25519 signatures |
| Key unification | Agent DID, quote signing key, and Solana payment signing key are the same Ed25519 keypair |
| Strategy privacy | LLM action log: action type + context fingerprint only; no prices, no private state |

---

## 14. Failure Modes

### No Deal Before Deadline

- Session transitions to `EXPIRED`
- No quote created, no payment occurs
- Buyer agent logs `action_type: "cancel"` implicitly

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
- Buyer must re-examine Solana transaction construction

### Transaction Not Confirmed

- Seller MUST reject with `transaction_not_confirmed`
- Buyer should wait for finalization before retrying

### Nonce Replay (PDA Exists)

- Seller MUST reject with `nonce_replayed`
- No further action; replay was blocked

### Strategy Produces Out-Of-Bounds Price

- `sanitizeBuyerAction` clamps to `budget_hard`
- No protocol error; sanitizer handles silently
- Runtime MAY log a warning for monitoring purposes (without logging the raw price)

---

## 15. Conformance Tests

### Duty 1

- RFQ signature pass / fail vectors (canonical JSON round-trip)
- Offer signature pass / fail
- Quote dual-signature pass / fail
- Quote tamper test (single-field mutation)
- Counter-offer signature pass / fail
- `spec_hash` computation determinism
- `normalizeAmount` edge cases: `"0.1"`, `"28.50"`, `"1000000.00"`, high decimal precision
- Nonce format: lowercase hex pass, uppercase hex fail, missing `0x` fail

### Duty 2

- State transition matrix (all valid transitions)
- Forbidden transition returns `409`
- Deadline expiry with no deal → `EXPIRED`
- Offer expiry rejection
- Counter-offer routing to correct seller
- Seller declines co-sign → return to `NEGOTIATING`
- Event replay reconstruction (full log → identical final state)
- Concurrent offer writes for same RFQ (no corruption)

### Duty 3

- Happy path: valid quote + confirmed Solana tx → `200`, service executes, PDA created
- Invalid buyer signature → `4xx`
- Invalid seller signature → `4xx`
- Transaction not confirmed → `4xx`
- Transfer destination mismatch → `4xx`
- Price mismatch → `4xx`
- Memo missing when `memo_policy: "quote_id_required"` → `4xx`
- Nonce replay (PDA exists) → `4xx`
- Expired quote → `4xx`
- PDA creation atomicity: simulated execution failure after PDA write → nonce NOT consumed

### Strategy Module

- `sanitizeBuyerAction`: counter price exceeds `budget_hard` → clamped
- `sanitizeBuyerAction`: counter price at exactly `budget_hard` → passes unchanged
- `LinearConcession`: price progression is monotonically increasing toward `budget_soft`
- `TimeWeighted`: price accelerates as `time_remaining_ms` approaches 0
- `FloorDefend`: price never crosses `floor_price`
- `LLMDelegate`: `budget_hard` not present in `user_context` JSON object
- Action log writer: log entry contains no price fields, no private state fields

---

## 16. Marketplace Profiles

### Services Marketplace (Upwork-style) — Recommended First Profile

Negotiable terms in `spec`:

- `price`
- `deadline`
- `revision_limit`
- `deliverable_spec`

Typical `negotiation_profile.style`: `"flexible"` for new sellers, `"firm"` for established agents with verified track records.

### C2C Marketplace (Carousell-style)

Negotiable terms in `spec`:

- `price`
- `delivery_mode`
- `shipping_cost`
- `item_condition`

### Merchant Marketplace (Amazon-style)

Negotiable terms in `spec`:

- `unit_price`
- `bulk_discount`
- `shipping_eta`
- `return_window`

---

## 17. Open Questions (v3 Draft)

- **ZK budget sufficiency proof.** Can a ZK proof in the RFQ let buyers prove `budget_hard >= seller_price` without revealing the value? Feasible per academic literature (Groth16, ~420ms latency for two-party). Adds proof generation infrastructure. Candidate for v4.
- **Strategy profile negotiation.** Should buyer and seller exchange `negotiation_profile` at the start of a session to agree on round budgets before offers begin?
- **Aggregate market signals.** Should agents be able to query anonymized historical price distributions (e.g., "median accepted price for code-review last 7 days") as strategy input? Requires a price oracle component.
- **Strategy benchmark suite.** Should the spec define standard negotiation scenarios for benchmarking strategy implementations against each other?
- **Escrow program.** Should a Solana Anchor program optionally lock buyer USDC into a PDA before RFQ broadcast, signaling solvency to sellers? This removes the solvency risk without requiring on-chain negotiation.
- **Threshold signatures for multi-agent sellers.** If a seller is a collective or DAO, t-of-n Solana multisig for quote co-signing?
- **Standardization path.** Independent standard, x402 extension, or Solana ecosystem proposal?

---

## 18. Migration Notes From v2

| v2 | v3 |
|---|---|
| `ed25519` or `eip712` scheme | Ed25519 only; remove all EIP-712 references |
| `PAYMENT-SIGNATURE` = EVM payload | `Payment-Signature` = base58 Solana tx signature |
| Nonce: KV/Redis/SQL (open question) | Nonce: Solana PDA (resolved) |
| Winner selection: server deterministic sort | Winner selection: buyer-driven `POST /rfqs/:id/accept` |
| No counter-offer endpoint | `POST /rfqs/:id/counter` (normative) |
| No strategy interface | Strategy module with pluggable `BuyerStrategy`/`SellerStrategy` |
| No strategy signaling | `negotiation_profile` in `ListingIntent` |
| No LLM action log spec | Privacy-preserving log schema (Section 9.7) |
| `spec_hash` optional mention | `spec_hash` SHOULD be included in all Signed Quotes |
| `memo_policy` absent | `memo_policy` field in Signed Quote, defaults to `"optional"` |

Keep all existing RFQ, Offer, and Quote field names. The object schemas are backward-compatible. Only the settlement header parsing, signature scheme, and nonce backend change at the implementation level.

---

*End of Draft v3.*
