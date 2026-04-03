import { useEffect, useRef, useSyncExternalStore } from "react"
import { apiUrl } from "../api"

export interface FeedEvent {
  readonly type: string
  readonly actor_role: "buyer" | "seller" | "system"
  readonly state_after: string
  readonly timestamp: number
}

export type FeedStatus = "connecting" | "open" | "disconnected" | "at-capacity"

const MAX_EVENTS = 50

/**
 * Live feed hook — SSE subscription to /dashboard/feed.
 *
 * Uses useSyncExternalStore to bridge the external circular buffer
 * into React without per-event setState. Events drive stats/activity refresh.
 */
export function useLiveFeed(onEvent?: () => void) {
  const storeRef = useRef(createFeedStore())

  useEffect(() => {
    const store = storeRef.current
    const url = apiUrl("/dashboard/feed")
    let cancelled = false

    let es: EventSource | null = null
    let retryMs = 1000
    let retryTimer: ReturnType<typeof setTimeout> | null = null

    const connect = () => {
      if (cancelled) return
      // Only show "connecting" if we don't already have data from fetch recent
      if (store.getSnapshot().length === 0) store.setStatus("connecting")
      es = new EventSource(url)

      es.onopen = () => {
        store.setStatus("open")
        retryMs = 1000
      }

      es.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data)
          if (data.type === "heartbeat") return

          const event: FeedEvent = {
            type: data.type ?? "unknown",
            actor_role: data.actor_role ?? "system",
            state_after: data.state_after ?? "",
            timestamp: Date.now(),
          }
          store.push(event)
          onEvent?.()
        } catch {
          // Ignore unparseable SSE frames
        }
      }

      es.onerror = () => {
        es?.close()
        es = null
        store.setStatus("disconnected")

        // Exponential backoff: 1s → 2s → 4s → ... → 30s max
        retryTimer = setTimeout(() => {
          connect()
        }, retryMs)
        retryMs = Math.min(retryMs * 2, 30_000)
      }
    }

    // Prefill with recent historical events (parallel with SSE connect)
    fetch(apiUrl("/dashboard/feed/recent"))
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (cancelled || !data?.events) return
        // events come newest-first from the API, push oldest first so
        // the buffer ends up in newest-first order
        const historical = (data.events as Array<{
          type: string; actor_role: string; state_after: string; timestamp: string
        }>).reverse()
        for (const e of historical) {
          store.push({
            type: e.type ?? "unknown",
            actor_role: (e.actor_role ?? "system") as FeedEvent["actor_role"],
            state_after: e.state_after ?? "",
            timestamp: new Date(e.timestamp).getTime(),
          })
        }
        onEvent?.()
      })
      .catch(() => { /* best-effort — SSE is the primary channel */ })

    // SSE connects immediately — no waiting for fetch
    connect()

    return () => {
      cancelled = true
      es?.close()
      if (retryTimer) clearTimeout(retryTimer)
    }
  }, [onEvent])

  const events = useSyncExternalStore(
    storeRef.current.subscribe,
    storeRef.current.getSnapshot,
  )
  const status = useSyncExternalStore(
    storeRef.current.subscribeStatus,
    storeRef.current.getStatusSnapshot,
  )

  return { events, status }
}

// ---------------------------------------------------------------------------
// External store — circular buffer + subscriber management
// ---------------------------------------------------------------------------

function createFeedStore() {
  let events: readonly FeedEvent[] = []
  let status: FeedStatus = "connecting"
  const listeners = new Set<() => void>()
  const statusListeners = new Set<() => void>()

  return {
    push(event: FeedEvent) {
      // Immutable: create new array (newest first, cap at MAX_EVENTS)
      events = [event, ...events].slice(0, MAX_EVENTS)
      listeners.forEach((l) => l())
    },

    setStatus(s: FeedStatus) {
      status = s
      statusListeners.forEach((l) => l())
    },

    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    getSnapshot(): readonly FeedEvent[] {
      return events
    },

    subscribeStatus(listener: () => void) {
      statusListeners.add(listener)
      return () => statusListeners.delete(listener)
    },

    getStatusSnapshot(): FeedStatus {
      return status
    },
  }
}
