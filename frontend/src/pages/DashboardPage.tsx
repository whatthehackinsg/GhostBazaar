import { useCallback, useRef, useState } from "react"
import { NavOverlay } from "../components/NavOverlay"
import { useIsMobile } from "../hooks/useIsMobile"
import { useDashboardStats } from "../hooks/useDashboardStats"
import type { DashboardActivity } from "../hooks/useDashboardActivity"
import { useDashboardActivity } from "../hooks/useDashboardActivity"
import { useLiveFeed } from "../hooks/useLiveFeed"
import type { FeedEvent } from "../hooks/useLiveFeed"
import { StatsCards } from "../components/dashboard/StatsCards"
import { ActivityChart } from "../components/dashboard/ActivityChart"
import { LiveFeed } from "../components/dashboard/LiveFeed"
import { EngineStatus } from "../components/dashboard/EngineStatus"
import { DemoMetricsPanel } from "../components/dashboard/DemoMetrics"
import { PrivacySplitView } from "../components/dashboard/PrivacySplitView"
import { DEMO_EVENTS, DEMO_METRICS } from "../demo/scenario"

interface Props {
  readonly onBack: () => void
}

const MINUTE_MS = 60_000
const ACTIVITY_BUCKETS = 5

function buildActivityFromFeedEvents(events: readonly FeedEvent[], now: number): DashboardActivity {
  const bucketAnchorMs = now - (now % MINUTE_MS)
  const buckets = new Array<number>(ACTIVITY_BUCKETS).fill(0)

  for (const event of events) {
    const ageMs = now - event.timestamp
    if (ageMs < 0) continue
    const bucketIdx = Math.floor(ageMs / MINUTE_MS)
    if (bucketIdx >= 0 && bucketIdx < ACTIVITY_BUCKETS) {
      buckets[bucketIdx]++
    }
  }

  return {
    events_per_minute: buckets,
    new_sessions_last_hour: 0,
    deals_last_hour: 0,
    bucket_anchor_ms: bucketAnchorMs,
  }
}

/**
 * Public live dashboard — real-time engine activity.
 *
 * Data strategy (event-driven, not fixed polling):
 * - SSE /dashboard/feed drives the UI — each event triggers stats/activity refresh
 * - Stats fallback poll: 30s (if SSE is down)
 * - Activity fallback poll: 60s
 * - Health poll: 30s (independent)
 *
 * Demo mode: "Run Demo" button simulates a full negotiation with real protocol events.
 */
export function DashboardPage({ onBack }: Props) {
  const mobile = useIsMobile()
  const [navOpen, setNavOpen] = useState(false)
  const [demoRunning, setDemoRunning] = useState(false)
  const [demoComplete, setDemoComplete] = useState(false)
  const [demoEvents, setDemoEvents] = useState<readonly FeedEvent[]>([])
  const demoTimersRef = useRef<ReturnType<typeof setTimeout>[]>([])

  const { stats, status: statsStatus, refresh: refreshStats } = useDashboardStats()
  const {
    activity,
    status: activityStatus,
    bucketAnchorMs,
    refresh: refreshActivity,
  } = useDashboardActivity()

  const onFeedEvent = useCallback(() => {
    refreshStats()
    refreshActivity()
  }, [refreshStats, refreshActivity])

  const { events: liveEvents, status: feedStatus } = useLiveFeed(onFeedEvent)

  const handleNavItem = (item: string) => {
    setNavOpen(false)
    if (item === "Live Feed" || item === "Metrics") return
    onBack()
  }

  const runDemo = () => {
    if (demoRunning) return
    setDemoRunning(true)
    setDemoComplete(false)
    setDemoEvents([])

    // Clear any previous timers
    demoTimersRef.current.forEach(clearTimeout)
    demoTimersRef.current = []

    let elapsed = 0
    DEMO_EVENTS.forEach((evt, i) => {
      elapsed += evt.delay
      const timer = setTimeout(() => {
        const feedEvent: FeedEvent = {
          type: evt.type,
          actor_role: evt.actor_role,
          state_after: evt.state_after,
          timestamp: Date.now(),
        }
        setDemoEvents((prev) => [feedEvent, ...prev])

        // Last event → demo complete
        if (i === DEMO_EVENTS.length - 1) {
          setDemoRunning(false)
          setDemoComplete(true)
        }
      }, elapsed)
      demoTimersRef.current.push(timer)
    })
  }

  const resetDemo = () => {
    demoTimersRef.current.forEach(clearTimeout)
    demoTimersRef.current = []
    setDemoRunning(false)
    setDemoComplete(false)
    setDemoEvents([])
  }

  // Show demo events when demo is active, otherwise show live events
  const displayEvents = demoEvents.length > 0 ? demoEvents : liveEvents
  const demoActivity = demoEvents.length > 0
    ? buildActivityFromFeedEvents(demoEvents, Date.now())
    : null
  const displayActivity = demoActivity ?? activity
  const displayActivityStatus = demoActivity ? "ok" : activityStatus
  const displayBucketAnchorMs = demoActivity
    ? demoActivity.bucket_anchor_ms
    : bucketAnchorMs

  return (
    <div
      style={{
        minHeight: "auto",
        fontFamily: "var(--font-main)",
        padding: mobile ? "16px" : "24px",
        paddingTop: mobile ? "78px" : "88px",
        paddingBottom: mobile ? "80px" : "120px",
        maxWidth: 1200,
        margin: "0 auto",
      }}
    >
      <NavOverlay
        active={navOpen}
        onClose={() => setNavOpen(false)}
        onNavigate={handleNavItem}
      />

      {/* Header */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 32,
          fontFamily: "var(--font-mono)",
          fontSize: "0.7rem",
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          color: "var(--secondary-color)",
        }}
      >
        <span onClick={() => setNavOpen(true)} style={{ cursor: "pointer", color: "var(--text-color)" }}>
          ☰ MENU
        </span>
        <span>GHOST BAZAAR DASHBOARD</span>
        <span onClick={onBack} style={{ cursor: "pointer", color: "var(--text-color)" }}>
          ← BACK
        </span>
      </div>

      {/* Demo button */}
      <div style={{ display: "flex", gap: 12, marginBottom: 20, justifyContent: "center" }}>
        <button
          onClick={demoRunning ? undefined : demoComplete ? resetDemo : runDemo}
          style={{
            padding: "8px 24px",
            border: "1px solid var(--text-color)",
            borderRadius: 4,
            background: demoRunning ? "transparent" : "var(--text-color)",
            color: demoRunning ? "var(--text-color)" : "var(--bg-color)",
            fontFamily: "var(--font-mono)",
            fontSize: "0.7rem",
            letterSpacing: "0.05em",
            textTransform: "uppercase",
            cursor: demoRunning ? "wait" : "pointer",
            opacity: demoRunning ? 0.5 : 1,
            transition: "all 0.2s",
          }}
        >
          {demoRunning ? "▶ Running..." : demoComplete ? "↻ Reset Demo" : "▶ Run Demo Scenario"}
        </button>
      </div>

      {/* Main grid */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: mobile ? "1fr" : "3fr 2fr",
          gap: mobile ? 16 : 24,
        }}
      >
        {mobile ? (
          <>
            <StatsCards stats={stats} status={statsStatus} mobile />
            <ActivityChart
              activity={displayActivity}
              stats={stats}
              status={displayActivityStatus}
              bucketAnchorMs={displayBucketAnchorMs}
            />
            <LiveFeed events={displayEvents} status={demoRunning ? "open" : feedStatus} mobile />
          </>
        ) : (
          <>
            <LiveFeed events={displayEvents} status={demoRunning ? "open" : feedStatus} />
            <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
              <StatsCards stats={stats} status={statsStatus} />
              <ActivityChart
                activity={displayActivity}
                stats={stats}
                status={displayActivityStatus}
                bucketAnchorMs={displayBucketAnchorMs}
              />
            </div>
          </>
        )}
      </div>

      {/* Demo results — show after demo completes */}
      {demoComplete && (
        <div style={{ display: "flex", flexDirection: "column", gap: 20, marginTop: 24 }}>
          <DemoMetricsPanel metrics={DEMO_METRICS} mobile={mobile} />
          <PrivacySplitView metrics={DEMO_METRICS} mobile={mobile} />
        </div>
      )}

      {/* Status bar */}
      <EngineStatus feedStatus={feedStatus} eventCount={liveEvents.length} />

      {/* CTA links */}
      <div
        style={{
          marginTop: 16,
          paddingBottom: mobile ? 16 : 0,
          display: "flex",
          gap: mobile ? 12 : 16,
          justifyContent: "center",
          flexWrap: "wrap",
          fontFamily: "var(--font-mono)",
          fontSize: mobile ? "0.6rem" : "0.7rem",
        }}
      >
        {DASHBOARD_LINKS.map(({ label, href }) => (
          <a
            key={label}
            href={href}
            target={href.startsWith("http") ? "_blank" : undefined}
            rel={href.startsWith("http") ? "noopener noreferrer" : undefined}
            style={{
              color: "var(--secondary-color)",
              textDecoration: "none",
              borderBottom: "1px solid var(--hairline)",
              paddingBottom: 2,
              transition: "color 0.2s",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text-color)" }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "var(--secondary-color)" }}
          >
            {label}
          </a>
        ))}
      </div>
    </div>
  )
}

const DASHBOARD_LINKS = [
  { label: "Protocol Spec", href: "https://github.com/whatthehackinsg/GhostBazaar/blob/main/GHOST-BAZAAR-SPEC-v4.md" },
  { label: "GitHub", href: "https://github.com/whatthehackinsg/GhostBazaar" },
  { label: "Documentation", href: "https://github.com/whatthehackinsg/GhostBazaar/blob/main/ENGINEERING.md" },
] as const
