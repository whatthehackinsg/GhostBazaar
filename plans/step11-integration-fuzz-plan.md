# Step 11: Integration Tests + Fuzz Testing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Verify the entire engine works end-to-end through HTTP routes, and use property-based fuzzing to prove the state machine never enters an illegal state or leaks data.

**Architecture:** Integration tests use `createTestApp()` with all routes mounted, submitting real signed HTTP requests. Fuzz tests use `fast-check` to generate random action sequences against the state machine.

**Tech Stack:** Vitest, fast-check (new dependency), @ghost-bazaar/core signing helpers, Hono test client

---

## File Structure

| File | Responsibility | New/Modify |
|------|---------------|------------|
| `package.json` | Add `fast-check` dev dependency | Modify |
| `tests/integration.test.ts` | Full E2E flow tests through HTTP routes | New |
| `tests/fuzz.test.ts` | Property-based state machine fuzzing | New |

---

## Task 1: Add fast-check Dependency

- [ ] **Step 1: Install fast-check**

```bash
cd /Volumes/MainSSD/HomeData/zengy/workspace/ghost-bazaar
pnpm --filter @ghost-bazaar/engine add -D fast-check
```

- [ ] **Step 2: Verify install**

Run: `pnpm --filter @ghost-bazaar/engine test`
Expected: All 311 existing tests still pass

- [ ] **Step 3: Commit**

```bash
git add packages/engine/package.json pnpm-lock.yaml
git commit -m "chore(engine): add fast-check for property-based testing (Step 11a)"
```

---

## Task 2: Integration Tests — Full E2E Flows

**Files:**
- Create: `packages/engine/tests/integration.test.ts`

This test file reuses the exact same signing helpers and HTTP submission helpers from `quote-flow.test.ts`. Read that file first to understand the patterns.

### Test Scenarios

- [ ] **Step 1: Write integration test file**

Create `tests/integration.test.ts`. The file must:
1. Import all route factories and wire them into a single `createTestApp()`
2. Include all signing helpers (makeSignedRfq, makeSignedOffer, makeAcceptEnvelope, signQuoteAsBuyer, signQuoteAsSeller, etc.)
3. Include all HTTP submission helpers (submitRfq, submitOffer, submitAccept, submitQuoteSign, submitCosign, submitDecline)
4. Use **injected `authenticateCaller`** for read routes (GET /quote, GET /events) — same pattern as existing route tests. Production auth header parsing is tested separately in `middleware.test.ts`.

Tests to implement:

**E2E-1: Happy path — RFQ → offer → accept → sign → cosign → COMMITTED**
```
1. POST /rfqs → 201, get rfq_id
2. POST /rfqs/:id/offers (seller A) → 201
3. POST /rfqs/:id/accept (buyer accepts seller A) → 200, get unsigned quote
4. PUT /rfqs/:id/quote/sign (buyer signs) → 200
5. PUT /rfqs/:id/cosign (seller A cosigns) → 200
6. Verify: session state === COMMITTED
7. Verify: GET /rfqs/:id/events returns all events in order
```

**E2E-2: Multi-seller competition — 2 sellers, buyer picks cheapest**
```
1. POST /rfqs → 201
2. POST /rfqs/:id/offers (seller A, $35) → 201
3. POST /rfqs/:id/offers (seller B, $28.50) → 201
4. POST /rfqs/:id/accept (buyer picks seller B) → 200
5. PUT /rfqs/:id/quote/sign → 200
6. PUT /rfqs/:id/cosign (seller B) → 200
7. Verify: COMMITTED, final_price === "28.50"
```

**E2E-3: Counter-offer flow — RFQ → offer → counter → revised offer → accept → commit**
```
1. POST /rfqs → 201
2. POST /rfqs/:id/offers (seller A, $35) → 201
3. POST /rfqs/:id/counter (buyer counters seller A, $30) → 201
4. POST /rfqs/:id/offers (seller A, revised $31) → 201
5. POST /rfqs/:id/accept (buyer accepts revised offer) → 200
6. Sign + cosign → COMMITTED
```

**E2E-4: Decline + re-accept — seller declines cosign, buyer picks another seller**
```
1. POST /rfqs → 201
2. POST /rfqs/:id/offers (seller A) + offers (seller B) → 201
3. POST /rfqs/:id/accept (pick seller A) → 200
4. PUT /rfqs/:id/quote/sign (buyer signs) → 200
5. PUT /rfqs/:id/decline (seller A declines) → 200
6. Verify: state rolled back to NEGOTIATING
7. POST /rfqs/:id/accept (pick seller B) → 200
8. Sign + cosign → COMMITTED
```

**E2E-5: Deadline expiry — enforcer expires OPEN session (Step 10 E2E)**
```
1. POST /rfqs with 100ms deadline → 201
2. Create DeadlineEnforcer with short interval
3. vi.advanceTimersByTimeAsync past deadline + scan interval
4. Verify: session state === EXPIRED
5. Verify: GET /rfqs/:id/events contains NEGOTIATION_EXPIRED event
```

**E2E-6: Cosign timeout — enforcer triggers rollback (Step 10 E2E)**
```
1. POST /rfqs → offer → accept → sign → COMMIT_PENDING
2. Create DeadlineEnforcer with 200ms cosign timeout
3. vi.advanceTimersByTimeAsync past timeout + scan interval
4. Verify: state === NEGOTIATING (rolled back)
5. Verify: commitPendingAt === null, selectedSeller === null
```

**E2E-7: SSE live event delivery (Step 9 E2E)**
```
1. POST /rfqs → get rfq_id
2. Connect SSE stream to GET /rfqs/:id/events
3. POST /rfqs/:id/offers → verify offer event arrives on SSE
4. Complete flow to COMMITTED → verify terminal event arrives
5. Verify: SSE stream closes after terminal
```

**E2E-8: Event replay consistency — events reconstruct identical state**
```
1. Run full happy path to COMMITTED
2. GET /rfqs/:id/events → all events
3. Feed events through deriveState()
4. Verify: derived state matches session state exactly (full field equality)
```

**E2E-9: Privacy — buyer private fields never leak in responses**
```
1. Run a negotiation with offers + counters
2. Inspect ALL HTTP response bodies
3. Verify: no response contains "budget_hard", "budget_soft", "floor_price", "target_price"
```

**E2E-10: Cancellation flow (system-event integration — no HTTP cancel route exists)**
```
1. POST /rfqs → offer → NEGOTIATING
2. Append NEGOTIATION_CANCELLED via sessionManager.withLock + appendEvent
3. Verify: state === CANCELLED
4. Verify: subsequent POST /rfqs/:id/offers returns 409
```

NOTE: E2E-5, E2E-6, and E2E-10 use sessionManager/enforcer directly because these are system-initiated events (deadline expiry, cosign timeout, cancellation). They are **system-event integration tests**, not pure HTTP integration tests. E2E-1 through E2E-4 and E2E-7 through E2E-9 are pure HTTP integration tests.

- [ ] **Step 2: Run tests**

Run: `pnpm --filter @ghost-bazaar/engine test -- tests/integration.test.ts`
Expected: All integration tests PASS

- [ ] **Step 3: Run full suite**

Run: `pnpm --filter @ghost-bazaar/engine test`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add packages/engine/tests/integration.test.ts
git commit -m "test(engine): add E2E integration tests — full negotiation flows (Step 11b)"
```

---

## Task 3: Property-Based Fuzz Testing

**Files:**
- Create: `packages/engine/tests/fuzz.test.ts`

### Design

Use `fast-check` to generate random sequences of protocol actions and verify invariants hold after each action.

**Action model** — 9 action types using `fc.frequency` for weighted distribution:

| Action | Weight | Description |
|--------|--------|-------------|
| `offer` | 5 | Random seller (0-2), valid decimal price |
| `counter` | 3 | Buyer counters a random seller |
| `accept` | 2 | Buyer accepts (modular index into actual offers) |
| `sign` | 2 | Buyer signs the current quote |
| `cosign` | 2 | Selected seller cosigns |
| `decline` | 2 | Selected seller declines |
| `cancel` | 1 | Buyer cancels the RFQ |
| `expire` | 1 | Simulate deadline expiry via direct event append |
| `cosignTimeout` | 1 | Simulate cosign timeout via direct event append |

**Price generator** — custom decimal string arbitrary (NOT `fc.float`):
```typescript
const priceArb = fc.tuple(
  fc.integer({ min: 1, max: 999 }),
  fc.integer({ min: 0, max: 99 }),
).map(([whole, frac]) => `${whole}.${String(frac).padStart(2, "0")}`)
```

**Offer index** — use modular arithmetic: `offerIdx % session.offers.length` to always pick a valid offer when offers exist.

**Invariants to check after each action:**
1. `session.state` is always one of the 6 valid states
2. `deriveState(allEvents)` produces **key field equality** with `sessionManager.getSession(rfqId)` — state, selectedSeller, selectedOfferId, commitPendingAt, buyerSignature, sellerSignature, totalOfferCount, quoteRevision, lastEventId
3. Event count == `store.size(rfqId)`
4. No event payload contains `budget_hard`, `budget_soft`, `floor_price`, `target_price`
5. **Terminal absorption** — once COMMITTED/EXPIRED/CANCELLED, state never changes again
6. **Quote field coherence** — `unsignedQuote` non-null only in COMMIT_PENDING/COMMITTED, null after rollback
7. **Signature coherence** — `buyerSignature` non-null only after QUOTE_SIGNED, `sellerSignature` only in COMMITTED
8. **Selected seller consistency** — `selectedSeller` non-null only in COMMIT_PENDING/COMMITTED

**fast-check configuration:**
```typescript
{ seed: 42, numRuns: 200, endOnFailure: true, verbose: 1 }
```

**Sequence length:** `{ minLength: 1, maxLength: 30 }`

- [ ] **Step 1: Write fuzz test file**

Create `tests/fuzz.test.ts` with 3 sellers (A, B, C), all routes mounted, and the following structure:

**Imports:** Same as integration.test.ts — all route factories, signing helpers, @ghost-bazaar/core, fast-check.

**3 test sellers:** SELLER_A_KP, SELLER_B_KP, SELLER_C_KP — all registered in ListingStore.

**Price arbitrary** (NOT fc.float):
```typescript
const priceArb = fc.tuple(
  fc.integer({ min: 1, max: 999 }),
  fc.integer({ min: 0, max: 99 }),
).map(([whole, frac]) => `${whole}.${String(frac).padStart(2, "0")}`)
```

**Action arbitrary** using `fc.frequency` for weighted distribution:
```typescript
const actionArb = fc.frequency(
  { weight: 5, arbitrary: fc.record({ type: fc.constant("offer" as const), seller: fc.integer({ min: 0, max: 2 }), price: priceArb }) },
  { weight: 3, arbitrary: fc.record({ type: fc.constant("counter" as const), seller: fc.integer({ min: 0, max: 2 }), price: priceArb }) },
  { weight: 2, arbitrary: fc.record({ type: fc.constant("accept" as const), offerIdx: fc.nat({ max: 10 }) }) },
  { weight: 2, arbitrary: fc.record({ type: fc.constant("sign" as const) }) },
  { weight: 2, arbitrary: fc.record({ type: fc.constant("cosign" as const) }) },
  { weight: 2, arbitrary: fc.record({ type: fc.constant("decline" as const) }) },
  { weight: 1, arbitrary: fc.record({ type: fc.constant("cancel" as const) }) },
  { weight: 1, arbitrary: fc.record({ type: fc.constant("expire" as const) }) },
  { weight: 1, arbitrary: fc.record({ type: fc.constant("cosignTimeout" as const) }) },
)
```

**Sequence:** `fc.array(actionArb, { minLength: 1, maxLength: 30 })`

**createFuzzTestApp():**
- Creates InMemoryEventStore, SessionManager, ListingStore with 3 sellers, EnvelopeTombstones
- Mounts all routes (rfqs, offers, counters, accept, sign, cosign, decline)
- Uses injected `authenticateCaller` that returns BUYER_DID (read routes)
- Returns `{ app, store, sessionManager }`

**createFuzzRfqSession(app):**
- Creates signed RFQ with 5-minute deadline, submits via POST /rfqs
- Returns rfq_id

**executeAction(app, rfqId, action, sessionManager, store):**
- `"offer"`: signs offer from sellers[action.seller], submits via POST /rfqs/:id/offers. Swallows 4xx.
- `"counter"`: signs counter from buyer to sellers[action.seller], submits via POST. Swallows 4xx.
- `"accept"`: gets session, uses `action.offerIdx % offers.length` for valid index, builds accept envelope, submits. Swallows 4xx.
- `"sign"`: gets session, if unsignedQuote exists, signs it as buyer, submits PUT. Swallows 4xx.
- `"cosign"`: gets session, if unsignedQuote + selectedSeller, signs as selected seller, submits PUT. Swallows 4xx.
- `"decline"`: gets session, if selectedSeller, builds decline envelope from selected seller, submits PUT. Swallows 4xx.
- `"cancel"`: wraps in try/catch — calls sessionManager.withLock + appendEvent(NEGOTIATION_CANCELLED). Catches and ignores invalid-transition errors (e.g. already terminal). Same swallow pattern as HTTP 4xx.
- `"expire"`: wraps in try/catch — calls sessionManager.withLock + appendEvent(NEGOTIATION_EXPIRED). Catches and ignores invalid-transition errors.
- `"cosignTimeout"`: wraps in try/catch — calls sessionManager.withLock + appendEvent(COSIGN_TIMEOUT) only if state === COMMIT_PENDING. Catches and ignores invalid-transition errors.

IMPORTANT: All 3 system-event actions MUST catch errors from `appendEvent()` (which throws on invalid transitions via dry-run replay). Without this, random cancel/expire on terminal sessions would fail the property test for the wrong reason.

**Invariant checks after EACH action:**
```typescript
const session = sessionManager.getSession(rfqId)
if (!session) return // session destroyed (shouldn't happen)

const VALID_STATES = ["OPEN", "NEGOTIATING", "COMMIT_PENDING", "COMMITTED", "EXPIRED", "CANCELLED"]
const TERMINAL = ["COMMITTED", "EXPIRED", "CANCELLED"]

// 1. Valid state
expect(VALID_STATES).toContain(session.state)

// 2. Event replay = key field equality (state + commitment fields + counters)
const events = store.getAllEvents(rfqId)
const derived = deriveState([...events])
expect(derived!.state).toBe(session.state)
expect(derived!.selectedSeller).toBe(session.selectedSeller)
expect(derived!.selectedOfferId).toBe(session.selectedOfferId)
expect(derived!.commitPendingAt).toBe(session.commitPendingAt)
expect(derived!.buyerSignature).toBe(session.buyerSignature)
expect(derived!.sellerSignature).toBe(session.sellerSignature)
expect(derived!.totalOfferCount).toBe(session.totalOfferCount)
expect(derived!.quoteRevision).toBe(session.quoteRevision)
expect(derived!.lastEventId).toBe(session.lastEventId)

// 3. Event count consistency
expect(events.length).toBe(store.size(rfqId))

// 5. Terminal absorption (tracked across loop)
if (prevTerminal) {
  expect(session.state).toBe(prevTerminal) // state must not change
}
if (TERMINAL.includes(session.state)) prevTerminal = session.state

// 6. Quote field coherence
if (session.state !== "COMMIT_PENDING" && session.state !== "COMMITTED") {
  expect(session.unsignedQuote).toBeNull()
}

// 7. Signature coherence
if (session.state !== "COMMIT_PENDING" && session.state !== "COMMITTED") {
  expect(session.buyerSignature).toBeNull()
}
if (session.state !== "COMMITTED") {
  expect(session.sellerSignature).toBeNull()
}

// 8. Selected seller consistency
if (session.state !== "COMMIT_PENDING" && session.state !== "COMMITTED") {
  expect(session.selectedSeller).toBeNull()
}
```

**Post-loop invariant:**
```typescript
// 4. Privacy — no private fields in any event
const eventsJson = JSON.stringify(store.getAllEvents(rfqId))
for (const field of PRIVATE_FIELDS) {
  expect(eventsJson).not.toContain(field)
}
```

**fc.assert configuration:**
```typescript
{ seed: 42, numRuns: 200, endOnFailure: true, verbose: 1 }
```

NOTE on `cancel`, `expire`, `cosignTimeout` actions: These use direct sessionManager event appending (not HTTP routes) because the engine has no HTTP cancel route, and expire/cosignTimeout are enforcer-triggered. This is documented and intentional — these are **system-event simulations**, not HTTP integration tests. The HTTP integration tests are in Task 2.

- [ ] **Step 2: Run fuzz tests**

Run: `pnpm --filter @ghost-bazaar/engine test -- tests/fuzz.test.ts`
Expected: PASS (200 random sequences with seed 42, all 8 invariants hold)

- [ ] **Step 3: Run full suite**

Run: `pnpm --filter @ghost-bazaar/engine test`
Expected: All tests PASS

- [ ] **Step 4: Verify build**

Run: `pnpm --filter @ghost-bazaar/engine build`
Expected: Clean

- [ ] **Step 5: Commit**

```bash
git add packages/engine/tests/fuzz.test.ts
git commit -m "test(engine): add property-based fuzz tests for state machine (Step 11c)"
```
