import { useCallback, useEffect, useRef, useState } from "react"
import { apiUrl } from "../api"

export interface DashboardStats {
  readonly active_sessions: number
  readonly completed_deals: number
  readonly total_sessions: number
  readonly unique_buyers: number
  readonly unique_sellers: number
  readonly by_state: Readonly<Record<string, number>>
  readonly total_offers: number
  readonly total_counters: number
  readonly avg_offers_per_session: number
  readonly avg_rounds_per_session: number
  readonly avg_negotiation_duration_ms: number
  readonly success_rate: number
  readonly uptime: number
  readonly listings: number
}

export type StatsStatus = "loading" | "ok" | "stale" | "error"

interface StatsState {
  readonly stats: DashboardStats | null
  readonly status: StatsStatus
}

/**
 * Dashboard stats hook — event-driven refresh.
 *
 * Instead of polling on a fixed interval, call `refresh()` whenever
 * a new SSE event arrives. Also does an initial fetch on mount and
 * a fallback poll every 30s in case SSE is down.
 */
export function useDashboardStats() {
  const [state, setState] = useState<StatsState>({ stats: null, status: "loading" })
  const abortRef = useRef<AbortController | null>(null)
  const lastFetchRef = useRef(0)

  const doFetch = useCallback(async () => {
    // Debounce: skip if last fetch was < 2s ago
    if (Date.now() - lastFetchRef.current < 2000) return
    lastFetchRef.current = Date.now()

    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    try {
      const res = await fetch(apiUrl("/dashboard/stats"), { signal: controller.signal })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const stats = await res.json() as DashboardStats
      setState({ stats, status: "ok" })
    } catch (err) {
      if ((err as Error).name === "AbortError") return
      setState((prev) => ({
        stats: prev.stats,
        status: prev.stats ? "stale" : "error",
      }))
    }
  }, [])

  // Initial fetch + fallback poll every 30s
  useEffect(() => {
    // Reset debounce on remount (handles React StrictMode double-mount
    // where abort() cancels first fetch but debounce blocks the retry)
    lastFetchRef.current = 0
    doFetch()
    const id = setInterval(doFetch, 30_000)
    return () => {
      clearInterval(id)
      abortRef.current?.abort()
    }
  }, [doFetch])

  return { ...state, refresh: doFetch }
}
