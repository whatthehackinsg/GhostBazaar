# Ghost Bazaar — Solana Agent Marketplace: Implementation Design

**Date:** 2026-03-13
**Status:** Approved for implementation
**Spec baseline:** GHOST-BAZAAR-SPEC-v4.md
**Target:** Solana Agent Hackathon MVP

---

## 1. Problem Statement

Agent-to-agent commerce today has no negotiation layer. Agents either pay a fixed listed price or implement ad-hoc barter logic with no standard protocol, no cryptographic commitment, and no privacy guarantees on budget or floor price. x402 solves the payment step but not price discovery.

Ghost Bazaar adds a negotiation phase before payment: agents broadcast intent, compete and counter-offer autonomously, lock a dual-signed price commitment, then settle on Solana. Budget and floor price never leave the agent's local process. Budget ceiling is provably enforced by a ZK range proof on every counter-offer — sellers can verify the buyer is negotiating in good faith without learning the actual ceiling.

This design implements GHOST BAZAAR-SPEC-v4, which incorporates ZK budget proofs as a normative optional extension (v4 Section 10). The `budget_commitment` field on RFQ and `budget_proof` field on CounterOffer are defined in v4 itself, not design-spec extensions.

---

## 2. Goals

1. Implement GHOST BAZAAR-SPEC-v4 end-to-end: Discovery → Negotiation → Commitment → Settlement
2. Expose Ghost Bazaar as an MCP server so any MCP-compatible agent (Claude Desktop, Claude SDK, third-party) can participate as buyer or seller with zero custom code
3. Ship pluggable autonomous strategies: rule-based (default, reliable) and LLM-powered (Claude API, demo centerpiece)
4. Settle on Solana: SPL USDC wallet-to-wallet transfer, Memo instruction with `quote_id` as on-chain receipt anchor, PDA nonce replay protection; structured on-chain deal receipt deferred to Anchor program (week-2 bonus)
5. ZK budget range proof: buyer publishes a Poseidon commitment to `budget_hard` in the RFQ; every counter-offer carries a Groth16 proof that `counter_price ≤ budget_hard`, verifiable by the engine and any seller without revealing `budget_hard`
6. Show settlement speed (negotiation-complete → on-chain-confirmed) in the demo UI

---

## 3. Non-Goals (MVP)

- Anchor program for nonce + structured deal receipt (week-2 bonus if time permits; see deal receipt note in Section 4 Layer 1)
- Structured on-chain deal receipt data (system program PDAs cannot store arbitrary user data; for MVP the nonce PDA is existence-only and the deal receipt is a signed JSON object returned in the 200 response plus a Memo instruction in the settlement transaction)
- Seller-side ZK floor price proof (post-MVP; buyer-side ZK ships first)
- On-chain ZK verifier program (off-chain snarkjs verification in the engine is sufficient for MVP)
- On-chain negotiation logic
- Delivery arbitration or escrow
- Reputation or staking
- Multi-unit or batch negotiation
- Cross-chain settlement
- Persistent database (in-memory state is sufficient for hackathon)
- Authentication or rate limiting on the negotiation engine

---

## 4. Architecture

The system has seven layers. Layer numbers reflect call-chain depth, not import direction — `packages/settlement` imports from `packages/core`, and `packages/engine` imports from `packages/zk`. The rule "strictly downward" means no lower-numbered package may import from a higher-numbered one; it does not mean higher-numbered packages are forbidden from importing lower ones. The MCP server and Agent Runtime are the only layers permitted to call across multiple layer boundaries; they are the orchestrators.

```
┌──────────────────────────────────────────────────────────────────┐
│  External Agents                                                 │
│  Claude Desktop · Claude SDK · any MCP-compatible agent          │
└───────────────────────────┬──────────────────────────────────────┘
                            │ MCP protocol (stdio or HTTP/SSE)
┌───────────────────────────▼──────────────────────────────────────┐
│  Layer 7: Ghost Bazaar MCP Server                                    │
│  packages/mcp                                                    │
│                                                                  │
│  Buyer tools:                    Seller tools:                   │
│  ghost_bazaar_browse_listings        ghost_bazaar_register_listing       │
│  ghost_bazaar_post_rfq               ghost_bazaar_get_rfqs               │
│  ghost_bazaar_get_offers             ghost_bazaar_respond_offer          │
│  ghost_bazaar_counter                ghost_bazaar_respond_counter        │
│  ghost_bazaar_accept                 ghost_bazaar_check_events           │
│  ghost_bazaar_settle                                                 │
│                                                                  │
│  ghost_bazaar_post_rfq generates budget_commitment automatically.    │
│  ghost_bazaar_counter generates + attaches budget_proof automatically│
│  Caller never sees ZK internals.                                 │
│                                                                  │
│  Wraps Agent Runtime. MCP is an entry point, not a separate      │
│  system. Same BuyerAgent / SellerAgent code underneath.          │
└───────────────────────────┬──────────────────────────────────────┘
                            │
┌───────────────────────────▼──────────────────────────────────────┐
│  Layer 6: Agent Runtime                                          │
│  packages/agents                                                 │
│                                                                  │
│  BuyerAgent                      SellerAgent                    │
│  · Solana keypair = identity      · Solana keypair = identity    │
│  · BuyerPrivate (never on wire)   · SellerPrivate (never wire)  │
│  · commitment_salt (random, kept  · polls /listings             │
│    local for session lifetime)    · calls strategy.onRfq()      │
│  · polls /rfqs/:id/events         · calls strategy.onCounter()  │
│    every 500ms with ?after= cursor · fires HTTP protocol actions │
│  · calls strategy.onOffers()                                     │
│  · calls zk.generateBudgetProof() · records settled_at on exec  │
│    before every counter POST                                     │
│  · fires HTTP protocol actions                                   │
│  · records negotiation_committed_at for settlement timer         │
└────────────┬──────────────────────────────┬──────────────────────┘
             │                              │
┌────────────▼──────────────────────────────▼──────────────────────┐
│  Layer 5: Strategy SDK                                           │
│  packages/strategy                                               │
│                                                                  │
│  Interfaces                                                      │
│  · BuyerStrategy: openingAnchor(), onOffersReceived()            │
│  · SellerStrategy: onRfqReceived(), onCounterReceived()          │
│                                                                  │
│  Rule-based (synchronous, reliable for demo)                     │
│  · LinearConcessionBuyer — moves anchor → budget_soft linearly   │
│  · TimeWeightedBuyer     — urgency-aware, accelerates near ddl   │
│  · CompetitiveBuyer      — exploits multi-seller competition     │
│  · FirmSeller            — rarely discounts, holds near target   │
│  · FlexibleSeller        — responds to pressure, concedes fast   │
│  · CompetitiveSeller     — concedes faster when competing_       │
│                            sellers ≥ 2; holds firm when sole     │
│                            responder to exploit scarcity         │
│                                                                  │
│  LLM-powered (async, Claude API)                                 │
│  · LLMBuyerStrategy  — Claude reasons on public context only     │
│  · LLMSellerStrategy — Claude reasons on public context only     │
│  · Private state injected as system prompt constraints,          │
│    never as structured fields in the user message               │
│                                                                  │
│  Privacy Sanitizer (non-bypassable, always runs last)            │
│  · Buyer: action.price MUST NOT exceed budget_hard               │
│  · Seller: action.price MUST NOT go below floor_price            │
│  · Any strategy — rule-based, LLM, or buggy plugin — is capped  │
│                                                                  │
│  Strategy SDK does NOT generate ZK proofs. It produces a         │
│  BuyerAction with a price. The Agent Runtime calls the ZK layer  │
│  after sanitization, before the HTTP POST.                       │
└────────────┬──────────────────────────────────────────────────────┘
             │
┌────────────▼──────────────────────────────────────────────────────┐
│  Layer 4: Negotiation Engine                                      │
│  packages/engine                                                  │
│                                                                   │
│  Routes                                                           │
│  GET  /listings              — list active seller listings        │
│  GET  /listings/:id          — single listing + negotiation_profile│
│  POST /rfqs                  — buyer broadcasts RFQ               │
│                                validates budget_commitment format  │
│  POST /rfqs/:id/offers       — seller submits offer               │
│  POST /rfqs/:id/counter      — buyer sends counter to seller      │
│                                verifies budget_proof via ZK layer  │
│                                rejects 422 if proof invalid        │
│  POST /rfqs/:id/accept       — buyer selects winner               │
│  PUT  /rfqs/:id/quote/sign   — buyer signs unsigned quote         │
│  GET  /rfqs/:id/quote        — seller retrieves buyer-signed quote│
│  PUT  /rfqs/:id/cosign       — seller co-signs quote              │
│  GET  /rfqs/:id/events       — append-only event stream           │
│                                                                   │
│  State Machine                                                    │
│  OPEN → NEGOTIATING (first offer triggers transition)             │
│  NEGOTIATING → COMMIT_PENDING → COMMITTED                         │
│  COMMIT_PENDING → NEGOTIATING (seller declines co-sign)           │
│  OPEN | NEGOTIATING | COMMIT_PENDING → EXPIRED                    │
│  OPEN | NEGOTIATING → CANCELLED (by buyer only)                   │
│  Invalid transitions return 409                                   │
│                                                                   │
│  COMMITTED transition fires on-chain deal receipt write           │
│  Event Log: append-only, in-memory, keyed by rfq_id              │
│  Deadline Enforcer: setInterval, auto-transitions to EXPIRED      │
│  Server does NOT select winners. Buyer drives accept.             │
└────────────┬──────────────────────────────────────────────────────┘
             │
┌────────────▼──────────────────────────────────────────────────────┐
│  Layer 3: ZK Budget Proof                                         │
│  packages/zk                                                      │
│  Pure library — no network calls, no Solana I/O                   │
│                                                                   │
│  generateBudgetCommitment(budget_hard, salt) → string             │
│    Poseidon([budget_hard_scaled, salt]) → "poseidon:<hex>"        │
│                                                                   │
│  generateBudgetProof(counter_price, budget_hard, salt)            │
│    → Promise<BudgetProof>                                         │
│    Runs snarkjs Groth16 prover via WASM                           │
│                                                                   │
│  verifyBudgetProof(proof, counter_price_scaled, commitment)       │
│    → Promise<boolean>                                             │
│    Runs snarkjs Groth16 verifier against bundled vkey.json        │
│                                                                   │
│  scalePrice(decimalStr) → bigint   (delegates to core's           │
│    normalizeAmount with USDC mint; multiply by 10^6, no float)   │
│  unscalePrice(bigint) → string     (divide by 10^6, decimal str) │
└────────────┬──────────────────────────────────────────────────────┘
             │
┌────────────▼──────────────────────────────────────────────────────┐
│  Layer 2: Protocol Core                                           │
│  packages/core                                                    │
│  Pure library — zero network calls, zero Solana I/O               │
│                                                                   │
│  Schemas + Validators                                             │
│  · validateRfq(rfq) → {ok, code}                                 │
│    — validates budget_commitment format if present                │
│  · validateOffer(offer, rfq) → {ok, code}                        │
│  · validateCounter(counter, rfq) → {ok, code}                    │
│    — validates budget_proof field structure if rfq has commitment │
│    — does NOT verify proof validity (engine does that)            │
│  · buildUnsignedQuote(input) → quote                             │
│  · signQuoteAsBuyer(quote, keypair) → quote                      │
│  · signQuoteAsSeller(quote, keypair) → quote                     │
│  · verifyQuote(quote) → {ok, code}                               │
│                                                                   │
│  Signing                                                          │
│  · canonicalJson(obj) → Uint8Array   (keys sorted, no spaces,    │
│                          prices as decimal strings)              │
│  · signEd25519(bytes, keypair) → "ed25519:<base64>"              │
│  · verifyEd25519(bytes, sig, pubkey) → boolean                   │
│  · buildDid(solanaPublicKey) → "did:key:z6Mk..."                 │
│    (multicodec 0xed01 + pubkey bytes, base58btc)                 │
│                                                                   │
│  Amounts                                                          │
│  · normalizeAmount(decimalStr, mintAddress) → bigint             │
│  · decimalStringCompare(a, b) → -1 | 0 | 1  (no floats)         │
│  · computeSpecHash(spec) → "sha256:<hex>"                        │
│                                                                   │
│  Extensions (v4 Section 5.7)                                      │
│  · All protocol objects support optional `extensions` map         │
│  · Keys MUST be namespaced strings (e.g., "x-acme:priority")     │
│  · Included in canonical JSON for signing                        │
│  · Engine MUST relay extensions it does not understand            │
│  · Empty or absent `extensions` MUST be omitted from canonical   │
│    JSON (signing bytes identical whether {} or absent)            │
└────────────┬──────────────────────────────────────────────────────┘
             │
┌────────────▼──────────────────────────────────────────────────────┐
│  Layer 1: Settlement + Solana                                     │
│  packages/settlement                                              │
│                                                                   │
│  POST /execute (seller's endpoint)                                │
│  17-step validation order (normative, from v4 spec §9):           │
│  1.  Decode X-Ghost-Bazaar-Quote header (base64 → canonical JSON)     │
│  2.  Verify buyer Ed25519 signature                               │
│  3.  Verify seller Ed25519 signature                              │
│  4.  Base58-decode Payment-Signature header                       │
│  5.  getTransaction(sig, {commitment:"confirmed"}) via RPC        │
│  6.  Confirm tx status is confirmed or finalized                  │
│  7.  Extract SPL token transfer instruction                       │
│  8.  Verify transfer destination matches quote.seller pubkey      │
│  9.  Verify token mint matches USDC mint for declared network     │
│  10. Verify transfer amount == normalizeAmount(final_price, usdc) │
│  11. Verify Memo instruction contains quote_id (if memo_policy    │
│      is "quote_id_required")                                      │
│  12. Verify Memo contains sha256(canonical_quote) if "hash_req"  │
│      (When memo_policy is "optional", steps 11-12 are skipped)   │
│  13. Verify nonce format: 32 bytes, lowercase hex, 0x prefix     │
│  14. Check nonce is not consumed (MVP: in-memory Set lookup;      │
│      week-2 Anchor: derive PDA, verify account does NOT exist)   │
│  15. Verify quote.expires_at is in the future                     │
│  16. Execute service                                              │
│  17. Persist nonce to consumed set atomically with execution.     │
│      MVP: in-memory Set<string> on seller process.                │
│      Week-2: PDA nonce account via custom Anchor program.         │
│      NOTE: System Program cannot create arbitrary PDA accounts;   │
│      PDA nonce requires a custom program that owns the PDA.       │
│                                                                   │
│  Deal receipt (MVP): signed JSON object in 200 response body.     │
│  On-chain structured receipt deferred to Anchor program (week-2). │
│  MVP includes quote_id in settlement Memo instruction as receipt  │
│  anchor — readable from Solana Explorer without a custom program. │
│                                                                   │
│  Settlement Timer                                                 │
│  · negotiation_committed_at: recorded when state → COMMITTED      │
│  · settlement_confirmed_at:  recorded after step 6 confirms       │
│  · delta exposed in 200 response and demo UI                      │
│                                                                   │
│  Nonce consumption (MVP): in-memory Set<string> keyed by quote_id.│
│  Checked at step 14, persisted at step 17.                        │
│  Nonce consumption (week-2): PDA account via Anchor program.      │
│  Deal receipt: deferred to Anchor program (week-2 bonus).         │
│  MVP: quote_id in Memo instruction is the on-chain receipt anchor.│
└───────────────────────────────────────────────────────────────────┘
```

---

## 5. ZK Budget Range Proof — Full Specification

### 5.1 Purpose

The current privacy model relies on convention: `budget_hard` is never sent over the wire. ZK upgrades this to a cryptographic guarantee: the buyer publishes a commitment to `budget_hard` at RFQ time, then proves on every counter-offer that the counter price is at or below that committed ceiling. The engine and any seller can verify this proof without learning `budget_hard`.

This eliminates a class of buyer misbehavior where a buyer sends low counters during negotiation but would actually accept much higher prices — the commitment binds them to a ceiling they declared before seeing any offers.

### 5.2 Price Scaling

Circuit arithmetic operates on integers, not decimal strings. All prices are scaled to micro-USDC before entering the circuit:

```
scaled = decimalString × 10^6   (integer multiply, no float)

Examples:
  "36.50" USDC  →  36_500_000 micro-USDC
  "100.00" USDC →  100_000_000 micro-USDC
  "0.01" USDC   →  10_000 micro-USDC
```

Scaling uses integer arithmetic on the decimal string — split at the decimal point, pad the fractional part to 6 digits, concatenate. Never use `parseFloat`.

Maximum representable amount: 2^64 − 1 micro-USDC ≈ 18.4 trillion USDC. The circuit uses 64-bit range checks throughout.

### 5.3 Commitment Scheme

```
commitment_salt: random bigint, 254 bits (one Poseidon field element)
                 generated once per BuyerAgent session, kept local

budget_commitment = Poseidon([budget_hard_scaled, commitment_salt])
                  encoded as "poseidon:<64-hex-chars>"
                  // hex MUST be zero-padded to exactly 64 characters (32 bytes)
```

Poseidon is chosen because circomlib ships it natively, it is efficiently provable in a Groth16 circuit, and it provides computational hiding and binding over BN254 scalar field elements.

**Salt generation (exact procedure):**
```typescript
// Generate 32 cryptographically random bytes
const bytes = crypto.getRandomValues(new Uint8Array(32))
// Interpret as a big-endian unsigned integer
const raw = BigInt("0x" + Buffer.from(bytes).toString("hex"))
// Reduce modulo the BN254 scalar field prime so the value is always a valid field element.
// p = 21888242871839275222246405745257275088548364400416034343698204186575808495617n
const BN254_PRIME = 21888242871839275222246405745257275088548364400416034343698204186575808495617n
const commitment_salt = raw % BN254_PRIME
```

The salt is generated once per BuyerAgent session (not per RFQ), kept in memory only, never serialized to disk or included in any log or protocol message. If a buyer agent restarts, it generates a new salt and publishes a new commitment in the new RFQ.

### 5.4 Circuit: BudgetRangeProof

**File:** `packages/zk/circuits/BudgetRangeProof.circom`

```circom
pragma circom 2.0.0;

include "node_modules/circomlib/circuits/poseidon.circom";
include "node_modules/circomlib/circuits/comparators.circom";

template BudgetRangeProof() {
    // ── Public inputs ────────────────────────────────────────────
    // counter_price_scaled: the counter price in micro-USDC (×10^6)
    // budget_commitment:    Poseidon([budget_hard_scaled, salt])
    signal input counter_price_scaled;
    signal input budget_commitment;

    // ── Private inputs ───────────────────────────────────────────
    // budget_hard_scaled:  budget ceiling in micro-USDC (×10^6)
    // commitment_salt:     random field element, known only to buyer
    signal input budget_hard_scaled;
    signal input commitment_salt;

    // ── Constraint 1: commitment integrity ───────────────────────
    // Verify that budget_commitment = Poseidon(budget_hard_scaled, salt)
    component poseidon = Poseidon(2);
    poseidon.inputs[0] <== budget_hard_scaled;
    poseidon.inputs[1] <== commitment_salt;
    poseidon.out === budget_commitment;

    // ── Constraint 2: range check — counter ≤ budget ─────────────
    // LessEqThan(n) checks that in[0] <= in[1] within n-bit range.
    // 64 bits supports amounts up to ~18.4 trillion USDC.
    component leq = LessEqThan(64);
    leq.in[0] <== counter_price_scaled;
    leq.in[1] <== budget_hard_scaled;
    leq.out === 1;

    // ── Implicit: both inputs are in [0, 2^64) ───────────────────
    // LessEqThan(64) implicitly enforces 64-bit range on both inputs.
    // Negative values cannot satisfy the range constraint.
}

component main {public [counter_price_scaled, budget_commitment]} = BudgetRangeProof();
```

**Constraint count:** ~300 R1CS constraints (Poseidon(2) ≈ 243, LessEqThan(64) ≈ 64, wiring overhead). A Powers of Tau ceremony with 2^12 (4096) constraints is more than sufficient.

### 5.5 Trusted Setup

**Runtime artifact path resolution (for `prover.ts`):**
```typescript
// prover.ts resolves build artifacts relative to the package directory
const wasmPath = path.join(__dirname, "../build/BudgetRangeProof_js/BudgetRangeProof.wasm")
const zkeyPath = path.join(__dirname, "../build/BudgetRangeProof_final.zkey")
// snarkjs.groth16.fullProve(input, wasmPath, zkeyPath)
```
These paths assume `prover.ts` compiles to `packages/zk/dist/prover.js` with `__dirname` pointing to `packages/zk/dist/`. Adjust if the tsconfig `outDir` differs.

```bash
# Step 1: Download existing Powers of Tau (no new ceremony needed)
# pot12 supports up to 2^12 constraints — sufficient for this circuit
curl -O https://hermez.s3-eu-west-1.amazonaws.com/powersOfTau28_hez_final_12.ptau

# Step 2: Compile circuit
circom packages/zk/circuits/BudgetRangeProof.circom \
  --r1cs --wasm --sym \
  --output packages/zk/build/

# Step 3: Generate initial zkey
snarkjs groth16 setup \
  packages/zk/build/BudgetRangeProof.r1cs \
  powersOfTau28_hez_final_12.ptau \
  packages/zk/build/BudgetRangeProof_0.zkey

# Step 4: Contribute randomness (one contribution is sufficient for hackathon)
snarkjs zkey contribute \
  packages/zk/build/BudgetRangeProof_0.zkey \
  packages/zk/build/BudgetRangeProof_final.zkey \
  --name="Ghost Bazaar hackathon contribution" -v

# Step 5: Export verification key (checked into git)
snarkjs zkey export verificationkey \
  packages/zk/build/BudgetRangeProof_final.zkey \
  packages/zk/keys/vkey.json
```

`vkey.json` is committed to the repository. The `.ptau`, `.r1cs`, `.wasm`, and `.zkey` files are generated artifacts and are gitignored; they must be regenerated from the circuit source.

### 5.6 Proof Format

The `budget_proof` field is added to `CounterOffer` objects. It is required if and only if the parent RFQ contains a `budget_commitment` field.

```json
{
  "counter_id": "uuid-v4",
  "rfq_id": "uuid-v4",
  "round": 2,
  "from": "did:key:z6Mk...",
  "to": "did:key:z6Mk...",
  "price": "36.00",
  "currency": "USDC",
  "valid_until": "2026-03-13T12:00:25Z",
  "budget_proof": {
    "protocol":             "groth16",
    "curve":                "bn128",
    "counter_price_scaled": "36000000",
    "pi_a":  ["14868786297678991965...", "12040578905791138720...", "1"],
    "pi_b":  [["18345808...","7034021..."], ["10578423...","21046851..."], ["1","0"]],
    "pi_c":  ["6734021987540218364...", "19823045712309874521...", "1"]
  },
  "signature": "ed25519:..."
}
```

Field rules:
- `protocol` MUST be `"groth16"`
- `curve` MUST be `"bn128"`
- `counter_price_scaled` MUST equal `normalizeAmount(counter.price, usdc_mint).toString()` as a decimal string. The engine cross-checks this before running the verifier.
- `pi_a`, `pi_b`, `pi_c` are the Groth16 proof elements as **decimal strings** — large unsigned integers, as output directly by `snarkjs.groth16.fullProve()`. Do NOT use hex strings here; snarkjs verifier expects decimal. Example: `"21888242871839275222246405745257275088548364400416034343698204186575808495617"`, not `"0x1a2b..."`.
- `budget_proof` MUST be present on any counter sent to an RFQ that has `budget_commitment`
- `budget_proof` MUST be absent on any counter sent to an RFQ that has no `budget_commitment`

### 5.7 RFQ Extension

```json
{
  "rfq_id": "uuid-v4",
  "protocol": "ghost-bazaar-v4",
  "buyer": "did:key:z6Mk...",
  "service_type": "ghost-bazaar:services:smart-contract-audit",
  "spec": { ... },
  "anchor_price": "35.00",
  "currency": "USDC",
  "deadline": "2026-03-13T12:01:00Z",
  "budget_commitment": "poseidon:1a2b3c4d5e6f...",
  "signature": "ed25519:..."
}
```

`budget_commitment` is optional but SHOULD be included when the buyer intends to send counter-offers. If present, the engine requires `budget_proof` on all subsequent counters from this buyer for this RFQ.

The commitment is included in the canonical JSON that the buyer signs, binding the buyer to this commitment for the session.

### 5.8 ZK Layer Public Interface

```typescript
// packages/zk/src/commitment.ts
function generateBudgetCommitment(
  budget_hard: string,  // decimal string, e.g. "45.00"
  salt: bigint          // random 254-bit field element
): string              // "poseidon:<32-byte-hex>"

// packages/zk/src/prover.ts
async function generateBudgetProof(
  counter_price: string,  // decimal string
  budget_hard: string,    // decimal string
  salt: bigint            // same salt used in generateBudgetCommitment
): Promise<BudgetProof>   // {protocol, curve, counter_price_scaled, pi_a, pi_b, pi_c}

// packages/zk/src/verifier.ts
async function verifyBudgetProof(
  proof: BudgetProof,
  counter_price_scaled: bigint,  // normalizeAmount(counter.price, usdc_mint)
  budget_commitment: string      // from rfq.budget_commitment, format: "poseidon:<32-byte-hex>"
): Promise<boolean>
// Implementation note: vkey is loaded once at module init:
//   import vkey from "../keys/vkey.json" assert { type: "json" }
// snarkjs.groth16.verify(vkey, publicSignals, proof) requires:
//   publicSignals = [
//     counter_price_scaled.toString(),                    // decimal string
//     BigInt("0x" + budget_commitment.slice(9)).toString() // strip "poseidon:" prefix (9 chars), hex→decimal
//   ]
// Signal order matches the circuit's {public [counter_price_scaled, budget_commitment]} declaration.

// packages/zk/src/scale.ts
function scalePrice(decimalStr: string): bigint   // "36.50" → 36_500_000n
function unscalePrice(scaled: bigint): string     // 36_500_000n → "36.50"
```

### 5.9 Engine Verification Flows

#### RFQ Submission Verification (POST /rfqs)

```
1. Parse and validate RFQ schema (Protocol Core)
2. Verify rfq.protocol === "ghost-bazaar-v4"
   → 422 malformed_payload if unknown version
3. Verify rfq.anchor_price is a valid positive decimal string
   → 422 invalid_amount
4. Verify rfq.deadline is in the future
   → 422 invalid_deadline
5. If rfq.budget_commitment present, verify format "poseidon:<64-hex-chars>"
   → 422 invalid_budget_commitment_format
6. Verify rfq.currency is supported
   → 422 currency_mismatch
7. Verify buyer Ed25519 signature
   → 401 invalid_signature
8. Create session in OPEN state
9. Return 201
```

#### Offer Submission Verification (POST /rfqs/:id/offers)

```
1. Parse and validate Offer schema (Protocol Core)
2. Retrieve RFQ for rfq_id
3. Verify offer.price is a valid positive decimal string
   → 422 invalid_amount
4. Verify offer.currency === rfq.currency
   → 422 currency_mismatch
5. Verify offer.valid_until is in the future
   → 422 invalid_expiry
6. Validate seller Ed25519 signature
   → 401 invalid_signature
7. Check state allows offers (OPEN or NEGOTIATING)
   → 409 invalid_state_transition
8. If state is OPEN, transition to NEGOTIATING
9. Append event to log
10. Return 201
```

#### Counter-Offer Verification (POST /rfqs/:id/counter)

When `POST /rfqs/:id/counter` is received:

```
1. Parse and validate CounterOffer schema (Protocol Core)
2. Retrieve RFQ for rfq_id
3. Verify counter.price is a valid positive decimal string
   → 422 invalid_amount if invalid
4. Verify counter.currency === rfq.currency
   → 422 currency_mismatch if not equal
5. Verify counter.valid_until is in the future
   → 422 invalid_expiry if expired
6. Verify counter.from === rfq.buyer (only the original RFQ buyer may counter)
   → 422 unauthorized_counter if mismatch
7. If rfq.budget_commitment is present:
     a. Check counter.budget_proof is present
        → 422 missing_budget_proof if absent
     b. Compute expected_scaled = normalizeAmount(counter.price, mint_for(rfq.currency))
     c. Check counter.budget_proof.counter_price_scaled === expected_scaled.toString()
        → 422 proof_price_mismatch if not equal
     d. Verify proof:
        result = await verifyBudgetProof(
          counter.budget_proof,
          expected_scaled,
          rfq.budget_commitment
        )
        → 422 invalid_budget_proof if result is false
   If rfq.budget_commitment is absent and counter.budget_proof is present:
        → 422 unexpected_budget_proof
8. Validate BUYER Ed25519 signature on CounterOffer
   → 401 invalid_buyer_signature if invalid
9. Check state machine allows counter (state is NEGOTIATING)
   → 409 invalid_state_transition if not
10. Validate counter.round is monotonically increasing per rfq_id
    → 422 invalid_round if not
11. Append event to log
12. Return 201
```

The engine treats a failed ZK proof the same as an invalid signature: the counter is rejected before touching the event log.

### 5.10 Agent Runtime: Proof Generation Sequence

When `BuyerAgent.sendCounter(seller, price)` is called:

```
1. strategy.onOffersReceived(ctx) → BuyerAction {type:"counter", price}
2. sanitizeBuyerAction(action, priv) → safe_action         // price ≤ budget_hard
3. Deadline guard: if time_remaining_ms < 500, skip counter (insufficient time for proof + network round-trip)
4. zk.generateBudgetProof(safe_action.price, priv.budget_hard, session.salt)
   → BudgetProof                                           // ~200ms on modern hardware
5. Build CounterOffer object with budget_proof attached
6. Sign CounterOffer with buyer Ed25519 keypair
7. POST /rfqs/:id/counter
```

Step 3 runs snarkjs WASM in-process. Proof generation for a circuit of this size takes ~150-250ms. This is acceptable within a negotiation round window.

---

## 6. MCP Server Detail

### 6.1 Transport

- Primary: stdio (works with Claude Desktop out of the box)
- Secondary: HTTP/SSE (works with Claude SDK and remote agents)
- Both exposed from the same server; transport is a startup flag

### 6.2 Tool Catalog

**Buyer tools**

| Tool | Input | Output | Notes |
|------|-------|--------|-------|
| `ghost_bazaar_browse_listings` | `{category?}` | `Listing[]` | Calls GET /listings |
| `ghost_bazaar_post_rfq` | `{service_type, spec, anchor_price, budget_soft, budget_hard, deadline_seconds}` | `{rfq_id}` | Generates commitment, signs RFQ. `budget_soft` defaults to `anchor_price` if omitted. |
| `ghost_bazaar_get_offers` | `{rfq_id}` | `SellerOffer[]` | Polls event log |
| `ghost_bazaar_counter` | `{rfq_id, seller_did, price}` | `{counter_id}` | Generates ZK proof + sanitizer before POST |
| `ghost_bazaar_accept` | `{rfq_id, seller_did}` | `{quote}` | Triggers COMMIT_PENDING |
| `ghost_bazaar_settle` | `{quote}` | `{tx_sig, explorer_url, settlement_ms}` | Builds + sends Solana tx |

**Seller tools**

| Tool | Input | Output | Notes |
|------|-------|--------|-------|
| `ghost_bazaar_register_listing` | `{title, category, base_terms, negotiation_profile}` | `{listing_id}` | Signs listing |
| `ghost_bazaar_get_rfqs` | `{category?}` | `RFQ[]` | Finds open RFQs |
| `ghost_bazaar_respond_offer` | `{rfq_id, price}` | `{offer_id}` | Signs with agent keypair |
| `ghost_bazaar_respond_counter` | `{rfq_id, counter_id, price}` | `{offer_id}` | Sanitizer runs before POST |
| `ghost_bazaar_check_events` | `{rfq_id}` | `NegotiationEvent[]` | Full event log for rfq |

`ghost_bazaar_post_rfq` accepts `budget_hard` as an input but never exposes it in any output or log. It derives the `budget_commitment` internally and includes it in the RFQ payload. The MCP caller only sees `{rfq_id}`.

**Privacy warning:** `budget_hard` is accepted as a tool input but MUST be stored only in the agent's local `BuyerPrivate` state. It MUST NOT appear in any MCP tool output, event log, or error message. MCP transport (stdio or HTTP/SSE) may be observable; the commitment hash is safe to expose but the raw value is not.

`ghost_bazaar_counter` accepts a `price` from the caller (which may be Claude reasoning about strategy), generates the ZK proof automatically, and fires the counter. Proof generation is transparent to the MCP caller.

### 6.3 Keypair and Configuration Injection

Agent Runtime is constructed with a Solana `Keypair` loaded from environment. The MCP server and demo scripts pass this keypair to `BuyerAgent` / `SellerAgent` at construction time.

```typescript
// Environment variables (required)
// SOLANA_KEYPAIR      — base58-encoded 64-byte secret key (preferred)
// SOLANA_KEYPAIR_PATH — path to a JSON keypair file (fallback)
// SOLANA_RPC_URL      — RPC endpoint, e.g. https://api.devnet.solana.com
// NEGOTIATION_ENGINE_URL — base URL of the running engine server
// ANTHROPIC_API_KEY   — required only if using LLMBuyerStrategy / LLMSellerStrategy

// Loading logic (packages/agents/src/config.ts):
function loadKeypair(): Keypair {
  if (process.env.SOLANA_KEYPAIR) {
    const bytes = bs58.decode(process.env.SOLANA_KEYPAIR)
    return Keypair.fromSecretKey(bytes)
  }
  if (process.env.SOLANA_KEYPAIR_PATH) {
    const json = JSON.parse(fs.readFileSync(process.env.SOLANA_KEYPAIR_PATH, "utf8"))
    return Keypair.fromSecretKey(Uint8Array.from(json))
  }
  throw new Error("SOLANA_KEYPAIR or SOLANA_KEYPAIR_PATH must be set")
}
```

The commitment salt is generated internally by `BuyerAgent` on construction and never exposed.

### 6.4 What the MCP Server Does Not Own

- Strategy decisions — those remain in Strategy SDK, called via Agent Runtime
- Signing — Agent Runtime holds the keypair; MCP server calls into it
- ZK proof generation — Agent Runtime calls the ZK layer; MCP server calls into Agent Runtime
- State — MCP server is stateless; all state is in Negotiation Engine

### 6.5 MCP Agent Demo Flow

```
User → Claude Desktop:
  "Find me the best price for a smart contract audit.
   I want to pay around 40 USDC but won't go above 45."

Claude calls:
  ghost_bazaar_browse_listings({category: "services"})
  → 3 sellers: FirmSeller (50 USDC base), FlexibleSeller (38 USDC base),
                CompetitiveSeller (42 USDC base)

  ghost_bazaar_post_rfq({
    service_type: "ghost-bazaar:services:smart-contract-audit",
    anchor_price: "35.00",
    budget_hard: "45.00",   ← internal only; commitment published in RFQ
    deadline_seconds: 60
  })
  → {rfq_id: "abc-123"}
  [RFQ sent with budget_commitment: "poseidon:1a2b..."]

  [round 1]   ← round = offer/counter exchange; round 1 = initial offers + buyer's first counter
  ghost_bazaar_get_offers({rfq_id: "abc-123"})
  → FlexibleSeller: 37.00, FirmSeller: 44.00, CompetitiveSeller: 41.00

  ghost_bazaar_counter({rfq_id: "abc-123", seller: FlexibleSeller, price: "36.00"})
  [ZK proof generated automatically: proves 36.00 ≤ committed ceiling]
  → {counter_id: "def-456"}

  [round 2]
  ghost_bazaar_get_offers({rfq_id: "abc-123"})
  → FlexibleSeller revised: 36.50

  ghost_bazaar_accept({rfq_id: "abc-123", seller: FlexibleSeller})
  → {quote: {final_price: "36.50", buyer_sig, seller_sig}}

  ghost_bazaar_settle({quote: ...})
  → {tx_sig: "5j7s...", explorer_url: "...", settlement_ms: 412}

Claude responds to user:
  "Done. Negotiated 36.50 USDC (vs 38.00 listed, 3.9% savings).
   Every counter I sent carried a zero-knowledge proof that my bid
   was below my ceiling — without revealing what that ceiling was.
   Settled on Solana in 412ms.
   Receipt: https://explorer.solana.com/tx/5j7s..."
```

---

## 7. Data Flow — Full Negotiation Lifecycle

```
BUYER AGENT / MCP          NEGOTIATION ENGINE              SELLER AGENT(S)
        │                          │                               │
        │  generate commitment     │                               │
        │  Poseidon(budget_hard,   │                               │
        │           salt)          │                               │
        │── POST /rfqs ───────────>│                               │
        │   rfq_id, anchor_price   │                               │
        │   buyer: did:key:z6Mk    │                               │
        │   budget_commitment      │                               │
        │   deadline, sig          │── GET /listings (poll) ──────>│
        │                          │<── 200 {listings[]} ─────────│
        │                          │                               │
        │                          │<── POST /rfqs/:id/offers ────│
        │                          │    price: "38.00", sig        │
        │<── GET /rfqs/:id/events──│                               │
        │    [{offer_received,     │                               │
        │      seller, price}]     │                               │
        │                          │                               │
        │  strategy / LLM decides  │                               │
        │  → BuyerAction: counter  │                               │
        │  → sanitizer: ≤ budget_hard                             │
        │  → ZK: generateBudgetProof(                             │
        │       "36.00", budget_hard, salt)                        │
        │    → BudgetProof (~200ms)                                │
        │                          │                               │
        │── POST /rfqs/:id/counter>│                               │
        │   price: "36.00"         │  verify budget_proof:         │
        │   budget_proof: {        │  1. cross-check scaled price  │
        │     pi_a, pi_b, pi_c,    │  2. verifyBudgetProof()       │
        │     counter_price_scaled │  → 422 if invalid             │
        │   }                      │  → 201 if valid               │
        │   to: seller_did, round:1│── event: counter_received ──>│
        │                          │                               │
        │                          │  strategy / LLM decides       │
        │                          │  → SellerAction: respond      │
        │                          │  → sanitizer: ≥ floor_price  │
        │                          │                               │
        │                          │<── POST /rfqs/:id/offers ────│
        │                          │    price: "36.50", round: 2   │
        │                          │                               │
        │  [N rounds ≤ deadline]   │                               │
        │                          │                               │
        │── POST /rfqs/:id/accept >│── event: commit_pending ─────>│
        │   seller: FlexibleSeller │                               │
        │                          │  seller co-signs quote        │
        │                          │<── PUT /rfqs/:id/cosign ─────│
        │                          │    seller_signature           │
        │                          │                               │
        │                          │  state → COMMITTED            │
        │                          │  committed_at = now() ← timer │
        │<── Signed Quote ─────────│                               │
        │    final_price: "36.50"  │                               │
        │    buyer_sig, seller_sig │                               │
        │                          │                               │
        ▼
SETTLEMENT LAYER
        │
        │  Build Solana tx:
        │  · SPL USDC transfer: buyer→seller, amount=36.50 USDC (36_500_000 micro-USDC)
        │  · Memo instruction: quote_id
        │  Sign with buyer Solana keypair
        │  sendAndConfirmTransaction()
        │  confirmed_at = now() ← timer end
        │
        │── POST /execute ────────────────────────────────────────>│
        │   Payment-Signature: base58_tx_sig                       │
        │   X-Ghost-Bazaar-Quote: base64_canonical_quote               │
        │                                                          │
        │                          17-step validation              │
        │                          write nonce PDA account        │
        │                          (deal receipt PDA: week-2)     │
        │                                                          │
        │<── 200 {                                                  │
        │      receipt: {                  ← signed JSON MVP       │
        │        quote_id, final_price,                            │
        │        buyer_pubkey, seller_pubkey, settled_at           │
        │      },                                                  │
        │      explorer_tx: "https://explorer.solana.com/tx/...", │
        │      settlement_ms: 412                                  │
        │    }                                                     │
        ▼
DEMO SHELL
  negotiation rounds:   2
  negotiation time:     ~3.8s
  ZK proofs verified:   1 ✓
  settlement time:      412ms  ← Solana speed
  savings vs listed:    1.50 USDC (3.9%)
  [View tx + Memo on Solana Explorer]
```

---

## 8. Strategy SDK Specification

### 8.1 Core Types

```typescript
// Private state — never crosses protocol boundary
type BuyerPrivate  = { budget_soft: Decimal; budget_hard: Decimal }
type SellerPrivate = { floor_price: Decimal; target_price: Decimal }

// Strategy context — public protocol state + local private state
type BuyerStrategyContext = {
  rfq:               RFQ
  private:           BuyerPrivate          // local process only
  current_offers:    SellerOffer[]
  counters_sent:     CounterOffer[]
  round:             number
  time_remaining_ms: number
  history:           NegotiationEvent[]
}

type SellerStrategyContext = {
  rfq:               RFQ
  private:           SellerPrivate         // local process only
  latest_counter:    CounterOffer | null
  own_offers:        SellerOffer[]
  round:             number
  time_remaining_ms: number
  competing_sellers: number
  seller_listing_profile: NegotiationProfile | null  // from seller's own listing.negotiation_profile
  // v4 alignment: v4 Section 11.1 uses `seller_listing_profile` (from seller's
  // own listing) for seller self-awareness, matching this design.
  // NegotiationProfile = { style: "firm"|"flexible"|"competitive"|"deadline-sensitive",
  //                         max_rounds?: number, accepts_counter?: boolean }
  // Populated from the seller's own listing metadata for self-awareness.
  // Also available: buyer-side signals could be added to RFQ in a future extension.
  // Non-binding hint — strategy may ignore it.
}

// Action types — strategy returns these; Agent Runtime handles ZK proof separately
type BuyerAction =
  | { type: "counter"; seller: DID; price: Decimal }
  | { type: "accept";  seller: DID }
  | { type: "wait" }
  | { type: "cancel" }

type SellerAction =
  | { type: "respond"; price: Decimal }
  | { type: "counter"; price: Decimal }
  | { type: "hold" }
  | { type: "decline" }
```

`BuyerAction` does not carry a `budget_proof` field. Strategy is responsible for the price decision only. The Agent Runtime attaches the proof after sanitization. This keeps the strategy interface clean and ensures no strategy implementation can accidentally bypass or omit the ZK step.

### 8.2 Strategy Interface

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

### 8.3 CompetitiveSeller Reference Implementation

```typescript
// CompetitiveSeller: concedes faster when facing competition; holds firm when sole responder.
// competing_sellers is the count of other active sellers visible from the event log.
class CompetitiveSeller implements SellerStrategy {
  onRfqReceived(ctx: SellerStrategyContext): SellerAction {
    // Open at target_price regardless of competition
    return { type: "respond", price: ctx.private.target_price }
  }

  onCounterReceived(ctx: SellerStrategyContext): SellerAction {
    const counter = ctx.latest_counter
    if (!counter) return { type: "hold" }

    const max_concession = ctx.private.target_price.minus(ctx.private.floor_price)
    const base_step = max_concession.div(5)  // 5 expected rounds

    // Concede faster under competition, hold firmer when sole responder
    const multiplier = ctx.competing_sellers >= 2 ? 1.5 : 0.5
    const concession = base_step.mul(multiplier)
    const new_price = ctx.private.target_price.minus(
      concession.mul(ctx.round)
    )

    // Never cross floor — offer at floor rather than declining outright
    // (declining forfeits the deal; offering at floor keeps the door open)
    // Sanitizer also enforces this as defense-in-depth
    if (new_price.lte(ctx.private.floor_price)) {
      return { type: "counter", price: ctx.private.floor_price }
    }
    return { type: "counter", price: new_price }
  }
}
```

### 8.4 Privacy Sanitizer

```typescript
// Runs after every strategy call. Cannot be bypassed.
// ZK proof generation happens AFTER this, in the Agent Runtime.
function sanitizeBuyerAction(action: BuyerAction, priv: BuyerPrivate): BuyerAction {
  if (action.type === "counter") {
    return { ...action, price: Decimal.min(action.price, priv.budget_hard) }
  }
  return action
}

function sanitizeSellerAction(action: SellerAction, priv: SellerPrivate): SellerAction {
  if (action.type === "respond" || action.type === "counter") {
    return { ...action, price: Decimal.max(action.price, priv.floor_price) }
  }
  return action
}
```

The sanitizer and ZK proof provide two independent enforcement layers:
- Sanitizer: prevents the strategy from producing an out-of-range price before the counter is sent
- ZK proof: allows the engine and counterpart to verify independently that any counter they receive was within the committed range

### 8.5 LLM Strategy Privacy Model

The LLM receives public context only. Private state is injected as natural language constraints in the system prompt, never as structured JSON fields.

```typescript
// CORRECT — private state as system prompt constraints
const system = `You are a buyer agent negotiating for: ${ctx.rfq.service_type}.
Your price target is ${ctx.private.budget_soft} USDC.
Do not exceed ${ctx.private.budget_hard} USDC under any circumstances.
Return JSON matching exactly: { "type": "counter" | "accept" | "wait" | "cancel", "seller"?: string, "price"?: string }`

// CORRECT — user message contains only public context
const user = JSON.stringify({
  round: ctx.round,
  time_remaining_seconds: Math.floor(ctx.time_remaining_ms / 1000),
  current_offers: ctx.current_offers.map(o => ({
    seller: o.seller,
    price: o.price,
    valid_until: o.valid_until
  }))
  // budget_hard, budget_soft are NOT here — they appear only in system prompt
})
```

The sanitizer caps the output price. The ZK proof enforces the same cap cryptographically. A hallucinating LLM that returns a price above `budget_hard` will be caught by the sanitizer and the counter will carry a valid proof for the capped price.

---

## 9. Solana Integration Points

| Integration | Mechanism | Package |
|-------------|-----------|---------|
| Agent identity | Solana keypair → did:key derivation | core |
| RFQ/Offer/Counter signing | Ed25519 sign with @noble/ed25519 | core |
| USDC transfer | SPL token transfer instruction | settlement |
| Memo binding | Memo program instruction, contains quote_id | settlement |
| Nonce replay protection | MVP: in-memory `Set<string>` on seller; week-2: PDA via Anchor program | settlement |
| Deal receipt | MVP: signed JSON in 200 response; week-2: PDA via Anchor program | settlement |
| On-chain verification | getTransaction RPC, commitment: "confirmed" | settlement |
| Settlement timer | Date.now() delta, committed_at → confirmed_at | settlement |
| ZK commitment | Poseidon hash, published in RFQ | zk, core |
| ZK proof | Groth16, verified in engine on each counter | zk, engine |

**USDC mint addresses:**
```
Mainnet: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v  (6 decimals)
Devnet:  4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU   (6 decimals)
```

**Nonce consumption (MVP):**
```typescript
// MVP: in-memory nonce set on the seller's process.
// Checked at settlement step 14, persisted at step 17.
// Nonces are keyed by quote_id.
const consumedNonces = new Set<string>()

function isNonceConsumed(quote_id: string): boolean {
  return consumedNonces.has(quote_id)
}

function consumeNonce(quote_id: string): void {
  consumedNonces.add(quote_id)
}
```

**Nonce consumption (week-2 Anchor bonus):**
```typescript
// Week-2: PDA account via custom Anchor program.
// System Program CANNOT create accounts at arbitrary PDAs — a custom program
// that owns the PDA and exposes a "consume nonce" instruction is required.
// const [noncePda] = PublicKey.findProgramAddressSync(
//   [Buffer.from("ghost_bazaar_nonce"), Buffer.from(quote_id_bytes)],
//   GHOST_BAZAAR_PROGRAM_ID   // custom Anchor program, NOT SystemProgram
// )
```

---

## 10. Monorepo Structure

```
ghost-bazaar/
├── packages/
│   ├── core/               # Layer 2 — Protocol Core (pure, no I/O)
│   │   ├── src/
│   │   │   ├── schemas.ts        # RFQ, Offer, Counter, Quote types
│   │   │   │                     # Counter schema includes optional budget_proof field
│   │   │   │                     # RFQ schema includes optional budget_commitment field
│   │   │   ├── signing.ts        # Ed25519 sign/verify, DID derivation
│   │   │   ├── canonical.ts      # Deterministic JSON serialization
│   │   │   └── amounts.ts        # SPL decimal normalization, no floats
│   │   └── tests/
│   │
│   ├── zk/                 # Layer 3 — ZK Budget Proof (pure, no I/O)
│   │   ├── circuits/
│   │   │   └── BudgetRangeProof.circom
│   │   ├── build/           # gitignored — generated artifacts
│   │   │   ├── BudgetRangeProof_js/
│   │   │   │   └── BudgetRangeProof.wasm
│   │   │   └── BudgetRangeProof_final.zkey
│   │   ├── keys/
│   │   │   └── vkey.json         # verification key — committed to git
│   │   ├── src/
│   │   │   ├── commitment.ts     # generateBudgetCommitment()
│   │   │   ├── prover.ts         # generateBudgetProof() via snarkjs
│   │   │   ├── verifier.ts       # verifyBudgetProof() via snarkjs
│   │   │   └── scale.ts          # scalePrice(), unscalePrice()
│   │   └── tests/
│   │       └── budget-range-proof.test.ts
│   │
│   ├── strategy/           # Layer 5 — Strategy SDK
│   │   ├── src/
│   │   │   ├── interfaces.ts          # BuyerStrategy, SellerStrategy
│   │   │   ├── sanitizer.ts           # Privacy sanitizer (non-bypassable)
│   │   │   ├── linear-concession.ts   # LinearConcessionBuyer
│   │   │   ├── time-weighted.ts       # TimeWeightedBuyer
│   │   │   ├── competitive.ts         # CompetitiveBuyer
│   │   │   ├── firm-seller.ts         # FirmSeller
│   │   │   ├── flexible-seller.ts     # FlexibleSeller
│   │   │   ├── competitive-seller.ts  # CompetitiveSeller
│   │   │   └── llm-strategy.ts        # LLMBuyerStrategy, LLMSellerStrategy
│   │   └── tests/
│   │
│   ├── engine/             # Layer 4 — Negotiation Engine
│   │   ├── src/
│   │   │   ├── server.ts         # Hono app, route registration
│   │   │   ├── routes/
│   │   │   │   ├── listings.ts
│   │   │   │   ├── rfqs.ts       # includes counter route with ZK verification
│   │   │   │   └── events.ts
│   │   │   ├── state-machine.ts  # State transitions, 409 on invalid
│   │   │   ├── event-log.ts      # Append-only, in-memory
│   │   │   └── deadline.ts       # setInterval, auto-EXPIRED transitions
│   │   └── tests/
│   │
│   ├── settlement/         # Layer 1 — Settlement + Solana
│   │   ├── src/
│   │   │   ├── execute.ts        # POST /execute, 17-step validation
│   │   │   ├── solana-verify.ts  # getTransaction RPC, SPL amount check
│   │   │   ├── pda-nonce.ts      # Derive + check + create nonce PDA
│   │   │   ├── deal-receipt.ts   # Derive + create deal receipt PDA
│   │   │   └── timer.ts          # committed_at → confirmed_at delta
│   │   └── tests/
│   │
│   ├── agents/             # Layer 6 — Agent Runtime
│   │   ├── src/
│   │   │   ├── buyer-agent.ts    # BuyerAgent: strategy → sanitizer → ZK → POST
│   │   │   ├── seller-agent.ts   # SellerAgent: strategy → sanitizer → POST
│   │   │   └── poll.ts           # Event polling loop
│   │   └── tests/
│   │
│   └── mcp/                # Layer 7 — Ghost Bazaar MCP Server
│       ├── src/
│       │   ├── server.ts         # MCP server, tool registration
│       │   ├── buyer-tools.ts    # 6 buyer tools (ZK transparent to caller)
│       │   ├── seller-tools.ts   # 5 seller tools
│       │   └── transport.ts      # stdio + HTTP/SSE
│       └── tests/
│
├── demo/
│   ├── src/
│   │   ├── scenario.ts     # Demo script: 1 buyer vs 3 sellers
│   │   ├── ui.ts           # Live negotiation event feed (terminal)
│   │   └── metrics.ts      # Settlement timer, ZK proof count, savings display
│   └── README.md
│
└── pnpm-workspace.yaml
```

---

## 11. Tech Stack

| Concern | Choice | Reason |
|---------|--------|--------|
| Language | TypeScript | typed interfaces are the contract between layers |
| HTTP server | Hono | minimal, edge-compatible, fast DX |
| Solana | @solana/web3.js v1 | stable, well-documented |
| SPL Token | @solana/spl-token | USDC transfer + mint decimal lookup |
| Ed25519 | @noble/ed25519 | audited, matches Solana's curve exactly |
| Decimal math | decimal.js | no float precision bugs on prices |
| ZK circuits | circom 2.0 + circomlib | Poseidon + comparators available natively |
| ZK proofs | snarkjs | Groth16 prover/verifier, browser/Node WASM |
| LLM | @anthropic-ai/sdk | Claude API for LLM strategy |
| MCP SDK | @modelcontextprotocol/sdk | official MCP TypeScript SDK |
| Testing | vitest | fast, native ESM |
| Demo UI | terminal (ink) | fast to build, shows event stream live |
| Monorepo | pnpm workspaces | clean package boundaries |

---

## 12. Team Split and Timeline

### Ownership

| Person | Owns | Packages |
|--------|------|---------|
| P1 (ZK researcher) | Duty 1: Protocol Core + Strategy SDK + ZK Budget Proof | core, strategy, zk |
| P3 (engineer, built engine) | Duty 2: Negotiation Engine + Demo UI | engine, demo |
| P2 (engineer) | Duty 3: Settlement + Solana + Agent Runtime + MCP Server | settlement, agents, mcp |

### Day 0 — Pre-work (before week 1 starts, all three people)

| Who | Task |
|-----|------|
| P3 | Generate 4 devnet keypairs (1 buyer, 3 sellers): `solana-keygen new` |
| P3 | Airdrop SOL to each: `solana airdrop 2 <pubkey> --url devnet` |
| P3 | Mint devnet USDC to buyer wallet from devnet USDC faucet program (4zMMC9...) |
| P3 | Set up `.env` file: `SOLANA_RPC_URL`, `SOLANA_KEYPAIR`, `NEGOTIATION_ENGINE_URL` |
| All | Install pnpm, set up monorepo workspace, verify `pnpm install` passes |
| P1 | Download `powersOfTau28_hez_final_12.ptau` (circom trusted setup prereq) |

Devnet USDC: the real devnet USDC mint (`4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`) has a controlled mint authority — you cannot `spl-token mint` to it. Instead, create a **local test USDC** mint that you control: `spl-token create-token --decimals 6 --url devnet` → save the mint address. Then `spl-token create-account <mint> --url devnet` and `spl-token mint <mint> 1000 <buyer_token_account> --url devnet`. Use this test mint address in your `.env` as `USDC_MINT`. For the demo, label it "devnet test USDC" to avoid confusion.

### Week 1 — Core systems working independently

| Day | P1 | P3 (engine/demo) | P2 (settlement/agents/mcp) |
|-----|----|----|-----|
| 1-2 | core: schemas (with budget_commitment + budget_proof fields), canonical JSON, Ed25519 sign/verify, DID derivation | engine: Hono server, /listings, /rfqs routes | settlement: solana-verify, SPL amount check |
| 3 | core: amounts normalization, verifyQuote; zk: circuit skeleton, scalePrice/unscalePrice | engine: state machine, event log | settlement: pda-nonce (existence-only), timer, signed JSON receipt in 200 response |
| 4 | zk: BudgetRangeProof.circom complete, trusted setup (ptau download + zkey gen + vkey export) | engine: /counter (with ZK verification hook, stubbed initially), /accept, /cosign | agents: BuyerAgent, SellerAgent, poll loop |
| 5 | zk: prover.ts + verifier.ts wired to snarkjs; strategy: interfaces, sanitizer, LinearConcession, TimeWeighted, Competitive, FirmSeller, FlexibleSeller | engine: deadline enforcer, all routes tested; ZK verification live in /counter | agents: BuyerAgent sends ZK proof on counter; end-to-end test on devnet |

### Week 2 — Integration, LLM, MCP, demo polish

| Day | P1 | P3 (engine/demo) | P2 (settlement/agents/mcp) |
|-----|----|----|-----|
| 6 | strategy: LLMBuyerStrategy, LLMSellerStrategy; zk: proof generation performance test (target <300ms) | integration: engine ↔ agents full flow | mcp: server scaffold, buyer tools (ZK transparent in ghost_bazaar_counter) |
| 7 | LLM strategy privacy audit; zk: edge cases (price exactly at ceiling, zero price) | demo: scenario.ts, event feed UI | mcp: seller tools, stdio transport |
| 8 | **Integration day** — all layers connected, full flow on devnet including ZK proofs | | |
| 9 | fix integration issues; zk: CI test for proof round-trip | demo: metrics (ZK proof count, settlement timer, Explorer links) | mcp: HTTP/SSE transport, Claude Desktop test |
| 10-11 | buffer / hardening | demo: rehearsal, timing | demo: rehearsal, timing |
| 12-14 | demo prep, pitch, submission | | |

**Critical path dependency:** P3's `/counter` ZK verification requires P1's `verifyBudgetProof` to be importable. P1 MUST export a working (even stubbed) verifier by end of day 3. P3 integrates the real verifier on day 4.

---

## 13. Demo Scenario

**Setup:** 1 buyer agent (LLMBuyerStrategy, `budget_soft`=40 USDC, `budget_hard`=45 USDC) vs 3 seller agents (FirmSeller at 50 USDC target, FlexibleSeller at 38 USDC target, CompetitiveSeller at 42 USDC target). Service: `"ghost-bazaar:services:smart-contract-audit"`.

**What judges see:**

1. Claude Desktop (or terminal) receives: *"Find me the best audit price. I won't go above 45 USDC."*
2. RFQ broadcasts with `budget_commitment` visible in event feed (commitment hash, not the value)
3. Live event feed: 3 offers arrive → Claude counters FlexibleSeller → ZK proof generated and verified (✓ shown) → FlexibleSeller revises → Claude accepts
4. Signed Quote: `final_price: 36.50 USDC` (vs 38.00 listed)
5. Solana tx builds — timer ticking
6. `settlement_ms: 412` — Solana Explorer link opens, Memo instruction shows `quote_id`
7. Signed JSON receipt returned in response — `quote_id`, `final_price`, both pubkeys, `settled_at`

**Demo metrics displayed:**

```
negotiation rounds:   2
ZK proofs verified:   1  ✓ (budget ceiling proven without revealing it)
negotiation time:     3.8s
settlement time:      412ms
price vs listed:      36.50 / 38.00 USDC  (-3.9%)
```

**Talking points:**

- Budget stayed private: sellers never knew the limit was 45 USDC
- Every counter carried a ZK proof — the engine verified the buyer wasn't cheating on their own commitment
- Identity = Solana wallet: no user accounts, no OAuth, no platform
- Platform cannot manipulate price: dual signatures locked it before payment
- Any agent with MCP can participate: Ghost Bazaar is infrastructure, not a walled garden
- Settlement: wallet-to-wallet in 412ms; `quote_id` anchored in Solana Memo instruction, readable on Explorer without a custom program

---

## 14. Error Codes

This implementation uses the v4 error code registry (Section 14) as-is. All error codes below are normative v4 codes.

```
Protocol + Negotiation (from v4):
  malformed_payload             malformed_quote
  invalid_signature             invalid_buyer_signature
  invalid_seller_signature      invalid_payment_signature
  currency_mismatch             invalid_deadline
  invalid_expiry                invalid_nonce_format
  invalid_amount                price_mismatch
  nonce_replayed                quote_expired
  invalid_state_transition

Settlement — Solana (v4 normative codes):
  transaction_not_found         transfer_destination_mismatch
  transaction_failed            transfer_mint_mismatch
  transaction_not_confirmed     memo_missing
  memo_mismatch                 execution_failed

Negotiation Authorization (from v4):
  unauthorized_counter          — counter.from does not match rfq.buyer (422)
  invalid_round                 — counter.round is not monotonically increasing (422)

ZK Budget Proof (from v4):
  invalid_budget_proof          — Groth16 verification returned false
  missing_budget_proof          — counter sent to RFQ with commitment but no proof attached
  invalid_budget_commitment_format — budget_commitment in RFQ is not "poseidon:<64-hex-chars>"
  proof_price_mismatch          — counter.price ≠ budget_proof.counter_price_scaled after scaling
  unexpected_budget_proof       — proof attached to counter for RFQ with no budget_commitment
```

---

## 15. Security Properties

| Property | Mechanism |
|----------|-----------|
| Budget privacy (hiding) | `budget_hard` never appears in protocol messages, LLM user context, or logs; Poseidon commitment is computationally hiding |
| Budget integrity (binding) | Groth16 proof on every counter proves `counter_price ≤ committed_budget_hard`; engine rejects any counter without a valid proof |
| Floor price privacy | `floor_price`/`target_price` never appear in protocol messages or LLM user context |
| Price non-repudiation | Dual Ed25519 signatures on Signed Quote — neither party can deny the agreed price |
| Replay protection | Nonce PDA — if account exists, nonce was consumed; settlement rejects |
| Time-boundedness | RFQ deadline enforced by engine; `quote.expires_at` enforced at settlement |
| Tamper evidence | Any mutation to signed objects invalidates signatures |
| Platform neutrality | Engine relays messages and verifies ZK proofs but cannot forge signatures; dual-sign is peer-to-peer |
| LLM strategy safety | Sanitizer caps output price before ZK proof generation; hallucinated prices above `budget_hard` are capped before the proof is made |
| ZK defense-in-depth | Sanitizer + ZK proof are independent layers; compromising the strategy library cannot produce a valid out-of-range proof |
| Settlement receipt (MVP) | Signed JSON receipt in 200 response body + `quote_id` in Solana Memo instruction; Memo is permanent on-chain, readable from Explorer without a custom program |
| On-chain structured receipt (week-2) | Anchor program deal PDA stores quote_id, final_price, buyer/seller pubkeys, settled_at_slot; fully verifiable without running the engine |

---

## 16. Open Questions (Post-MVP)

- **Anchor program** for nonce + deal receipt (stronger on-chain story; week-2 bonus if P2 finishes early)
- **Seller-side ZK floor price proof** — same circuit structure; seller proves offer ≥ committed floor without revealing floor
- **On-chain ZK verifier program** — move `verifyBudgetProof` into a Solana program for trustless verification without running the engine
- **On-chain listing registry** — permissionless seller discovery without a central engine instance
- **Agent reputation** — PDA-based score derived from settled deal count and price history
- **Multi-seller batch RFQ** — broadcast to all matching listings simultaneously
- **Delivery arbitration** — escrow release tied to service delivery proof
- **ZK batch proofs** — aggregate multiple counter proofs into one for multi-round efficiency

---

*Design approved. Next step: implementation plan via writing-plans.*
