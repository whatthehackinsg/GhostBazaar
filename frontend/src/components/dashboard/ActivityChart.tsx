import { useEffect, useMemo, useState } from "react"
import type { ActivityStatus, DashboardActivity } from "../../hooks/useDashboardActivity"
import type { DashboardStats } from "../../hooks/useDashboardStats"

interface Props {
  readonly activity: DashboardActivity | null
  readonly stats: DashboardStats | null
  readonly status: ActivityStatus
  readonly bucketAnchorMs: number | null
}

const BLOCKS = " ▁▂▃▄▅▆▇█"
const LABELS = ["-4m", "-3m", "-2m", "-1m", "now"]

function shiftBucketsNewestFirst(raw: readonly number[], shiftMinutes: number): number[] {
  if (shiftMinutes <= 0) return [...raw]
  if (shiftMinutes >= raw.length) return new Array(raw.length).fill(0)

  const shifted = new Array(raw.length).fill(0)
  for (let i = shiftMinutes; i < raw.length; i++) {
    shifted[i] = raw[i - shiftMinutes]
  }
  return shifted
}

export function ActivityChart({ activity, stats, status, bucketAnchorMs }: Props) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(id)
  }, [])

  // Engine returns newest-first [now, -1m, -2m, -3m, -4m]
  // Labels are oldest-first [-4m, -3m, -2m, -1m, now] — reverse to align
  const raw = activity?.events_per_minute ?? [0, 0, 0, 0, 0]
  const ageShift = bucketAnchorMs === null ? 0 : Math.floor((now - bucketAnchorMs) / 60_000)
  const buckets = useMemo(() => {
    return shiftBucketsNewestFirst(raw, ageShift).reverse()
  }, [raw, ageShift])
  const max = Math.max(1, ...buckets)

  const toBlock = (val: number): string => {
    const idx = Math.round((val / max) * (BLOCKS.length - 1))
    return BLOCKS[idx]
  }

  const successRate = stats ? `${Math.round(stats.success_rate * 100)}%` : "—"
  const avgRounds = stats ? String(stats.avg_rounds_per_session) : "—"

  return (
    <div
      style={{
        border: "1px solid var(--hairline)",
        borderRadius: 4,
        padding: 16,
        fontFamily: "var(--font-mono)",
      }}
      aria-label={`Activity chart: ${buckets.join(", ")} events per minute over last 5 minutes`}
    >
      <div
        style={{
          fontSize: "0.7rem",
          textTransform: "uppercase",
          letterSpacing: "0.1em",
          marginBottom: 12,
          color: "var(--text-color)",
        }}
      >
        ACTIVITY (5 min)
      </div>

      {/* ASCII bar chart */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${LABELS.length}, minmax(0, 1fr))`,
          alignItems: "end",
          justifyItems: "center",
          fontSize: "2rem",
          color: "var(--text-color)",
        }}
      >
        {buckets.map((v, i) => (
          <span
            key={i}
            title={`${v} events/min`}
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: "100%",
            }}
          >
            {toBlock(v)}
          </span>
        ))}
      </div>

      {/* Time labels */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${LABELS.length}, minmax(0, 1fr))`,
          justifyItems: "center",
          fontSize: "0.6rem",
          marginTop: 4,
          color: "var(--secondary-color)",
          opacity: 0.6,
        }}
      >
        {LABELS.map((l) => (
          <span key={l}>{l}</span>
        ))}
      </div>

      {/* Summary stats */}
      <div
        style={{
          marginTop: 12,
          fontSize: "0.7rem",
          color: "var(--secondary-color)",
          display: "flex",
          justifyContent: "space-between",
        }}
      >
        <span>success: {successRate}</span>
        <span>avg rounds: {avgRounds}</span>
      </div>

      {status === "stale" && (
        <div
          style={{
            marginTop: 8,
            fontSize: "0.6rem",
            color: "#b45309",
            textAlign: "center",
          }}
        >
          ● activity data may be stale
        </div>
      )}

      {status === "error" && (
        <div
          style={{
            marginTop: 8,
            fontSize: "0.6rem",
            color: "#b91c1c",
            textAlign: "center",
          }}
        >
          ● activity unavailable
        </div>
      )}
    </div>
  )
}
