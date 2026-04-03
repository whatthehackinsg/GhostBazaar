# Step 9: Events SSE Route — Design Document

> Round 1: Gemini (conditional pass), Codex (6.8/10)
> Round 2: Gemini (PASS, 0 findings), Codex (FAIL 6.6 → 4 findings fixed below)

## Overview

**Route**: `GET /rfqs/:id/events`
**Purpose**: Dual-mode event streaming — SSE for real-time consumers, JSON for polling/debugging.
**Spec reference**: §8 "append-only event stream"

The EventStore already provides role-scoped `getEvents()` and `subscribe()`. This route is an HTTP adapter **plus a small infrastructure extension** — it adds `subscribeFrom()` for atomic replay+subscribe, `hasCursor()` for cursor validation, a `ConnectionTracker` for resource limits, and a session-level terminal notification mechanism.

---

## Route Interface

```
GET /rfqs/:id/events

Query params:
  ?after=<event_id>       Optional cursor — replay events after this ID

Headers:
  Accept: text/event-stream    → SSE streaming mode
  Accept: application/json     → JSON polling mode (default)
  Last-Event-ID: <event_id>    → SSE reconnect cursor (overrides ?after)
  Authorization: GhostBazaar-Ed25519 <did> <timestamp> <signature>
```

### Authentication

Same `authenticateCaller` injectable pattern as `quote-read.ts`. Caller DID extracted and verified before any data access.

### Participant Check

Caller must be one of:
- `rfq.buyer` — sees all events (protocol-intended information advantage)
- A seller who has submitted at least one offer — sees role-scoped events

Third parties → 401 Unauthorized.

**Design decision (F5)**: Prospective sellers who haven't submitted an offer cannot subscribe. They should use `GET /rfqs/:id` to check session status first. The events route is for active participants only.

### Session Requirement

Session must exist → 404 `session_not_found`.

---

## Cursor Semantics (F2 fix)

Cursors are `event_id` strings. The EventStore uses them as positional markers in the ordered event log.

### Cursor Validation

The current `getEvents(afterId)` returns `[]` for both "no new events" and "invalid cursor." This is ambiguous. We add explicit cursor validation:

- **Valid cursor, no new events**: `{ events: [], cursor: "<same_cursor>", cursor_valid: true }`
- **Invalid/stale cursor**: JSON mode returns `400 invalid_cursor`. SSE mode sends `event: error\ndata: {"code":"invalid_cursor"}\n\n` then closes.
- **No cursor (omitted)**: Replay from the beginning of the session.

### Implementation

Add `hasCursor(rfqId: string, eventId: string): boolean` to the `EventStore` interface. This checks if the event_id exists **in the session's own event log**, not in any global index.

**CRITICAL (Codex R2-F1)**: The current `InMemoryEventStore.seenEventIds` is a **global** set across all sessions. Using it for cursor validation would accept a cursor from session A as valid in session B (cross-session cursor confusion). Instead, `hasCursor()` must scan the session's own `events` array:

```typescript
hasCursor(rfqId: string, eventId: string): boolean {
  const log = this.events.get(rfqId)
  if (!log) return false
  return log.some(e => e.event_id === eventId)
}
```

For MVP with short-lived sessions (< 500 events), linear scan is negligible (~0.01ms). If performance becomes a concern, add a per-session `Set<string>` index alongside the event array.

### Cursor Precedence (SSE mode)

1. `Last-Event-ID` header (set automatically by EventSource on reconnect)
2. `?after` query parameter
3. No cursor → replay all

---

## SSE Streaming Mode

### Connection Lifecycle

```
Client connects
  → Authenticate caller
  → Validate session exists + participant check
  → Validate cursor (if provided)
  → Atomic replay+subscribe (F1 fix)
  → Stream events as SSE messages
  → Heartbeat every 15s
  → Close on terminal state or client disconnect
```

### SSE Message Format

```
id: <event_id>
event: negotiation
data: <JSON-serialized NegotiationEvent>

```

Each message uses:
- `id:` — enables automatic `Last-Event-ID` on reconnect
- `event: negotiation` — named event type (clients listen with `addEventListener("negotiation", ...)`)
- `data:` — single-line JSON of the event object

### Heartbeat

```
: heartbeat

```

SSE comment (colon prefix) — keeps proxies/load balancers alive without triggering client event listeners. Interval: 15 seconds.

### Terminal State Close (F3 fix, Codex R2-F3 refinement)

The stream must close when the session reaches a terminal state. This is role-independent — **every** connected client should be notified, not just those who see the terminal event.

**The problem (Codex R2-F3)**: Non-winning sellers don't see `QUOTE_COMMITTED` (it's filtered to the selected seller only). If we only check visible events, their streams hang until the deadline enforcer expires the session.

**Solution: Session-level terminal notification via EventStore**

Add a `subscribeTerminal()` method to EventStore that fires when any event transitions the session to a terminal state. This is **not** role-scoped — it's a session lifecycle signal, not a data event.

```typescript
/**
 * Subscribe to session terminal state notification.
 * Fires once when the session reaches COMMITTED/EXPIRED/CANCELLED.
 * Not role-scoped — this is a lifecycle signal, not a data event.
 * The callback receives the terminal state name.
 */
subscribeTerminal(
  rfqId: string,
  listener: (terminalState: string) => void,
): () => void
```

**SSE close behavior**:
1. On receiving a terminal notification → send `event: terminal\ndata: {"state":"COMMITTED"}\n\n` → close stream
2. The `terminal` event is a **control event** (not a negotiation event) — it tells the client the session is over without leaking what happened
3. On replay: if session is already terminal at connect time, send all visible replay events + the terminal control event, then close immediately

**Role-specific behavior**:
| Role | Sees terminal data event? | Gets terminal control event? | Stream closes? |
|------|--------------------------|------------------------------|----------------|
| Buyer | Yes (QUOTE_COMMITTED / EXPIRED / CANCELLED) | Yes | Yes |
| Winning seller | Yes (QUOTE_COMMITTED) | Yes | Yes |
| Non-winning seller | Only EXPIRED/CANCELLED | Yes (always) | Yes |

### Disconnect Cleanup

On client disconnect (Hono's `c.req.raw.signal` abort event):
1. Call the unsubscribe function returned by `subscribeFrom()`
2. Clear the heartbeat interval
3. Decrement the per-DID connection counter

---

## Atomic Replay+Subscribe (F1 fix)

### The Problem

`getEvents()` and `subscribe()` are separate calls. An event appended between them is lost.

### Solution: `subscribeFrom()` on EventStore

Add a new method to the `EventStore` interface:

```typescript
/**
 * Atomically replay events after a cursor and subscribe for new ones.
 * Eliminates the gap between getEvents() and subscribe().
 *
 * Two-phase design (Codex R2-F2 fix):
 * Phase 1 (subscribeFrom call): Subscribe + replay + buffer. Returns replay
 *   events and any buffered live events in strict append order. The listener
 *   is NOT called during this phase — all events are returned as arrays.
 * Phase 2 (activate call): The route calls activate() after flushing all
 *   replay+buffered events to the SSE stream. Only then does the listener
 *   begin receiving new live events directly.
 *
 * This guarantees: replay events are sent BEFORE any live events. No out-of-
 * order delivery is possible because live delivery is gated on explicit
 * activation by the route.
 */
subscribeFrom(
  rfqId: string,
  callerDid: string,
  rfq: Pick<RFQ, "buyer">,
  afterId: string | undefined,
  listener: (event: NegotiationEvent) => void,
): {
  /** Historical events after cursor (role-scoped). */
  replay: readonly NegotiationEvent[]
  /** Events that arrived between subscribe and replay completion (deduped). */
  buffered: readonly NegotiationEvent[]
  /** Call after flushing replay+buffered to SSE. Enables live delivery to listener. */
  activate: () => void
  /** Unsubscribe and stop all delivery. */
  unsubscribe: () => void
}
```

### InMemoryEventStore Implementation

**Ordering contract**: Events delivered to the client are always in append order:
`[...replay, ...buffered, ...live]`. No live event is ever delivered before
the full replay+buffered prefix.

```
Phase 1 (inside subscribeFrom):
  1. Register subscriber in BUFFERING mode (incoming events → buffer array)
  2. Call getEvents(rfqId, callerDid, rfq, afterId) for historical replay
  3. Build a Set<string> of replay event IDs
  4. Filter buffer: remove any event whose event_id is in the replay set
  5. Return { replay, buffered, activate, unsubscribe }
     (listener has NOT been called yet)

Phase 2 (route calls activate() after flushing replay+buffered to SSE):
  6. Switch subscriber from BUFFERING to LIVE mode
  7. Any events that arrived between step 5 and step 6 are in the buffer
     → flush them to listener in order, then switch to direct delivery
  8. From this point, new events go directly to listener
```

This is safe because:
- `append()` is synchronous (single-threaded JS) — no event can be appended
  during a synchronous `activate()` call
- The subscriber is registered (step 1) before `getEvents()` reads (step 2)
- Any event appended between steps 1-5 is caught by the buffer
- Any event appended between steps 5-6 is caught by the buffer and flushed on activate
- Dedup by event_id is idempotent (events are globally unique UUIDs)
- The route controls when live delivery begins — no surprise out-of-order events

---

## JSON Polling Mode

### Response Format

```json
{
  "rfq_id": "abc-123",
  "events": [ /* NegotiationEvent[] */ ],
  "cursor": "evt-last-id",
  "cursor_valid": true
}
```

- `events`: Role-scoped filtered events after the cursor
- `cursor`: The `event_id` of the last event in the response. If `events` is empty and cursor was valid, returns the same cursor back. If no cursor was provided and session is empty (shouldn't happen — RFQ_CREATED always exists), returns `null`.
- `cursor_valid`: Always `true` in successful responses (invalid cursors return 400)

### Error Responses

| Status | Code | When |
|--------|------|------|
| 400 | `invalid_cursor` | Cursor event_id not found in session |
| 401 | `unauthorized` | Not a participant / auth failure |
| 404 | `session_not_found` | No session with this rfq_id |

---

## Connection Limits (F4 fix)

### Per-DID Cap

- Max **3 SSE connections per DID per session**
- Total cap: **10 SSE connections per session** (across all DIDs)
- **1 reserved slot** for `rfq.buyer` — even at 10/10, buyer can always connect (evicts oldest non-buyer connection if needed)

### Implementation (Codex R2-F4 fix)

The `ConnectionTracker` must track **concrete connection records** with identity, timestamps, and close callbacks to implement eviction.

```typescript
/** Opaque connection identifier */
type ConnectionId = string

/** A tracked SSE connection */
interface TrackedConnection {
  readonly connectionId: ConnectionId
  readonly rfqId: string
  readonly callerDid: string
  readonly isBuyer: boolean
  readonly openedAt: number        // Date.now() at acquire time
  readonly close: () => void       // Callback to send error event + close stream
}

interface ConnectionTracker {
  /**
   * Try to acquire a connection slot.
   * - If per-DID limit (3) reached → returns null (rejected)
   * - If session limit (10) reached AND caller is buyer → evicts oldest non-buyer, returns id
   * - If session limit (10) reached AND caller is NOT buyer → returns null (rejected)
   * - Otherwise → returns ConnectionId
   */
  acquire(conn: Omit<TrackedConnection, "connectionId" | "openedAt">): ConnectionId | null

  /** Release a connection slot (called on disconnect or eviction). */
  release(connectionId: ConnectionId): void

  /** Get connection count for a DID in a session. */
  countForDid(rfqId: string, callerDid: string): number

  /** Get total connection count for a session. */
  countForSession(rfqId: string): number

  /** Remove all connections for a session (called when session reaches terminal state). */
  closeAll(rfqId: string): void
}
```

**Eviction flow** (buyer connects, session at capacity):
1. Find all non-buyer connections for this session, sorted by `openedAt` ascending
2. If none found → reject even the buyer (all 10 are buyer connections — shouldn't happen in practice)
3. Evict the oldest: call `conn.close()` which sends `event: error\ndata: {"code":"evicted"}\n\n` then closes the SSE stream
4. `release()` the evicted connection
5. `acquire()` the new buyer connection

---

## Auth Expiry (F6 — documented, not fixed)

The `GhostBazaar-Ed25519` signature is validated at connection time only. SSE connections are inherently bounded by the session's `rfq.deadline` — the deadline enforcer (Step 10) will expire the session and close all streams. No mid-stream re-authentication is needed for the negotiation lifecycle.

---

## Deliverables

| File | Purpose |
|------|---------|
| `src/routes/events.ts` | Dual-mode events route + SSE streaming logic |
| `src/util/connection-tracker.ts` | Per-DID connection limit tracker with eviction support |
| `src/state/event-store.ts` | Add `subscribeFrom()` + `hasCursor()` + `subscribeTerminal()` to InMemoryEventStore |
| `src/types.ts` | Extend `EventStore` interface with `subscribeFrom()` + `hasCursor()` + `subscribeTerminal()` |
| `tests/events.test.ts` | Tests for both modes, cursor validation, connection limits, terminal close |
| `tests/connection-tracker.test.ts` | Dedicated tests for connection tracking + eviction logic |

---

## Test Plan

### JSON Mode
1. Returns all events for buyer (no cursor)
2. Returns filtered events for seller (role-scoped)
3. Cursor-based pagination returns only events after cursor
4. Invalid cursor returns 400 `invalid_cursor`
5. Non-participant gets 401
6. Non-existent session gets 404
7. Empty cursor_valid field is correct

### SSE Mode
8. Streams events in real-time as they're appended
9. `Last-Event-ID` overrides `?after` query param
10. Heartbeat sent every 15s (fake timers)
11. Stream closes on terminal state (COMMITTED/EXPIRED/CANCELLED)
12. Client disconnect triggers cleanup (unsubscribe + heartbeat clear)
13. Role-scoped: seller only sees own events in stream

### Atomic Replay+Subscribe (F1, R2-F2)
14. No event lost during replay-to-live handoff (concurrent append during subscribeFrom)
15. No duplicate events in stream (dedup works)
16. Strict ordering: replay events always before buffered, buffered before live
17. activate() flushes any events buffered between return and activation

### Terminal Close (F3, R2-F3)
18. Buyer stream closes on COMMITTED (sees QUOTE_COMMITTED + terminal event)
19. Winning seller stream closes on COMMITTED (sees QUOTE_COMMITTED + terminal event)
20. Non-winning seller stream closes on COMMITTED (gets terminal control event only)
21. All streams close on EXPIRED/CANCELLED (broadcast events + terminal event)
22. Already-terminal session at connect: replay events + terminal event, then close

### Connection Limits (F4, R2-F4)
23. 4th connection from same DID is rejected
24. 11th total connection is rejected
25. Buyer evicts oldest non-buyer when at capacity
26. Evicted connection receives error event before close
27. closeAll() terminates all connections for a session

### Cursor Validation (F2, R2-F1)
28. Valid cursor with no new events returns same cursor back
29. Invalid cursor returns 400 in JSON, error event + close in SSE
30. Cursor from different session is rejected (session-scoped validation)
