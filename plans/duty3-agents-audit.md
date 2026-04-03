# Duty 3 Agents Package — Security & Correctness Audit

**Branch:** `origin/feat/duty3-settlement-agents-mcp`
**Scope:** `packages/agents/src/` and `packages/agents/tests/`
**Date:** 2026-03-22

---

## 1. Engine Client Auth Status

| Method | Endpoint | Auth | Notes |
|--------|----------|------|-------|
| `getListings` | GET /listings | None (correct) | Public discovery |
| `getListing` | GET /listings/:id | None (correct) | Public discovery |
| `createListing` | POST /listings | None | **[H1]** Should require auth |
| `getRfqs` | GET /rfqs | None (correct) | Public, rate-limited on engine |
| `postRfq` | POST /rfqs | Body-signed | Correct — signature in RFQ body |
| `postOffer` | POST /rfqs/:id/offers | Body-signed | Correct |
| `postCounter` | POST /rfqs/:id/counter | Body-signed | Correct |
| `accept` | POST /rfqs/:id/accept | Envelope-signed | Correct — signed control envelope |
| `signQuote` | PUT /rfqs/:id/quote/sign | None | **[M1]** Missing auth header |
| `getQuote` | GET /rfqs/:id/quote | Auth header | Correct |
| `cosignQuote` | PUT /rfqs/:id/cosign | None | **[M2]** Missing auth header |
| `decline` | PUT /rfqs/:id/decline | Envelope-signed | Correct |
| `getEvents` | GET /rfqs/:id/events | Auth header | **Fixed** — was M4 in prior audit, now correct |

---

## 2. Findings

### CRITICAL

None found.

### HIGH

**H1. `getRfqs` sends `?status=` but engine accepts `?state=`**
- **File:** `engine-client.ts:92` — `params.set("status", filters.status)`
- **Engine:** `rfqs.ts` GET /rfqs handler reads `c.req.query("state")`, not `"status"`
- **Impact:** Status filtering silently fails — all RFQs returned, no error
- **Fix:** Change `"status"` to `"state"` in `getRfqs()`

**H2. `getRfqs` sends `?listing_id=` but engine does not support it**
- **File:** `engine-client.ts:91` — `params.set("listing_id", filters.listingId)`
- **Engine:** GET /rfqs only filters on `service_type`, `state`, `buyer`, `include_terminal`
- **Impact:** `listing_id` filter silently ignored — callers get unfiltered results
- **Fix:** Either add listing_id filter to engine, or remove from client and document

**H3. Seller cosigns quote without verifying fields against accepted offer**
- **File:** `seller-agent.ts:~160-170`
- The seller fetches the quote via `getQuote()`, checks `buyer_signature` exists and `seller_signature` is absent, then immediately calls `signQuoteAsSeller(quote, keypair)`.
- **Missing:** No validation that `quote.final_price` matches the seller's last offer price, that `quote.seller` matches `this.did`, or that `quote.buyer` matches `session.rfq.buyer`.
- **Impact:** A compromised engine could present a manipulated quote (e.g., different price) and the seller would blindly cosign it.
- **Fix:** Before signing, verify `quote.seller === this.did`, `quote.final_price` matches accepted offer, and `quote.service_type` matches RFQ.

### MEDIUM

**M1. `signQuote` (PUT /rfqs/:id/quote/sign) missing auth header**
- **File:** `engine-client.ts:~175`
- This is a write route that stores the buyer's signature. No `Authorization` header is sent.
- Engine may rely on body content alone, but defense-in-depth requires the header.
- **Fix:** Add `this.buildAuthHeader()` to the fetch headers.

**M2. `cosignQuote` (PUT /rfqs/:id/cosign) missing auth header**
- **File:** `engine-client.ts:~190`
- Same pattern as M1. Sends `seller_signature` without auth header.
- **Fix:** Add `this.buildAuthHeader()`.

**M3. `createListing` (POST /listings) missing auth/signing**
- **File:** `engine-client.ts:~80`
- Creates a listing with no signature or auth header. Anyone who knows the endpoint can create listings.
- **Fix:** Sign the listing body and/or add auth header.

**M4. No `maxRounds` enforcement in either agent**
- **File:** `buyer-agent.ts` poll loop, `seller-agent.ts` poll loop
- `round` is tracked but never compared to a limit. A malicious counterparty strategy could run unbounded rounds until deadline.
- The spec says `max_rounds` is advisory and not enforced by state machine, but agents should self-impose a ceiling.
- **Fix:** Add a configurable `maxRounds` (default e.g. 10) that triggers `cancel`/`decline` when exceeded.

**M5. Seller cosign error silently swallowed**
- **File:** `seller-agent.ts:~168` — `catch { /* will retry */ }`
- If cosign fails (e.g., engine rejects due to expiry), the bare `catch` discards the error. No logging, no session state update.
- **Fix:** At minimum log the error. If it's a permanent failure (4xx), mark session stopped.

**M6. Non-JSON error responses partially handled**
- **File:** `engine-client.ts` — only `accept()` has `.catch(() => ({}))` for JSON parse errors. All other methods call `res.json()` unconditionally after `!res.ok` throw.
- If the engine returns HTML error pages (e.g., reverse proxy errors), `res.json()` would throw an unrelated parse error before the status-code error is thrown.
- **Impact:** Misleading error messages during infrastructure failures.
- **Fix:** Add `.catch(() => ({}))` pattern consistently, or read `res.text()` first.

### LOW

**L1. No fetch timeout (AbortSignal) on any engine client call**
- **File:** `engine-client.ts` — all fetch calls
- Confirmed still present from prior audit (was L5).
- **Fix:** Add `signal: AbortSignal.timeout(10_000)` to all fetch calls.

**L2. Keypair held in memory for agent lifetime — no explicit cleanup**
- **File:** `buyer-agent.ts:89`, `seller-agent.ts:~70`
- Keypair is stored as `this.keypair` (private readonly) but never zeroed on stop.
- **Risk:** Low in Node.js (GC handles it), but for defense-in-depth the keypair bytes could be zeroed when polling stops.

**L3. Private fields never logged — GOOD**
- Confirmed: `budget_hard`, `budget_soft`, `floor_price`, `target_price` are stored in `this.priv` and passed only to strategy context and sanitizer. No `console.log`, `console.error`, or `throw new Error(...)` exposes them.

**L4. Tests mock fetch globally — fragile but not a security issue**
- All 3 test files use `globalThis.fetch` mock instead of injecting engine client.
- Makes tests harder to isolate but does not affect runtime security.

---

## 3. Privacy & Budget Safety

- **Buyer:** `budget_soft` and `budget_hard` stored in `this.priv`, passed to strategy context as `ctx.private`. The `sanitizeBuyerAction()` clamps counter prices to `budget_hard`. ZK proof generated when `budget_commitment` present. No leakage path found.
- **Seller:** `floor_price` and `target_price` stored in `this.priv`, passed to `sanitizeSellerAction()`. Test confirms price is clamped to `floor_price`. No leakage path found.
- **Sanitizers:** Both `sanitizeBuyerAction` and `sanitizeSellerAction` are called on every strategy output before any protocol action. This is the correct defense-in-depth pattern.

---

## 4. Summary

| Severity | Count | Status |
|----------|-------|--------|
| CRITICAL | 0 | -- |
| HIGH | 3 | H1-H3 need fixes before merge |
| MEDIUM | 6 | M1-M6 should be fixed |
| LOW | 4 | L1-L4 nice to have |

**Prior audit M4 (getEvents auth) is now fixed.** Prior M5 (registry.ts missing) not re-checked — out of scope.

**Blocking for merge:** H1 (status/state mismatch), H3 (blind cosign).
**Strongly recommended:** H2 (listing_id phantom filter), M1-M2 (auth headers on write routes), M4 (round limit).
