# Privacy + ZK Compliance Audit Report

**Auditor:** Privacy + ZK Compliance Auditor
**Date:** 2026-03-21
**Scope:** `packages/engine/src/` — all routes, event store, session, error handler
**Spec:** GHOST-BAZAAR-SPEC-v4.md

## Executive Summary

The engine implementation is **strong on privacy enforcement** and **correct on ZK proof verification wiring**. No CRITICAL findings. Two MEDIUM findings related to proof field format validation gaps and a missing `pi_a`/`pi_b`/`pi_c` structural check. One LOW informational finding.

---

## Findings (sorted by severity)

### MEDIUM-1: No structural validation of `pi_a`, `pi_b`, `pi_c` proof arrays

- **Severity:** MEDIUM
- **File:** `packages/core/src/schemas.ts:200-207` + `packages/engine/src/routes/counters.ts:182-205`
- **Description:** The core validator (`validateCounter`) checks `protocol === "groth16"` and `curve === "bn128"` but does NOT validate the structure of `pi_a` (string[3]), `pi_b` (string[3][2]), `pi_c` (string[3]). The engine route passes the raw `budget_proof` object directly to `snarkjs.groth16.verify()`. While snarkjs will likely throw on malformed proof material (caught by the try/catch at counters.ts:200), an attacker could submit proof fields with:
  - Non-string array elements (integers, objects, null)
  - Wrong array lengths
  - Non-numeric string values
  This relies entirely on snarkjs's internal validation, which is undocumented for edge cases.
- **Spec ref:** Section 10.5 defines proof format with specific array shapes.
- **Recommendation:** Add structural validation in `validateCounter()`: `pi_a` must be `string[3]`, `pi_b` must be `string[3][2]`, `pi_c` must be `string[3]`. Reject malformed proof shapes with `422 invalid_budget_proof` BEFORE reaching the ZK verifier.

### MEDIUM-2: `verifyBudgetProof` swallows all exceptions as `false`

- **Severity:** MEDIUM
- **File:** `packages/zk/src/verifier.ts:48-50` + `packages/engine/src/routes/counters.ts:198-202`
- **Description:** Both the ZK verifier and the engine counter route wrap the proof verification in try/catch and return `false` on any exception. This is correct for security (never returns 500), but it means:
  1. A misconfigured vkey path (file not found) silently rejects ALL proofs instead of failing loud.
  2. An snarkjs dependency bug is indistinguishable from an invalid proof.
  Operational monitoring cannot distinguish "proof actually invalid" from "verifier infrastructure broken."
- **Spec ref:** Section 10.6 — "Verify proof -> 422 invalid_budget_proof if verification fails"
- **Recommendation:** Log the caught exception at WARN level in the verifier (not in the HTTP response). Consider a health-check endpoint that verifies a known-good proof to detect verifier infrastructure failures.

### LOW-1: Devnet USDC mint address hardcoded in engine

- **Severity:** LOW (informational)
- **File:** `packages/engine/src/util/currency.ts:11`
- **Description:** `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` is the devnet USDC mint. This is documented as "Devnet mints used for MVP" and is appropriate for the current stage. No security issue, but will need to be replaced with `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` (mainnet USDC) before production.
- **Spec ref:** Section 9 — SPL Token Mint Table
- **Recommendation:** Move to environment variable or config file before mainnet deployment.

---

## Privacy Audit — PASS

### Private field search: `budget_hard`, `budget_soft`, `floor_price`, `target_price`

| Check | Result |
|-------|--------|
| Appear in engine `src/` source code? | **NO** — zero matches across all engine source files |
| Appear in any event payload? | **NO** — event payloads contain only: rfq_id, counter_id, round, from, to, price, currency, valid_until, signature, budget_proof, extensions, seller, offer_id, buyer_signature, seller_signature, quote |
| Appear in any HTTP response body? | **NO** — all route responses return only public protocol fields |
| Appear in any error message? | **NO** — error messages are generic (e.g., "Counter validation failed: ...code..."). No field values are interpolated from private state |
| Event visibility filter correct? | **YES** — `isEventVisibleTo()` in event-store.ts implements deny-by-default with buyer-sees-all, seller-sees-own semantics |

**Spec compliance:** Section 12.1 states "`budget_hard`, `budget_soft`, `floor_price`, and `target_price` MUST NOT appear in any protocol message." The engine fully complies — these strings do not exist anywhere in engine source code (only in test files where they verify absence).

### Error handler privacy

The error handler (`error-handler.ts:42-49`) correctly:
- Returns only `{ error, message }` — never stack traces
- For 500 errors, always returns "Internal server error" — never raw exception messages
- No private state fields can leak through error responses

### Event visibility (SSE + polling)

- `isEventVisibleTo()` is the single security gate for all read paths
- Buyer sees all events (protocol-intended information advantage per Spec)
- Seller sees only events relevant to them (own offers, counters addressed to them, quotes where they are selected)
- Unknown event types default to **hidden** (deny-by-default — line 88)
- Both SSE streaming and JSON polling paths flow through this filter

---

## ZK Audit — PASS (with MEDIUM findings above)

| Check | Result |
|-------|--------|
| Counter route verifies budget_proof when RFQ has budget_commitment? | **YES** — counters.ts:182-205 |
| Rejects missing budget_proof when required? | **YES** — counters.ts:184-186, also core validateCounter:202 |
| Rejects unexpected budget_proof when not required? | **YES** — counters.ts:206-208, also core validateCounter:205-206 |
| `verifyBudgetProof` is the REAL Groth16 verifier? | **YES** — `packages/zk/src/verifier.ts` uses `snarkjs.groth16.verify()` with a real vkey file |
| `server.ts` wires the real verifier? | **YES** — line 33: `import { verifyBudgetProof } from "@ghost-bazaar/zk"`, line 127: passed to `createCounterRoute` |
| `counter_price_scaled` binding check? | **YES** — counters.ts:189-191 verifies `budget_proof.counter_price_scaled` equals `normalizeAmount(counter.price)` |
| Proof fields validated for format? | **PARTIAL** — protocol/curve checked, but pi_a/pi_b/pi_c array structure NOT validated (see MEDIUM-1) |

### Spec ZK requirements match

- Spec Section 10: "If an RFQ carries a `budget_commitment`, the engine MUST enforce proof verification on all counters for that RFQ." — **Engine complies.**
- Spec Section 10: ZK is OPTIONAL at the protocol level. If `budget_commitment` is absent, no proof required. If present, proof MANDATORY on every counter. — **Engine matches exactly.**
- Spec Section 10.5: Proof format with `pi_a`, `pi_b`, `pi_c`, `protocol`, `curve`, `counter_price_scaled`. — **Engine checks protocol/curve/counter_price_scaled but not array shapes** (MEDIUM-1).

---

## Hardcode/Stub Audit — PASS

| Check | Result |
|-------|--------|
| `async () => true/false`, noop, stub, TODO, FIXME, HACK? | **NONE** found in engine src/ |
| Hardcoded DIDs, keys, secrets in source? | **NONE** — only `did:key:z6Mk...` appears in a comment in listing-store.ts as format documentation |
| `process.env` defaults reasonable? | **YES** — PORT=3000, ENFORCER_INTERVAL_MS=1000, COSIGN_TIMEOUT_MS=60000. All reasonable for MVP |
| Security checks skipped with "will implement later"? | **NONE** found |

---

## Summary Table

| Severity | ID | Finding | Action Required |
|----------|----|---------|----------------|
| MEDIUM | M1 | No pi_a/pi_b/pi_c structural validation before ZK verify | Add array shape checks in validateCounter |
| MEDIUM | M2 | Verifier swallows all exceptions silently | Add WARN logging, consider health check |
| LOW | L1 | Devnet USDC mint hardcoded | Replace before mainnet |
