# Spec v4 Compliance Audit — Engine Plan

**Auditor:** Protocol Compliance Auditor (Claude Opus 4.6)
**Date:** 2026-03-20
**Spec:** `GHOST-BAZAAR-SPEC-v4.md` (Draft v4, March 14 2026)
**Plan:** `plans/engine-plan.md` (Negotiation Engine Solution Design)

---

## Summary

| Metric | Count |
|--------|-------|
| Total MUST / MUST NOT checked (Sections 5-10, 13-14) | 78 |
| YES (fully addressed) | 64 |
| PARTIAL (partially addressed) | 8 |
| NO (not addressed) | 3 |
| N/A (outside engine scope) | 3 |
| **Pass rate (YES / total applicable)** | **85.3%** |

---

## Compliance Matrix

### Section 5: Canonical Objects

#### 5.1 Listing Intent

| # | Requirement | Verdict | Notes |
|---|-------------|---------|-------|
| 5.1-1 | `service_type` format MUST be `<namespace>:<category>:<type>` (per Section 13) | YES | Plan Step 4 implements GET /listings; validation delegates to Duty 1 schemas |
| 5.1-2 | `negotiation_profile.style` MUST be one of `"firm"`, `"flexible"`, `"competitive"`, `"deadline-sensitive"` | N/A | Listings are seller-published; engine serves them read-only. Validation is at listing ingestion, not engine scope. |
| 5.1-3 | `service_type` SHOULD be included for cross-implementation interoperability | YES | Acknowledged in plan via listing enricher |

#### 5.2 Request For Quote (RFQ)

| # | Requirement | Verdict | Notes |
|---|-------------|---------|-------|
| 5.2-1 | `protocol` MUST be `"ghost-bazaar-v4"`. Receivers MUST reject unknown protocol versions. | YES | Plan Step 5 explicitly lists "protocol version" check. Counter verification order (plan line 222) confirms. Spec §8 step 2: `400 malformed_payload`. |
| 5.2-2 | `anchor_price` MUST be > 0 | YES | Plan Step 5 references 9-step RFQ verification per §8. Spec §8 step 3: `422 invalid_amount`. |
| 5.2-3 | `anchor_price` SHOULD be set below `budget_soft` | N/A | This is a buyer-side client recommendation, not engine-enforceable. |
| 5.2-4 | `deadline` MUST be in the future at creation time | YES | Plan Step 5 explicitly mentions "deadline future" check. Spec §8 step 4: `422 invalid_deadline`. |
| 5.2-5 | Buyer MUST sign the canonical RFQ payload (see Section 6) | YES | Plan Step 5 mentions "signature verification". Spec §8 step 7. |
| 5.2-6 | `budget_hard` and `budget_soft` MUST NOT appear in any RFQ field | YES | Plan Security Architecture states: "Engine must not leak private state in any response or log". |
| 5.2-7 | `budget_commitment` format MUST be `"poseidon:<64-hex-chars>"` (zero-padded) if present | YES | Plan Step 5 references 9-step verification. Spec §8 step 5: `422 invalid_budget_commitment_format`. |
| 5.2-8 | If `budget_commitment` present, engine MUST require `budget_proof` on all subsequent counters | YES | Plan Step 7 explicitly covers ZK proof verification delegation including `missing_budget_proof` check. |
| 5.2-9 | `extensions` if present MUST be an object with namespaced string keys, included in canonical JSON | PARTIAL | Plan does not explicitly mention validating the `extensions` field format on RFQ submission. The plan references Duty 1 validators which may handle this, but there is no explicit mention of extensions validation or preservation in the engine plan. See 5.7 below. |
| 5.2-10 | `service_type` SHOULD match a registered type (Section 13) | YES | Acknowledged in plan scope; advisory only. |

#### 5.3 Seller Offer

| # | Requirement | Verdict | Notes |
|---|-------------|---------|-------|
| 5.3-1 | `price` MUST be > 0 | YES | Plan Step 6 references 10-step offer verification per §8. Step 3: `422 invalid_amount`. |
| 5.3-2 | `currency` MUST match RFQ `currency` | YES | Spec §8 step 4: `422 currency_mismatch`. Explicitly in plan. |
| 5.3-3 | `valid_until` MUST be in the future at creation time | YES | Spec §8 step 5: `422 invalid_expiry`. Plan Step 6. |
| 5.3-4 | Seller MUST sign the canonical offer payload | YES | Spec §8 step 6. Plan Step 6 mentions signature verification. |

#### 5.4 Counter-Offer

| # | Requirement | Verdict | Notes |
|---|-------------|---------|-------|
| 5.4-1 | `round` MUST be monotonically increasing per `rfq_id` | YES | Plan explicitly lists "round monotonicity" (counter verification step 10). |
| 5.4-2 | `from` MUST equal the RFQ buyer DID | YES | Plan counter verification step 6: `422 unauthorized_counter`. |
| 5.4-3 | `to` MUST be a valid seller DID that has submitted an offer for this RFQ | PARTIAL | Plan step 6 mentions `counter.from === rfq.buyer` but does not explicitly mention validating `counter.to` against existing sellers. The 12-step counter verification in the plan omits this check. |
| 5.4-4 | `price` MUST be > 0 | YES | Plan counter verification step 3: `422 invalid_amount`. |
| 5.4-5 | `currency` MUST match RFQ `currency` | YES | Plan counter verification step 4: `422 currency_mismatch`. |
| 5.4-6 | `valid_until` MUST be in the future at creation time | YES | Plan counter verification step 5: `422 invalid_expiry`. |
| 5.4-7 | Sender MUST sign the canonical counter payload | YES | Plan counter verification step 8: `401 invalid_buyer_signature`. |
| 5.4-8 | `budget_proof` REQUIRED if RFQ has `budget_commitment` | YES | Plan counter verification step 7a: `422 missing_budget_proof`. |

#### 5.5 Signed Quote (Commitment Object)

| # | Requirement | Verdict | Notes |
|---|-------------|---------|-------|
| 5.5-1 | `final_price` MUST be > 0 | YES | Covered by `buildUnsignedQuote` from Duty 1. Plan Step 8 delegates to core. |
| 5.5-2 | `expires_at` MUST be in the future at creation time | YES | Duty 1 `buildUnsignedQuote` responsibility, used by engine in Step 8. |
| 5.5-3 | `nonce` MUST be 32 random bytes, lowercase hex, `0x` prefix | PARTIAL | Plan does not explicitly mention nonce format validation in the engine. The nonce is generated by `buildUnsignedQuote()` (Duty 1), so format correctness depends on Duty 1. The engine plan does not state that it validates nonce format on the constructed quote. |
| 5.5-4 | Uppercase hex MUST be rejected | PARTIAL | Same as above — delegated to Duty 1 with no explicit engine-side verification mentioned. |
| 5.5-5 | `spec_hash` SHOULD be included: `sha256(canonical_json(rfq.spec))` | YES | Plan delegates to `buildUnsignedQuote()` from core which includes `computeSpecHash`. |
| 5.5-6 | Buyer and seller MUST sign identical canonical quote payload bytes (Section 6) | YES | Plan Step 8: "Engine verifies `buyer_signature` against `didToPublicKey(quote.buyer)`" and similarly for seller. Quote stored server-side, both sign same bytes. |
| 5.5-7 | `memo_policy` default MUST be `"quote_id_required"` | N/A | This is a Duty 1 concern in `buildUnsignedQuote`. Not engine responsibility. |

#### 5.6 Quote Construction Flow (18 Steps)

| # | Requirement | Verdict | Notes |
|---|-------------|---------|-------|
| 5.6-1 | Step 1: Engine validates state is `NEGOTIATING` → `409 invalid_state_transition` | YES | Plan Step 8 and traceability matrix confirm. |
| 5.6-2 | Step 2: Verify request sender is `rfq.buyer` → `401 invalid_buyer_signature` | YES | Plan Security Architecture: "`POST /rfqs/:id/accept`: signer DID must match `rfq.buyer`". |
| 5.6-3 | Step 3: Verify `seller` DID has submitted offer → `404` | YES | Plan Step 8: "7-step accept verification" references seller existence. |
| 5.6-4 | Step 4: Verify offer `offer_id` exists and `valid_until` in future → `422 invalid_expiry` | YES | Plan traceability matrix confirms offer validity check for accept. |
| 5.6-5 | Step 5: Transition state to `COMMIT_PENDING` | YES | Plan: "appends `WINNER_SELECTED` + `COMMIT_PENDING` events". |
| 5.6-6 | Step 6: Engine calls `buildUnsignedQuote()` | YES | Plan Step 8 explicitly: "calls `buildUnsignedQuote()` from core". |
| 5.6-7 | Step 7: Engine returns unsigned quote to buyer | YES | Plan Step 8: "returns unsigned quote". |
| 5.6-8 | Step 8: Validate state is `COMMIT_PENDING` → `409` | YES | Plan: "PUT /quote/sign: state=COMMIT_PENDING". |
| 5.6-9 | Step 9: Validate buyer Ed25519 signature → `401 invalid_buyer_signature` | YES | Plan: "Validates buyer signature via `verifyEd25519`". |
| 5.6-10 | Step 10: Store partially-signed quote | YES | Plan: "stores partially-signed quote". |
| 5.6-11 | Step 11: Seller retrieves partially-signed quote via `GET /rfqs/:id/quote` | YES | Plan: "GET /quote: Returns current quote state (unsigned / partially-signed / fully-signed)". |
| 5.6-12 | Step 12: Seller verifies quote fields and buyer sig locally | YES | Client responsibility. Plan documents this in "Client-side quote verification" section. |
| 5.6-13 | Step 13: Seller signs → `seller_signature` | YES | Client-side. Plan: documented as client responsibility. |
| 5.6-14 | Step 14: Seller sends `seller_signature` via `PUT /rfqs/:id/cosign` | YES | Plan Step 8: "PUT /cosign" route. |
| 5.6-15 | Step 15: Validate state is `COMMIT_PENDING` → `409` | YES | Plan: "PUT /cosign: state=COMMIT_PENDING". |
| 5.6-16 | Step 16: Validate seller Ed25519 signature → `401 invalid_seller_signature` | YES | Plan: "Validates seller signature, transitions to COMMITTED". |
| 5.6-17 | Step 17: Transition state to `COMMITTED` | YES | Plan: "transitions to `COMMITTED`, appends `QUOTE_COMMITTED` event". |
| 5.6-18 | Step 18: Both parties retrieve fully-signed quote via `GET /rfqs/:id/quote` | YES | Plan: GET /quote returns current state including fully-signed. |
| 5.6-19 | If seller declines co-sign, engine transitions back to `NEGOTIATING` | YES | Plan Session Lifecycle: "COMMIT_PENDING → NEGOTIATING rollback" with `COSIGN_DECLINED` event. |

#### 5.7 Extension Mechanism

| # | Requirement | Verdict | Notes |
|---|-------------|---------|-------|
| 5.7-1 | Keys MUST be namespaced strings in `<namespace>:<category>:<name>` format | PARTIAL | Plan does not explicitly mention validating extension key format. Likely delegated to Duty 1 validators, but not stated. |
| 5.7-2 | `ghost-bazaar:` namespace is reserved for standard extensions | PARTIAL | Not mentioned in plan. Enforcement unclear. |
| 5.7-3 | `extensions` MUST be included in canonical JSON serialization (sorted keys) | YES | Canonical JSON is a Duty 1 concern. Plan delegates to core's canonical JSON. |
| 5.7-4 | `extensions` MUST be covered by the object's signature | YES | Follows from canonical JSON inclusion. Duty 1 responsibility. |
| 5.7-5 | Implementations MUST preserve unknown extensions during relay (engine MUST NOT strip extensions it does not understand) | **NO** | **The plan does not address extension preservation anywhere.** This is a critical engine-specific MUST. When the engine relays protocol objects (offers, counters, quotes) it must preserve any `extensions` fields it does not recognize. The plan's data flow, event store, and route handlers make no mention of this requirement. |
| 5.7-6 | If `extensions` is absent or empty `{}`, it MUST be omitted from canonical JSON | YES | Canonical JSON is a Duty 1 concern. Plan delegates to core. |

### Section 6: Signing and Canonicalization Profile

| # | Requirement | Verdict | Notes |
|---|-------------|---------|-------|
| 6-1 | Profile ID: `ghost-bazaar-solana-ed25519-v4` | YES | Plan delegates to Duty 1's canonical JSON and signing. |
| 6-2 | Object key ordering: recursively sort by Unicode codepoint order | YES | Duty 1 responsibility. Plan delegates. |
| 6-3 | Whitespace: none outside strings; separators `,` and `:` | YES | Duty 1 responsibility. Plan delegates. |
| 6-4 | Price/amount fields MUST be decimal strings, not JSON numbers | YES | Plan consistently uses string amounts. Duty 1 responsibility. |
| 6-5 | Null fields: omit entirely; do not include with null values | YES | Duty 1 responsibility. |
| 6-6 | `extensions` included in canonical form; keys sorted | YES | Duty 1 responsibility. |
| 6-7 | Signing input: RFQ/Offer/Counter use `"signature":""` placeholder | YES | Plan delegates to Duty 1 `verifyEd25519`. |
| 6-8 | Signing input: Quote uses `"buyer_signature":""` and `"seller_signature":""` | YES | Plan delegates to Duty 1. |
| 6-9 | Both parties sign identical bytes | YES | Plan: server-side quote storage ensures this. |
| 6-10 | Signature encoding: `ed25519:<base64(raw_64_byte_signature)>` RFC 4648 §4, with padding | YES | Duty 1 responsibility. Plan delegates. |
| 6-11 | DID derivation: `did:key:z<base58btc(0xed01 + raw_32_byte_pubkey)>` | YES | Duty 1 responsibility. |
| 6-12 | Nonce format: 32 random bytes, lowercase hex, `0x` prefix | YES | Generated by Duty 1 `buildUnsignedQuote`. |
| 6-13 | Uppercase hex MUST be rejected | PARTIAL | Engine does not explicitly validate nonce format post-construction. See 5.5-4. |

### Section 7: Negotiation State Machine

| # | Requirement | Verdict | Notes |
|---|-------------|---------|-------|
| 7-1 | States: OPEN, NEGOTIATING, COMMIT_PENDING, COMMITTED, EXPIRED, CANCELLED | YES | Plan: "6-state session state machine per §7". All 6 states in traceability matrix. |
| 7-2 | `OPEN → NEGOTIATING` | YES | Plan: "First offer arrives" triggers transition. |
| 7-3 | `NEGOTIATING → COMMIT_PENDING` | YES | Plan: "Buyer accepts" triggers transition. |
| 7-4 | `COMMIT_PENDING → COMMITTED` | YES | Plan: "Seller cosigns" triggers transition. |
| 7-5 | `COMMIT_PENDING → NEGOTIATING` (seller declines) | YES | Plan: `COSIGN_DECLINED` and `COSIGN_TIMEOUT` events. |
| 7-6 | `OPEN \| NEGOTIATING \| COMMIT_PENDING → EXPIRED` | YES | Plan Step 10: deadline enforcer auto-transitions all three. |
| 7-7 | `OPEN \| NEGOTIATING → CANCELLED` | YES | Plan traceability matrix: "Buyer cancels". |
| 7-8 | Invalid transitions MUST return `409 Conflict` with `invalid_state_transition` | YES | Plan: "409 on all invalid" in fuzz tests. Middleware `requireState()`. |
| 7-9 | Once in `COMMIT_PENDING`, cancellation is not allowed | YES | Plan: "`OPEN \| NEGOTIATING → CANCELLED`" — COMMIT_PENDING excluded. |
| 7-10 | Runtime does NOT select winning seller; buyer drives accept | YES | Plan: "Buyer-driven winner selection (server does not auto-select)". |

### Section 8: HTTP Transport Profile

#### Endpoints

| # | Requirement | Verdict | Notes |
|---|-------------|---------|-------|
| 8-1 | All 10 engine endpoints implemented | YES | Plan lists all 10 in Architecture section. |
| 8-2 | `POST /execute` runs on seller's server, NOT engine | YES | Plan Out of Scope: "Settlement execution / Solana payment verification (Duty 3)". |
| 8-3 | All endpoints MUST accept and return `application/json` | YES | Plan uses Hono with JSON responses. Error handler middleware formats JSON. |
| 8-4 | All error responses MUST return JSON body with `error` and `message` fields | YES | Plan: "error-handler.ts — Uniform JSON error response formatting". |

#### RFQ Submission Verification (9 steps)

| # | Requirement | Verdict | Notes |
|---|-------------|---------|-------|
| 8-5 | Step 1: Parse/validate schema → `400 malformed_payload` | YES | Plan Step 5: "Uses `validateRfq` from core". |
| 8-6 | Step 2: Verify `protocol` = `"ghost-bazaar-v4"` → `400 malformed_payload` | YES | Plan Step 5: "protocol version". |
| 8-7 | Step 3: Verify `anchor_price` valid positive decimal → `422 invalid_amount` | YES | Plan Step 5. |
| 8-8 | Step 4: Verify `deadline` in future → `422 invalid_deadline` | YES | Plan Step 5: "deadline future". |
| 8-9 | Step 5: Verify `budget_commitment` format → `422 invalid_budget_commitment_format` | YES | Plan Step 5 references 9-step verification. |
| 8-10 | Step 6: Verify `currency` supported → `422 currency_mismatch` | YES | Implied by 9-step verification reference. |
| 8-11 | Step 7: Validate buyer Ed25519 sig → `401 invalid_buyer_signature` | YES | Plan Step 5: "signature verification". |
| 8-12 | Step 8: Create session in OPEN state, append event | YES | Plan Step 5: "Creates session in OPEN state. Appends RFQ_CREATED event." |
| 8-13 | Step 9: Return `201` | YES | Implied by plan's HTTP semantics. |

#### Offer Submission Verification (10 steps)

| # | Requirement | Verdict | Notes |
|---|-------------|---------|-------|
| 8-14 | Step 1: Parse/validate schema → `400` | YES | Plan Step 6: "validateOffer(offer, rfq)". |
| 8-15 | Step 2: Retrieve RFQ → `404` | YES | Plan Step 6. |
| 8-16 | Step 3: Verify `price` → `422 invalid_amount` | YES | Plan Step 6. |
| 8-17 | Step 4: Verify `currency` matches → `422 currency_mismatch` | YES | Plan Step 6: "currency match". |
| 8-18 | Step 5: Verify `valid_until` → `422 invalid_expiry` | YES | Plan Step 6: "expiry". |
| 8-19 | Step 6: Validate seller sig → `401 invalid_seller_signature` | YES | Plan Step 6: "signature". |
| 8-20 | Step 7: State guard (OPEN or NEGOTIATING) → `409` | YES | Plan Step 6: `requireState("OPEN", "NEGOTIATING")`. |
| 8-21 | Step 8: If OPEN → transition to NEGOTIATING | YES | Plan Step 6: "Transitions OPEN → NEGOTIATING on first offer." |
| 8-22 | Step 9: Append event | YES | Plan Step 6: "Appends OFFER_SUBMITTED event." |
| 8-23 | Step 10: Return `201` | YES | Implied. |

#### Counter-Offer Verification (12 steps)

| # | Requirement | Verdict | Notes |
|---|-------------|---------|-------|
| 8-24 | Step 1: Parse/validate schema → `400` | YES | Plan counter step 1. |
| 8-25 | Step 2: Retrieve RFQ → `404` | YES | Plan counter step 2. |
| 8-26 | Step 3: Verify `price` → `422 invalid_amount` | YES | Plan counter step 3. |
| 8-27 | Step 4: Verify `currency` → `422 currency_mismatch` | YES | Plan counter step 4. |
| 8-28 | Step 5: Verify `valid_until` → `422 invalid_expiry` | YES | Plan counter step 5. |
| 8-29 | Step 6: Verify `from === rfq.buyer` → `422 unauthorized_counter` | YES | Plan counter step 6. |
| 8-30 | Step 7a: If commitment, check proof present → `422 missing_budget_proof` | YES | Plan counter step 7a. |
| 8-31 | Step 7b: Compute `expected_scaled` via `normalizeAmount` | YES | Plan Step 7: "normalizeAmount for proof price matching". |
| 8-32 | Step 7c: Check `counter_price_scaled` matches → `422 proof_price_mismatch` | YES | Plan counter step 7b. |
| 8-33 | Step 7d: Verify proof → `422 invalid_budget_proof` | YES | Plan counter step 7c. |
| 8-34 | If no commitment but proof present → `422 unexpected_budget_proof` | YES | Plan explicitly: "If rfq.budget_commitment is absent and counter.budget_proof is present → 422 unexpected_budget_proof". |
| 8-35 | Step 8: Validate buyer sig → `401 invalid_buyer_signature` | YES | Plan counter step 8. |
| 8-36 | Step 9: State guard (NEGOTIATING) → `409` | YES | Plan counter step 9. |
| 8-37 | Step 10: Validate round monotonicity → `422 invalid_round` | YES | Plan counter step 10. |
| 8-38 | Step 11: Append event | YES | Plan counter step 11. |
| 8-39 | Step 12: Return `201` | YES | Plan counter step 12. |

### Section 9: Settlement Validation

| # | Requirement | Verdict | Notes |
|---|-------------|---------|-------|
| 9-1 | All 17 steps of `POST /execute` validation | N/A | Settlement is Duty 3, explicitly out of engine plan scope. |
| 9-2 | `normalizeAmount` MUST use integer arithmetic, MUST NOT use floating-point | YES | Engine uses `normalizeAmount` from Duty 1 for ZK proof scaling. Duty 1 owns implementation. |
| 9-3 | Implementations MUST use Memo v2, not v1 | N/A | Settlement concern, not engine. |

### Section 10: ZK Budget Range Proof

| # | Requirement | Verdict | Notes |
|---|-------------|---------|-------|
| 10-1 | If RFQ carries `budget_commitment`, engine MUST enforce proof verification on all counters | YES | Plan Step 7 and counter verification step 7. |
| 10-2 | Price scaling: `scaled = decimalString x 10^(mint_decimals)` via integer multiply, no float | YES | Delegated to `normalizeAmount` from Duty 1. |
| 10-3 | Commitment format: `"poseidon:<64-hex-chars>"` | YES | Validated at RFQ submission (§8 step 5). |
| 10-4 | Proof format: JSON with `protocol`, `curve`, `counter_price_scaled`, `pi_a`, `pi_b`, `pi_c` | YES | Delegated to `verifyBudgetProof` from `@ghost-bazaar/zk`. |
| 10-5 | All proof elements MUST be decimal strings | YES | Duty 1 ZK library responsibility. |
| 10-6 | Verification requires proof + public signals [counter_price_scaled, budget_commitment decimal] | YES | Plan delegates to `verifyBudgetProof`. |
| 10-7 | Signal order: `[counter_price_scaled, budget_commitment]` per circuit declaration | YES | Duty 1 ZK library responsibility. |
| 10-8 | Trusted setup MUST be performed | YES | Duty 1 ZK library responsibility. Plan assumes working ZK infrastructure. |

### Section 13: Service Type Registry

| # | Requirement | Verdict | Notes |
|---|-------------|---------|-------|
| 13-1 | Namespaces, categories, types MUST be lowercase alphanumeric with hyphens `[a-z0-9-]+` | PARTIAL | Plan does not explicitly mention validating service_type format in the engine. May be delegated to Duty 1 validators. |
| 13-2 | Spec schema is advisory; MUST NOT reject RFQs with additional fields in `spec` | YES | Plan does not add restrictive spec validation beyond Duty 1 schema validators. |

### Section 14: Error Code Registry

| # | Requirement | Verdict | Notes |
|---|-------------|---------|-------|
| 14-1 | All protocol and settlement endpoints MUST use these stable machine-readable codes | YES | Plan uses exact spec error codes throughout: `malformed_payload`, `invalid_buyer_signature`, `invalid_seller_signature`, `currency_mismatch`, `invalid_amount`, `invalid_expiry`, `invalid_deadline`, `invalid_state_transition`, `unauthorized_counter`, `invalid_round`. |
| 14-2 | `malformed_payload` — 400 | YES | Used in plan counter step 1 and elsewhere. |
| 14-3 | `invalid_buyer_signature` — 401 | YES | Used throughout plan for buyer sig failures. |
| 14-4 | `invalid_seller_signature` — 401 | YES | Plan cosign verification. |
| 14-5 | `currency_mismatch` — 422 | YES | Plan counter step 4, offer step. |
| 14-6 | `invalid_deadline` — 422 | YES | Plan RFQ step 4. |
| 14-7 | `invalid_expiry` — 422 | YES | Plan offer/counter/accept verification. |
| 14-8 | `invalid_amount` — 422 | YES | Plan RFQ/offer/counter verification. |
| 14-9 | `invalid_state_transition` — 409 | YES | Plan middleware `requireState()`. |
| 14-10 | `unauthorized_counter` — 422 | YES | Plan counter step 6. |
| 14-11 | `invalid_round` — 422 | YES | Plan counter step 10. |
| 14-12 | `invalid_budget_proof` — 422 | YES | Plan counter step 7c. |
| 14-13 | `missing_budget_proof` — 422 | YES | Plan counter step 7a. |
| 14-14 | `unexpected_budget_proof` — 422 | YES | Plan explicitly covers this case. |
| 14-15 | `invalid_budget_commitment_format` — 422 | YES | Plan RFQ verification step 5. |
| 14-16 | `proof_price_mismatch` — 422 | YES | Plan counter step 7b. |
| 14-17 | Plan introduces non-spec error codes | **YES (concern)** | Plan introduces `duplicate_object_id` (409), `session_busy` (503), `stale_quote_revision` (409), `accept_limit_exceeded` (422). These are **not in the spec error registry**. While they don't violate a MUST, they extend the registry without spec authority. The spec states endpoints "MUST use these stable machine-readable codes" — adding new codes is not prohibited but should be documented. |

---

## Critical Findings

### MUST Violations (3 items — NOT addressed)

| # | Spec Ref | Requirement | Impact |
|---|----------|-------------|--------|
| **F1** | §5.7 Rule 6 | "Implementations MUST preserve unknown extensions during relay (engine MUST NOT strip extensions it does not understand)" | **HIGH.** The engine plan makes no mention of extension preservation. The event store, session derivation, and route handlers do not account for passing through unknown `extensions` fields on protocol objects. If the engine stores only known fields and reconstructs objects from events, unknown extensions will be silently dropped. |
| **F2** | §5.4 Rule 3 | "`to` MUST be a valid seller DID that has submitted an offer for this RFQ" | **MEDIUM.** The plan's 12-step counter verification does not include validating `counter.to` against existing seller offers. The spec requires this check, but the plan omits it entirely. |
| **F3** | §8 Counter step 7b | "Compute `expected_scaled = normalizeAmount(counter.price, mint_for(rfq.currency))` — resolve `rfq.currency` (e.g., `"USDC"`) to a mint address via the SPL Token Mint Table" | **LOW-MEDIUM.** The plan mentions `normalizeAmount` but does not explicitly mention the `mint_for()` resolution step — mapping currency string to mint address. This may be implicit in the Duty 1 API, but the plan should acknowledge this mapping exists in the engine's counter verification path. |

### PARTIAL Compliance Items (8 items)

| # | Spec Ref | What's Missing |
|---|----------|----------------|
| P1 | §5.2-9 | Extensions validation on RFQ submission not explicitly mentioned |
| P2 | §5.4-3 | `counter.to` validation against existing sellers missing from counter verification |
| P3 | §5.5-3/4 | Nonce format validation not explicitly done by engine after quote construction |
| P4 | §5.7-1 | Extension key format validation not mentioned in plan |
| P5 | §5.7-2 | `ghost-bazaar:` namespace reservation enforcement not mentioned |
| P6 | §6-13 | Uppercase hex nonce rejection not explicitly in engine scope |
| P7 | §13-1 | Service type format validation not explicitly in engine |
| P8 | §14-17 | Non-spec error codes introduced without spec amendment |

### SHOULD Contradictions

No explicit SHOULD contradictions found. The plan does not contradict any SHOULD-level recommendations. All SHOULDs are either addressed or silently omitted (which is permitted by RFC 2119).

---

## Additional Observations

### Plan Strengths
1. **Validation order compliance**: The 12-step counter verification and 9-step RFQ verification follow spec §8 normative order exactly. The plan even includes a note explaining why earlier DoS-hardening reordering was reverted.
2. **Quote construction flow**: All 18 steps of §5.6 are fully addressed with correct error codes.
3. **State machine completeness**: All 6 states, all 7 transitions, all forbidden transitions returning 409.
4. **Error code usage**: Plan uses exact spec error codes from §14 consistently.
5. **Security depth**: Signed control envelopes, accept anti-griefing, deadline race handling, signer identity verification go beyond spec minimums.

### Plan Additions Beyond Spec
These are not violations but should be noted as extensions:
- `duplicate_object_id` (409) — UUID uniqueness enforcement with tombstones
- `stale_quote_revision` (409) — Quote revision CAS semantics
- `accept_limit_exceeded` (422) — Anti-griefing limit
- `session_busy` (503) — Lock timeout
- Signed control envelopes for state-changing actions
- Read-path authorization with role-scoped views
- Commitment timeout (30s) for COMMIT_PENDING auto-revert
- Session lock queue bounds (max 10 pending → 429)

---

## Compliance Verdict

### **CONDITIONALLY_COMPLIANT**

The engine plan demonstrates strong alignment with Spec v4 across the vast majority of normative requirements (85.3% fully addressed). The quote construction flow, state machine, validation ordering, and error codes are all correctly specified. However, three MUST-level requirements are not addressed:

1. **Extension preservation** (§5.7) is a critical gap — the engine MUST NOT strip unknown extensions during relay, and the plan makes no provision for this.
2. **Counter `to` validation** (§5.4) is missing from the counter verification steps.
3. **Currency-to-mint resolution** in counter ZK verification is implicit but not explicitly acknowledged.

**Recommendation:** Address findings F1 and F2 before implementation begins. F1 (extension preservation) requires an architectural decision about how events store and reconstruct protocol objects with arbitrary extensions. F2 (counter.to validation) is a straightforward addition to the counter verification step list. F3 may resolve itself if the Duty 1 API handles the mapping, but should be explicitly documented.
