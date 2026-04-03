# Engine Performance Audit

## Finding 1: deriveState() replays ALL events on EVERY call — O(n) per request, O(n^2) per append

**Severity: HIGH** | **Impact: ~2-5x latency degradation at 50+ events/session**

`SessionManager.getSession()` calls `getAllEvents()` + `deriveState()` (full replay). This happens:
- Once in `withLock()` (line 173, session-manager.ts)
- Once in `appendEvent()` for dry-run validation (line 204) — *after* `getAllEvents()` on line 199
- Once in each route handler *before* `withLock()` for pre-checks (events.ts:67, offers.ts:83, accept.ts:88, etc.)
- Once per session in `DeadlineEnforcer.scan()` (deadline-enforcer.ts:96)
- Once in events.ts SSE setup for terminal check (line 208)

**Total per append: 3-4 full replays.** With 100 events/session, that is 300-400 event-reduce iterations per request.

**Fix:** Cache `DerivedSession` in `SessionManager`, keyed by `(rfqId, lastEventId)`. Invalidate on append. The `withLock` call already serializes writes, so the cache is trivially consistent. Pre-lock `getSession` calls in routes can use a slightly stale cache (acceptable for pre-checks). Estimated improvement: 3-4x reduction in CPU per request.

---

## Finding 2: structuredClone + deepFreeze on SQLite reads — unnecessary overhead

**Severity: MEDIUM** | **Impact: ~10-20% overhead on read-heavy paths**

`SqliteEventStore.rowToEvent()` (line 92) calls `deepFreeze(structuredClone(...))` on every row. But SQLite rows are *already* independent objects — `JSON.parse` on `row.payload` creates a fresh object graph. There are no shared references to protect against.

`deepFreeze` is O(n) in object property count. For a typical event payload (10-15 fields nested 2-3 levels), this is ~50 property visits per event.

`InMemoryEventStore.append()` does need `structuredClone + deepFreeze` because the caller passes a mutable object. But `rowToEvent` builds a *new* object literal — freeze is sufficient, clone is wasted work.

**Fix:** In `SqliteEventStore.rowToEvent()`, use `Object.freeze` on the top-level object only (payload is already a fresh parse). Drop `structuredClone`. Estimated: ~15% reduction in read latency.

---

## Finding 3: DeadlineEnforcer scans ALL sessions every tick — O(n) where n = total sessions ever

**Severity: MEDIUM** | **Impact: linear growth, problematic at 10K+ sessions**

`scan()` calls `getActiveSessionIds()` which runs `SELECT DISTINCT session_id FROM events` — a full table scan in SQLite (no covering index on session_id alone). Then for each non-cleaned-up session, it calls `getSession()` (full event replay).

The `cleanedUpSessions` set mitigates this for terminal sessions, but only after one scan post-terminal. Sessions that reach terminal state but whose lock is still held (line 102 — `removeLock` returns false) will be re-scanned every tick.

**Fix:**
1. Add a covering index: `CREATE INDEX idx_events_session_only ON events(session_id)`.
2. Maintain an in-memory set of active (non-terminal) session IDs in `SessionManager`. Only scan those.
3. With cached `DerivedSession` (Finding 1), the per-session cost drops from O(events) to O(1).

---

## Finding 4: getAfterCursor correlated subquery — double index lookup

**Severity: LOW** | **Impact: ~0.5ms overhead per cursor-based poll**

```sql
SELECT * FROM events WHERE session_id = ? AND id > (
  SELECT id FROM events WHERE session_id = ? AND event_id = ?
) ORDER BY id
```

The subquery requires `idx_events_cursor(session_id, event_id)` to find the cursor row's `id`, then the outer query uses `idx_events_session(session_id, id)` for the range scan. This is two separate index lookups.

**Fix:** Since `hasCursor()` is always called first (line 265), its result could return the numeric `id` directly. Then `getAfterCursor` becomes a simple `WHERE session_id = ? AND id > ?` — single index scan. Estimated: ~30% faster cursor polls.

---

## Finding 5: FIFO mutex queue — Array.splice on timeout is O(n)

**Severity: LOW** | **Impact: negligible unless >100 concurrent waiters per session**

`SessionLock.waitForTurn()` timeout handler (line 94) calls `this.waiters.splice(idx, 1)` — O(n) in queue length. Under extreme contention (100+ waiters), this becomes measurable. The `maxQueueSize` of 10 limits this in practice.

**Fix:** Switch to a linked list for O(1) removal. Not urgent — the queue cap of 10 makes this a non-issue today.

---

## Finding 6: JSON.stringify per SSE event — redundant for SQLite path

**Severity: LOW** | **Impact: ~5% overhead on SSE streams**

In `events.ts`, every SSE event is serialized via `JSON.stringify(event)` (lines 177, 199, 204). For the SQLite path, the payload was just *parsed* from a JSON string in `rowToEvent()` and then immediately re-serialized for SSE delivery.

**Fix:** Store the raw JSON string alongside the parsed event in SQLite reads. Return it through the event pipeline so SSE can emit the pre-serialized form. This avoids parse-then-serialize round-trips.

---

## Finding 7: seenEventIds set grows unbounded

**Severity: LOW** | **Impact: memory growth, ~100 bytes per event**

`SqliteEventStore.seenEventIds` loads ALL event IDs from the DB at startup (line 189) and never prunes. At 1M events, this is ~100MB of string storage in the Set.

**Fix:** Since SQLite already enforces `UNIQUE(event_id)`, the dedup check can be a DB query (`INSERT OR IGNORE` or catch the constraint violation). Or, prune the set periodically for terminal sessions.

---

## Finding 8: isEventVisibleTo is O(1) per event — acceptable

The visibility filter is a simple switch statement. O(n) total for n events per read is the theoretical minimum. No optimization needed.

---

## Finding 9: 5s lock timeout — appropriate for agent-to-agent protocol

The 5s timeout with a queue cap of 10 is reasonable for an agent-to-agent negotiation protocol where request durations are typically <100ms. The concern would be if LLM strategy calls happen inside the lock, but those appear to happen before the lock is acquired in route handlers.

---

## Priority Ranking

| # | Finding | Severity | Effort | ROI |
|---|---------|----------|--------|-----|
| 1 | Cache deriveState | HIGH | Medium | **Highest** — eliminates 3-4x redundant replays |
| 2 | Drop structuredClone in SQLite reads | MEDIUM | Low | High — simple change, measurable gain |
| 3 | Optimize DeadlineEnforcer scanning | MEDIUM | Medium | High at scale |
| 4 | Optimize cursor subquery | LOW | Low | Moderate |
| 6 | Avoid JSON re-serialization for SSE | LOW | Medium | Moderate |
| 7 | Prune seenEventIds | LOW | Low | Prevents memory leak |
| 5 | Linked-list for lock waiters | LOW | Low | Negligible (capped at 10) |
