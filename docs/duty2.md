# Duty 2: Negotiation Engine + Demo UI (P3 — Engineer)

## Mission

Deliver the runtime negotiation system that executes Ghost Bazaar phases 1-3 (Discovery → Negotiation → Commitment) and the demo UI for the hackathon presentation.

**Owner:** P3 (engineer who built the engine)
**Packages:** `packages/engine`, `frontend/`
**Spec baseline:** GHOST-BAZAAR-SPEC-v4.md (Sections 5, 7-8)

---

## Product Scope

In scope:

- All negotiation HTTP routes
- Negotiation session state machine
- Append-only event stream (`/rfqs/:id/events`)
- Deadline and offer validity enforcement
- Counter-offer routing, authorization, and ZK proof verification (delegates to Duty 1)
- Quote construction flow (accept → unsigned quote → buyer sign → seller cosign)
- Buyer-driven winner selection (server does NOT auto-select)
- Demo scenario script and live event feed UI

Out of scope:

- Settlement execution and Solana payment verification (Duty 3)
- Strategy decisions and private state (Duty 1)
- Cryptographic primitives and ZK proof generation (Duty 1)
- Agent runtime and MCP server (Duty 3)
- Agent Registry on-chain registration (Duty 3 — `packages/agents`)

---

## Agent Registry Discovery (8004-Solana Integration)

The engine's listing flow now supports optional verified 8004 Agent Registry binding. Sellers may register a listing with an optional `registry_agent_id`; the engine verifies at write time that the discovered on-chain DID matches the seller DID, persists the verified binding, and later enriches listing reads from that persisted binding. (Note: "8004" refers to the Solana Agent Registry program, not an Ethereum ERC standard.)

**Discovery flow:**

1. Seller submits `POST /listings` with a signed listing body and optional `registry_agent_id`. Agent IDs are stringified bigint values assigned by the 8004 registry on-chain.
2. At registration time, the engine verifies `registry_agent_id` via `discoverAgent(agentId)` (from `@ghost-bazaar/agents`) and rejects the write if the discovered DID does not match the seller DID.
3. The verified `registry_agent_id` is stored durably alongside the listing.
4. On `GET /listings`, for each listing with a persisted verified binding, the engine calls `discoverAgent(agentId)` to fetch:
   - ATOM reputation score and total feedback count
   - Agent name and registration URI
   - Ghost Bazaar `did:key` identity (derived from on-chain owner pubkey)
5. The response includes an optional `registry` field on each listing:

```json
{
  "listing_id": "...",
  "seller": "did:key:z6Mk...",
  "title": "Smart Contract Audit",
  "registry": {
    "agent_id": "42",
    "reputation_score": 92.5,
    "total_feedbacks": 47,
    "registered": true
  }
}
```

6. Buyers can use `reputation_score` as a signal when selecting sellers. The strategy layer now has a typed `seller_registry` helper/contract for this data, while full buyer runtime orchestration remains a Duty 3 concern.

**Fallback:** If a seller is not registered in the Agent Registry, the `registry` field is omitted and the listing works exactly as before. Registration is optional and does not gate participation.

---

## API Contract

```
GET  /listings              — list active seller listings (+ optional verified 8004 registry data)
GET  /listings/:id          — single listing + negotiation_profile (+ optional verified 8004 registry data)
POST /listings              — seller creates signed listing (+ optional verified `registry_agent_id`)
POST /rfqs                  — buyer broadcasts RFQ (9-step verification)
POST /rfqs/:id/offers       — seller submits offer (must include signed `listing_id`)
POST /rfqs/:id/counter      — buyer sends counter (verifies budget_proof via Duty 1 ZK library)
POST /rfqs/:id/accept       — buyer selects winner (7-step accept verification)
PUT  /rfqs/:id/quote/sign   — buyer signs unsigned quote
GET  /rfqs/:id/quote        — seller retrieves buyer-signed quote
PUT  /rfqs/:id/cosign       — seller co-signs quote
PUT  /rfqs/:id/decline      — seller declines co-sign (returns to NEGOTIATING)
POST /rfqs/:id/cancel       — deferred; state-machine action exists but public route is not shipped yet
GET  /rfqs/:id/events       — append-only event stream (?after= cursor)
```

Expected responses:

- `201` on listing, RFQ, offer, and counter creation
- `200` on reads and successful accept/cosign/decline
- `400` for malformed request bodies
- `401` for signature verification or authorization failures
- `404` for references to missing resources (e.g. seller with no offers)
- `409` for invalid state transitions
- `422` for semantic validation failures (amount, expiry, currency, ZK proof)

---

## Session State Machine

States:

- `OPEN` — RFQ created, waiting for offers
- `NEGOTIATING` — offers/counters in progress
- `COMMIT_PENDING` — winner selected, co-sign requested
- `COMMITTED` — Signed Quote completed (dual-signed)
- `EXPIRED` — deadline elapsed without deal
- `CANCELLED` — explicit cancellation by buyer (latent state-machine support; public route deferred)

Allowed transitions:

- `OPEN → NEGOTIATING` (triggered on first offer, step 8 of Offer Verification)
- `NEGOTIATING → COMMIT_PENDING` (buyer accepts)
- `COMMIT_PENDING → COMMITTED` (seller cosigns)
- `COMMIT_PENDING → NEGOTIATING` (seller declines co-sign via `PUT /rfqs/:id/decline`)
- `OPEN | NEGOTIATING | COMMIT_PENDING → EXPIRED` (deadline enforcer)
- `OPEN | NEGOTIATING → CANCELLED` (buyer cancels, engine-internal; public HTTP route deferred)

Forbidden transitions return `409 invalid_state_transition`.

---

## Quote Construction Flow (v4 Section 5.6)

18-step flow across accept → buyer sign → seller cosign:

**Accept verification (steps 1-7):**

1. Parse and validate accept request body: `{ "seller": "did:key:z6Mk...", "offer_id": "uuid-v4" }` → `400 malformed_payload`
2. Check state is `NEGOTIATING` → `409 invalid_state_transition`
3. Verify requester is `rfq.buyer` → `401 unauthorized_accept`
4. Verify `seller` DID has submitted at least one offer → `404 seller_not_found`
5. Verify referenced `offer_id` exists and `valid_until` is in the future → `422 invalid_expiry`
6. Transition state to `COMMIT_PENDING`
7. Call `buildUnsignedQuote(input: BuildQuoteInput)` (Duty 1, `@ghost-bazaar/core`) with fields from RFQ + accepted offer, and return unsigned quote

**Buyer sign (steps 8-10):**

8. Buyer receives unsigned quote, signs locally
9. `PUT /rfqs/:id/quote/sign` with `{ "buyer_signature": "ed25519:..." }`
10. Engine stores buyer-signed quote

**Seller cosign (steps 11-18):**

11. Seller retrieves buyer-signed quote via `GET /rfqs/:id/quote`
12. Seller verifies quote fields and buyer signature
13. Seller signs → `PUT /rfqs/:id/cosign` with `{ "seller_signature": "ed25519:..." }`
14. Engine verifies seller signature against `seller_did`
15. Engine verifies buyer signature against `buyer_did`
16. Engine verifies quote fields match the accepted offer and RFQ terms
17. Transition state to `COMMITTED`
18. Append `QUOTE_COMMITTED` event to log and return signed quote

---

## RFQ Submission Verification (9 steps)

When `POST /rfqs` is received:

1. Parse and validate RFQ schema → `400 malformed_payload`
2. Verify `rfq.protocol` equals `"ghost-bazaar-v4"` → `400 malformed_payload`
3. Verify `rfq.anchor_price` is a valid positive decimal string → `422 invalid_amount`
4. Verify `rfq.deadline` is in the future → `422 invalid_deadline`
5. If `rfq.budget_commitment` is present, verify format is `"poseidon:<64-hex-chars>"` → `422 invalid_budget_commitment_format`
6. Verify `rfq.currency === "USDC"` (only supported currency) → `422 unsupported_currency`
7. Validate buyer Ed25519 signature → `401 invalid_buyer_signature`
8. Create session in `OPEN` state, append event to log
9. Return `201`

---

## Counter-Offer Verification (12 steps)

When `POST /rfqs/:id/counter` is received:

1. Parse and validate CounterOffer schema (Duty 1) → `400 malformed_payload`
2. Retrieve RFQ for `rfq_id`
3. Verify `counter.price` is a valid positive decimal string → `422 invalid_amount`
4. Verify `counter.currency === rfq.currency` → `422 currency_mismatch`
5. Verify `counter.valid_until` is in the future → `422 invalid_expiry`
6. Verify `counter.from === rfq.buyer` → `422 unauthorized_counter`; verify `counter.to` references a seller who has submitted an offer → `422 unauthorized_counter`
7. ZK proof verification (if `rfq.budget_commitment` present):
   - a. Check `counter.budget_proof` is present → `422 missing_budget_proof`
   - b. Compute `expected_scaled = normalizeAmount(counter.price, USDC_MINT_ADDRESS)` (from `@ghost-bazaar/core`)
   - c. Check `counter.budget_proof.counter_price_scaled === expected_scaled.toString()` → `422 proof_price_mismatch`
   - d. Verify proof via `verifyBudgetProof()` → `422 invalid_budget_proof`
   - If no commitment but proof present → `422 unexpected_budget_proof`
8. Validate buyer Ed25519 signature → `401 invalid_buyer_signature`
9. Check state machine allows counter (state is `NEGOTIATING`) → `409 invalid_state_transition`
10. Validate `counter.round` is monotonically increasing → `422 invalid_round`
11. Append event to log
12. Return `201`

---

## Offer Verification (10 steps)

When `POST /rfqs/:id/offers` is received:

1. Parse and validate Offer schema (Duty 1) → `400 malformed_payload`
2. Retrieve RFQ
3. Verify `offer.price` is a valid positive decimal string → `422 invalid_amount`
4. Verify `offer.currency === rfq.currency` → `422 currency_mismatch`
5. Verify `offer.valid_until` is in the future → `422 invalid_expiry`
6. Validate seller Ed25519 signature → `401 invalid_seller_signature`
7. Check state allows offers (`OPEN` or `NEGOTIATING`) → `409 invalid_state_transition`
8. If state is `OPEN`, transition to `NEGOTIATING`
9. Append event to log
10. Return `201`

---

## Event Schema (Append-Only)

Event fields:

- `event_id` (monotonic per RFQ)
- `rfq_id`
- `event_type`
- `actor`
- `payload`
- `timestamp`

### Storage Backends

| Backend | Use | Persistence |
|---------|-----|-------------|
| `InMemoryEventStore` | Dev, tests | None — lost on restart |
| `SqliteEventStore` | Production (Fly.io) | SQLite WAL mode, Fly.io persistent volume at `/data` |

Both implement the same `EventStore` / `InternalEventStore` interface. All route and state machine code is storage-agnostic. See [Step 12 Plan](../plans/step12-sqlite-persistence-plan.md).

Required event types:

- `RFQ_CREATED`
- `OFFER_SUBMITTED`
- `COUNTER_SENT`
- `WINNER_SELECTED` (buyer accepts, state enters `COMMIT_PENDING`)
- `COSIGN_DECLINED` (seller declines co-sign, state returns to `NEGOTIATING`)
- `QUOTE_COMMITTED`
- `NEGOTIATION_EXPIRED`
- `NEGOTIATION_CANCELLED`

---

## Deadline Enforcer

- `setInterval` periodically checks all active sessions
- Auto-transitions `OPEN | NEGOTIATING | COMMIT_PENDING → EXPIRED` when `deadline` passes
- Emits `NEGOTIATION_EXPIRED` event

---

## Error Codes (Duty 2 owns)

- `malformed_payload` — request body fails schema validation (400)
- `invalid_state_transition` — action not valid for current state (409)
- `invalid_amount` — price is not a valid positive decimal string (422)
- `invalid_deadline` — RFQ deadline is in the past (422)
- `invalid_expiry` — `valid_until` is in the past (422)
- `invalid_round` — counter round not monotonically increasing (422)
- `unsupported_currency` — RFQ currency is not `USDC` (422)
- `currency_mismatch` — offer/counter currency doesn't match RFQ (422)
- `unauthorized_counter` — `counter.from` does not match `rfq.buyer` (422)
- `unauthorized_accept` — accept by a DID that is not `rfq.buyer` (401)
- `unauthorized_decline` — decline by a DID that is not the accepted seller (401)
- `seller_not_found` — accepted seller has no offers in this RFQ (404)
- `invalid_buyer_signature` — buyer Ed25519 signature verification failed (401)
- `invalid_seller_signature` — seller Ed25519 signature verification failed (401)
- `invalid_budget_commitment_format` — `budget_commitment` not in `"poseidon:<64-hex>"` format (422)

ZK proof errors (delegated from Duty 1 library):

- `invalid_budget_proof` — Groth16 verification returned false
- `missing_budget_proof` — counter to RFQ with commitment but no proof
- `proof_price_mismatch` — counter.price ≠ budget_proof.counter_price_scaled after scaling
- `unexpected_budget_proof` — proof on counter for RFQ without commitment

---

## Demo UI

**Package:** `frontend/`

### Demo Scenario

1 buyer agent (LLMBuyerStrategy, `budget_soft`=40, `budget_hard`=45 USDC) vs 3 seller agents (FirmSeller 42, FlexibleSeller 38, CompetitiveSeller 40). Service: `"ghost-bazaar:services:smart-contract-audit"`.

### Demo Metrics Display (Screen 2)

```
negotiation rounds:   2
ZK proofs verified:   1  ✓
negotiation time:     3.8s
settlement time:      412ms
price vs listed:      36.50 / 38.00 USDC  (-3.9%)
savings vs budget:    8.50 USDC (18.9%) — seller never knew ceiling was 45
agent reputation:     92.5 / 100 (ATOM on-chain, pre-existing)
privacy score:        5/6  ██████████░░ 83%
```

### Privacy Score Metric

The privacy score shows how much sensitive information Ghost Bazaar keeps private vs. what leaks on-chain. Displayed as `N/M` with a progress bar during the demo to highlight Ghost Bazaar's privacy advantage over competing protocols.

**Scoring (6 data points, 1 point each):**

| Data Point | Private? | Mechanism | Score |
|------------|----------|-----------|:-----:|
| Buyer budget (`budget_hard`) | Yes | Never leaves local state; ZK Poseidon commitment in RFQ | +1 |
| Buyer soft target (`budget_soft`) | Yes | Never leaves local state; not in any protocol message | +1 |
| Seller floor price (`floor_price`) | Yes | Never leaves local state; sanitizer enforces bound | +1 |
| Seller target price (`target_price`) | Yes | Never leaves local state; not in any protocol message | +1 |
| Counter-offer budget compliance | Yes | ZK Groth16 proof — sellers verify `counter <= budget_hard` without learning budget | +1 |
| Final settlement amount | No | Visible on-chain in SPL transfer instruction | 0 |

**Score = 5/6 (83%)** when ZK budget proof is used, **4/6 (67%)** when budget commitment is omitted.

**Planned implementation (`frontend/src/privacy-score.ts`):**

```typescript
interface PrivacyScoreInput {
  /** True if the RFQ included a budget_commitment. */
  hasBudgetCommitment: boolean
  /** Number of counter-offers that carried a valid ZK proof. */
  zkProofsVerified: number
}

interface PrivacyScore {
  /** Points earned. */
  score: number
  /** Maximum possible points. */
  max: number
  /** Score as percentage (0-100). */
  percent: number
  /** Per-item breakdown for display. */
  breakdown: Array<{ label: string; private: boolean; mechanism: string }>
}

function computePrivacyScore(input: PrivacyScoreInput): PrivacyScore
```

The breakdown array drives a colored table in the demo UI:
- Green rows: data kept private (buyer budget, seller floor, ZK proof)
- Red row: final amount visible on-chain
- Used in pitch to contrast with competing protocols (x402, Virtuals ACP, ERC-8183) where all pricing data is public

**Future (roadmap slide):** "When Solana USDC enables confidential transfer extensions, Ghost Bazaar achieves 6/6 — full-stack privacy from negotiation to settlement."

### Privacy Split-View (Final Demo Screen)

After the negotiation completes, the demo renders a split-view that shows exactly what each party could see vs. what was hidden. This is the "aha" screen for judges — the entire privacy story in one terminal frame.

**Layout:**

```
┌─ SELLER'S VIEW (public) ─────────────┬─ BUYER'S TRUTH (private) ────────────┐
│                                       │                                       │
│  RFQ received                         │  budget_soft: 40.00 USDC             │
│  service: smart-contract-audit        │  budget_hard: 45.00 USDC             │
│  anchor_price: 35.00 USDC            │  anchor_price: 35.00 USDC            │
│  budget_commitment: poseidon:a3f1...  │  commitment_salt: 0x7e2b...          │
│  (opaque hash — can't reverse)        │  (salt + budget_hard → commitment)   │
│                                       │                                       │
│  My offer: 38.00 USDC                │  Sees all 3 offers:                   │
│  (can't see other sellers' offers)    │  FirmSeller: 42.00                   │
│                                       │  FlexibleSeller: 38.00  ← winner     │
│                                       │  CompetitiveSeller: 40.00            │
│                                       │                                       │
│  Counter received: 36.00 USDC         │  Counter sent: 36.00 USDC            │
│  ZK proof: ✓ valid                    │  ZK proof: counter <= budget_hard     │
│  (proves 36 is within budget          │  (seller verified without learning    │
│   but budget could be 36.01 or 999)   │   that budget_hard = 45.00)          │
│                                       │                                       │
│  Final price: 36.50 USDC             │  Final price: 36.50 USDC             │
│  Signed quote: ✓ dual-signed          │  Saved: 8.50 vs budget (18.9%)       │
│                                       │                                       │
├─ ON-CHAIN (visible to everyone) ──────┼─ NEVER ON-CHAIN ─────────────────────┤
│  SPL transfer: 36.50 USDC   ← leak   │  budget_hard: 45.00                  │
│  Memo: GhostBazaar:quote_id:a1b2...      │  budget_soft: 40.00                  │
│  Agent NFT: registered ✓              │  floor_price: 30.00 (seller)         │
│  ATOM feedback: 92.5/100 (pre-demo)   │  target_price: 38.00 (seller)        │
│                                       │  commitment_salt: 0x7e2b...          │
└───────────────────────────────────────┴───────────────────────────────────────┘
                          privacy score: 5/6 ██████████░░ 83%
```

**Planned implementation (`frontend/src/split-view.ts`):**

The split-view is a pure rendering function. It takes the completed negotiation state and formats two columns:

```typescript
interface SplitViewInput {
  // Public data (from event log — what seller actually saw)
  rfq: RFQ
  sellerOffer: SellerOffer
  counterOffer: CounterOffer
  signedQuote: SignedQuote
  zkProofValid: boolean

  // Private data (from local state — what was hidden)
  buyerPrivate: { budget_soft: string; budget_hard: string }
  sellerPrivate: { floor_price: string; target_price: string }
  commitmentSalt: string
  allOffers: SellerOffer[]   // buyer sees all, seller sees only theirs

  // On-chain data (from settlement)
  splTransferAmount: string
  memoContent: string
  agentRegistered: boolean
  atomFeedbackScore: number | null
  explorerUrl: string
}

function renderSplitView(input: SplitViewInput): string
```

**Data sources — no new logic needed, all data already exists:**

| Column | Source | Already available? |
|--------|--------|--------------------|
| Seller's view (RFQ, single offer, counter, quote) | Engine event log (`GET /rfqs/:id/events`) | Yes (Duty 2) |
| Buyer's truth (all offers, budget, salt) | `BuyerPrivate` + `SellerPrivate` local state | Yes (Duty 1 types) |
| On-chain (SPL transfer, memo, NFT, feedback) | Settlement receipt + 8004 registry | Yes (Duty 3) |
| Privacy score | `computePrivacyScore()` | Yes (planned above) |

**Rendering rules:**
- Left column: normal text for what the seller actually saw; items the seller couldn't see are simply absent
- Right column: green text for private values the seller couldn't see, white for shared values
- Bottom divider: red highlight on the SPL transfer amount (the single leak)
- Progress bar: green fill proportional to score, grey for the missing point
- Use `chalk` for terminal colors (already common in ink-based CLIs)

**Demo flow — 3 screens in sequence:**

1. **Live event feed** — real-time events as negotiation unfolds (existing `ui.ts` plan)
2. **Metrics summary** — negotiation rounds, ZK proofs, times, savings (existing `metrics.ts` plan)
3. **Privacy split-view** — the screenshot moment, shows public vs private side-by-side (new `split-view.ts`)

Screen 3 holds for 10 seconds or until keypress, giving the presenter time to walk through it.

### Protocol Comparison Table (Pitch Slide in Demo)

Optional fourth screen or overlay, shown after the split-view:

```
              Ghost Bazaar vs. Competing Protocols — Privacy Comparison

┌──────────────────────────┬───────────┬───────────┬──────────┬──────────────┐
│ What's protected?        │ Ghost Bazaar  │ Virtuals  │ x402     │ OpenAI/Stripe│
│                          │           │ ACP       │          │ ACP          │
├──────────────────────────┼───────────┼───────────┼──────────┼──────────────┤
│ Buyer budget             │  ✓ ZK     │  ✗        │  N/A     │  ✗           │
│ Seller floor price       │  ✓ local  │  ✗        │  N/A     │  ✗           │
│ Competing offers         │  ✓ asym   │  ✗        │  N/A     │  N/A         │
│ Budget compliance proof  │  ✓ ZK     │  ✗        │  ✗       │  ✗           │
│ Multi-seller competition │  ✓        │  ~        │  ✗       │  ✗           │
│ On-chain reputation      │  ✓ 8004   │  ✗        │  ✗       │  ✗           │
├──────────────────────────┼───────────┼───────────┼──────────┼──────────────┤
│ Privacy score            │  83%      │  0%       │  0%      │  0%          │
└──────────────────────────┴───────────┴───────────┴──────────┴──────────────┘

  "When USDC enables confidential transfers, Ghost Bazaar reaches 100%."
```

**Implementation:** Pure string rendering, no external data needed. Hardcoded comparison based on competitive landscape analysis (`COMPETITIVE-LANDSCAPE.md`).

### Components

- `frontend/src/scenario.ts` — Demo script: 1 buyer vs 3 sellers
- `frontend/src/ui.ts` — Screen 1: live negotiation event feed (terminal, ink)
- `frontend/src/metrics.ts` — Screen 2: settlement timer, ZK proof count, savings display, Explorer links
- `frontend/src/privacy-score.ts` — Privacy score computation + breakdown
- `frontend/src/split-view.ts` — Screen 3: seller-view vs buyer-truth side-by-side
- `frontend/src/comparison.ts` — Screen 4 (optional): protocol comparison table

---

## Acceptance Criteria

0. Listings for 8004-registered sellers include `registry` field with reputation score.
1. No invalid state transition is accepted.
2. Deadline and offer validity are always enforced.
3. Quote construction flow works end-to-end: accept → buyer sign → seller cosign → COMMITTED.
4. Counter-offer verification rejects unauthorized/invalid counters with correct error codes.
5. ZK proof verification blocks invalid proofs before event log.
6. Full event log can reconstruct final state exactly.
7. Demo scenario completes end-to-end with live metrics.
8. Privacy split-view renders correctly showing seller-view vs buyer-truth.
9. Privacy score displays 5/6 (83%) when ZK budget proof is used.

---

## Duty 2 Test Checklist

Listings:

- `POST /listings` creates signed listing and returns `201`
- `GET /listings` returns listings without `registry` field for unregistered sellers
- `GET /listings` includes `registry` field with `reputation_score` for verified 8004-registered sellers
- `GET /listings/:id` returns single listing with negotiation_profile
- same seller can register multiple listings with distinct `listing_id`
- offers with a missing or mismatched `listing_id` are rejected

State Machine:

- State transition matrix (all valid transitions)
- Forbidden transition returns `409`
- Deadline expiry with no deal → `EXPIRED`
- Seller declines co-sign → return to `NEGOTIATING`

Offer/Counter:

- Offer expiry rejection
- Offer currency mismatch rejection
- Counter authorization: `counter.from !== rfq.buyer` → `422`
- Counter currency mismatch → `422`
- Counter expired `valid_until` → `422`
- Counter round monotonicity enforcement
- Counter without proof when RFQ has commitment → `422`
- Counter with proof when RFQ has no commitment → `422`

Accept/Quote:

- Accept with seller who has no offers → `404 seller_not_found`
- Accept with expired offer → `422 invalid_expiry`
- Accept by non-buyer DID → `401`
- `PUT /rfqs/:id/quote/sign` stores buyer signature
- `GET /rfqs/:id/quote` returns buyer-signed quote
- `PUT /rfqs/:id/cosign` completes dual-signed quote
- `PUT /rfqs/:id/decline` by seller returns state to `NEGOTIATING`
- `PUT /rfqs/:id/decline` by non-seller → `401`

RFQ Submission:

- RFQ with unknown `protocol` version → rejected

ZK:

- ZK proof verification on counter (if budget_commitment present)
- Budget commitment format validation on RFQ → `422`

Event Log:

- Event replay reconstruction (full log → identical final state)

---

## Timeline (from Design Spec)

| Day | Tasks |
|-----|-------|
| 1-2 | engine: Hono server, /listings, /rfqs routes |
| 3 | engine: state machine, event log |
| 4 | engine: /counter (with ZK verification hook), /accept, /cosign, /decline, /quote/sign, /quote |
| 5 | engine: deadline enforcer, all routes tested; ZK verification live in /counter |
| 6 | integration: engine ↔ agents full flow |
| 7 | demo: scenario.ts, event feed UI (Screen 1) |
| 8 | **Integration day** — all layers connected |
| 9 | demo: metrics + privacy score (Screen 2), split-view (Screen 3), comparison table (Screen 4) |
| 10-14 | buffer, hardening, demo rehearsal |

**Critical dependency:** Duty 1 MUST export a working `verifyBudgetProof` by end of day 3 so `/counter` route can integrate ZK verification on day 4.
