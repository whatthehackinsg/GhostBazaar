# Step 10: Deadline Enforcer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a periodic scanner that auto-expires sessions past their RFQ deadline and enforces cosign timeouts, with proper lock serialization, terminal cleanup, and self-scheduling to prevent overlap.

**Architecture:** Self-scheduling `setTimeout` loop scans active sessions. Unlocked fast-path check, then `withLock` re-validation before appending events. Terminal sessions get SSE connections closed + lock removed + marked as cleaned.

**Tech Stack:** Vitest (fake timers), SessionManager (locks), EventStore (events), ConnectionTracker (SSE cleanup)

**Design doc:** Codex PASS 8.0/10 (Round 3), design in conversation history.

**Deployment assumption:** Single engine instance only. Process-local locks.

---

## File Structure

| File | Responsibility | New/Modify |
|------|---------------|------------|
| `src/state/session.ts` | Add `commitPendingAt` field to DerivedSession + reducer | Modify |
| `src/types.ts` | Add `listSessionIds()` to InternalEventStore | Modify |
| `src/state/event-store.ts` | Implement `listSessionIds()` on InMemoryEventStore | Modify |
| `src/state/session-manager.ts` | Add `getActiveSessionIds()` | Modify |
| `src/deadline-enforcer.ts` | The enforcer class | New |
| `tests/deadline-enforcer.test.ts` | Tests with fake timers | New |
| `tests/derive-state.test.ts` | Tests for commitPendingAt field | Modify |

---

## Task 1: Add `commitPendingAt` to DerivedSession

**Files:**
- Modify: `packages/engine/src/state/session.ts`
- Modify: `packages/engine/tests/derive-state.test.ts`

- [ ] **Step 1: Write failing tests for commitPendingAt**

Add to `tests/derive-state.test.ts` (inside the existing describe block):

```typescript
  describe("commitPendingAt", () => {
    it("is null initially and after offers", () => {
      const events = [
        makeRfqEvent(),
        makeOfferEvent(SELLER_A_DID),
      ]
      const session = deriveState(events)!
      expect(session.commitPendingAt).toBeNull()
    })

    it("is set to WINNER_SELECTED timestamp when entering COMMIT_PENDING", () => {
      const winnerEvent = makeWinnerSelectedEvent(SELLER_A_DID)
      const events = [
        makeRfqEvent(),
        makeOfferEvent(SELLER_A_DID),
        winnerEvent,
      ]
      const session = deriveState(events)!
      expect(session.state).toBe("COMMIT_PENDING")
      expect(session.commitPendingAt).toBe(winnerEvent.timestamp)
    })

    it("is cleared on COSIGN_DECLINED (rollback to NEGOTIATING)", () => {
      const events = [
        makeRfqEvent(),
        makeOfferEvent(SELLER_A_DID),
        makeWinnerSelectedEvent(SELLER_A_DID),
        makeCosignDeclinedEvent(SELLER_A_DID),
      ]
      const session = deriveState(events)!
      expect(session.state).toBe("NEGOTIATING")
      expect(session.commitPendingAt).toBeNull()
    })

    it("is cleared on COSIGN_TIMEOUT (rollback to NEGOTIATING)", () => {
      const events = [
        makeRfqEvent(),
        makeOfferEvent(SELLER_A_DID),
        makeWinnerSelectedEvent(SELLER_A_DID),
        makeCosignTimeoutEvent(SELLER_A_DID),
      ]
      const session = deriveState(events)!
      expect(session.state).toBe("NEGOTIATING")
      expect(session.commitPendingAt).toBeNull()
    })

    it("is re-set on second WINNER_SELECTED after rollback", () => {
      const winner2 = makeWinnerSelectedEvent(SELLER_A_DID)
      const events = [
        makeRfqEvent(),
        makeOfferEvent(SELLER_A_DID),
        makeWinnerSelectedEvent(SELLER_A_DID),
        makeCosignDeclinedEvent(SELLER_A_DID),
        winner2,
      ]
      const session = deriveState(events)!
      expect(session.state).toBe("COMMIT_PENDING")
      expect(session.commitPendingAt).toBe(winner2.timestamp)
    })
  })
```

- [ ] **Step 2: Run tests — expect fail**

Run: `pnpm --filter @ghost-bazaar/engine test -- tests/derive-state.test.ts`
Expected: FAIL — `commitPendingAt` does not exist on DerivedSession

- [ ] **Step 3: Add commitPendingAt to DerivedSession interface**

In `src/state/session.ts`, add to the `DerivedSession` interface after `sellerSignature`:

```typescript
  // ---------------------------------------------------------------------------
  // Commitment timing — used by deadline enforcer for cosign timeout
  // ---------------------------------------------------------------------------
  /** ISO timestamp when WINNER_SELECTED moved session to COMMIT_PENDING. Null otherwise. */
  readonly commitPendingAt: string | null
```

- [ ] **Step 4: Add commitPendingAt to reducer**

In `src/state/session.ts` `deriveState()`:

1. Add variable after `sellerSignature`:
```typescript
  let commitPendingAt: string | null = null
```

2. In the `WINNER_SELECTED` case (after `sellerSignature = null`), add:
```typescript
        commitPendingAt = event.timestamp
```

3. In the `COSIGN_DECLINED` / `COSIGN_TIMEOUT` case (after `sellerSignature = null`), add:
```typescript
        commitPendingAt = null
```

4. In the return statement, add `commitPendingAt`:
```typescript
  return {
    state, rfq, offers, counters, selectedSeller, selectedOfferId,
    quoteRevision, totalOfferCount, offerCountBySeller: offerCountBySeller,
    totalAcceptAttempts, acceptAttemptsBySeller,
    lastEventId, unsignedQuote, buyerSignature, sellerSignature,
    commitPendingAt,
  }
```

- [ ] **Step 5: Run tests — expect pass**

Run: `pnpm --filter @ghost-bazaar/engine test -- tests/derive-state.test.ts`
Expected: All tests PASS

- [ ] **Step 6: Run full test suite**

Run: `pnpm --filter @ghost-bazaar/engine test`
Expected: All tests PASS (no regressions from adding the field)

- [ ] **Step 7: Commit**

```bash
git add packages/engine/src/state/session.ts packages/engine/tests/derive-state.test.ts
git commit -m "feat(engine): add commitPendingAt to DerivedSession for cosign timeout (Step 10a)"
```

---

## Task 2: Add `listSessionIds` + `getActiveSessionIds`

**Files:**
- Modify: `packages/engine/src/types.ts`
- Modify: `packages/engine/src/state/event-store.ts`
- Modify: `packages/engine/src/state/session-manager.ts`
- Modify: `packages/engine/tests/event-store.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `tests/event-store.test.ts`:

```typescript
  describe("listSessionIds", () => {
    it("returns empty array when no sessions exist", () => {
      const store = new InMemoryEventStore()
      expect(store.listSessionIds()).toEqual([])
    })

    it("returns all session IDs", () => {
      const store = new InMemoryEventStore()
      store.append(RFQ_ID, makeRfqEvent())
      store.append("rfq-other", makeRfqEvent("rfq-other"))
      const ids = store.listSessionIds()
      expect(ids).toHaveLength(2)
      expect(ids).toContain(RFQ_ID)
      expect(ids).toContain("rfq-other")
    })
  })
```

- [ ] **Step 2: Add `listSessionIds` to InternalEventStore interface**

In `src/types.ts`, add to the `InternalEventStore` interface:

```typescript
  /** List all rfqIds that have at least one event. Used by deadline enforcer. */
  listSessionIds(): readonly string[]
```

- [ ] **Step 3: Implement on InMemoryEventStore**

In `src/state/event-store.ts`:

```typescript
  listSessionIds(): readonly string[] {
    return [...this.events.keys()]
  }
```

- [ ] **Step 4: Add `getActiveSessionIds` to SessionManager**

In `src/state/session-manager.ts`:

```typescript
  /**
   * List all session IDs that have events.
   * Used by the deadline enforcer to iterate sessions.
   */
  getActiveSessionIds(): readonly string[] {
    return this.eventStore.listSessionIds()
  }
```

- [ ] **Step 5: Run tests — expect pass**

Run: `pnpm --filter @ghost-bazaar/engine test`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/types.ts packages/engine/src/state/event-store.ts packages/engine/src/state/session-manager.ts packages/engine/tests/event-store.test.ts
git commit -m "feat(engine): add listSessionIds + getActiveSessionIds for session enumeration (Step 10b)"
```

---

## Task 3: Implement DeadlineEnforcer

**Files:**
- Create: `packages/engine/src/deadline-enforcer.ts`
- Create: `packages/engine/tests/deadline-enforcer.test.ts`

- [ ] **Step 1: Write failing tests**

Create `tests/deadline-enforcer.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { InMemoryEventStore } from "../src/state/event-store.js"
import { SessionManager } from "../src/state/session-manager.js"
import { ConnectionTracker } from "../src/util/connection-tracker.js"
import { DeadlineEnforcer } from "../src/deadline-enforcer.js"
import type { NegotiationEvent, EventType } from "../src/types.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BUYER = "did:key:z6MkBuyer"
const SELLER_A = "did:key:z6MkSellerA"

function makeEvent(
  type: EventType,
  rfqId: string,
  actor: string,
  payload: Record<string, unknown> = {},
): NegotiationEvent {
  return {
    event_id: crypto.randomUUID(),
    rfq_id: rfqId,
    type,
    timestamp: new Date().toISOString(),
    actor,
    payload: { rfq_id: rfqId, ...payload },
  }
}

function createRfqEvent(rfqId: string, deadlineMs: number): NegotiationEvent {
  return makeEvent("RFQ_CREATED", rfqId, BUYER, {
    protocol: "ghost-bazaar-v4",
    buyer: BUYER,
    service_type: "llm-inference",
    spec: {},
    anchor_price: "30.00",
    currency: "USDC",
    deadline: new Date(Date.now() + deadlineMs).toISOString(),
    signature: "ed25519:AAAA",
  })
}

function createOfferEvent(rfqId: string): NegotiationEvent {
  return makeEvent("OFFER_SUBMITTED", rfqId, SELLER_A, {
    offer_id: crypto.randomUUID(),
    seller: SELLER_A,
    price: "28.50",
    currency: "USDC",
    valid_until: new Date(Date.now() + 300_000).toISOString(),
    signature: "ed25519:BBBB",
    listing_id: "listing-1",
    payment_endpoint: "https://seller.example.com/pay",
  })
}

function createWinnerEvent(rfqId: string): NegotiationEvent {
  return makeEvent("WINNER_SELECTED", rfqId, BUYER, {
    seller: SELLER_A,
    offer_id: crypto.randomUUID(),
    quote: {
      quote_id: crypto.randomUUID(),
      rfq_id: rfqId,
      buyer: BUYER,
      seller: SELLER_A,
      final_price: "28.50",
      currency: "USDC",
      nonce: crypto.randomUUID(),
      expires_at: new Date(Date.now() + 300_000).toISOString(),
      payment_endpoint: "https://seller.example.com/pay",
    },
  })
}

function setup(intervalMs = 100, cosignTimeoutMs = 500) {
  const store = new InMemoryEventStore()
  const sessionManager = new SessionManager(store)
  const connectionTracker = new ConnectionTracker()
  const enforcer = new DeadlineEnforcer({
    sessionManager,
    eventStore: store,
    connectionTracker,
    intervalMs,
    cosignTimeoutMs,
  })
  return { store, sessionManager, connectionTracker, enforcer }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DeadlineEnforcer", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("expires OPEN session past deadline", async () => {
    const { store, sessionManager, enforcer } = setup()
    // Create session with 50ms deadline
    store.append("rfq-1", createRfqEvent("rfq-1", 50))

    enforcer.start()

    // Advance past deadline
    vi.advanceTimersByTime(60)
    // Advance past scan interval
    await vi.advanceTimersByTimeAsync(110)

    const session = sessionManager.getSession("rfq-1")
    expect(session!.state).toBe("EXPIRED")

    enforcer.stop()
  })

  it("expires NEGOTIATING session past deadline", async () => {
    const { store, sessionManager, enforcer } = setup()
    store.append("rfq-1", createRfqEvent("rfq-1", 50))
    store.append("rfq-1", createOfferEvent("rfq-1"))

    const session1 = sessionManager.getSession("rfq-1")
    expect(session1!.state).toBe("NEGOTIATING")

    enforcer.start()
    vi.advanceTimersByTime(60)
    await vi.advanceTimersByTimeAsync(110)

    const session2 = sessionManager.getSession("rfq-1")
    expect(session2!.state).toBe("EXPIRED")

    enforcer.stop()
  })

  it("expires COMMIT_PENDING session past deadline", async () => {
    const { store, sessionManager, enforcer } = setup()
    store.append("rfq-1", createRfqEvent("rfq-1", 50))
    store.append("rfq-1", createOfferEvent("rfq-1"))
    store.append("rfq-1", createWinnerEvent("rfq-1"))

    const session1 = sessionManager.getSession("rfq-1")
    expect(session1!.state).toBe("COMMIT_PENDING")

    enforcer.start()
    vi.advanceTimersByTime(60)
    await vi.advanceTimersByTimeAsync(110)

    const session2 = sessionManager.getSession("rfq-1")
    expect(session2!.state).toBe("EXPIRED")

    enforcer.stop()
  })

  it("triggers COSIGN_TIMEOUT after cosign timeout in COMMIT_PENDING", async () => {
    const { store, sessionManager, enforcer } = setup(100, 200)
    // Deadline is far in the future, but cosign timeout is 200ms
    store.append("rfq-1", createRfqEvent("rfq-1", 300_000))
    store.append("rfq-1", createOfferEvent("rfq-1"))
    store.append("rfq-1", createWinnerEvent("rfq-1"))

    enforcer.start()

    // Advance past cosign timeout
    await vi.advanceTimersByTimeAsync(350)

    const session = sessionManager.getSession("rfq-1")
    expect(session!.state).toBe("NEGOTIATING") // rolled back
    expect(session!.commitPendingAt).toBeNull()
    expect(session!.selectedSeller).toBeNull()

    enforcer.stop()
  })

  it("does NOT expire COMMITTED sessions", async () => {
    const { store, sessionManager, enforcer } = setup()
    store.append("rfq-1", createRfqEvent("rfq-1", 50))
    store.append("rfq-1", createOfferEvent("rfq-1"))
    store.append("rfq-1", createWinnerEvent("rfq-1"))
    // Manually add quote signed + committed events to reach COMMITTED
    store.append("rfq-1", makeEvent("QUOTE_SIGNED", "rfq-1", BUYER, {
      seller: SELLER_A,
      buyer_signature: "ed25519:SIG1",
    }))
    store.append("rfq-1", makeEvent("QUOTE_COMMITTED", "rfq-1", SELLER_A, {
      seller: SELLER_A,
      seller_signature: "ed25519:SIG2",
    }))

    expect(sessionManager.getSession("rfq-1")!.state).toBe("COMMITTED")

    enforcer.start()
    vi.advanceTimersByTime(60)
    await vi.advanceTimersByTimeAsync(110)

    // Still COMMITTED, not re-expired
    expect(sessionManager.getSession("rfq-1")!.state).toBe("COMMITTED")

    enforcer.stop()
  })

  it("stop() prevents further scanning", async () => {
    const { store, sessionManager, enforcer } = setup()
    store.append("rfq-1", createRfqEvent("rfq-1", 50))

    enforcer.start()
    enforcer.stop()

    vi.advanceTimersByTime(60)
    await vi.advanceTimersByTimeAsync(200)

    // Session should NOT be expired because enforcer was stopped
    expect(sessionManager.getSession("rfq-1")!.state).toBe("OPEN")
  })

  it("multiple scans are idempotent — already expired session not re-processed", async () => {
    const { store, sessionManager, enforcer } = setup()
    store.append("rfq-1", createRfqEvent("rfq-1", 50))

    enforcer.start()

    // First scan expires it
    vi.advanceTimersByTime(60)
    await vi.advanceTimersByTimeAsync(110)
    expect(sessionManager.getSession("rfq-1")!.state).toBe("EXPIRED")

    // Second scan should not throw or double-process
    await vi.advanceTimersByTimeAsync(110)
    expect(sessionManager.getSession("rfq-1")!.state).toBe("EXPIRED")

    enforcer.stop()
  })

  it("cleans up terminal session connections", async () => {
    const { store, connectionTracker, enforcer } = setup()
    store.append("rfq-1", createRfqEvent("rfq-1", 50))

    // Simulate an SSE connection
    const closeFn = vi.fn()
    connectionTracker.acquire({ rfqId: "rfq-1", callerDid: BUYER, isBuyer: true, close: closeFn })
    expect(connectionTracker.countForSession("rfq-1")).toBe(1)

    enforcer.start()
    vi.advanceTimersByTime(60)
    await vi.advanceTimersByTimeAsync(110)

    // Connection should be closed
    expect(closeFn).toHaveBeenCalled()
    expect(connectionTracker.countForSession("rfq-1")).toBe(0)

    enforcer.stop()
  })
})
```

- [ ] **Step 2: Run tests — expect fail**

Run: `pnpm --filter @ghost-bazaar/engine test -- tests/deadline-enforcer.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement DeadlineEnforcer**

Create `src/deadline-enforcer.ts`:

```typescript
/**
 * DeadlineEnforcer — periodic scanner that auto-expires sessions.
 *
 * Two responsibilities:
 * 1. RFQ deadline: OPEN/NEGOTIATING/COMMIT_PENDING → EXPIRED when rfq.deadline passes
 * 2. Cosign timeout: COMMIT_PENDING → NEGOTIATING (via COSIGN_TIMEOUT) after timeout
 *
 * DEPLOYMENT: Single engine instance only. Uses process-local SessionManager locks.
 *
 * Uses self-scheduling setTimeout (not setInterval) to prevent overlapping scans.
 * Re-validates conditions inside withLock to handle concurrent state changes.
 */

import type { SessionManager } from "./state/session-manager.js"
import { SessionBusyError } from "./state/session-manager.js"
import type { EventStore, NegotiationEvent } from "./types.js"
import type { ConnectionTracker } from "./util/connection-tracker.js"

// ---------------------------------------------------------------------------
// Terminal states — sessions in these states are cleaned up, not scanned
// ---------------------------------------------------------------------------

const TERMINAL_STATES: ReadonlySet<string> = new Set([
  "COMMITTED",
  "EXPIRED",
  "CANCELLED",
])

// ---------------------------------------------------------------------------
// Non-terminal states eligible for deadline expiry
// ---------------------------------------------------------------------------

const EXPIRABLE_STATES: ReadonlySet<string> = new Set([
  "OPEN",
  "NEGOTIATING",
  "COMMIT_PENDING",
])

// ---------------------------------------------------------------------------
// Configuration defaults and bounds
// ---------------------------------------------------------------------------

const DEFAULT_INTERVAL_MS = 1_000
const MIN_INTERVAL_MS = 500
const MAX_INTERVAL_MS = 10_000

const DEFAULT_COSIGN_TIMEOUT_MS = 60_000
const MIN_COSIGN_TIMEOUT_MS = 15_000
const MAX_COSIGN_TIMEOUT_MS = 120_000

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface DeadlineEnforcerConfig {
  readonly sessionManager: SessionManager
  readonly eventStore: EventStore
  readonly connectionTracker: ConnectionTracker
  readonly intervalMs?: number
  readonly cosignTimeoutMs?: number
}

// ---------------------------------------------------------------------------
// DeadlineEnforcer
// ---------------------------------------------------------------------------

export class DeadlineEnforcer {
  private readonly sessionManager: SessionManager
  private readonly eventStore: EventStore
  private readonly connectionTracker: ConnectionTracker
  private readonly intervalMs: number
  private readonly cosignTimeoutMs: number

  /** Sessions that have been fully cleaned up — skip on future scans */
  private readonly cleanedUpSessions = new Set<string>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false

  constructor(config: DeadlineEnforcerConfig) {
    this.sessionManager = config.sessionManager
    this.eventStore = config.eventStore
    this.connectionTracker = config.connectionTracker
    this.intervalMs = clamp(
      config.intervalMs ?? DEFAULT_INTERVAL_MS,
      MIN_INTERVAL_MS, MAX_INTERVAL_MS,
    )
    this.cosignTimeoutMs = clamp(
      config.cosignTimeoutMs ?? DEFAULT_COSIGN_TIMEOUT_MS,
      MIN_COSIGN_TIMEOUT_MS, MAX_COSIGN_TIMEOUT_MS,
    )
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.scheduleNext()
  }

  stop(): void {
    this.running = false
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  private scheduleNext(): void {
    if (!this.running) return
    this.timer = setTimeout(async () => {
      try {
        await this.scan()
      } catch {
        // Unexpected scan error must not kill the enforcer loop (Codex non-blocking note)
      }
      this.scheduleNext()
    }, this.intervalMs)
    // Prevent timer from keeping Node alive during shutdown
    if (typeof this.timer === "object" && "unref" in this.timer) {
      this.timer.unref()
    }
  }

  private async scan(): Promise<void> {
    const allIds = this.sessionManager.getActiveSessionIds()

    for (const rfqId of allIds) {
      if (!this.running) break
      if (this.cleanedUpSessions.has(rfqId)) continue

      const session = this.sessionManager.getSession(rfqId)
      if (!session) continue

      // Clean up already-terminal sessions (may have been terminated by routes)
      if (TERMINAL_STATES.has(session.state)) {
        this.connectionTracker.closeAll(rfqId)
        if (this.sessionManager.removeLock(rfqId)) {
          this.cleanedUpSessions.add(rfqId)
        }
        continue
      }

      const now = Date.now()

      // Check 1: RFQ deadline expiry
      if (EXPIRABLE_STATES.has(session.state)) {
        const deadlineMs = new Date(session.rfq.deadline).getTime()
        if (now >= deadlineMs) {
          await this.tryExpire(rfqId)
          continue // Don't also check cosign timeout — session is expired
        }
      }

      // Check 2: Cosign timeout
      if (
        session.state === "COMMIT_PENDING" &&
        session.commitPendingAt !== null
      ) {
        const commitMs = new Date(session.commitPendingAt).getTime()
        if (now - commitMs >= this.cosignTimeoutMs) {
          await this.tryCosignTimeout(rfqId)
        }
      }
    }
  }

  private async tryExpire(rfqId: string): Promise<void> {
    try {
      await this.sessionManager.withLock(rfqId, async (lockedSession) => {
        // Re-validate inside lock (Codex R2-F7)
        if (!lockedSession) return
        if (TERMINAL_STATES.has(lockedSession.state)) return
        if (!EXPIRABLE_STATES.has(lockedSession.state)) return
        const deadlineMs = new Date(lockedSession.rfq.deadline).getTime()
        if (Date.now() < deadlineMs) return

        this.sessionManager.appendEvent(rfqId, {
          event_id: crypto.randomUUID(),
          rfq_id: rfqId,
          type: "NEGOTIATION_EXPIRED",
          timestamp: new Date().toISOString(),
          actor: "engine/deadline-enforcer",
          payload: {},
        })
      })
    } catch (e) {
      if (e instanceof SessionBusyError) return // Skip, retry next scan
      throw e
    }
  }

  private async tryCosignTimeout(rfqId: string): Promise<void> {
    try {
      await this.sessionManager.withLock(rfqId, async (lockedSession) => {
        // Re-validate inside lock (Codex R2-F7)
        if (!lockedSession) return
        if (lockedSession.state !== "COMMIT_PENDING") return
        if (!lockedSession.commitPendingAt) return
        const commitMs = new Date(lockedSession.commitPendingAt).getTime()
        if (Date.now() - commitMs < this.cosignTimeoutMs) return

        const seller = lockedSession.selectedSeller
        if (!seller) return // Shouldn't happen in COMMIT_PENDING, but defensive

        this.sessionManager.appendEvent(rfqId, {
          event_id: crypto.randomUUID(),
          rfq_id: rfqId,
          type: "COSIGN_TIMEOUT",
          timestamp: new Date().toISOString(),
          actor: "engine/deadline-enforcer",
          payload: { seller },
        })
      })
    } catch (e) {
      if (e instanceof SessionBusyError) return // Skip, retry next scan
      throw e
    }
  }
}
```

- [ ] **Step 4: Run tests — expect pass**

Run: `pnpm --filter @ghost-bazaar/engine test -- tests/deadline-enforcer.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Run full test suite**

Run: `pnpm --filter @ghost-bazaar/engine test`
Expected: All tests PASS

- [ ] **Step 6: Verify build**

Run: `pnpm --filter @ghost-bazaar/engine build`
Expected: Clean compilation

- [ ] **Step 7: Commit**

```bash
git add packages/engine/src/deadline-enforcer.ts packages/engine/tests/deadline-enforcer.test.ts
git commit -m "feat(engine): implement deadline enforcer with cosign timeout (Step 10c)"
```
