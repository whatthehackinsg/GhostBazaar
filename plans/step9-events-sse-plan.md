# Step 9: Events SSE Route — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `GET /rfqs/:id/events` as a dual-mode route (SSE streaming + JSON polling) with atomic replay+subscribe, session-scoped cursor validation, connection limits with eviction, and terminal state notification.

**Architecture:** Extend EventStore with `subscribeFrom()` (2-phase atomic handoff), `hasCursor()` (session-scoped), and `subscribeTerminal()` (lifecycle signal). Build `ConnectionTracker` for per-DID rate limiting with buyer-reserved eviction. Route does content negotiation via `Accept` header.

**Tech Stack:** Hono (HTTP), Vitest (testing), EventStore (event sourcing), SSE (text/event-stream)

**Design doc:** `plans/step9-events-sse-design.md`

---

## File Structure

| File | Responsibility | New/Modify |
|------|---------------|------------|
| `src/types.ts` | Add `hasCursor`, `subscribeFrom`, `subscribeTerminal` to EventStore interface | Modify |
| `src/state/event-store.ts` | Implement new methods on InMemoryEventStore | Modify |
| `src/util/connection-tracker.ts` | Per-DID connection tracking with eviction | New |
| `src/routes/events.ts` | Dual-mode events route (SSE + JSON) | New |
| `tests/event-store.test.ts` | Tests for `hasCursor`, `subscribeFrom`, `subscribeTerminal` | Modify |
| `tests/connection-tracker.test.ts` | Connection tracker + eviction tests | New |
| `tests/events.test.ts` | Route tests: JSON mode, SSE mode, integration | New |

---

## Task 1: Extend EventStore Interface

**Files:**
- Modify: `packages/engine/src/types.ts:69-108`

- [ ] **Step 1: Add `hasCursor` to EventStore interface**

In `src/types.ts`, add to the `EventStore` interface after the `size()` method:

```typescript
  /**
   * Check if an event_id exists in the session's event log.
   * Used for cursor validation — returns true only if the event_id
   * belongs to THIS session (not a global check).
   *
   * CRITICAL: Must be session-scoped. The global seenEventIds set
   * must NOT be used — it would accept cursors from other sessions.
   */
  hasCursor(rfqId: string, eventId: string): boolean

  /**
   * Atomically replay events after a cursor and subscribe for new ones.
   * Eliminates the race between getEvents() and subscribe().
   *
   * Two-phase design:
   * Phase 1 (this call): Subscribe + replay + buffer. Returns replay
   *   events and any buffered live events. The listener is NOT called.
   * Phase 2 (activate()): Route calls after flushing replay+buffered
   *   to the client. Only then does the listener receive new events.
   *
   * Ordering contract: [...replay, ...buffered, ...live] — strict append order.
   */
  subscribeFrom(
    rfqId: string,
    callerDid: string,
    rfq: Pick<RFQ, "buyer">,
    afterId: string | undefined,
    listener: (event: NegotiationEvent) => void,
  ): {
    readonly replay: readonly NegotiationEvent[]
    readonly buffered: readonly NegotiationEvent[]
    readonly activate: () => void
    readonly unsubscribe: () => void
  }

  /**
   * Subscribe to session terminal state notification.
   * Fires once when any event transitions the session to COMMITTED/EXPIRED/CANCELLED.
   * Not role-scoped — this is a lifecycle signal, not a data event.
   */
  subscribeTerminal(
    rfqId: string,
    listener: (terminalState: string) => void,
  ): () => void
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd /Volumes/MainSSD/HomeData/zengy/workspace/ghost-bazaar && pnpm --filter @ghost-bazaar/engine build 2>&1 | tail -5`
Expected: Compilation errors for InMemoryEventStore not implementing new methods (this is correct — we implement next)

---

## Task 2: Implement `hasCursor` + `subscribeTerminal` on InMemoryEventStore

**Files:**
- Modify: `packages/engine/src/state/event-store.ts`
- Modify: `packages/engine/tests/event-store.test.ts`

- [ ] **Step 1: Write failing tests for `hasCursor`**

Add to `tests/event-store.test.ts` at the end of the `InMemoryEventStore` describe block:

```typescript
  describe("hasCursor", () => {
    it("returns true for an event_id that exists in the session", () => {
      const event = makeRfqEvent()
      store.append(RFQ_ID, event)
      expect(store.hasCursor(RFQ_ID, event.event_id)).toBe(true)
    })

    it("returns false for an event_id that does not exist", () => {
      store.append(RFQ_ID, makeRfqEvent())
      expect(store.hasCursor(RFQ_ID, "nonexistent-id")).toBe(false)
    })

    it("returns false for an event_id from a different session", () => {
      const event = makeRfqEvent("other-rfq")
      store.append("other-rfq", event)
      expect(store.hasCursor(RFQ_ID, event.event_id)).toBe(false)
    })

    it("returns false for a non-existent session", () => {
      expect(store.hasCursor("no-such-session", "any-id")).toBe(false)
    })
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Volumes/MainSSD/HomeData/zengy/workspace/ghost-bazaar && pnpm --filter @ghost-bazaar/engine test -- tests/event-store.test.ts 2>&1 | tail -10`
Expected: FAIL — `store.hasCursor is not a function`

- [ ] **Step 3: Implement `hasCursor` on InMemoryEventStore**

In `src/state/event-store.ts`, add to the `InMemoryEventStore` class:

```typescript
  hasCursor(rfqId: string, eventId: string): boolean {
    const log = this.events.get(rfqId)
    if (!log) return false
    return log.some((e) => e.event_id === eventId)
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Volumes/MainSSD/HomeData/zengy/workspace/ghost-bazaar && pnpm --filter @ghost-bazaar/engine test -- tests/event-store.test.ts 2>&1 | tail -10`
Expected: All hasCursor tests PASS

- [ ] **Step 5: Write failing tests for `subscribeTerminal`**

Add to `tests/event-store.test.ts`:

```typescript
  describe("subscribeTerminal", () => {
    it("fires when session reaches COMMITTED", () => {
      const store = new InMemoryEventStore()
      store.append(RFQ_ID, makeRfqEvent())
      store.append(RFQ_ID, makeOfferEvent(SELLER_A_DID))

      const states: string[] = []
      store.subscribeTerminal(RFQ_ID, (s) => states.push(s))

      store.append(RFQ_ID, makeWinnerSelectedEvent(SELLER_A_DID))
      expect(states).toEqual([]) // COMMIT_PENDING is not terminal

      store.append(RFQ_ID, makeQuoteSignedEvent(SELLER_A_DID))
      expect(states).toEqual([]) // Still COMMIT_PENDING

      store.append(RFQ_ID, makeQuoteCommittedEvent(SELLER_A_DID))
      expect(states).toEqual(["COMMITTED"])
    })

    it("fires when session reaches EXPIRED", () => {
      const store = new InMemoryEventStore()
      store.append(RFQ_ID, makeRfqEvent())

      const states: string[] = []
      store.subscribeTerminal(RFQ_ID, (s) => states.push(s))

      store.append(RFQ_ID, makeExpiredEvent())
      expect(states).toEqual(["EXPIRED"])
    })

    it("fires when session reaches CANCELLED", () => {
      const store = new InMemoryEventStore()
      store.append(RFQ_ID, makeRfqEvent())

      const states: string[] = []
      store.subscribeTerminal(RFQ_ID, (s) => states.push(s))

      store.append(RFQ_ID, makeCancelledEvent())
      expect(states).toEqual(["CANCELLED"])
    })

    it("unsubscribe prevents notification", () => {
      const store = new InMemoryEventStore()
      store.append(RFQ_ID, makeRfqEvent())

      const states: string[] = []
      const unsub = store.subscribeTerminal(RFQ_ID, (s) => states.push(s))
      unsub()

      store.append(RFQ_ID, makeExpiredEvent())
      expect(states).toEqual([])
    })

    it("fires at most once per subscription", () => {
      const store = new InMemoryEventStore()
      // Create a session that's already expired
      store.append(RFQ_ID, makeRfqEvent())

      const states: string[] = []
      store.subscribeTerminal(RFQ_ID, (s) => states.push(s))

      store.append(RFQ_ID, makeExpiredEvent())
      // Trying to append after terminal should fail in deriveState,
      // but subscribeTerminal itself should fire only once
      expect(states).toEqual(["EXPIRED"])
    })
  })
```

- [ ] **Step 6: Run tests to verify they fail**

Run: `cd /Volumes/MainSSD/HomeData/zengy/workspace/ghost-bazaar && pnpm --filter @ghost-bazaar/engine test -- tests/event-store.test.ts 2>&1 | tail -10`
Expected: FAIL — `store.subscribeTerminal is not a function`

- [ ] **Step 7: Implement `subscribeTerminal` on InMemoryEventStore**

The terminal detection hooks into `append()`. After appending an event, check if the event type leads to a terminal state.

In `src/state/event-store.ts`, add:

1. A new private field for terminal subscribers:
```typescript
  /** rfqId → terminal state listeners (fire once on COMMITTED/EXPIRED/CANCELLED) */
  private readonly terminalSubscribers = new Map<string, Set<(state: string) => void>>()
```

2. Import the terminal state detection constant at the top of the file:
```typescript
import type { NegotiationEvent, InternalEventStore, EventType } from "../types.js"
```

3. Add a constant for terminal event types (events that transition INTO a terminal state):
```typescript
// Events that transition the session into a terminal state.
// Used by subscribeTerminal to detect when to fire the lifecycle signal.
const TERMINAL_EVENT_TYPES: ReadonlySet<EventType> = new Set([
  "QUOTE_COMMITTED",       // → COMMITTED
  "NEGOTIATION_EXPIRED",   // → EXPIRED
  "NEGOTIATION_CANCELLED", // → CANCELLED
])
```

4. Hook into `append()` — after notifying role-scoped subscribers, add:
```typescript
    // Notify terminal subscribers if this event transitions to a terminal state.
    // Terminal notification is NOT role-scoped — it's a lifecycle signal.
    if (TERMINAL_EVENT_TYPES.has(frozenEvent.type)) {
      const termSubs = this.terminalSubscribers.get(rfqId)
      if (termSubs) {
        // Determine terminal state name from event type
        const terminalState =
          frozenEvent.type === "QUOTE_COMMITTED" ? "COMMITTED" :
          frozenEvent.type === "NEGOTIATION_EXPIRED" ? "EXPIRED" : "CANCELLED"
        for (const listener of termSubs) {
          try {
            listener(terminalState)
          } catch {
            // Terminal subscriber failure must not affect append
          }
        }
        // Clean up — terminal fires at most once
        this.terminalSubscribers.delete(rfqId)
      }
    }
```

5. Add the `subscribeTerminal` method:
```typescript
  subscribeTerminal(
    rfqId: string,
    listener: (terminalState: string) => void,
  ): () => void {
    let subs = this.terminalSubscribers.get(rfqId)
    if (!subs) {
      subs = new Set()
      this.terminalSubscribers.set(rfqId, subs)
    }
    subs.add(listener)

    return () => {
      subs!.delete(listener)
      if (subs!.size === 0) {
        this.terminalSubscribers.delete(rfqId)
      }
    }
  }
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `cd /Volumes/MainSSD/HomeData/zengy/workspace/ghost-bazaar && pnpm --filter @ghost-bazaar/engine test -- tests/event-store.test.ts 2>&1 | tail -10`
Expected: All tests PASS

- [ ] **Step 9: Commit**

```bash
cd /Volumes/MainSSD/HomeData/zengy/workspace/ghost-bazaar
git add packages/engine/src/types.ts packages/engine/src/state/event-store.ts packages/engine/tests/event-store.test.ts
git commit -m "feat(engine): add hasCursor + subscribeTerminal to EventStore (Step 9a)"
```

---

## Task 3: Implement `subscribeFrom` (Atomic Replay+Subscribe)

**Files:**
- Modify: `packages/engine/src/state/event-store.ts`
- Modify: `packages/engine/tests/event-store.test.ts`

- [ ] **Step 1: Write failing tests for `subscribeFrom`**

Add to `tests/event-store.test.ts`:

```typescript
  describe("subscribeFrom", () => {
    it("returns replay events and subscribes for new ones", () => {
      const store = new InMemoryEventStore()
      const rfqEvent = makeRfqEvent()
      const offerEvent = makeOfferEvent(SELLER_A_DID)
      store.append(RFQ_ID, rfqEvent)
      store.append(RFQ_ID, offerEvent)

      const liveEvents: NegotiationEvent[] = []
      const result = store.subscribeFrom(
        RFQ_ID, BUYER_DID, MOCK_RFQ, undefined,
        (e) => liveEvents.push(e),
      )

      // Replay should contain both events (buyer sees all)
      expect(result.replay).toHaveLength(2)
      expect(result.replay[0].event_id).toBe(rfqEvent.event_id)
      expect(result.replay[1].event_id).toBe(offerEvent.event_id)
      expect(result.buffered).toHaveLength(0)

      // Listener should NOT have been called yet
      expect(liveEvents).toHaveLength(0)

      // Activate live delivery
      result.activate()

      // Now append a new event — listener should receive it
      const counterEvent = makeCounterEvent(SELLER_A_DID)
      store.append(RFQ_ID, counterEvent)
      expect(liveEvents).toHaveLength(1)
      expect(liveEvents[0].event_id).toBe(counterEvent.event_id)

      result.unsubscribe()
    })

    it("uses cursor to replay only events after afterId", () => {
      const store = new InMemoryEventStore()
      const rfqEvent = makeRfqEvent()
      const offerEvent = makeOfferEvent(SELLER_A_DID)
      store.append(RFQ_ID, rfqEvent)
      store.append(RFQ_ID, offerEvent)

      const result = store.subscribeFrom(
        RFQ_ID, BUYER_DID, MOCK_RFQ, rfqEvent.event_id,
        () => {},
      )

      // Only events after rfqEvent
      expect(result.replay).toHaveLength(1)
      expect(result.replay[0].event_id).toBe(offerEvent.event_id)

      result.unsubscribe()
    })

    it("captures events appended between subscribe and activate (no lost events)", () => {
      const store = new InMemoryEventStore()
      store.append(RFQ_ID, makeRfqEvent())

      const liveEvents: NegotiationEvent[] = []
      // subscribeFrom registers the subscriber internally
      const result = store.subscribeFrom(
        RFQ_ID, BUYER_DID, MOCK_RFQ, undefined,
        (e) => liveEvents.push(e),
      )

      // Simulate: event appended AFTER subscribeFrom returns but BEFORE activate
      const offerEvent = makeOfferEvent(SELLER_A_DID)
      store.append(RFQ_ID, offerEvent)

      // Listener should NOT have been called (not activated yet)
      expect(liveEvents).toHaveLength(0)

      // Activate — should flush the buffered event
      result.activate()
      expect(liveEvents).toHaveLength(1)
      expect(liveEvents[0].event_id).toBe(offerEvent.event_id)

      result.unsubscribe()
    })

    it("deduplicates events that appear in both replay and buffer", () => {
      // This test verifies the dedup logic. In single-threaded JS,
      // events appended during getEvents() would be rare, but the
      // contract must handle it correctly.
      const store = new InMemoryEventStore()
      const rfqEvent = makeRfqEvent()
      store.append(RFQ_ID, rfqEvent)

      const liveEvents: NegotiationEvent[] = []
      const result = store.subscribeFrom(
        RFQ_ID, BUYER_DID, MOCK_RFQ, undefined,
        (e) => liveEvents.push(e),
      )

      // rfqEvent is in replay. It should NOT appear in buffered.
      expect(result.replay).toHaveLength(1)
      expect(result.buffered).toHaveLength(0)

      result.activate()
      // No duplicate delivery
      expect(liveEvents).toHaveLength(0)

      result.unsubscribe()
    })

    it("respects role-scoped visibility in replay", () => {
      const store = new InMemoryEventStore()
      store.append(RFQ_ID, makeRfqEvent())
      store.append(RFQ_ID, makeOfferEvent(SELLER_A_DID))
      store.append(RFQ_ID, makeOfferEvent(SELLER_B_DID))

      // Seller A should only see RFQ + their own offer
      const result = store.subscribeFrom(
        RFQ_ID, SELLER_A_DID, MOCK_RFQ, undefined,
        () => {},
      )

      expect(result.replay).toHaveLength(2) // RFQ + Seller A's offer
      expect(result.replay[0].type).toBe("RFQ_CREATED")
      expect(result.replay[1].actor).toBe(SELLER_A_DID)

      result.unsubscribe()
    })

    it("unsubscribe stops live delivery", () => {
      const store = new InMemoryEventStore()
      store.append(RFQ_ID, makeRfqEvent())

      const liveEvents: NegotiationEvent[] = []
      const result = store.subscribeFrom(
        RFQ_ID, BUYER_DID, MOCK_RFQ, undefined,
        (e) => liveEvents.push(e),
      )
      result.activate()
      result.unsubscribe()

      // Append after unsubscribe — should NOT be delivered
      store.append(RFQ_ID, makeOfferEvent(SELLER_A_DID))
      expect(liveEvents).toHaveLength(0)
    })

    it("strict ordering: replay before buffered before live", () => {
      const store = new InMemoryEventStore()
      const rfqEvent = makeRfqEvent()
      store.append(RFQ_ID, rfqEvent)

      const allEvents: Array<{ source: string; id: string }> = []
      const result = store.subscribeFrom(
        RFQ_ID, BUYER_DID, MOCK_RFQ, undefined,
        (e) => allEvents.push({ source: "live", id: e.event_id }),
      )

      // Record replay
      for (const e of result.replay) {
        allEvents.push({ source: "replay", id: e.event_id })
      }

      // Simulate event before activate
      const offerEvent = makeOfferEvent(SELLER_A_DID)
      store.append(RFQ_ID, offerEvent)

      // Record buffered (would be flushed on activate)
      for (const e of result.buffered) {
        allEvents.push({ source: "buffered", id: e.event_id })
      }

      // Activate — flushes post-return buffer
      result.activate()

      // Now append a truly live event
      const counterEvent = makeCounterEvent(SELLER_A_DID)
      store.append(RFQ_ID, counterEvent)

      // Order: replay(rfq) → live(offer via activate flush) → live(counter)
      expect(allEvents[0]).toEqual({ source: "replay", id: rfqEvent.event_id })
      // The offer was appended after subscribeFrom returned, so it's flushed on activate as "live"
      expect(allEvents[1]).toEqual({ source: "live", id: offerEvent.event_id })
      expect(allEvents[2]).toEqual({ source: "live", id: counterEvent.event_id })

      result.unsubscribe()
    })
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Volumes/MainSSD/HomeData/zengy/workspace/ghost-bazaar && pnpm --filter @ghost-bazaar/engine test -- tests/event-store.test.ts 2>&1 | tail -10`
Expected: FAIL — `store.subscribeFrom is not a function`

- [ ] **Step 3: Implement `subscribeFrom` on InMemoryEventStore**

Add to `InMemoryEventStore` class in `src/state/event-store.ts`:

```typescript
  subscribeFrom(
    rfqId: string,
    callerDid: string,
    rfq: Pick<RFQ, "buyer">,
    afterId: string | undefined,
    listener: (event: NegotiationEvent) => void,
  ): {
    readonly replay: readonly NegotiationEvent[]
    readonly buffered: readonly NegotiationEvent[]
    readonly activate: () => void
    readonly unsubscribe: () => void
  } {
    // Phase 1: Subscribe in BUFFERING mode
    const buffer: NegotiationEvent[] = []
    let mode: "buffering" | "live" | "stopped" = "buffering"

    const unsubscribeRole = this.subscribe(rfqId, callerDid, rfq, (event) => {
      if (mode === "stopped") return
      if (mode === "buffering") {
        buffer.push(event)
        return
      }
      // mode === "live" — deliver directly
      listener(event)
    })

    // Phase 1 continued: Read historical events (subscriber is already registered)
    const replay = this.getEvents(rfqId, callerDid, rfq, afterId)

    // Deduplicate: remove any buffered events that overlap with replay
    const replayIds = new Set(replay.map((e) => e.event_id))
    const dedupedBuffer: NegotiationEvent[] = []
    for (const e of buffer) {
      if (!replayIds.has(e.event_id)) {
        dedupedBuffer.push(e)
      }
    }
    // Clear and replace buffer with deduped version
    buffer.length = 0
    buffer.push(...dedupedBuffer)

    let activated = false

    const activate = (): void => {
      if (activated || mode === "stopped") return
      activated = true

      // Flush any events that arrived between subscribeFrom return and activate()
      // These are in the buffer (events appended after dedup but before activate)
      const toFlush = [...buffer]
      buffer.length = 0
      mode = "live"

      for (const e of toFlush) {
        if (mode === "stopped") break
        listener(e)
      }
    }

    const unsubscribe = (): void => {
      mode = "stopped"
      buffer.length = 0
      unsubscribeRole()
    }

    // Return the deduped buffer snapshot (events between subscribe and replay)
    // NOTE: The buffer may grow between this return and activate() — activate
    // flushes everything accumulated since this point.
    const bufferedSnapshot = [...dedupedBuffer]

    return {
      replay,
      buffered: bufferedSnapshot,
      activate,
      unsubscribe,
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Volumes/MainSSD/HomeData/zengy/workspace/ghost-bazaar && pnpm --filter @ghost-bazaar/engine test -- tests/event-store.test.ts 2>&1 | tail -10`
Expected: All tests PASS

- [ ] **Step 5: Run full test suite to verify no regressions**

Run: `cd /Volumes/MainSSD/HomeData/zengy/workspace/ghost-bazaar && pnpm --filter @ghost-bazaar/engine test 2>&1 | tail -10`
Expected: All existing tests still PASS

- [ ] **Step 6: Commit**

```bash
cd /Volumes/MainSSD/HomeData/zengy/workspace/ghost-bazaar
git add packages/engine/src/state/event-store.ts packages/engine/tests/event-store.test.ts
git commit -m "feat(engine): implement subscribeFrom atomic replay+subscribe (Step 9b)"
```

---

## Task 4: ConnectionTracker

**Files:**
- Create: `packages/engine/src/util/connection-tracker.ts`
- Create: `packages/engine/tests/connection-tracker.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/connection-tracker.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest"
import { ConnectionTracker } from "../src/util/connection-tracker.js"

const RFQ = "rfq-1"
const BUYER = "did:key:buyer"
const SELLER_A = "did:key:sellerA"
const SELLER_B = "did:key:sellerB"

function noop() {}

describe("ConnectionTracker", () => {
  it("allows connection within limits", () => {
    const tracker = new ConnectionTracker()
    const id = tracker.acquire({ rfqId: RFQ, callerDid: BUYER, isBuyer: true, close: noop })
    expect(id).not.toBeNull()
    expect(tracker.countForSession(RFQ)).toBe(1)
    expect(tracker.countForDid(RFQ, BUYER)).toBe(1)
  })

  it("rejects 4th connection from same DID", () => {
    const tracker = new ConnectionTracker()
    tracker.acquire({ rfqId: RFQ, callerDid: SELLER_A, isBuyer: false, close: noop })
    tracker.acquire({ rfqId: RFQ, callerDid: SELLER_A, isBuyer: false, close: noop })
    tracker.acquire({ rfqId: RFQ, callerDid: SELLER_A, isBuyer: false, close: noop })
    const fourth = tracker.acquire({ rfqId: RFQ, callerDid: SELLER_A, isBuyer: false, close: noop })
    expect(fourth).toBeNull()
  })

  it("rejects 11th total connection from non-buyer", () => {
    const tracker = new ConnectionTracker()
    // Fill 10 slots with different sellers
    for (let i = 0; i < 10; i++) {
      const did = `did:key:seller${i}`
      const id = tracker.acquire({ rfqId: RFQ, callerDid: did, isBuyer: false, close: noop })
      expect(id).not.toBeNull()
    }
    // 11th non-buyer rejected
    const eleventh = tracker.acquire({ rfqId: RFQ, callerDid: "did:key:seller10", isBuyer: false, close: noop })
    expect(eleventh).toBeNull()
    expect(tracker.countForSession(RFQ)).toBe(10)
  })

  it("buyer evicts oldest non-buyer when at capacity", () => {
    const tracker = new ConnectionTracker()
    const closeFns: Array<ReturnType<typeof vi.fn>> = []

    // Fill 10 slots with sellers
    for (let i = 0; i < 10; i++) {
      const did = `did:key:seller${i}`
      const close = vi.fn()
      closeFns.push(close)
      tracker.acquire({ rfqId: RFQ, callerDid: did, isBuyer: false, close })
    }

    // Buyer connects — should evict oldest non-buyer (seller0)
    const buyerId = tracker.acquire({ rfqId: RFQ, callerDid: BUYER, isBuyer: true, close: noop })
    expect(buyerId).not.toBeNull()
    expect(closeFns[0]).toHaveBeenCalledOnce() // seller0 evicted
    expect(closeFns[1]).not.toHaveBeenCalled() // seller1 not evicted
    expect(tracker.countForSession(RFQ)).toBe(10) // replaced, not added
  })

  it("release frees a slot", () => {
    const tracker = new ConnectionTracker()
    const id = tracker.acquire({ rfqId: RFQ, callerDid: SELLER_A, isBuyer: false, close: noop })!
    expect(tracker.countForSession(RFQ)).toBe(1)
    tracker.release(id)
    expect(tracker.countForSession(RFQ)).toBe(0)
  })

  it("closeAll terminates all connections for a session", () => {
    const tracker = new ConnectionTracker()
    const close1 = vi.fn()
    const close2 = vi.fn()
    tracker.acquire({ rfqId: RFQ, callerDid: SELLER_A, isBuyer: false, close: close1 })
    tracker.acquire({ rfqId: RFQ, callerDid: SELLER_B, isBuyer: false, close: close2 })

    tracker.closeAll(RFQ)
    expect(close1).toHaveBeenCalledOnce()
    expect(close2).toHaveBeenCalledOnce()
    expect(tracker.countForSession(RFQ)).toBe(0)
  })

  it("separate sessions have independent limits", () => {
    const tracker = new ConnectionTracker()
    tracker.acquire({ rfqId: "rfq-1", callerDid: SELLER_A, isBuyer: false, close: noop })
    tracker.acquire({ rfqId: "rfq-2", callerDid: SELLER_A, isBuyer: false, close: noop })
    expect(tracker.countForSession("rfq-1")).toBe(1)
    expect(tracker.countForSession("rfq-2")).toBe(1)
    // Per-DID limit is per session, not global
    expect(tracker.countForDid("rfq-1", SELLER_A)).toBe(1)
    expect(tracker.countForDid("rfq-2", SELLER_A)).toBe(1)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Volumes/MainSSD/HomeData/zengy/workspace/ghost-bazaar && pnpm --filter @ghost-bazaar/engine test -- tests/connection-tracker.test.ts 2>&1 | tail -10`
Expected: FAIL — module not found

- [ ] **Step 3: Implement ConnectionTracker**

Create `src/util/connection-tracker.ts`:

```typescript
/**
 * ConnectionTracker — manages SSE connection limits per session.
 *
 * Limits:
 * - Max 3 SSE connections per DID per session
 * - Max 10 SSE connections per session (total)
 * - 1 reserved slot for the buyer (evicts oldest non-buyer if at capacity)
 *
 * Tracks concrete connection records with identity, timestamps, and close
 * callbacks to implement eviction (Codex R2-F4).
 */

/** Opaque connection identifier. */
export type ConnectionId = string

interface ConnectionRecord {
  readonly connectionId: ConnectionId
  readonly rfqId: string
  readonly callerDid: string
  readonly isBuyer: boolean
  readonly openedAt: number
  readonly close: () => void
}

const MAX_PER_DID = 3
const MAX_PER_SESSION = 10

export class ConnectionTracker {
  private readonly connections = new Map<ConnectionId, ConnectionRecord>()
  /** rfqId → Set<ConnectionId> for fast session lookups */
  private readonly bySession = new Map<string, Set<ConnectionId>>()
  private nextId = 0

  acquire(conn: {
    readonly rfqId: string
    readonly callerDid: string
    readonly isBuyer: boolean
    readonly close: () => void
  }): ConnectionId | null {
    const { rfqId, callerDid, isBuyer } = conn

    // Check per-DID limit
    const didCount = this.countForDid(rfqId, callerDid)
    if (didCount >= MAX_PER_DID) return null

    // Check session limit
    const sessionCount = this.countForSession(rfqId)
    if (sessionCount >= MAX_PER_SESSION) {
      if (!isBuyer) return null

      // Buyer eviction: find oldest non-buyer
      const evicted = this.findOldestNonBuyer(rfqId)
      if (!evicted) return null // all connections are buyer — reject

      // Evict: call close callback and remove record
      evicted.close()
      this.removeRecord(evicted.connectionId)
    }

    // Acquire slot
    const connectionId = `conn-${++this.nextId}`
    const record: ConnectionRecord = {
      connectionId,
      rfqId,
      callerDid,
      isBuyer,
      openedAt: Date.now(),
      close: conn.close,
    }

    this.connections.set(connectionId, record)
    let sessionSet = this.bySession.get(rfqId)
    if (!sessionSet) {
      sessionSet = new Set()
      this.bySession.set(rfqId, sessionSet)
    }
    sessionSet.add(connectionId)

    return connectionId
  }

  release(connectionId: ConnectionId): void {
    this.removeRecord(connectionId)
  }

  countForDid(rfqId: string, callerDid: string): number {
    const sessionSet = this.bySession.get(rfqId)
    if (!sessionSet) return 0
    let count = 0
    for (const id of sessionSet) {
      const rec = this.connections.get(id)
      if (rec && rec.callerDid === callerDid) count++
    }
    return count
  }

  countForSession(rfqId: string): number {
    return this.bySession.get(rfqId)?.size ?? 0
  }

  closeAll(rfqId: string): void {
    const sessionSet = this.bySession.get(rfqId)
    if (!sessionSet) return
    // Copy to avoid mutation during iteration
    const ids = [...sessionSet]
    for (const id of ids) {
      const rec = this.connections.get(id)
      if (rec) {
        rec.close()
        this.removeRecord(id)
      }
    }
  }

  private findOldestNonBuyer(rfqId: string): ConnectionRecord | null {
    const sessionSet = this.bySession.get(rfqId)
    if (!sessionSet) return null
    let oldest: ConnectionRecord | null = null
    for (const id of sessionSet) {
      const rec = this.connections.get(id)
      if (rec && !rec.isBuyer) {
        if (!oldest || rec.openedAt < oldest.openedAt) {
          oldest = rec
        }
      }
    }
    return oldest
  }

  private removeRecord(connectionId: ConnectionId): void {
    const rec = this.connections.get(connectionId)
    if (!rec) return
    this.connections.delete(connectionId)
    const sessionSet = this.bySession.get(rec.rfqId)
    if (sessionSet) {
      sessionSet.delete(connectionId)
      if (sessionSet.size === 0) {
        this.bySession.delete(rec.rfqId)
      }
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Volumes/MainSSD/HomeData/zengy/workspace/ghost-bazaar && pnpm --filter @ghost-bazaar/engine test -- tests/connection-tracker.test.ts 2>&1 | tail -10`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
cd /Volumes/MainSSD/HomeData/zengy/workspace/ghost-bazaar
git add packages/engine/src/util/connection-tracker.ts packages/engine/tests/connection-tracker.test.ts
git commit -m "feat(engine): add ConnectionTracker with per-DID limits + buyer eviction (Step 9c)"
```

---

## Task 5: Events Route — JSON Polling Mode

**Files:**
- Create: `packages/engine/src/routes/events.ts`
- Create: `packages/engine/tests/events.test.ts`

- [ ] **Step 1: Write failing tests for JSON mode**

Create `tests/events.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest"
import { Hono } from "hono"
import { Keypair } from "@solana/web3.js"
import {
  buildDid,
  signEd25519,
  objectSigningPayload,
} from "@ghost-bazaar/core"
import { createApp } from "../src/app.js"
import { createRfqRoute } from "../src/routes/rfqs.js"
import { createOfferRoute } from "../src/routes/offers.js"
import { createEventsRoute } from "../src/routes/events.js"
import { InMemoryEventStore } from "../src/state/event-store.js"
import { SessionManager } from "../src/state/session-manager.js"
import { ListingStore } from "../src/registry/listing-store.js"
import type { EngineEnv } from "../src/app.js"
import { ConnectionTracker } from "../src/util/connection-tracker.js"

// ---------------------------------------------------------------------------
// Test keypairs — same pattern as offers.test.ts
// ---------------------------------------------------------------------------

const BUYER_KP = Keypair.generate()
const BUYER_DID = buildDid(BUYER_KP.publicKey)
const SELLER_A_KP = Keypair.generate()
const SELLER_A_DID = buildDid(SELLER_A_KP.publicKey)
const SELLER_B_KP = Keypair.generate()
const SELLER_B_DID = buildDid(SELLER_B_KP.publicKey)
const OUTSIDER_KP = Keypair.generate()
const OUTSIDER_DID = buildDid(OUTSIDER_KP.publicKey)

// ---------------------------------------------------------------------------
// Helpers — mirrors offers.test.ts signing pattern
// ---------------------------------------------------------------------------

async function makeSignedRfq() {
  const rfq = {
    rfq_id: crypto.randomUUID(),
    protocol: "ghost-bazaar-v4",
    buyer: BUYER_DID,
    service_type: "llm-inference",
    spec: { model: "gpt-4" },
    anchor_price: "30.00",
    currency: "USDC",
    deadline: new Date(Date.now() + 300_000).toISOString(),
    signature: "",
  }
  const payload = objectSigningPayload(rfq)
  const sig = await signEd25519(payload, BUYER_KP)
  return { ...rfq, signature: sig }
}

async function makeSignedOffer(
  rfqId: string,
  sellerKp: typeof SELLER_A_KP,
  overrides: Record<string, unknown> = {},
) {
  const sellerDid = buildDid(sellerKp.publicKey)
  const offer = {
    offer_id: crypto.randomUUID(),
    rfq_id: rfqId,
    seller: sellerDid,
    price: "28.50",
    currency: "USDC",
    valid_until: new Date(Date.now() + 60_000).toISOString(),
    signature: "",
    ...overrides,
  }
  const payload = objectSigningPayload(offer)
  const sig = await signEd25519(payload, sellerKp)
  return { ...offer, signature: sig }
}

async function createRfqSession(app: Hono<EngineEnv>) {
  const rfq = await makeSignedRfq()
  await app.request("/rfqs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(rfq),
  })
  return rfq // Returns the full rfq object with rfq_id set by the caller
}

async function submitOffer(app: Hono<EngineEnv>, rfqId: string, sellerKp: typeof SELLER_A_KP) {
  const offer = await makeSignedOffer(rfqId, sellerKp)
  await app.request(`/rfqs/${rfqId}/offers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(offer),
  })
}

function createTestApp(authenticateCaller?: (req: Request) => Promise<string>) {
  const store = new InMemoryEventStore()
  const sessionManager = new SessionManager(store)
  const listingStore = new ListingStore()
  const connectionTracker = new ConnectionTracker()

  listingStore.add({
    listing_id: "listing-seller-a",
    seller: SELLER_A_DID,
    title: "Seller A Service",
    category: "llm",
    service_type: "llm-inference",
    negotiation_endpoint: "https://seller-a.example.com/negotiate",
    payment_endpoint: "https://seller-a.example.com/pay",
    base_terms: {},
  })
  listingStore.add({
    listing_id: "listing-seller-b",
    seller: SELLER_B_DID,
    title: "Seller B Service",
    category: "llm",
    service_type: "llm-inference",
    negotiation_endpoint: "https://seller-b.example.com/negotiate",
    payment_endpoint: "https://seller-b.example.com/pay",
    base_terms: {},
  })

  const app = createApp() as Hono<EngineEnv>
  app.route("/", createRfqRoute(sessionManager))
  app.route("/", createOfferRoute({ sessionManager, listingStore }))
  app.route(
    "/",
    createEventsRoute({
      sessionManager,
      eventStore: store,
      connectionTracker,
      authenticateCaller: authenticateCaller ?? (async () => BUYER_DID),
    }),
  )
  return { app, store, sessionManager, connectionTracker }
}

// ---------------------------------------------------------------------------
// JSON Mode Tests
// ---------------------------------------------------------------------------

describe("GET /rfqs/:id/events", () => {
  describe("JSON mode", () => {
    it("returns all events for buyer (no cursor)", async () => {
      const { app } = createTestApp()
      const rfq = await createRfqSession(app)
      await submitOffer(app, rfq.rfq_id, SELLER_A_KP)

      const res = await app.request(`/rfqs/${rfq.rfq_id}/events`, {
        headers: { Accept: "application/json" },
      })
      expect(res.status).toBe(200)
      const body = await res.json() as any
      expect(body.events).toHaveLength(2) // RFQ_CREATED + OFFER_SUBMITTED
      expect(body.cursor).toBeTruthy()
      expect(body.rfq_id).toBe(rfq.rfq_id)
    })

    it("returns filtered events for seller (role-scoped)", async () => {
      const { app } = createTestApp(async () => SELLER_A_DID)
      const rfq = await createRfqSession(app)
      await submitOffer(app, rfq.rfq_id, SELLER_A_KP)
      await submitOffer(app, rfq.rfq_id, SELLER_B_KP)

      const res = await app.request(`/rfqs/${rfq.rfq_id}/events`, {
        headers: { Accept: "application/json" },
      })
      const body = await res.json() as any
      // Seller A sees: RFQ_CREATED + own offer (not Seller B's offer)
      expect(body.events).toHaveLength(2)
    })

    it("cursor-based pagination returns only events after cursor", async () => {
      const { app } = createTestApp()
      const rfq = await createRfqSession(app)
      await submitOffer(app, rfq.rfq_id, SELLER_A_KP)

      // Get all events to find the cursor
      const res1 = await app.request(`/rfqs/${rfq.rfq_id}/events`, {
        headers: { Accept: "application/json" },
      })
      const body1 = await res1.json() as any
      const firstEventId = body1.events[0].event_id

      // Use cursor to get only events after RFQ_CREATED
      const res2 = await app.request(`/rfqs/${rfq.rfq_id}/events?after=${firstEventId}`, {
        headers: { Accept: "application/json" },
      })
      const body2 = await res2.json() as any
      expect(body2.events).toHaveLength(1) // Only the offer
      expect(body2.events[0].type).toBe("OFFER_SUBMITTED")
    })

    it("invalid cursor returns 400", async () => {
      const { app } = createTestApp()
      const rfq = await createRfqSession(app)

      const res = await app.request(`/rfqs/${rfq.rfq_id}/events?after=nonexistent-cursor`, {
        headers: { Accept: "application/json" },
      })
      expect(res.status).toBe(400)
      const body = await res.json() as any
      expect(body.error).toBe("invalid_cursor")
    })

    it("non-participant gets 401", async () => {
      const { app } = createTestApp(async () => OUTSIDER_DID)
      const rfq = await createRfqSession(app)

      const res = await app.request(`/rfqs/${rfq.rfq_id}/events`, {
        headers: { Accept: "application/json" },
      })
      expect(res.status).toBe(401)
    })

    it("non-existent session gets 404", async () => {
      const { app } = createTestApp()
      const res = await app.request("/rfqs/nonexistent/events", {
        headers: { Accept: "application/json" },
      })
      expect(res.status).toBe(404)
    })

    it("valid cursor with no new events returns same cursor back", async () => {
      const { app } = createTestApp()
      const rfq = await createRfqSession(app)

      const res1 = await app.request(`/rfqs/${rfq.rfq_id}/events`, {
        headers: { Accept: "application/json" },
      })
      const body1 = await res1.json() as any
      const cursor = body1.cursor

      // Request with same cursor — no new events
      const res2 = await app.request(`/rfqs/${rfq.rfq_id}/events?after=${cursor}`, {
        headers: { Accept: "application/json" },
      })
      const body2 = await res2.json() as any
      expect(body2.events).toHaveLength(0)
      expect(body2.cursor).toBe(cursor) // Same cursor returned
      expect(body2.cursor_valid).toBe(true)
    })

    it("cursor from different session is rejected", async () => {
      const { app } = createTestApp()
      const rfq1 = await createRfqSession(app)
      const rfq2 = await createRfqSession(app)

      // Get a cursor from rfq1
      const res1 = await app.request(`/rfqs/${rfq1.rfq_id}/events`, {
        headers: { Accept: "application/json" },
      })
      const body1 = await res1.json() as any
      const cursorFromRfq1 = body1.cursor

      // Use rfq1's cursor on rfq2 — should fail
      const res2 = await app.request(`/rfqs/${rfq2.rfq_id}/events?after=${cursorFromRfq1}`, {
        headers: { Accept: "application/json" },
      })
      expect(res2.status).toBe(400)
      const body2 = await res2.json() as any
      expect(body2.error).toBe("invalid_cursor")
    })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Volumes/MainSSD/HomeData/zengy/workspace/ghost-bazaar && pnpm --filter @ghost-bazaar/engine test -- tests/events.test.ts 2>&1 | tail -10`
Expected: FAIL — module not found (events.ts doesn't exist yet)

- [ ] **Step 3: Implement events route (JSON mode only first)**

Create `src/routes/events.ts`:

```typescript
/**
 * Events Route — GET /rfqs/:id/events
 *
 * Dual-mode event streaming:
 * - Accept: text/event-stream → SSE streaming (Task 6)
 * - Accept: application/json → JSON polling (this task)
 *
 * Authentication: Injectable authenticateCaller (same pattern as quote-read).
 * Participant check: buyer or seller with at least one offer.
 * Cursor: ?after=<event_id> with session-scoped validation.
 */

import { Hono } from "hono"
import type { EngineEnv } from "../app.js"
import type { SessionManager } from "../state/session-manager.js"
import type { EventStore } from "../types.js"
import { EngineError } from "../middleware/error-handler.js"
import type { ConnectionTracker } from "../util/connection-tracker.js"

// ---------------------------------------------------------------------------
// Route Config
// ---------------------------------------------------------------------------

export interface EventsRouteConfig {
  readonly sessionManager: SessionManager
  readonly eventStore: EventStore
  readonly connectionTracker: ConnectionTracker
  readonly authenticateCaller: (req: Request) => Promise<string>
}

// ---------------------------------------------------------------------------
// Participant check — caller must be buyer or a seller with an offer
// ---------------------------------------------------------------------------

function isParticipant(
  callerDid: string,
  buyerDid: string,
  offers: ReadonlyArray<{ readonly seller: string }>,
): boolean {
  if (callerDid === buyerDid) return true
  return offers.some((o) => o.seller === callerDid)
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

export function createEventsRoute(config: EventsRouteConfig): Hono<EngineEnv> {
  const { sessionManager, eventStore, connectionTracker, authenticateCaller } = config
  const router = new Hono<EngineEnv>()

  router.get("/rfqs/:id/events", async (c) => {
    const rfqId = c.req.param("id")

    // Step 1: Authenticate
    const callerDid = await authenticateCaller(c.req.raw)

    // Step 2: Session must exist
    const session = sessionManager.getSession(rfqId)
    if (!session) {
      throw new EngineError(404, "session_not_found", "RFQ session not found")
    }

    // Step 3: Participant check
    if (!isParticipant(callerDid, session.rfq.buyer, session.offers)) {
      throw new EngineError(401, "unauthorized", "Only participants can access events")
    }

    // Step 4: Determine mode
    const accept = c.req.header("Accept") ?? ""
    const isSSE = accept.includes("text/event-stream")

    // Step 5: Resolve cursor (Last-Event-ID takes precedence in SSE mode)
    const lastEventId = isSSE ? c.req.header("Last-Event-ID") : undefined
    const afterParam = c.req.query("after")
    const cursor = lastEventId ?? afterParam ?? undefined

    // Step 6: Validate cursor if provided
    if (cursor !== undefined && !eventStore.hasCursor(rfqId, cursor)) {
      if (isSSE) {
        // SSE: send error event and close
        return new Response(
          `event: error\ndata: ${JSON.stringify({ code: "invalid_cursor" })}\n\n`,
          {
            status: 200,
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            },
          },
        )
      }
      throw new EngineError(400, "invalid_cursor", "Cursor event_id not found in session")
    }

    if (isSSE) {
      // SSE mode — implemented in Task 6
      throw new EngineError(501, "not_implemented", "SSE mode not yet implemented")
    }

    // JSON polling mode
    const rfq = { buyer: session.rfq.buyer }
    const events = eventStore.getEvents(rfqId, callerDid, rfq, cursor)
    const lastEvent = events.length > 0 ? events[events.length - 1] : null
    const responseCursor = lastEvent ? lastEvent.event_id : (cursor ?? null)

    return c.json({
      rfq_id: rfqId,
      events,
      cursor: responseCursor,
      cursor_valid: true,
    }, 200)
  })

  return router
}
```

- [ ] **Step 4: Run tests to verify JSON mode passes**

Run: `cd /Volumes/MainSSD/HomeData/zengy/workspace/ghost-bazaar && pnpm --filter @ghost-bazaar/engine test -- tests/events.test.ts 2>&1 | tail -15`
Expected: All JSON mode tests PASS

- [ ] **Step 5: Commit**

```bash
cd /Volumes/MainSSD/HomeData/zengy/workspace/ghost-bazaar
git add packages/engine/src/routes/events.ts packages/engine/tests/events.test.ts
git commit -m "feat(engine): events route JSON polling mode (Step 9d)"
```

---

## Task 6: Events Route — SSE Streaming Mode

**Files:**
- Modify: `packages/engine/src/routes/events.ts`
- Modify: `packages/engine/tests/events.test.ts`

- [ ] **Step 1: Write failing tests for SSE mode**

Add to `tests/events.test.ts`:

```typescript
  describe("SSE mode", () => {
    it("streams existing events and new events in real-time", async () => {
      const { app, store } = createTestApp()
      const rfq = await createRfqSession(app)

      const res = await app.request(`/rfqs/${rfq.rfq_id}/events`, {
        headers: { Accept: "text/event-stream" },
      })
      expect(res.status).toBe(200)
      expect(res.headers.get("Content-Type")).toContain("text/event-stream")

      // Read the stream body
      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let accumulated = ""

      // Read initial replay events
      const { value } = await reader.read()
      accumulated += decoder.decode(value, { stream: true })

      // Should contain the RFQ_CREATED event
      expect(accumulated).toContain("event: negotiation")
      expect(accumulated).toContain("RFQ_CREATED")

      reader.cancel()
    })

    it("Last-Event-ID overrides ?after query param", async () => {
      const { app } = createTestApp()
      const rfq = await createRfqSession(app)
      await submitOffer(app, rfq.rfq_id, SELLER_A_KP)

      // Get the first event ID
      const jsonRes = await app.request(`/rfqs/${rfq.rfq_id}/events`, {
        headers: { Accept: "application/json" },
      })
      const body = await jsonRes.json() as any
      const firstEventId = body.events[0].event_id
      const lastEventId = body.events[1].event_id

      // Use Last-Event-ID (should replay from first event, ignoring ?after=last)
      const res = await app.request(`/rfqs/${rfq.rfq_id}/events?after=${lastEventId}`, {
        headers: {
          Accept: "text/event-stream",
          "Last-Event-ID": firstEventId,
        },
      })

      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      const { value } = await reader.read()
      const text = decoder.decode(value, { stream: true })

      // Should contain the offer (after first event, not after last)
      expect(text).toContain("OFFER_SUBMITTED")

      reader.cancel()
    })

    it("invalid cursor returns error event and closes", async () => {
      const { app } = createTestApp()
      const rfq = await createRfqSession(app)

      const res = await app.request(`/rfqs/${rfq.rfq_id}/events?after=bad-cursor`, {
        headers: { Accept: "text/event-stream" },
      })

      const text = await res.text()
      expect(text).toContain("event: error")
      expect(text).toContain("invalid_cursor")
    })

    it("role-scoped: seller only sees own events", async () => {
      const { app } = createTestApp(async () => SELLER_A_DID)
      const rfq = await createRfqSession(app)
      await submitOffer(app, rfq.rfq_id, SELLER_A_KP)
      await submitOffer(app, rfq.rfq_id, SELLER_B_KP)

      const res = await app.request(`/rfqs/${rfq.rfq_id}/events`, {
        headers: { Accept: "text/event-stream" },
      })

      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      const { value } = await reader.read()
      const text = decoder.decode(value, { stream: true })

      // Seller A should see RFQ + own offer, NOT Seller B's offer
      expect(text).toContain("RFQ_CREATED")
      expect(text).toContain(SELLER_A_DID)
      expect(text).not.toContain(SELLER_B_DID)

      reader.cancel()
    })
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Volumes/MainSSD/HomeData/zengy/workspace/ghost-bazaar && pnpm --filter @ghost-bazaar/engine test -- tests/events.test.ts 2>&1 | tail -10`
Expected: FAIL — SSE tests fail (501 not_implemented or wrong response)

- [ ] **Step 3: Implement SSE streaming mode**

Replace the SSE placeholder in `src/routes/events.ts`. The SSE mode replaces the `throw new EngineError(501, ...)` block:

```typescript
    if (isSSE) {
      // SSE streaming mode
      const rfq = { buyer: session.rfq.buyer }

      // Check connection limit
      let connectionId: string | null = null
      const isBuyer = callerDid === session.rfq.buyer

      // We'll set up the close callback after creating the stream
      let closeStream: (() => void) | null = null

      const stream = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder()

          function send(text: string): boolean {
            try {
              controller.enqueue(encoder.encode(text))
              return true
            } catch {
              return false // Stream closed
            }
          }

          function sendEvent(eventId: string, data: string): boolean {
            return send(`id: ${eventId}\nevent: negotiation\ndata: ${data}\n\n`)
          }

          function sendTerminal(state: string): void {
            send(`event: terminal\ndata: ${JSON.stringify({ state })}\n\n`)
          }

          // Acquire connection slot
          closeStream = () => {
            try { controller.close() } catch { /* already closed */ }
          }

          connectionId = connectionTracker.acquire({
            rfqId,
            callerDid,
            isBuyer,
            close: () => {
              // Eviction: send error before close
              send(`event: error\ndata: ${JSON.stringify({ code: "evicted" })}\n\n`)
              cleanup()
            },
          })

          if (connectionId === null) {
            send(`event: error\ndata: ${JSON.stringify({ code: "connection_limit" })}\n\n`)
            try { controller.close() } catch { /* already closed */ }
            return
          }

          // Atomic replay+subscribe
          const sub = eventStore.subscribeFrom(
            rfqId, callerDid, rfq, cursor,
            (event) => {
              // Live event delivery
              sendEvent(event.event_id, JSON.stringify(event))
            },
          )

          // Subscribe to terminal state notification
          const unsubTerminal = eventStore.subscribeTerminal(rfqId, (state) => {
            sendTerminal(state)
            cleanup()
          })

          // Send replay events
          for (const event of sub.replay) {
            sendEvent(event.event_id, JSON.stringify(event))
          }

          // Send buffered events (between subscribe and now)
          for (const event of sub.buffered) {
            sendEvent(event.event_id, JSON.stringify(event))
          }

          // Check if session is already terminal
          const currentSession = sessionManager.getSession(rfqId)
          const terminalStates = new Set(["COMMITTED", "EXPIRED", "CANCELLED"])
          if (currentSession && terminalStates.has(currentSession.state)) {
            sendTerminal(currentSession.state)
            sub.unsubscribe()
            unsubTerminal()
            try { controller.close() } catch { /* already closed */ }
            return
          }

          // Activate live delivery (replay+buffered have been flushed)
          sub.activate()

          // Heartbeat
          const heartbeatInterval = setInterval(() => {
            if (!send(": heartbeat\n\n")) {
              cleanup()
            }
          }, 15_000)
          if (typeof heartbeatInterval === "object" && "unref" in heartbeatInterval) {
            heartbeatInterval.unref()
          }

          function cleanup() {
            clearInterval(heartbeatInterval)
            sub.unsubscribe()
            unsubTerminal()
            if (connectionId) {
              connectionTracker.release(connectionId)
              connectionId = null
            }
            try { controller.close() } catch { /* already closed */ }
          }

          // Listen for client disconnect
          c.req.raw.signal.addEventListener("abort", cleanup)
        },
      })

      return new Response(stream, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      })
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Volumes/MainSSD/HomeData/zengy/workspace/ghost-bazaar && pnpm --filter @ghost-bazaar/engine test -- tests/events.test.ts 2>&1 | tail -15`
Expected: All tests PASS

- [ ] **Step 5: Run full test suite**

Run: `cd /Volumes/MainSSD/HomeData/zengy/workspace/ghost-bazaar && pnpm --filter @ghost-bazaar/engine test 2>&1 | tail -10`
Expected: All tests PASS (no regressions)

- [ ] **Step 6: Commit**

```bash
cd /Volumes/MainSSD/HomeData/zengy/workspace/ghost-bazaar
git add packages/engine/src/routes/events.ts packages/engine/tests/events.test.ts
git commit -m "feat(engine): events route SSE streaming mode (Step 9e)"
```

---

## Task 7: Terminal Close + Connection Limit Integration Tests

**Files:**
- Modify: `packages/engine/tests/events.test.ts`

- [ ] **Step 1: Write terminal close and connection limit tests**

Add to `tests/events.test.ts`:

```typescript
  describe("terminal close", () => {
    it("already-terminal session: sends replay + terminal event, then closes", async () => {
      // Create a session and expire it
      const { app, store, sessionManager } = createTestApp()
      const rfq = await createRfqSession(app)

      // Manually append an EXPIRED event
      await sessionManager.withLock(rfq.rfq_id, async () => {
        return sessionManager.appendEvent(rfq.rfq_id, {
          event_id: crypto.randomUUID(),
          rfq_id: rfq.rfq_id,
          type: "NEGOTIATION_EXPIRED",
          timestamp: new Date().toISOString(),
          actor: "system",
          payload: {},
        })
      })

      const res = await app.request(`/rfqs/${rfq.rfq_id}/events`, {
        headers: { Accept: "text/event-stream" },
      })

      const text = await res.text()
      expect(text).toContain("RFQ_CREATED")
      expect(text).toContain("event: terminal")
      expect(text).toContain('"EXPIRED"')
    })
  })

  describe("connection limits", () => {
    it("rejects connection when per-DID limit exceeded", async () => {
      const { app, connectionTracker } = createTestApp()
      const rfq = await createRfqSession(app)

      // Pre-fill 3 connections for buyer
      for (let i = 0; i < 3; i++) {
        connectionTracker.acquire({
          rfqId: rfq.rfq_id,
          callerDid: BUYER_DID,
          isBuyer: true,
          close: () => {},
        })
      }

      const res = await app.request(`/rfqs/${rfq.rfq_id}/events`, {
        headers: { Accept: "text/event-stream" },
      })

      const text = await res.text()
      expect(text).toContain("connection_limit")
    })
  })

  describe("heartbeat", () => {
    it("sends heartbeat comment at configured interval", async () => {
      vi.useFakeTimers()
      try {
        const { app } = createTestApp()
        const rfq = await createRfqSession(app)

        const res = await app.request(`/rfqs/${rfq.rfq_id}/events`, {
          headers: { Accept: "text/event-stream" },
        })

        const reader = res.body!.getReader()
        const decoder = new TextDecoder()

        // Read initial replay
        const { value: initial } = await reader.read()
        const initialText = decoder.decode(initial, { stream: true })
        expect(initialText).toContain("RFQ_CREATED")

        // Advance 15 seconds — should trigger heartbeat
        vi.advanceTimersByTime(15_000)

        const { value: heartbeat } = await reader.read()
        const hbText = decoder.decode(heartbeat, { stream: true })
        expect(hbText).toContain(": heartbeat")

        reader.cancel()
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe("disconnect cleanup", () => {
    it("cleans up subscriptions on client abort", async () => {
      const { app, store, connectionTracker } = createTestApp()
      const rfq = await createRfqSession(app)

      const controller = new AbortController()
      const res = await app.request(`/rfqs/${rfq.rfq_id}/events`, {
        headers: { Accept: "text/event-stream" },
        signal: controller.signal,
      })

      // Connection should be tracked
      expect(connectionTracker.countForSession(rfq.rfq_id)).toBe(1)

      // Abort the connection
      controller.abort()

      // Give cleanup a tick to run
      await new Promise((r) => setTimeout(r, 10))

      // Connection should be released
      expect(connectionTracker.countForSession(rfq.rfq_id)).toBe(0)
    })
  })
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `cd /Volumes/MainSSD/HomeData/zengy/workspace/ghost-bazaar && pnpm --filter @ghost-bazaar/engine test -- tests/events.test.ts 2>&1 | tail -15`
Expected: All tests PASS

- [ ] **Step 3: Run full test suite for final verification**

Run: `cd /Volumes/MainSSD/HomeData/zengy/workspace/ghost-bazaar && pnpm --filter @ghost-bazaar/engine test 2>&1 | tail -10`
Expected: All tests PASS

- [ ] **Step 4: Verify TypeScript compiles cleanly**

Run: `cd /Volumes/MainSSD/HomeData/zengy/workspace/ghost-bazaar && pnpm --filter @ghost-bazaar/engine build 2>&1 | tail -5`
Expected: Clean compilation

- [ ] **Step 5: Commit**

```bash
cd /Volumes/MainSSD/HomeData/zengy/workspace/ghost-bazaar
git add packages/engine/tests/events.test.ts
git commit -m "test(engine): terminal close + connection limit integration tests (Step 9f)"
```

---

## Task 8: Final Integration — Mount Route in App

**Files:**
- Modify: `packages/engine/src/app.ts` (if routes need to be wired up — check existing pattern)

- [ ] **Step 1: Verify the route is mountable**

Check how other routes are mounted. The events route follows the same `createEventsRoute(config)` pattern — it returns a `Hono<EngineEnv>` that can be mounted with `app.route("/", eventsRouter)`.

This step may be a no-op if routes are mounted at the test/integration level only (the engine doesn't have a main entrypoint yet — that's Step 12).

- [ ] **Step 2: Run full test suite one final time**

Run: `cd /Volumes/MainSSD/HomeData/zengy/workspace/ghost-bazaar && pnpm --filter @ghost-bazaar/engine test 2>&1 | tail -10`
Expected: All tests PASS

- [ ] **Step 3: Final commit**

```bash
cd /Volumes/MainSSD/HomeData/zengy/workspace/ghost-bazaar
git add -A
git commit -m "feat(engine): implement Step 9 — GET /rfqs/:id/events (SSE + JSON dual-mode)"
```
