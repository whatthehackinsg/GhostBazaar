import { useCallback, useEffect, useRef, useState } from "react"
import { apiUrl } from "../api"

export interface DashboardActivity {
  readonly events_per_minute: readonly number[]
  readonly new_sessions_last_hour: number
  readonly deals_last_hour: number
  readonly bucket_anchor_ms: number
}

export type ActivityStatus = "loading" | "ok" | "stale" | "error"

interface ActivityState {
  readonly activity: DashboardActivity | null
  readonly status: ActivityStatus
  readonly bucketAnchorMs: number | null
}

/**
 * Dashboard activity hook — event-driven refresh.
 *
 * Activity data (per-minute event rates) changes slowly,
 * so refresh is triggered by SSE events with a 5s debounce.
 * Fallback poll every 60s.
 */
export function useDashboardActivity() {
  const [state, setState] = useState<ActivityState>({
    activity: null,
    status: "loading",
    bucketAnchorMs: null,
  })
  const abortRef = useRef<AbortController | null>(null)
  const lastFetchRef = useRef(0)

  const doFetch = useCallback(async () => {
    if (Date.now() - lastFetchRef.current < 5000) return
    lastFetchRef.current = Date.now()

    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller

    try {
      const res = await fetch(apiUrl("/dashboard/activity"), {
        signal: controller.signal,
        cache: "no-store",
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const activity = await res.json() as DashboardActivity
      setState({ activity, status: "ok", bucketAnchorMs: activity.bucket_anchor_ms })
    } catch (err) {
      if ((err as Error).name === "AbortError") return
      setState((prev) => ({
        activity: prev.activity,
        status: prev.activity ? "stale" : "error",
        bucketAnchorMs: prev.bucketAnchorMs,
      }))
    }
  }, [])

  useEffect(() => {
    // Reset debounce on remount (handles React StrictMode double-mount)
    lastFetchRef.current = 0
    doFetch()

    const onVisible = () => {
      if (document.visibilityState === "visible") {
        lastFetchRef.current = 0
        void doFetch()
      }
    }

    const id = setInterval(doFetch, 15_000)
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      clearInterval(id)
      document.removeEventListener("visibilitychange", onVisible)
      abortRef.current?.abort()
    }
  }, [doFetch])

  return { ...state, refresh: doFetch }
}
