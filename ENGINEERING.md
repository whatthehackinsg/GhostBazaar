# Ghost Bazaar Engineering Guide

This document is a practical guide for engineers implementing the Ghost Bazaar protocol. It covers data structures, negotiation flow, settlement integration, cryptographic requirements, ZK budget proofs, and the MCP agent interface.

All mechanics in this guide are aligned with GHOST-BAZAAR-SPEC-v4.md. For the authoritative reference, see the spec directly.

## Protocol Overview

Ghost Bazaar operates in four sequential phases:

```
Phase 1: Discovery       Phase 2: Negotiation      Phase 3: Commitment       Phase 4: Settlement
────────────────────     ────────────────────      ────────────────────      ────────────────────
Buyer broadcasts RFQ     Sellers return offers     Dual-signed Quote         Solana SPL Transfer
  w/ budget_commitment   Buyer counter-offers      (Ed25519, both sign)      17-step verification
  to sellers A,B,C...    ZK proof on counters      Price locked              Nonce consumed
```

**Transport:** Negotiation happens over HTTP (Hono server). Settlement happens over HTTPS with `Payment-Signature` and `X-Ghost-Bazaar-Quote` headers.

## Roles

### Buyer Agent

- Holds private state: `budget_soft`, `budget_hard`, `commitment_salt`. These MUST NOT appear in any protocol message.
- Identity: Solana keypair → `did:key:z6Mk...` (multicodec `0xed01` + pubkey, base58btc)
- Publishes `budget_commitment = Poseidon([budget_hard_scaled, salt])` in RFQ (optional)
- Generates Groth16 proof on every counter-offer (if budget commitment present)
- Drives negotiation: broadcasts RFQ, collects offers, counter-offers, selects winner

### Seller Agent

- Holds private state: `floor_price`, `target_price`. These MUST NOT appear in any protocol message.
- Identity: Solana keypair → `did:key`
- Responds to RFQs with offers, handles counter-offers
- Co-signs the final quote, runs settlement validation, executes service

### Negotiation Engine

- HTTP server managing session state and event log
- Enforces state machine transitions and deadlines
- Verifies ZK proofs on counter-offers
- Does NOT make strategy decisions

## Data Structures

Full schemas are in GHOST BAZAAR-SPEC-v4, Section 5.

### RFQ

```json
{
  "rfq_id": "uuid-v4",
  "protocol": "ghost-bazaar-v4",
  "buyer": "did:key:z6Mk...",
  "service_type": "ghost-bazaar:services:smart-contract-audit",
  "spec": { "language": "solidity", "lines": 500 },
  "anchor_price": "35.00",
  "currency": "USDC",
  "deadline": "2026-03-14T12:00:30Z",
  "signature": "ed25519:<base64>",
  "budget_commitment": "poseidon:<64-hex-chars>"
}
```

Key rules:
- `protocol` MUST be `"ghost-bazaar-v4"` — reject unknown versions
- `anchor_price` is a decimal string, MUST be positive
- `budget_commitment` format: `poseidon:` + 64 lowercase hex chars
- `deadline` must be in the future at creation time
- Prices are always decimal strings, never JSON numbers

### Seller Offer

```json
{
  "offer_id": "uuid-v4",
  "rfq_id": "...",
  "seller": "did:key:z6Mk...",
  "price": "38.00",
  "currency": "USDC",
  "valid_until": "2026-03-14T12:00:25Z",
  "signature": "ed25519:<base64>"
}
```

- `currency` MUST match the RFQ's `currency`
- `valid_until` must be in the future

### Counter-Offer

```json
{
  "counter_id": "uuid-v4",
  "rfq_id": "...",
  "round": 1,
  "from": "did:key:z6Mk... (buyer)",
  "to": "did:key:z6Mk... (target seller)",
  "price": "36.00",
  "currency": "USDC",
  "valid_until": "...",
  "signature": "ed25519:<base64>",
  "budget_proof": { "protocol": "groth16", "curve": "bn128", ... }
}
```

- `from` MUST equal `rfq.buyer` — engine verifies this (422 `unauthorized_counter`)
- `to` MUST reference a seller who has submitted an offer
- `round` MUST be monotonically increasing per RFQ
- `budget_proof` required if RFQ has `budget_commitment`, rejected if not

### Signed Quote

```json
{
  "quote_id": "uuid-v4",
  "rfq_id": "...",
  "buyer": "did:key:z6Mk...",
  "seller": "did:key:z6Mk...",
  "service_type": "ghost-bazaar:services:smart-contract-audit",
  "final_price": "36.50",
  "currency": "USDC",
  "payment_endpoint": "https://seller.example/execute",
  "expires_at": "2026-03-14T12:01:00Z",
  "nonce": "0x000102...1e1f",
  "memo_policy": "quote_id_required",
  "buyer_signature": "ed25519:<base64>",
  "seller_signature": "ed25519:<base64>",
  "spec_hash": "sha256:<64-hex>"
}
```

- `nonce`: 32 random bytes, lowercase hex, `0x` prefix. Uppercase hex MUST be rejected.
- `memo_policy` defaults to `"quote_id_required"` (not `"optional"`)
- `spec_hash`: `sha256:` + hex of SHA-256 of canonical JSON of the RFQ spec

## Signing Profile

All signing uses Ed25519 with Solana wallet keypairs.

**Canonical JSON:**
- Keys sorted recursively by Unicode codepoint
- No whitespace outside strings
- Prices as decimal strings
- Empty `extensions` omitted entirely (not sent as `{}`)

**Signing inputs (v4 §6):**
- RFQ: canonical JSON with `signature: ""`
- Seller Offer: canonical JSON with `signature: ""`
- Counter-Offer: canonical JSON with `signature: ""`
- Signed Quote: canonical JSON with `buyer_signature: ""` and `seller_signature: ""`

Both buyer and seller sign the same quote payload bytes.

**Signature format:** `ed25519:` + base64 (RFC 4648 §4, standard alphabet with `=` padding)

**DID derivation:** `did:key:z` + base58btc(`0xed 0x01` + 32-byte Ed25519 pubkey)

## Amount Normalization

**Single canonical function:** `normalizeAmount(decimalStr, mintAddress) → bigint`

Uses integer arithmetic on the decimal string — never `parseFloat()`.

USDC mints (6 decimals):
- Mainnet: `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`
- Devnet: `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`

Example: `normalizeAmount("36.50", devnetMint) → 36_500_000n`

## State Machine

```
OPEN → NEGOTIATING → COMMIT_PENDING → COMMITTED
                  ↗ (seller declines)
COMMIT_PENDING → NEGOTIATING (seller declines quote)
OPEN | NEGOTIATING → CANCELLED (buyer only)
OPEN | NEGOTIATING | COMMIT_PENDING → EXPIRED (deadline)
```

- `OPEN → NEGOTIATING`: triggered by first offer
- `COMMIT_PENDING → CANCELLED`: NOT allowed (once in COMMIT_PENDING, cancellation is blocked)
- `COMMITTED`, `EXPIRED`, `CANCELLED`: terminal states

## ZK Budget Range Proof

### Commitment

```
budget_commitment = Poseidon([budget_hard_scaled, salt])
                  = "poseidon:<64-hex>"
```

- `budget_hard_scaled = normalizeAmount(budget_hard, usdc_mint)`
- `salt`: random 254-bit field element, generated once per session

### Circuit: BudgetRangeProof.circom

- Public inputs: `counter_price_scaled`, `budget_commitment`
- Private inputs: `budget_hard_scaled`, `commitment_salt`
- Constraint 1: `Poseidon([budget_hard_scaled, salt]) == budget_commitment`
- Constraint 2: `counter_price_scaled <= budget_hard_scaled` (64-bit LessEqThan)
- ~300 R1CS constraints, ~200ms proof generation

### Proof format on CounterOffer

```json
{
  "protocol": "groth16",
  "curve": "bn128",
  "counter_price_scaled": "36500000",
  "pi_a": [...],
  "pi_b": [...],
  "pi_c": [...]
}
```

`counter_price_scaled` MUST equal `normalizeAmount(counter.price, usdc_mint).toString()`.

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
- Buyer: `action.price` clamped to `budget_hard` ceiling
- Seller: `action.price` clamped to `floor_price` floor

### Rule-Based Strategies

| Strategy | Behavior |
|----------|----------|
| `LinearConcessionBuyer` | Moves anchor → budget_soft linearly over rounds |
| `TimeWeightedBuyer` | Accelerates concession near deadline |
| `CompetitiveBuyer` | Exploits multi-seller competition, concedes less with more sellers |
| `FirmSeller` | 5% of range per round, holds near target |
| `FlexibleSeller` | 25% of range per round, concedes fast |
| `CompetitiveSeller` | Concedes 1.5x faster when `competing_sellers >= 2` |

### LLM Strategies

`LLMBuyerStrategy` and `LLMSellerStrategy` use the Claude API. Private state is injected as system prompt constraints, never as structured JSON fields. The sanitizer caps output; the ZK proof enforces cryptographically.

## Engine API

```
GET  /listings              — list active seller listings (+ optional 8004 registry data)
GET  /listings/:id          — single listing (+ optional 8004 registry data)
POST /rfqs                  — buyer broadcasts RFQ (9-step verification)
POST /rfqs/:id/offers       — seller submits offer (10-step verification)
POST /rfqs/:id/counter      — buyer sends counter (12-step verification + ZK)
POST /rfqs/:id/accept       — buyer selects winner (7-step verification)
PUT  /rfqs/:id/quote/sign   — buyer signs unsigned quote
GET  /rfqs/:id/quote        — seller retrieves buyer-signed quote
PUT  /rfqs/:id/cosign       — seller co-signs quote
GET  /rfqs/:id/events       — append-only event stream (?after= cursor)
```

### Counter-Offer 12-Step Verification

1. Parse and validate CounterOffer schema
2. Retrieve RFQ
3. Verify `price` is valid positive decimal → 422 `invalid_amount`
4. Verify `currency === rfq.currency` → 422 `currency_mismatch`
5. Verify `valid_until` is in future → 422 `invalid_expiry`
6. Verify `from === rfq.buyer` → 422 `unauthorized_counter`; verify `to` has submitted an offer → 422 `unauthorized_counter`
7. ZK proof verification (if `budget_commitment` present): price scaled match, Groth16 verify
8. Validate buyer Ed25519 signature → 401 `invalid_buyer_signature`
9. Check state is `NEGOTIATING` → 409 `invalid_state_transition`
10. Validate `round` is monotonically increasing → 422 `invalid_round`
11. Append event to log
12. Return 201

## Settlement: 17-Step Validation

The `POST /execute` endpoint runs on the seller's server (separate from the engine).

See the full step-by-step in GHOST BAZAAR-SPEC-v4, Section 9, or the implementation at `packages/settlement/src/execute.ts`.

### Error Codes (Settlement)

| Code | Step |
|------|------|
| `invalid_payment_signature` | 4 |
| `transaction_not_found` | 5 |
| `transaction_failed` | 6 |
| `transaction_not_confirmed` | 6 |
| `transfer_destination_mismatch` | 8 |
| `transfer_mint_mismatch` | 9 |
| `price_mismatch` | 10 |
| `memo_missing` | 11-12 |
| `memo_mismatch` | 11-12 |
| `invalid_nonce_format` | 13 |
| `nonce_replayed` | 14 |
| `quote_expired` | 15 |
| `execution_failed` | 16 |

## MCP Server

The MCP server exposes Ghost Bazaar to any MCP-compatible agent (Claude Desktop, Claude SDK).

**Transports:** stdio (primary, Claude Desktop) and HTTP/SSE (secondary, remote agents). Selected via startup flag.

**Privacy:** `budget_hard` is accepted as tool input but stored only in `BuyerPrivate`. MUST NOT appear in any MCP tool output, event log, or error message.

**Configuration:**

```
SOLANA_KEYPAIR        — base58-encoded 64-byte secret key (preferred)
SOLANA_KEYPAIR_PATH   — path to JSON keypair file (fallback)
SOLANA_RPC_URL        — RPC endpoint (default: devnet)
NEGOTIATION_ENGINE_URL — base URL of running engine
ANTHROPIC_API_KEY     — required only for LLM strategies
USDC_MINT             — mint address (devnet test USDC)
```

## Solana Integration Points

| Integration | Mechanism |
|-------------|-----------|
| Agent identity | Solana keypair → `did:key` derivation |
| **Agent Registry** | **8004-Solana: Metaplex Core NFT + IPFS registration file (ERC-8004)** |
| **Reputation** | **ATOM engine: on-chain scored feedback post-settlement** |
| USDC transfer | SPL token transfer instruction |
| Memo binding | Memo program instruction, contains `GhostBazaar:quote_id:<uuid>` |
| Nonce replay | MVP: in-memory `Set<string>`; week-2: PDA via Anchor |
| Deal receipt | MVP: signed JSON in 200; week-2: PDA via Anchor |
| Transaction verification | `getTransaction` RPC, commitment: `"confirmed"` |
| Token account | Associated token account derived from seller pubkey + USDC mint |

## Testing Checklist

### Protocol Core
- RFQ/Offer/Quote signature pass/fail vectors
- Canonical JSON determinism (same payload → same bytes)
- Tamper evidence (single-field mutation invalidates signatures)
- `normalizeAmount` edge cases: `"0.1"`, `"28.50"`, `"1000000.00"`
- Nonce format: lowercase hex pass, uppercase fail, missing `0x` fail
- Empty `extensions` omitted from canonical JSON
- Extension fields included in signing

### ZK
- `generateBudgetCommitment → verifyBudgetProof` round-trip
- Proof with wrong `counter_price_scaled` → verification fails
- Proof at exactly `budget_hard` ceiling → passes
- Proof above `budget_hard` ceiling → fails

### Engine
- State transition matrix (all valid + forbidden transitions)
- Counter authorization: `counter.from !== rfq.buyer` → 422
- Counter round monotonicity enforcement
- ZK proof blocks invalid proofs before event log
- Quote construction: accept → sign → cosign → COMMITTED
- Deadline expiry → EXPIRED

### Settlement
- Valid quote + confirmed tx → 200, service executes, nonce consumed
- Each error code triggered by the appropriate failure condition
- Nonce replay after first success → rejected
- Memo missing when `memo_policy: "quote_id_required"` → rejected
- Memo not checked when `memo_policy: "optional"` → 200

### Agent Registry (8004-Solana)
- Program ID constants are valid Solana public keys
- `createRegistrySDK` creates writable SDK with Pinata JWT
- `createReadOnlySDK` creates read-only SDK without signer
- `did:key` derivation is consistent across keypairs
- Metadata keys use consistent `ghost-bazaar:` prefix
- `registerAgent` throws when `agentId`/`asset` is missing from result
- `recordDealFeedback` throws when `feedbackUri` provided without `feedbackContentHash`
- `discoverAgent` returns `null` for non-existent agent
- `discoverAgentsByOwner` filters revoked feedbacks from score computation
- Reputation score is `null` when `totalFeedbacks === 0`

### Demo
- Privacy score computes 5/6 (83%) with ZK budget proof, 4/6 (67%) without
- Split-view renders seller's redacted view vs buyer's full truth
- Comparison table shows Ghost Bazaar 83% vs competitors 0%

## 8004 Agent Registry (ERC-8004 on Solana)

Ghost Bazaar integrates with the [Solana Agent Registry](https://solana.com/agent-registry) — the Solana-native implementation of [ERC-8004: Trustless Agents](https://eips.ethereum.org/EIPS/eip-8004). This adds on-chain discoverable identity and portable reputation to Ghost Bazaar agents.

**Package:** `@ghost-bazaar/agents` — `packages/agents/src/registry.ts`
**SDK:** [`8004-solana`](https://www.npmjs.com/package/8004-solana)

### Identity Bridge

The same Solana keypair powers both Ghost Bazaar identity (`did:key:z6Mk...`) and the 8004 Agent Registry (Metaplex Core NFT owned by the keypair). The `ghost-bazaar:did` metadata key is stored on-chain during registration, linking the NFT to the Ghost Bazaar `did:key`. No key translation is needed.

### Three Registries

| Registry | Ghost Bazaar Usage |
|----------|---------------|
| **Identity** | Agent NFT with IPFS registration file containing negotiation/payment endpoints, skills, domains |
| **Reputation** | ATOM engine records scored feedback after each successful settlement |
| **Validation** | (Week-2) Records 17-step settlement verification results as on-chain validation proofs |

### Integration Points

1. **Registration** — Agent startup optionally calls `registerAgent()` to mint an 8004 NFT
2. **Discovery** — `GET /listings` augments responses with reputation scores via `discoverAgent()`
3. **Post-Settlement Feedback** — After step 17, both parties call `recordDealFeedback()`
4. **Strategy Signal** — Reputation scores are injected into LLM strategy context

### Key Functions (`@ghost-bazaar/agents`)

```typescript
registerAgent(config, opts)              // Mint NFT + upload registration file to IPFS
discoverAgent(agentId, rpcUrl?, cluster?)          // Load agent metadata + reputation by ID
discoverAgentsByOwner(owner, rpcUrl?, cluster?)    // Find all agents for a pubkey
recordDealFeedback(config, agentId, fb)  // Post scored feedback to ATOM engine
getAgentMetadata(agentId, key, rpcUrl?, cluster?)  // Read on-chain metadata
setAgentMetadata(config, agentId, k, v)  // Write on-chain metadata
createRegistrySDK(config)               // Create SDK + IPFS client
createReadOnlySDK(rpcUrl?, cluster?)     // Read-only SDK (no signer)
```

### Exported Constants (`@ghost-bazaar/agents`)

| Constant | Value | Purpose |
|----------|-------|---------|
| `FEEDBACK_SCORE_SUCCESS` | `100` | Default score for successful settlement |
| `FEEDBACK_SCORE_FAILURE` | `0` | Default score for failed settlement |
| `FEEDBACK_TAG_CATEGORY` | `"settlement"` | ATOM `tag1` for Ghost Bazaar feedback |
| `FEEDBACK_TAG_SOURCE` | `"ghost-bazaar"` | ATOM `tag2` for Ghost Bazaar feedback |
| `DEFAULT_SKILLS` | `["commerce/negotiation/price_negotiation"]` | Default OASF skills (overridable) |
| `DEFAULT_DOMAINS` | `["finance/payments/autonomous_settlement"]` | Default OASF domains (overridable) |
| `METADATA_KEY_SERVICE_TYPE` | `"ghost-bazaar:service_type"` | On-chain metadata key |
| `METADATA_KEY_NEGOTIATION_PROFILE` | `"ghost-bazaar:negotiation_profile"` | On-chain metadata key |
| `METADATA_KEY_DID` | `"ghost-bazaar:did"` | On-chain metadata key linking NFT to `did:key` |

---

## Duty Split

| Duty | Owner | Packages |
|------|-------|----------|
| 1: Protocol Core + Strategy + ZK | P1 (ZK researcher) | `core`, `strategy`, `zk` |
| 2: Negotiation Engine + Demo UI | P3 (engine builder) | `engine`, `demo/` |
| 3: Settlement + Agent Runtime + MCP + Registry | P2 (engineer) | `settlement`, `agents`, `mcp` |

Critical path: P1 must export a working `verifyBudgetProof` by end of day 3 so P3 can integrate ZK verification in the `/counter` route on day 4.
