# Ghost Bazaar: Autonomous Negotiation for Agent-to-Agent Commerce on Solana

**Draft v0.1 | March 2026**

---

## Abstract

Autonomous AI agents are beginning to transact with each other: buying compute, selling inference, trading data. Payment rails like x402 give agents a clean way to pay over HTTP. But they assume the price is already known. In practice, price is the hardest part.

Ghost Bazaar is a protocol that adds structured, multi-party price negotiation before settlement. A buyer agent broadcasts a request for quotes to competing sellers, runs game-theoretic bidding rounds to drive prices toward a hidden budget target, and locks the final price with a dual-signed Ed25519 commitment. Settlement flows through Solana SPL USDC transfer, with a 17-step settlement verification process.

The protocol includes an optional zero-knowledge budget proof: the buyer publishes a Poseidon commitment to their budget ceiling in the RFQ, and every counter-offer carries a Groth16 proof that the proposed price does not exceed the ceiling. Sellers can verify the proof without learning the budget.

The result: agents can discover fair prices across multiple sellers without revealing their true budgets, prove budget sufficiency cryptographically, and settle on-chain with non-repudiation. No trusted broker required.

---

## 1. Problem Statement

### Payment Rails Solve Payment, Not Pricing

Payment protocols like x402 provide HTTP-native payment using blockchain settlement. An agent encounters a payment-required response, authorizes payment, and the transaction settles on-chain. This works when the price is fixed and known upfront.

But real agent commerce rarely has fixed prices:

- **Multiple sellers offer the same service.** Five inference providers can serve the same model. Which one should a buyer pick, and at what price?
- **Budgets are private.** A buyer agent operating on behalf of a user has a spending ceiling it must protect. Revealing that ceiling invites price discrimination.
- **Markets move.** Compute costs fluctuate. A price that was fair ten minutes ago may not be fair now.
- **No one mediates.** There's no marketplace sitting between agents. They need to negotiate directly.

### Why Existing Approaches Fall Short

Several protocols have emerged for agent commerce, but none combine multi-party negotiation with budget privacy and on-chain settlement:

- **Virtuals Protocol ACP** runs negotiation and settlement entirely on-chain, which provides transparency but sacrifices buyer privacy. It does not clearly support competitive multi-seller bidding.
- **OpenAI/Stripe ACP** connects agents to merchants with fixed catalog prices. There's no price negotiation at all.
- **Google UCP** allows agents to propose prices to a single merchant, who accepts or rejects. Single-seller, single-round, no competition.

Microsoft Research's Magentic Marketplace project demonstrated that letting LLMs negotiate in free text produces poor outcomes: models exhibit severe first-proposal bias, and response speed dominates quality by 10-30x. Structured negotiation protocols aren't optional. They're necessary.

---

## 2. Design Goals and Non-Goals

### Goals

1. **Multi-seller competition.** A buyer solicits and compares offers from multiple sellers simultaneously.
2. **Budget privacy.** A buyer's true spending ceiling must never be exposed to sellers through the protocol.
3. **ZK budget proof.** Optional cryptographic proof that the buyer's counter-offer is within their budget, without revealing the budget itself.
4. **Cryptographic commitment.** Once buyer and seller agree on a price, neither party can alter it. The agreement is dual-signed with Ed25519 and verifiable.
5. **Solana-native settlement.** Settlement uses Solana SPL token transfer with seller-side verification via RPC. Agent identity derives from Solana wallet keypairs.
6. **Time-bounded negotiation.** Every negotiation has a hard deadline. No indefinite haggling.
7. **Agent-native.** The protocol is designed for software agents, not humans. Round-trip times are seconds, not days.

### Non-Goals

- ~~**Reputation or identity systems.**~~ Now addressed via [Solana Agent Registry (ERC-8004)](https://solana.com/agent-registry) integration. Agents register as on-chain NFTs with the 8004 identity registry; post-settlement feedback is recorded in the ATOM reputation engine. See `packages/agents/src/registry.ts`.
- ~~**Service discovery.**~~ Now partially addressed. The negotiation engine's `GET /listings` endpoint augments seller listings with 8004 Agent Registry data (reputation score, registered endpoints). See duty2.md "Agent Registry Discovery" section.
- **Dispute resolution.** If a seller accepts payment but doesn't deliver, Ghost Bazaar has no built-in arbitration. Deferred to future work.
- **Multi-unit or batch transactions.** v4 covers single-service negotiations only.

---

## 3. Protocol At-a-Glance

Ghost Bazaar operates in four sequential phases:

```
Phase 1: Discovery       Phase 2: Negotiation      Phase 3: Commitment       Phase 4: Settlement
────────────────────     ────────────────────      ────────────────────      ────────────────────
Buyer broadcasts RFQ     Sellers return offers     Dual-signed Quote         Solana SPL Transfer
  w/ budget_commitment   Buyer counter-offers      (Ed25519, both sign)      17-step verification
  to sellers A,B,C...    ZK proof on counters      Price locked              Nonce consumed
                         Repeat until agreement                              Service executes
```

**Phase 1 (Discovery):** The buyer agent constructs a Request for Quote (RFQ) specifying the desired service, an anchor price, a currency, a deadline, and optionally a Poseidon budget commitment. It broadcasts this to known sellers.

**Phase 2 (Negotiation):** Sellers respond with offers. The buyer eliminates expensive sellers, counter-offers the rest, and uses competing bids as downward pressure. Each counter-offer carries a Groth16 proof (if the RFQ included a budget commitment) proving the counter price is within budget. Multiple rounds continue until the deadline approaches or a satisfactory price is reached.

**Phase 3 (Commitment):** The buyer selects a winner. The engine builds an unsigned quote. The buyer signs it, the seller cosigns it. This dual-signed Ed25519 object locks the agreed price, service, payment endpoint, expiry, memo policy, and a replay-protection nonce.

**Phase 4 (Settlement):** The buyer sends a Solana SPL USDC transfer with a Memo instruction binding the transaction to the quote. The buyer then calls the seller's service endpoint over HTTPS with `Payment-Signature` and `X-Ghost-Bazaar-Quote` headers. The seller runs a 17-step validation, executes the service, and consumes the nonce.

---

## 4. Core Objects

Ghost Bazaar defines five primary data structures, fully specified in GHOST BAZAAR-SPEC-v4.

### 4.1 Request for Quote (RFQ)

The RFQ is the buyer's opening move. It contains:

- **Protocol version:** `"ghost-bazaar-v4"` — receivers reject unknown versions
- **Service type:** namespaced (e.g., `"ghost-bazaar:services:smart-contract-audit"`)
- **Anchor price:** strategically below the real target, decimal string
- **Budget commitment (optional):** `"poseidon:<64-hex-chars>"` — Poseidon hash of `[budget_hard_scaled, salt]`
- **Deadline:** hard cutoff for negotiation (ISO 8601)
- **Buyer identity and signature:** `did:key` DID and `ed25519:<base64>` signature

### 4.2 Seller Offer

Each seller responds independently with a price, currency, validity window, and Ed25519 signature. Sellers don't see each other's offers. The buyer sees all of them.

### 4.3 Counter-Offer

The buyer sends counter-offers with a price, target seller DID, and (if the RFQ has a budget commitment) a `budget_proof` containing the Groth16 proof elements.

### 4.4 Signed Quote (Commitment Object)

The protocol's central artifact. It locks the final negotiated price, service type, payment endpoint, expiry, nonce (32 random bytes, `0x`-prefixed lowercase hex; uppercase MUST be rejected), memo policy, and both Ed25519 signatures.

`memo_policy` defaults to `"quote_id_required"` — the Solana transaction's Memo instruction must contain `GhostBazaar:quote_id:<uuid>`.

### 4.5 Extensions

All protocol objects support an optional `extensions` map with namespaced keys (`<namespace>:<category>:<name>`). Empty extensions are omitted from canonical JSON. Non-empty extensions are included in signing.

---

## 5. ZK Budget Range Proof

Ghost Bazaar includes an optional zero-knowledge proof system that lets buyers prove their counter-offer is within their budget without revealing the budget.

### Commitment

The buyer generates a random 254-bit salt and computes:

```
budget_commitment = Poseidon([budget_hard_scaled, salt])
```

This commitment is included in the RFQ. The salt never leaves the buyer's local memory.

### Proof

For each counter-offer, the buyer generates a Groth16 proof for the BudgetRangeProof circuit:

- **Public inputs:** `counter_price_scaled`, `budget_commitment`
- **Private inputs:** `budget_hard_scaled`, `commitment_salt`
- **Constraints:**
  1. Commitment integrity: `Poseidon([budget_hard_scaled, salt]) == budget_commitment`
  2. Range check: `counter_price_scaled <= budget_hard_scaled` (64-bit)

The proof is ~200ms to generate and near-instant to verify. Any seller or the engine can verify the proof without learning `budget_hard`.

---

## 6. Settlement Flow

Settlement bridges off-chain negotiation with on-chain payment via a 17-step validation:

1. Decode `X-Ghost-Bazaar-Quote` header (base64 → canonical JSON)
2. Verify buyer Ed25519 signature
3. Verify seller Ed25519 signature
4. Base58-decode `Payment-Signature` header
5. `getTransaction(sig, {commitment:"confirmed"})` via RPC
6. Confirm tx status is confirmed or finalized
7. Extract SPL token transfer instruction
8. Verify transfer destination matches seller's associated token account
9. Verify token mint matches USDC mint
10. Verify transfer amount equals `normalizeAmount(final_price, usdc_mint)`
11. If `memo_policy` is `"quote_id_required"`: verify Memo contains quote_id
12. If `memo_policy` is `"hash_required"`: verify Memo contains sha256(canonical_quote)
13. Verify nonce format: 32 bytes, lowercase hex, `0x` prefix
14. Check nonce is not consumed (MVP: in-memory Set; week-2: PDA)
15. Verify `expires_at` is in the future
16. Execute service
17. Consume nonce atomically with execution

If any step fails, the seller returns an error with the appropriate v4 error code. No service executes.

---

## 7. Security Properties and Threat Model

### What Ghost Bazaar Guarantees

| Property | How It Works |
|---|---|
| **Budget privacy** | `budget_hard` never appears in any protocol message. The anchor price is strategically lower. The ZK proof proves sufficiency without revelation. |
| **Price non-repudiation** | Both buyer and seller sign the quote with Ed25519. Neither can later claim a different price was agreed. |
| **Replay protection** | Each quote contains a unique nonce (32 random bytes). The seller consumes it on first use. Replayed quotes are rejected. |
| **Time-bounding** | Quotes carry `expires_at`. Stale quotes are rejected. Negotiation is bounded by the RFQ `deadline`. |
| **Tamper evidence** | Any modification to the quote invalidates both Ed25519 signatures. |
| **Budget sufficiency** | ZK proof cryptographically proves `counter_price <= budget_hard` without revealing the budget. |

### What Ghost Bazaar Does NOT Guarantee

| Threat | Status |
|---|---|
| **Seller delivers after payment** | Not enforced. Ghost Bazaar commits to a price, not to service delivery. |
| **Sybil sellers** | A single entity could pose as multiple sellers. Not enforced in v4. |
| **Buyer solvency** | Ghost Bazaar doesn't verify funds. That check happens at Solana settlement time. |
| **Network-level privacy** | Offer messages aren't encrypted by default. TLS is assumed. |
| **Seller collusion** | If sellers coordinate prices outside the protocol, Ghost Bazaar can't detect it. |

---

## 8. Agent Interface: MCP Server

Ghost Bazaar exposes its functionality through an MCP (Model Context Protocol) server, enabling any MCP-compatible agent (including Claude Desktop) to negotiate autonomously.

**Buyer tools:** `ghost_bazaar_browse_listings`, `ghost_bazaar_post_rfq`, `ghost_bazaar_get_offers`, `ghost_bazaar_counter`, `ghost_bazaar_accept`, `ghost_bazaar_settle`

**Seller tools:** `ghost_bazaar_register_listing`, `ghost_bazaar_get_rfqs`, `ghost_bazaar_respond_offer`, `ghost_bazaar_respond_counter`, `ghost_bazaar_check_events`

Privacy invariant: `budget_hard` is accepted as tool input but stored only in local `BuyerPrivate`. It never appears in any tool output, event log, or error message.

---

## 9. Open Questions and Roadmap

Several areas remain for future work:

- **Seller-side ZK floor price proof** — Mirror the buyer's budget proof for sellers. Candidate for v5.
- **On-chain ZK verifier** — Move proof verification to an Anchor program. Off-chain verification is sufficient for MVP.
- **Sealed-bid / commit-reveal reverse auctions** — Sellers submit hashed commitments, reveal simultaneously. Stronger fairness guarantees.
- **Reputation and Sybil resistance** — Staking or verifiable credentials for seller identity.
- **Multi-unit and batch transactions** — v4 covers single-service only. Batch negotiation requires different mechanism design.
- **Cross-chain settlement** — The Signed Quote is chain-agnostic, but settlement currently runs on Solana only.
- **Dispute resolution** — Escrow or arbitration for delivery quality disputes.

---

## 10. References

1. [x402 Protocol](https://x402.org) — HTTP-native payment protocol
2. [Solana Web3.js](https://solana-labs.github.io/solana-web3.js/) — Solana JavaScript SDK
3. [SPL Token](https://spl.solana.com/token) — Solana Program Library token standard
4. [circomlib](https://github.com/iden3/circomlib) — Poseidon hash and comparator circuits
5. [snarkjs](https://github.com/iden3/snarkjs) — Groth16 prover and verifier
6. [Model Context Protocol](https://modelcontextprotocol.io/) — Agent tool interface standard
7. [Virtuals Protocol ACP](https://whitepaper.virtuals.io/about-virtuals/agent-commerce-protocol-acp)
8. [Microsoft Magentic Marketplace](https://www.microsoft.com/en-us/research/blog/magentic-marketplace-an-open-source-simulation-environment-for-studying-agentic-markets/)
9. [Privacy-Preserving Negotiation Agents (arXiv:2601.00911)](https://arxiv.org/html/2601.00911)
10. [SBRAC: ZK Sealed-Bid Auctions](https://www.sciencedirect.com/science/article/abs/pii/S2214212621002635)
11. [Cryptobazaar: Private Sealed-Bid Auctions](https://eprint.iacr.org/2024/1410.pdf)

---

*Ghost Bazaar is an open protocol. This whitepaper describes the protocol as of v4 (March 2026) and will evolve as the protocol matures.*
