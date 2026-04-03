# Blue Team Defense Report: Ghost Bazaar Negotiation Engine

**Defender:** Blue Team (Claude Opus 4.6)
**Date:** 2026-03-20
**Scope:** Complete defense inventory, attack surface map, defense interaction analysis, and residual risk assessment
**Inputs:** `plans/engine-plan.md`, `GHOST-BAZAAR-SPEC-v4.md` (Sections 5-10), `plans/engine-security-audit.md`, `plans/red-team-audit.md`, `plans/spec-compliance-audit.md`

---

## 1. Defense Inventory

### D1: Event Sourcing with Immutable Append-Only Log

| Property | Detail |
|----------|--------|
| **Defends against** | State corruption, unauthorized state mutation, audit evasion |
| **Mechanism** | All state changes are modeled as events appended to an ordered, immutable log. Session state is derived by reducing the event sequence (`deriveState(events)`). No mutable state is stored directly. |
| **Gaps** | None identified. Event sourcing is architecturally sound. The `InMemoryEventStore.append()` adds to an array — JavaScript arrays are not truly immutable, but the plan's convention (never splice/pop) combined with the interface boundary makes accidental mutation unlikely. A production hardening would be to use `Object.freeze()` on appended events. |
| **Conflicts** | None. Event sourcing is the foundation that other defenses build upon. |

### D2: Per-Session Async Lock (Promise Chain Serialization)

| Property | Detail |
|----------|--------|
| **Defends against** | Race conditions (concurrent counter + accept, duplicate state transitions), TOCTOU attacks |
| **Mechanism** | Each `rfq_id` maps to a `SessionLock` that serializes all mutations as a promise chain. A request acquires the lock, performs validation + state change atomically, then releases. |
| **Gaps** | (a) Lock timeout is 5 seconds — under extreme load, legitimate requests may time out. (b) The lock covers only per-session operations; cross-session attacks (e.g., tombstone flooding) are not serialized. (c) No priority mechanism — deadline enforcer competes equally with user requests for the lock. |
| **Conflicts** | Interacts with the deadline enforcer (see Section 3, DI-2). |

### D3: Lock Queue Bound (Max 10 Pending)

| Property | Detail |
|----------|--------|
| **Defends against** | Lock starvation, unbounded resource consumption per session, queue memory exhaustion |
| **Mechanism** | If 10 requests are already waiting for the session lock, the 11th gets `429 Too Many Requests`. |
| **Gaps** | (a) 10 different DIDs can each queue one request simultaneously, exhausting the queue. Per-session offer rate limiting (D12) mitigates this partially, but the lock queue applies to ALL request types (counters, accepts, offers), not just offers. (b) The deadline enforcer is subject to the same queue limit (see Section 3, DI-2). |
| **Conflicts** | Interacts with deadline enforcer priority (see DI-2). |

### D4: Deadline Check Inside Lock

| Property | Detail |
|----------|--------|
| **Defends against** | Post-deadline state transitions via queued requests, deadline race exploitation |
| **Mechanism** | When a handler acquires the lock, its first action is `if (Date.now() >= rfq.deadline) → reject 409`. Uses wall clock at handler start, not lock acquisition time. |
| **Gaps** | Relies on `Date.now()` accuracy. Clock skew between the engine and external systems could create a narrow window (sub-second). Not a practical concern for an in-memory single-process engine. |
| **Conflicts** | None. This is a defense-in-depth complement to the deadline enforcer (D10). Even if the enforcer is delayed, each handler independently rejects post-deadline requests. |

### D5: State Machine Guards (requireState Middleware)

| Property | Detail |
|----------|--------|
| **Defends against** | Invalid state transitions, protocol state confusion attacks |
| **Mechanism** | Each route declares allowed states. Requests to routes whose required state doesn't match the current derived state get `409 invalid_state_transition`. |
| **Gaps** | Per the revised plan, the state guard runs AFTER signature verification (matching Spec order). This is correct — no information leak about session state to unauthenticated actors. |
| **Conflicts** | None. |

### D6: Ed25519 Signature Verification with Signer Identity Binding

| Property | Detail |
|----------|--------|
| **Defends against** | Request forgery, unauthorized actions, impersonation, cross-party replay |
| **Mechanism** | Every write endpoint verifies (a) the Ed25519 signature is cryptographically valid, AND (b) the signer's DID matches the expected role: buyer for RFQs/counters/accept/quote-sign, seller for offers/cosign. Cosign specifically verifies against `didToPublicKey(quote.seller)` — the selected seller, not the request sender. |
| **Gaps** | None identified in the plan. The plan explicitly addresses the H2/H3 findings from the security audit (signer identity binding on quote/sign and cosign). **Critical implementation note:** The cosign endpoint MUST extract the verification key from `quote.seller`, never from the HTTP request sender's identity. If this is implemented correctly, RT-C5 (seller impersonation) is fully mitigated. |
| **Conflicts** | None. |

### D7: Signed Control Envelopes (Domain Separation + Replay Protection)

| Property | Detail |
|----------|--------|
| **Defends against** | Cross-session replay, cross-action replay, cross-engine replay, within-window replay |
| **Mechanism** | State-changing actions (accept, decline, cancel, sign, cosign) require a signed envelope containing: `envelope_id` (unique nonce UUID), `action` (must match endpoint), `rfq_id` (must match route param), `issued_at` (within 60s), `expires_at` (in future). The `envelope_id` is tombstoned after first use. |
| **Gaps** | (a) Envelope nonce tombstones share the same tombstone set as protocol object IDs. If tombstone eviction occurs (e.g., after LRU cap), a very old envelope could theoretically be replayed. However, the `issued_at` within 60s check and `expires_at` in future check independently prevent this — a replayed old envelope would fail the freshness check even if the tombstone was evicted. **Verdict: no gap.** (b) The 60-second `issued_at` window is generous enough for network latency but tight enough to limit replay windows. |
| **Conflicts** | Interacts with tombstone set (see DI-3). |

### D8: UUID Uniqueness Enforcement with Tombstones

| Property | Detail |
|----------|--------|
| **Defends against** | Protocol object replay, duplicate session creation, ID collision attacks |
| **Mechanism** | All protocol object IDs (`rfq_id`, `offer_id`, `counter_id`, `quote_id`) and envelope IDs are checked against a global `Set<string>`. Duplicates get `409 duplicate_object_id`. After session pruning, IDs move to a `tombstoneSet` retained for 60 minutes. |
| **Gaps** | (a) Tombstones are only created for authenticated requests — good, prevents unauthenticated UUID flooding. (b) On restart, tombstones are lost — accepted MVP tradeoff. Post-restart, a replayed request with the same UUID could succeed if the original session was pruned. The plan acknowledges this and targets SQLite for production. (c) The plan now implicitly bounds tombstone growth via the per-DID rate limit (10 RFQs/min) + authenticated-only tombstoning. However, no explicit maximum tombstone set size is mentioned. |
| **Conflicts** | Interacts with session pruning (see DI-3) and control envelope nonces (see DI-3). |

### D9: Spec-Ordered Validation Chains

| Property | Detail |
|----------|--------|
| **Defends against** | Information leakage via error code oracle, interop-breaking error code deviations |
| **Mechanism** | All three write endpoints (RFQ, Offer, Counter) follow the exact validation order prescribed by Spec Section 8. Cheap checks (schema, field validation) run first; signature verification runs before state guard; ZK verification runs before signature for counters (as per Spec). |
| **Gaps** | The plan explicitly documents that earlier DoS-hardening reordering was reverted to match Spec order. The note explains the reasoning. **Verified: the 12-step counter verification in the plan matches Spec Section 8 counter verification steps 1-12 exactly.** |
| **Conflicts** | None. |

### D10: Deadline Enforcer (Periodic Scanner)

| Property | Detail |
|----------|--------|
| **Defends against** | Sessions lingering past deadline, resource exhaustion from abandoned sessions |
| **Mechanism** | `setInterval` periodically scans all active sessions. Sessions in `OPEN`, `NEGOTIATING`, or `COMMIT_PENDING` past their `rfq.deadline` are auto-transitioned to `EXPIRED` with a `NEGOTIATION_EXPIRED` event appended. |
| **Gaps** | (a) `setInterval` is imprecise — worst case 1-2 seconds late. The plan acknowledges this and recommends a priority queue for production. (b) The enforcer must acquire the per-session lock to transition state. If the lock queue is full (10 pending), the enforcer is blocked (see DI-2). (c) CPU-intensive ZK verification across multiple sessions could starve the event loop, delaying the enforcer callback. |
| **Conflicts** | Interacts with session lock (see DI-2). D4 (deadline check inside lock) provides defense-in-depth. |

### D11: Commitment Timeout (Cosign Timeout)

| Property | Detail |
|----------|--------|
| **Defends against** | Griefing via indefinite `COMMIT_PENDING` lock, seller disappearance stalling buyer |
| **Mechanism** | If `COMMIT_PENDING` persists longer than `commitment_timeout` (default 60s, configurable 15-120s via `COSIGN_TIMEOUT_MS`), the deadline enforcer auto-reverts to `NEGOTIATING` and appends `COSIGN_TIMEOUT` event. |
| **Gaps** | (a) 60s default is generous — a Sybil seller can waste 60s per attempt. With 2 attempts per seller and 6 global attempts, worst case is min(6 * 60s, deadline) = 360s = 6 minutes. For a 10-minute deadline, this consumes 60% of the buyer's time. (b) The configurable range (15-120s) allows operators to tune. Public-facing deployments should use the lower end (30s). (c) No adaptive timeout — first and second attempts for the same seller use the same timeout. Reducing the second attempt timeout would improve resilience. |
| **Conflicts** | Interacts with the global accept attempt limit (D14). Together they cap total grief time. |

### D12: Offer Admission Control (Anti-Sybil)

| Property | Detail |
|----------|--------|
| **Defends against** | Sybil offer flooding (Chain-1 from red team), event cap exhaustion via offer spam, lock queue saturation |
| **Mechanism** | Per-session total offer cap: max 50 offers. Per-DID offer cap: max 5 offers per seller per session. Offers count separately from the 500-event session cap. |
| **Gaps** | (a) 50 offers still requires 10 Sybil identities at 5 each, which is trivial to generate (Ed25519 keypairs are free). However, this is a significant improvement over the unbounded original. The 500-event cap is no longer reachable by offer spam alone (50 offers << 500 cap). (b) Optional production hardening: require 8004 registry enrollment to submit offers (`403 unregistered_seller`). This makes Sybil attacks economically expensive (on-chain registration cost). Not enabled in MVP. |
| **Conflicts** | The offer cap and event cap are now decoupled — offers have their own limit (50) separate from the general event cap (500). This resolves the Chain-1 attack (red team RT-H2). |

### D13: Per-Session Event Cap (500) with Per-Actor Quota

| Property | Detail |
|----------|--------|
| **Defends against** | Memory exhaustion from unbounded event accumulation, session resource abuse |
| **Mechanism** | Max 500 events per session. Non-terminal events (offers, counters) are rejected at cap. Terminal actions (accept, cosign, cancel) are still permitted. Per-actor quota: max 100 events per DID per session. |
| **Gaps** | (a) With the offer cap at 50 and per-actor quota at 100, the 500-event cap is primarily a defense against legitimate but very active sessions rather than attacks. Attacks are stopped earlier by D12. (b) Terminal actions remain permitted at cap — this is correct, preventing the cap from being weaponized to block session completion. |
| **Conflicts** | No longer conflicts with offer cap (D12) since they are separate limits. |

### D14: Global Accept Attempt Limit

| Property | Detail |
|----------|--------|
| **Defends against** | Sybil commitment timeout cycling (RT-C3), indefinite accept-then-timeout loops |
| **Mechanism** | Max 6 total accept attempts per session across all sellers. Combined with per-seller limit of 2. |
| **Gaps** | (a) 6 attempts × 60s timeout = 360s worst case. For a 10-minute deadline, this is 60% of the time. With 30s timeout: 180s = 30%. This is a significant improvement over unbounded. (b) The per-seller limit of 2 means a single malicious seller can only burn 2 × 60s = 120s. The global limit of 6 caps total grief from all Sybil sellers combined. |
| **Conflicts** | Works cooperatively with D11 (commitment timeout). Total grief = min(6 × timeout, deadline). |

### D15: Quote Immutability and Versioning

| Property | Detail |
|----------|--------|
| **Defends against** | TOCTOU attacks on quote content, quote field manipulation between accept and signing |
| **Mechanism** | After `POST /accept`, the unsigned quote is stored server-side. `PUT /quote/sign` and `PUT /cosign` accept ONLY signature fields — no quote fields in the request body. Engine verifies signatures against stored canonical bytes. Quote revision counter prevents signing stale quotes after rollback. |
| **Gaps** | None identified. This is a robust defense against quote manipulation. The only way to change quote content is to trigger a new accept cycle (which increments `quote_revision`). |
| **Conflicts** | None. |

### D16: `payment_endpoint` Provenance (Anti-Redirection)

| Property | Detail |
|----------|--------|
| **Defends against** | Payment redirection (RT-C1), `payment_endpoint` injection via offer or registry |
| **Mechanism** | `buildUnsignedQuote()` sources `payment_endpoint` from the original Listing associated with the seller, recorded at offer submission time in the `OFFER_SUBMITTED` event. NOT from the offer body or live registry lookup. |
| **Gaps** | (a) If the Listing itself was poisoned (attacker controls the listing content), the `payment_endpoint` is malicious from the start. However, listings are published by the seller themselves — a seller has no incentive to redirect their own payments. (b) The client-side verification contract requires buyers to verify `payment_endpoint` before signing. This is advisory, not enforced. An automated buyer agent that skips this check is vulnerable to a compromised engine. (c) If no listing exists for the seller → `422 missing_payment_endpoint`. Good. |
| **Conflicts** | None. |

### D17: Extension Field Preservation

| Property | Detail |
|----------|--------|
| **Defends against** | Silent data loss of protocol extensions during relay, Spec non-compliance (Section 5.7 MUST) |
| **Mechanism** | The full original protocol object (including `extensions`) is preserved in event payloads. `filterEventsForRole()` preserves extensions on forwarded events. Engine ignores unknown extensions for processing but never strips them. |
| **Gaps** | This was originally missing (spec-compliance audit F1). The plan now explicitly addresses it. Implementation must verify that `deriveState()` reconstruction includes extensions in all protocol objects, and that serialization/deserialization round-trips don't drop unknown keys. |
| **Conflicts** | None. |

### D18: Counter `to` Validation

| Property | Detail |
|----------|--------|
| **Defends against** | Counters addressed to non-participant sellers, phantom counter injection |
| **Mechanism** | Counter verification checks that `counter.to` is a seller DID that has submitted at least one offer for the RFQ. Rejects with `422 unauthorized_counter`. |
| **Gaps** | This was originally missing (spec-compliance audit F2). Now addressed. |
| **Conflicts** | None. |

### D19: Rate Limiting

| Property | Detail |
|----------|--------|
| **Defends against** | Request flooding, DDoS, session creation spam |
| **Mechanism** | Global: 100 req/min per IP. Per-DID: 10 RFQ creations/min. Per-session: lock queue bound (10). Request body: max 64 KB. Proof field cardinality: validated. |
| **Gaps** | (a) IP-based rate limiting is bypassable with distributed sources (botnets, cloud IPs). Standard limitation, not specific to this system. (b) No per-session offer submission rate limiting per IP — only per-DID per-session (5 offers). An attacker with 10 DIDs from 1 IP hits the 50-offer session cap, which is acceptable due to D12. |
| **Conflicts** | None. |

### D20: Opaque Event Cursors

| Property | Detail |
|----------|--------|
| **Defends against** | Competitor count disclosure via event ID gap analysis (RT-H4) |
| **Mechanism** | External SSE cursors are opaque UUIDs mapped from internal monotonic IDs. Sellers cannot infer how many events they are not seeing. |
| **Gaps** | None identified for gap analysis prevention. However, SSE timing side channels (RT-H5) remain — event delivery timing reveals negotiation cadence. The plan documents this as a known limitation with optional jitter as a future mitigation. |
| **Conflicts** | None. |

### D21: Role-Scoped Event Filtering

| Property | Detail |
|----------|--------|
| **Defends against** | Cross-seller intelligence leakage, unauthorized visibility into competitor offers/counters |
| **Mechanism** | `filterEventsForRole(events, callerDid, rfq)` — buyers see all events, sellers see only their own offers and counters addressed to them. Third parties get `401`. |
| **Gaps** | (a) SSE timing can leak information even with content filtering (D20 partially mitigates via opaque cursors). (b) Requires correct DID extraction from request authentication — if the auth middleware misidentifies the caller, wrong events are returned. |
| **Conflicts** | None. |

### D22: Registry Data Sanitization

| Property | Detail |
|----------|--------|
| **Defends against** | XSS/injection via on-chain registry entries, SSRF via malicious URLs, score manipulation |
| **Mechanism** | Strip HTML, validate URL format, clamp scores to 0-100 range on all data from 8004 Agent Registry. |
| **Gaps** | (a) If `discoverAgent()` itself makes HTTP calls to attacker-controlled endpoints (SSRF), the sanitization only covers the data after retrieval, not the retrieval path. The plan notes this — SSRF risk is in the registry client, not the enricher. (b) URL validation should use allowlist (HTTPS only, no private IPs). |
| **Conflicts** | None. |

### D23: ZK Error Sanitization

| Property | Detail |
|----------|--------|
| **Defends against** | Budget commitment leakage via error messages (RT-M1) |
| **Mechanism** | Plan states: "Private state (budget_hard, floor_price, commitment_salt) MUST NEVER appear in logs." ZK verification errors return generic `422 invalid_budget_proof` without internal circuit values. |
| **Gaps** | (a) The plan should mandate that all ZK-related error paths use a catch-all that returns `false` (matching current `verifier.ts` pattern) rather than letting snarkjs exceptions propagate. (b) Stack traces in 5xx responses must be sanitized — the plan says stack traces are logged for 5xx only, not returned to clients. Good. |
| **Conflicts** | None. |

### D24: Known Information Leak Documentation

| Property | Detail |
|----------|--------|
| **Defends against** | N/A (documentation defense — manages expectations, guides strategy implementers) |
| **Mechanism** | The plan documents three inherent protocol-level leaks: (1) counter price lower bound on `budget_hard`, (2) SSE timing side channels, (3) buyer omniscient advantage. |
| **Gaps** | Documentation is not enforcement. Strategy implementers who don't read the docs may still counter above `budget_soft`. However, the Duty 1 strategy sanitizer already clamps counter prices to `budget_hard` — the recommendation is to never counter above `budget_soft`, which is a strategy-level concern. |
| **Conflicts** | None. |

---

## 2. Attack Surface Map

### Endpoint: `GET /listings`

| Property | Detail |
|----------|--------|
| **Who can call** | Anyone (no authentication required) |
| **Authentication** | None |
| **Validation order** | (1) Parse query params, (2) Retrieve listings, (3) Enrich via 8004 registry (optional), (4) Sanitize registry data |
| **State changes** | None (read-only) |
| **Information returned** | Listing details including seller DID, service type, negotiation profile, payment endpoint. Registry enrichment adds name, URI, reputation scores (sanitized). |
| **Side effects** | Outbound HTTP call to 8004 Agent Registry (if configured). Potential SSRF vector if registry client follows arbitrary URLs. |

### Endpoint: `GET /listings/:id`

| Property | Detail |
|----------|--------|
| **Who can call** | Anyone |
| **Authentication** | None |
| **Validation order** | (1) Validate listing ID, (2) Retrieve listing, (3) Enrich, (4) Sanitize |
| **State changes** | None |
| **Information returned** | Single listing detail |
| **Side effects** | Same as `GET /listings` |

### Endpoint: `POST /rfqs`

| Property | Detail |
|----------|--------|
| **Who can call** | Any buyer with a valid Ed25519 keypair |
| **Authentication** | Ed25519 signature on RFQ payload (step 7 of 9) |
| **Validation order** | (1) Parse/validate schema → `400`, (2) Protocol version → `400`, (3) Anchor price valid → `422`, (4) Deadline future → `422`, (5) Budget commitment format → `422`, (6) Currency supported → `422`, (7) Buyer Ed25519 sig → `401`, (8) Create session + append event, (9) Return `201` |
| **State changes** | Creates new session in `OPEN` state, appends `RFQ_CREATED` event |
| **Information returned** | Session ID, created RFQ confirmation |
| **Side effects** | Session created in memory, UUID added to seen set, rate limit counter incremented |

### Endpoint: `POST /rfqs/:id/offers`

| Property | Detail |
|----------|--------|
| **Who can call** | Any seller with a valid Ed25519 keypair |
| **Authentication** | Ed25519 signature on offer payload (step 6 of 10) |
| **Validation order** | (1) Parse/validate schema → `400`, (2) Retrieve RFQ → `404`, (3) Price valid → `422`, (4) Currency match → `422`, (5) Valid_until future → `422`, (6) Seller Ed25519 sig → `401`, (7) State guard (OPEN/NEGOTIATING) → `409`, (8) Offer admission check (50/session, 5/DID) → `422`, (9) Transition OPEN→NEGOTIATING if first, (10) Append event, (11) Return `201` |
| **State changes** | May transition `OPEN → NEGOTIATING`. Appends `OFFER_SUBMITTED` event. |
| **Information returned** | Confirmation of offer submission |
| **Side effects** | Event appended, SSE subscribers notified, listing `payment_endpoint` recorded in event |

### Endpoint: `POST /rfqs/:id/counter`

| Property | Detail |
|----------|--------|
| **Who can call** | Only the RFQ buyer |
| **Authentication** | Ed25519 signature on counter payload (step 8 of 12), `from === rfq.buyer` check (step 6) |
| **Validation order** | (1) Parse schema → `400`, (2) Retrieve RFQ → `404`, (3) Price valid → `422`, (4) Currency match → `422`, (5) Valid_until future → `422`, (6) `from === buyer` → `422`, (7) ZK proof (if commitment): missing → `422`, price match → `422`, verify → `422`, unexpected → `422`, (8) Buyer sig → `401`, (9) State guard (NEGOTIATING) → `409`, (10) Round monotonicity → `422`, (11) Append event, (12) Return `201` |
| **State changes** | Appends `COUNTER_SENT` event |
| **Information returned** | Confirmation of counter submission |
| **Side effects** | Event appended, SSE subscribers notified (only the addressed seller sees the counter via role-scoped filtering) |

### Endpoint: `POST /rfqs/:id/accept`

| Property | Detail |
|----------|--------|
| **Who can call** | Only the RFQ buyer |
| **Authentication** | Signed control envelope with `action: "accept"`, signer DID === `rfq.buyer` |
| **Validation order** | (1) Validate control envelope (nonce, action, rfq_id, freshness, expiry, signature), (2) State guard (NEGOTIATING) → `409`, (3) Verify sender is buyer → `401`, (4) Verify seller submitted offer → `404`, (5) Verify offer_id exists + valid_until → `422`, (6) Check accept limits (2/seller, 6/global) → `422`, (7) CAS check (session_revision) → `409`, (8) Transition to COMMIT_PENDING, call `buildUnsignedQuote()`, (9) Append events, return unsigned quote |
| **State changes** | Transitions `NEGOTIATING → COMMIT_PENDING`. Appends `WINNER_SELECTED` event. Starts commitment timeout timer. |
| **Information returned** | Unsigned quote (all fields including `payment_endpoint`, `final_price`, `nonce`) |
| **Side effects** | Quote stored server-side, commitment timeout timer started, SSE notification |

### Endpoint: `PUT /rfqs/:id/quote/sign`

| Property | Detail |
|----------|--------|
| **Who can call** | Only the RFQ buyer |
| **Authentication** | `buyer_signature` verified against `didToPublicKey(quote.buyer)` |
| **Validation order** | (1) State guard (COMMIT_PENDING) → `409`, (2) Verify signature against stored quote canonical bytes → `401`, (3) Store partially-signed quote |
| **State changes** | Quote updated from unsigned to partially-signed |
| **Information returned** | Confirmation |
| **Side effects** | SSE notification (seller can now retrieve partially-signed quote) |

### Endpoint: `GET /rfqs/:id/quote`

| Property | Detail |
|----------|--------|
| **Who can call** | Buyer or the selected seller (authenticated) |
| **Authentication** | Ed25519 signed request or bearer token |
| **Validation order** | (1) Authenticate caller, (2) Verify caller is buyer or selected seller, (3) Return quote |
| **State changes** | None (read-only) |
| **Information returned** | Current quote state (unsigned/partially-signed/fully-signed). Non-selected sellers get `404`. |
| **Side effects** | None |

### Endpoint: `PUT /rfqs/:id/cosign`

| Property | Detail |
|----------|--------|
| **Who can call** | Only the selected seller |
| **Authentication** | `seller_signature` verified against `didToPublicKey(quote.seller)` — NOT the request sender's DID |
| **Validation order** | (1) State guard (COMMIT_PENDING) → `409`, (2) Verify seller signature against stored quote canonical bytes, using `quote.seller`'s public key → `401`, (3) Transition to COMMITTED, (4) Append `QUOTE_COMMITTED` event |
| **State changes** | Transitions `COMMIT_PENDING → COMMITTED` |
| **Information returned** | Fully-signed quote |
| **Side effects** | Event appended, SSE notification, commitment timeout timer cancelled |

### Endpoint: `GET /rfqs/:id/events`

| Property | Detail |
|----------|--------|
| **Who can call** | Authenticated buyer or seller |
| **Authentication** | Ed25519 signed request or bearer token (plan M3 notes: SSE/EventSource doesn't support custom headers — needs query parameter token or cookie) |
| **Validation order** | (1) Authenticate caller, (2) Retrieve events, (3) `filterEventsForRole()`, (4) Apply cursor (`?after=<uuid>`), (5) Return filtered events |
| **State changes** | None (read-only) |
| **Information returned** | Role-scoped events with opaque UUID cursors. Buyer sees all. Seller sees only their own. |
| **Side effects** | SSE connection held open if `Accept: text/event-stream`. Subscriber registered in EventStore. |

### Endpoint: `GET /metrics`

| Property | Detail |
|----------|--------|
| **Who can call** | Anyone (no authentication mentioned) |
| **Authentication** | None specified |
| **Validation order** | None |
| **State changes** | None |
| **Information returned** | Active session count, total events, per-route latency |
| **Side effects** | None, but information disclosed is useful for reconnaissance |

---

## 3. Defense Interaction Analysis

### DI-1: Offer Cap (D12) vs Event Cap (D13)

**Question:** Does the offer cap interact badly with the event cap?

**Analysis:** The plan explicitly decoupled these. Offers have their own cap (50/session, 5/DID) separate from the 500-event session cap. Offers count toward the event cap, but the offer cap fires first (50 << 500). This means:
- A pure offer-flooding attack is stopped at 50 offers, well before the 500-event cap.
- The event cap now primarily limits buyer counter spam (only the buyer sends counters) and legitimate high-activity sessions.
- Terminal actions (accept, cosign) bypass the event cap, so a session at 500 events can still complete.

**Verdict: No conflict. The decoupling is correct and well-designed.** The offer cap defends against the specific Sybil vector (Chain-1), while the event cap provides a general safety net.

### DI-2: Session Lock (D2/D3) vs Deadline Enforcer (D10)

**Question:** Does the session lock interact badly with the deadline enforcer?

**Analysis:** The deadline enforcer needs to acquire the per-session lock to transition state. If the lock queue is full (10 pending), the enforcer gets `429` or must wait. This was flagged in the security audit (M2).

**Mitigations in place:**
1. D4 (deadline check inside lock) — Every handler independently checks the deadline as its first action. Even if the enforcer is delayed, no post-deadline request succeeds.
2. The lock queue of 10, with 50ms average ZK verification, clears in ~500ms. The enforcer's 1-second interval means it typically finds the queue empty on the next tick.

**Remaining gap:** Under sustained load (10 concurrent requests continuously), the enforcer could be delayed for seconds. However, D4 ensures correctness — the enforcer is responsible for cleanup (transitioning to EXPIRED and appending the event), but no handler will accept a post-deadline request even without the enforcer.

**Verdict: No functional gap due to D4 defense-in-depth. The enforcer should still get priority access for cleanliness (append the EXPIRED event promptly), but security is not compromised by delays.**

### DI-3: UUID Tombstone (D8) vs Session Pruning

**Question:** Does the UUID tombstone interact badly with session pruning?

**Analysis:** Session pruning removes sessions 60 minutes after terminal transition. When a session is pruned, its object IDs move to the tombstone set (retained for 60 minutes). The timeline is:
1. Session created at T=0
2. Session reaches terminal state at T=X
3. Session pruned at T=X+60min
4. Tombstones for that session's IDs created at T=X+60min
5. Tombstones evicted at T=X+120min

**Concern:** Between T=X+120min and T=infinity, the IDs are no longer in any set. A replayed request with the same `rfq_id` would create a new session. However:
- The original session's events are gone (pruned).
- A replayed RFQ would have a `deadline` in the distant past → rejected at step 4 (`422 invalid_deadline`).
- A replayed offer/counter references an `rfq_id` that no longer exists → `404`.
- Only a fully replayed RFQ with all original fields could potentially succeed, but its deadline would be expired.

**Verdict: No practical gap. Deadline validation provides independent protection against post-pruning replay.** The tombstone gap is real but unexploitable due to deadline checks.

### DI-4: Control Envelope Nonce (D7) vs Accept Limit (D14)

**Question:** Does the control envelope nonce interact badly with the accept limit?

**Analysis:** Each accept request requires a unique `envelope_id` (tombstoned after use). The accept limit is 6 per session (2 per seller). These are independent counters:
- Envelope nonce prevents replay of the SAME accept request.
- Accept limit prevents DIFFERENT accept requests beyond the threshold.

A scenario: buyer sends accept #1 with `envelope_id: "aaa"` → succeeds. Seller times out. Buyer sends accept #2 with `envelope_id: "bbb"` → succeeds (same seller, attempt 2/2). Seller times out again. Buyer sends accept #3 with `envelope_id: "ccc"` targeting same seller → rejected by per-seller limit (2). Buyer targets a different seller. After 6 total attempts → `422 accept_limit_exceeded`.

If the buyer tries to replay `envelope_id: "aaa"` → `409 duplicate_control_envelope` (tombstoned). If the buyer sends a NEW envelope for the same action after limit reached → `422 accept_limit_exceeded`.

**Verdict: No conflict. The nonce and limit operate on orthogonal dimensions (uniqueness vs count).**

### DI-5: Commitment Timeout (D11) vs Session Lock (D2)

**Question:** Could the commitment timeout fire while the lock is held by a cosign request?

**Analysis:** Both the commitment timeout (fired by the deadline enforcer) and the cosign handler need the session lock. The lock serializes them:
- If cosign acquires lock first → cosign completes, state becomes COMMITTED, timeout timer is cancelled → no conflict.
- If enforcer acquires lock first → state reverts to NEGOTIATING, timeout event appended → cosign finds state is NEGOTIATING, not COMMIT_PENDING → `409`. The seller's signature is wasted, but no state corruption occurs.

**Verdict: No conflict. Serialization ensures exactly one of (cosign, timeout) succeeds. This is the correct behavior.**

---

## 4. Residual Risk Assessment

After all 24 defenses, the following attacks remain theoretically possible. Each is rated for practical difficulty and impact.

### RR-1: Budget Discovery via Counter Price Observation

| Property | Detail |
|----------|--------|
| **Attack** | Seller submits escalating offers, observes buyer's counter prices across rounds. Rising counters reveal a tightening lower bound on `budget_hard`. |
| **Defenses in place** | ZK proof (hides exact `budget_hard`), documented limitation, strategy recommendation (never counter above `budget_soft`) |
| **Practical difficulty** | **Trivial** — Any seller participating in negotiation observes counter prices as part of normal protocol flow. No special tooling needed. |
| **Impact** | **Medium** — Seller learns `budget_hard >= max(observed_counters)`. If buyer follows recommendation (counter <= `budget_soft`), seller learns a bound on `budget_soft`, not `budget_hard`. The gap between `budget_soft` and `budget_hard` remains hidden. |
| **Residual risk** | **Accepted** — Inherent to any iterative negotiation protocol. The ZK proof prevents exact discovery. Strategy discipline prevents tight bounds. Fully solving this requires single-round sealed-bid auctions, which contradicts the multi-round negotiation design. |

### RR-2: SSE Timing Side Channel

| Property | Detail |
|----------|--------|
| **Attack** | Seller measures time gaps between events on their SSE stream. Long gaps indicate buyer is negotiating with other sellers. |
| **Defenses in place** | Opaque cursors (prevent count-based gap analysis), documented limitation |
| **Practical difficulty** | **Trivial** — Any connected seller with a stopwatch can measure inter-event timing. |
| **Impact** | **Low** — Reveals negotiation cadence and approximate competitor count, but not prices or identities. Competitive intelligence, not financial harm. |
| **Residual risk** | **Accepted** — Mitigatable with artificial jitter (not implemented in v1). The plan acknowledges this as a future enhancement. In practice, negotiation timing is already partially visible through offer response times. |

### RR-3: Sybil Offer Pollution (Reduced but Not Eliminated)

| Property | Detail |
|----------|--------|
| **Attack** | Attacker generates multiple keypairs, submits 50 junk offers (10 DIDs × 5 each) to pollute a session. |
| **Defenses in place** | Offer cap (50/session, 5/DID), event cap (500), rate limiting (100 req/min per IP) |
| **Practical difficulty** | **Moderate** — Requires generating 10 keypairs (trivial) and submitting 50 authenticated requests (must bypass IP rate limiting or use multiple IPs). With a single IP: 100 req/min limit means ~30 seconds to submit 50 offers. |
| **Impact** | **Low** — 50 junk offers consume quota but don't kill the session (cap is 50, not 500). Buyer can still counter and accept with legitimate sellers. The offers are at absurd prices that the buyer's strategy ignores. No state corruption. |
| **Residual risk** | **Acceptable** — The 50-offer cap bounds the damage. Optional 8004 registry requirement makes Sybil attacks economically expensive. For MVP, this is a minor annoyance, not a security breach. |

### RR-4: Commitment Timeout Griefing (Reduced)

| Property | Detail |
|----------|--------|
| **Attack** | Sybil sellers get accepted, deliberately don't cosign, burning buyer's time (6 attempts × 60s = 360s max). |
| **Defenses in place** | Per-seller accept limit (2), global accept limit (6), configurable timeout (15-120s) |
| **Practical difficulty** | **Moderate** — Requires 3+ Sybil seller identities with competitive offers (buyer must actually accept them). The buyer's strategy determines which sellers get accepted — absurd-price Sybils won't be selected. |
| **Impact** | **Medium** — Worst case: 6 × 60s = 6 minutes. With 30s timeout: 3 minutes. For a 10-minute deadline, this is significant but not fatal. Buyer can still complete a deal with the remaining time if legitimate sellers are available. |
| **Residual risk** | **Acceptable** — Significantly reduced from unbounded. Operators can tune timeout lower (30s) for public deployments. The attacker must offer competitive prices to get accepted, which costs them if the buyer signs quickly and the seller has to actually cosign. |

### RR-5: Metrics Endpoint Information Disclosure

| Property | Detail |
|----------|--------|
| **Attack** | Unauthenticated access to `GET /metrics` reveals active session count, event totals, per-route latency. |
| **Defenses in place** | None — the plan does not authenticate this endpoint. |
| **Practical difficulty** | **Trivial** — Public HTTP GET request. |
| **Impact** | **Low** — Reveals operational metrics but no session-specific data. Attacker can time their attacks for high load or infer ZK verification activity from latency spikes. |
| **Residual risk** | **Should fix** — Authenticate the endpoint or bind it to a separate internal port. For MVP/demo, this is a low-priority issue since the engine is not public-facing. |

### RR-6: SSE Authentication Gap

| Property | Detail |
|----------|--------|
| **Attack** | Browser `EventSource` doesn't support custom headers. If SSE auth requires Ed25519 headers, legitimate clients can't use `EventSource`. If auth falls back to query parameter tokens, tokens may appear in server logs and URL bars. |
| **Defenses in place** | Plan requires authentication on `GET /events` but doesn't specify the SSE-specific mechanism. |
| **Practical difficulty** | **Hard** — Exploiting this requires knowing the auth token mechanism and intercepting it. The plan's demo uses agent-to-agent communication (not browser), so `EventSource` limitations may not apply. |
| **Impact** | **Low** (for MVP) — Demo agents use HTTP clients that support custom headers. Production would need a cookie or short-lived token mechanism. |
| **Residual risk** | **Deferred** — Not a concern for MVP demo. Must be addressed before production deployment. |

### RR-7: Deadline Enforcer Event Loop Starvation

| Property | Detail |
|----------|--------|
| **Attack** | Attacker submits counter-offers with ZK proofs to 20+ concurrent sessions. Each ZK verification takes ~50ms synchronously, blocking the event loop for ~1 second. Deadline enforcer `setInterval` is delayed. |
| **Defenses in place** | D4 (in-handler deadline check) prevents post-deadline requests regardless of enforcer timing. |
| **Practical difficulty** | **Hard** — Requires 20+ sessions with ZK commitments, each with a valid counter-offer and proof. Must be timed precisely around a deadline. |
| **Impact** | **Low** — Even with enforcer delayed, D4 prevents post-deadline state changes. The only effect is that the `NEGOTIATION_EXPIRED` event is appended slightly late (by seconds). No state corruption. |
| **Residual risk** | **Acceptable for MVP** — Moving ZK verification to worker threads would eliminate this for production. The defense-in-depth of D4 makes this non-exploitable for state manipulation. |

### RR-8: Engine Compromise (Operator Threat)

| Property | Detail |
|----------|--------|
| **Attack** | A compromised engine operator modifies the engine code to return tampered quotes (wrong `final_price`, wrong `payment_endpoint`). |
| **Defenses in place** | Client-side quote verification contract (D16) — both parties should locally reconstruct the expected quote. |
| **Practical difficulty** | **Moderate** — Requires operator-level access. |
| **Impact** | **High** — If clients don't verify, money is stolen. If clients verify (as documented), attack fails. |
| **Residual risk** | **Accepted with caveat** — This is inherent to any centralized engine. The client-side verification contract is advisory, not enforced. In production, multiple independent engines or a verification relay would reduce this trust assumption. |

### RR-9: Post-Restart UUID Replay

| Property | Detail |
|----------|--------|
| **Attack** | After engine restart, tombstones are lost. A replayed request with a previously-used UUID could be processed. |
| **Defenses in place** | Deadline validation (expired RFQs rejected), session non-existence (offers/counters for pruned sessions get `404`) |
| **Practical difficulty** | **Hard** — Requires (a) engine restart, (b) replay within the deadline window (RFQ must still be valid), (c) original session was pruned. Given 60-minute retention, the attacker has a narrow window where the RFQ deadline hasn't expired but the session was pruned AND the engine restarted. |
| **Impact** | **Low** — In the narrow exploit window, a duplicate session could be created. But the buyer's keypair would need to re-sign everything (signatures are non-replayable to different nonces). |
| **Residual risk** | **Accepted for MVP** — SQLite persistence eliminates this entirely. |

---

## 5. Overall Assessment

### Defense Coverage Summary

| Category | Defenses | Coverage |
|----------|----------|----------|
| **Authentication & Authorization** | D6, D7, D21 | **Strong** — Every write endpoint has signer identity binding. Control envelopes prevent replay. Role-scoped views enforce information boundaries. |
| **State Machine Integrity** | D1, D2, D4, D5, D15 | **Excellent** — Event sourcing, per-session locks, deadline checks inside locks, state guards, and quote immutability form a comprehensive defense against state corruption. |
| **DoS / Resource Exhaustion** | D3, D10, D12, D13, D14, D19 | **Good** — Offer caps, event caps, accept limits, lock queue bounds, and rate limiting address all identified flooding vectors. Some residual risk from Sybil (RR-3) is bounded. |
| **Privacy / Information Leakage** | D20, D21, D23, D24 | **Adequate** — Opaque cursors, role-scoped filtering, and ZK error sanitization address most leakage vectors. Inherent protocol-level leaks (counter prices, timing) are documented as known limitations. |
| **Spec Compliance** | D9, D17, D18 | **Good** — Validation ordering matches Spec exactly. Extension preservation and counter `to` validation now addressed. |
| **Payment Security** | D6, D15, D16 | **Strong** — Quote immutability, signer identity binding on cosign, and explicit `payment_endpoint` provenance prevent payment manipulation. Client-side verification adds defense-in-depth. |

### Findings from Previous Audits — Resolution Status

| Finding | Source | Status |
|---------|--------|--------|
| C1: Validation order deviation (counter) | Security audit | **Resolved** — Plan reverted to Spec order with explicit note. |
| C2: Validation order deviation (offer) | Security audit | **Resolved** — Sig verification runs before state guard per Spec. |
| C3: RFQ validation order ambiguity | Security audit | **Resolved** — Plan clarifies middleware stack. |
| H1: POST /accept auth not explicit | Security audit | **Resolved** — Signed control envelope required. |
| H2: PUT /quote/sign signer identity | Security audit | **Resolved** — Verifies against `didToPublicKey(quote.buyer)`. |
| H3: PUT /cosign seller identity | Security audit | **Resolved** — Verifies against `didToPublicKey(quote.seller)`. |
| H4: unexpected_budget_proof | Security audit | **Resolved** — Added to counter verification step 7. |
| H5: Event cursor gap analysis | Security audit | **Resolved** — Opaque UUID cursors. |
| H6: commitment_salt in errors | Security audit | **Resolved** — ZK errors return generic messages. |
| M1: Tombstone memory growth | Security audit | **Partially resolved** — Authenticated-only tombstoning limits growth, but no explicit size cap. |
| M2: Deadline enforcer lock priority | Security audit | **Mitigated** — D4 provides defense-in-depth. No explicit priority, but correctness is guaranteed. |
| M3: SSE authentication mechanism | Security audit | **Deferred** — Not specified for v1. |
| M4: Metrics endpoint unauthenticated | Security audit | **Not addressed** — Still unauthenticated. |
| RT-C1: payment_endpoint injection | Red team | **Resolved** — D16 (provenance from listing). |
| RT-C4: Budget brute force via counters | Red team | **Accepted** — Documented as inherent limitation. |
| RT-C5: Seller impersonation on cosign | Red team | **Resolved** — D6 (identity binding). |
| Chain-1: Sybil flood + event cap | Red team | **Resolved** — D12 (offer admission control). |
| RT-C3: Commitment timeout cycling | Red team | **Mitigated** — D14 (global accept limit). |
| RT-H1: Lock queue saturation | Red team | **Mitigated** — D12 (per-session offer limits). |
| RT-H4: Event cursor gap analysis | Red team | **Resolved** — D20 (opaque cursors). |
| F1: Extension preservation missing | Spec compliance | **Resolved** — D17. |
| F2: Counter `to` validation missing | Spec compliance | **Resolved** — D18. |
| F3: Currency-to-mint resolution implicit | Spec compliance | **Resolved** — Plan now explicitly mentions `mintFor()` resolution. |

### Verdict

**The defense posture is STRONG for an MVP/demo deployment.** The plan addresses all CRITICAL and HIGH findings from previous audits. The residual risks are either inherent to the protocol design (counter price information leaks), bounded by explicit caps (Sybil griefing), or deferred with documented tradeoffs (SSE auth, metrics endpoint).

**Recommended priorities for production hardening (post-MVP):**
1. Require 8004 Agent Registry enrollment for offer submission (Sybil resistance)
2. Move ZK verification to worker threads (event loop protection)
3. Implement SSE authentication mechanism (query param token or cookie)
4. Authenticate or isolate the metrics endpoint
5. Add tombstone size cap with LRU eviction
6. Add optional event delivery jitter for timing side channel mitigation
7. Persist tombstones to SQLite for restart resilience

None of these are blocking for the demo/hackathon deployment. The current defense set is sufficient for a controlled demonstration environment.
