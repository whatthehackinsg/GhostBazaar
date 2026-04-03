# Step 8: Accept + Quote Construction — Implementation Plan

> 5 routes implementing the 18-step quote construction flow (Spec §5.6) + seller decline

## Overview

Step 8 is the **commitment phase** — the most security-critical part of the engine. It turns a negotiation into a dual-signed cryptographic commitment. Five routes work together:

| Route | HTTP | Purpose | Events Emitted |
|-------|------|---------|---------------|
| `accept.ts` | `POST /rfqs/:id/accept` | Buyer selects winner → unsigned quote | `WINNER_SELECTED` |
| `quote-sign.ts` | `PUT /rfqs/:id/quote/sign` | Buyer submits signature | `QUOTE_SIGNED` |
| `quote-read.ts` | `GET /rfqs/:id/quote` | Read current quote state | (none) |
| `cosign.ts` | `PUT /rfqs/:id/cosign` | Seller co-signs → COMMITTED | `QUOTE_COMMITTED` |
| `decline.ts` | `PUT /rfqs/:id/decline` | Seller explicitly declines (engine extension) | `COSIGN_DECLINED` |

## Prerequisite Changes (before route implementation)

### Extend `RecordedOffer` in `session.ts` (fix Codex H1)

The current `RecordedOffer` only retains `{offer_id, seller, price, currency, valid_until}`. The OFFER_SUBMITTED event payload already stores `listing_id` and `payment_endpoint` (set server-side in offers.ts:200-202). The reducer must propagate these into `RecordedOffer` so the quote builder can source `payment_endpoint` from historical provenance:

```typescript
// session.ts — extend RecordedOffer
export interface RecordedOffer {
  readonly offer_id: string
  readonly seller: string
  readonly price: string
  readonly currency: string
  readonly valid_until: string
  readonly listing_id: string        // ← NEW: from OFFER_SUBMITTED event
  readonly payment_endpoint: string  // ← NEW: server-resolved at offer time
}
```

In the reducer's `OFFER_SUBMITTED` case, extract these two additional fields with `str()`. This is a backward-compatible change — no existing tests break because offers.ts already stores these fields in the event payload.

Also extend the RFQ fields in `DerivedSession.rfq` to include `spec` (currently dropped by the reducer). Needed for `computeSpecHash(rfq.spec)` in quote construction:

```typescript
// session.ts — extend rfq in DerivedSession
readonly rfq: {
  // ... existing fields ...
  readonly spec?: Record<string, unknown>  // ← NEW: for spec_hash computation
}
```

### Quote Expiry Derivation (fix Codex M1)

`quote.expires_at` must be explicitly defined:

```
expires_at = min(
  rfq.deadline,
  now + QUOTE_SETTLEMENT_WINDOW
)
```

Where `QUOTE_SETTLEMENT_WINDOW` defaults to **300 seconds (5 minutes)**, configurable via `QUOTE_SETTLEMENT_WINDOW_MS` env var, clamped to [60s, 600s].

Rationale: The quote's settlement window should not extend past the RFQ deadline (otherwise a committed quote outlives the negotiation intent). The 5-minute default gives the buyer time to construct and submit the Solana transaction.

### Quote Signature Verification Helper (Red Team Finding 2)

**CRITICAL implementation note:** The existing `verifySignature()` in `validate-signature.ts` uses `objectSigningPayload()` which sets `{ ...obj, signature: "" }`. This is correct for RFQ, Offer, and Counter objects.

**Quote signatures are DIFFERENT.** They use `quoteSigningPayload()` which sets `{ ...obj, buyer_signature: "", seller_signature: "" }`. If an implementer mistakenly calls `verifySignature()` on a quote object, it would inject a spurious `signature: ""` key into the canonical JSON, producing different bytes from what the buyer/seller actually signed. All legitimate signatures would be rejected.

**Required:** Add `verifyQuoteSignature()` to `validate-signature.ts`:

```typescript
// validate-signature.ts — NEW helper for quote signatures
export async function verifyQuoteSignature(
  quote: SignedQuote,
  signature: string,
  expectedSignerDid: string,
  errorCode: string,
): Promise<void> {
  // Uses quoteSigningPayload (buyer_signature="" + seller_signature="")
  // NOT objectSigningPayload (signature="")
  const payload = quoteSigningPayload(quote)
  const pubkey = didToPublicKey(expectedSignerDid)
  if (!pubkey) throw new EngineError(401, errorCode, "Invalid signer DID")
  const ok = await verifyEd25519(payload, signature, pubkey)
  if (!ok) throw new EngineError(401, errorCode, "Signature verification failed")
}
```

**Enforcement:** Add a lint comment or test that `verifySignature()` is never called with a quote-like object (one that has `buyer_signature` or `seller_signature` fields).

### Read-Path Authentication (fix Codex H3)

All authenticated endpoints (including `GET /quote` and `GET /events`) use the same mechanism:

**Request signing**: The client includes an `Authorization` header with a short-lived signed challenge:
```
Authorization: GhostBazaar-Ed25519 did=<did:key:...>,ts=<ISO8601>,sig=<ed25519:base64>
```
Where `sig` signs `"ghost-bazaar-auth:<did>:<timestamp>"` with the caller's private key. Engine verifies:
1. `did` is a valid `did:key`
2. `ts` is within 60 seconds of server time
3. `sig` is valid Ed25519 over the challenge string using `didToPublicKey(did)`

Implementation: `src/middleware/read-auth.ts` — shared by `GET /quote` and `GET /events`.

## Shared Infrastructure Needed

### Quote State in Events — NO separate QuoteStore (Gemini D1)

**Design decision**: All quote state lives in the EventStore. No separate mutable QuoteStore.

This is the architecturally correct choice for an event-sourced system:
- `WINNER_SELECTED` payload contains the **full unsigned quote** (quote_id, nonce, expires_at, all fields)
- `QUOTE_SIGNED` payload contains `{ buyer_signature }` (~88 bytes)
- `QUOTE_COMMITTED` payload contains `{ seller_signature }` (~88 bytes)
- `deriveState()` reconstructs the current quote by layering these events

**Why this is better than a separate QuoteStore:**
1. **Crash recovery**: restart + replay events = full quote state recovered. No data loss. (fixes Gemini S1)
2. **No split-brain**: single source of truth for everything. (fixes Codex H2)
3. **No consistency model needed**: event append is the only write operation.
4. **Negligible bloat**: two Ed25519 signatures add ~176 bytes total per session.

**`deriveState()` changes** — extend the reducer to track quote fields:

```typescript
// New fields in DerivedSession
export interface DerivedSession {
  // ... existing fields ...
  readonly unsignedQuote: SignedQuote | null  // from WINNER_SELECTED (includes memo_policy, nonce, expires_at)
  readonly buyerSignature: string | null     // from QUOTE_SIGNED
  readonly sellerSignature: string | null    // from QUOTE_COMMITTED
}
```

Note: `SignedQuote` from `@ghost-bazaar/core` already includes `memo_policy`, `nonce`, `spec_hash`, and all Spec §5.5 fields. The `buildUnsignedQuote()` in core defaults `memo_policy` to `"quote_id_required"` (Spec §5.5).

### Extensions Preservation (Spec §5.7 compliance)

Per Spec §5.7: "engine MUST NOT strip extensions it does not understand" and "extensions MUST be included in canonical JSON serialization."

The quote flow preserves extensions at every step:
- **RFQ extensions**: stored in RFQ_CREATED event payload, available via `session.rfq` (already handled by existing reducer)
- **Offer extensions**: stored in OFFER_SUBMITTED event payload, available via `RecordedOffer` (extend with `extensions?: Record<string, unknown>`)
- **Quote extensions**: if the accepted offer or RFQ carries extensions, they are NOT automatically propagated into the quote. Per Spec, the Quote object itself MAY have an `extensions` field. The engine preserves extensions on the source objects but does not inject them into the quote unless explicitly carried through.
- **WINNER_SELECTED event**: stores the full unsigned quote object, which includes `extensions` if present. `canonicalJson()` in core already handles extension key sorting and empty-extension omission per §5.7.
- **Event relay**: `filterEventsForRole()` already preserves extensions on forwarded events (from the engine plan Security Architecture section).

`RecordedOffer` extension (add to prerequisite changes):
```typescript
export interface RecordedOffer {
  // ... existing fields ...
  readonly extensions?: Record<string, unknown>  // ← preserved per Spec §5.7
}
```

The reducer builds the current quote:
- On `WINNER_SELECTED`: extract full unsigned quote from payload, set `unsignedQuote`
- On `QUOTE_SIGNED`: extract `buyer_signature`, set `buyerSignature`
- On `QUOTE_COMMITTED`: extract `seller_signature`, set `sellerSignature`
- On `COSIGN_DECLINED` / `COSIGN_TIMEOUT`: **MUST clear ALL three fields** (`unsignedQuote = null`, `buyerSignature = null`, `sellerSignature = null`). Failure to clear these would cause `getCurrentQuote()` to return stale quote data after rollback — a correctness bug that could serve a wrong seller's payment_endpoint. **Add integration test** covering: accept Seller A → decline → accept Seller B → verify quote has Seller B's fields, not Seller A's.

**Reading the quote** (for `GET /quote` and `PUT /cosign`):
```typescript
function getCurrentQuote(session: DerivedSession): SignedQuote | null {
  if (!session.unsignedQuote) return null
  return {
    ...session.unsignedQuote,
    buyer_signature: session.buyerSignature ?? "",
    seller_signature: session.sellerSignature ?? "",
  }
}
```

**Rollback on decline/timeout**:
1. Append `COSIGN_DECLINED` or `COSIGN_TIMEOUT` event (state → NEGOTIATING)
2. Reducer clears unsignedQuote/buyerSignature/sellerSignature
3. Next `POST /accept` creates a new quote with incremented revision

### `src/util/quote-builder.ts` (thin wrapper)

```typescript
function buildQuoteFromSession(
  session: DerivedSession,
  offerId: string,
  quoteSettlementWindowMs: number,  // default 300_000 (5 min)
): SignedQuote
```

Sources `payment_endpoint` directly from `RecordedOffer.payment_endpoint` — which was server-resolved from the seller's listing at offer submission time and captured in the OFFER_SUBMITTED event. No ListingStore lookup at accept time.

```typescript
// Implementation sketch:
const offer = session.offers.find(o => o.offer_id === offerId)

// Compute expires_at deterministically: min(deadline, now + window)
// NOTE: We do NOT use buildUnsignedQuote's expires_seconds parameter.
// Instead, we compute expires_at ourselves and override it after construction.
// This avoids the double-derivation mismatch where the core helper would
// independently compute a different expires_at from expires_seconds.
const expiresAt = new Date(
  Math.min(
    Date.parse(session.rfq.deadline),
    Date.now() + quoteSettlementWindowMs,
  )
).toISOString()

const quote = buildUnsignedQuote({
  rfq_id: session.rfq.rfq_id,
  buyer: session.rfq.buyer,
  seller: offer.seller,
  service_type: session.rfq.service_type,
  final_price: offer.price,
  currency: offer.currency,
  payment_endpoint: offer.payment_endpoint,  // ← from RecordedOffer, not ListingStore
  expires_seconds: 0,  // placeholder — overridden below
  spec_hash: session.rfq.spec ? computeSpecHash(session.rfq.spec) : undefined,
})

// Override expires_at with our deterministic value
return { ...quote, expires_at: expiresAt }
```

**Why override instead of using `expires_seconds`**: `buildUnsignedQuote` computes `expires_at = now + expires_seconds`, but we need `min(deadline, now + window)`. Rather than modifying the core helper (which other duties also use), we override the field after construction. The override happens BEFORE the quote is stored in the event, so both parties sign the deterministic value.

## Route Implementations

### 1. `accept.ts` — POST /rfqs/:id/accept

**Spec §5.6 steps 1-7. Transitions: NEGOTIATING → COMMIT_PENDING**

Validation order (inside handler, Spec-compliant):
1. Parse JSON body → `400 malformed_payload`
2. Validate signed control envelope (envelope_id, action="accept", rfq_id, session_revision, seller, offer_id in payload, issued_at, expires_at, signature) → `400`/`401`/`409`
3. Reject duplicate `envelope_id` via tombstone → `409 duplicate_control_envelope`
4. **Inside lock:**
   a. Deadline check (wall clock) → `409`
   b. State === NEGOTIATING → `409 invalid_state_transition`
   c. Signer DID === `rfq.buyer` → `401 invalid_buyer_signature`
   d. `payload.seller` is a DID that has submitted at least one offer for this RFQ → `404` (Spec §5.6 step 3)
   e. `payload.offer_id` exists in session offers AND belongs to `payload.seller` → `404`
   f. `payload.session_revision` === `session.lastEventId` (CAS) → `409 stale_revision`
   g. Offer `valid_until` still in future → `422 invalid_expiry`
   h. Accept limit: global ≤ 6, per-seller ≤ 2 → `422 accept_limit_exceeded`
   h. Call `buildQuoteFromSession()` → unsigned quote (includes `memo_policy` defaulting to `"quote_id_required"` per Spec §5.5)
   i. Validate `final_price > 0` AND `normalizeAmount(final_price, mint) > 0n` (Spec §5.5 MUST)
   j. Validate nonce format: `0x` + 64 lowercase hex chars, reject uppercase (Spec §5.5 MUST)
   k. Append `WINNER_SELECTED` event (payload: **full unsigned quote** including quote_id, nonce, expires_at, payment_endpoint, memo_policy — all fields needed for recovery)
4. Return `200` with unsigned quote in response body

### 2. `quote-sign.ts` — PUT /rfqs/:id/quote/sign

**Spec §5.6 steps 8-10. Stays in COMMIT_PENDING.**

Validation order:
1. Parse JSON body `{ buyer_signature: "ed25519:..." }` → `400`
2. Validate `buyer_signature` format (pre-check) → `400`
3. **Inside lock:**
   a. Deadline check (`rfq.deadline`) → `409`
   b. Quote expiry check (`quote.expires_at`) → `422 quote_expired` (Gemini S3 fix)
   c. State === COMMIT_PENDING → `409 invalid_state_transition`
   d. `session.unsignedQuote` exists → `404`
   e. `session.buyerSignature` is null (not yet signed) → `409 already_signed`
   f. Verify `buyer_signature` against `didToPublicKey(quote.buyer)` using quote canonical bytes → `401 invalid_buyer_signature`
   g. Append `QUOTE_SIGNED` event (payload: `{seller: selectedSeller, buyer_signature}`)
4. Return `200` with partially-signed quote (assembled from session fields)

### 3. `quote-read.ts` — GET /rfqs/:id/quote

**Spec §5.6 quote retrieval. Read-only, no state change.**

1. Auth: Extract caller DID from request
2. Session must exist → `404`
3. State must be COMMIT_PENDING or COMMITTED → `404` (no quote in OPEN/NEGOTIATING)
4. Caller must be `rfq.buyer` OR `session.selectedSeller` → `401`
5. Return `getCurrentQuote(session)` — assembled from `session.unsignedQuote` + `session.buyerSignature` + `session.sellerSignature`

Lock needed for consistent read (session derived inside `withLock`).

### 4. `cosign.ts` — PUT /rfqs/:id/cosign

**Spec §5.6 steps 11-18. Transitions: COMMIT_PENDING → COMMITTED.**

Validation order:
1. Parse JSON body `{ seller_signature: "ed25519:..." }` → `400`
2. Validate `seller_signature` format (pre-check) → `400`
3. **Inside lock:**
   a. Deadline check (`rfq.deadline`) → `409`
   b. Quote expiry check (`quote.expires_at`) → `422 quote_expired` (Gemini S3 fix)
   c. State === COMMIT_PENDING → `409 invalid_state_transition`
   d. `session.unsignedQuote` exists AND `session.buyerSignature` exists → `409 buyer_not_signed` if missing
   e. Verify `seller_signature` against `didToPublicKey(quote.seller)` using quote canonical bytes → `401 invalid_seller_signature`
   f. **CRITICAL: verify signer is `session.selectedSeller`** — NOT any seller → `401`
   g. Append `QUOTE_COMMITTED` event (payload: `{seller: selectedSeller, seller_signature}`)
4. Return `200` with fully-signed quote (assembled from session fields)

### 5. `decline.ts` — PUT /rfqs/:id/decline (Engine Extension)

Per Spec §7, seller decline is engine-internal. We add an explicit HTTP endpoint as an **engine extension** (not in Spec) for better UX — seller can decline in <1s instead of waiting 60s for timeout.

Validation order:
1. Parse JSON body → `400`
2. Validate signed control envelope (action="decline", rfq_id, session_revision) → `400`/`401`
3. **Inside lock:**
   a. Deadline check → `409`
   b. State === COMMIT_PENDING → `409 invalid_state_transition`
   c. Signer DID === `session.selectedSeller` → `401` (only the selected seller can decline)
   d. Reject duplicate `envelope_id` via tombstone → `409 duplicate_control_envelope`
   e. Append `COSIGN_DECLINED` event (reducer clears unsignedQuote/buyerSig/sellerSig)
4. Return `200 { state: "NEGOTIATING" }`

**Timeout still operates as fallback**: if seller neither cosigns nor declines within `COSIGN_TIMEOUT_MS` (60s), the deadline enforcer fires `COSIGN_TIMEOUT` automatically.

## Test Plan

### Unit Tests (`tests/accept.test.ts`)
- Happy path: accept → unsigned quote returned
- Envelope validation: missing/invalid envelope fields
- CAS: stale session_revision → 409
- Accept limits: global (6) and per-seller (2) enforcement
- Offer not found / expired → 404/422
- Non-buyer signer → 401
- State guard: only NEGOTIATING allowed
- Deadline expired → 409
- payment_endpoint sourced from listing (not offer body)

### Unit Tests (`tests/quote-sign.test.ts`)
- Happy path: buyer signs → partially-signed quote stored
- Invalid signature → 401
- Wrong signer (not buyer) → 401
- No quote exists → 404
- Already signed → 409
- Deadline expired → 409
- State not COMMIT_PENDING → 409

### Unit Tests (`tests/quote-read.test.ts`)
- Buyer can read → 200
- Selected seller can read → 200
- Non-selected seller → 401
- Unauthenticated → 401
- No quote (OPEN/NEGOTIATING) → 404
- Returns unsigned / partial / full depending on lifecycle stage

### Unit Tests (`tests/cosign.test.ts`)
- Happy path: seller cosigns → COMMITTED, fully-signed quote
- Wrong seller (not selected) → 401
- Invalid signature → 401
- Buyer_signature missing (unsigned quote) → 409
- State not COMMIT_PENDING → 409
- Deadline expired → 409

### Integration Tests (`tests/quote-flow.test.ts`)
- Full 18-step flow: RFQ → offer → accept → buyer sign → seller cosign → COMMITTED
- Seller decline flow: accept → timeout → NEGOTIATING → re-accept different seller
- Explicit decline (Option B): accept → decline → NEGOTIATING
- Rollback: accept → decline → accept → cosign (revision increments correctly)
- Post-deadline sign/cosign rejection
- Quote immutability: verify canonical bytes match across all steps

## Security Checklist

- [ ] Quote fields are server-constructed (buildUnsignedQuote), not client-supplied
- [ ] payment_endpoint from RecordedOffer (listing provenance at offer time), not current ListingStore
- [ ] Full unsigned quote stored in WINNER_SELECTED event (crash-recoverable)
- [ ] buyer_signature verified against didToPublicKey(quote.buyer), not request sender
- [ ] seller_signature verified against didToPublicKey(quote.seller) = selectedSeller
- [ ] Non-selected seller cannot cosign
- [ ] rfq.deadline re-checked in sign AND cosign (not just accept)
- [ ] quote.expires_at re-checked in sign AND cosign (Gemini S3)
- [ ] CAS on accept prevents stale revision acceptance
- [ ] Accept limits enforced (6 global, 2 per-seller)
- [ ] Control envelope with nonce prevents accept replay
- [ ] Quote canonical bytes use both signatures blanked to ""
- [ ] No separate QuoteStore — all state in EventStore (crash-safe, no split-brain)
- [ ] GET /quote uses GhostBazaar-Ed25519 authenticated read
- [ ] GET /quote returns quote only to buyer or selected seller

## File Outputs

```
packages/engine/
  src/
    state/session.ts              ← MODIFY: extend RecordedOffer + add unsignedQuote/buyerSig/sellerSig to DerivedSession
    middleware/read-auth.ts       ← NEW: GhostBazaar-Ed25519 auth for GET endpoints
    util/quote-builder.ts         ← NEW: buildQuoteFromSession wrapper
    routes/accept.ts              ← NEW: POST /rfqs/:id/accept
    routes/quote-sign.ts          ← NEW: PUT /rfqs/:id/quote/sign
    routes/quote-read.ts          ← NEW: GET /rfqs/:id/quote
    routes/cosign.ts              ← NEW: PUT /rfqs/:id/cosign
    routes/decline.ts             ← NEW: PUT /rfqs/:id/decline (engine extension)
  tests/
    accept.test.ts                ← NEW
    quote-sign.test.ts            ← NEW
    quote-read.test.ts            ← NEW
    cosign.test.ts                ← NEW
    decline.test.ts               ← NEW
    quote-flow.test.ts            ← NEW: E2E integration
```

## Dependencies

- `@ghost-bazaar/core`: `buildUnsignedQuote`, `verifyEd25519`, `canonicalJson`, `computeSpecHash`
- Existing engine: `SessionManager`, `EngineError`, `preCheckSignatureFormat`, `verifySignature`, `ListingStore`
- New: `read-auth.ts` middleware (GhostBazaar-Ed25519 auth for GET endpoints)

## Estimated Test Count

~55 new tests across 7 test files, bringing total to ~283.
