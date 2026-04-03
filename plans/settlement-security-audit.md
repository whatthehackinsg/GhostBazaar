# Settlement Package Security Audit Report

**Branch:** `feat/duty3-settlement-agents-mcp`
**Scope:** `packages/settlement/src/` and `packages/settlement/tests/`
**Date:** 2026-03-22
**Auditor:** Claude Opus 4.6

---

## Executive Summary

The 17-step settlement validation is architecturally sound and covers the critical on-chain verification surface area correctly. One **CRITICAL** finding (C1 -- nonce non-atomicity) creates a real double-delivery window. Two **HIGH** findings relate to race conditions and error-message leakage. Several **MEDIUM** findings identify defense-in-depth gaps.

**Overall risk posture:** The codebase is safe for devnet/testnet. C1 and C2 MUST be resolved before mainnet deployment.

---

## CRITICAL Findings

### C1. Nonce Not Atomic With Service Execution -- Double-Delivery Risk

**File:** `packages/settlement/src/execute.ts`, Steps 16-17
**Severity:** CRITICAL

```
// Step 16: Execute service
try {
  await executor(quote)
} catch (err) {
  throw executionFailed(...)
}

// Step 17: Persist nonce atomically with execution
consumeNonce(quote.quote_id)
```

**Problem:** The comment says "atomically" but it is NOT atomic. If `executor(quote)` succeeds (service delivered -- e.g. audit performed, API key issued) and then the process crashes between Step 16 and Step 17, the nonce is never consumed. On restart (in-memory Set is empty), the same `quote_id` can be submitted again, and the seller delivers the service a second time for the same payment.

**Attack scenario:**
1. Buyer pays once on-chain (valid SPL transfer).
2. Buyer sends settlement request. Executor runs, service is delivered.
3. Process crashes (or is killed) before `consumeNonce()`.
4. Buyer re-submits the same request after restart. All 17 steps pass again -- nonce Set is fresh.
5. Service delivered twice for one payment.

**Impact:** Direct financial loss to the seller -- service given away for free.

**Remediation:**
- **Immediate:** Consume nonce BEFORE calling executor (between Step 15 and Step 16). If executor fails, the nonce stays consumed. This flips the risk from "seller loses" to "buyer might need to re-negotiate", which is the safe default.
- **Production:** Replace in-memory `Set<string>` with durable storage (SQLite, Redis, or Solana PDA `["ghost_bazaar_nonce", quote_id_bytes]` as the code comments suggest). This survives restarts.

### C2. In-Memory Nonce Store Is Volatile -- Restart Wipes All Replay Protection

**File:** `packages/settlement/src/nonce.ts`
**Severity:** CRITICAL

```typescript
const consumedNonces = new Set<string>()
```

**Problem:** On process restart, container redeployment, or horizontal scaling, all consumed nonces are lost. Every previously settled quote becomes re-settleable.

**Attack scenario:**
1. Settlement completes normally for quote Q1. Nonce consumed in memory.
2. Server restarts (deploy, crash, OOM, scaling event).
3. Attacker replays the original settlement request for Q1.
4. All chain checks pass (the on-chain tx is still valid). Nonce check passes (Set is empty). Service delivered again.

**Impact:** Unbounded replay of any previously settled quote after any restart.

**Remediation:** Persist consumed nonces to durable storage. At minimum, write `quote_id` to SQLite before executing the service. The code already notes this as the "Week-2 upgrade path" but it MUST ship before mainnet.

---

## HIGH Findings

### H1. TOCTOU Race on Nonce Check -- Concurrent Double-Settlement

**File:** `packages/settlement/src/execute.ts`, Steps 14-17
**Severity:** HIGH

**Problem:** Steps 14 (check nonce) and 17 (consume nonce) are separated by Step 15 (expiry check) and Step 16 (executor call). Two concurrent requests for the same `quote_id` can both pass Step 14 before either reaches Step 17.

```
Request A: Step 14 (not consumed) -> Step 15 -> Step 16 (executing...)
Request B: Step 14 (not consumed) -> Step 15 -> Step 16 (executing...)
Request A: Step 17 (consume)
Request B: Step 17 (consume -- Set.add is idempotent, no error)
```

**Impact:** Service delivered twice concurrently for one payment.

**Remediation:**
- Move `consumeNonce()` to immediately after Step 14 (check-and-set pattern), or
- Use an atomic check-and-set operation: `if (consumedNonces.has(id)) throw; consumedNonces.add(id)` in a synchronous block. Note: this is safe in single-threaded Node.js for sync code, but the current code has `await` calls between check and set, allowing event-loop interleaving.

### H2. SettlementError `.message` Exposed in HTTP Response

**File:** `packages/settlement/src/http.ts`, catch block
**Severity:** HIGH

```typescript
if (err instanceof SettlementError) {
  res.writeHead(err.httpStatus, { "Content-Type": "application/json" })
  res.end(JSON.stringify({ error: err.code, message: err.message }))
}
```

**Problem:** `SettlementError.message` is returned verbatim to the client. While the current error messages in `errors.ts` are safe, the `executionFailed()` error (Step 16) directly forwards the executor's error message:

```typescript
// execute.ts, Step 16
throw executionFailed(err instanceof Error ? err.message : "Unknown execution error")
```

If the service executor throws an error containing internal details (database connection strings, stack traces, file paths), that message propagates through `SettlementError.message` to the HTTP response.

**Impact:** Information disclosure of internal server state to attackers.

**Remediation:**
- For `execution_failed`, return a generic message in the HTTP response. Log the detailed error server-side.
- Or: Add a `publicMessage` field to `SettlementError` and only expose that in HTTP responses, keeping the detailed message for server logs.

---

## MEDIUM Findings

### M1. Expiry Check After Nonce Check -- Ordering Allows Expired-Quote Settlement Window

**File:** `packages/settlement/src/execute.ts`, Steps 14-15
**Severity:** MEDIUM

**Problem:** Step 14 checks nonce, Step 15 checks expiry. If nonce is consumed first (per H1 remediation), an expired quote would still consume the nonce, requiring buyer re-negotiation for an expired quote. The more defensive ordering is: check expiry first (Step 15 before Step 14), so expired quotes are rejected early without touching nonce state.

### M2. `verifyQuote()` Combines Steps 2 and 3 Into One Call

**File:** `packages/settlement/src/execute.ts`, Steps 2-3
**Severity:** MEDIUM

**Problem:** The spec defines Step 2 (verify buyer sig) and Step 3 (verify seller sig) as distinct steps. The implementation calls `verifyQuote()` once and maps the return code. If the core `verifyQuote()` checks seller before buyer, a bad buyer signature might surface as `invalid_seller_signature` or vice versa.

**Impact:** Misleading error codes to the caller. No security impact, but spec non-compliance.

### M3. Transaction Confirmation Level Uses `confirmed` Not `finalized`

**File:** `packages/settlement/src/execute.ts`, Step 5
**Severity:** MEDIUM

```typescript
const connection = new Connection(request.rpcUrl, "confirmed")
const tx = await connection.getTransaction(txSignature, {
  commitment: "confirmed",
  maxSupportedTransactionVersion: 0,
})
```

**Problem:** `confirmed` commitment means 66%+ stake has voted on the block. `finalized` means 31+ confirmations (~13 seconds on Solana). A transaction at `confirmed` can theoretically be rolled back in a consensus failure (extremely rare, but possible on mainnet with a cluster split).

**Impact:** If a confirmed-but-not-finalized transaction is rolled back after service delivery, the seller delivers the service but the payment disappears.

**Remediation:** Use `finalized` commitment for mainnet settlement. Keep `confirmed` as an option for devnet/testnet where speed matters more.

### M4. `extractSplTransfer` Returns Only First Transfer Found

**File:** `packages/settlement/src/execute.ts`, Step 7
**Severity:** MEDIUM

**Problem:** `extractSplTransfer` returns the first SPL transfer instruction found. If the transaction contains multiple SPL transfers, only the first is verified. An attacker could construct a transaction where the first transfer is a trivial amount to an unrelated account, and the real payment transfer is second.

**Impact:** False rejection of valid payments (if wrong transfer is picked) or false acceptance (if a decoy transfer matches verification parameters). Since amount, mint, and destination are all verified, actual exploitation requires the decoy to match all three -- extremely unlikely, but the logic should pick the correct transfer deterministically.

### M5. `onSettled` Hook Error Is Silently Swallowed

**File:** `packages/settlement/src/http.ts`
**Severity:** MEDIUM

```typescript
try { await config.onSettled(quote, result) } catch { /* noop */ }
```

**Problem:** If the post-settlement hook (8004 registry feedback, agent session marking) fails, no one knows. This is intentional (don't fail the response), but there is no logging or error metrics.

**Impact:** Silent failure of downstream settlement effects (reputation, session state).

---

## LOW Findings

### L1. `resetNonces()` Exported Without Guard

**File:** `packages/settlement/src/nonce.ts`
**Severity:** LOW

The `resetNonces()` function is exported without restriction. If accidentally called in production code (not just tests), all replay protection is wiped. Consider gating behind `NODE_ENV === "test"` or moving to a test-only module.

### L2. No Rate Limiting on Settlement Endpoint

**File:** `packages/settlement/src/http.ts`
**Severity:** LOW

The HTTP handler has no rate limiting. An attacker could flood the endpoint with invalid settlement requests, each triggering RPC calls to Solana, incurring RPC costs and potential denial of service.

### L3. Quote Parsed Twice in HTTP Handler

**File:** `packages/settlement/src/http.ts`
**Severity:** LOW

```typescript
const result = await verifyAndExecute(request, config.executor)
// ...
const quote = JSON.parse(Buffer.from(quoteHeader, "base64").toString("utf-8"))
try { await config.onSettled(quote, result) } catch { /* noop */ }
```

The quote is decoded once inside `verifyAndExecute` (Step 1) and again in the HTTP handler for `onSettled`. The second decode is unvalidated and could theoretically diverge. Better to return the parsed+validated quote from `verifyAndExecute`.

---

## Test Coverage Assessment

| Step | What | Test Coverage | Verdict |
|------|------|---------------|---------|
| 1 | Decode quote header | execute.test.ts: malformed base64 | PASS |
| 2 | Buyer signature | execute.test.ts: invalid buyer sig | PASS |
| 3 | Seller signature | execute.test.ts: invalid seller sig | PASS |
| 4 | Payment sig decode | execute.test.ts: invalid base58 | PASS |
| 5 | getTransaction RPC | execute.test.ts: tx not found | PASS |
| 6 | Tx status | execute.test.ts: failed tx | PASS |
| 7 | SPL transfer extract | execute.test.ts: no transfer instruction | PASS |
| 8 | Destination match | execute.test.ts: wrong destination | PASS |
| 9 | Mint match | execute.test.ts: wrong mint | PASS |
| 10 | Amount match | execute.test.ts: wrong amount | PASS |
| 11 | Memo quote_id | integration.test.ts: missing + wrong memo | PASS |
| 12 | Memo hash | integration.test.ts: wrong hash | PASS |
| 13 | Nonce format | execute.test.ts: bad nonce format | PASS |
| 14 | Nonce replay | execute.test.ts: pre-consumed nonce | PASS |
| 15 | Expiry | execute.test.ts: expired quote | PASS |
| 16 | Executor failure | execute.test.ts: throwing executor | PASS |
| 17 | Nonce persist | Implicit in happy-path test | WEAK |

### Missing Negative Tests (Attack Scenarios)

| Scenario | Coverage |
|----------|----------|
| Concurrent settlement (TOCTOU on nonce) | **NOT TESTED** |
| Restart replay (nonce volatility) | **NOT TESTED** |
| Executor success + crash before nonce persist | **NOT TESTED** |
| Multi-transfer transaction (wrong transfer picked) | **NOT TESTED** |
| Boundary: quote expires exactly during settlement | **NOT TESTED** |
| Rate-limiting / DoS resilience | **NOT TESTED** |

---

## Remediation Priority

| ID | Severity | Effort | Priority |
|----|----------|--------|----------|
| C1 | CRITICAL | Low (reorder 2 lines) | **MUST -- before mainnet** |
| C2 | CRITICAL | Medium (add SQLite/Redis) | **MUST -- before mainnet** |
| H1 | HIGH | Low (atomic check-and-set) | **SHOULD -- before mainnet** |
| H2 | HIGH | Low (sanitize error message) | **SHOULD -- before mainnet** |
| M3 | MEDIUM | Low (config flag) | **SHOULD -- before mainnet** |
| M1 | MEDIUM | Low (reorder steps) | SHOULD |
| M2 | MEDIUM | Low (split verify calls) | NICE TO HAVE |
| M4 | MEDIUM | Medium (multi-transfer handling) | NICE TO HAVE |
| M5 | MEDIUM | Low (add logging) | SHOULD |
| L1 | LOW | Low (conditional export) | NICE TO HAVE |
| L2 | LOW | Medium (add rate limiter) | SHOULD for production |
| L3 | LOW | Low (pass parsed quote) | NICE TO HAVE |
