# Research: Light Protocol ZK Nullifier Skill -- Relevance to Ghost Bazaar

**Date:** 2026-03-21
**Scope:** ZK nullifier skill at skills.sh, Light Protocol, ZK compressed accounts, Ghost Bazaar applicability

---

## TL;DR

The Light Protocol ZK nullifier skill provides a pattern for **one-time-use cryptographic tokens on Solana** using compressed PDAs at ~59x lower cost than regular PDAs (15,000 vs 890,880 lamports per nullifier). This is **directly relevant** to Ghost Bazaar's nonce consumption (replay prevention) in Duty 3 Settlement and could also serve commitment state proofs and privacy-preserving verification.

---

## 1. What the ZK Nullifier Skill Does

The [skills.sh/lightprotocol/skills/zk-nullifier](https://skills.sh/lightprotocol/skills/zk-nullifier) is a Claude Code skill (also compatible with opencode, gemini-cli, copilot, amp, codex) that provides code patterns and documentation references for implementing ZK nullifiers on Solana using Light Protocol.

### Core Pattern

```
1. Client computes nullifier = hash(secret, context)
2. Client fetches validity proof for derived address (proves it does NOT exist)
3. Client calls create_nullifier with nullifier values and proof
4. Program derives address from nullifier, creates compressed account via CPI
5. Light system program REJECTS CPI if address already exists
```

Key insight: the nullifier is a **deterministically derived hash** that ensures an action can only be performed once. The nullifier **cannot be linked back** to the action or user (privacy-preserving).

### Cost Comparison

| Storage             | Cost per nullifier   |
|---------------------|----------------------|
| Regular PDA         | 890,880 lamports     |
| Compressed PDA      | 15,000 lamports      |

**Resources provided by the skill:**
- Full example: [Lightprotocol/program-examples/zk/nullifier](https://github.com/Lightprotocol/program-examples/tree/main/zk/nullifier)
- Additional ZK examples: nullifier, zk-id, mixer, shielded-pool
- ZK overview: [zkcompression.com/zk/overview](https://www.zkcompression.com/zk/overview)

---

## 2. What is Light Protocol?

[Light Protocol](https://lightprotocol.com/) is the ZK Compression protocol for Solana, co-developed with [Helius Labs](https://www.helius.dev/). Launched June 2024, it enables developers to create compressed accounts, tokens, and PDAs that store only a cryptographic commitment (state root) on-chain while full data lives in cheaper Solana ledger space.

**Key numbers:**
- 100-byte PDA: ~160x cheaper compressed
- 100 token accounts: ~5,000x cheaper compressed
- State trees support ~67 million leaves (depth 26)

**Architecture components:**
- **Light System Program** -- Verifies validity proofs, enforces account schema, manages state transitions
- **Account Compression Program** -- Writes to state and address trees
- **Photon Indexer** -- Indexes and serves compressed account state to clients
- **Prover Nodes** -- Generate off-chain ZK validity proofs
- **Forester Nodes** -- Asynchronously empty nullifier queues and advance state roots

**Smart contracts are independently audited** -- reports at [github.com/Lightprotocol/light-protocol/tree/main/audits](https://github.com/Lightprotocol/light-protocol/tree/main/audits).

---

## 3. ZK Compressed Accounts on Solana

### How They Work

1. Account data is hashed and stored as a leaf in a sparse binary Merkle tree
2. Only the tree's **state root** (32 bytes) is stored on-chain
3. Full account data is stored as **call data** in cheaper Solana ledger space
4. Transactions provide the compressed data + a **zero-knowledge validity proof** that the data corresponds to the on-chain state root

### State Transition Model

```
(state, validityProof) -> state transition -> state'
```

- Old compressed account hash is **nullified** (inserted into nullifier queue)
- New compressed account hash is **appended** to the state Merkle tree
- Transitions are **atomic and instantly final**
- Forester nodes asynchronously empty nullifier queues by zeroing the corresponding Merkle tree leaves

### Key Properties

- **Composable** -- compressed and regular accounts can interact atomically
- **L1 security** -- execution and data availability remain on Solana L1
- **No separate chain ID** -- users and developers stay on Solana
- **Write-lock optimization** -- state trees and nullifier queues are separated to reduce contention

---

## 4. Nullifier-Based State Management

### Core Concept

A nullifier is a **deterministic, one-way hash** derived from a secret and context. Once consumed (created as a compressed PDA), it can never be created again -- the Light system program enforces uniqueness at the protocol level.

### UTXO-Like Model

Light Protocol's compressed accounts follow a **UTXO-inspired model**:
- To update state, you **nullify** the old account and **create** a new one
- The nullifier queue tracks consumed states
- Forester nodes zero out the corresponding Merkle tree leaves asynchronously
- This provides **instant finality** while keeping state trees manageable

### Why This Matters for Replay Prevention

The nullifier pattern is the **gold standard** for preventing double-spending and replay attacks in ZK systems:
- Used by Zcash, Tornado Cash, and many ZK protocols
- Deterministic derivation: `hash(secret, context)` ensures the same action always produces the same nullifier
- Existence check: validity proof proves the nullifier does NOT exist before creation
- Atomic rejection: the system program rejects any CPI that tries to create a duplicate

---

## 5. Relevance to Ghost Bazaar

### Direct Applicability Matrix

| Ghost Bazaar Need                         | ZK Nullifier Solution                                   | Fit   |
|---------------------------------------|---------------------------------------------------------|-------|
| **Nonce consumption (replay prevention)** | `nullifier = hash(commitment_id, nonce)` -- consumed on settlement, Light rejects duplicates | HIGH  |
| **On-chain state proofs**             | Compressed commitment records with validity proofs, verifiable against state root | HIGH  |
| **Privacy-preserving verification**   | Nullifier is unlinkable to the original action/user; ZK proofs verify without revealing private data | HIGH  |
| **Cost efficiency**                   | 15,000 lamports per nullifier vs 890,880 for regular PDA (~59x savings) | HIGH  |
| **Settlement finality**               | Atomic state transitions with instant finality | HIGH  |

### Concrete Ghost Bazaar Integration Points

#### Duty 3: Settlement -- Nonce Consumption
Currently Ghost Bazaar spec (v4) requires nonce consumption to prevent replay attacks on `POST /execute`. The ZK nullifier pattern maps directly:

```
nullifier = hash(commitment.dual_sig, commitment.nonce)
```

- On settlement, the buyer creates a nullifier (compressed PDA) for the commitment nonce
- If the same commitment is replayed, Light's system program rejects the duplicate nullifier
- Cost: ~15,000 lamports per settlement (vs ~890,880 for a regular PDA nonce account)
- Privacy: the nullifier hash does not reveal the commitment details

#### Commitment State Proofs
Dual-signed commitments could be stored as compressed accounts:
- State root on-chain proves the commitment exists
- Validity proof verifies the commitment without revealing `final_price` or terms
- Composable with the settlement SPL token transfer in the same transaction

#### Privacy Layer Integration with `@ghost-bazaar/zk`
Ghost Bazaar already has a `@ghost-bazaar/zk` package for Groth16 budget range proofs. The nullifier pattern could complement this:
- Budget proof: "my counter_price <= budget_hard" (already implemented)
- Nullifier proof: "this nonce has not been consumed" (new, via Light)
- Both are ZK proofs that can be verified on-chain without revealing private data

### Architectural Considerations

**Pros:**
- Battle-tested protocol with independent security audits
- Massive cost savings (59x per nullifier)
- Native Solana composability -- no bridge or L2 needed
- Light SDK provides TypeScript and Rust client libraries
- Solana ecosystem alignment (Helius as RPC partner)

**Cons / Risks:**
- Dependency on Light Protocol infrastructure (Photon indexer, Prover, Forester nodes)
- Additional complexity: compressed accounts require validity proofs from RPC
- Transaction size overhead: ~128 bytes reserved for validity proof within Solana's 1232-byte tx limit
- Nullifier queues have capped size -- may need monitoring under high throughput
- Light Protocol is still maturing (Protocol 1.0.0 released, but ecosystem is young)

### Recommendation

**YES -- investigate integration for Duty 3 settlement.** The ZK nullifier pattern is the most natural fit for Ghost Bazaar's nonce consumption requirement. It provides:
1. Protocol-level replay prevention (not just application-level)
2. 59x cost reduction per settlement
3. Privacy-preserving nonce consumption (unlinkable nullifiers)
4. Atomic composability with SPL token transfers

**Next steps:**
1. Review the full example at [Lightprotocol/program-examples/zk/nullifier](https://github.com/Lightprotocol/program-examples/tree/main/zk/nullifier)
2. Prototype a Ghost Bazaar commitment nullifier using the TypeScript SDK (`@lightprotocol/stateless.js`)
3. Evaluate whether the compressed commitment record pattern fits Duty 3's settlement verification flow
4. Assess infrastructure requirements (Photon indexer, Prover node) for production deployment

---

## Sources

- [skills.sh -- zk-nullifier skill](https://skills.sh/lightprotocol/skills/zk-nullifier)
- [Light Protocol homepage](https://lightprotocol.com/)
- [ZK Compression documentation](https://www.zkcompression.com/home)
- [Light Protocol whitepaper](https://www.zkcompression.com/references/whitepaper)
- [Light Protocol GitHub](https://github.com/Lightprotocol/light-protocol)
- [ZK nullifier program examples](https://github.com/Lightprotocol/program-examples/tree/main/zk/nullifier)
- [Light Protocol core concepts](https://docs.lightprotocol.com/learn/core-concepts)
- [ZK Compression client guide](https://www.zkcompression.com/pda/compressed-pdas/guides/client-guide)
- [Helius blog -- ZK proofs on Solana](https://www.helius.dev/blog/zero-knowledge-proofs-its-applications-on-solana)
- [The Block -- Light Protocol launch](https://www.theblock.co/post/301368/light-protocol-and-helius-labs-introduce-zk-compression-to-further-scale-solana-apps)
- [Developer's Guide to ZK Compression](https://harshghodkar.substack.com/p/developers-guide-to-zk-compression)
- [DeepWiki -- Light Protocol](https://deepwiki.com/Lightprotocol/light-protocol)
- [arXiv -- ZK Architecture on Solana](https://arxiv.org/abs/2511.00415)
