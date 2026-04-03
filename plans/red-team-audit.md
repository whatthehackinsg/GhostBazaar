# Red Team Audit: Ghost Bazaar Negotiation Engine

**Attacker:** Red Team (Claude Opus 4.6)
**Date:** 2026-03-20
**Scope:** `plans/engine-plan.md` attack surface analysis with code-level exploit chaining
**Baseline:** `plans/engine-security-audit.md` (prior defensive audit)

---

## Attack Category 1: Steal Money (Quote / Payment Manipulation)

### RT-C1: Quote Field Injection via `buildUnsignedQuote` Input Poisoning [CRITICAL]

**Attack goal:** Manipulate `final_price` or `payment_endpoint` in the committed quote so the buyer pays the wrong amount to the wrong address.

**Attack path:**

The `POST /rfqs/:id/accept` handler calls `buildUnsignedQuote(rfq, accepted_offer, buyer_did, seller_did)`. The plan says the engine constructs the quote server-side. But the plan does NOT specify where `payment_endpoint` comes from. Looking at `BuildQuoteInput` in `packages/core/src/quote.ts`, it accepts `payment_endpoint` as a string parameter.

If the engine reads `payment_endpoint` from the **offer** object (and sellers control their offers), a malicious seller submits an offer with a valid price but a `payment_endpoint` pointing to their secondary address. The buyer signs a quote with a `payment_endpoint` they never verified.

But the more dangerous variant: if the engine reads `payment_endpoint` from a **listing** that was enriched via the 8004 registry, an attacker who controls a registry entry can inject a malicious `payment_endpoint` at listing time, which flows into the quote at accept time.

**Exact HTTP requests:**

1. Attacker registers a malicious agent in the 8004 registry with `payment_endpoint: "https://attacker.example.com/execute"`
2. Legitimate buyer creates RFQ
3. Attacker submits valid offer (with their legitimate seller DID)
4. Buyer accepts the attacker's offer
5. Engine calls `buildUnsignedQuote()` with the attacker's `payment_endpoint`
6. Buyer signs the quote (the spec says clients "SHOULD locally reconstruct" but this is documented as client responsibility, not enforced)
7. Attacker's endpoint receives the payment and never executes the service

**Plan's defense:** The plan says "Client-side quote verification (documented contract)" -- but this is advisory, not enforced. Many agent implementations will trust the engine's quote.

**Severity: CRITICAL** -- If the engine sources `payment_endpoint` from mutable/external data without explicit buyer confirmation, money can be stolen. The plan must specify the exact data source for every quote field and fail if any field is ambiguous.

---

### RT-C2: Stale Offer Price Exploitation in Accept Flow [HIGH]

**Attack goal:** Lock in a price that has been superseded by a lower offer.

**Attack path:**

1. Seller submits Offer A at $50 (`offer_id: "aaa"`)
2. Buyer counters; Seller submits Offer B at $35 (`offer_id: "bbb"`)
3. Before the buyer's strategy processes Offer B, a compromised engine (or race condition) processes `POST /accept` with `offer_id: "aaa"` (the $50 offer)

The plan says accept validates "offer valid" and checks `valid_until`. But it does NOT specify whether the engine accepts ANY valid offer from a seller, or only the most recent one. If the buyer's accept envelope contains `offer_id`, and a compromised agent or MITM replays an older accept, the buyer is locked into a higher price.

**Plan's defense:** The signed control envelope includes `offer_id` and `session_revision` (CAS semantics). If the buyer signs the accept with the correct `offer_id`, this attack fails. But if the buyer's agent is compromised or the strategy doesn't track offer freshness, the old offer_id gets signed.

**Severity: HIGH** -- The engine should warn or reject accepts on offers that have been superseded by newer offers from the same seller, or at minimum document this explicitly.

---

### RT-C3: Commitment Timeout Cycle to Drain Buyer Funds [HIGH]

**Attack goal:** Lock a buyer in an endless accept-timeout loop, preventing them from completing any deal before the RFQ deadline.

**Attack path:**

```
POST /rfqs/:id/accept  {seller: "seller_A", offer_id: "..."}
  -> Engine transitions to COMMIT_PENDING, starts 30s commitment timer
  -> Seller A deliberately does NOT cosign
  -> 30s later: engine auto-reverts to NEGOTIATING (COSIGN_TIMEOUT)

POST /rfqs/:id/accept  {seller: "seller_A", offer_id: "..."}
  -> Second attempt for seller_A
  -> Seller A does NOT cosign again
  -> 30s later: COSIGN_TIMEOUT

  # Plan says max 2 attempts per seller. Now try seller_B:
POST /rfqs/:id/accept  {seller: "seller_B", offer_id: "..."}
  -> Seller B (controlled by same attacker) does NOT cosign
  -> 30s later: COSIGN_TIMEOUT

POST /rfqs/:id/accept  {seller: "seller_B", offer_id: "..."}
  -> Second attempt for seller_B -- burns another 30s
```

If the attacker controls N seller identities (Sybil), they can waste `N * 2 * 30s = 60N seconds` of the buyer's deadline. With 5 Sybil sellers = 300 seconds = 5 minutes burned. If the RFQ deadline is 10 minutes, the attacker just consumed half of it.

**Plan's defense:**
- "Max 2 accept attempts per seller per RFQ" -- good but insufficient against Sybil
- The plan mentions 8004 registry for Sybil resistance, but registry enrichment is in `GET /listings`, not in offer submission validation. Any DID can submit an offer.

**Severity: HIGH** -- The engine needs a global accept attempt limit per session (not just per-seller), or a progressively shorter commitment timeout after repeated failures.

---

## Attack Category 2: Grief Other Agents

### RT-H1: Session Lock Starvation via Burst Requests [HIGH]

**Attack goal:** Lock out a legitimate seller from submitting their offer during a critical negotiation window.

**Attack path:**

The plan specifies a per-session lock queue bounded at 10. The attacker sends 10 simultaneous `POST /rfqs/:id/offers` with different seller DIDs (each requiring a new Ed25519 keypair -- cheap to generate). Each request holds the lock for the duration of validation (~50ms for ZK, ~1ms for sig verification).

The legitimate seller's 11th request gets `429 Too Many Requests`.

```
# Attacker sends 10 concurrent offer requests
for i in 1..10:
  POST /rfqs/:id/offers
  Body: {offer_id: uuid(), rfq_id: "target", seller: "did:key:z6MkAttacker{i}",
         price: "999.00", currency: "USDC", valid_until: "+5min",
         signature: "ed25519:<valid_sig_for_attacker_i>"}
```

Even though these offers are at absurd prices (no buyer would accept), they consume lock queue slots.

**Plan's defense:**
- Rate limit: 100 req/min per IP, 10 RFQs/min per DID. But offer submission is not DID-rate-limited per session.
- Lock queue: max 10 pending. But 10 concurrent requests from 10 different DIDs all targeting the same session saturate the queue.

**Severity: HIGH** -- The plan rate-limits RFQ creation per DID but does NOT rate-limit offer submission per session. An attacker with 10 keypairs (trivial to generate) can monopolize any session's lock queue.

**Fix:** Add per-session offer rate limiting (e.g., max 3 offers per DID per session, max 20 total offers per session).

---

### RT-H2: Event Cap Exhaustion via Counter Spam [HIGH]

**Attack goal:** Force a session to hit the 500-event cap, auto-expiring it before a legitimate deal can close.

**Attack path:**

The buyer is the only party who can send counters. But offers are unlimited from sellers. Each offer appends an `OFFER_SUBMITTED` event. If an attacker controls multiple seller DIDs:

```
for i in 1..500:
  POST /rfqs/:id/offers
  Body: {offer_id: uuid(), seller: "did:key:z6MkSybil{i % 50}",
         price: "{random_valid_price}", ...valid signature...}
```

500 offers = 500 events = session auto-expires via `SESSION_EVENT_LIMIT`.

**Plan's defense:** Per-session event cap of 500 triggers auto-expire. This is DEFENSIVE against memory exhaustion but OFFENSIVE against the buyer -- an attacker who floods offers kills the buyer's session.

**Severity: HIGH** -- The 500-event cap is a DoS vector. The plan should either: (a) count events per-actor and cap sellers individually, (b) not count offers toward the session cap (only count counters + state transitions), or (c) allow the buyer to "close" the session to new offers once negotiation is underway.

---

### RT-H3: Phantom Seller Grief via Accept-Decline Loop [MEDIUM]

**Attack goal:** Waste buyer's time by accepting selection then declining cosign.

**Attack path:**

Seller submits a competitive offer, gets accepted. Then the seller reads the quote via `GET /rfqs/:id/quote` and immediately submits a decline (or simply waits for timeout). The buyer wasted 30 seconds. With the 2-attempt limit, the seller can do this twice.

This is acknowledged by the plan's commitment timeout mechanism, but the 30-second window is generous. If seller response time for legitimate cosigning is typically <5 seconds, the timeout could be tighter.

**Severity: MEDIUM** -- The plan addresses this with the 30s timeout and 2-attempt limit. Could be improved with adaptive timeout (e.g., 10s for first attempt, 5s for second).

---

## Attack Category 3: Leak Private Information

### RT-C4: Budget Commitment Brute Force via Counter Price Probing [CRITICAL]

**Attack goal:** Discover the buyer's `budget_hard` from the `budget_commitment` in the RFQ.

**Attack path:**

The commitment is `Poseidon([budget_hard_scaled, commitment_salt])`. The salt is 254-bit, so brute-forcing the commitment directly is infeasible. However, the attacker can use the **counter price oracle**:

1. Buyer publishes RFQ with `budget_commitment`
2. Attacker (posing as seller) submits offer at $100
3. Buyer's strategy produces a counter at price P. The counter includes a `budget_proof` proving `P <= budget_hard`
4. Attacker observes P. If the buyer's strategy leaks information (e.g., always counters at `budget_soft`, or at a fixed percentage of `budget_hard`), the attacker narrows the range.

This isn't an engine attack per se -- it's a strategy information leak. But the ENGINE enables it by allowing any seller to receive counters and their associated ZK proofs.

**More concerning:** If the buyer's strategy always sends the same counter to all sellers, ALL sellers see the same counter price. Each seller knows `counter_price <= budget_hard`. After multiple rounds where the buyer raises their counter price, the maximum counter price observed is a tight lower bound on `budget_hard`.

**Plan's defense:** The plan says counters are addressed to specific sellers (`counter.to` field). The role-scoped event view means Seller A shouldn't see counters addressed to Seller B. Good.

But: the buyer's counter prices across rounds with the SAME seller progressively reveal a tighter bound on `budget_hard`. If the buyer sends counter round 1 at $28, round 2 at $32, round 3 at $38 -- the seller knows `budget_hard >= $38`.

**Severity: CRITICAL** -- This is an inherent protocol-level information leak that the ZK proof only partially mitigates. The ZK proof prevents the seller from learning the EXACT `budget_hard`, but rising counter prices reveal a lower bound. The plan should document this limitation and recommend strategy-level mitigations (e.g., never counter above `budget_soft`).

---

### RT-H4: Event Cursor Gap Analysis to Count Competing Sellers [HIGH]

**Attack goal:** Determine how many sellers are competing in a negotiation.

**Attack path:**

As documented in the prior audit (H5), if event IDs are sequential integers and sellers only see their own events, gaps reveal the existence of other events.

```
GET /rfqs/:id/events?after=0
# Seller A sees events: [1, 5, 9, 14]
# Gaps: 2-4, 6-8, 10-13 → at least 3 other sellers with ~3 events each
```

This reveals: (a) number of competing sellers (approximately), (b) pace of negotiation, (c) whether the buyer is actively countering other sellers.

**Plan's defense:** The prior audit flagged this (H5). The plan does not address it. Using opaque cursors (UUIDs) would fix it.

**Severity: HIGH** -- Competitive intelligence leak. Sellers can adjust their strategy based on knowing the number of competitors.

---

### RT-H5: SSE Timing Side Channel [HIGH]

**Attack goal:** Infer when buyer sends counters to other sellers.

**Attack path:**

Even with opaque cursors, the SSE stream delivers events in real time. Seller A is connected via SSE. They receive their own events but NOT other sellers' events. However, they can measure the TIME GAP between events:

- `t=0`: Seller A's offer submitted → event arrives on SSE
- `t=5`: (no event for 5 seconds) → buyer is negotiating with others
- `t=5.2`: Counter arrives for Seller A

The 5-second gap strongly suggests the buyer was processing other sellers' offers. A gap pattern of [offer, 5s pause, counter, 3s pause, counter] reveals the buyer's negotiation cadence.

**Plan's defense:** None. SSE by nature reveals timing. The only mitigation would be introducing artificial random delays before delivering events (adding jitter), which the plan does not mention.

**Severity: HIGH** -- Timing analysis reveals competitive dynamics. Difficult to prevent without adding jitter to event delivery.

---

### RT-M1: ZK Proof Error Messages Could Leak Commitment Details [MEDIUM]

**Attack goal:** Extract information about `budget_hard` or `commitment_salt` from error responses.

**Attack path:**

Submit a counter with a deliberately malformed `budget_proof`. If the `verifyBudgetProof` function throws an error that includes the expected public signals (which include the commitment value converted to decimal), the error message leaks information.

Looking at `verifier.ts` line 30: `BigInt("0x" + budget_commitment.slice(9)).toString()` -- this converts the commitment to decimal. If snarkjs throws with a message like "expected signal X, got Y", the decimal representation of the commitment appears in the error.

**Plan's defense:** The prior audit flagged this (H6). The plan says "Private state MUST NEVER appear in logs" but does not explicitly sanitize snarkjs error messages. The current `verifier.ts` catches all errors and returns `false`, which is good -- but the plan should mandate this pattern for the engine integration.

**Severity: MEDIUM** -- Current code catches errors properly, but the plan should mandate error sanitization for all ZK-related paths.

---

## Attack Category 4: Break Protocol Fairness

### RT-C5: Seller Impersonation on Cosign via Missing Identity Binding [CRITICAL]

**Attack goal:** A non-selected seller cosigns a quote, locking the session with the wrong counterparty.

**Attack path:**

1. Buyer creates RFQ
2. Seller A and Seller B both submit offers
3. Buyer accepts Seller A's offer → `COMMIT_PENDING`, quote built with `seller: Seller_A`
4. Seller B (who was NOT selected) calls `PUT /rfqs/:id/cosign` with their own Ed25519 signature

```
PUT /rfqs/:id/cosign
Body: {seller_signature: "ed25519:<valid_sig_by_seller_B>"}
```

If the engine only verifies "the signature is valid Ed25519" but doesn't check that the signer is `quote.seller` (which is Seller A), Seller B's signature is accepted.

The quote's canonical JSON has `"seller": "did:key:z6Mk...SellerA"`. If Seller B signs this canonical JSON, the signature is by Seller B's key but over a payload that says the seller is Seller A. This is cryptographically invalid IF the engine verifies the signature against `didToPublicKey(quote.seller)`. But if the engine verifies against the request sender's DID (extracted from the request signature), and the request sender is Seller B, the verification passes against the wrong key.

**Plan's defense:** The plan (revised) says "engine verifies `seller_signature` against `didToPublicKey(quote.seller)` -- must be the selected seller." This is correct IF implemented exactly. The prior audit (H3) flagged this. The plan now addresses it in the "Signer identity verification" section. **If implemented as written, this attack fails.** But implementation must extract the key from `quote.seller`, NOT from the request sender.

**Severity: CRITICAL** -- If the cosign endpoint extracts the verification key from the request sender instead of from `quote.seller`, this is an instant exploit. The plan addresses it but the implementation must be verified.

---

### RT-H6: Race Condition on Accept with Stale Session Revision [HIGH]

**Attack goal:** Exploit the accept CAS mechanism to select a seller that the buyer didn't intend.

**Attack path:**

The plan says accept requires `{offer_id, session_revision}` in the signed envelope. But the `session_revision` is derived from the event count. If the attacker can cause an event to be appended between the buyer reading the session state and sending the accept, the session_revision changes and the buyer's accept is rejected.

Reverse attack: if the attacker can PREDICT the next session_revision (it's just `events.length + 1`), they can prepare a forged accept envelope (if they compromise the buyer's key) with the correct revision.

**Plan's defense:** The session_revision is in the signed envelope, so without the buyer's private key, the attacker cannot forge it. This is secure against external attackers but creates a griefing vector: by submitting offers at precisely the right moment, an attacker can invalidate a buyer's pre-signed accept envelope.

**Severity: HIGH** -- Not a money-stealing attack, but an effective griefing mechanism. A seller who observes the buyer's `GET /quote` request (via timing) can rush an offer to increment the session revision, causing the buyer's accept to fail.

---

### RT-H7: Omniscient Buyer Advantage Exploitation [MEDIUM]

**Attack goal:** Buyer exploits their information advantage unfairly.

**Attack path:**

The plan explicitly states: "Buyer sees: full event stream (all offers, all counters, quote state) -- this is the protocol's intended information advantage." The buyer sees ALL sellers' offers and can play sellers against each other:

1. Buyer sees Seller A offers $50, Seller B offers $35
2. Buyer counters Seller A with $30 (knowing B already offered $35)
3. Buyer counters Seller B with $25 (knowing A offered $50, so B must be desperate)
4. If Seller B declines, buyer can immediately accept Seller A at $35 (Seller A doesn't know B existed)

This is BY DESIGN in the protocol (buyer drives the negotiation). But sellers have no mechanism to know whether the buyer is negotiating fairly.

**Severity: MEDIUM** -- This is a protocol design choice, not a bug. Documenting it is sufficient.

---

## Attack Category 5: DoS the Engine

### RT-C6: UUID Tombstone Memory Exhaustion [HIGH]

**Attack goal:** Exhaust engine memory via tombstone set growth.

**Attack path:**

The plan says "Tombstones are only created for requests that pass authentication." This is a good defense. But an attacker with a single valid keypair can:

1. Create RFQ with valid signature (passes auth, UUID stored)
2. Session gets created, eventually expires
3. RFQ UUID goes to tombstone set
4. Repeat with new RFQ UUID

Rate limit: 10 RFQs/min per DID. Over 60 minutes (tombstone retention): `10 * 60 = 600` tombstones per DID. With N keypairs: `600N` tombstones.

At 36 bytes per UUID: `600 * 1000 DID * 36 bytes = 21.6 MB`. Not catastrophic, but with 10,000 DIDs (cheap to generate): 216 MB just in tombstones.

**Plan's defense:** The plan acknowledges tombstone growth but has no bound. The 10,000-event warning doesn't cover tombstones.

**Severity: HIGH** -- Need a tombstone size limit. When the tombstone set exceeds a threshold (e.g., 100,000 entries), evict the oldest entries. Post-eviction UUID reuse is acceptable because the session has already been pruned.

---

### RT-H8: Deadline Enforcer Thread Starvation [HIGH]

**Attack goal:** Prevent the deadline enforcer from running by saturating the event loop.

**Attack path:**

The deadline enforcer runs on `setInterval`. If the Node.js event loop is saturated (e.g., by many concurrent ZK proof verifications), the interval callback gets delayed.

Attack: send 20 concurrent counter-offers to 20 different sessions, each with ZK proofs. Each `verifyBudgetProof` call takes ~50ms synchronously (snarkjs is CPU-bound). Total: 20 * 50ms = 1 second of synchronous CPU time, blocking the event loop.

During this second, deadline enforcer intervals are delayed. Sessions that should have expired remain alive. A buyer can squeeze in a last-millisecond accept on an expired session.

```
# Attacker creates 20 sessions with ZK commitments
# Then simultaneously submits counters with ZK proofs to all 20
for session_id in sessions:
  POST /rfqs/{session_id}/counter
  Body: {valid counter with budget_proof}
```

**Plan's defense:** The per-session lock serializes requests within a session, but ZK verification happens within the lock (after acquiring it). Cross-session requests are NOT serialized -- 20 sessions can run ZK verification in parallel.

The plan acknowledges "ZK verification is ~50ms, synchronous, acceptable for demo." But in the context of deadline enforcement, this is an attack vector.

**Severity: HIGH** -- ZK verification should be moved to a worker thread or at minimum the engine should check deadlines BEFORE starting expensive ZK verification (which the plan does -- ZK is step 7, deadline check is "first action inside the lock"). But the deadline enforcer itself can be starved by the event loop being busy.

---

### RT-H9: SSE Connection Exhaustion [MEDIUM]

**Attack goal:** Exhaust server file descriptors via SSE connections.

**Attack path:**

Each SSE connection holds an HTTP keep-alive socket. The plan mentions "SSE connection limits" as a technical consideration but does not specify a per-session or global SSE connection limit.

```
# Attacker opens 1000 SSE connections to various sessions
for i in 1..1000:
  GET /rfqs/{random_session}/events
  Accept: text/event-stream
```

Each connection is a long-lived TCP socket. Node.js default `maxSockets` is limited but not zero.

**Plan's defense:** The plan says "client disconnect cleanup" but no limit on concurrent SSE connections. Rate limiting (100 req/min per IP) wouldn't catch this because these are 1000 connections opened over 10 minutes.

**Severity: MEDIUM** -- Add a global SSE connection limit and a per-session limit (e.g., max 5 SSE connections per session, max 100 global).

---

### RT-M2: Metrics Endpoint as Reconnaissance Tool [MEDIUM]

**Attack goal:** Enumerate active sessions and monitor engine health.

**Attack path:**

```
GET /metrics
# No authentication required per plan
# Returns: session counts, event totals, per-route latency
```

Attacker monitors `/metrics` to:
- Know how many sessions are active (timing their attack for high load)
- Measure route latency (identifying when ZK verification is running)
- Detect when deadline enforcer runs (latency spike on `/metrics`)

**Plan's defense:** Prior audit (M4) flagged this. Plan does not address it.

**Severity: MEDIUM** -- Authenticate the metrics endpoint or run it on a separate internal port.

---

## Chained Exploit Scenarios

### Chain 1: Sybil Flood + Event Cap + Commitment Timeout = Total Session Kill

**Steps:**
1. Attacker registers 50 Sybil seller identities (50 Ed25519 keypairs)
2. Each Sybil submits 10 offers to the target session = 500 events
3. Session hits the 500-event cap and auto-expires via `SESSION_EVENT_LIMIT`
4. Buyer's negotiation is destroyed; they must create a new RFQ and start over
5. Attacker repeats on the new session

**Time required:** Generating 50 keypairs: <1 second. Submitting 500 offers at 100 req/min rate limit: 5 minutes (but using different IPs bypasses per-IP rate limit).

**Severity: CRITICAL** -- This chain combines Sybil (no offer-submission auth beyond having a keypair), missing per-session offer caps, and the event cap's offensive use.

### Chain 2: Timing Analysis + Counter Price Observation = Budget Discovery

**Steps:**
1. Attacker (seller) connects to SSE stream
2. Attacker submits offer at $100 (absurdly high)
3. Buyer counters at $28 → attacker knows `budget_hard >= $28`
4. Attacker submits new offer at $29
5. Buyer counters at $32 → attacker knows `budget_hard >= $32`
6. Attacker submits offer at $33
7. If buyer counters at $33 → `budget_hard` is very close to $33
8. If buyer doesn't counter (switches to another seller) → `budget_hard < $33` or strategy changed
9. Combine with SSE timing gaps to know when buyer is negotiating with others

**Severity: HIGH** -- This is a fundamental information leak in any iterative negotiation protocol. The ZK proof only proves `counter_price <= budget_hard`, it doesn't hide the counter price itself. Rising counter prices are a tight lower bound.

### Chain 3: Lock Queue Saturation + Deadline Race = Unauthorized State Transition

**Steps:**
1. Target session is at 2 seconds before deadline
2. Attacker sends 10 concurrent offer requests to saturate the lock queue
3. Deadline enforcer tries to acquire the lock but is at position 11 in the queue
4. Deadline enforcer gets `429` (queue full) or waits 5 seconds (timeout)
5. During the 5-second window, a request that should have been rejected (post-deadline) succeeds because the enforcer hasn't run yet
6. Buyer squeezes in a last-second accept on an effectively expired session

**Plan's defense:** The plan says "deadline check inside lock" -- the handler checks `Date.now() >= deadline` as first action. So even if the enforcer is delayed, each handler independently checks the deadline. **This chain is mitigated** IF the in-handler deadline check is reliable.

However, the prior audit (M2) notes the queue bound prevents the enforcer from acquiring the lock. The plan should give the enforcer priority access.

**Severity: MEDIUM** -- Partially mitigated by in-handler deadline check, but enforcer priority should still be implemented.

---

## Summary

| ID | Severity | Category | Title |
|----|----------|----------|-------|
| RT-C1 | CRITICAL | Money | Quote field injection via `payment_endpoint` source ambiguity |
| RT-C4 | CRITICAL | Privacy | Budget discovery via counter price observation (protocol-level) |
| RT-C5 | CRITICAL | Fairness | Seller impersonation on cosign if identity binding is wrong |
| Chain-1 | CRITICAL | DoS+Grief | Sybil flood + event cap = session kill |
| RT-C2 | HIGH | Money | Stale offer price lock-in via outdated `offer_id` |
| RT-C3 | HIGH | Grief | Commitment timeout cycle with Sybil sellers drains deadline |
| RT-H1 | HIGH | Grief | Session lock starvation via burst requests |
| RT-H2 | HIGH | DoS/Grief | Event cap exhaustion via offer spam |
| RT-H4 | HIGH | Privacy | Event cursor gap analysis reveals competitor count |
| RT-H5 | HIGH | Privacy | SSE timing side channel reveals negotiation dynamics |
| RT-H6 | HIGH | Fairness | Session revision grief via timed offer submission |
| RT-C6 | HIGH | DoS | UUID tombstone memory exhaustion |
| RT-H8 | HIGH | DoS | Deadline enforcer starvation via ZK CPU saturation |
| Chain-2 | HIGH | Privacy | Timing + counter prices = budget discovery |
| RT-H3 | MEDIUM | Grief | Phantom seller accept-decline loop |
| RT-H7 | MEDIUM | Fairness | Buyer omniscient advantage (by design) |
| RT-H9 | MEDIUM | DoS | SSE connection exhaustion |
| RT-M1 | MEDIUM | Privacy | ZK error messages could leak commitment details |
| RT-M2 | MEDIUM | DoS | Metrics endpoint as reconnaissance tool |
| Chain-3 | MEDIUM | Fairness | Lock queue + deadline race (partially mitigated) |

---

## Recommended Priority Fixes

### Must Fix (Before Implementation)

1. **Explicit `payment_endpoint` source binding** (RT-C1): The engine plan must specify that `payment_endpoint` comes from the listing/offer that was explicitly referenced in the accept, and the buyer's agent MUST verify this field before signing.

2. **Per-session offer cap** (RT-H2, Chain-1): Add a per-session offer limit (e.g., max 50 offers total, max 5 per seller DID) separate from the event cap. The event cap should not be triggerable by unilateral seller action alone.

3. **Cosign identity verification** (RT-C5): Implementation MUST extract verification key from `didToPublicKey(quote.seller)`, never from the request sender. Add an integration test that specifically tests a non-selected seller attempting to cosign.

4. **Opaque event cursors** (RT-H4): Replace integer event IDs with UUIDs in the SSE stream to prevent gap analysis.

### Should Fix

5. **Global accept attempt limit** (RT-C3): Add a per-session ceiling on total accept attempts (e.g., max 6 across all sellers) in addition to the per-seller limit of 2.

6. **Offer submission rate limiting per session** (RT-H1): Add per-DID-per-session and per-session-total offer rate limits.

7. **Tombstone size cap** (RT-C6): Bound the tombstone set to 100,000 entries with LRU eviction.

8. **ZK verification in worker thread** (RT-H8): Move `verifyBudgetProof` to a worker thread to prevent event loop starvation.

9. **SSE connection limits** (RT-H9): Max 5 SSE connections per session, max 100 global.

### Document (Protocol Limitations)

10. **Counter price information leak** (RT-C4, Chain-2): Document that rising counter prices reveal a lower bound on `budget_hard`. Recommend strategies never counter above `budget_soft`. This is inherent to any iterative negotiation and not fully solvable by ZK proofs.

11. **SSE timing side channel** (RT-H5): Document that event delivery timing reveals negotiation cadence. Consider optional jitter in event delivery.

12. **Buyer omniscient advantage** (RT-H7): Already by design. Document clearly for seller implementers.

---

## Final Verdict

The plan is **architecturally solid** with excellent primitives (event sourcing, per-session locks, quote immutability, signed control envelopes). The security audit found real issues, and the plan addressed many of them in revision.

However, this red team exercise reveals **systemic weaknesses** in the areas of:

1. **Sybil resistance at the offer layer** -- anyone with a keypair can submit offers, and there's no cap on offers per session. This creates multiple attack vectors (event cap exhaustion, lock starvation, timeline griefing).

2. **Information leakage through legitimate protocol behavior** -- counter prices, event timing, and cursor gaps all leak competitive intelligence. The ZK proof extension mitigates exact budget discovery but not the iterative lower-bound tightening.

3. **Trust assumptions about quote field sourcing** -- the `payment_endpoint` provenance is ambiguous and could lead to payment redirection if not carefully implemented.

**Bottom line:** The plan should be implementable securely IF the "Must Fix" items above are addressed before code is written. The Sybil offer flooding chain (Chain-1) is the single most dangerous attack because it requires zero prerequisites (just keypair generation) and completely destroys a buyer's session. Adding a per-session offer cap closes this immediately.
