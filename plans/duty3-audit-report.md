# Duty 3 Branch Audit Report

**Branch:** `feat/duty3-settlement-agents-mcp`
**Date:** 2026-03-22
**Scope:** 46 files changed, +6099 lines across 3 new packages + e2e script + skills

---

## Overall Quality Score: 7.0 / 10

Solid architectural foundation with correct protocol flow and good spec alignment, but held back by security issues in skills, atomicity gaps in settlement, missing `ghost_bazaar_get_rfqs` seller tool, and test mocking depth concerns.

---

## CRITICAL Issues (MUST fix before merge)

### C1. Hardcoded keypair paths and public keys in SKILL.md files
**Files:** `.claude/skills/ghost-bazaar-buyer/SKILL.md`, `.claude/skills/ghost-bazaar-seller/SKILL.md`
- Buyer skill has hardcoded public key `5KFABNHuro3jtntXvjc9PU1PsDLFM8s6CPXhknWB52Ys`
- Both skills reference `.keys/buyer.json` / `.keys/seller.json` with hardcoded engine URL and USDC mint
- **Risk:** These keys are devnet test keys, but committing specific key paths and pubkeys into shared skills creates a pattern where real keys could leak
- **Fix:** Use environment variable references only; remove hardcoded pubkeys; document that keys must be generated per-user

### C2. Settlement nonce + execution is NOT atomic (Step 16-17 race)
**File:** `packages/settlement/src/execute.ts` lines ~Step 14-17
- The code checks `isNonceConsumed()` at Step 14, then executes the service at Step 16, then calls `consumeNonce()` at Step 17
- Between check and consume, a concurrent request with the same quote could pass Step 14
- The spec says "Persist nonce to consumed set **atomically** with execution" (Step 17)
- **Risk:** Double-spend / double-execution in concurrent environments
- **Fix:** Consume nonce BEFORE execution (between Step 14 and Step 15), or use a lock. If execution fails, the nonce stays consumed (which is safer than double-execution). Alternatively, consume at Step 14 and un-consume on executor failure.

### C3. `.mcp.json` committed with seller keypair path
**File:** `.mcp.json`
- Contains `"SOLANA_KEYPAIR_PATH": ".keys/seller.json"` — this will be committed to the repo
- **Risk:** Anyone cloning the repo would use the same keypair file path, and the `.keys/` directory might contain real keys
- **Fix:** Add `.mcp.json` to `.gitignore` (or make it `.mcp.json.example`), ensure `.keys/` is gitignored

### C4. Missing `ghost_bazaar_get_rfqs` seller MCP tool
**Spec requires:** `ghost_bazaar_get_rfqs` — `{category?}` → `RFQ[]` (Finds open RFQs)
**Actual:** The seller tools file defines: `ghost_bazaar_register_listing`, `ghost_bazaar_respond_offer`, `ghost_bazaar_respond_counter`, `ghost_bazaar_check_events`, `ghost_bazaar_cosign`
- There is NO tool for sellers to discover/browse incoming RFQs
- The seller skill says "Wait for an RFQ" but provides no mechanism for doing so via MCP tools
- **Fix:** Add `ghost_bazaar_get_rfqs` tool that polls engine for RFQs matching the seller's listing

---

## MEDIUM Issues (SHOULD fix)

### M1. Settlement `verifyQuote` combines Steps 2 and 3 into a single call
**File:** `packages/settlement/src/execute.ts`
- Spec says Step 2 = verify buyer signature, Step 3 = verify seller signature (distinct steps with distinct error codes)
- Implementation calls `verifyQuote()` which returns a single code, then maps it back
- Works correctly, but if `verifyQuote` checks seller before buyer (implementation-dependent), the error code ordering could be wrong
- **Fix:** Verify that `@ghost-bazaar/core.verifyQuote()` checks buyer first, or split into two explicit calls

### M2. `ghost_bazaar_settle` uses `quote.payment_endpoint` but falls back to engine URL
**File:** `packages/mcp/src/tools/buyer.ts` — `ghost_bazaar_settle` handler
```
const executeUrl = quote.payment_endpoint ?? `${config.engineUrl}/execute`
```
- Falling back to the engine's `/execute` is wrong — the engine doesn't have a settlement endpoint
- Should fail explicitly if `payment_endpoint` is missing from the quote
- **Fix:** Remove fallback; throw an error if `payment_endpoint` is missing

### M3. `ghost_bazaar_respond_counter` in seller tools ignores the `counter_id` semantically
**File:** `packages/mcp/src/tools/seller.ts`
- The tool accepts `counter_id` as input but just includes it in the JSON output — it doesn't pass it to the engine as the offer this is responding to
- The engine route `POST /rfqs/:id/offers` doesn't know this offer is a response to a specific counter
- **Impact:** Protocol traceability of which counter prompted which revised offer is lost
- **Fix:** Include `in_response_to` in the offer payload if the engine supports it, or at minimum log the linkage

### M4. Engine client `getEvents` does not pass auth header
**File:** `packages/agents/src/engine-client.ts`
- `getEvents()` calls `GET /rfqs/:id/events` but does NOT include `Authorization: GhostBazaar-Ed25519` header
- The engine requires this header for participant read routes (as documented in CLAUDE.md)
- **Fix:** Add `this.buildAuthHeader()` to the `getEvents()` fetch call

### M5. `BuyerAgent` and `SellerAgent` import from `./registry.js` but file is not in the diff
**Files:** `packages/agents/src/buyer-agent.ts`, `packages/agents/src/seller-agent.ts`
- Both import `registerAgent`, `recordDealFeedback`, `type RegistryConfig`, `type RegisteredAgent` from `./registry.js`
- This file (`packages/agents/src/registry.ts`) is NOT in the branch diff (46 files listed)
- **Risk:** Build will fail if `registry.ts` doesn't exist
- **Fix:** Either include registry.ts in the branch or make the 8004 registry integration optional (dynamic import with try/catch)

### M6. E2E test script has hardcoded USDC mint and keypair paths
**File:** `e2etestscript/run.ts`
- `TEST_USDC_MINT = "6mG4me97Td5NCQ8Pd61Y9rVAGsragUYip4C53WttdHiD"` is hardcoded
- Keypair paths `../.keys/buyer.json` and `../.keys/seller.json` are relative and fragile
- **Fix:** Use environment variables with fallback to these defaults

### M7. `ghost_bazaar_accept` in buyer tools does not wait for cosign
**File:** `packages/mcp/src/tools/buyer.ts`
- After calling `engine.accept()`, it signs the quote as buyer and returns immediately
- The quote is only buyer-signed at this point; the seller still needs to cosign
- The tool output does not indicate the quote is not yet fully committed
- **Fix:** Add a status field like `"status": "awaiting_seller_cosign"` to the output so the LLM knows to wait

### M8. HTTP/SSE transport in CLI is minimal
**File:** `packages/mcp/src/cli.ts`
- The HTTP handler just calls `transport.handleRequest(req, res)` with no path routing
- No CORS headers, no health check endpoint, no graceful shutdown
- Spec says HTTP/SSE is "secondary" but it should at least handle basic production concerns
- **Fix:** Add `/health` endpoint, CORS for cross-origin MCP clients, and signal handling

---

## LOW Issues (nice to have)

### L1. Settlement `extractSplTransfer` raw instruction fallback parses fixed offsets
**File:** `packages/settlement/src/execute.ts`
- The raw instruction fallback reads `data[1..9]` as amount assuming a specific Token Program layout
- This is fragile if Token-2022 or other programs are used
- **Impact:** Low — USDC on devnet/mainnet uses the standard Token Program

### L2. No input validation on price strings in MCP tools
**Files:** `packages/mcp/src/tools/buyer.ts`, `packages/mcp/src/tools/seller.ts`
- Prices are accepted as `z.string()` but not validated as valid decimal numbers
- Could cause downstream `Decimal` constructor failures with poor error messages
- **Fix:** Add `.regex(/^\d+\.\d{2}$/)` or use Decimal.isDecimal validation in Zod schema

### L3. `buildReceipt` explorer URL construction duplicated
**Files:** `packages/settlement/src/receipt.ts`, `packages/mcp/src/tools/buyer.ts`
- Two separate implementations of Solana Explorer URL building
- **Fix:** Centralize in a shared utility

### L4. `onSettled` callback in settlement HTTP handler is fire-and-forget
**File:** `packages/settlement/src/http.ts`
- `config.onSettled?.(quote, result)` errors are caught and silently ignored
- Should at least log the error
- **Fix:** Add error logging in the catch block

### L5. No timeout on engine client fetch calls
**File:** `packages/agents/src/engine-client.ts`
- No `AbortSignal.timeout()` on any fetch calls
- Could hang indefinitely if engine is unresponsive
- **Fix:** Add `signal: AbortSignal.timeout(10_000)` to all fetch calls

---

## Test Quality Assessment

### Settlement Tests (874 lines across 5 files) — GOOD
- **execute.test.ts** (438 lines): Tests all 17 validation steps individually with mock transactions. Uses `__setMockTx` to control Solana RPC responses. Tests both happy path and all error codes. This is the strongest test suite in the branch.
- **http.test.ts** (114 lines): Tests HTTP handler routing, header extraction, error response format. Uses mock executor.
- **integration.test.ts** (218 lines): Full-stack test with mock Solana transaction. Tests the complete flow from HTTP request to receipt.
- **nonce.test.ts** (36 lines): Tests in-memory nonce consumption, idempotency, and reset.
- **receipt.test.ts** (68 lines): Tests receipt building, explorer URL generation, required fields.
- **Verdict:** Tests cover real validation logic. Mocking is at the right level (Solana RPC layer, not the validation logic itself). Coverage is strong for settlement.

### Agent Tests (3 files) — ADEQUATE
- **buyer-agent.test.ts**: Tests negotiation flow with mock engine client via globalThis.fetch. Tests strategy interaction, privacy sanitizer, ZK proof generation trigger.
- **seller-agent.test.ts**: Tests offer posting, counter-offer response, cosign flow. Uses mock fetch.
- **seller-discover.test.ts**: Tests batch RFQ response capability.
- **Weakness:** All tests mock `fetch` globally rather than injecting an engine client. Makes tests brittle and harder to isolate.

### MCP Tests (4 files) — GOOD
- **tools.test.ts** (151 lines): Unit tests for tool definitions, schema validation, basic handler execution with mock fetch.
- **privacy.test.ts**: Dedicated tests that budget_hard never leaks through tool output. Well-targeted.
- **integration.test.ts**: Tests tools against mock engine, verifying signatures and protocol flow.
- **e2e-negotiation.test.ts**: Spins up real engine in-process, tests full 8-step negotiation flow without mocking. This is the highest-value test in the branch.
- **Weakness:** No test for `ghost_bazaar_settle` (would require Solana devnet interaction or deeper mocking).

---

## Spec Compliance Check (GHOST BAZAAR-SPEC-v4 Section 9)

| Spec Step | Implementation | Status |
|-----------|---------------|--------|
| 1. Decode X-Ghost-Bazaar-Quote | base64 decode + JSON parse | PASS |
| 2. Verify buyer Ed25519 sig | via verifyQuote() | PASS (order depends on core impl) |
| 3. Verify seller Ed25519 sig | via verifyQuote() | PASS (see M1) |
| 4. Base58 decode Payment-Signature | bs58.decode + length check | PASS |
| 5. getTransaction via RPC | Connection.getTransaction with confirmed + maxSupportedTransactionVersion:0 | PASS |
| 6. Confirm tx status | Checks meta.err and slot existence | PASS |
| 7. Extract SPL transfer | Handles parsed + raw instructions + inner instructions | PASS |
| 8. Verify destination | ATA derivation from seller DID | PASS |
| 9. Verify mint | Direct comparison against usdcMint config | PASS |
| 10. Verify amount | normalizeAmount from core | PASS |
| 11. Memo quote_id_required | Checks memo contains quote_id | PASS |
| 12. Memo hash_required | sha256(canonical_quote) check | PASS |
| 13. Nonce format | NONCE_RE regex from core | PASS |
| 14. Nonce not consumed | In-memory Set (MVP) | PASS |
| 15. expires_at in future | Date.parse comparison | PASS |
| 16. Execute service | Calls executor callback | PASS |
| 17. Persist nonce | consumeNonce() after execution | PASS (but NOT atomic — see C2) |

### Duty3.md Tool Catalog vs Implementation

| Spec Tool | Implemented | Status |
|-----------|------------|--------|
| ghost_bazaar_browse_listings | Yes | PASS |
| ghost_bazaar_post_rfq | Yes (with ZK commitment) | PASS |
| ghost_bazaar_get_offers | Yes | PASS |
| ghost_bazaar_counter | Yes (with sanitizer + ZK proof) | PASS |
| ghost_bazaar_accept | Yes | PASS |
| ghost_bazaar_settle | Yes (Solana tx + POST /execute) | PASS |
| ghost_bazaar_register_listing | Yes | PASS |
| ghost_bazaar_get_rfqs | **NO** | FAIL (see C4) |
| ghost_bazaar_respond_offer | Yes | PASS |
| ghost_bazaar_respond_counter | Yes | PASS (see M3) |
| ghost_bazaar_check_events | Yes | PASS |
| ghost_bazaar_cosign | Yes (extra, not in spec table) | BONUS |

---

## Integration / Merge Assessment

- **Merge conflicts:** The `git merge-tree` output shows only additions (new files). No textual conflicts detected against `main`. The only shared file is `pnpm-workspace.yaml` and `pnpm-lock.yaml`, which will need clean merge.
- **Engine compatibility:** The engine-client correctly targets existing engine routes (`/rfqs`, `/rfqs/:id/offers`, `/rfqs/:id/counter`, `/rfqs/:id/accept`, `/rfqs/:id/quote/sign`, `/rfqs/:id/quote/cosign`, `/listings`). These match the engine routes in main.
- **Missing dependency risk:** `registry.ts` is imported but not in the diff (M5). The `8004-solana` package is in dependencies — if registry.ts is not included, the build will fail.
- **pnpm workspace:** The branch adds `packages/settlement`, `packages/agents`, and `packages/mcp` to `pnpm-workspace.yaml` — clean addition.

---

## What's Missing vs Duty3.md

1. **`ghost_bazaar_get_rfqs` tool** — specified in tool catalog but not implemented (C4)
2. **8004 Agent Registry integration** — imports exist but `registry.ts` may be missing from diff (M5)
3. **PDA-based nonce (Week-2)** — correctly deferred to MVP in-memory approach, documented as future work
4. **HTTP/SSE transport hardening** — minimal implementation, spec says it's secondary (acceptable)
5. **Post-settlement reputation feedback** — `onSettled` callback hook exists but no 8004 wiring shown in MCP tools
6. **`POST /rfqs/:id/cancel`** — not part of duty3 scope (engine gap) but agents don't handle cancellation

---

## Summary

**Strengths:**
- Settlement validation follows the 17-step spec faithfully with clear step-by-step comments
- Privacy enforcement is well-designed — budget_hard stays in local state, has dedicated test suite
- E2E negotiation test spins up real engine in-process, proving the full protocol flow works
- Clean package architecture with proper workspace dependencies
- MCP server supports both stdio and HTTP/SSE transports
- Good error code taxonomy matching the spec

**Weaknesses:**
- Non-atomic nonce check-then-execute-then-consume is the most dangerous pattern (C2)
- Hardcoded credentials in skill files and .mcp.json (C1, C3)
- Missing `ghost_bazaar_get_rfqs` tool breaks seller autonomous discovery (C4)
- Engine client missing auth headers on read routes (M4)
- No settle tool test coverage
