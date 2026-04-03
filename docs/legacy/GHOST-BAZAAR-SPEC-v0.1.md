# Ghost Bazaar Protocol
### Off-Chain Negotiation + x402 Settlement for Multi-Agent Markets

**Status:** Draft v0.1
**Author:** [Your Name]
**Date:** February 2026
**Previously:** Agentic Commerce Protocol — renamed to avoid conflicts with Virtuals Protocol ACP and OpenAI/Stripe ACP

---

## Abstract

Ghost Bazaar is a protocol for autonomous agent-to-agent commerce, combining off-chain multi-party price negotiation with cryptographically signed quote commitment and on-chain settlement via x402. The protocol enables a buyer agent to discover optimal pricing across multiple seller agents without revealing its true budget, using game-theoretic bidding strategies, and to finalize transactions with cryptographic non-repudiation guarantees.

---

## 1. Motivation

The x402 protocol provides a clean mechanism for agents to pay for services via HTTP. However, x402 assumes price is already known at call time. In real agentic commerce, price itself is a negotiable variable — especially when:

- Multiple sellers offer substitutable services
- Buyers have budget constraints they wish to protect
- Market prices are dynamic and time-sensitive
- No trusted intermediary is available to mediate

Existing solutions either rely on fixed pricing (no negotiation), trusted brokers (centralized), or expose buyer preferences (information leakage). Ghost Bazaar fills this gap.

## 2. Protocol Overview

```
Phase 1: Discovery          Phase 2: Negotiation        Phase 3: Commitment         Phase 4: Settlement
─────────────────────       ─────────────────────       ─────────────────────       ─────────────────────
Buyer → RFQ broadcast  →    Sellers return offers  →    Signed Quote (EIP-712)  →   x402 Payment Call
        (to A,B,C,D,E)       Buyer counter-offers        Buyer + Seller sign          Seller verifies sig
                             ↑↓ repeat until agree       Price locked on-chain        Transfer executes
```

---

## 3. Roles

**Buyer Agent**
- Holds a private budget ceiling (`budget_hard`) and a target price (`budget_soft`)
- Initiates negotiation, never reveals `budget_hard`
- Selects the best offer within deadline

**Seller Agents (A, B, C, D, E)**
- Each independently prices their service
- Responds to RFQs and counters
- Co-signs the final agreed quote

**Agent Runtime**
- Maintains session state off-chain
- Enforces deadline
- Facilitates signed quote generation

---

## 4. Data Structures

### 4.1 Request for Quote (RFQ)

```json
{
  "rfq_id": "uuid-v4",
  "buyer": "did:agent:buyer_pubkey",
  "service": "text-generation",
  "spec": { "tokens": 1000, "model": "gpt-4o" },
  "anchor_price": 2.00,
  "currency": "USDC",
  "deadline": "2026-02-21T12:00:30Z",
  "signature": "ed25519:..."
}
```

**Note:** `anchor_price` is the buyer's opening anchor, NOT the real budget. It is strategically set below `budget_soft`.

### 4.2 Seller Offer

```json
{
  "offer_id": "uuid-v4",
  "rfq_id": "...",
  "seller": "did:agent:seller_a_pubkey",
  "price": 3.50,
  "currency": "USDC",
  "valid_until": "2026-02-21T12:00:25Z",
  "signature": "ed25519:..."
}
```

### 4.3 Signed Quote (Commitment Object)

```json
{
  "quote_id": "uuid-v4",
  "rfq_id": "...",
  "buyer": "did:agent:buyer_pubkey",
  "seller": "did:agent:seller_a_pubkey",
  "service": "text-generation",
  "final_price": 2.80,
  "currency": "USDC",
  "payment_endpoint": "https://seller-a.com/api/generate",
  "expires_at": "2026-02-21T12:01:00Z",
  "nonce": "0xabc123...",
  "buyer_signature": "ed25519:...",
  "seller_signature": "ed25519:..."
}
```

This is the **cryptographic lock**. Both parties have signed the final price. Neither can alter it post-signature.

---

## 5. Negotiation Protocol

### 5.1 Buyer Strategy (Game Theory)

The buyer's private state:

```
budget_hard  = $5.00   // never revealed
budget_soft  = $3.00   // target
anchor_price = $2.00   // opening bid (anchor heuristic)
deadline     = T+30s
```

**Round structure:**

```
T+0s:   Buyer broadcasts RFQ with anchor_price = $2.00
T+3s:   Sellers return initial offers (A=$4.00, B=$3.80, C=$3.20, D=$3.50, E=$4.20)
T+6s:   Buyer eliminates E, A. Counter-offers B,C,D at $2.60
T+10s:  B=$3.30, C=$2.90, D=$3.10
T+14s:  Buyer counters C,D at $2.75
T+18s:  C=$2.80, D=$2.95
T+20s:  Buyer accepts C at $2.80 → initiate signing
```

**Key rules for buyer agent:**
- Never counter above `budget_soft` in early rounds
- Use competing offers to create downward pressure ("Seller D is at $2.95, can you beat that?")
- Reveal competing offers but NOT your budget
- Apply time pressure: send final-round signal at T+25s
- If no seller reaches `budget_soft` by T+25s, accept best offer under `budget_hard`

### 5.2 Seller Strategy

Sellers set a `reserve_price` floor below which they will not go. They can:
- Observe buyer's counter patterns to infer budget range
- Drop price competitively when aware of rivals
- Withdraw if no deal seems viable

### 5.3 Information Asymmetry

| Information | Buyer knows | Seller knows |
|-------------|-------------|--------------|
| Buyer's hard budget | ✅ | ❌ |
| Buyer's soft target | ✅ | ❌ |
| Seller's reserve price | ❌ | ✅ |
| Other sellers' offers | ✅ (all) | ❌ (own only) |
| Deadline | ✅ | ✅ (from RFQ) |

This asymmetry is intentional. The buyer holds more information and uses it to drive prices toward `budget_soft`.

---

## 6. Signed Quote Commitment

Once negotiation concludes:

1. **Buyer proposes** final signed quote to winning seller
2. **Seller co-signs** (or rejects within 3s timeout)
3. Quote is **frozen** — any mutation invalidates both signatures
4. Quote is stored in buyer's agent runtime as payment credential

**Signature scheme:** EIP-712 typed structured data (EVM compatible) or Ed25519 (Solana/generic).

EIP-712 domain example:
```json
{
  "name": "Ghost Bazaar",
  "version": "1",
  "chainId": 1,
  "verifyingContract": "0x..."
}
```

---

## 7. Settlement via x402

The buyer calls the seller's payment endpoint with the signed quote as a credential:

```http
POST /api/generate HTTP/1.1
Host: seller-a.com
PAYMENT-SIGNATURE: <base64-encoded-signed-payment-payload>
X-Ghost-Bazaar-Quote: <base64-encoded-signed-quote>
Content-Type: application/json

{ "prompt": "..." }
```

**Seller-side validation:**
1. Decode `X-Ghost-Bazaar-Quote`
2. Verify buyer and seller signatures on quote
3. Verify quote `final_price` matches x402 payment amount
4. Verify quote `nonce` not already spent (replay protection)
5. Verify `expires_at` not elapsed
6. If all pass → execute service + accept payment

If validation fails at any step, return `402 Payment Required` with error detail.

---

## 8. Security Properties

| Property | Mechanism |
|----------|-----------|
| Budget privacy | Anchor price ≠ real budget; no protocol field exposes `budget_hard` |
| Price non-repudiation | Dual signatures on Signed Quote |
| Replay protection | Nonce in Signed Quote, consumed on first use |
| Time-bound | `expires_at` on quote; enforced by seller |
| Sybil resistance | Seller DIDs must be registered/staked (out of scope v1) |

---

## 9. Failure Modes

**No deal reached within deadline:**
Buyer falls back to best available offer under `budget_hard`. If none, transaction fails gracefully with no payment.

**Seller refuses to co-sign:**
Buyer moves to next-best offer. Seller loses the deal.

**Quote expires before x402 call:**
Buyer must re-negotiate. Short expiry (60s suggested) prevents stale pricing.

**Payment fails after quote signed:**
Quote is signed but not yet settled. No funds moved. Buyer retries or abandons.

---

## 10. Reference Implementation (Pseudocode)

```python
class BuyerAgent:
    def __init__(self, budget_hard, budget_soft, deadline_sec):
        self.budget_hard = budget_hard
        self.budget_soft = budget_soft
        self.deadline = time.now() + deadline_sec
        self.anchor = budget_soft * 0.65  # initial anchor heuristic

    async def run(self, sellers):
        offers = await self.broadcast_rfq(sellers, self.anchor)

        while time.now() < self.deadline - 5:
            candidates = [o for o in offers if o.price < self.budget_hard]
            if not candidates:
                break
            best = min(candidates, key=lambda o: o.price)
            if best.price <= self.budget_soft:
                break
            counter = self.compute_counter(best.price, time_remaining())
            offers = await self.counter_offer(candidates[:3], counter)

        winner = min(offers, key=lambda o: o.price)
        if winner.price > self.budget_hard:
            return None  # no deal

        quote = await self.sign_and_lock(winner)
        return await self.pay_x402(quote)

    def compute_counter(self, best_price, time_remaining):
        # Move faster toward budget_soft as deadline approaches
        urgency = 1 - (time_remaining / self.deadline_sec)
        return self.budget_soft * (0.85 + 0.15 * urgency)
```

---

## 11. Open Questions

- **Privacy-preserving negotiation:** Can we use ZK proofs to let buyers prove "my budget is sufficient" without revealing it?
- **Sealed-bid extension:** Can we support a commit-reveal reverse-auction mode for sealed-bid negotiation when sellers should not see initial offer positions?
- **Seller identity and reputation:** Can verifiable credentials or ZK attestations gate seller participation to reduce Sybil behavior while keeping identity privacy?
- **Seller signing security:** Can seller quote approvals use threshold signatures or multisig so quote authorization is resilient to single-key compromise?
- **Dispute resilience:** Should a fair-exchange path with optional escrow be added for delivery/payment conflicts?
- **Verifiable delivery:** Can we require deterministic delivery proofs via TEE or zkVM before final payment to reduce disputes about service execution?
- **Multi-unit purchases:** Protocol currently assumes single transaction. Batch negotiation is TBD.
- **Reputation layer:** How to penalize sellers who refuse co-signing after negotiation? Staking mechanism?
- **Standardization:** Submit as EIP? Or define as Ghost Bazaar independent standard?
- **Cross-chain:** Quote signing should be chain-agnostic; settlement chain is flexible.

---

## 12. Comparison to Related Work

| Protocol | Negotiation | Multi-seller | Budget Privacy | On-chain Settlement |
|----------|-------------|--------------|----------------|---------------------|
| x402 (base) | ❌ Fixed price | ❌ | N/A | ✅ |
| FIPA Contract Net | ✅ | ✅ | ❌ | ❌ |
| Filecoin Storage Deal | ✅ Limited | ❌ | ❌ | ✅ |
| **Ghost Bazaar (this work)** | ✅ | ✅ | ✅ | ✅ |

---

*End of Draft v0.1*
