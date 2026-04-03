# Security Audit: Negotiation Engine Plan vs Ghost Bazaar Spec v4

**Auditor:** Security Review (Claude Opus 4.6)
**Date:** 2026-03-20
**Scope:** `plans/engine-plan.md` against `GHOST-BAZAAR-SPEC-v4.md`

---

## CRITICAL Findings (Must Fix Before Implementation)

### C1: Validation Order Deviates from Spec — Counter-Offer Route

**Spec §8 Counter-Offer Verification** prescribes a strict 12-step order where:
- Step 6: `counter.from === rfq.buyer` check
- Step 7: ZK proof verification
- Step 8: Ed25519 signature verification
- Step 9: State machine guard
- Step 10: Round monotonicity

**Plan reorders** to: schema → RFQ exists → state guard → `from===buyer` → `to` valid seller → round monotonicity → field validation → Ed25519 → ZK → append event.

The plan explicitly says "DoS-hardened" reordering to reject cheap checks first. However, the Spec uses the verb **"MUST validate in this order"** (RFC 2119 MUST). This means the validation order is normative, not advisory. A conforming engine MUST follow the Spec order exactly.

**Attack scenario:** A malicious implementation or interop tester sends a request that would fail at Spec step 6 (`unauthorized_counter`) but passes plan step 3 (state guard). The engine returns `409 invalid_state_transition` instead of `422 unauthorized_counter`. This is an interop-breaking difference — clients relying on specific error codes for specific failure modes get wrong codes.

**Fix:** Follow the Spec's exact validation order for all three write endpoints (RFQ, Offer, Counter). The performance argument for reordering is weak — the 50ms ZK verification runs last in both orderings, and signature verification (~1ms) is not worth breaking spec compliance.

### C2: Offer Route Validation Order Also Deviates from Spec

**Spec §8 Offer Submission** prescribes:
1. Schema → 2. RFQ lookup → 3. Price valid → 4. Currency match → 5. Expiry valid → 6. **Signature verify** → 7. **State guard** → 8-10. Transition + append + return.

**Plan puts state guard middleware BEFORE signature verification** (middleware stack: error-handler → require-state → validate-signature → handler). This means an unauthenticated request gets a `409` instead of `401` if the state is wrong. The Spec requires signature verification (step 6) before state check (step 7).

**Attack scenario:** Information leakage. An unauthenticated attacker can probe session state by sending unsigned offer requests and observing whether they get `401` (state was valid, signature failed) or `409` (state was invalid). With Spec ordering, they always get `400`/`422`/`401` before ever reaching the state guard.

**Fix:** Restructure middleware so signature verification runs before state guard, matching Spec order.

### C3: RFQ Route Validation Order — Signature Before Session Creation

**Spec §8 RFQ Submission** prescribes signature verification at step 7, *after* field-level checks (steps 1-6) but *before* session creation (step 8). The plan's middleware architecture applies `validate-signature` as a middleware before the handler, which is correct order-wise IF the handler runs the field validation first. However, the plan's middleware stack diagram shows `require-state → validate-signature` — for `POST /rfqs`, there's no session yet, so `require-state` doesn't apply, but the plan must ensure no session is created before signature passes.

**Confirmed:** The plan says signature middleware runs before the handler, and the handler calls `validateRfq()` plus engine checks then appends the event. Need to verify during implementation that `validateRfq()` covers Spec steps 1-6 and runs BEFORE the signature middleware result is consumed. If `validateRfq()` runs inside the handler AFTER signature middleware, but signature middleware is also after field validation middleware, this could be correct. The plan is ambiguous here — clarify during implementation.

---

## HIGH Findings (Should Fix)

### H1: `POST /accept` Authentication Not Explicit in Middleware

**Spec §5.6 step 2:** "Verify request sender is `rfq.buyer` → `401 invalid_buyer_signature` if not (accept MUST be authenticated)."

The plan mentions `POST /accept` validates "state=NEGOTIATING, requester=buyer, seller exists, offer valid" but does NOT explicitly list `validate-signature` middleware on this route. The route file `accept.ts` is listed separately from `quote-sign.ts` and `cosign.ts`. If the accept route omits Ed25519 signature verification, any party (or attacker) could trigger `NEGOTIATING → COMMIT_PENDING` by knowing a valid seller DID and offer ID.

**Attack scenario:** Seller self-selects as winner by forging an accept request, locking out other sellers. If accept is unsigned, the seller only needs the RFQ ID and their own offer ID.

**Fix:** Explicitly require Ed25519 signature verification middleware on `POST /accept`, verifying the signer is `rfq.buyer`.

### H2: `PUT /quote/sign` — Missing Signer Identity Verification

**Spec §5.6 step 9:** Engine validates the **buyer** Ed25519 signature. The plan says "Validates buyer signature via `verifyEd25519`" but the middleware `validate-signature.ts` is generic. The plan does not describe how the engine ensures the signature on `PUT /quote/sign` was made by `rfq.buyer` specifically (not just any valid Ed25519 signature).

**Attack scenario:** A seller or third party generates a valid Ed25519 signature with their own key and submits it as `buyer_signature`. If the engine only verifies the signature is valid against *some* key (extracted from the request), but doesn't verify it's the buyer's key signing the quote canonical bytes, the quote gets a valid but wrong buyer signature.

**Fix:** Explicitly verify that the signer DID matches `rfq.buyer` for `PUT /quote/sign` and matches the selected seller DID for `PUT /cosign`.

### H3: `PUT /cosign` — Missing Seller Identity Check

Same as H2 but for the seller side. **Spec §5.6 step 16** requires verifying the seller Ed25519 signature. The engine must verify that `seller_signature` was produced by the specific seller DID selected in the `WINNER_SELECTED` event, not by any seller who participated.

**Attack scenario:** A different seller who submitted offers (but was not selected) could cosign, creating a committed quote with the wrong seller identity. This is especially dangerous because the quote's `seller` field was set during `buildUnsignedQuote` — if the cosigning seller differs from `quote.seller`, settlement would fail, but the session is now stuck in `COMMITTED`.

### H4: No `unexpected_budget_proof` Check Documented

**Spec §8 Counter step 7:** "If `rfq.budget_commitment` is absent and `counter.budget_proof` is present → `422 unexpected_budget_proof`."

The plan's 12-step counter verification (lines 216-226) does not mention this check. If a counter includes an unsolicited budget proof for an RFQ without a commitment, the engine should reject it to prevent confusion or potential oracle attacks where a proof presence is used to infer the buyer has a budget.

**Fix:** Add the `unexpected_budget_proof` check to the counter verification flow.

### H5: `GET /events` Role-Scoped Filtering Could Leak Event Counts

The plan describes role-scoped views: sellers see only their own events, buyers see all. However, if the SSE cursor (`event_id`) is a monotonically increasing integer across all events in the session, a seller can infer how many events they are NOT seeing by observing gaps in the cursor sequence.

**Attack scenario:** Seller A sees events with IDs [1, 5, 8]. They deduce events 2-4, 6-7 exist (likely other sellers' offers or buyer counters to other sellers). This reveals the buyer is negotiating with exactly N other sellers and the approximate pace.

**Fix:** Either use opaque cursors (UUIDs), or per-role cursor sequences, or accept this as a known information leak and document it. The Spec does not define event filtering — this is an engine design choice. If seller event filtering is implemented, the cursor must not leak event count.

### H6: `commitment_salt` Leakage Risk in Error Messages

**Spec §15:** `budget_hard` never in protocol messages; Poseidon commitment is computationally hiding.

The plan's error handling section says "Private state (budget_hard, floor_price, commitment_salt) MUST NEVER appear in logs." Good. But the plan does not discuss:
1. ZK proof verification error details — if `verifyBudgetProof` throws with a stack trace containing internal proof values, the error handler must sanitize before logging.
2. What `422 invalid_budget_proof` returns in its `message` field — must not include proof inputs or commitment details.

**Fix:** Specify that all ZK-related error messages contain only the error code and a generic message. Never include proof inputs, commitment values, or internal circuit values.

---

## MEDIUM Findings (Nice to Fix)

### M1: Tombstone Set Memory Leak After Restart

The plan acknowledges tombstone loss on restart. But more critically, the `tombstoneSet` grows indefinitely during a long-running session. With 10,000 UUID4s at ~36 bytes each, this is ~360KB — negligible. But the plan has no size limit on `tombstoneSet`, while `EventStore` has a 10,000 event warning. Consider bounding tombstones similarly.

### M2: Session Lock Queue — No Priority for Deadline Enforcer

The session lock queue is bounded at 10 pending requests. If 10 requests are queued, the deadline enforcer (which also needs the lock) gets `429`. This could delay expiration, keeping a session alive beyond its deadline.

**Fix:** Give the deadline enforcer priority access to the lock (bypass the queue limit), or run the deadline check inside the lock acquisition path itself.

### M3: SSE Event Stream — No Authentication Mentioned for EventSource

The plan says `GET /events` requires authentication. But browser `EventSource` does not support custom headers. If clients use `EventSource`, they cannot send `Authorization` or Ed25519 signature headers. The plan should specify how SSE authentication works (query parameter token, cookie, etc.) and ensure the auth token doesn't leak in server logs or URLs.

### M4: `GET /metrics` Endpoint — Information Disclosure

The plan exposes `GET /metrics` with session counts, event totals, and per-route latency. This is unauthenticated (no auth mentioned). An attacker can enumerate active sessions and monitor engine activity.

**Fix:** Either authenticate the metrics endpoint or rate-limit it heavily. For production, use a separate internal port.

### M5: Registry Enrichment SSRF Partial Mitigation

The plan mentions sanitizing registry data (strip HTML, validate URLs, clamp scores). Good. But if `discoverAgent()` itself makes HTTP calls to attacker-controlled registry entries, the SSRF risk is in the registry client, not the enricher. Verify that `@ghost-bazaar/agents` doesn't follow arbitrary URLs from on-chain data.

### M6: Demo Hardcoded Private State Values

Step 12 lists demo values: `budget_hard=$45, budget_soft=$40`. These appear in the plan document itself. While this is a plan (not code), ensure the demo implementation loads these from config or environment, never hardcoded in source that could be served or logged.

### M7: `CANCELLED` State — No HTTP Endpoint but Events Could Reveal

The Spec says cancellation is engine-internal (no HTTP endpoint). The plan's `NEGOTIATION_CANCELLED` event would be visible on the SSE stream. If a seller is connected via SSE, they learn the buyer cancelled (vs. expired). This is a minor information leak — the Spec doesn't prohibit it, but it reveals buyer intent.

### M8: Quote Revision Counter Without Bound

The plan introduces `quote_revision` (not in the Spec). A buyer could theoretically cycle accept → seller decline → re-accept repeatedly, incrementing the revision counter and creating many `WINNER_SELECTED` + `COSIGN_DECLINED` event pairs. The per-session 500-event cap eventually catches this, but a more targeted limit (e.g., max 5 accept attempts per session) would be cheaper to enforce.

---

## Confirmed Secure Patterns (What the Plan Does Well)

### S1: Event Sourcing with Immutable Append-Only Log
The plan's core architecture — derive state from events, never mutate — is the correct approach. It provides audit trails, replay verification, and eliminates an entire class of state corruption bugs.

### S2: Per-Session Async Queue for Concurrency
The promise-chain serialization per `rfq_id` is a solid concurrency primitive. It prevents race conditions without global locks and handles the deadline-vs-request race correctly.

### S3: Quote Immutability — No Client-Supplied Quote Fields
The plan specifies that `PUT /quote/sign` and `PUT /cosign` accept only signature fields, with the engine verifying against stored canonical bytes. This prevents TOCTOU attacks on quote content.

### S4: Deadline Check Inside Lock
Checking `Date.now() >= rfq.deadline` as the first action inside the lock (not at lock acquisition time) prevents the "queued before deadline, executed after" exploit.

### S5: UUID Uniqueness Enforcement with Tombstones
Preventing ID reuse across sessions with tombstone retention is good defense against replay of entire protocol objects.

### S6: Lock Timeout + Queue Bound
The 5-second lock timeout and 10-request queue bound prevent lock starvation and unbounded resource consumption.

### S7: Per-Session Event Cap (500)
Defending against event flooding with a hard cap is a practical DoS mitigation not present in the Spec but sensible for an engine implementation.

### S8: Commitment Timeout (30s)
Preventing a griefing attack where a seller locks the buyer in `COMMIT_PENDING` forever is a critical addition. The Spec's `COMMIT_PENDING → NEGOTIATING` transition enables this, but the plan adds the timeout enforcement.

### S9: DoS-Ordered Counter Verification (Intent)
While the specific reordering violates Spec order (see C1), the intent to put cheap checks before expensive ZK verification is correct engineering. The fix is to follow Spec order — which already puts ZK last (step 7d) and signature second-to-last (step 8).

### S10: Registry Data Sanitization
Sanitizing HTML, validating URLs, and clamping scores from external registry data is correct defense against injection via on-chain data.

---

## Summary

| Severity | Count | Key Theme |
|----------|-------|-----------|
| CRITICAL | 3 | Validation order deviates from Spec's normative MUST; interop-breaking |
| HIGH | 6 | Missing authentication on accept, identity checks on sign/cosign, ZK edge case |
| MEDIUM | 8 | Memory bounds, SSE auth, metrics exposure, info leaks |
| SECURE | 10 | Strong event sourcing, concurrency model, quote immutability, DoS defense |

**Overall assessment:** The plan is architecturally sound with excellent concurrency and DoS defense. The critical findings are all about **validation order compliance** — the Spec uses "MUST validate in this order" which is normative. The high findings are about **authentication gaps** on write endpoints where the plan is insufficiently explicit. These are fixable during implementation without architectural changes.
