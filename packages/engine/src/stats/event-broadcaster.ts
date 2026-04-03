/**
 * EventBroadcaster — decouples SSE fan-out from the append hot path.
 *
 * Problem: Each SSE connection registering directly on SessionManager.onAppend()
 * makes append latency O(N × JSON.stringify). With 100 public + 5 admin SSE
 * connections, that's 105 serializations inside the session lock per event.
 *
 * Solution: ONE onAppend observer → serialize ONCE per feed type → fan out
 * the pre-serialized string to N connections (string copy, microseconds).
 *
 * Public feed: all connections get identical anonymized data (1 stringify).
 * Admin feed: per-rfqId, all watchers of that rfqId get identical full data (1 stringify).
 */

import type { NegotiationEvent } from "../types.js"
import type { DerivedSession } from "../state/session.js"

type StringSubscriber = (serialized: string) => void

export class EventBroadcaster {
  /** Public feed subscribers — all receive the same anonymized string */
  private readonly publicSubs = new Set<StringSubscriber>()
  /** Admin subscribers — per rfqId, receive full event + state_after */
  private readonly adminSubs = new Map<string, Set<StringSubscriber>>()

  /**
   * Called by SessionManager.onAppend() — exactly 1 registration.
   * Serializes once per feed type, fans out pre-serialized strings.
   */
  onEvent(event: NegotiationEvent, session: DerivedSession): void {
    // --- Public feed: 1x serialize, Nx fan-out ---
    if (this.publicSubs.size > 0) {
      const role = event.actor === session.rfq.buyer
        ? "buyer"
        : event.actor.startsWith("engine/")
          ? "system"
          : "seller"
      const data = JSON.stringify({
        type: event.type,
        actor_role: role,
        state_after: session.state,
      })
      for (const sub of this.publicSubs) {
        try { sub(data) } catch { /* subscriber failure must not affect other subscribers */ }
      }
    }

    // --- Admin feed: 1x serialize per watched rfqId, Mx fan-out ---
    const subs = this.adminSubs.get(event.rfq_id)
    if (subs && subs.size > 0) {
      const data = JSON.stringify({ ...event, state_after: session.state })
      for (const sub of subs) {
        try { sub(data) } catch { /* subscriber failure isolated */ }
      }
    }
  }

  /** Subscribe to anonymized public feed. Returns unsubscribe function. */
  subscribePublic(fn: StringSubscriber): () => void {
    this.publicSubs.add(fn)
    return () => { this.publicSubs.delete(fn) }
  }

  /** Subscribe to full events for a specific session. Returns unsubscribe function. */
  subscribeAdmin(rfqId: string, fn: StringSubscriber): () => void {
    let subs = this.adminSubs.get(rfqId)
    if (!subs) {
      subs = new Set()
      this.adminSubs.set(rfqId, subs)
    }
    subs.add(fn)
    return () => {
      subs!.delete(fn)
      if (subs!.size === 0) this.adminSubs.delete(rfqId)
    }
  }
}
