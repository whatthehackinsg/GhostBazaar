import type { RFQ } from "@ghost-bazaar/core"
import type { NegotiationEvent, InternalEventStore } from "../types.js"
import { deepFreeze, isEventVisibleTo, TERMINAL_EVENT_TYPES } from "./visibility.js"

// ---------------------------------------------------------------------------
// InMemoryEventStore — MVP implementation (dev/test)
//
// NOTE: The internal events array uses mutable push() for performance.
// This is safe because:
//   1. The array is private (never exposed)
//   2. Each event is deep-frozen on append (runtime immutability)
//   3. getEvents() returns a new array of frozen events
//   4. subscribe() delivers frozen event references
// ---------------------------------------------------------------------------

interface Subscriber {
  readonly callerDid: string
  readonly rfq: Pick<RFQ, "buyer">
  readonly listener: (event: NegotiationEvent) => void
}

export class InMemoryEventStore implements InternalEventStore {
  /** rfqId → ordered event array (internal, mutable for push performance) */
  private readonly events = new Map<string, NegotiationEvent[]>()
  /** rfqId → active subscribers */
  private readonly subscribers = new Map<string, Set<Subscriber>>()
  /** Global event_id dedup set — prevents replay/double-append attacks */
  private readonly seenEventIds = new Set<string>()
  /** rfqId → terminal state subscribers (fire-once on COMMITTED/EXPIRED/CANCELLED) */
  private readonly terminalSubscribers = new Map<string, Set<(state: string) => void>>()

  append(rfqId: string, event: NegotiationEvent): void {
    // Guard: rfqId parameter must match event.rfq_id to prevent cross-session contamination
    if (rfqId !== event.rfq_id) {
      throw new Error(
        `EventStore.append: rfqId mismatch — parameter "${rfqId}" !== event.rfq_id "${event.rfq_id}"`,
      )
    }

    // Guard: reject duplicate event_id (prevents replay and double-append)
    if (this.seenEventIds.has(event.event_id)) {
      throw new Error(
        `EventStore.append: duplicate event_id "${event.event_id}"`,
      )
    }

    // structuredClone produces a fully independent deep copy — no shared
    // references with the caller's object at any nesting level. deepFreeze
    // then makes the clone immutable at runtime (mutation throws in strict mode).
    const frozenEvent = deepFreeze(structuredClone(event))

    // Record event_id BEFORE storing — if storage fails, the ID is still marked
    // to prevent partial-append replay. This is the conservative choice.
    this.seenEventIds.add(event.event_id)

    const log = this.events.get(rfqId)
    if (log) {
      log.push(frozenEvent)
    } else {
      this.events.set(rfqId, [frozenEvent])
    }

    // Notify subscribers — each only receives events they're authorized to see.
    // Each listener is wrapped in try/catch to prevent one broken subscriber from
    // affecting append semantics or other subscribers.
    const subs = this.subscribers.get(rfqId)
    if (subs) {
      for (const sub of subs) {
        if (isEventVisibleTo(frozenEvent, sub.callerDid, sub.rfq)) {
          try {
            sub.listener(frozenEvent)
          } catch {
            // Subscriber failure must not affect append or other subscribers.
            // In production, this would be logged. Failing subscribers are
            // kept alive (they may recover) — SSE cleanup handles eviction.
          }
        }
      }
    }

    // Notify terminal subscribers — fires once when session reaches a terminal state.
    // After firing, all terminal subscribers for this session are removed (fire-once semantics).
    if (TERMINAL_EVENT_TYPES.has(frozenEvent.type)) {
      const termSubs = this.terminalSubscribers.get(rfqId)
      if (termSubs) {
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
        this.terminalSubscribers.delete(rfqId)
      }
    }
  }

  getEvents(
    rfqId: string,
    callerDid: string,
    rfq: Pick<RFQ, "buyer">,
    afterId?: string,
  ): readonly NegotiationEvent[] {
    const log = this.events.get(rfqId)
    if (!log) return []

    let startIdx = 0
    if (afterId !== undefined) {
      const cursorIdx = log.findIndex((e) => e.event_id === afterId)
      // If afterId not found, return empty (invalid cursor).
      // This is documented behavior — SSE consumers should treat empty
      // as "reconnect from scratch" if their cursor is stale.
      if (cursorIdx === -1) return []
      startIdx = cursorIdx + 1
    }

    // Filter by role visibility and return a new array.
    // Events are already frozen, so returning references is safe.
    const result: NegotiationEvent[] = []
    for (let i = startIdx; i < log.length; i++) {
      if (isEventVisibleTo(log[i], callerDid, rfq)) {
        result.push(log[i])
      }
    }
    return result
  }

  subscribe(
    rfqId: string,
    callerDid: string,
    rfq: Pick<RFQ, "buyer">,
    listener: (event: NegotiationEvent) => void,
  ): () => void {
    let subs = this.subscribers.get(rfqId)
    if (!subs) {
      subs = new Set()
      this.subscribers.set(rfqId, subs)
    }

    const sub: Subscriber = { callerDid, rfq, listener }
    subs.add(sub)

    // Return unsubscribe function
    return () => {
      subs!.delete(sub)
      if (subs!.size === 0) {
        this.subscribers.delete(rfqId)
      }
    }
  }

  getAllEvents(rfqId: string): readonly NegotiationEvent[] {
    const log = this.events.get(rfqId)
    if (!log) return []
    // Return a copy — events are frozen, so sharing references is safe
    return [...log]
  }

  size(rfqId: string): number {
    return this.events.get(rfqId)?.length ?? 0
  }

  hasCursor(rfqId: string, eventId: string): boolean {
    const log = this.events.get(rfqId)
    if (!log) return false
    return log.some((e) => e.event_id === eventId)
  }

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
    // Phase 1: Subscribe in BUFFERING mode — captures events arriving between
    // the subscribe() call and the activate() call, preventing the classic
    // "gap between getEvents and subscribe" race condition.
    const buffer: NegotiationEvent[] = []
    let mode: "buffering" | "live" | "stopped" = "buffering"

    const unsubscribeRole = this.subscribe(rfqId, callerDid, rfq, (event) => {
      if (mode === "stopped") return
      if (mode === "buffering") {
        buffer.push(event)
        return
      }
      // mode === "live" — deliver directly to the caller's listener
      listener(event)
    })

    // Phase 1 continued: Read historical events. The subscriber is already
    // registered, so any concurrent appends land in the buffer.
    const replay = this.getEvents(rfqId, callerDid, rfq, afterId)

    // Deduplicate: remove any buffered events that overlap with replay.
    // This handles the edge case where an event is appended between subscribe()
    // and getEvents() — it would appear in both replay and buffer.
    const replayIds = new Set(replay.map((e) => e.event_id))
    const dedupedBuffer: NegotiationEvent[] = []
    for (const e of buffer) {
      if (!replayIds.has(e.event_id)) {
        dedupedBuffer.push(e)
      }
    }
    buffer.length = 0
    buffer.push(...dedupedBuffer)

    let activated = false
    let stopped = false

    // Snapshot the deduped buffer, then DRAIN the internal buffer so that
    // activate() only flushes events that arrived AFTER this snapshot.
    // This prevents double-delivery: the caller sends the snapshot, then
    // activate() sends only post-snapshot events. (Codex R3-F2 fix)
    const bufferedSnapshot = [...dedupedBuffer]
    buffer.length = 0

    // Phase 2: activate() flushes any events that arrived between
    // subscribeFrom() return and this call, then switches to live mode.
    // Ordering contract: caller sends replay → buffered snapshot → activate flushes → live.
    const activate = (): void => {
      if (activated || stopped) return
      activated = true

      const toFlush = [...buffer]
      buffer.length = 0
      mode = "live"

      for (const e of toFlush) {
        if (stopped) break
        listener(e)
      }
    }

    const unsubscribe = (): void => {
      stopped = true
      mode = "stopped"
      buffer.length = 0
      unsubscribeRole()
    }

    return {
      replay,
      buffered: bufferedSnapshot,
      activate,
      unsubscribe,
    }
  }

  listSessionIds(): readonly string[] {
    return [...this.events.keys()]
  }

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
}
