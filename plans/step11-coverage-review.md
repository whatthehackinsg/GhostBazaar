# Step 11 Test Coverage Review

## 1. All Valid State Transitions (from state-machine.ts)

| # | From State | Event | To State |
|---|-----------|-------|----------|
| T1 | OPEN | OFFER_SUBMITTED | NEGOTIATING |
| T2 | OPEN | NEGOTIATION_EXPIRED | EXPIRED |
| T3 | OPEN | NEGOTIATION_CANCELLED | CANCELLED |
| T4 | NEGOTIATING | OFFER_SUBMITTED | NEGOTIATING |
| T5 | NEGOTIATING | COUNTER_SENT | NEGOTIATING |
| T6 | NEGOTIATING | WINNER_SELECTED | COMMIT_PENDING |
| T7 | NEGOTIATING | NEGOTIATION_EXPIRED | EXPIRED |
| T8 | NEGOTIATING | NEGOTIATION_CANCELLED | CANCELLED |
| T9 | COMMIT_PENDING | COMMIT_PENDING | COMMIT_PENDING (self-loop) |
| T10 | COMMIT_PENDING | QUOTE_SIGNED | COMMIT_PENDING |
| T11 | COMMIT_PENDING | QUOTE_COMMITTED | COMMITTED |
| T12 | COMMIT_PENDING | COSIGN_DECLINED | NEGOTIATING |
| T13 | COMMIT_PENDING | COSIGN_TIMEOUT | NEGOTIATING |
| T14 | COMMIT_PENDING | NEGOTIATION_EXPIRED | EXPIRED |

**Total: 14 valid transitions + 3 terminal states (no outgoing)**

## 2. Transition Coverage Matrix

| # | Transition | state-machine.test | derive-state.test | quote-flow.test | deadline-enforcer.test | Step 11 E2E | Step 11 Fuzz |
|---|-----------|-------------------|-------------------|-----------------|----------------------|-------------|-------------|
| T1 | OPEN→NEGOTIATING (OFFER) | YES | YES | YES | — | YES (all E2Es) | YES |
| T2 | OPEN→EXPIRED | YES | YES (indirect) | — | YES | **NO** | **PARTIAL** |
| T3 | OPEN→CANCELLED | YES | YES | — | — | **NO** | **NO** |
| T4 | NEGOTIATING→NEGOTIATING (OFFER) | YES | YES | — | — | YES (E2E-2) | YES |
| T5 | NEGOTIATING→NEGOTIATING (COUNTER) | YES | YES | — | — | YES (E2E-3) | YES |
| T6 | NEGOTIATING→COMMIT_PENDING (WINNER) | YES | YES | YES | — | YES (all E2Es) | YES |
| T7 | NEGOTIATING→EXPIRED | YES | YES | — | YES | **NO** | **PARTIAL** |
| T8 | NEGOTIATING→CANCELLED | YES | YES | — | — | **NO** | **NO** |
| T9 | COMMIT_PENDING self-loop | YES | — | — | — | **NO** | **NO** |
| T10 | COMMIT_PENDING→COMMIT_PENDING (SIGN) | YES | YES | YES | — | YES (all E2Es) | YES |
| T11 | COMMIT_PENDING→COMMITTED (COSIGN) | YES | YES | YES | — | YES (E2E-1,2,3,4) | YES |
| T12 | COMMIT_PENDING→NEGOTIATING (DECLINED) | YES | YES | YES | — | YES (E2E-4) | YES |
| T13 | COMMIT_PENDING→NEGOTIATING (TIMEOUT) | YES | YES | — | YES | **NO** | **NO** |
| T14 | COMMIT_PENDING→EXPIRED | YES | YES (indirect) | — | YES | **NO** | **PARTIAL** |

## 3. Gap Analysis

### 3.1 Missing E2E Scenarios in Step 11 Plan

1. **E2E-EXPIRED-OPEN**: RFQ created, deadline passes, session expires while OPEN. Not covered by any E2E integration test. (Unit-tested in deadline-enforcer.test.ts but no HTTP-level E2E.)

2. **E2E-EXPIRED-NEGOTIATING**: RFQ with offers, deadline passes, session expires while NEGOTIATING. Same gap.

3. **E2E-EXPIRED-COMMIT_PENDING**: Deadline expires while waiting for cosign. Only unit-tested in deadline-enforcer.test.ts.

4. **E2E-CANCELLED**: No integration test for cancellation flow at all. The NEGOTIATION_CANCELLED transition (T3, T8) has zero E2E coverage in the plan.

5. **E2E-COSIGN_TIMEOUT**: Seller takes too long to cosign, COSIGN_TIMEOUT fires, session rolls back to NEGOTIATING. Only unit-tested in deadline-enforcer.test.ts. No HTTP-level integration test.

6. **E2E-COMMIT_PENDING-SELF-LOOP (T9)**: The COMMIT_PENDING event self-loop is never tested through HTTP in any existing or planned test.

### 3.2 Missing Fuzz Actions in Step 11 Plan

The fuzz action model defines 6 actions: `offer`, `counter`, `accept`, `sign`, `cosign`, `decline`.

**Missing from fuzz action model:**
1. **`expire` / `timeout`** — No action to simulate deadline expiry or cosign timeout. The fuzz cannot reach EXPIRED state or exercise T2, T7, T13, T14.
2. **`cancel`** — No action to simulate cancellation. The fuzz cannot reach CANCELLED state or exercise T3, T8.

This means the fuzz invariant check for valid states includes EXPIRED and CANCELLED in the assertion, but **those states are unreachable** in the fuzz model. Two of the six states are dead code in fuzz testing.

### 3.3 Missing Acceptance Criteria Coverage

| AC | Criterion | Covered by Step 11? | Gap? |
|----|-----------|---------------------|------|
| AC1 | 8004 registry in listings | No (Step 4 / routes.test) | Not Step 11's scope — OK |
| AC2 | No invalid state transitions | YES (fuzz) | Partial — fuzz can't reach EXPIRED/CANCELLED |
| AC3 | Deadline + offer validity enforced | **NO** | No integration E2E for expiry. Only unit-tested. |
| AC4 | Quote flow E2E | YES (E2E-1 through E2E-4) | Adequate |
| AC5 | Counter rejects unauthorized | Not Step 11's scope | OK |
| AC6 | ZK proof blocks invalid | Not Step 11's scope | OK |
| AC7 | Event replay = final state | YES (E2E-5) | Adequate |
| AC8 | Demo E2E | Step 12 | Not Step 11's scope |
| AC9 | Privacy split-view | Step 12 | Not Step 11's scope |
| AC10 | Privacy score 5/6 | Step 12 | Not Step 11's scope |

## 4. Recommendations

### Add to E2E scenarios:

- **E2E-7: Expiry while OPEN** — Create RFQ with short deadline, wait for expiry, verify state = EXPIRED, verify subsequent offers rejected with 409.
- **E2E-8: Expiry while COMMIT_PENDING** — Get to COMMIT_PENDING, let deadline pass, verify state = EXPIRED.
- **E2E-9: Cosign timeout rollback** — Get to COMMIT_PENDING, wait for cosign timeout, verify rollback to NEGOTIATING, then re-accept different seller.
- **E2E-10: Cancellation flow** — Create RFQ, cancel it, verify all subsequent actions rejected. (Requires a cancel route or mechanism — check if one exists.)

### Add to fuzz action model:

- **`expire`** — Simulates deadline enforcement by directly appending a `NEGOTIATION_EXPIRED` event (or calling the deadline enforcer with fake timers).
- **`cosignTimeout`** — Simulates cosign timeout by appending `COSIGN_TIMEOUT` when in COMMIT_PENDING.
- **`cancel`** — Simulates cancellation by appending `NEGOTIATION_CANCELLED` when in OPEN or NEGOTIATING.

This would bring the fuzz from covering 4/6 states to 6/6 states, and from 9/14 transitions to 14/14 transitions.

## 5. Verdict

**GAPS FOUND**

The Step 11 plan has solid coverage of the happy path and decline/re-accept flows. However:

- **3 transitions are completely untested** at both E2E and fuzz levels: T3 (OPEN→CANCELLED), T8 (NEGOTIATING→CANCELLED), T9 (COMMIT_PENDING self-loop)
- **3 transitions are only unit-tested**, with no E2E or fuzz coverage: T2 (OPEN→EXPIRED), T13 (COSIGN_TIMEOUT), T14 (COMMIT_PENDING→EXPIRED)
- **2 of 6 session states** (EXPIRED, CANCELLED) are unreachable in the fuzz model
- **AC3** (deadline enforcement) lacks integration-level verification

The existing unit tests in `state-machine.test.ts`, `derive-state.test.ts`, and `deadline-enforcer.test.ts` cover all 14 transitions individually. The gap is specifically at the **integration/E2E** layer where these transitions are exercised through HTTP routes with real middleware, signing, and full request/response cycles.
