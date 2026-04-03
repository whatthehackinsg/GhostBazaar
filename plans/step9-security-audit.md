# Step 9 Events/SSE — Red Team Security Audit

## Finding 1: Cleanup Re-Entrancy Race — Double-Free of ConnectionTracker Slot

**Severity: HIGH**

**Location:** `events.ts` lines 221-230, 156-159, 177-179, 233

**Attack scenario:**
1. Attacker opens an SSE connection as a legitimate seller.
2. A terminal event fires, calling `cleanup()` from `subscribeTerminal` (line 179).
3. Simultaneously, the client aborts the connection, firing the `abort` event listener (line 233), which also calls `cleanup()`.
4. The `connectionId` null-check on line 225 prevents double-release of the tracker slot, BUT `clearInterval`, `sub.unsubscribe()`, and `unsubTerminal()` are all called twice without guards.
5. `unsubTerminal()` deletes the listener from the Set. On second call, `subs!.delete(listener)` is a no-op, but `subs!.size === 0` may trigger premature `terminalSubscribers.delete(rfqId)`, removing the map entry while another connection's terminal subscriber still exists in a different Set reference — this is safe only because each `subscribeTerminal` call captures its own `subs` closure. However, `sub.unsubscribe()` (the role subscriber) similarly does `subs!.delete(sub)` and may delete the rfqId key from `subscribers` map while other subscribers for the same session still exist in a **different** Set reference.

**Impact:** The double-call to `sub.unsubscribe()` is benign (Set.delete is idempotent). But `clearInterval` called twice with the same ID is undefined behavior in some runtimes. More critically, the `controller.close()` is called twice — the try/catch masks this, but on some stream implementations this can cause the response to hang or leak the underlying socket.

**Suggested fix:** Add a boolean `cleaned` guard at the top of `cleanup()`:
```typescript
let cleaned = false
function cleanup(): void {
  if (cleaned) return
  cleaned = true
  // ... rest of cleanup
}
```

---

## Finding 2: Buyer Eviction Weaponization — Seller DoS via Buyer Impersonation

**Severity: HIGH**

**Location:** `connection-tracker.ts` lines 43-54, `events.ts` lines 127, 152-155

**Attack scenario:**
1. The `isBuyer` flag is derived in `events.ts` line 127: `const isBuyer = callerDid === session.rfq.buyer`.
2. This is correctly derived from the authenticated `callerDid` and session data — no direct impersonation.
3. However, the buyer can **weaponize eviction**: open 3 connections (per-DID max), then open more. Each new connection attempt at session capacity evicts the oldest non-buyer seller connection.
4. A malicious buyer can cycle connections rapidly: open connection, let it count, open another — the tracker evicts sellers each time.
5. With 10 slots and 3 buyer slots, sellers get 7 slots. But if the buyer opens tab after tab (each hitting the per-DID limit and being rejected), existing seller connections are NOT evicted. The real attack is: buyer opens 3 connections, session has 10 total, buyer disconnects one, reconnects — each reconnect at capacity evicts a seller.

**Impact:** The buyer can systematically evict all seller SSE connections, preventing sellers from receiving real-time updates. This is a protocol-level DoS against sellers.

**Suggested fix:** Add a cooldown or rate limit on eviction: track eviction count per buyer per session, and after N evictions in a time window, stop evicting and reject the buyer's connection instead.

---

## Finding 3: No Global Connection Limit — Cross-Session Resource Exhaustion

**Severity: HIGH**

**Location:** `connection-tracker.ts` — no global limit exists

**Attack scenario:**
1. The ConnectionTracker limits connections per-DID (3) and per-session (10).
2. There is NO global limit on total connections across all sessions.
3. An attacker with valid credentials can create or participate in thousands of RFQ sessions.
4. For each session, they open 3 SSE connections = 3,000+ concurrent SSE connections from a single DID.
5. Each SSE connection holds: a ReadableStream, a setInterval for heartbeat, subscriber entries in the EventStore, and a ConnectionTracker record.

**Impact:** Server memory and file descriptor exhaustion. Each SSE connection consumes ~10-50KB of memory (stream buffers, closures, encoder). 10,000 connections = 100-500MB+ of memory, plus file descriptors that can hit OS limits.

**Suggested fix:** Add a global per-DID connection limit (e.g., 20 total across all sessions) and a server-wide connection cap (e.g., 10,000). Reject new connections with 503 when at capacity.

---

## Finding 4: Unbounded Event Log — Memory Exhaustion via Event Flooding

**Severity: HIGH**

**Location:** `event-store.ts` — `events` Map and `seenEventIds` Set grow unbounded

**Attack scenario:**
1. The `seenEventIds` Set grows monotonically — event IDs are never removed.
2. The `events` Map stores all events for all sessions forever (no TTL, no eviction).
3. The `subscribers` and `terminalSubscribers` Maps also accumulate if sessions are not cleaned up.
4. Over time (or via deliberate flooding of many short-lived sessions), memory grows without bound.
5. The types.ts mentions a "500-event session cap" (line 106) but this is NOT enforced in the EventStore — it's just a comment about the intended limit.

**Impact:** OOM kill of the server process. The `seenEventIds` Set is particularly dangerous because it spans ALL sessions and is never pruned.

**Suggested fix:**
- Enforce the 500-event session cap in `append()`.
- Add session cleanup: when a session reaches terminal state, schedule removal of its events after a grace period (e.g., 5 minutes for reconnecting clients).
- Use a bounded LRU or time-windowed structure for `seenEventIds`.

---

## Finding 5: Slow-Read / Backpressure Attack on SSE Stream

**Severity: MEDIUM**

**Attack scenario:**
1. Attacker opens an SSE connection and deliberately reads data very slowly (or stops reading entirely).
2. The `ReadableStream` in `events.ts` uses `controller.enqueue()` which buffers data in memory.
3. The `send()` function (line 134-141) catches errors from `enqueue()` but does NOT check backpressure via `controller.desiredSize`.
4. Events continue to be enqueued regardless of whether the client is consuming them.
5. Combined with a high-frequency event session, the server-side buffer for this single connection can grow very large.

**Impact:** Memory exhaustion on the server side. A single slow-reading attacker can cause unbounded buffering for their connection.

**Suggested fix:** Check `controller.desiredSize` before enqueuing. If backpressure is detected (desiredSize <= 0), close the connection and clean up. Alternatively, implement a per-connection buffer cap.

---

## Finding 6: Terminal State Race — subscribeTerminal Fires Before Replay Flush

**Severity: MEDIUM**

**Location:** `events.ts` lines 169-209, `event-store.ts` lines 180-195

**Attack scenario:**
1. Client connects with a cursor that is a few events behind.
2. `subscribeFrom` is called (line 169), which registers both a regular subscriber and a terminal subscriber (line 177).
3. Between the `subscribeFrom` call and the replay flush (lines 183-189), a QUOTE_COMMITTED event is appended.
4. The terminal subscriber fires immediately (line 177-179), calling `sendTerminal()` then `cleanup()`.
5. `cleanup()` calls `sub.unsubscribe()` and closes the controller.
6. The replay loop (lines 183-186) is still iterating and tries to call `sendEvent()` on an already-closed controller.
7. The `send()` function catches the error and returns false, but the replay loop doesn't check the return value — it continues iterating uselessly.

**Impact:** Client receives a terminal event BEFORE receiving all replay events, causing data loss. The client sees the session ended but never received the events leading up to it.

**Suggested fix:** The terminal subscriber should NOT call cleanup directly. Instead, it should set a flag. After replay+buffered flush and activate(), check the flag and then send terminal + cleanup. This ensures ordering: replay -> buffered -> live -> terminal.

**UPDATE after re-reading:** Actually, looking more carefully at the code flow: `subscribeTerminal` is registered at line 177, but the terminal event arrives via `append()` which notifies terminal subscribers synchronously. If the QUOTE_COMMITTED arrives during the replay loop iteration (lines 183-186), the terminal listener fires synchronously within the `append()` call, which is happening in a different call stack (some other route handler). Since JS is single-threaded, this cannot happen during the for-loop. The terminal event can only fire between the `subscribeFrom` return and the replay flush if `append()` is called from a microtask. In practice, this race requires concurrent request handling (which Hono with async does support). **Verdict: Still a valid concern in async runtimes.**

---

## Finding 7: Heartbeat Interval Leak on Failed Acquire

**Severity: LOW**

**Location:** `events.ts` lines 152-166, 212-219

**Attack scenario:**
1. If `connectionTracker.acquire()` returns `null` (line 162), the code sends an error event and closes the controller.
2. However, the `heartbeatInterval` is declared AFTER the acquire check (line 212), so this specific path is safe.
3. BUT: if `acquire()` succeeds but the subsequent `subscribeFrom()` or `subscribeTerminal()` throws, the `heartbeatInterval` (set at line 212) would never be created because the error propagates out of `start()`. The `cleanup()` function is never called.
4. The connection record in ConnectionTracker is now leaked — it was acquired but never released.

**Impact:** Leaked connection slots in ConnectionTracker, reducing available capacity for the session over time.

**Suggested fix:** Wrap the post-acquire logic in try/catch and call `connectionTracker.release(connectionId)` in the catch block.

---

## Finding 8: seenEventIds Enables Timing Oracle for Event Existence

**Severity: LOW**

**Location:** `event-store.ts` line 138, `hasCursor` lines 263-267

**Attack scenario:**
1. `hasCursor()` iterates the session's event array with `Array.some()`.
2. The `seenEventIds` global Set is NOT used for cursor validation (correctly, per the comment on types.ts line 115).
3. However, `hasCursor` performs a linear scan (`log.some()`), making it O(n) per call.
4. An attacker can probe cursor IDs and measure response time differences to determine approximate event log size for a session they participate in.
5. This is a minor information leak — the attacker already knows they're a participant.

**Impact:** Minimal. Attacker can estimate event count, which is low-sensitivity information.

**Suggested fix:** Use an index (Map or Set of event_ids per session) for O(1) cursor lookup. This also improves performance.

---

## Finding 9: No Rate Limiting on Event Polling (JSON Mode)

**Severity: MEDIUM**

**Location:** `events.ts` lines 108-120

**Attack scenario:**
1. The JSON polling endpoint has no rate limiting.
2. An authenticated participant can poll `GET /rfqs/:id/events` thousands of times per second.
3. Each poll calls `eventStore.getEvents()` which iterates the full event log (after cursor).
4. With many sessions and frequent polling, this creates CPU load on the server.

**Impact:** CPU exhaustion via rapid polling. Unlike SSE mode (which has connection limits), JSON mode has no throttling.

**Suggested fix:** Add per-DID rate limiting on the polling endpoint (e.g., 10 requests/second).

---

## Summary Table

| # | Severity | Finding | Risk |
|---|----------|---------|------|
| 1 | HIGH | Cleanup re-entrancy race | Socket/resource leak |
| 2 | HIGH | Buyer eviction weaponization | Seller DoS |
| 3 | HIGH | No global connection limit | Server resource exhaustion |
| 4 | HIGH | Unbounded event log + seenEventIds | OOM |
| 5 | MEDIUM | Slow-read backpressure attack | Per-connection memory bloat |
| 6 | MEDIUM | Terminal fires before replay flush | Client data loss |
| 7 | LOW | Connection slot leak on subscribeFrom throw | Capacity degradation |
| 8 | LOW | hasCursor timing oracle | Minor info leak |
| 9 | MEDIUM | No rate limit on JSON polling | CPU exhaustion |

## Positive Security Notes

Things the implementation gets RIGHT:
- **Event visibility filter is structural** — baked into EventStore, not bolted on at the route layer. Impossible to accidentally bypass.
- **Deny-by-default** for unknown event types (line 87 of event-store.ts).
- **Session-scoped cursor validation** — correctly uses `hasCursor(rfqId, eventId)` not the global `seenEventIds`.
- **Deep-freeze on events** — prevents mutation after append.
- **structuredClone before freeze** — prevents shared references with caller objects.
- **Dedup in subscribeFrom** — replay/buffer overlap is correctly handled.
- **isBuyer derived server-side** from authenticated DID, not from client input.
