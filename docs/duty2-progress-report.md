# Duty 2: Negotiation Engine — Progress Report

**Date**: 2026-03-21
**Branch**: `feat/engine`
**Status**: Track A (Engine Core) Complete | Track B API Complete | Track B UI Pending

---

## Summary

The Negotiation Engine is Ghost Bazaar's runtime core — it wires Duty 1's standalone libraries (signing, strategies, ZK proofs) into a functional HTTP service. The current implementation now includes durable seller onboarding, multi-listing provenance, verified 8004 registry wiring, and buyer-side registry signal helpers on top of the original negotiation core.

---

## Deliverables at a Glance

| Metric | Value |
|--------|-------|
| Track A status | Complete |
| Track B API status | Complete |
| Track B UI status | Pending |
| Test files | 18 |
| Test cases | 345 (all passing) |
| TypeScript build | Zero errors |
| External review rounds | 30+ (Codex + Gemini + Red Team + Spec Compliance) |

---

## Implementation Steps

### Step 1-2: Core Types + Event Sourcing Foundation

Established the engine's data model and state management:

- **6 session states**: OPEN → NEGOTIATING → COMMIT_PENDING → COMMITTED / EXPIRED / CANCELLED
- **11 event types**: Append-only events driving the state machine (RFQ_CREATED, OFFER_SUBMITTED, COUNTER_SENT, WINNER_SELECTED, etc.)
- **InMemoryEventStore**: Append-only writes, deep-frozen immutability, role-scoped visibility filtering (buyer sees all; seller sees only their own events)
- **SessionManager**: Per-session FIFO mutex (5s timeout, queue size 10), dry-run validation before event persistence

Core architecture: **state = reduce(events)**. No mutable state. Crash recovery is simply event replay.

### Step 3: HTTP Framework + Middleware

- Hono app factory + global error handler (EngineError → uniform JSON responses)
- Ed25519 signature verification middleware
- Quote-specific signature verification (different canonical form than standard signatures)

### Step 4: Service Discovery Routes

- `GET /listings` — returns service listings from ListingStore
- `POST /listings` — signed seller registration
- durable SQLite-backed listing persistence (seed-if-missing, not seed-only memory)
- verified 8004 Agent Registry binding via optional `registry_agent_id`

### Step 5-7: Negotiation Routes

| Route | Function | Key Security |
|-------|----------|-------------|
| `POST /rfqs` | Create RFQ | Signature verification, deadline/currency/price validation |
| `POST /rfqs/:id/offers` | Seller submits offer | Per-DID cap (5), total cap (50), payment_endpoint captured from ListingStore (anti-redirection) |
| `POST /rfqs/:id/counter` | Buyer counter-offers | Buyer signature, target seller must have an offer, optional ZK budget proof verification |

### Step 8: Commitment Flow (5 Routes)

Implements the full Protocol Phase 3 (Commitment) lifecycle:

| Route | Method | Function |
|-------|--------|----------|
| `/rfqs/:id/accept` | POST | Buyer selects winner — Signed Control Envelope + CAS |
| `/rfqs/:id/quote/sign` | PUT | Buyer signs the quote |
| `/rfqs/:id/quote` | GET | Read current quote state |
| `/rfqs/:id/cosign` | PUT | Seller co-signs → COMMITTED |
| `/rfqs/:id/decline` | PUT | Seller declines → rollback to NEGOTIATING |

Security notes: Accept uses offer_id + session_revision dual CAS to prevent race conditions. Quote signing uses a dedicated canonical form (`buyer_signature:""` + `seller_signature:""`), distinct from standard object signing.

### Step 9: Events Route (SSE + JSON Dual-Mode)

`GET /rfqs/:id/events` — content-negotiated dual-mode endpoint:

- **SSE mode** (`Accept: text/event-stream`): Real-time push + 15s heartbeat + `Last-Event-ID` auto-reconnect + terminal state auto-close
- **JSON mode**: Polling + cursor pagination

Key infrastructure:
- `subscribeFrom()` — Atomic replay+subscribe (2-phase activate design; eliminates the classic gap between getEvents and subscribe where events can be lost)
- `subscribeTerminal()` — Terminal state lifecycle signal (solves the problem where non-winning sellers cannot see the COMMITTED event)
- `ConnectionTracker` — Per-DID connection limit (3) + per-session cap (10) + buyer-priority eviction
- `hasCursor()` — Session-scoped cursor validation (prevents cross-session cursor injection)

### Step 10: Deadline Enforcer

`DeadlineEnforcer` — the engine's periodic heartbeat timer:

| Function | Condition | Result |
|----------|-----------|--------|
| RFQ expiry | `Date.now() >= rfq.deadline` | → EXPIRED |
| Cosign timeout | COMMIT_PENDING exceeds 60s | → COSIGN_TIMEOUT → rollback to NEGOTIATING |

Technical highlights:
- Self-scheduling `setTimeout` (not `setInterval` — prevents overlapping scans)
- Re-validates conditions inside `withLock` (prevents TOCTOU races)
- Terminal cleanup: releases locks + closes SSE connections
- Per-session try/catch isolation (one corrupted session does not block enforcement for others)
- Configurable: `COSIGN_TIMEOUT_MS` [15s-120s], `ENFORCER_INTERVAL_MS` [500ms-10s]

### Step 11: Integration Tests + Fuzz Testing

Track A quality gate:

**10 E2E integration tests:**
1. Happy path full flow → COMMITTED
2. Multi-seller competition — buyer picks cheapest
3. Counter-offer flow (offer → counter → revised offer → accept)
4. Decline + re-accept a different seller
5. Deadline expiry (DeadlineEnforcer E2E)
6. Cosign timeout rollback
7. SSE live event delivery
8. Event replay consistency verification
9. Privacy check (private fields never leak)
10. Cancellation flow

**200 seeded property-based tests** (`fast-check`):
- 9 weighted random action types (offer/counter/accept/sign/cosign/decline/cancel/expire/cosignTimeout)
- 30-action random sequences per run
- 8 invariants verified after every action: state validity, event replay consistency, terminal absorption, quote field coherence, signature coherence, privacy zero-leak, etc.
- Seed 42 for CI reproducibility

---

## Security Audit Record

Every step underwent multi-party independent review:

| Audit Type | Steps Covered | Auditor |
|------------|---------------|---------|
| Plan Review | All | Codex (multi-round), Gemini |
| Code Review | Steps 1-11 | Codex (at least 1 round per step) |
| Red Team Attack Testing | Steps 8, 9, 10 | Independent attacker agents |
| Spec Compliance | Steps 9, 10, 11 | Independent compliance checker agents |
| Blue Team Defense Report | Engine Plan | Independent defender agent |

Key security findings and fixes:
- **Event stream replay-to-live race** → `subscribeFrom()` atomic design
- **Cross-session cursor injection** → Session-scoped `hasCursor()`
- **Cleanup re-entrancy** → `cleanedUp` boolean guard
- **Connection slot leak** → try/catch around subscribeFrom setup
- **Enforcer corrupted session propagation** → Per-session try/catch isolation
- **Fuzz swallowing 500 errors** → `res.status < 500` assertion

---

## Step 12: SQLite Event Persistence (Done)

Replaced `InMemoryEventStore` with `SqliteEventStore` for durable negotiation history.

- **Storage**: SQLite via `better-sqlite3`, WAL mode, `max_page_count` 1GB cap
- **Dedup**: UNIQUE constraint on `event_id` (no in-memory Set — eliminates unbounded memory growth)
- **Startup**: Loads `activeSessionIds` from DB, no per-tick `SELECT DISTINCT` scan
- **What didn't change**: All routes, state machine, middleware, DeadlineEnforcer

### Step 12 Audit + Performance Fixes

8-finding audit (4 agents: correctness, memory, performance, security) + 5 rounds Codex review:

- Extracted `visibility.ts` shared module (single source for `isEventVisibleTo`)
- `deriveState()` cache in SessionManager (keyed by eventCount, TTL 5min eviction)
- `offers.push()` instead of `[...offers, offer]` (O(n²) → O(n))
- `EnvelopeTombstones.sweep()` wired into enforcer + `nextExpiry` fast-path
- `activeSessionIds` in-memory Set replaces `SELECT DISTINCT` per tick
- `sessionCache` evicted on `removeLock()` + stale TTL
- `cleanedUpSessions` bounded (evict oldest half at 10k)
- `err.code` for UNIQUE constraint check (not message text)

## Step 13: Dual Dashboard API (Done — API complete, UI pending)

Public dashboard (no auth) + Admin panel (session cookie auth). API endpoints only, no UI yet.

**Public (`/dashboard/*`)**:
- `GET /dashboard/stats` — anonymized aggregate metrics
- `GET /dashboard/activity` — per-minute event rate
- `GET /dashboard/feed` (SSE) — anonymized live event stream (max 100 connections)
- `GET /dashboard/privacy` — buyer vs seller visibility explainer
- `GET /dashboard/comparison` — protocol comparison table

**Admin (`/admin/*`)**:
- `POST /admin/login` + `POST /admin/logout` — session cookie auth (httpOnly + Secure + SameSite=Strict)
- `GET /admin/sessions` — paginated, filterable session list
- `GET /admin/sessions/:id` — full session detail
- `GET /admin/sessions/:id/events` — JSON + SSE dual-mode with buffer-first replay
- `GET /admin/stats` — extended metrics

**Infrastructure**: StatsCollector (in-memory aggregator), EventBroadcaster (1x serialize → Nx fan-out), per-IP + global rate limiting, HMAC safeCompare.

Reviewed: 7 rounds Codex + 12 agent audits (security, memory, SSE correctness, privacy).

## Step 14: Durable Seller Onboarding + Real 8004 Wiring (Done)

Closed the old “fake discovery” gap by turning listings into durable runtime resources instead of seed-only memory.

- `SqliteListingStore` persists listings across restarts
- `POST /listings` accepts signed listing bodies and stores unsigned listings
- sellers may register multiple listings
- offer provenance is now bound by signed `listing_id`
- optional `registry_agent_id` is verified against real 8004 discovery before persistence
- listing reads enrich from the persisted verified binding, not seller-DID guesswork

This makes seller onboarding and 8004 integration real engine behavior instead of a demo-only hook.

## Step 15: Buyer Strategy Reputation Inputs (Done)

Registry data is no longer only a read-side decoration on listings.

- `BuyerStrategyContext` now includes typed `seller_registry` signals
- deterministic buyer strategies preserve old behavior when no registry data exists
- near-tie seller ranking can use verified reputation as a soft signal
- `LLMBuyerStrategy` includes compact registry summaries when present
- an engine-side `buyer-registry-signals` helper builds verified seller signals from:
  - current offers
  - persisted listing bindings
  - runtime 8004 discovery

Important boundary: this phase ships the contract, strategy behavior, and signal builder honestly. It does **not** claim a full engine-driven buyer runtime loop exists if there is no real runtime caller yet.

### Track B: Demo UI

Public dashboard API serves as Track B's data layer. 4 hackathon demo screens mapped to dashboard endpoints. Frontend rendering is a separate concern.

### Exit Criteria

- [x] Core negotiation + discovery endpoints implemented
- [x] No illegal state transitions (fuzz verified)
- [x] Event replay reconstructs identical state
- [x] 345 tests all passing
- [x] Build zero errors
- [x] Server entrypoint with real auth + ZK verification
- [x] Fly.io deployment config (Dockerfile + fly.toml + GitHub Actions CI/CD)
- [x] SQLite persistence (Step 12)
- [x] 8-finding audit + 4 performance optimizations (Step 12 audit)
- [x] Dual dashboard API endpoints (Step 13)
- [x] Durable seller onboarding + verified 8004 registry wiring (Step 14)
- [x] Buyer strategy registry signal contract + helper (Step 15)
- [ ] Buyer cancel HTTP route (deferred; latent state-machine support exists, public route not shipped)
- [ ] Dashboard frontend rendering (Track B UI)

---

## Code Structure

```
packages/engine/
├── src/
│   ├── app.ts                          # Hono app factory
│   ├── deadline-enforcer.ts            # Periodic scanner (Step 10)
│   ├── types.ts                        # EventStore interface, event types, state types
│   ├── middleware/
│   │   ├── error-handler.ts            # Global error handler
│   │   └── validate-signature.ts       # Ed25519 signature verification
│   ├── registry/
│   │   ├── listing-store.ts            # Listing store contract
│   │   ├── sqlite-listing-store.ts     # Durable listing persistence
│   │   ├── listing-bootstrap.ts        # Seed-if-missing bootstrap
│   │   ├── listing-enricher.ts         # 8004 Agent Registry enrichment
│   │   └── registry-binding.ts         # registry_agent_id verification
│   ├── routes/
│   │   ├── listings.ts                 # GET/POST /listings, GET /listings/:id
│   │   ├── rfqs.ts                     # POST /rfqs
│   │   ├── offers.ts                   # POST /rfqs/:id/offers
│   │   ├── counters.ts                 # POST /rfqs/:id/counter
│   │   ├── accept.ts                   # POST /rfqs/:id/accept
│   │   ├── quote-sign.ts              # PUT /rfqs/:id/quote/sign
│   │   ├── quote-read.ts              # GET /rfqs/:id/quote
│   │   ├── cosign.ts                  # PUT /rfqs/:id/cosign
│   │   ├── decline.ts                 # PUT /rfqs/:id/decline
│   │   └── events.ts                  # GET /rfqs/:id/events (SSE+JSON)
│   ├── security/
│   │   └── control-envelope.ts         # Signed control envelope validation
│   ├── strategy/
│   │   └── buyer-registry-signals.ts   # verified seller_registry signal builder
│   ├── state/
│   │   ├── event-store.ts              # InMemoryEventStore (event sourcing)
│   │   ├── sqlite-event-store.ts       # SqliteEventStore (persistent, Step 12)
│   │   ├── session.ts                  # DerivedSession + deriveState reducer
│   │   ├── session-manager.ts          # FIFO lock + event append
│   │   └── state-machine.ts            # State transition rules
│   └── util/
│       ├── connection-tracker.ts       # SSE connection limits
│       └── quote-builder.ts            # Quote construction
└── tests/
    ├── integration.test.ts             # 10 E2E scenarios (Step 11)
    ├── fuzz.test.ts                    # 200 property-based tests (Step 11)
    ├── quote-flow.test.ts              # Step 8 commitment flow tests
    ├── events.test.ts                  # Step 9 SSE tests
    ├── deadline-enforcer.test.ts       # Step 10 enforcer tests
    ├── connection-tracker.test.ts      # Connection limit tests
    ├── event-store.test.ts             # Event store tests
    ├── derive-state.test.ts            # State derivation tests
    ├── session-manager.test.ts         # Lock + event management tests
    ├── state-machine.test.ts           # State transition tests
    ├── offers.test.ts                  # Offer route tests
    ├── counters.test.ts                # Counter route tests
    ├── rfqs.test.ts                    # RFQ route tests
    ├── listings.test.ts                # Discovery + registration route tests
    ├── listing-persistence.test.ts     # durable listing storage tests
    ├── buyer-registry-signals.test.ts  # seller_registry helper tests
    ├── middleware.test.ts              # Middleware tests
    └── types.test.ts                   # Type tests
```
