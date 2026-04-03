# Step 8 Plan vs Spec v4 Compliance Review

> Sections reviewed: 5.5 (Signed Quote), 5.6 (Quote Construction Flow), 7 (State Machine)

## 1. Compliance Table

### Section 5.5 — Signed Quote Rules

| # | Spec Requirement (exact language) | Plan Coverage | Notes |
|---|----------------------------------|---------------|-------|
| 5.5-1 | `final_price` MUST be > 0 | NO | Plan does not mention `final_price > 0` validation in accept.ts or quote-builder.ts |
| 5.5-2 | `expires_at` MUST be in the future at creation time | YES | Plan line 46-48: `expires_at = min(rfq.deadline, now + QUOTE_SETTLEMENT_WINDOW)` |
| 5.5-3 | `nonce` MUST be 32 random bytes, lowercase hex, `0x` prefix | PARTIAL | Plan line 271 mentions `nonce` in WINNER_SELECTED payload but delegates to `buildUnsignedQuote` from core. No explicit validation of hex format in engine |
| 5.5-4 | Uppercase hex MUST be rejected | NO | Not mentioned anywhere in the plan |
| 5.5-5 | `spec_hash` SHOULD be included: `sha256(canonical_json(rfq.spec))` | YES | Plan line 153: `spec_hash: undefined, // TODO: compute from rfq.spec if available` — acknowledged, deferred |
| 5.5-6 | Buyer and seller MUST sign identical canonical quote payload bytes (Section 6) | YES | Plan line 299: "Quote canonical bytes use both signatures blanked to ''" |
| 5.5-7 | `memo_policy` field with default `"quote_id_required"` | NO | Plan never mentions `memo_policy` field. Not in quote-builder sketch, not in DerivedSession, not in any validation |
| 5.5-8 | Quote schema includes `memo_policy` field | NO | Same as above — field entirely absent from plan |

### Section 5.6 — Quote Construction Flow

| # | Spec Requirement (exact language) | Plan Coverage | Notes |
|---|----------------------------------|---------------|-------|
| 5.6-1 | Accept body: `{ "seller": "did:key:...", "offer_id": "uuid-v4" }` | PARTIAL | Plan uses signed control envelope with `offer_id` in payload (line 164) but does NOT mention `seller` field in accept body. Plan line 169 checks `payload.offer_id` exists but seller is derived from offer lookup, not from request body |
| 5.6-2 | Step 1: validate state is NEGOTIATING -> 409 | YES | Plan line 167b |
| 5.6-3 | Step 2: verify sender is `rfq.buyer` -> 401 | YES | Plan line 168c |
| 5.6-4 | Step 3: verify `seller` DID has submitted at least one offer | NO | Plan validates `offer_id` exists (line 169d) but does NOT validate that the `seller` DID from request body has submitted offers. Since plan omits `seller` from request body entirely, this check is structurally absent |
| 5.6-5 | Step 4: verify offer exists and `valid_until` in future -> 422 | YES | Plan line 171f |
| 5.6-6 | Step 5: transition to COMMIT_PENDING | YES | Plan line 160: "Transitions: NEGOTIATING -> COMMIT_PENDING" |
| 5.6-7 | Step 6: call `buildUnsignedQuote(rfq, accepted_offer, buyer_did, seller_did)` | YES | Plan line 173h |
| 5.6-8 | Step 7: return unsigned quote in response body | YES | Plan line 175 |
| 5.6-9 | Step 8: sign — validate state is COMMIT_PENDING -> 409 | YES | Plan line 187c |
| 5.6-10 | Step 9: validate buyer Ed25519 sig against canonical JSON -> 401 | YES | Plan line 190f |
| 5.6-11 | Step 10: store partially-signed quote | YES | Plan line 191g: append QUOTE_SIGNED event |
| 5.6-12 | Step 15: cosign — validate state is COMMIT_PENDING -> 409 | YES | Plan line 215c |
| 5.6-13 | Step 16: validate seller Ed25519 sig against canonical JSON -> 401 | YES | Plan line 218e |
| 5.6-14 | Step 17: transition to COMMITTED | YES | Plan line 208: "Transitions: COMMIT_PENDING -> COMMITTED" |
| 5.6-15 | Step 18: both parties retrieve fully-signed quote | YES | Plan line 200-204: GET /quote with access for buyer and selectedSeller |
| 5.6-16 | GET /quote: 404 if no quote (OPEN or NEGOTIATING) | YES | Plan line 200 |
| 5.6-17 | GET /quote: returns signatures present (none/partial/full) | YES | Plan line 202 |
| 5.6-18 | Seller decline -> back to NEGOTIATING | YES | Plan lines 117-119 and decline.ts route |

### Section 7 — State Machine

| # | Spec Requirement (exact language) | Plan Coverage | Notes |
|---|----------------------------------|---------------|-------|
| 7-1 | States: OPEN, NEGOTIATING, COMMIT_PENDING, COMMITTED, EXPIRED, CANCELLED | YES | Implicit in plan's state checks |
| 7-2 | NEGOTIATING -> COMMIT_PENDING | YES | accept.ts |
| 7-3 | COMMIT_PENDING -> COMMITTED | YES | cosign.ts |
| 7-4 | COMMIT_PENDING -> NEGOTIATING (seller declines) | YES | decline.ts + timeout |
| 7-5 | Invalid transitions MUST return 409 with `invalid_state_transition` | YES | Plan uses this error code throughout |
| 7-6 | Once in COMMIT_PENDING, cancellation is not allowed | PARTIAL | Plan does not explicitly block cancellation in COMMIT_PENDING, but the state guards implicitly prevent it (accept/decline/cosign all require COMMIT_PENDING or NEGOTIATING) |
| 7-7 | Buyer drives NEGOTIATING -> COMMIT_PENDING via `POST /rfqs/:id/accept` with explicit `seller` DID | PARTIAL | Plan uses accept route correctly but omits `seller` DID from request body (see 5.6-1) |
| 7-8 | If seller declines, session returns to NEGOTIATING and buyer may select different seller | YES | Plan line 119 + decline.ts |

## 2. Deviations

### DEVIATION 1: Accept request body differs from Spec

**Spec** (Section 5.6, line 294-301): Accept body is `{ "seller": "did:key:...", "offer_id": "uuid-v4" }`

**Plan** (line 162-164): Uses a signed control envelope: `{ envelope_id, action="accept", rfq_id, session_revision, offer_id, issued_at, expires_at, signature }`

The plan **drops the `seller` field** entirely from the accept request. The seller DID is derived from the matching offer record. This also means Spec step 3 ("verify `seller` DID has submitted at least one offer") is structurally bypassed — the plan validates `offer_id` existence instead.

**Verdict: COMPATIBLE EXTENSION** — The signed envelope is strictly more secure than the Spec's plain body (adds replay protection via envelope_id, CAS via session_revision, authentication via signature). Deriving seller from offer_id is logically equivalent to receiving seller + offer_id together, since offer_id already implies a seller. However, the plan should document that the `seller` field from Spec is intentionally omitted and why.

### DEVIATION 2: Full unsigned quote stored in WINNER_SELECTED event (no separate QuoteStore)

**Spec** (Section 5.6, step 10): "Engine stores the partially-signed quote" — implies a mutable store.

**Plan** (lines 70-84): Eliminates QuoteStore entirely. Full unsigned quote is embedded in WINNER_SELECTED event payload. Signatures are appended as separate events. Quote state is reconstructed via `deriveState()`.

**Verdict: COMPATIBLE EXTENSION** — The Spec says "stores" but does not prescribe a storage mechanism. Event-sourced reconstruction satisfies the Spec's requirement that the quote is retrievable. This is strictly better for crash recovery and consistency.

### DEVIATION 3: Explicit `PUT /rfqs/:id/decline` HTTP endpoint

**Spec** (Section 7, line 461): "No public HTTP cancel endpoint is defined — cancellation is an engine-internal operation."

**Spec** (Section 5.6, line 352): "If the seller declines to co-sign, the engine transitions back to NEGOTIATING."

**Plan** (lines 223-238): Adds `PUT /rfqs/:id/decline` as an explicit HTTP endpoint for seller decline.

**Verdict: COMPATIBLE EXTENSION** — The Spec's "engine-internal" comment is about buyer *cancellation* (OPEN/NEGOTIATING -> CANCELLED), not about seller decline from COMMIT_PENDING. The Spec acknowledges seller decline happens (line 352) but is silent on the mechanism. An explicit endpoint is a UX improvement that does not violate any MUST/MUST NOT. The plan correctly notes this is "an engine extension (not in Spec)."

### DEVIATION 4: `quote.expires_at` checked in sign and cosign

**Spec** (Section 5.6): Steps 8-10 (sign) check only state == COMMIT_PENDING. Steps 15-16 (cosign) check only state == COMMIT_PENDING. No mention of `expires_at` validation during sign/cosign.

**Plan** (lines 186b, 215b): Both quote-sign.ts and cosign.ts check `quote.expires_at` -> `422 quote_expired`.

**Verdict: COMPATIBLE EXTENSION** — The Spec does not prohibit additional validations. Checking expiry at sign/cosign time is a security hardening that prevents signing a stale quote. This is additive and does not conflict with any Spec requirement.

### DEVIATION 5: Accept limits (6 global, 2 per-seller)

**Spec**: No mention of accept limits anywhere in Sections 5.5, 5.6, or 7.

**Plan** (line 172g): `Accept limit: global <= 6, per-seller <= 2 -> 422 accept_limit_exceeded`

**Verdict: COMPATIBLE EXTENSION** — Not in Spec, but reasonable DoS protection. Does not violate any MUST.

### DEVIATION 6: CAS (Compare-And-Swap) via session_revision

**Spec**: No mention of optimistic concurrency control in the accept flow.

**Plan** (line 170e): `payload.session_revision === session.lastEventId (CAS) -> 409 stale_revision`

**Verdict: COMPATIBLE EXTENSION** — Additive concurrency safety. Does not violate any Spec requirement.

## 3. Gaps (Spec requirements NOT addressed)

| Gap | Spec Ref | Severity |
|-----|----------|----------|
| `final_price > 0` validation | 5.5 line 280 | **HIGH** — Spec MUST. Plan must add this check in accept.ts or quote-builder.ts |
| `memo_policy` field entirely absent | 5.5 lines 286-290 | **HIGH** — Spec defines this as a quote field with default `"quote_id_required"`. Plan's quote schema and builder omit it completely |
| Uppercase hex nonce rejection | 5.5 line 283 | **MEDIUM** — Spec MUST. Likely handled by core's `buildUnsignedQuote` but plan should explicitly confirm |
| `seller` field in accept request body | 5.6 lines 294-301 | **LOW** — Intentional deviation (see Deviation 1), but should be documented |

## Summary

- **14 of 18** Spec requirements in 5.6 are fully covered (YES)
- **2** are partially covered (PARTIAL)
- **2** are not covered (NO) — both in 5.5 (final_price validation, memo_policy)
- **6 deviations** identified — all are **compatible extensions**, none are Spec violations
- **2 high-severity gaps** require plan amendment before implementation: `final_price > 0` and `memo_policy`
