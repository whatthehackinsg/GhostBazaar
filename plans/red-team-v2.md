# Red Team Audit v2: Ghost Bazaar Negotiation Engine

**Attacker:** Red Team (Claude Opus 4.6)
**Date:** 2026-03-20
**Scope:** Post-patch attack surface analysis — finding vectors that bypass the v1 audit remediations
**Baseline:** `plans/red-team-audit.md` (v1 audit), `plans/engine-plan.md` (revised plan with patches)

---

## Patched Defenses (Assumed Working)

The following v1 findings are now addressed in the revised plan. This audit assumes correct implementation of these defenses and focuses on bypasses:

| Defense | Patch |
|---------|-------|
| Offer flooding (Chain-1) | Per-session 50 total offers, 5 per DID |
| Event cap griefing | Cap rejects non-terminal events, not auto-expire |
| Control envelope replay | Signed envelopes with `envelope_id` nonce, tombstoned after use |
| Cursor gap analysis (RT-H4) | Opaque UUID cursors |
| Request body size | 64 KB limit |
| Commitment timeout abuse | 60s default [15-120s] |
| Global accept limit | 6 per session |
| Payment endpoint redirection (RT-C1) | Sourced from original Listing only |
| Cosign identity (RT-C5) | Verified against `didToPublicKey(quote.seller)` |

---

## Attack Category 1: State Machine Corruption

### RT2-C1: deriveState() Reducer Poisoning via Extension Field Collision [CRITICAL]

**Attack goal:** Inject fields into the event payload that confuse the `deriveState()` reducer into producing an impossible state.

**Attack path:**

The spec (Section 5.7) says extensions use namespaced keys and the engine MUST relay them intact. The plan says `filterEventsForRole()` preserves extensions on forwarded events. But `deriveState()` reduces the event log to session state. If the reducer reads from `event.payload` using property access (e.g., `payload.state`, `payload.price`), an attacker can inject a malicious extension that shadows a real protocol field.

Consider the canonical JSON serialization: extensions are sorted alongside regular fields. If an attacker crafts an offer with:

```json
{
  "offer_id": "...",
  "rfq_id": "...",
  "seller": "did:key:z6MkAttacker",
  "price": "35.00",
  "currency": "USDC",
  "valid_until": "...",
  "signature": "ed25519:...",
  "extensions": {
    "ghost-bazaar:internal:state_override": "COMMITTED"
  }
}
```

The schema validator (`validateOffer`) does NOT check for reserved extension keys. If the reducer ever destructures the full event payload (including extensions) without filtering, the `state_override` key could collide with reducer logic.

**More dangerous variant:** If the event payload stored in the EventStore includes the raw parsed JSON body, and the reducer uses `Object.assign` or spread to merge event data into state, any top-level field in the offer body that matches a state field name will override it. The 64KB body limit means the attacker has plenty of room.

**Exact HTTP sequence:**

```
POST /rfqs/:id/offers
Content-Type: application/json
Body: {
  "offer_id": "uuid",
  "rfq_id": "target",
  "seller": "did:key:z6MkAttacker",
  "price": "30.00",
  "currency": "USDC",
  "valid_until": "+5min",
  "signature": "ed25519:<valid>",
  "state": "COMMITTED",
  "quote": {"final_price": "0.01", "seller": "did:key:z6MkAttacker", "payment_endpoint": "https://evil.com/drain"}
}
```

The schema validator checks for required fields but does NOT reject unknown top-level fields. If `event.payload = requestBody` (full body stored), and the reducer ever reads `payload.state` or `payload.quote`, the attacker has injected arbitrary state.

**Prerequisites:** Valid seller keypair (trivial to generate).

**Expected outcome:** If the reducer reads the injected fields, it could skip to COMMITTED state, inject a fake quote with the attacker's payment endpoint, or bypass the commitment flow entirely.

**Current plan defense:** The plan says events have a `NegotiationEvent` type with specific fields (`event_id`, `rfq_id`, `event_type`, `actor`, `payload`, `timestamp`). But it does NOT specify that `payload` is a typed, validated subset of the request body. If `payload` is the raw request body, this attack succeeds. If `payload` is a curated extraction (e.g., only `{offer_id, seller, price, currency, valid_until}`), this attack fails.

**Verdict:** Plan does NOT specify payload sanitization. VULNERABLE unless implementation strips unknown fields.

---

### RT2-C2: Phantom State via Concurrent Accept + Deadline Race [HIGH]

**Attack goal:** Achieve COMMITTED state on a session that should be EXPIRED.

**Attack path:**

The plan says deadline check happens as "first action inside the lock." The deadline enforcer also runs on `setInterval`. Consider this precise timing:

```
T=0:       RFQ deadline is T+100ms
T=0:       Buyer sends POST /accept (valid, acquires lock)
T=50ms:    Lock acquired, handler checks Date.now() < deadline (TRUE, 50ms left)
T=60ms:    Handler transitions to COMMIT_PENDING, appends WINNER_SELECTED event, releases lock
T=100ms:   Deadline passes
T=101ms:   Deadline enforcer runs, acquires lock, checks state=COMMIT_PENDING
```

Now the question: does the deadline enforcer expire COMMIT_PENDING states? The plan says: "Auto-transitions `OPEN | NEGOTIATING | COMMIT_PENDING -> EXPIRED` when `rfq.deadline` has passed."

So yes, the enforcer should expire it. But there's a critical window: the buyer's quote/sign and seller's cosign must both complete within the commitment_timeout (60s), AND before the deadline enforcer kills the session.

But the plan says commitment_timeout is SEPARATE from rfq.deadline. The `expires_at` on the quote provides a separate settlement window. So what happens when:

1. Deadline passes while in COMMIT_PENDING
2. Deadline enforcer fires and expires the session
3. But the buyer already signed (PUT /quote/sign returned 200)
4. Seller sends cosign request — gets 409 (session is EXPIRED)

The buyer has signed a quote that will never be committed. The buyer's agent may attempt settlement with the partially-signed quote (some implementations might not check for seller_signature presence before sending payment).

**More dangerous:** What if the buyer and seller collude to RUSH the cosign before the enforcer runs?

```
T=0:       Buyer accepts (COMMIT_PENDING)
T=100ms:   Deadline passes
T=100ms:   Buyer signs immediately (PUT /quote/sign) - succeeds (enforcer hasn't run yet)
T=110ms:   Seller cosigns immediately (PUT /cosign) - succeeds (enforcer STILL hasn't run, lock acquired by cosign)
T=120ms:   State is now COMMITTED
T=1000ms:  Deadline enforcer runs - state is COMMITTED, no action taken
```

This is a valid COMMITTED quote on a session where the deadline has passed. The seller then has a valid dual-signed quote for a session that was technically expired. If the deadline was meaningful (e.g., the buyer's budget authority expires at deadline), this is an unauthorized commitment.

**Prerequisites:** Buyer and seller coordination (or buyer acting alone if they control both sides).

**Expected outcome:** A valid dual-signed quote exists for a post-deadline session. Settlement can proceed normally because the quote has its own `expires_at`.

**Current plan defense:** The in-lock deadline check catches the accept (T=0 must be before deadline). But sign and cosign handlers do NOT re-check `rfq.deadline` -- they only check `state === COMMIT_PENDING`. The deadline enforcer runs on interval and can miss the window.

**Verdict:** Plan is VULNERABLE. The sign and cosign handlers must ALSO verify `rfq.deadline` has not passed, not just the session state.

---

### RT2-H1: State Machine Rollback Exploitation — Accept During COMMIT_PENDING [HIGH]

**Attack goal:** Second buyer accept request races with seller cosign decline, selecting a different seller than intended.

**Attack path:**

```
T=0:    Buyer accepts Seller A → COMMIT_PENDING
T=1s:   Buyer (realizing A is slow) prepares an accept envelope for Seller B with session_revision=N+1 (predicting the revision after COSIGN_DECLINED)
T=29s:  Seller A still hasn't cosigned
T=30s:  Buyer simultaneously:
         (a) Sends the pre-prepared accept for Seller B
         (b) Waits for timeout
T=60s:  Commitment timeout fires → COSIGN_TIMEOUT → NEGOTIATING (session_revision = N+1)
T=60.001s: Buyer's pre-prepared accept arrives, acquires lock
           session_revision matches N+1 → CAS passes
           State = NEGOTIATING → accept valid → COMMIT_PENDING for Seller B
```

The attack exploits the PREDICTABILITY of `session_revision` after a timeout event. The buyer pre-computes what the revision will be after the timeout, and fires the accept immediately when the rollback occurs.

But the real exploit: the buyer pre-signed the accept envelope BEFORE the timeout. The envelope has `issued_at` from T=30s and `expires_at` from T=30s+60s=T+90s. At T=60s when it's processed, both are valid. The CAS value N+1 was a correct prediction.

**Why is this bad?** If the buyer has a strategy that changes its mind during the commitment window (e.g., Seller B sent a lower offer during the COMMIT_PENDING window for A), the buyer can pre-stage an accept for B that fires the instant A times out. This gives an unfair speed advantage — the buyer effectively has zero-latency re-selection.

**More critically:** session_revision is derived from event count. The timeout event is deterministic (always increments by 1). So the buyer can ALWAYS predict the post-timeout revision. The CAS mechanism provides no protection because the revision is predictable.

**Prerequisites:** Buyer with valid keypair. Knowledge that timeout increments revision by 1.

**Expected outcome:** Buyer achieves instant seller-switching after timeout, gaining an unfair negotiation advantage.

**Current plan defense:** CAS with session_revision in signed envelope. But revision is predictable (event count), so CAS is bypassable by pre-computation.

**Verdict:** CAS mechanism is weaker than it appears. Consider using a cryptographic session_revision (hash of latest event) instead of a counter.

---

## Attack Category 2: Financial Exploits

### RT2-C3: Quote Field Manipulation via canonicalJson Ordering Ambiguity [CRITICAL]

**Attack goal:** Make buyer and seller sign different logical quotes that produce identical canonical JSON bytes.

**Attack path:**

The `canonicalJson()` function in `packages/core/src/canonical.ts` recursively sorts keys and uses `JSON.stringify`. The signing input for a quote is `canonicalJson({ ...quote, buyer_signature: "", seller_signature: "" })`.

Now examine `buildUnsignedQuote()` in `packages/core/src/quote.ts`:
- It constructs the quote with `spec_hash` as an optional field
- If `spec_hash` is undefined, the spread operator includes `spec_hash: undefined`
- In `canonicalJson`, `JSON.stringify` OMITS keys with `undefined` values
- But `sortKeys()` does NOT filter `undefined` — it passes them to JSON.stringify which drops them silently

**The ambiguity:** If the engine builds a quote where `spec_hash` is `undefined`, the canonical JSON excludes `spec_hash`. If a client reconstructs the quote and includes `spec_hash: null`, the canonical JSON includes `"spec_hash":null`. These produce DIFFERENT signing bytes but could represent the "same" quote logically.

But the spec says "Null fields: omit entirely; do not include with null values." So compliant implementations should always omit null. However, the `canonicalJson()` function does NOT enforce this — it passes `null` through:

```typescript
function sortKeys(obj: unknown, isTopLevel: boolean): unknown {
  if (obj === null || typeof obj !== "object") return obj  // null passes through!
```

So `canonicalJson({ a: null })` produces `{"a":null}` while `canonicalJson({ a: undefined })` produces `{}`. A compliant buyer sends `undefined`, an attacker-controlled engine stores `null`, the canonical bytes differ, and signature verification fails — or worse, succeeds on different data.

**Exact exploit:**

1. Engine builds quote with `spec_hash: undefined` (omitted from canonical JSON)
2. Engine returns quote to buyer: `{ ... }` (no `spec_hash` field)
3. Buyer signs canonical JSON of `{ ..., buyer_signature: "", seller_signature: "" }` — no `spec_hash` in output
4. Compromised engine modifies stored quote to include `spec_hash: "sha256:0000...0000"` (garbage hash)
5. Engine constructs canonical JSON with `spec_hash` included — DIFFERENT BYTES
6. Engine presents this modified quote to seller
7. Seller signs the modified canonical JSON (different from what buyer signed)
8. Now buyer_signature was over bytes WITHOUT spec_hash, but seller_signature was over bytes WITH spec_hash
9. `verifyQuote()` constructs canonical JSON from the stored quote object — which includes `spec_hash`. Buyer signature verification FAILS.

Wait — this breaks the quote, not exploits it. Let me think harder.

**Reverse direction exploit:**

1. Engine builds quote normally with `spec_hash: "sha256:<real_hash>"`
2. Buyer sees and signs the quote (canonical JSON includes spec_hash)
3. Compromised engine deletes `spec_hash` from the stored quote before presenting to seller
4. Seller sees a quote WITHOUT spec_hash — signs different bytes
5. Now buyer signed WITH spec_hash, seller signed WITHOUT
6. The quote in the engine has no spec_hash — seller signature verifies against the no-spec-hash version
7. At settlement, the seller receives the quote via `X-Ghost-Bazaar-Quote` header
8. If the settlement code uses the engine-stored version (no spec_hash), the seller signature is valid but the buyer signature is INVALID
9. But what if settlement code only checks seller signature? No — `verifyQuote` checks both.

So this is a denial-of-service against the commitment flow, not a money theft. But it reveals a deeper issue: **the engine is a trusted intermediary for quote bytes**. If the engine is compromised, it can serve different canonical bytes to buyer and seller, causing signature mismatch.

**The REAL exploit leveraging this:**

The plan says: "Client-side quote verification (documented contract): buyer MUST locally reconstruct the expected unsigned quote." If the engine adds a field that the buyer doesn't expect (like injecting `extensions` into the quote), and the buyer's reconstruction doesn't include it, the buyer will reject the quote — denial of service.

But if the buyer's reconstruction DOES include it (because the buyer trusts the engine's response), the buyer signs bytes that include attacker-controlled extension data. The extension data is semantically meaningless to the protocol but becomes part of the signed commitment. A seller or third party could later claim the buyer "agreed" to the extension terms.

**Current plan defense:** Client-side verification is "documented contract, not enforced by engine." Most agent implementations will trust the engine.

**Verdict:** The engine acts as a quote construction oracle. No defense against a compromised engine except client-side verification, which is advisory only. Medium-high risk.

---

### RT2-C4: normalizeAmount Truncation Exploit [HIGH]

**Attack goal:** Create a valid-looking price that normalizes to a different integer than expected, enabling underpayment.

**Attack path:**

Look at `normalizeAmount()` in `packages/core/src/amounts.ts`:

```typescript
// Pad or truncate fractional part to exactly `decimals` digits
if (fracPart.length < decimals) {
  fracPart = fracPart.padEnd(decimals, "0")
} else {
  fracPart = fracPart.slice(0, decimals)  // TRUNCATION!
}
```

USDC has 6 decimals. If the attacker sends a price of `"28.5000009"` (7 fractional digits), `normalizeAmount` truncates to `"28.500000"` = 28500000. The validator `isValidDecimalPositive` uses `Decimal.js` which treats `"28.5000009"` as > 28.500000. So the price field shows 28.5000009 but the normalized amount is 28.500000.

**The exploit chain:**

1. Seller submits offer with price `"28.5000009"`
2. Schema validation: `isValidDecimalPositive("28.5000009")` returns TRUE (valid positive decimal)
3. Buyer accepts this offer
4. Engine calls `buildUnsignedQuote()` with `final_price: "28.5000009"`
5. Quote is signed by both parties with `final_price: "28.5000009"` in canonical JSON
6. At settlement, seller runs `normalizeAmount("28.5000009", USDC_MINT)` = 28500000 (truncated)
7. The Solana transaction pays 28500000 micro-USDC = $28.50, not $28.5000009
8. But both parties signed a quote saying `"28.5000009"` — the payment is technically SHORT by 0.0000009 USDC

This difference is negligible for one transaction. But the real exploit is the REVERSE:

1. Buyer's strategy sees `"28.999999999"` and thinks the price is ~$29
2. `normalizeAmount("28.999999999")` = 28999999 (truncated from 9 fractional digits to 6) = $28.999999
3. Buyer pays $28.999999, which is 0.000001 less than the "agreed" $29

Again tiny. But the more dangerous scenario:

**Different truncation behavior between buyer and seller implementations:**

If the buyer's `normalizeAmount` implementation rounds instead of truncates, and the seller's truncates, they'll compute different expected payment amounts. The buyer pays (rounded up) while the seller expects (truncated down) — buyer overpays. Or vice versa.

The spec says "MUST use integer arithmetic on the decimal string" but doesn't specify truncation vs. rounding behavior. The implementation truncates silently.

**More dangerous:** If a price like `"0.0000001"` (below minimum representable) is used:
- `isValidDecimalPositive("0.0000001")` returns TRUE
- `normalizeAmount("0.0000001", USDC_MINT)` = 0 (truncated to 0 micro-USDC)
- This creates a valid quote with `final_price: "0.0000001"` that requires ZERO payment

**Exact HTTP sequence:**

```
POST /rfqs/:id/offers
Body: { "price": "0.0000001", ... valid fields ... }
```

The offer passes validation (positive decimal). If the buyer accepts, the quote `final_price` is "0.0000001", but normalization produces 0. Settlement requires 0 USDC payment.

**Prerequisites:** Valid seller keypair.

**Expected outcome:** Free service via sub-micro-unit pricing.

**Current plan defense:** `isValidDecimalPositive` only checks `> 0`. No minimum amount enforcement. `normalizeAmount` truncates without error.

**Verdict:** VULNERABLE. The engine must validate that `normalizeAmount(price) > 0` for all prices, not just that the decimal string is positive.

---

### RT2-H2: offer.valid_until Expiry Window Exploitation [HIGH]

**Attack goal:** Lock in an offer whose terms the seller intended to be temporary.

**Attack path:**

An offer's `valid_until` is checked at two points: (1) offer submission (`isFutureISO`), and (2) accept time (plan Step 8: "Verify the referenced offer ... `valid_until` is still in the future").

But what about between accept and cosign? The flow is:

```
T=0:    Offer submitted with valid_until = T+30s
T=25s:  Buyer accepts (valid_until is T+30s, still future) → COMMIT_PENDING
T=31s:  Seller reads quote via GET /quote — offer has now expired
T=45s:  But the QUOTE doesn't have the offer's valid_until — it has its own expires_at
T=60s:  Seller cosigns the quote
```

The offer expired at T+30s, but the acceptance at T+25s locked in the price. The quote's `expires_at` is calculated from `input.expires_seconds`, which is independent of the offer's `valid_until`. So a buyer can accept an offer 1 millisecond before it expires and have 60+ seconds to complete the commitment flow.

**Why is this bad?** Sellers use short `valid_until` windows to limit their exposure. If the seller set `valid_until = +30s` intending that the price is only valid for 30 seconds, but the buyer accepts at second 29 and the commitment flow takes 60 more seconds, the seller is locked into a price for 90 seconds total — 3x their intended exposure.

**More aggressive variant:** Seller offers at $30 with `valid_until = +10s` (flash offer). Buyer's strategy detects this is a good price, accepts at second 9.999. Seller cannot withdraw the offer during COMMIT_PENDING. The commitment timeout is 60 seconds. Seller is locked for potentially 60 seconds on a price they intended to be available for only 10 seconds.

**Prerequisites:** Buyer agent with low-latency acceptance.

**Expected outcome:** Seller locked into expired offer terms for the duration of the commitment timeout.

**Current plan defense:** Accept checks `valid_until` is future. But once accepted, the offer's `valid_until` becomes irrelevant. The plan does not re-validate `valid_until` during cosign.

**Verdict:** By design (offer lock-in at accept time is standard), but the interaction with the 60s commitment timeout amplifies seller exposure beyond their stated `valid_until`. Consider adding offer_expiry as a field in the quote so the seller can see the original window.

---

## Attack Category 3: Information Leakage (New Vectors)

### RT2-C5: Role-Scoped View Bypass via EventStore Interface Boundary [CRITICAL]

**Attack goal:** Seller reads events intended for other sellers or the buyer's private negotiation state.

**Attack path:**

The plan specifies `filterEventsForRole(events, callerDid, rfq)` as the privacy boundary. But the EventStore interface is defined as:

```typescript
interface EventStore {
  append(rfqId: string, event: NegotiationEvent): void
  getEvents(rfqId: string, afterId?: number): NegotiationEvent[]  // Returns ALL events
  subscribe(rfqId: string, listener: (event: NegotiationEvent) => void): () => void
  size(rfqId: string): number
}
```

Notice: `getEvents()` returns ALL events for an RFQ, and `subscribe()` notifies on ALL new events. The role filtering is applied AFTER retrieval, in the route handler.

**Attack vector 1: SSE subscription leaks**

The SSE subscription mechanism calls `eventStore.subscribe(rfqId, listener)`. When a new event is appended (e.g., a counter to a different seller), the listener fires for ALL subscribers. If the route handler's SSE code forwards the event to all connected SSE clients BEFORE applying role filtering, every seller sees every event.

The implementation must be: subscribe -> event arrives -> filter for this subscriber's role -> THEN send. But the plan's EventStore interface gives no role-awareness to the subscription. The filtering must happen in the SSE route's listener callback. If the implementer forgets to filter in the callback (or filters incorrectly), all events leak.

**Attack vector 2: Race between getEvents() and filterEventsForRole()**

If the implementation does:
```typescript
const events = eventStore.getEvents(rfqId, afterCursor)
const filtered = filterEventsForRole(events, callerDid, rfq)
return json(filtered)
```

Between `getEvents` and the filter, if the event objects are mutable (shared references), another request could modify the event objects. In JavaScript, array elements are references. If `getEvents` returns references to the internal event array (not copies), and another concurrent handler modifies an event's fields, the filter might see inconsistent data.

But the plan uses per-session locks, so concurrent modification within a session is prevented. However, the `getEvents` call might happen OUTSIDE the lock (it's a read operation), while an `append` happens inside the lock. If `getEvents` is not protected by the lock, it could read a partially-appended event.

**Attack vector 3: Cursor-based leak**

Even with opaque UUID cursors, the `afterId` parameter in the internal EventStore interface uses integer IDs. If the SSE route translates UUID cursors back to internal integer IDs, and the mapping is stored in memory, an attacker who causes many events might observe the mapping behavior through timing.

More concretely: if the cursor UUID -> internal ID mapping is a simple `Map<string, number>`, and the attacker provides a UUID that doesn't exist, the error response timing reveals whether the map is large (many events) or small.

**Prerequisites:** Valid seller keypair with SSE connection.

**Expected outcome:** If SSE callback doesn't filter, seller sees all events (counters to other sellers, buyer's acceptance decisions).

**Current plan defense:** The plan describes `filterEventsForRole()` but the EventStore interface has no built-in role awareness. The defense relies entirely on correct application of the filter at every read point.

**Verdict:** The interface boundary is dangerous. A single missed filter application leaks everything. The plan should specify that the EventStore interface ITSELF accepts a role parameter, so it's impossible to get unfiltered events.

---

### RT2-H3: Error Code Oracle for Session State Probing [HIGH]

**Attack goal:** Determine the exact state of a session without having access to the event stream.

**Attack path:**

The plan's validation order is:
1. Schema validation -> 400
2. Field checks -> 422
3. Authorization -> 422
4. Signature verification -> 401
5. State guard -> 409

But the plan also says: "Signature verification runs BEFORE state guard (per Spec). This prevents unauthenticated actors from probing session state via error code differences."

However, this defense is incomplete. Consider an attacker with a valid keypair (trivial to generate) who is NOT a participant in the session:

```
POST /rfqs/:id/counter
Body: { valid counter schema, from: attacker_did, valid signature }
```

Step 6 checks `counter.from === rfq.buyer`. If the attacker is not the buyer, they get `422 unauthorized_counter`. This happens BEFORE the state check (step 9). So the attacker always gets `422` regardless of state — no leak.

But now consider:

```
POST /rfqs/:id/offers
Body: { valid offer, seller: attacker_did, valid signature }
```

Steps 1-6 pass (schema, field checks, signature). Step 7: state check. If state is `OPEN` or `NEGOTIATING`, it succeeds. If state is `COMMIT_PENDING`, `COMMITTED`, `EXPIRED`, or `CANCELLED`, it returns `409`.

So an attacker with a valid keypair can distinguish between active states (OPEN/NEGOTIATING) and terminal/locked states (everything else) by submitting a cheap offer and checking the response code. This is a legitimate operation (anyone can submit an offer), but it reveals state information to non-participants.

**More refined probing:**

- If state is OPEN: submit offer -> 201. (Also transitions to NEGOTIATING)
- If state is NEGOTIATING: submit offer -> 201.
- If state is COMMIT_PENDING: submit offer -> 409.
- If state is terminal: submit offer -> 409.

To distinguish COMMIT_PENDING from terminal: submit the same offer_id again after getting 409. If the session is COMMIT_PENDING and later rolls back to NEGOTIATING (timeout), the second attempt will get 201. If terminal, it stays 409.

**Combined with per-session offer cap (50 total):** The attacker consumes offer slots to probe state. After 50 probes, the session's offer slots are exhausted, griefing real sellers. But only 5 per DID, so 10 DIDs needed.

**Prerequisites:** 10 valid keypairs (trivial).

**Expected outcome:** Attacker knows when a buyer has selected a winner (COMMIT_PENDING), giving competitive intelligence about buyer decisions.

**Current plan defense:** Signature before state prevents unauthenticated probing. But any authenticated actor can probe via offer submission. The per-session offer cap limits but doesn't prevent it.

**Verdict:** Partial leak. Not catastrophic but reveals buyer's accept/commit decisions to non-participants.

---

### RT2-H4: Timing Oracle on ZK Proof Verification [HIGH]

**Attack goal:** Determine whether a counter-offer included a ZK proof (revealing that the RFQ has a budget_commitment).

**Attack path:**

Counter verification step 7 is ZK proof verification (~50ms). Steps 1-6 are field checks (~1ms total). If an RFQ has `budget_commitment`, counter verification takes ~51ms. If not, it takes ~1ms.

An observer who can measure response times to `POST /counter` can determine:
- Fast response (< 5ms) = no budget_commitment on this RFQ
- Slow response (~50ms) = budget_commitment present

But only the buyer can submit counters. So this requires the buyer to be compromised.

**However**, the SSE timing side-channel (acknowledged in v1) has a new variant: when the buyer submits a counter WITH a ZK proof, the event delivery to the SSE subscriber (the seller) is delayed by the ~50ms ZK verification time. When the buyer submits a counter WITHOUT proof, the event arrives faster.

The seller can compare event arrival times across different RFQs by the same buyer to determine which RFQs use budget_commitment. This is meta-information about the buyer's privacy preferences.

**Prerequisites:** Seller with SSE connection to multiple sessions involving the same buyer.

**Expected outcome:** Seller learns which of the buyer's RFQs use ZK proofs and which don't, revealing the buyer's privacy strategy.

**Current plan defense:** No mitigation. ZK verification is synchronous in the handler.

**Verdict:** Minor information leak about buyer privacy preferences. Mitigate by adding consistent-time processing (always delay counter responses to max expected ZK time).

---

## Attack Category 4: Denial of Service (New Vectors)

### RT2-C6: InMemoryEventStore Map.get() Prototype Pollution [CRITICAL]

**Attack goal:** Corrupt the EventStore's internal Map via prototype pollution.

**Attack path:**

If the `rfq_id` is used as a Map key via `Map.get(rfq_id)`, this is safe against prototype pollution (Map keys don't use prototype chain). But if ANY code path uses a plain object as a lookup table (e.g., `sessions[rfq_id]`), an attacker can submit:

```
POST /rfqs
Body: {
  "rfq_id": "__proto__",
  "protocol": "ghost-bazaar-v4",
  "buyer": "did:key:z6MkAttacker",
  ...
}
```

Or `rfq_id: "constructor"`, `rfq_id: "toString"`, etc.

The UUID v4 format check (`isUuidV4()`) requires the format `xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx`. This DOES block `__proto__` and other prototype names because they don't match the UUID regex. So prototype pollution via `rfq_id` is blocked.

But what about the `envelope_id` in signed control envelopes? The plan says `envelope_id` is a UUID v4. If the implementation validates UUID format, this is safe. If it doesn't, an attacker could submit `envelope_id: "__proto__"` and corrupt the tombstone set if it's a plain object instead of a Set or Map.

**Prerequisites:** Implementation uses plain objects for lookups instead of Map/Set.

**Expected outcome:** Prototype pollution corrupts internal data structures. In the worst case, `hasOwnProperty` checks are bypassed, allowing duplicate envelope replay.

**Current plan defense:** UUID validation on rfq_id. But envelope_id validation is not explicitly specified beyond "UUID v4" — the validator must enforce the format.

**Verdict:** Depends on implementation. If all IDs are UUID-validated and Maps/Sets are used instead of plain objects, this is safe. Plan should explicitly require Map/Set for all lookup tables.

---

### RT2-H5: EventStore.subscribe() Memory Leak via Phantom Sessions [HIGH]

**Attack goal:** Exhaust memory via accumulated SSE listener closures that are never cleaned up.

**Attack path:**

The EventStore interface has `subscribe()` which returns an unsubscribe function. The SSE route calls `subscribe()` when a client connects and should call the unsubscribe function on disconnect.

But consider: what happens when a session is pruned (60-minute retention after terminal state)?

```
1. Seller connects SSE to session X
2. Session X reaches COMMITTED
3. 60 minutes later, deadline enforcer prunes session X
4. Session X is removed from the sessions Map
5. But the SSE connection is still open (the seller never disconnected)
6. The EventStore has been pruned, but the subscribe listener closure still holds a reference to the old event array
```

In JavaScript, if the `subscribe()` listener captures the event array via closure, and the session is pruned from the Map, the listener closure prevents garbage collection of the event array. Over time, thousands of pruned sessions with lingering SSE connections keep all their events in memory.

**More aggressive:** An attacker opens SSE connections to many sessions, never disconnects, and lets the sessions expire. Each connection holds a closure reference to the session's events. With 1000 sessions averaging 100 events, that's 100,000 events kept alive via closure references.

**Prerequisites:** Ability to open many SSE connections (the plan mentions no SSE connection limit per client).

**Expected outcome:** Gradual memory exhaustion as pruned session data is retained by SSE closure references.

**Current plan defense:** "Client disconnect cleanup" and "Remove subscriber from listener set." But this only cleans up when the CLIENT disconnects. If the client stays connected, the listener persists. Session pruning must also terminate associated SSE connections.

**Verdict:** VULNERABLE. Session pruning must forcibly close all SSE connections associated with the pruned session and call all unsubscribe functions.

---

### RT2-H6: Lock Queue Amplification via Multi-Session Orchestrated Starvation [HIGH]

**Attack goal:** Make the engine unresponsive by saturating ALL session lock queues simultaneously.

**Attack path:**

The plan bounds each session's lock queue to 10. But there's no bound on the number of active sessions. An attacker can:

1. Create 100 RFQ sessions (at 10 RFQs/min per DID, using 10 DIDs = 100 RFQs/min)
2. For each session, send 10 concurrent offer requests = 1000 total requests
3. Each session's lock queue is at capacity (10 each)
4. Every request takes the lock for the duration of validation (~1-50ms depending on ZK)
5. The node.js event loop is processing 1000 requests concurrently

The per-session lock prevents race conditions WITHIN a session, but 100 sessions running in parallel means 100 concurrent validation operations. If each involves ZK verification (~50ms synchronous), that's 100 * 50ms = 5 seconds of CPU time blocked.

But more insidiously: the 5-second lock timeout means each of the 10 queued requests per session waits up to 5 seconds. That's 100 sessions * 10 requests * 5 seconds = 5000 request-seconds of server time consumed.

Meanwhile, legitimate sessions' requests are competing for CPU time. The deadline enforcer (running on setInterval) is delayed because the event loop is saturated.

**Prerequisites:** 10 valid keypairs for RFQ creation. 100 additional keypairs for offers. Total: 110 keypairs (~trivial).

**Expected outcome:** Engine becomes unresponsive for 5+ seconds. Deadline enforcer misses cycles. Legitimate sessions may time out.

**Current plan defense:** Per-session lock queue (10), per-IP rate limit (100 req/min). But 1000 requests from a single IP at 100/min would take 10 minutes. However, using multiple IPs (trivial with cloud infrastructure) bypasses per-IP limits entirely.

**Verdict:** No global concurrency bound. The plan needs a global maximum concurrent requests limit (e.g., 200 total in-flight requests across all sessions).

---

## Attack Category 5: Registry Integration Exploits

### RT2-H7: 8004 Registry SSRF via listing-enricher.ts [HIGH]

**Attack goal:** Use the engine's `GET /listings` enrichment to make server-side requests to internal services.

**Attack path:**

The plan says: "All registry-returned data (name, uri, scores) is sanitized — strip HTML, validate URL format, clamp scores to 0-100 range. Prevents SSRF/injection from malicious registry entries."

But the `discoverAgent()` function in `packages/agents/src/registry.ts` calls `sdk.loadAgent(agentId)` which fetches the agent's IPFS URI. The `agent_uri` field is an IPFS URI (`ipfs://...`). The enricher would need to resolve this URI to get the full registration file.

If the IPFS resolution is handled by a gateway (e.g., `https://gateway.pinata.cloud/ipfs/<CID>`), the engine makes an outbound HTTP request to the IPFS gateway. But what if the `agent_uri` is NOT an IPFS URI but a malicious URL? The 8004 registry stores whatever URI the registering agent provided.

If the enricher blindly fetches `agent.uri` to resolve the registration file, and the URI is `http://169.254.169.254/latest/meta-data/` (AWS metadata endpoint), the engine makes a request to the internal metadata service.

**Exact flow:**

```
1. Attacker registers agent in 8004 registry with uri: "http://169.254.169.254/latest/meta-data/iam/security-credentials/"
2. Legitimate buyer calls GET /listings
3. Engine calls discoverAgent(attacker_agent_id)
4. discoverAgent calls sdk.loadAgent() which reads the uri from on-chain
5. If the enricher subsequently fetches the URI to extract endpoint data → SSRF
```

The current `discoverAgent()` code does NOT fetch the URI — it just returns it. But the `listing-enricher.ts` (not yet implemented) might fetch it to extract additional metadata.

**Prerequisites:** Ability to register an agent in the 8004 registry with a malicious URI (requires on-chain transaction, costs SOL).

**Expected outcome:** If the enricher fetches the URI, SSRF against internal services. If it only returns the URI string, no SSRF but the malicious URI is exposed to buyers.

**Current plan defense:** "Sanitize — validate URL format." But URL format validation alone doesn't prevent SSRF (e.g., `http://10.0.0.1/admin` is a valid URL). Need a URI allowlist (only `ipfs://` prefix allowed).

**Verdict:** Plan mentions sanitization but not SSRF-specific defenses. Recommend: only allow `ipfs://` URIs from registry data; reject all `http://` and `https://` URIs.

---

### RT2-H8: Registry Reputation Score Manipulation for Unfair Advantage [HIGH]

**Attack goal:** Inflate reputation scores to appear as a trusted seller, then exploit the trust.

**Attack path:**

The ATOM reputation engine allows any agent to give feedback to any other agent. The `recordDealFeedback()` function requires a signer keypair and the counterparty's agent ID. There's no verification that a deal actually occurred between the two parties.

An attacker can:

1. Register two agents: Agent A (attacker seller) and Agent B (shill)
2. Agent B gives score=100 feedback to Agent A — no actual deal needed
3. Repeat with Agents C, D, E... all giving 100 scores to Agent A
4. Agent A now has high `reputationScore` and many `totalFeedbacks`
5. When `GET /listings` enriches Agent A's listing, it shows high reputation
6. Buyer's strategy trusts Agent A (high rep) and accepts their offer
7. Agent A then griefs (timeout on cosign, or provides bad service)

The 8004 registry's ATOM engine may have on-chain protections (e.g., requiring both parties to have a deal receipt PDA). But the current code shows `sdk.giveFeedback(counterpartyAgentId, { score, ... })` with no deal verification.

**Prerequisites:** Multiple Solana keypairs (trivial), SOL for transaction fees (cheap on devnet).

**Expected outcome:** Inflated reputation scores mislead buyer strategies into trusting malicious sellers.

**Current plan defense:** The plan mentions "8004 Agent Registry for Sybil-resistant discovery" but the ATOM feedback mechanism has no deal-binding. Scores can be manufactured.

**Verdict:** Registry reputation is unverified. Buyer strategies should NOT use reputation score as the sole trust signal.

---

## Attack Category 6: Chained Exploits (New)

### Chain-4: Extension Injection + Quote Construction + Settlement = Payment Theft

**Steps:**

1. Attacker registers as a seller with a valid listing (payment_endpoint: `https://legit.com/execute`)
2. Attacker submits offer with `extensions: { "ghost-bazaar:quote:payment_endpoint": "https://evil.com/drain" }`
3. Engine stores the offer event with full payload including extensions (plan says "preserve extensions")
4. Buyer accepts the attacker's offer
5. Engine calls `buildUnsignedQuote()` — sources `payment_endpoint` from the original Listing (defense from RT-C1)
6. Quote has correct `payment_endpoint: "https://legit.com/execute"`
7. **BUT**: the extensions from the offer are preserved in the event log
8. If any downstream system (analytics, display, settlement) reads the extension field thinking it's an override → payment redirected

**Verdict:** The `payment_endpoint` provenance defense blocks the direct attack. But extensions create a secondary channel for injecting conflicting values. The engine should reject any extension key in the `ghost-bazaar:` reserved namespace that shadows a real protocol field. **Medium risk** — requires a bug in downstream code to exploit.

---

### Chain-5: normalizeAmount(0) + Budget Proof + Free Service

**Steps:**

1. Buyer creates RFQ with `budget_commitment` (valid Poseidon commitment)
2. Buyer sends counter with `price: "0.0000001"` to a seller
3. Counter passes `isValidDecimalPositive("0.0000001")` — TRUE
4. Budget proof: `counter_price_scaled` = `normalizeAmount("0.0000001", USDC_MINT)` = 0
5. ZK proof proves `0 <= budget_hard_scaled` — trivially true for any budget_hard > 0
6. Counter passes ZK verification
7. But wait — step 7b computes `expected_scaled = normalizeAmount(counter.price, mint)` = 0
8. Step 7c checks `counter.budget_proof.counter_price_scaled === expected_scaled` → `"0" === "0"` → TRUE
9. Counter is accepted as valid
10. If the seller accepts this counter (unlikely but possible if seller's strategy is buggy), the quote `final_price` is "0.0000001"
11. Settlement: `normalizeAmount("0.0000001")` = 0 → buyer pays 0 USDC
12. Seller executes service for free

**Verdict:** The chain works end-to-end IF the seller accepts the absurd price. The engine doesn't validate minimum price at the counter or accept level. **High risk** — engine should enforce `normalizeAmount(price) > 0` at counter and accept time.

---

### Chain-6: SSE Reconnect Storm + Session Lock Saturation = Deadline Bypass

**Steps:**

1. Attacker opens 10 SSE connections to the same session
2. Attacker repeatedly disconnects and reconnects all 10 (rapid reconnect storm)
3. Each SSE reconnect sends `Last-Event-ID` → handler must look up cursor, acquire session state
4. If SSE reconnect processing requires the session lock, each reconnect consumes a lock queue slot
5. With 10 connections reconnecting rapidly, the lock queue (max 10) is saturated
6. The deadline enforcer cannot acquire the lock (queue full → 429 or 5s wait)
7. Session should expire but doesn't — deadline enforcer is locked out
8. Attacker's partner (a buyer) submits a last-second accept that should be rejected

**Prerequisites:** SSE reconnect must acquire session lock (if it reads events via getEvents + filter within the lock). If SSE reads are lock-free, this chain fails.

**Expected outcome:** Deadline enforcer is starved, allowing post-deadline operations.

**Current plan defense:** Lock queue bound of 10, 5s timeout. If SSE reconnects are read-only and don't require the lock, the chain fails. The plan does not specify whether SSE reads acquire the lock.

**Verdict:** Depends on implementation. If SSE reads are lock-free (as they should be for read operations), this is mitigated. But the plan should explicitly specify that `getEvents()` is a lock-free read. **Medium risk.**

---

## Summary of New Findings

| ID | Severity | Category | Title | Plan Defends? |
|----|----------|----------|-------|---------------|
| RT2-C1 | CRITICAL | State | Extension/unknown field injection into deriveState() reducer | NO — no payload sanitization specified |
| RT2-C5 | CRITICAL | Privacy | Role-scoped view bypass via EventStore subscribe() leak | PARTIAL — filter exists but not at interface level |
| RT2-C4 | HIGH | Financial | normalizeAmount truncation to zero enables free service | NO — no minimum normalized amount check |
| RT2-C2 | HIGH | State | Post-deadline commitment via sign/cosign not re-checking deadline | NO — sign/cosign only check state, not deadline |
| RT2-C3 | HIGH | Financial | Quote field manipulation via canonicalJson null/undefined ambiguity | PARTIAL — client-side verification is advisory |
| RT2-H1 | HIGH | Fairness | Predictable session_revision enables pre-staged accepts | PARTIAL — CAS exists but revision is predictable |
| RT2-H2 | HIGH | Fairness | Offer valid_until not re-checked during commitment window | BY DESIGN but amplified by 60s timeout |
| RT2-H3 | HIGH | Privacy | Error code oracle reveals session state to non-participants | PARTIAL — sig-before-state helps but offers still probe |
| RT2-H4 | HIGH | Privacy | ZK verification timing reveals budget_commitment presence | NO — synchronous ZK in handler |
| RT2-H5 | HIGH | DoS | SSE closure memory leak on pruned sessions | NO — pruning doesn't close SSE connections |
| RT2-H6 | HIGH | DoS | Multi-session lock queue saturation | NO — no global concurrency limit |
| RT2-H7 | HIGH | SSRF | Registry URI fetching enables SSRF | PARTIAL — sanitization mentioned, no URI prefix restriction |
| RT2-H8 | HIGH | Fairness | Reputation score inflation via unverified feedback | NO — no deal-binding for feedback |
| Chain-4 | MEDIUM | Financial | Extension injection for downstream payment redirection | PARTIAL — direct path blocked, extension path open |
| Chain-5 | HIGH | Financial | Zero-amount payment via sub-micro-unit pricing | NO — no minimum normalized amount |
| Chain-6 | MEDIUM | DoS | SSE reconnect storm starves deadline enforcer | DEPENDS on implementation |

---

## Recommended Priority Fixes

### Must Fix (Before Implementation)

1. **Payload sanitization in EventStore events** (RT2-C1): When appending events, extract only the typed, known fields from the request body. NEVER store raw request body as event payload. Reject or strip unknown top-level fields from protocol objects.

2. **Minimum normalized amount validation** (RT2-C4, Chain-5): After any price field passes `isValidDecimalPositive`, also verify `normalizeAmount(price, mint) > 0n`. Reject prices that normalize to zero. This should be a shared utility used by counter validation, offer validation, and accept validation.

3. **Deadline re-check in sign and cosign handlers** (RT2-C2): Both `PUT /quote/sign` and `PUT /cosign` must verify `Date.now() < rfq.deadline` in addition to checking `state === COMMIT_PENDING`. A post-deadline cosign should fail with `409 expired`.

4. **Role-aware EventStore interface** (RT2-C5): Modify the EventStore interface to accept a `callerRole` parameter on `getEvents()` and `subscribe()`. Make it impossible to retrieve unfiltered events. The filter should be at the interface layer, not application layer.

5. **Session pruning closes SSE connections** (RT2-H5): When a session is pruned, the engine must call all registered unsubscribe functions AND send an SSE close event to all connected clients. The deadline enforcer pruning sweep must include SSE cleanup.

### Should Fix

6. **Reserved extension namespace enforcement** (Chain-4): Reject any extension key that starts with `ghost-bazaar:` and matches a protocol field name (e.g., `ghost-bazaar:quote:payment_endpoint`, `ghost-bazaar:internal:state`). Only the protocol itself should use the `ghost-bazaar:` namespace.

7. **Cryptographic session_revision** (RT2-H1): Replace the event-count-based session_revision with a hash of the latest event (e.g., `sha256(latest_event_canonical_json)`). This makes the revision unpredictable after a timeout, preventing pre-staged accepts.

8. **Global concurrency limit** (RT2-H6): Add a global semaphore limiting total in-flight requests to a configurable maximum (e.g., 200). Requests beyond this limit get `503 Service Unavailable`. This caps CPU usage regardless of session count.

9. **URI prefix allowlist for registry data** (RT2-H7): Only allow `ipfs://` URIs from registry data. Strip or reject any `http://`, `https://`, `ftp://`, or `file://` URIs returned by the 8004 registry.

10. **Consistent-time counter processing** (RT2-H4): Add a minimum processing delay to counter responses (e.g., always wait at least 60ms before returning, regardless of whether ZK verification ran). This prevents timing oracles.

### Document (Risk Accepted)

11. **Error code state probing** (RT2-H3): Document that any authenticated agent can determine whether a session is in an active state by submitting an offer. This is inherent to the protocol's open-offer model.

12. **Offer valid_until amplification** (RT2-H2): Document that accepting an offer 1ms before its `valid_until` locks the offer for up to `commitment_timeout` seconds. Seller strategies should account for this when setting `valid_until`.

13. **Reputation score trustworthiness** (RT2-H8): Document that 8004 ATOM reputation scores are not deal-verified and can be inflated via shill feedback. Buyer strategies should use reputation as one signal among many, not the sole trust indicator.

---

## Final Verdict

The v1 audit patches are solid and close the most obvious attack vectors. However, this v2 audit reveals **deeper architectural gaps** that the patches don't address:

1. **The EventStore interface is a trust boundary that leaks.** The interface returns raw unfiltered data, and privacy depends on every consumer correctly applying `filterEventsForRole()`. A single missed filter call exposes all negotiation data. Moving the filter INTO the interface is the only reliable fix.

2. **The reducer/state derivation is vulnerable to field injection.** Without strict payload typing, attackers can inject fields into events that confuse state derivation. The plan treats events as bags of data without specifying which fields are extracted.

3. **Price normalization has a zero-truncation vulnerability.** The `normalizeAmount` function silently truncates sub-micro-unit values to zero, enabling zero-payment exploits. This is a critical financial vulnerability.

4. **Post-deadline commitment is possible.** The sign and cosign handlers don't re-check `rfq.deadline`, only session state. A fast buyer+seller pair can complete commitment after the deadline has passed, bypassing the session's temporal boundary.

**Bottom line:** The v1 patches handle the outer attack surface (rate limiting, offer caps, envelope nonces). But the v2 vectors exploit the INNER interfaces — the EventStore abstraction, the state reducer's data handling, and the price normalization boundary. These require surgical fixes at the interface layer, not additional middleware.
