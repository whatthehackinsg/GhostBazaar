# Duty 3: Settlement + Agent Runtime + MCP Server (P2 — Engineer)

## Mission

Deliver Ghost Bazaar phase 4 (Settlement), the agent runtime that orchestrates buyer/seller agents, and the MCP server that exposes Ghost Bazaar to any MCP-compatible agent.

**Owner:** P2 (engineer)
**Packages:** `packages/settlement`, `packages/agents`, `packages/mcp`
**Spec baseline:** GHOST-BAZAAR-SPEC-v4.md (Sections 9, 12)

---

## Product Scope

In scope:

- `POST /execute` settlement endpoint (runs on seller's server)
- Solana payment verification (17-step validation)
- Nonce consumption (MVP: in-memory `Set<string>` keyed by `quote_id`)
- Nonce consumption (week-2: PDA via Anchor program, seed `"ghost_bazaar_nonce"`)
- Deal receipt (MVP: signed JSON in 200 response + `quote_id` in Memo)
- Deal receipt (week-2: PDA via Anchor program)
- Agent runtime: `BuyerAgent`, `SellerAgent`, event polling
- MCP server: buyer + seller tools, stdio + HTTP/SSE transport
- Settlement timer: `committed_at → confirmed_at` delta
- **8004 Agent Registry integration:** agent registration, post-settlement reputation feedback, validation proof recording (via `@ghost-bazaar/agents`)

Out of scope:

- Negotiation strategy internals (Duty 1)
- Negotiation engine HTTP routes (Duty 2)
- ZK proof generation (Duty 1 — Agent Runtime calls it but doesn't own it)
- Quote-signing primitive implementation (Duty 1)
- Dispute/arbitration workflows

---

## Settlement Contract

### 17-Step Validation Order (normative, v4 §9)

```
1.  Decode X-Ghost-Bazaar-Quote header (base64 → canonical JSON)
2.  Verify buyer Ed25519 signature
3.  Verify seller Ed25519 signature
4.  Base58-decode Payment-Signature header
5.  getTransaction(sig, {commitment:"confirmed"}) via RPC
6.  Confirm tx status is confirmed or finalized
7.  Extract SPL token transfer instruction
8.  Verify transfer destination matches quote.seller pubkey
9.  Verify token mint matches USDC mint for declared network
10. Verify transfer amount == normalizeAmount(final_price, usdc_mint)
11. If memo_policy is "quote_id_required": verify Memo contains quote_id → memo_missing / memo_mismatch
12. If memo_policy is "hash_required": verify Memo contains sha256(canonical_quote) → memo_missing / memo_mismatch
    (When memo_policy is "optional", steps 11-12 are skipped entirely)
13. Verify nonce format: 32 bytes, lowercase hex, 0x prefix → invalid_nonce_format
14. Check nonce is not consumed → nonce_replayed
    MVP: in-memory Set<string> keyed by quote_id
    Week-2: derive PDA ["ghost_bazaar_nonce", quote_id_bytes], verify account does NOT exist
15. Verify quote.expires_at is in the future
16. Execute service
17. Persist nonce to consumed set atomically with execution
    MVP: in-memory Set<string> on seller process
    Week-2: PDA nonce account via custom Anchor program
```

`memo_policy` defaults to `"quote_id_required"` (breaking change from earlier specs where default was `"optional"`).

### Request Requirements

- HTTP over TLS
- `Payment-Signature` header: base58-encoded Solana transaction signature
- `X-Ghost-Bazaar-Quote` header: base64-encoded canonical JSON of the Signed Quote

### Response (200)

```json
{
  "receipt": {
    "quote_id": "...",
    "final_price": "36.50",
    "buyer_pubkey": "...",
    "seller_pubkey": "...",
    "settled_at": "..."
  },
  "explorer_tx": "https://explorer.solana.com/tx/...",
  "settlement_ms": 412
}
```

---

## Nonce Consumption

### MVP (in-memory)

```typescript
const consumedNonces = new Set<string>()

function isNonceConsumed(quote_id: string): boolean {
  return consumedNonces.has(quote_id)
}

function consumeNonce(quote_id: string): void {
  consumedNonces.add(quote_id)
}
```

Checked at step 14, persisted at step 17.

### Week-2 (Anchor PDA)

```typescript
const [noncePda] = PublicKey.findProgramAddressSync(
  [Buffer.from("ghost_bazaar_nonce"), Buffer.from(quote_id_bytes)],
  GHOST_BAZAAR_PROGRAM_ID   // custom Anchor program, NOT SystemProgram
)
```

System Program CANNOT create accounts at arbitrary PDAs — a custom program that owns the PDA is required.

---

## Agent Runtime

### BuyerAgent

- Solana keypair = identity
- `BuyerPrivate` (never on wire): `budget_soft`, `budget_hard`
- `commitment_salt`: random 254-bit field element, kept local for session lifetime
- Polls `/rfqs/:id/events` every 500ms with `?after=` cursor
- Calls `strategy.onOffersReceived()` → `BuyerAction`
- Runs privacy sanitizer (Duty 1) → safe action
- Calls `zk.generateBudgetProof()` (Duty 1) before every counter POST
- Fires HTTP protocol actions (POST /counter, POST /accept, PUT /quote/sign)
- Records `negotiation_committed_at` for settlement timer

### SellerAgent

- Solana keypair = identity
- `SellerPrivate` (never on wire): `floor_price`, `target_price`
- Polls `/listings` and event log
- Calls `strategy.onRfqReceived()`, `strategy.onCounterReceived()`
- Runs privacy sanitizer (Duty 1) → safe action
- Fires HTTP protocol actions (POST /offers, GET /quote, PUT /cosign, POST /decline)
- Records `settled_at` on execution

### Proof Generation Sequence (BuyerAgent)

```
1. strategy.onOffersReceived(ctx) → BuyerAction {type:"counter", price}
2. sanitizeBuyerAction(action, priv) → safe_action       // price ≤ budget_hard
3. Deadline guard: if time_remaining_ms < 500, skip counter
4. zk.generateBudgetProof(safe_action.price, priv.budget_hard, session.salt)
   → BudgetProof                                         // ~200ms
5. Build CounterOffer object with budget_proof attached
6. Sign CounterOffer with buyer Ed25519 keypair
7. POST /rfqs/:id/counter
```

---

## MCP Server

### Transport

- Primary: stdio (Claude Code CLI)
- Secondary: HTTP/SSE (Claude SDK, remote agents)
- Both from same server; transport is a startup flag

### Tool Catalog

**Buyer tools:**

| Tool | Input | Output | Notes |
|------|-------|--------|-------|
| `ghost_bazaar_browse_listings` | `{category?}` | `Listing[]` | GET /listings |
| `ghost_bazaar_post_rfq` | `{service_type, spec, anchor_price, budget_soft, budget_hard, deadline_seconds}` | `{rfq_id}` | Generates commitment, signs RFQ |
| `ghost_bazaar_get_offers` | `{rfq_id}` | `SellerOffer[]` | Polls event log |
| `ghost_bazaar_counter` | `{rfq_id, seller_did, price}` | `{counter_id}` | ZK proof + sanitizer automatic |
| `ghost_bazaar_accept` | `{rfq_id, seller_did, offer_id}` | `{quote}` | Triggers COMMIT_PENDING |
| `ghost_bazaar_settle` | `{quote}` | `{tx_sig, explorer_url, settlement_ms}` | Builds + sends Solana tx |

**Seller tools:**

| Tool | Input | Output | Notes |
|------|-------|--------|-------|
| `ghost_bazaar_register_listing` | `{title, category, base_terms, negotiation_profile}` | `{listing_id}` | Signs listing |
| `ghost_bazaar_get_rfqs` | `{category?}` | `RFQ[]` | Finds open RFQs |
| `ghost_bazaar_respond_offer` | `{rfq_id, price}` | `{offer_id}` | Signs with agent keypair |
| `ghost_bazaar_respond_counter` | `{rfq_id, counter_id, price}` | `{offer_id}` | Sanitizer before POST |
| `ghost_bazaar_check_events` | `{rfq_id}` | `NegotiationEvent[]` | Full event log |

**Privacy:** `budget_hard` accepted as tool input but stored only in `BuyerPrivate`. MUST NOT appear in any MCP tool output, event log, or error message.

### Configuration

```
SOLANA_KEYPAIR      — base58-encoded 64-byte secret key (preferred)
SOLANA_KEYPAIR_PATH — path to JSON keypair file (fallback)
SOLANA_RPC_URL      — RPC endpoint
NEGOTIATION_ENGINE_URL — base URL of running engine
ANTHROPIC_API_KEY   — required only for LLM strategies
USDC_MINT           — mint address (devnet test USDC)
```

---

## 8004 Agent Registry Integration (8004-Solana)

Ghost Bazaar agents register in the [Solana Agent Registry](https://solana.com/agent-registry) to gain on-chain discoverable identity, portable reputation, and cross-protocol trust. The registry is the Solana implementation of [8004: Trustless Agents](https://eips.ethereum.org/EIPS/eip-8004), developed by [Quantu Labs](https://github.com/QuantuLabs/8004-solana-ts). (Note: "8004" originates as an Ethereum EIP but the Ghost Bazaar integration uses the Solana port via the `8004-solana` SDK.)

**Package:** `@ghost-bazaar/agents` — `packages/agents/src/registry.ts`
**SDK:** [`8004-solana`](https://www.npmjs.com/package/8004-solana)

### Identity Bridge: `did:key` ↔ Agent NFT

Ghost Bazaar's `did:key:z6Mk...` identity derives directly from Ed25519 public keys — the same keys used as Solana keypairs. The 8004 Agent Registry mints a Metaplex Core NFT per agent, owned by the same keypair. The `ghost-bazaar:did` metadata key is stored on-chain during registration, linking the NFT back to the Ghost Bazaar identity. No key translation is needed:

```
Solana Keypair → PublicKey → did:key:z6Mk... (Ghost Bazaar identity)
                           → Agent NFT asset  (8004 on-chain identity)
```

### Registration (Agent Startup)

When a `BuyerAgent` or `SellerAgent` starts, it optionally registers in the Agent Registry:

```typescript
import { registerAgent } from "@ghost-bazaar/agents"

const registered = await registerAgent(
  { signer: agentKeypair, pinataJwt: process.env.PINATA_JWT },
  {
    name: "Ghost Bazaar Seller — Smart Contract Auditor",
    description: "Autonomous seller agent for Solidity audit services",
    negotiationEndpoint: "https://seller.example/negotiate",
    paymentEndpoint: "https://seller.example/execute",
    serviceType: "ghost-bazaar:services:smart-contract-audit",
    negotiationProfile: "competitive",
  },
)
// registered.agentId → on-chain agent ID (bigint)
// registered.asset   → on-chain NFT public key
// registered.did     → "did:key:z6Mk..."
// registered.registryUri → "ipfs://Qm..."
```

### Post-Settlement Reputation Feedback

After the 17-step settlement verification completes successfully (step 17), both buyer and seller submit feedback to the ATOM reputation engine:

```typescript
import { recordDealFeedback } from "@ghost-bazaar/agents"

await recordDealFeedback(
  { signer: buyerKeypair, pinataJwt: process.env.PINATA_JWT },
  sellerAgentId,  // bigint from registration
  { success: true, settledAmount: "36.50" },
)
```

This creates an on-chain, Sybil-resistant feedback record tied to both agent identities. Future counterparties can query the score via `discoverAgent()`.

### Validation Proof Recording (Week-2)

The 8004 Validation Registry provides generic hooks for recording independent verification. After settlement, the 17-step verification result can be posted as a validation proof, creating an on-chain audit trail of successful Ghost Bazaar settlements.

### Program IDs

| Network | Agent Registry | ATOM Engine |
|---------|---------------|-------------|
| Mainnet | `8oo4dC4JvBLwy5tGgiH3WwK4B9PWxL9Z4XjA2jzkQMbQ` | `AToMw53aiPQ8j7iHVb4fGt6nzUNxUhcPc3tbPBZuzVVb` |
| Devnet  | `6MuHv4dY4p9E4hSCEPr9dgbCSpMhq8x1vrUexbMVjfw1` | `6Mu7qj6tRDrqchxJJPjr9V1H2XQjCerVKixFEEMwC1Tf` |

### Environment Variables (Additional)

```
PINATA_JWT              — Pinata JWT for IPFS uploads (registration metadata)
AGENT_REGISTRY_RPC_URL  — Custom RPC URL for registry operations (default: public devnet)
```

**Note:** The `8004-solana` SDK v0.3.0 only supports `"devnet"` as a cluster. Mainnet support is pending an SDK update. For advanced queries (e.g., `discoverAgentsByOwner`), a non-default RPC is required since public devnet does not support `getProgramAccounts` with `memcmp`.

---

## Solana Integration Points

| Integration | Mechanism |
|-------------|-----------|
| Agent identity | Solana keypair → `did:key` derivation (Duty 1) |
| **Agent Registry** | **8004-Solana: Metaplex Core NFT + IPFS registration file** |
| **Reputation** | **ATOM engine: on-chain scored feedback post-settlement** |
| USDC transfer | SPL token transfer instruction |
| Memo binding | Memo program instruction, contains `GhostBazaar:quote_id:<uuid>` |
| Nonce replay | MVP: in-memory `Set<string>`; week-2: PDA via Anchor |
| Deal receipt | MVP: signed JSON in 200; week-2: PDA via Anchor |
| Transaction verification | `getTransaction` RPC, commitment: `"confirmed"` |
| Settlement timer | `Date.now()` delta, `committed_at → confirmed_at` |

USDC mint addresses:

- Mainnet: `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` (6 decimals)
- Devnet: `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` (6 decimals)

---

## Error Codes (Duty 3 owns)

- `invalid_payment_signature` — `Payment-Signature` header not valid base58 (400)
- `malformed_quote_header` — `X-Ghost-Bazaar-Quote` header missing or not valid base64 (400)
- `transaction_not_found` — Solana RPC returned null (404)
- `transaction_failed` — transaction status is not success (422)
- `transaction_not_confirmed` — transaction not yet confirmed (422)
- `transfer_instruction_missing` — no SPL token transfer instruction in transaction (422)
- `transfer_destination_mismatch` — transfer recipient ≠ quote.seller (422)
- `transfer_mint_mismatch` — token mint ≠ USDC mint (422)
- `price_mismatch` — transfer amount ≠ `normalizeAmount(final_price, usdc_mint)` (422)
- `memo_missing` — Memo required but not present (422)
- `memo_mismatch` — Memo content doesn't match expected value (422)
- `nonce_replayed` — nonce already consumed (409)
- `invalid_nonce_format` — quote nonce is not `0x` + 64 lowercase hex chars (422)
- `expired_quote` — `expires_at` is in the past (422)
- `execution_failed` — service execution failed after all validation passed (500)

Quote signature errors (delegated from Duty 1 library):

- `invalid_buyer_signature` — buyer signature on quote fails verification (401)
- `invalid_seller_signature` — seller signature on quote fails verification (401)

---

## Acceptance Criteria

1. Any tampered quote is rejected before business execution.
2. Any amount mismatch is rejected.
3. Any replayed nonce is rejected after first success.
4. Successful settlement always consumes nonce exactly once.
5. MCP tools work end-to-end via stdio with Claude Code.
6. Settlement timer reports accurate `settlement_ms`.
7. Agent can register in 8004 Agent Registry and be discoverable by `agentId`.
8. Post-settlement reputation feedback is recorded on-chain via ATOM engine.

---

## Duty 3 Test Checklist

Settlement (MVP):

- Valid quote + confirmed Solana tx → `200`, service executes, nonce consumed
- `X-Ghost-Bazaar-Quote` header missing or malformed → `400 malformed_quote_header`
- Invalid buyer signature → `401 invalid_buyer_signature`
- Invalid seller signature → `401 invalid_seller_signature`
- `Payment-Signature` header not valid base58 → `400 invalid_payment_signature`
- Transaction not found on-chain → `404 transaction_not_found`
- Transaction not confirmed → `422 transaction_not_confirmed`
- Transaction failed → `422 transaction_failed`
- No SPL transfer instruction in transaction → `422 transfer_instruction_missing`
- Transfer destination mismatch → `422 transfer_destination_mismatch`
- Transfer mint mismatch (not USDC) → `422 transfer_mint_mismatch`
- Price mismatch → `422 price_mismatch`
- Memo missing when `memo_policy: "quote_id_required"` → `422 memo_missing`
- Memo hash mismatch when `memo_policy: "hash_required"` → `422 memo_mismatch`
- Memo not checked when `memo_policy: "optional"` → `200`
- Invalid nonce format → `422 invalid_nonce_format`
- Nonce replay (already consumed) → `409 nonce_replayed`
- Expired quote → `422 expired_quote`
- Service execution fails after all validation passes → `500 execution_failed`

Settlement (Week-2 — Anchor PDA):

- Deal receipt PDA created with correct fields after successful settlement
- Deal receipt PDA data matches quote fields (quote_id, buyer, seller, final_price)
- Nonce PDA prevents replay (account exists check)

Agent Runtime:

- BuyerAgent sends ZK proof on counter automatically
- SellerAgent cosigns quote end-to-end
- Event polling with `?after=` cursor works correctly

MCP:

- `ghost_bazaar_post_rfq` generates commitment internally
- `ghost_bazaar_counter` generates ZK proof transparently
- `budget_hard` never appears in tool output
- stdio transport works with Claude Code
- HTTP/SSE transport works with Claude SDK

Agent Registry (8004-Solana):

- `registerAgent()` mints NFT with metadata on devnet
- `discoverAgent()` resolves agent metadata and reputation score
- `recordDealFeedback()` posts scored feedback after successful settlement
- Agent with no registry entry → graceful fallback (no error)
- `did:key` ↔ agent NFT identity bridge round-trips correctly

---

## Timeline (from Design Spec)

| Day | Tasks |
|-----|-------|
| 1-2 | settlement: solana-verify, SPL amount check |
| 3 | settlement: pda-nonce (existence-only), timer, signed JSON receipt |
| 4 | agents: BuyerAgent, SellerAgent, poll loop |
| 5 | agents: BuyerAgent sends ZK proof on counter; end-to-end test on devnet |
| 6 | mcp: server scaffold, buyer tools (ZK transparent in ghost_bazaar_counter) |
| 7 | mcp: seller tools, stdio transport |
| 8 | **Integration day** — all layers connected, full flow on devnet |
| 9 | mcp: HTTP/SSE transport, Claude Code test |
| 10-14 | buffer, hardening, demo rehearsal |

## Day 0 Pre-work (P2 owns)

- Generate 4 devnet keypairs (1 buyer, 3 sellers): `solana-keygen new`
- Airdrop SOL: `solana airdrop 2 <pubkey> --url devnet`
- Create a test USDC mint with 6 decimals: `spl-token create-token --decimals 6 --url devnet` (save the mint address)
- Set `USDC_MINT` env var to the new mint address (overrides the default in Solana Integration Points)
- Create token accounts: `spl-token create-account <USDC_MINT> --url devnet --owner <buyer_pubkey>`
- Fund buyer with test USDC: `spl-token mint <USDC_MINT> 1000 <buyer_token_account> --url devnet`
- Set up `.env` file with all required environment variables
