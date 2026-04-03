# Step 12c: Codex Performance Fixes

## Context

Codex final deep-dive found 4 performance issues. No correctness bugs, no new memory leaks — these are scalability bottlenecks that matter at >100 sessions.

---

### Fix A: `listSessionIds()` full index scan (HIGH)

**Problem**: `SELECT DISTINCT session_id FROM events` scans the entire `idx_events_session` index every enforcer tick (~5s in prod) AND every `/health` request. Cost grows with total historical events, not active sessions.

**Solution**: Add an in-memory `activeSessionIds: Set<string>` to SqliteEventStore, maintained on `append()` and populated from DB on startup. `listSessionIds()` returns this set instead of querying.

**Files**:
- `src/state/sqlite-event-store.ts` — add `activeSessionIds` Set, populate in constructor, update in `append()`
- `listSessionIds()` → `return [...this.activeSessionIds]`

**Why not a separate `sessions` table?** Over-engineering for current scale. The in-memory Set is O(1) on append, O(n) on startup (one query), and eliminates the per-tick scan. If we later need multi-process, we add the table then.

---

### Fix B: `deriveState()` array spread copies (MEDIUM)

**Problem**: Two spread-copy lines in `deriveState()`:
- L196: `offers = [...offers, offer]` — creates new array on every OFFER_SUBMITTED
- L230: `counters = [...counters, counter]` — creates new array on every COUNTER_SENT

For a session with 50 offers, that's 50 × O(n) = O(n²) copies.

**Solution**: Use mutable `push()` inside `deriveState()`. The `offers` and `counters` variables are local to the function — they're never shared outside. The returned `DerivedSession` is frozen by the caller (SessionManager cache), so mutation during construction is safe.

**File**: `src/state/session.ts`

```typescript
// Before:
offers = [...offers, offer]
counters = [...counters, counter]

// After:
offers.push(offer)
counters.push(counter)
```

**Why is this safe?** `offers` and `counters` are declared as `let` locals at the top of `deriveState()`. They're never leaked mid-construction. The `DerivedSession` returned is frozen by the cache layer. This follows the same pattern as `InMemoryEventStore.events` (mutable push, frozen on read).

---

### Fix C: `sessionCache` TTL for non-terminal sessions (MEDIUM)

**Problem**: `sessionCache` entries for OPEN/NEGOTIATING sessions persist forever if never reaching terminal state (abandoned negotiations). Each entry holds a full `DerivedSession` with offers, counters, maps.

**Solution**: Add a `lastAccessedAt` timestamp to cache entries. During enforcer scan (which already iterates sessions), evict cache entries not accessed in the last 5 minutes.

**File**: `src/state/session-manager.ts`

```typescript
// Cache entry shape:
{ eventCount: number; session: DerivedSession; lastAccessedAt: number }

// In getSession(): update lastAccessedAt = Date.now()

// New method: evictStaleCache(maxAgeMs: number)
//   for (const [rfqId, entry] of sessionCache)
//     if (Date.now() - entry.lastAccessedAt > maxAgeMs) sessionCache.delete(rfqId)
```

**File**: `src/deadline-enforcer.ts` — call `sessionManager.evictStaleCache(300_000)` at end of scan (alongside tombstones.sweep).

---

### Fix D: `tombstones.sweep()` linear scan optimization (LOW)

**Problem**: `sweep()` iterates the entire tombstone Map every enforcer tick. At high throughput (1000 envelopes/hour with 1-hour retention), this scans 1000 entries per tick.

**Solution**: Track a `nextExpiry` timestamp. Skip the sweep entirely if `Date.now() < nextExpiry`. This converts most ticks from O(n) to O(1).

**File**: `src/security/control-envelope.ts`

```typescript
private nextExpiry = Infinity

use(envelopeId: string, retentionMs = 3_600_000): void {
  const expiry = Date.now() + retentionMs
  this.tombstones.set(envelopeId, expiry)
  if (expiry < this.nextExpiry) this.nextExpiry = expiry
}

sweep(): void {
  const now = Date.now()
  if (now < this.nextExpiry) return  // fast path: nothing expired yet
  let minExpiry = Infinity
  for (const [id, expiry] of this.tombstones) {
    if (now >= expiry) {
      this.tombstones.delete(id)
    } else if (expiry < minExpiry) {
      minExpiry = expiry
    }
  }
  this.nextExpiry = minExpiry
}
```

---

## Implementation Order

```
Fix B (array push)     — independent, 2 lines
Fix D (sweep fast-path) — independent, ~10 lines
  ↓
Fix A (activeSessionIds) — independent, ~20 lines
Fix C (cache TTL)       — depends on enforcer wiring, ~20 lines
```

All four are independent of each other except Fix C needs the enforcer to call `evictStaleCache()`.

## Verification

1. `pnpm --filter @ghost-bazaar/engine build` — zero TS errors
2. `pnpm --filter @ghost-bazaar/engine test` — 322 tests pass
3. Start server locally — verify health, listings, auth
