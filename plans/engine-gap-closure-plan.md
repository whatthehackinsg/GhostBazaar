# Plan: Engine Gap Closure — Real Seller Onboarding, Registry Wiring, and Remaining Duty 2 Engine Work

> Status: Phase 1-5.1 implemented; Phase 6-7 planned
> Priority: P0
> Scope: non-UI engine work only

## Goal

Close the remaining engine-layer gaps that are still hand-engineered, partially wired, or only documented:

1. seller listing registration is missing
2. multi-listing sellers are not supported
3. 8004 discovery is only an optional hook, not real runtime wiring
4. buyer strategy does not receive or use registry reputation data
5. cancel exists in lower layers but has no HTTP route
6. listings are not durable resources
7. Step 13 lacks dedicated route tests

This plan intentionally excludes frontend/dashboard rendering work.

## Design Principles

- Keep write-route auth consistent: use signed request bodies, not header auth shortcuts.
- Make listing provenance explicit and signed. Do not infer critical routing from seller DID alone.
- Do not pretend 8004 is integrated until seller DID to agent identity binding is verifiable at runtime.
- Do not ship seller onboarding as an in-memory demo-only feature.
- Close the loop with dedicated tests for every new route and integration point.

## Ordered Implementation Plan

## Dependency Map

- Phase 1 is the storage and contract foundation.
- Phase 2 depends on Phase 1.
- Phase 3 depends on Phases 1-2.
- Phase 4 depends on Phase 1 and should ideally land after Phase 2.
- Phase 5 depends on Phase 4 and is the only phase that is not engine-only.
- Phase 5.1 is a required hardening pass over Phases 1-5 before Phase 6.
- Phase 6 is engine-only and can land after core protocol work is stable.
- Phase 7 closes coverage and docs after the behavior is real.

## Canonical Checklist

Use this as the “do not lose it again” checklist.

- [x] Phase 1: durable listing persistence + signed registration contract
- [x] Phase 2: `POST /listings`
- [x] Phase 3: multi-listing seller support
- [x] Phase 4: real 8004 discovery wiring
- [x] Phase 5: buyer strategy reputation inputs
- [x] Phase 5.1: hardening patch for listing integrity, seed safety, and price-first buyer behavior
- [ ] Phase 6: buyer cancel HTTP route
- [ ] Phase 7: dedicated Step 13 tests + cleanup

### Phase 1: Durable Listing Model + Signed Registration Contract

Create the contract that all later phases build on.

Execution rule:

- **Phase 1 must be test-first.**
- No production implementation starts until the targeted persistence tests exist
  and are observed failing for the correct reason.

Design:

- Add `SignedListingRegistration` in `@ghost-bazaar/core`:
  - `Listing`
  - `signature: string`
  - optional `registry_agent_id?: string`
- Keep the stored listing unsigned; never persist or echo the signature.
- Add durable listing persistence in engine using SQLite, not process memory only.
- Persist `registry_agent_id` alongside the listing as nullable metadata.

Why first:

- `POST /listings` is not a real feature if listings disappear on restart.
- Real 8004 wiring needs a place to store a verified `agent_id` binding.

Expected engine changes:

- new SQLite-backed listing store or repository
- startup load from SQLite into the runtime listing index
- seed listings inserted only when absent, not blindly treated as the only source of truth

Acceptance criteria:

- listings survive restart
- listing count reflects persisted + seed listings
- store supports `getById`, `getAll`, `filterByServiceType`, `findAllBySeller`, `findBySellerAndId`

Concrete deliverables:

- a listing persistence abstraction in engine
- one SQLite-backed implementation used by `server.ts`
- optional in-memory implementation preserved for isolated tests if useful
- schema for persisted listing metadata, including nullable `registry_agent_id`

Preferred implementation shape:

- keep event storage and listing storage separate
- do **not** overload `SqliteEventStore` with listing concerns
- introduce a dedicated listing repository / store layer for clarity

Files likely touched:

- `packages/core/src/schemas.ts`
- `packages/engine/src/registry/listing-store.ts`
- `packages/engine/src/registry/*` for a new SQLite-backed store or repository
- `packages/engine/src/server.ts`
- new tests under `packages/engine/tests`

Test design first:

Recommended initial test file:

- `packages/engine/tests/listing-persistence.test.ts`

Tests to write before implementation:

1. `persists listings across repository reopen`
   - add a listing
   - close/recreate the SQLite-backed listing repository
   - expect `getById()` and `getAll()` to still return it
2. `preserves nullable registry_agent_id across reopen`
   - write one listing with `registry_agent_id`
   - write one listing without it
   - reopen repository
   - expect both rows to round-trip correctly
3. `findAllBySeller and findBySellerAndId work after restart`
   - persist multiple listings for one seller
   - reopen repository
   - expect both lookup methods to still behave correctly
4. `seed listings are inserted only when missing`
   - bootstrap empty durable store with seed enabled
   - restart bootstrap again
   - expect no duplicated seeded rows
5. `listing count reflects durable state after startup`
   - persist at least one non-seed listing
   - start server/bootstrap path
   - expect health/stat listing count to reflect durable rows, not only seed assumptions
6. `in-memory test implementation matches repository contract`
   - if an in-memory listing implementation is kept for tests, ensure it matches the same external contract

Red phase expectation:

- before implementation, these tests should fail because no durable listing
  repository / bootstrap path exists yet
- failures must be “feature missing” failures, not malformed test harness failures

Checklist:

- [ ] design and add failing persistence tests first
- [ ] verify the new tests fail for the expected missing-feature reason
- [ ] decide and codify the listing persistence abstraction
- [ ] add SQLite schema for listings
- [ ] load persisted listings on startup
- [ ] seed demo listings only when absent
- [ ] make `/health` and dashboard listing count read from durable state
- [ ] verify restart persistence end to end

Verification:

- `pnpm --filter @ghost-bazaar/engine test -- tests/listing-persistence.test.ts`
- `pnpm --filter @ghost-bazaar/engine build`
- targeted listing persistence tests
- manual restart test: create listing, restart server, `GET /listings` still returns it

### Phase 2: `POST /listings` Route

Add real seller onboarding.

Execution rule:

- **Phase 2 must also be test-first.**
- Do not implement the route until the new route tests exist and fail for the
  expected missing-feature reason.

Design:

- Add `POST /listings`
- body must be a signed listing registration object
- validate shape first, then `preCheckSignatureFormat()`, then `verifySignature()`
- map storage errors into stable API errors:
  - `400 malformed_payload`
  - `401 invalid_seller_signature`
  - `409 duplicate_listing`
  - `422 invalid_listing`
  - `503 capacity_exceeded`
- return `201` with the stored unsigned listing payload

Important:

- no header-auth MVP shortcut
- no implicit registry enrichment side effects beyond storing verified optional `registry_agent_id`

Acceptance criteria:

- seller can create a listing over HTTP
- duplicate `listing_id` is rejected
- invalid signature is rejected
- listing count updates after successful registration

Concrete deliverables:

- `POST /listings`
- signed request-body validator
- deterministic error mapping for malformed, invalid, duplicate, and capacity cases

Files likely touched:

- `packages/core/src/schemas.ts`
- `packages/engine/src/routes/listings.ts`
- `packages/engine/src/middleware/validate-signature.ts` only if helper coverage must expand
- `packages/engine/src/server.ts`
- `packages/engine/tests/listings.test.ts`

Test design first:

Recommended initial test target:

- `packages/engine/tests/listings.test.ts`

Tests to write before implementation:

1. `POST /listings accepts a valid signed listing and returns 201`
   - send a valid signed body
   - expect `201`
   - expect response body to omit `signature`
   - expect `GET /listings/:id` to return the stored unsigned listing
2. `POST /listings rejects malformed JSON`
   - send invalid JSON
   - expect `400 malformed_payload`
3. `POST /listings rejects non-object bodies`
   - send scalar / array payloads
   - expect `400 malformed_payload`
4. `POST /listings rejects missing or malformed signature`
   - omit `signature` or send wrong format
   - expect `400 malformed_payload`
5. `POST /listings rejects invalid seller signature`
   - send a body signed by the wrong key
   - expect `401 invalid_seller_signature`
6. `POST /listings rejects invalid listing fields`
   - bad DID, non-HTTPS URL, empty required string, bad negotiation profile
   - expect stable validation error mapping (`422 invalid_listing` or more specific schema code if introduced)
7. `POST /listings rejects duplicate listing_id`
   - insert once, insert again with same `listing_id`
   - expect `409 duplicate_listing`
8. `POST /listings updates listing count`
   - after successful insert, expect listing count surfaces such as `/health`
     or route-visible store state to reflect the new durable row

Red phase expectation:

- before route implementation, the positive-path `POST /listings` test should fail
  because the route is missing
- failure mode should be “route not found / method not allowed” or equivalent
  missing-feature behavior, not broken fixtures or invalid signing helpers

Checklist:

- [ ] add failing `POST /listings` route tests first
- [ ] verify the new tests fail for the expected missing-feature reason
- [ ] define `SignedListingRegistration`
- [ ] validate plain-object body shape before signature verification
- [ ] verify seller signature against listing payload
- [ ] strip signature before persistence and response
- [ ] wire listing-count updates after successful insert
- [ ] confirm duplicate and invalid-signature error mapping
- [ ] keep GET listing routes behavior unchanged

Verification:

- `pnpm --filter @ghost-bazaar/engine test -- tests/listings.test.ts`
- targeted route cases for malformed, invalid-signature, duplicate, and success paths
- manual `curl` path: create listing then fetch it from `GET /listings`

### Phase 3: Multi-Listing Seller Support

Remove the current single-listing bottleneck.

Design:

- extend `SellerOffer` to require `listing_id`
- include `listing_id` in the canonical signed offer payload
- update `validateOffer()` so `listing_id` is required
- update `extractOfferFields()` in the offer route to include `listing_id`
- resolve provenance with `findBySellerAndId(sellerDid, listingId)`
- remove the current `ambiguous_listing` branch

Why after Phase 2:

- once sellers can self-register, the current single-listing assumption becomes a real blocker

Acceptance criteria:

- one seller DID can register multiple listings
- seller can submit an offer for a specific listing
- engine binds the accepted listing’s `payment_endpoint` deterministically

Concrete deliverables:

- upgraded `SellerOffer` schema
- upgraded offer signature binding
- removal of seller-DID-only provenance lookup

Files likely touched:

- `packages/core/src/schemas.ts`
- `packages/engine/src/routes/offers.ts`
- `packages/engine/src/state/session.ts` only if types need adjustment
- `packages/engine/tests/offers.test.ts`
- `packages/engine/tests/integration.test.ts`

Checklist:

- [ ] add `listing_id` to `SellerOffer`
- [ ] require `listing_id` in `validateOffer()`
- [ ] include `listing_id` in canonical signed fields
- [ ] resolve listing by seller + listing_id
- [ ] remove `ambiguous_listing`
- [ ] cover multi-listing happy path and abuse cases in tests

Verification:

- `pnpm --filter @ghost-bazaar/engine test -- tests/offers.test.ts tests/integration.test.ts`
- manual flow: same seller registers two listings, offers against one chosen listing

### Phase 4: Real 8004 Discovery Wiring

Replace the fake “optional discover hook” posture with an actual runtime integration.

Design:

- define the runtime mapping contract as:
  - seller submits optional `registry_agent_id`
  - engine resolves `discoverAgent(BigInt(agentId))`
  - engine verifies `discovered.did === seller`
  - only then store the seller DID to agent ID binding
- on `GET /listings` and `GET /listings/:id`, enrich from persisted `registry_agent_id`
- stop describing the feature as “automatic” when no verified mapping exists

Why this contract:

- `@ghost-bazaar/agents` discovers by `agentId`, not by seller DID
- Duty 2’s current “agentId cache” intent becomes concrete and verifiable

Acceptance criteria:

- runtime server actually returns `registry` fields for verified linked sellers
- unlinked sellers still work normally
- invalid `registry_agent_id` or DID mismatch is rejected during registration

Concrete deliverables:

- verified seller DID to `agent_id` binding at registration time
- runtime enrichment based on persisted `registry_agent_id`
- no more “discover by seller DID” fake contract in runtime code paths

Preferred implementation details:

- keep enrichment best-effort on reads
- add a small TTL cache for registry reads if needed, instead of hammering chain RPC on every `GET /listings`
- keep fallback behavior graceful when RPC or registry lookup fails

Files likely touched:

- `packages/engine/src/routes/listings.ts`
- `packages/engine/src/registry/listing-enricher.ts`
- new engine-side registry binding helper or cache module
- `packages/engine/src/server.ts`
- `packages/agents/src/registry.ts` only if a helper wrapper is needed
- `packages/engine/tests/listings.test.ts`

Checklist:

- [ ] accept optional `registry_agent_id` in listing registration
- [ ] resolve `discoverAgent(BigInt(agentId))`
- [ ] verify discovered DID matches submitted seller DID
- [ ] persist verified binding
- [ ] enrich listing reads from persisted binding
- [ ] add fallback tests for not registered / lookup failure / DID mismatch

Verification:

- `pnpm --filter @ghost-bazaar/engine test -- tests/listings.test.ts`
- manual read check: linked seller returns `registry`, unlinked seller does not

### Phase 5: Buyer Strategy Reputation Inputs

Make registry data usable by the buyer side instead of leaving it as response decoration only.

Execution rule:

- **Phase 5 must be test-first.**
- Start by extending strategy tests and any engine-side context-builder tests.
- Do not change buyer logic until the new tests fail for the expected missing-context reason.

Design:

- extend `BuyerStrategyContext` with verified per-seller registry signals sourced from persisted
  `registry_agent_id` + runtime 8004 discovery, not from seller-submitted scores
- use a shape like:
  - `seller_registry: Record<string, { agentId?: string; reputationScore: number | null; totalFeedbacks: number }>`
- keep the strategy contract seller-DID keyed so it aligns with current `current_offers`
- use registry data as a **soft ranking signal**, not a hard participation gate
- preserve current behavior when registry data is absent or partial

Reality check:

- today this repo defines and tests buyer strategies in `packages/strategy`
- there is **not yet a mature engine-side autonomous buyer runtime** that constructs and calls
  `BuyerStrategyContext` end to end
- Phase 5 therefore has two honest deliverables:
  1. strategy contract + strategy behavior upgrades
  2. an engine-side or shared helper that can build `seller_registry` inputs for future runtime glue
- do **not** claim a full engine-driven buyer loop exists unless that runtime glue is also added in-repo

Acceptance criteria:

- buyer strategy context can access verified registry reputation by seller DID
- deterministic buyer strategies behave the same when no registry data is present
- deterministic buyer strategies can use registry data as a tie-breaker or ranking hint
- LLM buyer prompts include registry context when present, without leaking seller private state
- lack of registry data remains a clean fallback path

Important scope note:

- this is the only phase that is not purely engine-local
- it spans `packages/engine` and `packages/strategy`
- it must stay honest about current runtime boundaries

Concrete deliverables:

- `BuyerStrategyContext` upgraded with a typed `seller_registry` field
- deterministic buyer strategies updated to optionally factor registry signals into seller ranking
- `LLMBuyerStrategy` prompt updated to mention verified registry signals when available
- one engine-side or shared helper that can construct `seller_registry` from:
  - current offers
  - persisted listing bindings
  - 8004 discovery results
- tests proving that registry data is available to buyer logic without changing no-registry behavior

Files likely touched:

- `packages/strategy/src/interfaces.ts`
- `packages/strategy/src/competitive-buyer.ts`
- `packages/strategy/src/time-weighted-buyer.ts`
- `packages/strategy/src/linear-concession.ts`
- `packages/strategy/src/llm-buyer.ts`
- `packages/strategy/tests/strategies.test.ts`
- `packages/strategy/tests/llm-strategies.test.ts`
- `packages/strategy/tests/context-isolation.test.ts`
- new engine-side helper, for example `packages/engine/src/strategy/buyer-registry-signals.ts`
- new engine-side helper tests, for example `packages/engine/tests/buyer-registry-signals.test.ts`
- only if an actual runtime glue point exists and is implemented: the engine or agent-runtime caller that builds `BuyerStrategyContext`

Recommended implementation shape:

- introduce a small shared type such as `SellerRegistrySignal`
- add a pure helper that ranks or selects the “best” offer with an optional reputation tie-break
- keep deterministic strategy changes intentionally narrow:
  - price remains the primary sort key
  - reputation only breaks near-ties or otherwise equal-looking offers
  - no hard minimum score threshold in Phase 5
- keep LLM prompt additions compact:
  - seller DID
  - optional `agentId`
  - optional `reputationScore`
  - optional `totalFeedbacks`
- do not inject raw registry URIs or any seller-private strategy data into buyer context

Test design first:

Recommended initial test files:

- `packages/strategy/tests/strategies.test.ts`
- `packages/strategy/tests/llm-strategies.test.ts`
- `packages/engine/tests/buyer-registry-signals.test.ts`

Tests to write before implementation:

1. `deterministic buyers preserve old behavior when seller_registry is empty`
   - existing acceptance/counter tests still pass with `seller_registry: {}`
2. `competitive buyer breaks near price ties using higher reputation`
   - two sellers within a small price spread
   - higher reputation seller should win only when prices are otherwise nearly equivalent
3. `competitive buyer still prefers meaningfully cheaper offer over better reputation`
   - confirm price remains dominant
4. `llm buyer prompt includes verified registry summary when available`
   - mock Anthropic client
   - inspect prompt payload for compact registry lines
5. `llm buyer prompt omits registry section when no signals exist`
6. `buyer context isolation still holds`
   - no seller private fields leak into `BuyerStrategyContext`
   - registry data is limited to public verified metadata
7. `engine-side signal builder maps seller DID -> verified registry summary`
   - given offers + listings with persisted `registry_agent_id`
   - builder returns expected map
8. `engine-side signal builder skips unlinked or failed registry lookups`
   - fallback remains sparse and non-fatal

Red phase expectation:

- strategy tests should fail because `BuyerStrategyContext` lacks `seller_registry`
- helper tests should fail because no signal-builder helper exists
- failures must reflect missing feature support, not broken fixtures

Behavior guardrails:

- registry data must come from runtime 8004 discovery, not seller-supplied scores
- only verified `registry_agent_id` bindings from Phase 4 may feed buyer context
- reputation is advisory, not authoritative
- missing registry data must not cause buyer strategies to crash, reject offers, or degrade to unusable behavior

Checklist:

- [x] add failing strategy/helper tests first
- [x] define `SellerRegistrySignal` shape and `BuyerStrategyContext.seller_registry`
- [x] keep existing no-registry buyer behavior green
- [x] add narrow reputation-aware ranking to deterministic buyer strategies
- [x] expose compact registry summary to `LLMBuyerStrategy`
- [x] add engine-side signal-builder helper for future runtime glue
- [x] keep context isolation and privacy guarantees intact
- [x] only wire runtime caller code if a real buyer-orchestration call site exists in-repo
- [x] document clearly if Phase 5 stops at contract + helper because full runtime glue is still absent

Verification:

- `pnpm --filter @ghost-bazaar/strategy test`
- `pnpm --filter @ghost-bazaar/engine test -- tests/buyer-registry-signals.test.ts`
- `pnpm --filter @ghost-bazaar/strategy build`
- one fixture path showing verified seller reputation enters buyer context by DID

### Phase 6: Buyer Cancel HTTP Route

### Phase 5.1: Hardening Patch for Phase 1-5

Close the blocking findings from the Phase 1-5 review before any Phase 6 work starts.

Execution rule:

- **Phase 5.1 must be test-first.**
- Start with regression tests for each blocking finding.
- Do not move on to buyer cancel or more feature work until the hardening tests are green.

Why this phase exists:

- Phase 1-5 introduced real seller onboarding and registry-aware buyer logic.
- Review found three high-risk issues that make the current state unsafe to treat as “done”:
  1. seller-controlled unknown fields can be persisted and re-exposed via `POST /listings` / `GET /listings`
  2. default seed listings can persist fake demo DIDs into the durable production store
  3. reputation tie-break logic can override a cheaper already-affordable offer

Acceptance criteria:

- `POST /listings` persists only the explicit `Listing` contract fields
- unknown top-level listing fields are either rejected or stripped before persistence and response
- seed listings are safe for durable runtime use, or are disabled outside explicit demo/dev mode
- deterministic buyer strategies remain price-first for accept decisions
- buyer registry helper normalizes persisted agent IDs before discovery
- no new source-breaking requirement is imposed on downstream `BuyerStrategyContext` callers unless intentionally versioned

Concrete deliverables:

- listing registration hardening
- durable listing bootstrap hardening
- buyer reputation ranking hardening
- targeted regression tests covering every review finding

Files likely touched:

- `packages/engine/src/routes/listings.ts`
- `packages/engine/src/registry/listing-store.ts`
- `packages/engine/src/registry/sqlite-listing-store.ts`
- `packages/engine/src/registry/listing-bootstrap.ts`
- `packages/engine/src/registry/registry-binding.ts`
- `packages/engine/src/registry/listing-enricher.ts`
- `packages/engine/src/server.ts`
- `packages/engine/src/strategy/buyer-registry-signals.ts`
- `packages/engine/tests/listings.test.ts`
- `packages/engine/tests/listing-persistence.test.ts`
- `packages/strategy/src/interfaces.ts`
- `packages/strategy/src/buyer-ranking.ts`
- `packages/strategy/src/competitive-buyer.ts`
- `packages/strategy/src/time-weighted-buyer.ts`
- `packages/strategy/src/linear-concession.ts`
- `packages/strategy/src/llm-buyer.ts`
- `packages/strategy/tests/strategies.test.ts`
- `packages/strategy/tests/llm-strategies.test.ts`
- `packages/engine/tests/buyer-registry-signals.test.ts`

Test design first:

Recommended initial test targets:

- `packages/engine/tests/listings.test.ts`
- `packages/engine/tests/listing-persistence.test.ts`
- `packages/strategy/tests/strategies.test.ts`
- `packages/engine/tests/buyer-registry-signals.test.ts`

Tests to write before implementation:

1. `POST /listings rejects or strips unknown top-level fields`
   - submit a valid signed listing with forged `registry`, `reputation_score`, or other unknown fields
   - expect the response body to exclude them
   - expect subsequent `GET /listings` and `GET /listings/:id` to exclude them
2. `durable listing store rejects malformed registry_agent_id`
   - write via the store abstraction with a bad `registry_agent_id`
   - expect rejection instead of durable persistence of invalid values
3. `seed bootstrap is idempotent under duplicate insertion`
   - simulate repeated seed application
   - expect no failure and no duplicated rows
4. `seed listings are disabled outside explicit demo mode or use real decodable DIDs`
   - verify the chosen policy with a server/bootstrap test
   - if keeping seeds enabled, assert the seeded DIDs are real decodable identities
5. `health/listing count does not require full listing scan`
   - add store contract coverage for `count()`
   - ensure server paths use it instead of `getAll().length`
6. `competitive buyer accepts the cheapest in-budget offer even when a pricier near-tie has better reputation`
   - repro with `39.80` vs `40.60`, `budget_soft=40`
   - expect accept of the `39.80` seller
7. `registry signal builder normalizes persisted registry_agent_id before lookup`
   - persist `registry_agent_id: "042"`
   - expect discovery and signals to resolve agent `42`
8. `LLM buyer prompt does not include unnecessary agent identity fields`
   - if `agentId` is dropped from prompt scope, assert only reputation/feedback summary remains

Red phase expectation:

- listing-route hardening tests should fail because unknown fields are currently preserved
- seed/bootstrap tests should fail because bootstrap is currently only best-effort idempotent
- buyer strategy test should fail because current ranking can promote a pricier seller before the accept check
- registry helper normalization test should fail because current helper passes stored IDs through unchanged

Implementation order:

1. **Listing integrity hardening**
   - replace object-spread persistence in `POST /listings` with an explicit `Listing` allowlist builder
   - decide and codify whether unknown top-level keys are rejected or silently stripped
   - align store-level validation with route-level `registry_agent_id` expectations
2. **Durable seed + count hardening**
   - make seed insertion atomic (`INSERT OR IGNORE` or equivalent duplicate-safe path)
   - either make seeding explicit/dev-only or replace fake demo DIDs with real generated demo identities
   - add `count()` to the listing store contract and use it for `/health` and listing-count stats updates
3. **Buyer price-first hardening**
   - preserve absolute-cheapest-offer accept semantics before any reputation tie-break
   - keep reputation as a soft signal only for near-tie ranking among offers that are otherwise still negotiation candidates
4. **Registry helper consistency hardening**
   - normalize persisted `registry_agent_id` before discovery in buyer signal builder
   - tighten binding/enrichment so discovered `agentId` must match the normalized requested ID
5. **Optional privacy cleanup**
   - if no real consumer needs `agentId` in LLM prompts, remove it from prompt output and tests
   - consider whether `seller_registry` should be optional for compatibility until a coordinated breaking release

Checklist:

- [x] write failing regression tests for the three high-risk findings first
- [x] stop persisting unknown listing fields
- [x] align store-level `registry_agent_id` validation with route-level rules
- [x] make seed bootstrap duplicate-safe
- [x] remove fake durable seed identities or gate them behind explicit demo mode
- [x] add a listing `count()` path and replace O(n) `getAll().length` call sites
- [x] restore price-first buyer accept behavior
- [x] normalize `registry_agent_id` in buyer signal builder
- [x] tighten discovered `agentId` equality checks in binding/enrichment
- [ ] decide whether `agentId` belongs in LLM prompt scope
- [x] re-run strategy + engine tests after each hardening slice

Verification:

- `pnpm --filter @ghost-bazaar/strategy test -- tests/strategies.test.ts tests/llm-strategies.test.ts`
- `pnpm --filter @ghost-bazaar/engine test -- tests/listings.test.ts tests/listing-persistence.test.ts tests/buyer-registry-signals.test.ts`
- `pnpm --filter @ghost-bazaar/engine test`
- `pnpm --filter @ghost-bazaar/strategy build`
- `pnpm --filter @ghost-bazaar/engine build`

Only after Phase 5.1 is green should Phase 6 proceed.

### Phase 6: Buyer Cancel HTTP Route

Promote the existing latent cancel capability into a real API surface.

Design:

- add `POST /rfqs/:id/cancel`
- use the existing signed control envelope mechanism with `action: "cancel"`
- allow only `OPEN` and `NEGOTIATING`
- append `NEGOTIATION_CANCELLED`
- reject in `COMMIT_PENDING` and terminal states with `409 invalid_state_transition`

Why this matters:

- cancel already exists in state machine, fuzz paths, and control-envelope semantics
- the absence of an HTTP route means the feature is not actually delivered

Acceptance criteria:

- buyer can cancel through HTTP without test-only manual event injection
- further offers/counters are rejected after cancellation

Concrete deliverables:

- `createCancelRoute`
- route wiring in `server.ts`
- route tests and integration tests

Files likely touched:

- new `packages/engine/src/routes/cancel.ts`
- `packages/engine/src/server.ts`
- `packages/engine/src/index.ts`
- `packages/engine/tests/integration.test.ts`
- likely a new dedicated cancel route test or expanded quote/integration coverage

Checklist:

- [ ] add cancel route with control-envelope validation
- [ ] restrict to buyer only
- [ ] restrict allowed source states to `OPEN` and `NEGOTIATING`
- [ ] append `NEGOTIATION_CANCELLED`
- [ ] reject invalid state transitions
- [ ] replace test-only manual cancellation injection with route-driven coverage

Verification:

- `pnpm --filter @ghost-bazaar/engine test -- tests/integration.test.ts`
- manual route check: cancel then verify later offer is rejected

### Phase 7: Dedicated Test Coverage + Cleanup

Turn the above from “working code” into maintainable code.

Add dedicated tests for:

- `POST /listings`
- durable listing reload across restart
- multi-listing offer selection and signed `listing_id`
- 8004 DID to `agent_id` verification and enrichment fallback
- buyer strategy context carrying registry signals
- `POST /rfqs/:id/cancel`
- `/admin/*` and `/dashboard/*` route behavior, since Step 13 currently lacks dedicated tests

Also clean up documentation and server comments so they stop claiming features that are only partially wired.

Concrete deliverables:

- new dedicated dashboard/admin route tests
- refreshed docs that match actual runtime behavior
- removal of stale comments implying fake integrations are real

Files likely touched:

- new `packages/engine/tests/admin.test.ts`
- new `packages/engine/tests/dashboard.test.ts`
- `packages/engine/README.md`
- `docs/duty2-progress-report.md` or other duty docs if they are being used as current-state references
- `packages/engine/src/server.ts` comments

Checklist:

- [ ] add dedicated Step 13 route tests
- [ ] add route-level listing and cancel regression tests if still missing
- [ ] update README claims about discovery, listings, and seller onboarding
- [ ] remove or rewrite comments that still describe fake runtime paths

Verification:

- `pnpm --filter @ghost-bazaar/engine test`
- `pnpm --filter @ghost-bazaar/engine build`
- sanity-read docs after changes to ensure code and prose agree

## Recommended Sequence

1. Phase 1
2. Phase 2
3. Phase 3
4. Phase 4
5. Phase 5
6. Phase 6
7. Phase 7

## Out of Scope

- frontend dashboard rendering
- settlement execution details
- MCP / agent runtime work
- broader production observability and analytics

## Notes

- `plans/post-listings-plan.md` remains useful as a drill-down for the listing route itself, but this document is the higher-level source of truth for closing the remaining non-UI engine gaps.
- If implementation bandwidth is limited, Phases 1-4 are the real seller-onboarding critical path.
