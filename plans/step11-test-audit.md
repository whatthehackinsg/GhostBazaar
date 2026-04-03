# Step 11 Test Quality Audit Report

## 1. E2E Test Quality (integration.test.ts)

### Findings sorted by severity

#### HIGH — E2E-2: Missing status assertions on sign/cosign responses
- **File:** integration.test.ts:452-455
- **Description:** After accept, the test calls `submitQuoteSign` and `submitCosign` without checking their return status codes. If either silently fails (e.g., returns 400), the test relies solely on the final `session.state === "COMMITTED"` check which could pass if the session manager has a bug that allows state advancement without valid signatures.
- **Fix:** Add `expect(...status).toBe(200)` for both sign and cosign calls, matching E2E-1's pattern.

#### HIGH — E2E-3: Same missing status assertions
- **File:** integration.test.ts:516-519
- **Description:** Same issue as E2E-2. The counter-offer flow skips status assertions on `submitRfq`, `submitOffer` (first), `submitOffer` (second), `submitQuoteSign`, and `submitCosign`.
- **Fix:** Assert status on every HTTP call.

#### HIGH — E2E-4: Missing status assertions on intermediate calls
- **File:** integration.test.ts:544-550, 566, 591-594
- **Description:** Several calls (`submitRfq`, `submitOffer` x2, `submitQuoteSign` x2, `submitCosign`) lack status assertions. The decline→re-accept flow is complex; any intermediate failure would be masked.
- **Fix:** Assert status on every HTTP call.

#### MEDIUM — E2E-7: SSE test has race condition / flakiness risk
- **File:** integration.test.ts:724-751
- **Description:** The test does NOT use SSE streaming mode properly. It submits RFQ + offer, THEN opens the SSE stream. Since events are already stored, this tests replay-to-SSE, not live delivery as claimed. Also, `readSSEFrames` uses a 500ms timeout with `Promise.race` — on slow CI, the reader may not receive all frames before timeout. The frame-splitting logic (`frames.push(text)`) doesn't parse SSE protocol properly (data can span multiple chunks or be partial).
- **Fix:** (a) Rename to clarify it tests replay-via-SSE, not live push. (b) Increase timeout or add retry logic. (c) Consider parsing SSE frames properly (split on `\n\n`).

#### MEDIUM — E2E-5/6: Timer switching pattern is fragile
- **File:** integration.test.ts:617-647, 663-716
- **Description:** Both deadline tests switch between real and fake timers mid-test (`vi.useRealTimers()` then `vi.useFakeTimers({ now: Date.now() })`). This pattern works but is fragile — any async operation that straddles the timer switch boundary can behave unpredictably. The `beforeEach/afterEach` setup calls `vi.useFakeTimers()` but the first thing in the test body is `vi.useRealTimers()`, making the beforeEach a no-op.
- **Fix:** Remove the fake-timer `beforeEach` or restructure to avoid switching mid-test.

#### MEDIUM — E2E-10: Tests cancellation via internal API, not HTTP
- **File:** integration.test.ts:901-914
- **Description:** Cancellation is tested by directly calling `sessionManager.withLock/appendEvent`, bypassing HTTP entirely. This doesn't test the actual HTTP cancel endpoint (if one exists) or validate that HTTP-level auth/validation applies. The assertion that a subsequent offer returns 409 is good, but the cancellation trigger is an integration shortcut.
- **Fix:** If a cancel HTTP endpoint exists, use it. If not, document that cancellation is engine-internal only.

#### LOW — E2E-9: Privacy test doesn't cover sign/cosign/decline responses
- **File:** integration.test.ts:826-875
- **Description:** The privacy test collects responses from RFQ, offer, counter, revised offer, accept, and events — but NOT from `quote/sign`, `cosign`, or `decline`. If those endpoints accidentally echo back private fields, it would be missed.
- **Fix:** Add sign, cosign, and decline responses to `responseTexts`.

#### LOW — Test isolation is correct
- Each `describe` block has its own `beforeEach` creating a fresh app. E2E-5/6 create inline. E2E-7 creates inline. No shared mutable state across tests.

#### LOW — Signing helpers are correct
- Patterns match `quote-flow.test.ts` exactly: `objectSigningPayload` for RFQ/offer/counter/envelope, `canonicalJson` with zeroed signatures for quote signing.

---

## 2. Fuzz Test Quality (fuzz.test.ts)

### Findings sorted by severity

#### CRITICAL — Fuzz actions use pre-check guards that prevent reaching deep states
- **File:** fuzz.test.ts:312-313 (counter), :328 (accept), :341-342 (sign), :352-353 (cosign), :367-368 (decline), :419 (cosignTimeout)
- **Description:** Every non-offer action has `if (!session || ...) break` guards that check current session state before attempting the action. This means invalid-state actions are silently skipped rather than submitted via HTTP. The problem: the fuzz test NEVER tests that the engine correctly rejects invalid-state transitions via HTTP. It only exercises the happy-path actions that the fuzz itself pre-validates. This is a fundamental weakness — the fuzz cannot find bugs where the engine allows transitions it shouldn't.
- **Fix:** Remove pre-checks (or make them optional). Submit all actions via HTTP unconditionally and verify the engine returns 4xx for invalid ones. Invariants should hold regardless.

#### HIGH — Invariant 5 (terminal absorption) has a logic gap
- **File:** fuzz.test.ts:489-494
- **Description:** The terminal check sets `prevTerminal = session.state` AFTER checking `if (prevTerminal)`. But consider: if the session reaches EXPIRED, `prevTerminal` is set. Next iteration, if an action is a no-op (due to pre-check guards), session stays EXPIRED, and the assertion passes trivially. The invariant never actually tests that a REAL action (submitted via HTTP) against a terminal state is rejected. Because of the pre-check guards above, no HTTP request is ever made against a terminal-state session.
- **Fix:** Submit actions via HTTP even in terminal states and verify the session state doesn't change.

#### HIGH — Invariant 6/7/8: Weakened to only check OPEN/NEGOTIATING
- **File:** fuzz.test.ts:497-519
- **Description:** Comments say "terminal states may preserve fields from COMMIT_PENDING" — but the ACTUAL `deriveState` implementation (session.ts:305-311) explicitly nullifies ALL commitment state on COSIGN_DECLINED/COSIGN_TIMEOUT rollback. The invariants were weakened to accommodate a behavior that doesn't exist. In terminal states (EXPIRED, CANCELLED), `selectedSeller`/`unsignedQuote`/`buyerSignature` are NOT preserved after rollback — they should also be null if reached via rollback→expire path.
- **Fix:** Add assertions for terminal states: if `state === EXPIRED/CANCELLED` AND the session went through a rollback before expiring, quote fields should be null.

#### MEDIUM — Action model is too heavily weighted toward offers
- **File:** fuzz.test.ts:100-110
- **Description:** `offer` weight=5, `counter` weight=3, `accept` weight=2. With 30 max actions, most runs will be dominated by offers with occasional other actions. The probability of reaching COMMITTED (requires offer→accept→sign→cosign in sequence) in a random 30-action run is low. The fuzz may never exercise the QUOTE_SIGNED or QUOTE_COMMITTED transitions.
- **Fix:** Either increase `maxLength` to 50+, or add a "guided" action sequence that's more likely to reach deep states (e.g., always start with offer+accept+sign+cosign then randomize).

#### MEDIUM — Missing COMMIT_PENDING self-loop event type
- **File:** fuzz.test.ts (not present)
- **Description:** The state machine allows COMMIT_PENDING + COMMIT_PENDING (transition #9), but no fuzz action generates this event. This transition is never exercised.
- **Fix:** Add a `commitPendingAudit` action type that emits COMMIT_PENDING events.

#### LOW — Seed 42 + 200 runs is minimal but adequate for CI
- **Description:** 200 runs x 30 max actions = up to 6000 actions. Adequate for smoke testing. For thorough coverage, consider 1000+ runs in a nightly CI job.

#### LOW — No flakiness risk in current design
- **Description:** The fuzz uses a fixed seed (42) and all operations are synchronous within each property run. No timers, no real async. Deterministic.

---

## 3. Missing Coverage Analysis

### State Transitions Coverage Matrix

| # | Transition | E2E | Fuzz | Notes |
|---|-----------|-----|------|-------|
| 1 | OPEN → NEGOTIATING (OFFER_SUBMITTED) | E2E-1,2,3,4 | Yes | |
| 2 | OPEN → EXPIRED (NEGOTIATION_EXPIRED) | E2E-5 | Yes (expire action) | |
| 3 | OPEN → CANCELLED (NEGOTIATION_CANCELLED) | Partially (E2E-10 from NEGOTIATING) | Yes (cancel action) | **Gap: E2E-10 cancels from NEGOTIATING, not OPEN** |
| 4 | NEGOTIATING → NEGOTIATING (OFFER_SUBMITTED) | E2E-2,3,4 | Yes | |
| 5 | NEGOTIATING → NEGOTIATING (COUNTER_SENT) | E2E-3 | Yes | |
| 6 | NEGOTIATING → COMMIT_PENDING (WINNER_SELECTED) | E2E-1,2,3,4 | Yes | |
| 7 | NEGOTIATING → EXPIRED (NEGOTIATION_EXPIRED) | Not tested | Yes | **Gap: no E2E tests NEGOTIATING→EXPIRED** |
| 8 | NEGOTIATING → CANCELLED (NEGOTIATION_CANCELLED) | E2E-10 | Yes | |
| 9 | COMMIT_PENDING → COMMIT_PENDING (COMMIT_PENDING self-loop) | Not tested | **NOT tested** | **Gap: never exercised** |
| 10 | COMMIT_PENDING → COMMIT_PENDING (QUOTE_SIGNED) | E2E-1,2,3,4,6 | Yes (weak) | |
| 11 | COMMIT_PENDING → COMMITTED (QUOTE_COMMITTED) | E2E-1,2,3,4 | Yes (weak) | |
| 12 | COMMIT_PENDING → NEGOTIATING (COSIGN_DECLINED) | E2E-4 | Yes | |
| 13 | COMMIT_PENDING → NEGOTIATING (COSIGN_TIMEOUT) | E2E-6 | Yes | |
| 14 | COMMIT_PENDING → EXPIRED (NEGOTIATION_EXPIRED) | Not tested | Yes | **Gap: no E2E tests COMMIT_PENDING→EXPIRED** |

### States Reachability

| State | E2E | Fuzz |
|-------|-----|------|
| OPEN | Yes | Yes |
| NEGOTIATING | Yes | Yes |
| COMMIT_PENDING | Yes | Yes (weak probability) |
| COMMITTED | Yes | Possible but unlikely |
| EXPIRED | Yes (from OPEN only) | Yes |
| CANCELLED | Yes (from NEGOTIATING) | Yes |

### Critical Missing Coverage

1. **OPEN → CANCELLED via E2E** — E2E-10 cancels from NEGOTIATING. No test for cancelling an OPEN session (before any offers).
2. **NEGOTIATING → EXPIRED via E2E** — Not tested. Deadline expiry is only tested from OPEN state.
3. **COMMIT_PENDING → EXPIRED via E2E** — Not tested. What happens when the deadline fires while waiting for cosign?
4. **COMMIT_PENDING self-loop** — Transition #9 is never exercised in either E2E or fuzz.
5. **Negative-path E2E tests** — No tests for: duplicate offers from same seller rejected, accept with wrong session_revision (CAS failure), double-sign, cosign by wrong seller, accept after COMMITTED.
6. **HTTP error code validation in fuzz** — Fuzz never asserts that invalid transitions return proper 4xx codes.

---

## Summary

| Category | Critical | High | Medium | Low |
|----------|----------|------|--------|-----|
| E2E (integration.test.ts) | 0 | 3 | 3 | 2 |
| Fuzz (fuzz.test.ts) | 1 | 2 | 2 | 2 |
| Missing Coverage | 0 | 2 | 4 | 0 |

**Top 3 action items:**
1. Fix fuzz pre-check guards (CRITICAL) — the fuzz cannot find rejection bugs because it never submits invalid actions.
2. Add status assertions to all E2E HTTP calls (HIGH x3) — missing assertions mask failures.
3. Add E2E tests for transitions #7, #9, #14 and negative paths (HIGH x2) — 3 of 14 transitions have zero coverage.
