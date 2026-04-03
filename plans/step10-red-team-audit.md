# Step 10 Deadline Enforcer — Red Team Security Audit

**Target:** `packages/engine/src/deadline-enforcer.ts` and supporting modules
**Date:** 2026-03-21
**Auditor:** Red Team (Claude Opus 4.6)

---

## Finding 1: `cleanedUpSessions` Unbounded Memory Leak

**Severity: HIGH**

**Attack scenario:** Every session that reaches a terminal state gets added to `cleanedUpSessions` (a `Set<string>`). This set is **never pruned**. Over the lifetime of a long-running engine, it grows monotonically — one entry per completed/expired/cancelled session. An attacker can accelerate this by rapidly creating and expiring sessions (e.g., RFQs with immediate deadlines).

With UUIDs at ~36 bytes each, 10M sessions = ~360 MB of dead strings in a Set that is checked on every scan iteration.

**Impact:** Memory exhaustion / OOM crash on long-running deployments. Also degrades scan performance as `Set.has()` on very large sets has GC pressure from the string references.

**Fix:** Replace `Set<string>` with a bounded LRU or periodic flush. Alternatively, since `listSessionIds()` returns event store keys (which are also never pruned — see Finding 2), the `cleanedUpSessions` check is only useful to skip `getSession()` + `deriveState()` re-derivation. A simpler fix: remove sessions from the event store's `events` Map when terminal, and drop `cleanedUpSessions` entirely.

```typescript
// Option A: Periodic flush (least invasive)
private pruneCleanedUp(): void {
  if (this.cleanedUpSessions.size > 10_000) {
    this.cleanedUpSessions.clear()
    // Worst case: re-derives a few terminal sessions next scan, harmless
  }
}
```

---

## Finding 2: Event Store `listSessionIds()` Never Shrinks — Scan Cost Grows Linearly

**Severity: HIGH**

**Attack scenario:** `scan()` calls `getActiveSessionIds()` which calls `this.events.keys()` on the InMemoryEventStore. The events Map **never removes entries** — even terminal sessions remain. The enforcer iterates *every* session ID on every scan tick.

An attacker floods the engine with cheap RFQs (create + immediate expire) to grow the session list. With a 1-second scan interval and 1M sessions, each scan iterates 1M IDs, calling `getSession()` (which replays the entire event log via `deriveState()`) for any ID not in `cleanedUpSessions`.

Even with the `cleanedUpSessions` guard, the `for` loop still iterates and checks `this.cleanedUpSessions.has(rfqId)` for every session — O(N) per scan tick where N = total historical sessions.

**Impact:** CPU starvation. The enforcer scan takes longer than `intervalMs`, causing cascading delays. Legitimate sessions may not get expired promptly because the enforcer is busy iterating dead sessions.

**Fix:** Maintain a separate `activeSessions` set that removes IDs when they reach terminal state. The enforcer should only iterate active sessions.

---

## Finding 3: TOCTOU Race — Enforcer Reads State Outside Lock, Then Acts Inside Lock

**Severity: MEDIUM**

**Attack scenario (cosmetic, not exploitable):** In `scan()`, the enforcer reads `session.state` and `session.commitPendingAt` *outside* `withLock`, then calls `tryExpire()` or `tryCosignTimeout()` which re-read inside the lock. Between the outer read and the inner lock acquisition:

1. A route handler could transition COMMIT_PENDING -> COMMITTED (cosign completes).
2. The enforcer enters `tryExpire()` or `tryCosignTimeout()`.
3. Inside the lock, the re-validation catches this: `if (TERMINAL_STATES.has(lockedSession.state)) return`.

**This is correctly defended.** The double-check inside the lock prevents stale-read exploitation. However, the pattern still wastes lock acquisitions — every scan tick acquires locks for sessions whose state may have changed since the outer read.

**Impact:** Lock contention under high load. Each wasted lock acquisition occupies a queue slot (max 10), potentially causing `SessionBusyError` for legitimate route handlers during the brief window.

**Fix (hardening):** No correctness bug, but consider: (a) the outer check already prevents most unnecessary lock acquisitions, and (b) the `SessionBusyError` catch in `tryExpire`/`tryCosignTimeout` gracefully handles contention. Acceptable as-is, but document the intentional TOCTOU-safe pattern.

---

## Finding 4: `Date.now()` Monotonicity Assumption — No NTP Skew Protection

**Severity: MEDIUM**

**Attack scenario:** The cosign timeout check computes `now - commitMs >= this.cosignTimeoutMs`. If the system clock jumps backward (NTP correction, VM snapshot restore, DST-unaware system), `now - commitMs` could become negative, causing the timeout to never fire. Conversely, a forward jump could trigger premature timeout.

For `commitPendingAt`, the value is set from `event.timestamp` (ISO string from `new Date().toISOString()` at WINNER_SELECTED append time). If the clock skews between event creation and the enforcer scan, the timeout calculation is wrong.

**Impact:**
- **Clock backward:** Cosign timeout never fires for sessions created before the skew. Seller can hold COMMIT_PENDING indefinitely until the clock catches up.
- **Clock forward:** Legitimate sellers lose their cosign window prematurely.

**Fix:** Use a monotonic clock (`performance.now()` or `process.hrtime()`) for elapsed-time calculations. Store a monotonic timestamp alongside the ISO timestamp for timeout purposes.

---

## Finding 5: Enforcer Silently Swallows All Errors — No Alerting

**Severity: MEDIUM**

**Attack scenario:** The `scheduleNext()` catch block is `catch { }` — every error from `scan()` is silently swallowed. An attacker who discovers a way to cause `deriveState()` to throw for a specific session (e.g., by exploiting a malformed event that somehow bypassed validation) would cause the enforcer to skip that session forever after `cleanedUpSessions` is not populated.

Actually, the error propagation is more nuanced: `tryExpire()` and `tryCosignTimeout()` catch `SessionBusyError` but re-throw other errors. Those re-thrown errors propagate to `scan()` which **does not catch them** — they propagate to `scheduleNext()` which swallows them. A single malformed session causes the enforcer to abort the *entire* scan for that tick (all sessions after the failing one in the iteration are skipped).

**Impact:** A single poisoned session causes the enforcer to repeatedly fail at the same point in its iteration, skipping all subsequent sessions every tick. This is a denial-of-service against all sessions that sort lexicographically after the poisoned one.

**Fix:** Wrap the per-session logic inside `scan()` in a try/catch. On persistent failure for a session, add it to a "quarantine" set and log an alert.

```typescript
for (const rfqId of allIds) {
  try {
    // ... existing per-session logic
  } catch (e) {
    // Log and quarantine — don't let one bad session kill the whole scan
    this.quarantinedSessions.add(rfqId)
  }
}
```

---

## Finding 6: `removeLock` + `cleanedUpSessions` Interaction — Premature Lock Removal Blocks Future Operations

**Severity: MEDIUM**

**Attack scenario:** When the enforcer sees a terminal session, it calls `removeLock(rfqId)`. If this returns true, the session is added to `cleanedUpSessions`. But `removeLock` deletes the lock from the `locks` Map. If a late-arriving route handler (e.g., a cosign request that was already in-flight) tries to `withLock` after the lock is removed, `getOrCreateLock` creates a *new* lock. The handler proceeds, acquires the new lock, reads the session (which is terminal), and returns an error — harmless.

However, this creates a new lock entry in the `locks` Map that will never be cleaned up (the session is already in `cleanedUpSessions`, so the enforcer skips it). Over time, these orphaned locks accumulate.

**Impact:** Minor memory leak from orphaned SessionLock objects. Each lock is small (~200 bytes), so this requires millions of late arrivals to matter. Low practical impact.

**Fix:** In `withLock`, check if the session is terminal after acquiring the lock and self-clean.

---

## Finding 7: No CANCELLATION Transition from COMMIT_PENDING

**Severity: LOW**

**Observation:** The state machine allows `NEGOTIATION_EXPIRED` from COMMIT_PENDING but NOT `NEGOTIATION_CANCELLED`. Once in COMMIT_PENDING, the buyer cannot cancel — they must wait for either cosign, decline, timeout, or RFQ deadline expiry.

This is likely intentional (the buyer initiated the commitment), but it means an attacker (malicious seller) can:
1. Submit an offer.
2. Wait for buyer to accept (NEGOTIATING -> COMMIT_PENDING).
3. Neither cosign nor decline — just wait.
4. The buyer is locked for up to `cosignTimeoutMs` (60s default, max 120s).

Combined with the max 6 accepts and max 2 per seller, 3 colluding sellers can burn 6 accept cycles * 60s = 360 seconds of wasted negotiation time.

**Impact:** Griefing / time-wasting attack. Limited by accept limits and cosign timeout, but still annoying.

**Fix:** Consider allowing buyer cancellation from COMMIT_PENDING, or shortening the default cosign timeout. The current anti-griefing limits (6 accepts, 2 per seller) already bound the damage.

---

## Finding 8: `seenEventIds` in EventStore Grows Unbounded

**Severity: LOW**

**Observation:** Related to the enforcer: `InMemoryEventStore.seenEventIds` is a Set of all event IDs ever appended. Like `cleanedUpSessions`, it never shrinks. With ~10 events per session and 1M sessions, that is 10M UUIDs (~360 MB). This is the same class of leak as Finding 1 but in a different component.

**Impact:** Memory growth proportional to total historical event count.

**Fix:** If sessions are pruned from the events Map, their event IDs can be removed from `seenEventIds` at the same time.

---

## Finding 9: Cosign Route Pre-Lock Read Creates Brief Inconsistency Window

**Severity: LOW**

**Observation:** The cosign route reads `preSession = sessionManager.getSession(rfqId)` outside the lock for signature format pre-checking. Between this read and the `withLock` call, a COSIGN_TIMEOUT could fire, reverting the session to NEGOTIATING. The lock body correctly re-validates state, so this is not exploitable. But the pre-check error message ("No active commitment found") could be confusing when the real situation is "commitment timed out while you were submitting."

**Impact:** UX confusion only. No security impact.

**Fix:** Return a more descriptive error from the lock body when state != COMMIT_PENDING after the pre-check passed.

---

## Summary Table

| # | Severity | Finding | Exploitable? |
|---|----------|---------|--------------|
| 1 | HIGH | `cleanedUpSessions` unbounded memory growth | Yes — flood with short-lived sessions |
| 2 | HIGH | `listSessionIds()` never shrinks — O(N) scan | Yes — flood to degrade enforcer |
| 3 | MEDIUM | TOCTOU outer read vs. inner lock (correctly defended) | No — defense in depth works |
| 4 | MEDIUM | Clock skew can delay/advance timeouts | Situational — requires NTP manipulation |
| 5 | MEDIUM | Single poisoned session aborts entire scan tick | Yes — one bad session blocks all subsequent |
| 6 | MEDIUM | Orphaned locks after `removeLock` + late handler | Mild — requires specific timing |
| 7 | LOW | Seller can waste buyer time by ignoring cosign | Yes — bounded by accept limits |
| 8 | LOW | `seenEventIds` unbounded growth | Same class as #1 |
| 9 | LOW | Cosign pre-lock read stale error message | No — UX only |

---

## Recommended Priority

1. **Finding 5** — Fix first. A single corrupt session silently killing enforcement for all subsequent sessions is the most dangerous operational failure mode.
2. **Findings 1+2+8** — Address together. Implement session pruning from the event store when terminal + old, and derive `cleanedUpSessions` / `seenEventIds` cleanup from that.
3. **Finding 4** — Add monotonic timing for elapsed-time calculations.
4. **Findings 6, 7** — Low urgency, address in hardening pass.
