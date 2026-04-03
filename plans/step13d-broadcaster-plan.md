# Step 13d: EventBroadcaster — Decouple SSE from Append Path

## Problem

`SessionManager.appendEvent()` fires observers synchronously inside the session lock.
Each SSE connection registers its own observer via `onAppend()`. With 100 public +
5 admin connections, a single append does 105x `JSON.stringify` + 105x `enqueue`
before returning. This couples spectator traffic to negotiation latency.

## Solution

Insert an `EventBroadcaster` between SessionManager and SSE routes:

```
SessionManager.appendEvent()
  ↓ 1 observer (always)
  EventBroadcaster.onEvent(event, session)
  ↓
  ├── Public: 1x JSON.stringify(anonymized) → fan out string to N connections
  └── Admin:  1x JSON.stringify(full) per watched rfqId → fan out to M connections
```

**Key insight**: All 100 public feed connections receive the SAME anonymized string.
Serialize once, copy the string 100 times (memcpy, microseconds).

## Design

```typescript
class EventBroadcaster {
  // Public feed — all get identical anonymized data
  private publicSubs = new Set<(serialized: string) => void>()

  // Admin — per-session, full events
  private adminSubs = new Map<string, Set<(serialized: string) => void>>()

  /** Called by sessionManager.onAppend() — exactly 1 registration */
  onEvent(event: NegotiationEvent, session: DerivedSession): void {
    // Public: serialize ONCE, fan out to all
    if (this.publicSubs.size > 0) {
      const role = event.actor === session.rfq.buyer ? "buyer"
        : event.actor.startsWith("engine/") ? "system" : "seller"
      const data = JSON.stringify({ type: event.type, actor_role: role, state_after: session.state })
      for (const sub of this.publicSubs) {
        try { sub(data) } catch { /* subscriber failure isolated */ }
      }
    }

    // Admin: serialize ONCE per rfqId with watchers
    const subs = this.adminSubs.get(event.rfq_id)
    if (subs && subs.size > 0) {
      const data = JSON.stringify({ ...event, state_after: session.state })
      for (const sub of subs) {
        try { sub(data) } catch { /* subscriber failure isolated */ }
      }
    }
  }

  subscribePublic(fn: (serialized: string) => void): () => void {
    this.publicSubs.add(fn)
    return () => { this.publicSubs.delete(fn) }
  }

  subscribeAdmin(rfqId: string, fn: (serialized: string) => void): () => void {
    let subs = this.adminSubs.get(rfqId)
    if (!subs) { subs = new Set(); this.adminSubs.set(rfqId, subs) }
    subs.add(fn)
    return () => {
      subs!.delete(fn)
      if (subs!.size === 0) this.adminSubs.delete(rfqId)
    }
  }
}
```

## Changes

| File | Action | Change |
|------|--------|--------|
| `src/stats/event-broadcaster.ts` | Create ~50 lines | EventBroadcaster class |
| `src/routes/dashboard.ts` | Modify | Replace `sessionManager.onAppend()` with `broadcaster.subscribePublic()` |
| `src/routes/admin.ts` | Modify | Replace `sessionManager.onAppend()` with `broadcaster.subscribeAdmin(rfqId)` |
| `src/server.ts` | Modify | Create broadcaster, register 1 observer, pass to routes |

## What Stays the Same

- `SessionManager.onAppend()` API — unchanged, still available
- StatsCollector — still registers directly on onAppend (it's 1 observer, always fast)
- Protocol SSE (`/rfqs/:id/events`) — uses subscribeFrom, not onAppend, unaffected
- All existing tests — no interface changes

## Performance Impact

| Metric | Before | After |
|--------|--------|-------|
| JSON.stringify per append (100 public + 5 admin on 1 rfqId) | 105 | 2 (1 public + 1 admin) |
| Observers in onAppend Set | 100+ | 2 (StatsCollector + Broadcaster) |
| Append latency with full SSE load | O(N × stringify) | O(2 × stringify + N × memcpy) |
| String copy per connection | N/A | ~100 bytes × N, microseconds |
