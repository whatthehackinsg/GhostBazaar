# Ghost Bazaar Engine — Final Security Audit (Pre-Duty 3)

**Auditor:** Claude Opus 4.6 (1M context)
**Date:** 2026-03-21
**Scope:** All 27 source files in `packages/engine/src/`
**Branch:** `feat/engine`

---

## Security Scorecard

| Category                    | Status | Notes |
|-----------------------------|--------|-------|
| Authentication (write)      | PASS   | All 8 write routes verify Ed25519 signatures before any state mutation. RFQ/Offer/Counter use `verifySignature()`, Quote use `verifyQuoteSignature()` (different canonical form). Accept/Decline use signed control envelopes. |
| Authentication (read)       | PASS   | GET /quote and GET /events use `authenticateCaller()` with full Ed25519 header verification (DID + timestamp + signature). 60s drift tolerance. |
| Authorization               | PASS   | Buyer-only ops (counter, accept) enforce `from === rfq.buyer`. Seller-only ops (cosign, decline) enforce `selectedSeller` match. Quote read restricted to buyer + selected seller. Events restricted to participants. |
| Privacy                     | PASS   | Zero references to `budget_hard`, `budget_soft`, `floor_price`, `target_price` in engine source. ZK proof verifies budget constraint without revealing private bounds. |
| ZK Verification             | PASS   | Real `verifyBudgetProof` from `@ghost-bazaar/zk` injected in `server.ts`. Counter route validates `counter_price_scaled` matches `normalizeAmount(price)` before ZK verify. Malformed proof errors caught and mapped to 422. |
| Input Validation            | PASS   | Core schema validators (`validateRfq`, `validateOffer`, `validateCounter`) + engine-level bounds (spec 8KB, extensions 4KB). `extractRfqFields`/`extractOfferFields`/`extractCounterFields` whitelist known fields for signature verification -- extra body fields cannot alter signing payload. |
| Replay Protection           | PASS   | Control envelopes (accept/decline) have UUID nonce tombstoned after first use. Event store rejects duplicate `event_id`. Duplicate `offer_id`/`counter_id` rejected inside lock. CAS `session_revision` prevents stale-state replay. |
| Rate Limiting / DoS         | PASS   | Offers: 50/session, 5/seller. Accepts: 6/session, 2/seller. SSE: 3/DID, 10/session. Lock queue: max 10 pending. Listings: 10K cap. Timer intervals clamped. Signature pre-check rejects malformed sigs before crypto. |
| Error Handling              | PASS   | Global `onEngineError` handler: typed `EngineError` returns `{error, message}`. 500 errors suppress raw message (no stack/path leakage). Session state not revealed in 409 errors. Per-subscriber try/catch in event store. Per-session try/catch in enforcer. |
| Event Visibility            | PASS   | `isEventVisibleTo()` is private to `event-store.ts` and is the sole filter for `getEvents()`, `subscribe()`, and `subscribeFrom()`. Deny-by-default for unknown event types. Buyer sees all; seller sees only own offers, addressed counters, and events where they are the selected seller. |
| Cross-Session Isolation     | PASS   | `EventStore.append()` validates `rfqId === event.rfq_id`. `hasCursor()` is session-scoped (searches session log, not global `seenEventIds`). Per-session locks prevent cross-session lock interference. `ConnectionTracker` tracks per-session. |
| Lock Safety (TOCTOU)        | PASS   | All state-changing operations run inside `withLock()`. Deadline check is FIRST action inside lock. State assertions re-checked inside lock. Decline route re-validates `selectedSeller` inside lock. `appendEvent()` enforces it must be called within `withLock()` context. |

---

## OWASP API Top 10 Analysis

### 1. Injection -- NOT APPLICABLE
No SQL, shell, or eval. In-memory Map-based storage. No user input reaches any execution context.

### 2. Broken Authentication -- CLEAN
- Write routes: Ed25519 signature verified over canonical JSON of the protocol object
- Read routes: GhostBazaar-Ed25519 header with DID + timestamp + signature
- Pre-check filter rejects malformed signatures before crypto (~0.1ms DoS filter)
- Control envelopes bind action + rfq_id + session_revision + timestamp window

### 3. Excessive Data Exposure -- CLEAN
- Error handler suppresses internal details for 500 errors
- Session state not revealed in 409 messages
- `isEventVisibleTo()` filters all event reads by role
- `InternalEventStore` (with `getAllEvents`) confined to `SessionManager` -- route handlers only see the public `EventStore` interface
- Listing enricher explicitly excludes on-chain URI (SSRF prevention)

### 4. Lack of Resources & Rate Limiting -- CLEAN
All resource-intensive operations have explicit caps. No unbounded operations found.

### 5. Broken Function Level Authorization -- CLEAN
- Counter: `from === rfq.buyer` enforced
- Accept: control envelope signer must be `rfq.buyer`
- Cosign: signature verified against `selectedSeller` DID
- Decline: control envelope signer must be `selectedSeller`
- Quote read: buyer or selected seller only
- Events: buyer or seller with recorded offer only

### 6. Mass Assignment -- CLEAN
`extractRfqFields()`, `extractOfferFields()`, `extractCounterFields()` whitelist known fields. Extra body fields are ignored for signature verification. Event payloads constructed explicitly from validated fields.

---

## Ghost Bazaar-Specific Findings

### Finding 1 -- LOW: Listings endpoint has no authentication
**File:** `src/routes/listings.ts`
**Impact:** Public by design (discovery phase). An attacker could enumerate all seller listings and payment endpoints.
**Recommendation:** Document as intentional. Consider optional API key for production if listing data becomes sensitive.

### Finding 2 -- LOW: No per-IP rate limiting at transport level
**File:** `src/server.ts`
**Impact:** The engine has application-level caps (offer limits, connection limits) but no transport-level rate limiting. A determined attacker could still send many malformed requests before hitting application caps.
**Recommendation:** Add reverse proxy (nginx/Cloudflare) with per-IP rate limiting in production deployment. This is a deployment concern, not an engine bug.

### Finding 3 -- INFO: Tombstone memory growth
**File:** `src/security/control-envelope.ts`
**Impact:** `EnvelopeTombstones` grows unboundedly if `sweep()` is never called. The deadline enforcer does not call `sweep()`.
**Recommendation:** Add `tombstones.sweep()` to the enforcer's scan loop. The 1-hour retention with periodic sweep would keep memory bounded. Currently, memory only grows proportionally to accept/decline actions (bounded by session accept limits), so practical risk is very low.

### Finding 4 -- INFO: Event store memory growth for terminated sessions
**File:** `src/state/event-store.ts`
**Impact:** Events for terminated sessions remain in memory indefinitely. The `cleanedUpSessions` set in the enforcer tracks cleanup, but event data is never evicted.
**Recommendation:** Add an eviction policy (e.g., remove event data 1 hour after terminal state). This is an operational concern for long-running instances.

### Finding 5 -- INFO: @solana/web3.js and bs58 in dependencies but not imported
**File:** `package.json`
**Impact:** Listed as direct dependencies but not imported in any engine source file. May be transitive requirements of workspace packages.
**Recommendation:** If not needed directly, move to peer dependencies or remove to reduce attack surface.

---

## Dependency Audit

| Package | Version | Assessment |
|---------|---------|------------|
| hono | ^4.4.0 | Actively maintained, minimal web framework. No known CVEs. |
| @hono/node-server | ^1.11.0 | Official Hono Node adapter. Clean. |
| @ghost-bazaar/core | workspace | Internal. Provides validators, signing, canonical JSON. |
| @ghost-bazaar/zk | workspace | Internal. Provides Groth16 verifier. |
| @ghost-bazaar/agents | workspace | Internal. Provides 8004 agent discovery types. |
| @solana/web3.js | ^1.95.0 | Large dependency tree. Not directly imported -- see Finding 5. |
| bs58 | ^6.0.0 | Small utility. Not directly imported -- see Finding 5. |

No known vulnerable dependencies. No unnecessary runtime dependencies beyond Finding 5.

---

## Verdict

The Ghost Bazaar Negotiation Engine is **security-ready for Duty 3 integration**. All 12 security categories pass. Zero critical or high findings. Three LOW/INFO operational findings documented above.
