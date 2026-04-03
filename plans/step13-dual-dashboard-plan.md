# Step 13: Dual Dashboard API — Public + Admin

## Context

Two dashboards with different audiences and data exposure levels:

| | Public Dashboard | Admin Panel |
|---|---|---|
| **Path prefix** | `/dashboard/*` | `/admin/*` |
| **Auth** | None (public) | Session cookie (httpOnly + Secure + SameSite=Strict) |
| **Audience** | Community, investors, website embed | Team internal, ops, debugging |
| **Data** | Anonymized aggregates only | Full session/event details |
| **Privacy** | No DIDs, no prices, no payloads | All events (private fields never stored) |

---

## Part A: Public Dashboard (`/dashboard/*`)

### Design: Aggregation-Only, Zero Leakage

The public dashboard answers: "Is Ghost Bazaar active? How much?" — not "Who is trading what at what price?"

#### `GET /dashboard/stats` — No auth

```typescript
{
  // Activity
  active_sessions: 8,           // OPEN + NEGOTIATING + COMMIT_PENDING
  completed_deals: 142,         // COMMITTED total
  total_sessions: 203,          // all-time

  // Participants (distinct DID counts, not actual DIDs)
  unique_buyers: 12,
  unique_sellers: 27,

  // Distribution
  by_state: {
    OPEN: 2,
    NEGOTIATING: 4,
    COMMIT_PENDING: 2,
    COMMITTED: 142,
    EXPIRED: 38,
    CANCELLED: 15
  },

  // Volume (counts only, no prices)
  total_offers: 891,
  total_counters: 234,
  avg_offers_per_session: 4.4,
  avg_rounds_per_session: 2.1,

  // Timing
  avg_negotiation_duration_ms: 45000,  // RFQ_CREATED → terminal
  success_rate: 0.73,                  // COMMITTED / terminal

  // System
  uptime: 86400,
  listings: 3
}
```

**What's NOT exposed**: DIDs, prices, session IDs, event payloads, timestamps of specific events.

#### `GET /dashboard/activity` — No auth, real-time pulse

Returns recent activity as a rate signal (not individual events):

```typescript
{
  // Events per minute in the last 5 windows
  events_per_minute: [12, 8, 15, 11, 9],  // newest first
  // New sessions in the last hour
  new_sessions_last_hour: 5,
  // Deals completed in the last hour
  deals_last_hour: 3
}
```

#### Global Append Observer (Codex Fix #1)

StatsCollector, public feed SSE, and admin SSE all need "notify me on new event".
Instead of modifying EventStore, add an observer list to `SessionManager.appendEvent()`:

```typescript
// SessionManager — new field + methods
type AppendObserver = (event: NegotiationEvent, session: DerivedSession) => void
private readonly appendObservers = new Set<AppendObserver>()

/** Register an observer. Returns unsubscribe function. (Codex R3 Fix #1) */
onAppend(fn: AppendObserver): () => void {
  this.appendObservers.add(fn)
  return () => { this.appendObservers.delete(fn) }
}

// At end of appendEvent(), after successful persist:
for (const obs of this.appendObservers) {
  try { obs(event, candidateState) } catch { /* observer failure must not break append */ }
}
```

**Unsubscribe semantics (Codex R3 Fix #1):** `onAppend()` returns an unsubscribe function.
- `StatsCollector`: registers once at startup, never unsubscribes (lives for process lifetime)
- Public feed SSE: each connection registers an observer, calls unsubscribe on disconnect/abort
- Admin SSE: same pattern — unsubscribe on disconnect

Uses `Set<AppendObserver>` (not Array) so delete is O(1).

**SSE fanout architecture:** For public feed, instead of registering one observer per
SSE connection (which is fine up to ~100), an alternative is a single `FeedBroadcaster`
that registers one observer and manages its own subscriber list. Either approach works
at the 100-connection scale. Choose the simpler per-connection approach for now.

This keeps EventStore's security boundary intact — no new global subscribe API needed.

#### Implementation: `StatsCollector` class (~100 lines)

A lightweight in-memory aggregator registered via `sessionManager.onAppend()`:

```typescript
/** Per-session summary for correct state-transition counting (Codex R3 Fix #4) */
interface SessionLedgerEntry {
  state: SessionState       // current state — used to decrement old by_state count
  createdAt: string         // RFQ_CREATED timestamp — for duration calculation
  offerCount: number
  counterCount: number
}

class StatsCollector {
  private uniqueBuyers = new Set<string>()
  private uniqueSellers = new Set<string>()
  private totalOffers = 0
  private totalCounters = 0
  private completedDeals = 0
  private terminalSessions = 0
  private totalDurationMs = 0
  private readonly byState: Record<SessionState, number> = { ... }
  // Per-session ledger — tracks prior state so transitions update by_state correctly
  // e.g., OPEN→NEGOTIATING: byState.OPEN--, byState.NEGOTIATING++
  private readonly sessionLedger = new Map<string, SessionLedgerEntry>()
  // Per-minute event counters (circular buffer, 5 slots)
  private minuteBuckets: number[] = [0, 0, 0, 0, 0]
  // Hourly counters
  private newSessionsLastHour = 0
  private dealsLastHour = 0

  // Called on every append() via sessionManager.onAppend() — O(1) per event
  onEvent(event: NegotiationEvent, session: DerivedSession): void {
    const rfqId = event.rfq_id
    const prev = this.sessionLedger.get(rfqId)

    if (!prev) {
      // New session — initialize ledger entry
      this.sessionLedger.set(rfqId, { state: session.state, createdAt: event.timestamp, offerCount: 0, counterCount: 0 })
      this.byState[session.state]++
    } else if (prev.state !== session.state) {
      // State transition — decrement old, increment new
      this.byState[prev.state]--
      this.byState[session.state]++
      prev.state = session.state
    }
    // ... update counters, DIDs, timing, etc.
  }

  getStats(): DashboardStats { ... }
  getActivity(): DashboardActivity { ... }
}
```

**Why the ledger is needed**: Without tracking each session's previous state,
`by_state` counts would drift (e.g., OPEN→NEGOTIATING would increment NEGOTIATING
but never decrement OPEN). The ledger is small — one entry per session, ~50 bytes each.

**On startup** (Codex Fix #4): Replay raw events directly from `eventStore.getAllEvents()`,
NOT via `sessionManager.getSession()`. This avoids filling the sessionCache with every
historical session on boot.

```typescript
// StatsCollector constructor — direct event replay, no SessionManager
constructor(eventStore: InternalEventStore) {
  for (const rfqId of eventStore.listSessionIds()) {
    const events = eventStore.getAllEvents(rfqId)
    for (const e of events) this.processRawEvent(e)
  }
}
```

**Performance**: O(1) per event (increment counters). No queries on read. `/dashboard/stats` is a pure memory read.

#### `GET /dashboard/feed` — No auth, anonymized live event stream (SSE)

Real-time feed of anonymized protocol activity. Shows **what type** of event happened, not **who** or **at what price**.

```typescript
// SSE event data:
{
  type: "OFFER_SUBMITTED",       // event type
  actor_role: "seller",          // just "buyer" or "seller", no index (Codex Fix #2)
  state_after: "NEGOTIATING"     // session state after this event
}
```

**Anonymization rules (Codex Fix #2 — no cross-session linkage):**
- DIDs → `actor_role: "buyer" | "seller"` only. No index, no pseudonym
- Prices → omitted entirely
- Session IDs → omitted (frontend just sees a stream of activity)
- Timestamps → omitted from SSE data (SSE `id:` field provides ordering only)
- Payload details → stripped, only event type + role + resulting state

**Why no seller_index**: A stable index lets observers correlate the same seller across sessions and build behavior profiles. With only `"seller"`, you know "a seller did something" but can't tell if it's the same seller as before.

This powers the **live event feed** screen — the audience sees "A seller submitted an offer" scrolling in real time.

**Public SSE connection limit (Codex Fix #5):** Max 100 concurrent `/dashboard/feed` connections. Simple global counter — no per-user tracking (public endpoint has no identity). Rejected with 503 when full. Heartbeat every 15s, cleanup on abort.

```typescript
let publicFeedConnections = 0
const MAX_PUBLIC_FEED = 100

// Route entry: if (publicFeedConnections >= MAX_PUBLIC_FEED) return 503
// On connect: publicFeedConnections++
// On disconnect/abort: publicFeedConnections--
```

#### `GET /dashboard/privacy-explainer` — No auth, static JSON

Educational content for the Privacy Split-View screen. Shows what buyer vs seller can see.

```typescript
{
  buyer_sees: [
    "All offers from all sellers (information advantage)",
    "All counter-offers they sent",
    "Selected winner + dual-signed quote",
    "Terminal events (expired, cancelled, committed)"
  ],
  seller_sees: [
    "The RFQ (service request + deadline)",
    "Only their own offers",
    "Only counters addressed to them",
    "Winner notification (only if they won)",
    "Terminal events (expired, cancelled)"
  ],
  seller_never_sees: [
    "Other sellers' offers or prices",
    "Other sellers' identities",
    "Buyer's budget (protected by ZK proof)",
    "How many other sellers are competing"
  ],
  zk_proof_protects: [
    "budget_hard — buyer's maximum willingness to pay",
    "Groth16 proof verifies counter_price <= budget_hard without revealing budget_hard",
    "Poseidon commitment in RFQ binds the budget without exposing it"
  ]
}
```

#### `GET /dashboard/comparison` — No auth, static JSON

Protocol comparison table for the pitch screen. Data from `COMPETITIVE-LANDSCAPE.md`.

```typescript
{
  protocols: [
    {
      name: "Ghost Bazaar",
      negotiation: "Structured RFQ/offer/counter/quote",
      multi_seller: true,
      budget_privacy: "ZK (Groth16)",
      privacy_score: "83%",
      settlement: "Solana SPL"
    },
    { name: "x402", negotiation: "None", multi_seller: false, ... },
    { name: "Virtuals ACP", negotiation: "Partial", multi_seller: "Partial", ... },
    { name: "Google A2A", negotiation: "None", multi_seller: false, ... }
  ]
}
```

### Track B Screens Mapping

| Duty 2 Track B Screen | Dashboard Endpoint | Status |
|---|---|---|
| 1. Live event feed | `GET /dashboard/feed` (SSE) | NEW |
| 2. Metrics dashboard | `GET /dashboard/stats` + `GET /dashboard/activity` | NEW |
| 3. Privacy split-view | `GET /dashboard/privacy-explainer` | NEW (static) |
| 4. Protocol comparison | `GET /dashboard/comparison` | NEW (static) |

**Frontend**: The API returns JSON/SSE. The actual HTML/React rendering is a separate concern — the engine serves API endpoints, the frontend consumes them. For hackathon, a simple static HTML page with fetch() + EventSource can render all 4 screens.

---

## Part B: Admin Panel (`/admin/*`)

### Auth: Session Cookie (Browser-Safe)

Admin uses a login page + httpOnly cookie. `ADMIN_TOKEN` never reaches browser JavaScript.

**Flow:**
```
Browser → GET  /admin/login          → Login page (HTML form)
        → POST /admin/login          → Verify password, set httpOnly cookie
        → GET  /admin                → Dashboard (cookie auto-sent)
        → GET  /admin/* API          → Cookie verified per-request
        → GET  /admin/sessions/:id/events (SSE) → Cookie auto-sent by EventSource
        → POST /admin/logout         → Clear cookie
```

**Clear cookie = logged out.** Re-visit `/admin/login` and enter password again.

```typescript
// src/middleware/admin-auth.ts
import { timingSafeEqual, randomBytes } from "node:crypto"

const SESSION_COOKIE = "ghost_bazaar_admin"
const SESSION_MAX_AGE = 24 * 60 * 60 // 24 hours

// Active sessions — maps session token → expiry timestamp
const activeSessions = new Map<string, number>()

/** POST /admin/login — verify password, issue session cookie */
export function handleLogin(password: string): { cookie: string } | null {
  const token = process.env.ADMIN_TOKEN
  if (!token) return null

  const provided = Buffer.from(password)
  const expected = Buffer.from(token)
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return null
  }

  // Issue a random session token (not the ADMIN_TOKEN itself)
  const sessionToken = randomBytes(32).toString("hex")
  activeSessions.set(sessionToken, Date.now() + SESSION_MAX_AGE * 1000)
  return {
    cookie: `${SESSION_COOKIE}=${sessionToken}; HttpOnly; Secure; SameSite=Strict; Path=/admin; Max-Age=${SESSION_MAX_AGE}`
  }
}

/** Middleware: verify admin session cookie on all /admin/* routes (except login) */
export function requireAdminAuth(req: Request): void {
  const token = process.env.ADMIN_TOKEN
  if (!token) throw new EngineError(403, "forbidden", "Admin API not configured")

  const cookies = req.headers.get("Cookie") ?? ""
  const match = cookies.match(/ghost_bazaar_admin=([a-f0-9]{64})/)
  if (!match) throw new EngineError(401, "unauthorized", "Not logged in — visit /admin/login")

  const sessionToken = match[1]
  const expiry = activeSessions.get(sessionToken)
  if (!expiry || Date.now() > expiry) {
    activeSessions.delete(sessionToken)
    throw new EngineError(401, "unauthorized", "Session expired — please log in again")
  }
}

/** POST /admin/logout — clear session */
export function handleLogout(req: Request): string {
  const cookies = req.headers.get("Cookie") ?? ""
  const match = cookies.match(/ghost_bazaar_admin=([a-f0-9]{64})/)
  if (match) activeSessions.delete(match[1])
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/admin; Max-Age=0`
}
```

**Security properties:**
- `HttpOnly` — JavaScript cannot read the cookie (XSS protection)
- `Secure` — cookie only sent over HTTPS
- `SameSite=Strict` — cookie not sent on cross-origin requests (CSRF protection)
- Session token is random 32 bytes, NOT the `ADMIN_TOKEN` itself
- 24-hour expiry, in-memory session store (lost on restart = re-login required)
- `timingSafeEqual` on password check prevents timing attacks

**Session sweep (Codex Fix #3 + R3 Fix #3):** `activeSessions` Map is swept on BOTH
login and auth check. Hard cap of 50 active sessions enforced at login time.

```typescript
// Shared sweep helper — called from both login and auth check
function sweepExpiredSessions(): void {
  const now = Date.now()
  for (const [tok, exp] of activeSessions) {
    if (now > exp) activeSessions.delete(tok)
  }
}

// In handleLogin(), BEFORE issuing new session:
sweepExpiredSessions()
if (activeSessions.size >= 50) {
  return null  // → 429 Too Many Sessions
}

// In requireAdminAuth(), BEFORE checking the caller's token:
sweepExpiredSessions()
```

**Why this works for SSE:** `EventSource` automatically sends cookies — no custom headers needed. This was a blocking issue with Bearer token auth.

### `GET /admin/sessions` — Paginated, filterable

```typescript
// Query params: ?limit=50&offset=0&state=NEGOTIATING&sort=updated_at
{
  total: 203,
  limit: 50,
  offset: 0,
  sessions: [
    {
      rfq_id: "...",
      state: "NEGOTIATING",
      buyer: "did:key:z6Mk...",
      service_type: "smart-contract-audit",
      anchor_price: "45.00",
      currency: "USDC",
      offer_count: 3,
      seller_count: 2,
      selected_seller: null,
      final_price: null,
      created_at: "2026-03-21T...",
      last_event_at: "2026-03-21T...",
      deadline: "2026-03-21T..."
    }
  ]
}
```

### `GET /admin/sessions/:id` — Single session detail

Returns full DerivedSession (sanitized): state, rfq, offers, counters, selectedSeller, signatures, quoteRevision.

### `GET /admin/sessions/:id/events` — Dual-mode (JSON + SSE)

- JSON: All events + session summary header (`{ session: {...}, events: [...] }`)
- SSE: Live stream with `state_after` field on each event

**SSE design (Codex R3 Fix #2 — replay-to-live safety):**

Admin SSE uses the same 2-phase buffered activation protocol as participant SSE,
but implemented via `onAppend()` instead of `subscribeFrom()`:

```
Phase 1: Register observer in BUFFERING mode (events go to buffer, not client)
Phase 2: Read replay from eventStore.getAllEvents(rfqId) with optional ?after cursor
Phase 3: Deduplicate buffer against replay (same as subscribeFrom)
Phase 4: Send replay → send buffered → activate() switches to live mode
```

```typescript
// Admin SSE per-session handler:
const buffer: NegotiationEvent[] = []
let mode: "buffering" | "live" = "buffering"

const unsub = sessionManager.onAppend((event, session) => {
  if (event.rfq_id !== rfqId) return  // filter to this session
  if (mode === "buffering") { buffer.push(event); return }
  // live mode — send to SSE client with state_after
  stream.write(`data: ${JSON.stringify({ ...event, state_after: session.state })}\n\n`)
})

// Replay from DB
const replay = eventStore.getAllEvents(rfqId)
// Dedupe buffer against replay
const replayIds = new Set(replay.map(e => e.event_id))
const deduped = buffer.filter(e => !replayIds.has(e.event_id))
// Send replay, send deduped buffer, switch to live
mode = "live"

// On disconnect: unsub()
```

This restores the same replay-to-live correctness guarantee as the participant route.

**Connection tracking**: Dedicated admin connection tracker (max 5 admin SSE connections total, concrete records for cleanup).

### `GET /admin/stats` — Extended metrics

Same as `/dashboard/stats` plus:
- `cache_size`, `db_size_bytes`, `sse_connections` (protocol + admin)
- Per-session breakdown not available on public endpoint

---

## Files

| File | Action | Lines (est.) |
|------|--------|-------------|
| `src/stats/stats-collector.ts` | Create | ~100 (aggregator + startup replay from raw events) |
| `src/middleware/admin-auth.ts` | Create | ~80 (login + cookie + logout + session sweep) |
| `src/routes/dashboard.ts` | Create | ~120 (stats + activity + feed SSE + privacy + comparison) |
| `src/routes/admin.ts` | Create | ~150 (sessions list + detail + events + stats) |
| `src/state/session-manager.ts` | Modify | ~10 (add onAppend observer list + notify in appendEvent) |
| `src/server.ts` | Modify | ~20 (wire routes + StatsCollector + login/logout + observers) |
| `tests/dashboard.test.ts` | Create | ~80 (stats + feed + privacy + comparison) |
| `tests/admin.test.ts` | Create | ~120 (login + cookie + sessions + events + logout) |

## Security Summary

| Concern | Public Dashboard | Admin Panel |
|---------|-----------------|-------------|
| DID exposure | Never (count only) | Full (behind token) |
| Price exposure | Never | Full (behind token) |
| Session IDs | Never | Full (behind token) |
| Event payloads | Never | Full (behind token, private fields never stored) |
| Auth | None needed | Session cookie (httpOnly + Secure + SameSite=Strict) |
| Login | N/A | POST /admin/login → cookie, POST /admin/logout → clear |
| Rate limit | Cacheable (static aggregates) | Cookie-gated, 24h session expiry, max 50 sessions |
| CORS | Safe (no sensitive data) | SameSite=Strict blocks cross-origin |
| SSE auth | No auth (public feed) | EventSource auto-sends cookie — works natively |
| SSE abuse | Max 100 public feed connections | Max 5 admin SSE connections |
| ADMIN_TOKEN | N/A | Only used at POST /admin/login — never reaches browser JS |
| Cookie cleared | N/A | Re-visit /admin/login, enter password again |

## Codex + Agent Review Findings Addressed

| Finding | Source | Resolution |
|---------|--------|-----------|
| Token must stay server-side | Codex HIGH | Session cookie auth — ADMIN_TOKEN only used at login, never in browser JS |
| timingSafeEqual required | Security agent HIGH | Used in login password check |
| SSE can't set custom headers | Security agent HIGH | Cookie auth — EventSource sends cookies natively |
| EventStore abstraction overreach | Codex R2 HIGH | Replaced subscribeAll() with SessionManager.onAppend() observer — no EventStore changes |
| seller_index cross-session linkage | Codex R2 HIGH | Removed seller_index, only expose actor_role: "buyer"/"seller" |
| Pagination/filtering needed | Completeness HIGH | Added ?limit&offset&state on /admin/sessions |
| Missing session detail endpoint | Completeness HIGH | Added GET /admin/sessions/:id |
| Missing session list fields | Completeness HIGH | Added service_type, anchor_price, currency, seller_count, last_event_at, final_price |
| onAppend() leaks SSE observers | Codex R3 HIGH | Returns unsubscribe function, SSE calls it on disconnect |
| Admin SSE replay-to-live gap | Codex R3 HIGH | 2-phase buffer+activate protocol, same as participant route |
| admin activeSessions not enforced on login | Codex R3 MEDIUM | sweepExpiredSessions() on both login + auth check, reject at 50 |
| StatsCollector needs per-session ledger | Codex R3 MEDIUM | Added sessionLedger Map for correct state-transition counting |
| admin activeSessions memory leak | Codex R2 MEDIUM | Sweep on auth check + hard cap 50 sessions |
| Startup replay fills sessionCache | Codex R2 MEDIUM | StatsCollector reads raw events from EventStore, not via SessionManager |
| Public SSE no connection limit | Codex R2 MEDIUM | Max 100 concurrent /dashboard/feed connections |
| Summary table contradictions | Codex R2 MEDIUM | Fixed — tables match route definitions |
| SSE needs state_after | Completeness MEDIUM | Added to admin SSE event payload |
| Admin connection tracking too weak | Codex MEDIUM | Dedicated admin tracker with concrete records |
