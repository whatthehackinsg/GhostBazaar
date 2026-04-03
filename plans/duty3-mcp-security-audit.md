# Duty 3 MCP Package — Tools Security & Privacy Audit

**Branch:** `feat/duty3-settlement-agents-mcp`
**Scope:** `packages/mcp/src/**`, `packages/mcp/tests/**`, `.mcp.json`
**Date:** 2026-03-22

---

## Per-Tool Audit

### Buyer Tools (buyer.ts)

| Tool | Verdict | Notes |
|------|---------|-------|
| `ghost_bazaar_browse_listings` | **SAFE** | Optional `service_type` filter via Zod. Read-only GET. No sensitive data in or out. |
| `ghost_bazaar_post_rfq` | **SAFE** | `budget_hard`/`budget_soft` accepted as input, stored in local `BuyerState` only. Output returns only `rfq_id` — never budget values. ZK commitment generated internally. |
| `ghost_bazaar_get_offers` | **SAFE** | Fetches events from engine, filters to offer types, returns them. Engine-side visibility already strips buyer-private fields. |
| `ghost_bazaar_counter` | **SAFE** | `sanitizeBuyerAction()` clamps price to `budget_hard`. ZK proof auto-generated. Output contains only `counter_id`/`price`/`round`. Budget values never in output. |
| `ghost_bazaar_accept` | **SAFE** | Delegates to engine `/accept`. Returns signed quote which by protocol design does not contain `budget_hard`. Comment in code confirms this. |
| `ghost_bazaar_settle` | **CONCERN** | `z.record(z.unknown())` accepts any object as `quote` — no structural validation. Falls back to `config.engineUrl/execute` if `payment_endpoint` missing (M2 — unsafe default). Sends real USDC on Solana. |
| `ghost_bazaar_record_feedback` | **SAFE** | Calls `recordDealFeedback` from agents package. Input validated by Zod. |

### Seller Tools (seller.ts)

| Tool | Verdict | Notes |
|------|---------|-------|
| `ghost_bazaar_register_listing` | **SAFE** | Rich Zod schema with nested objects. Signs listing. Stores `listing_id` in local closure. No buyer data exposed. |
| `ghost_bazaar_respond_offer` | **CONCERN** | Price is `z.string()` with no decimal/positive validation. Negative, zero, or garbage strings accepted — `Decimal` constructor will throw with a cryptic error, not a user-friendly one. |
| `ghost_bazaar_respond_counter` | **CONCERN** | Same price validation gap as `respond_offer`. Also uses hardcoded 5-minute `valid_until` — no configurable expiry. |
| `ghost_bazaar_check_events` | **CONCERN** | Returns raw `engine.getEvents()` with `JSON.stringify(events, null, 2)`. No role-based filtering at MCP layer — relies entirely on engine-side visibility. If engine returns events with buyer-private fields due to a bug, MCP layer would pass them through. |
| `ghost_bazaar_cosign` | **SAFE** | Fetches quote, signs as seller via `signQuoteAsSeller()`, posts cosign. Minimal attack surface. |

### Missing Tool

| Tool | Verdict | Notes |
|------|---------|-------|
| `ghost_bazaar_get_rfqs` | **MISSING** | Spec requires this for sellers to discover incoming RFQs. Currently absent — sellers have no mechanism to find RFQs without out-of-band information. |

---

## Category Findings

### 1. Input Validation

**CONCERN — Price strings not validated as valid decimals.**

All price inputs (`anchor_price`, `budget_soft`, `budget_hard`, `price`) use `z.string()` with no regex or refinement. Values like `"-100"`, `"abc"`, `""`, or `"999999999"` pass Zod validation and reach `new Decimal(...)` which either throws an unhelpful error or creates negative/extreme values.

- **Affected tools:** `ghost_bazaar_post_rfq`, `ghost_bazaar_counter`, `ghost_bazaar_respond_offer`, `ghost_bazaar_respond_counter`
- **Fix:** Add `.regex(/^\d+(\.\d{1,2})?$/)` or a Zod `.refine()` that validates positive decimal format

**CONCERN — `ghost_bazaar_settle` quote schema is `z.record(z.unknown())`.**

This accepts literally any JSON object. No validation that the quote has required fields (`rfq_id`, `buyer_signature`, `seller_signature`, `price`, `payment_endpoint`). A malformed quote could cause runtime crashes or send funds to the wrong address.

- **Fix:** Define a proper `QuoteSchema` with required fields

### 2. Privacy Leakage

**SAFE — budget_hard / budget_soft never leak through tool outputs.**

- `ghost_bazaar_post_rfq` stores budgets in local `BuyerState` Map, returns only `rfq_id`
- `ghost_bazaar_counter` uses `sanitizeBuyerAction()` to clamp, outputs only `counter_id`/`price`/`round`
- `ghost_bazaar_accept` returns quote object which by protocol design excludes budget fields
- Privacy tests explicitly verify serialized output does not contain budget values or amounts
- Integration tests verify budget/commitment/salt values never appear in counter output

**MINOR CONCERN — `ghost_bazaar_check_events` passes through raw engine events.**

No MCP-layer filtering. If the engine visibility layer has a bug, buyer-private fields could leak to seller tools (or vice versa). Defense in depth would add a second filter at the MCP layer.

### 3. Prompt Injection Surface

**LOW RISK — Tool descriptions are safe.**

- Descriptions are static strings, not user-controlled
- No description instructs the LLM to perform dangerous operations beyond the tool's scope
- Tool descriptions correctly describe what each tool does

**CONCERN — No sanitization of engine response data.**

Seller-controlled data (listing titles, offer extensions, event payloads) flows through tools back to the LLM as `JSON.stringify(...)` text content. A malicious seller could embed prompt injection instructions in listing titles or offer extensions that the LLM would see. No escaping or sanitization is applied.

- **Affected tools:** `ghost_bazaar_browse_listings`, `ghost_bazaar_get_offers`, `ghost_bazaar_check_events`
- **Mitigation:** This is an industry-wide MCP concern. Consider adding `[UNTRUSTED DATA]` markers around engine responses.

**CONCERN — User input directly concatenated into fetch URLs.**

`ghost_bazaar_browse_listings` builds URL with `?service_type=${input.service_type}`. While Zod validates it as a string, no URL encoding is applied. Special characters could manipulate the URL path.

- **Fix:** Use `encodeURIComponent()` or `URLSearchParams`

### 4. Configuration Security

**SAFE — No hardcoded secrets in source code.**

- `config.ts` loads all secrets from environment variables (`SOLANA_KEYPAIR`, `SOLANA_KEYPAIR_PATH`, `SOLANA_RPC_URL`, `NEGOTIATION_ENGINE_URL`, `PINATA_JWT`)
- Keypair loading validates format and fails explicitly
- `PINATA_JWT` is optional, loaded from env only

**SAFE — `.mcp.json` contains no secrets.**

- References `SOLANA_KEYPAIR_PATH` (a file path, not a key)
- Contains only public endpoint URLs and mint address
- Keypair file at `.keys/seller.json` is presumably gitignored

**MINOR CONCERN — No validation of `SOLANA_KEYPAIR_PATH` safety.**

`loadKeypair()` does `readFileSync(path)` with no path traversal guard. An attacker who controls the env var could read arbitrary JSON files. Low risk since env vars are operator-controlled.

### 5. Test Coverage

| Test File | Coverage | Quality |
|-----------|----------|---------|
| `tools.test.ts` | All 6+5 buyer/seller tools defined, basic handlers | GOOD — verifies tool registration and basic output |
| `integration.test.ts` | Budget privacy for post_rfq, counter, accept | GOOD — explicitly checks budget_hard/budget_soft/commitment/salt never in output |
| `e2e-negotiation.test.ts` | Full 8-step flow: browse → register → RFQ → offer → counter → accept → sign → cosign | EXCELLENT — real engine in-process, no mocks |
| `privacy.test.ts` | budget_hard and budget_soft never in post_rfq output; budget stored only in local state | GOOD — targeted privacy assertions |

**Test Gaps:**
- No test for `ghost_bazaar_settle` (requires Solana interaction or deep mocking)
- No test for invalid/malicious price strings (negative, NaN, empty)
- No test for `ghost_bazaar_check_events` with events containing buyer-private fields
- No test for URL injection in `ghost_bazaar_browse_listings`
- No test for malformed quote object in `ghost_bazaar_settle`
- No test for `ghost_bazaar_get_rfqs` (tool doesn't exist)

---

## Overall Security Rating

**6.5 / 10 — Acceptable for devnet, not production-ready.**

**Strengths:**
- Budget privacy is well-enforced with `sanitizeBuyerAction()` + ZK proofs + tested assertions
- All secrets loaded from environment, none hardcoded
- Zod schemas on all tool inputs
- Excellent E2E test coverage for the happy path
- Proper Ed25519 signing on all protocol messages

**Must-fix before mainnet:**
1. Add decimal format validation on all price string inputs
2. Define a proper `QuoteSchema` for `ghost_bazaar_settle` instead of `z.record(z.unknown())`
3. Remove unsafe `payment_endpoint` fallback in settle — fail explicitly
4. Add `encodeURIComponent` for URL parameters
5. Implement `ghost_bazaar_get_rfqs` seller tool
6. Add `[UNTRUSTED DATA]` markers on engine responses returned to LLM
7. Add defense-in-depth role filtering in `ghost_bazaar_check_events`
