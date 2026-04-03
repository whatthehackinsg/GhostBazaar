# @ghost-bazaar/engine

The Negotiation Engine is Ghost Bazaar's runtime core. It wires the standalone protocol libraries (`@ghost-bazaar/core`, `@ghost-bazaar/zk`, `@ghost-bazaar/agents`) into a stateful HTTP service that manages the full negotiation lifecycle — from RFQ broadcast through dual-signed commitment.

## What It Does

An AI buyer agent connects, broadcasts an RFQ, receives competing offers from multiple seller agents, counter-offers with optional ZK budget proofs, selects a winner, and both parties co-sign a binding quote. The engine enforces protocol rules, manages deadlines, and streams events in real time.

## Architecture

```
                         ┌──────────────────────────────────────┐
                         │          Hono HTTP Server             │
                         │       (src/server.ts + app.ts)        │
                         └──────────────┬───────────────────────┘
                                        │
              ┌─────────────────────────┼─────────────────────────┐
              │                         │                         │
     ┌────────▼────────┐     ┌──────────▼──────────┐   ┌─────────▼─────────┐
     │  Write Routes    │     │  Read/Public Routes  │   │  Background        │
     │  (body sig auth) │     │ (header + no-auth)   │   │  Services          │
     ├──────────────────┤     ├──────────────────────┤   ├────────────────────┤
     │ POST /listings   │     │ GET  /listings       │   │ DeadlineEnforcer   │
     │ POST /rfqs       │     │ GET  /quote          │   │  - RFQ expiry      │
     │ POST /offers     │     │ GET  /events (SSE)   │   │  - Cosign timeout  │
     │ POST /counter    │     └──────────────────────┘   └────────────────────┘
     │ POST /accept     │
     │ PUT  /quote/sign │
     │ PUT  /cosign     │
     │ PUT  /decline    │
     └──────────────────┘
              │
     ┌────────▼──────────────────────────────────────────┐
     │                  State Layer                       │
     ├───────────────────────────────────────────────────┤
     │ SessionManager   — per-session FIFO mutex + lock  │
     │ InMemoryEventStore — append-only event log        │
     │ deriveState()    — state = reduce(events)         │
     │ StateMachine     — transition validation          │
     └───────────────────────────────────────────────────┘
```

### State Machine

```
OPEN ──(offer)──► NEGOTIATING ──(accept)──► COMMIT_PENDING ──(cosign)──► COMMITTED
  │                    │                          │
  │                    │                     (decline/timeout)
  │                    │                          │
  └──(expire)──► EXPIRED ◄──(expire)──────────────┘
                                                  ▼
                 CANCELLED ◄──(cancel)──── NEGOTIATING
```

6 states, 11 event types, all transitions enforced by the state machine. Terminal states (COMMITTED, EXPIRED, CANCELLED) are absorbing — no further transitions allowed.

Note: `CANCELLED` exists in the state machine and event model, but the public buyer cancel route is intentionally deferred for now.

### Event Sourcing

All state is derived from an append-only event log. There is no mutable session object.

- `deriveState(events)` — pure function, reconstructs full session from events
- **Two storage backends**: `InMemoryEventStore` (dev/test) and `SqliteEventStore` (production, persistent)
- Crash recovery = event replay from SQLite
- Role-scoped visibility — sellers see only their own events; buyers see all

### Authentication

| Route Type | Method | How |
|------------|--------|-----|
| Write routes | POST/PUT | Ed25519 signature inside request body, verified per-handler |
| Read routes | GET | `Authorization: GhostBazaar-Ed25519 <did> <timestamp> <signature>` header |
| Public dashboard | GET /dashboard/* | No auth — anonymized aggregates only |
| Admin panel | GET /admin/* | Session cookie (httpOnly + Secure + SameSite=Strict) |
| Health check | GET /health | No auth |

### Listings + Registry Binding

Seller onboarding is now a real runtime feature:

- `POST /listings` accepts a signed listing body and stores the unsigned listing durably
- listings are persisted in SQLite, not just seeded in memory
- sellers may register multiple listings
- `POST /rfqs/:id/offers` must include a signed `listing_id`
- if `registry_agent_id` is supplied on registration, the engine verifies the 8004 binding before storing it

`GET /listings` and `GET /listings/:id` enrich from the persisted verified `registry_agent_id`, not from seller-DID guesswork.

### Real-Time Events

`GET /rfqs/:id/events` supports two modes via content negotiation:

- **SSE** (`Accept: text/event-stream`) — live push, 15s heartbeat, `Last-Event-ID` reconnect, terminal auto-close
- **JSON** (`Accept: application/json`) — cursor-based polling

`subscribeFrom()` uses a 2-phase atomic design to eliminate the classic replay-to-live event gap.

### Public Dashboard (`/dashboard/*`)

No auth. Anonymized aggregates for community traffic display.

| Endpoint | Returns |
|----------|---------|
| `GET /dashboard/stats` | Active sessions, completed deals, unique buyers/sellers, by_state, averages |
| `GET /dashboard/activity` | Events per minute (5 windows), new sessions + deals last hour |
| `GET /dashboard/feed` (SSE) | Anonymized live event stream: `{type, actor_role, state_after}` — no DIDs, no prices |
| `GET /dashboard/privacy` | Educational: buyer vs seller visibility rules |
| `GET /dashboard/comparison` | Protocol comparison table (Ghost Bazaar vs x402 vs ACP vs A2A) |

### Admin Panel (`/admin/*`)

Session cookie auth. Full negotiation details for team ops/debugging.

```
POST /admin/login   → verify ADMIN_TOKEN, set httpOnly cookie
POST /admin/logout  → clear cookie
GET  /admin/sessions         → paginated session list (?limit, ?offset, ?state)
GET  /admin/sessions/:id     → full session detail
GET  /admin/sessions/:id/events → JSON or SSE (buffer-first replay-to-live)
GET  /admin/stats            → public stats + admin metrics
```

## Quick Start

```bash
# From monorepo root
pnpm install
pnpm build

# Run with tsx (dev mode, no build needed)
pnpm --filter @ghost-bazaar/engine dev

# Or build + run
pnpm --filter @ghost-bazaar/engine build
pnpm --filter @ghost-bazaar/engine start
```

The server starts on `http://localhost:3000` with 3 seed demo listings inserted only when missing.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP listen port |
| `ENFORCER_INTERVAL_MS` | `1000` | Deadline scanner interval (ms) |
| `COSIGN_TIMEOUT_MS` | `60000` | Max time in COMMIT_PENDING before rollback (ms) |
| `SEED_LISTINGS` | `true` | Set to `"false"` to disable demo listings |
| `DATA_DIR` | `./data` | SQLite database directory |
| `ADMIN_TOKEN` | (none) | Admin panel password. If not set, admin routes return 403 |
| `AGENT_REGISTRY_RPC_URL` | (none) | Optional RPC URL for 8004 registry discovery |
| `REGISTRY_CACHE_TTL_MS` | `300000` | TTL for runtime 8004 discovery cache |

### Verify It Works

```bash
# Health check
curl http://localhost:3000/health
# → {"status":"ok","uptime":5,"sessions":0,"listings":3}

# List seed demo listings
curl http://localhost:3000/listings
# → {"listings":[...3 items...]}

# Write routes reject without valid signature
curl -X POST http://localhost:3000/rfqs -H "Content-Type: application/json" -d '{}'
# → 400 malformed_payload

# Read routes reject without auth header
curl http://localhost:3000/rfqs/test/events
# → 401 unauthorized
```

## Deployment (Fly.io)

A `Dockerfile` and `fly.toml` are provided at the monorepo root.

### First-Time Setup

```bash
# Install flyctl
curl -L https://fly.io/install.sh | sh

# Authenticate
fly auth login

# Create the app (one-time)
fly launch --no-deploy

# Deploy
fly deploy
```

### Deployment Notes

- **Image size**: ~412MB (Node 22 + snarkjs ZK library). Most of the size is the ZK verification dependency.
- **Cold start**: With `min_machines_running = 0` (default), first request after idle has ~2-3s cold start. Set to `1` in `fly.toml` for always-on.
- **SSE connections**: `fly.toml` sets connection concurrency limits (hard: 200, soft: 150). SSE connections are long-lived — monitor with `GET /health` which reports active session count.
- **Enforcer interval**: Production uses `ENFORCER_INTERVAL_MS=5000` (5s scan). For lower latency on deadline enforcement, reduce to `1000` but this increases CPU usage on shared VMs.
- **Secrets**: `ADMIN_TOKEN` is required if you want the admin panel enabled. If you use a private or paid registry RPC, provide `AGENT_REGISTRY_RPC_URL` via Fly secrets as well.
- **Region**: Default `iad` (US East). Add regions with `fly scale count 1 --region lhr` for multi-region.
- **Health check**: Fly pings `GET /health` every 15s. If it fails, the machine is restarted.

### What Fly.io Handles

- TLS termination (HTTPS at the edge)
- Auto-scaling (stop on idle, start on request)
- Zero-downtime deploys (rolling)
- DDoS protection at the proxy layer

### What You Must Handle

- **Persistent volume** — `SqliteEventStore` writes to `/data/engine.db`. The Fly.io volume must be provisioned (`fly volumes create ghost_bazaar_data --size 1 --region iad`) before first deploy.
- **No rate limiting** — Fly.io proxy provides basic protection, but application-level rate limiting (per-DID request caps) is a Duty 3 concern.
- **No monitoring** — add a Grafana/Prometheus exporter or use `fly metrics` for basic observability.

## Testing

```bash
# Run all 345 tests
pnpm --filter @ghost-bazaar/engine test

# Run specific test file
pnpm --filter @ghost-bazaar/engine test -- tests/integration.test.ts
```

| Test Suite | File | Coverage |
|------------|------|----------|
| Unit: state machine | `state-machine.test.ts` | All 6 states, valid + invalid transitions |
| Unit: event store | `event-store.test.ts` | Append, subscribe, subscribeFrom, hasCursor |
| Unit: session derivation | `derive-state.test.ts` | All 11 event types, edge cases |
| Unit: session manager | `session-manager.test.ts` | FIFO mutex, lock timeout, dry-run |
| Route: RFQs | `rfqs.test.ts` | Validation, signature, deadline |
| Route: Offers | `offers.test.ts` | Per-DID cap, total cap, listing validation |
| Route: Counters | `counters.test.ts` | ZK proof, state checks, budget commitment |
| Route: Quote flow | `quote-flow.test.ts` | Accept, sign, cosign, decline lifecycle |
| Route: Events | `events.test.ts` | SSE, JSON polling, connection limits |
| Route: Listings | `listings.test.ts` | Discovery, enrichment, validation |
| Middleware | `middleware.test.ts` | Error handler, signature verification |
| Deadline enforcer | `deadline-enforcer.test.ts` | Expiry, cosign timeout, isolation |
| Connection tracker | `connection-tracker.test.ts` | Per-DID limits, eviction |
| Integration (E2E) | `integration.test.ts` | 10 full negotiation scenarios |
| Fuzz (property-based) | `fuzz.test.ts` | 200 random action sequences, 8 invariants |

## File Structure

```
src/
├── server.ts                    # Entrypoint — wires routes, stores, enforcer
├── app.ts                       # Hono app factory
├── types.ts                     # EventStore interface, event/state types
├── deadline-enforcer.ts         # Periodic RFQ expiry + cosign timeout scanner
├── middleware/
│   ├── error-handler.ts         # EngineError → uniform JSON responses
│   ├── validate-signature.ts    # Ed25519 signature verification
│   ├── require-state.ts         # Session state guard middleware
│   └── admin-auth.ts            # Admin cookie auth + login throttling
├── state/
│   ├── event-store.ts           # InMemoryEventStore (dev/test)
│   ├── sqlite-event-store.ts    # SqliteEventStore (production, persistent)
│   ├── visibility.ts            # Shared isEventVisibleTo + deepFreeze + TERMINAL_EVENT_TYPES
│   ├── session.ts               # DerivedSession + deriveState reducer
│   ├── session-manager.ts       # Per-session FIFO mutex + event append + onAppend observers
│   └── state-machine.ts         # State transition rules
├── stats/
│   ├── stats-collector.ts       # In-memory aggregator (startup replay + live onAppend)
│   └── event-broadcaster.ts     # SSE fan-out (1x serialize → Nx string copy)
├── routes/
│   ├── rfqs.ts                  # POST /rfqs
│   ├── offers.ts                # POST /rfqs/:id/offers
│   ├── counters.ts              # POST /rfqs/:id/counter
│   ├── accept.ts                # POST /rfqs/:id/accept
│   ├── quote-sign.ts            # PUT /rfqs/:id/quote/sign
│   ├── quote-read.ts            # GET /rfqs/:id/quote
│   ├── cosign.ts                # PUT /rfqs/:id/cosign
│   ├── decline.ts               # PUT /rfqs/:id/decline
│   ├── events.ts                # GET /rfqs/:id/events (SSE + JSON)
│   ├── listings.ts              # GET/POST /listings, GET /listings/:id
│   ├── dashboard.ts             # GET /dashboard/* (public, no auth)
│   └── admin.ts                 # GET /admin/* (cookie auth, sessions, events SSE)
├── registry/
│   ├── listing-store.ts         # Listing store contract
│   ├── sqlite-listing-store.ts  # Durable SQLite-backed listings
│   ├── listing-bootstrap.ts     # Seed-if-missing bootstrap
│   ├── listing-enricher.ts      # 8004 Agent Registry metadata enrichment
│   └── registry-binding.ts      # registry_agent_id verification
├── strategy/
│   └── buyer-registry-signals.ts # verified seller_registry signal builder
├── security/
│   └── control-envelope.ts      # Signed control envelope + tombstones
└── util/
    ├── connection-tracker.ts    # SSE connection limits + buyer-priority eviction
    ├── currency.ts              # Supported currency validation
    └── quote-builder.ts         # Quote construction from session state
```
