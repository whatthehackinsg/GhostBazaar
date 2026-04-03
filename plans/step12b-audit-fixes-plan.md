# Step 12b: Audit Fixes — Memory, Performance, Security

## Context

4-agent parallel audit of the engine found 8 actionable issues across memory leaks, performance, and security. This plan fixes all 8 in dependency order.

## Fix Order

Fixes are grouped by dependency — #4 must go first (shared module that #1 and #5 depend on), then the rest can be done in parallel.

---

### Fix #4: Extract `isEventVisibleTo` to shared module (Security — HIGH)

**Problem**: Identical 50-line function copy-pasted in `event-store.ts` and `sqlite-event-store.ts`. Future edits to one without the other = visibility divergence (seller sees wrong events).

**Files**:
- Create: `src/state/visibility.ts`
- Modify: `src/state/event-store.ts` — delete local function, import from visibility
- Modify: `src/state/sqlite-event-store.ts` — delete local function, import from visibility

**Change**:
```typescript
// src/state/visibility.ts
export function isEventVisibleTo(event, callerDid, rfq): boolean { ... }
export function deepFreeze<T extends object>(obj: T): Readonly<T> { ... }
export const TERMINAL_EVENT_TYPES: ReadonlySet<EventType> = new Set([...])
```

Both `deepFreeze` and `TERMINAL_EVENT_TYPES` are also duplicated — extract all three.

---

### Fix #1: Remove unbounded `seenEventIds` from SqliteEventStore (Memory — CRITICAL)

**Problem**: `seenEventIds` Set loads ALL historical event_ids at startup, grows forever. At 100k events = ~5MB of strings in memory, never freed.

**File**: `src/state/sqlite-event-store.ts`

**Change**:
- Delete `seenEventIds` Set field entirely
- Delete the startup loop that loads all event_ids
- In `append()`: replace `seenEventIds.has()` check with a try/catch around `stmtInsert.run()` that catches the UNIQUE constraint error
- Delete `stmtAllEventIds` prepared statement

```typescript
// Before:
if (this.seenEventIds.has(event.event_id)) {
  throw new Error(`duplicate event_id "${event.event_id}"`)
}
this.stmtInsert.run(...)
this.seenEventIds.add(event.event_id)

// After:
try {
  this.stmtInsert.run(...)
} catch (err: unknown) {
  if (err instanceof Error && err.message.includes("UNIQUE constraint failed")) {
    throw new Error(`EventStore.append: duplicate event_id "${event.event_id}"`)
  }
  throw err
}
```

**InMemoryEventStore**: Keep its `seenEventIds` — it has no DB constraint to rely on. But it only lives for the process lifetime, so unbounded growth is acceptable for dev/test use.

---

### Fix #2: Wire `EnvelopeTombstones.sweep()` into DeadlineEnforcer (Memory — HIGH)

**Problem**: `sweep()` method exists but is never called. Tombstone Map grows forever.

**Files**:
- Modify: `src/deadline-enforcer.ts` — accept `tombstones` in config, call `sweep()` at end of `scan()`
- Modify: `src/server.ts` — pass `tombstones` to enforcer config

**Change in deadline-enforcer.ts**:
```typescript
interface DeadlineEnforcerConfig {
  // ... existing fields
  tombstones?: { sweep(): void }  // optional to not break tests
}

// At end of scan():
this.config.tombstones?.sweep()
```

**Change in server.ts**:
```typescript
const enforcer = new DeadlineEnforcer({
  sessionManager,
  eventStore,
  connectionTracker,
  tombstones,  // new
  intervalMs: ENFORCER_INTERVAL_MS,
  cosignTimeoutMs: COSIGN_TIMEOUT_MS,
})
```

---

### Fix #3: Cache `deriveState()` result in SessionManager (Performance — HIGH)

**Problem**: `deriveState()` replays all events from scratch 3-4 times per append request (route pre-check, withLock, dry-run, enforcer). 100-event session = 300-400 event replays per request.

**File**: `src/state/session-manager.ts`

**Change**:
Add a cache Map that stores `{ eventCount: number, session: DerivedSession }`. Invalidate when eventCount changes.

```typescript
private readonly sessionCache = new Map<string, { eventCount: number; session: DerivedSession }>()

getSession(rfqId: string): DerivedSession | null {
  const events = this.eventStore.getAllEvents(rfqId)
  if (events.length === 0) return null

  const cached = this.sessionCache.get(rfqId)
  if (cached && cached.eventCount === events.length) {
    return cached.session
  }

  const session = deriveState(events)
  this.sessionCache.set(rfqId, { eventCount: events.length, session })
  return session
}
```

After `appendEvent()` succeeds, invalidate:
```typescript
this.sessionCache.delete(rfqId)
```

Cache is invalidated by event count, not event content — simple and safe since events are append-only.

---

### Fix #5: Remove redundant `structuredClone` in SqliteEventStore (Performance — MEDIUM)

**Problem**: `rowToEvent()` calls `deepFreeze()` which internally calls `Object.freeze`. But `structuredClone` is unnecessary — `JSON.parse()` already produces a fresh object graph with no shared references.

**File**: `src/state/sqlite-event-store.ts`

**Change in `rowToEvent()`**:
```typescript
// Before:
return deepFreeze(structuredClone({ ... }))  // wait, it doesn't use structuredClone

// Actually check: rowToEvent uses deepFreeze directly on a new object literal
// The object is already fresh (not shared). deepFreeze is correct, no structuredClone present.
// BUT: append() line 220 does structuredClone(event) for subscriber notification.
// Fix: Since the event fields are already extracted into the INSERT params,
// build frozenEvent from those extracted values instead of cloning the caller's object.
```

In `append()`:
```typescript
// Before:
const frozenEvent = deepFreeze(structuredClone(event))

// After: Build from the values we already inserted (no shared refs)
const frozenEvent = deepFreeze({
  event_id: event.event_id,
  rfq_id: rfqId,
  type: event.type,
  actor: event.actor,
  timestamp: event.timestamp,
  payload: JSON.parse(JSON.stringify(event.payload)),
} as NegotiationEvent)
```

This avoids `structuredClone` overhead while maintaining the immutability guarantee.

---

### Fix #6: Enforcer active-session tracking (Performance — MEDIUM)

**Problem**: Enforcer calls `listSessionIds()` → `SELECT DISTINCT session_id` (table scan), then `getSession()` for each (uncached before Fix #3). O(sessions × events).

**Files**:
- Modify: `src/state/session-manager.ts` — expose `getTerminalSessionIds()` or filter in getActiveSessionIds
- Modify: `src/deadline-enforcer.ts` — skip sessions in `cleanedUpSessions`

**Change**: With Fix #3 (cache), `getSession()` is now cheap. The enforcer already has `cleanedUpSessions` to skip terminal ones. The remaining optimization is:

```typescript
// In scan(), filter early:
const allIds = this.config.sessionManager.getActiveSessionIds()
const toScan = allIds.filter(id => !this.cleanedUpSessions.has(id))
```

This is already partially implemented. Combined with Fix #3's cache, this becomes efficient.

---

### Fix #7: Add SQLite max DB size pragma (Security — MEDIUM)

**Problem**: No limit on database growth. Attacker could create unlimited sessions/events to fill disk.

**File**: `src/state/sqlite-event-store.ts`

**Change**: Add in constructor after WAL mode:
```typescript
// Defense-in-depth: cap DB at ~1 GB (262144 pages × 4 KB)
this.db.pragma("max_page_count = 262144")
```

This causes SQLite to throw `SQLITE_FULL` when the limit is reached, which propagates as a 500 error. The 1 GB limit is generous — 10 million events would only be ~200 MB.

---

### Fix #8: Bound `cleanedUpSessions` Set (Memory — MEDIUM)

**Problem**: `cleanedUpSessions` Set adds one entry per terminal session, never removes. Over months = unbounded growth.

**File**: `src/deadline-enforcer.ts`

**Change**: Clear the set when it exceeds a threshold, since the enforcer's scan already re-derives state and skips terminal sessions naturally:

```typescript
// At end of scan():
if (this.cleanedUpSessions.size > 10_000) {
  this.cleanedUpSessions.clear()
}
```

Clearing is safe — the worst case is re-deriving a terminal session once on the next scan, which is cheap with Fix #3's cache.

---

## Implementation Order

```
Fix #4 (shared visibility module)
  ↓
Fix #1 (remove seenEventIds from SQLite) ←── depends on #4 (imports from shared module)
Fix #5 (remove structuredClone)          ←── depends on #4 (imports from shared module)
  ↓
Fix #2 (wire tombstones.sweep)           ←── independent
Fix #3 (deriveState cache)               ←── independent
Fix #7 (max_page_count pragma)           ←── independent
Fix #8 (bound cleanedUpSessions)         ←── independent
  ↓
Fix #6 (enforcer active-session)         ←── depends on #3 (cache makes this effective)
```

Fixes #2, #3, #7, #8 can be done in parallel after #4.

## Verification

1. `pnpm --filter @ghost-bazaar/engine build` — zero TS errors
2. `pnpm --filter @ghost-bazaar/engine test` — 322 tests still pass
3. Manual: start server, verify health + listings + auth still work
4. Verify `isEventVisibleTo` imported from single source in both stores
