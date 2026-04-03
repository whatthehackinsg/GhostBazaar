import { useCallback, useEffect, useRef, useState } from "react"
import { apiUrl } from "../../api"
import type { FeedStatus } from "../../hooks/useLiveFeed"

interface HealthData {
  readonly status: string
  readonly uptime: number
  readonly sessions: number
  readonly listings: number
}

interface Props {
  readonly feedStatus: FeedStatus
  /** Number of SSE events received — drives heartbeat waveform */
  readonly eventCount: number
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return `${h}h ${m}m`
}

const WAVEFORM_LEN = 60

/**
 * Heartbeat waveform — 1px scrolling line at the bottom of the status bar.
 * Each SSE event creates a "spike"; idle time shows flat line.
 * Rendered via direct DOM ref (no React re-render per tick).
 */
function Heartbeat({ eventCount }: { readonly eventCount: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const samplesRef = useRef<number[]>(new Array(WAVEFORM_LEN).fill(0))
  const lastEventCountRef = useRef(0)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return

    const draw = () => {
      const samples = samplesRef.current
      // Shift left, push new sample
      samples.shift()
      const newEvents = eventCount - lastEventCountRef.current
      lastEventCountRef.current = eventCount
      samples.push(newEvents > 0 ? Math.min(newEvents, 5) : 0)

      const w = canvas.width
      const h = canvas.height
      const dpr = window.devicePixelRatio || 1

      canvas.width = canvas.clientWidth * dpr
      canvas.height = canvas.clientHeight * dpr
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

      ctx.clearRect(0, 0, w, h)
      ctx.strokeStyle = "#22c55e"
      ctx.lineWidth = 1
      ctx.globalAlpha = 0.5
      ctx.beginPath()

      const stepX = canvas.clientWidth / (WAVEFORM_LEN - 1)
      const maxH = canvas.clientHeight

      for (let i = 0; i < WAVEFORM_LEN; i++) {
        const x = i * stepX
        const spike = samples[i] / 5
        const y = maxH - spike * maxH
        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }

      ctx.stroke()
    }

    const id = setInterval(draw, 500)
    draw()
    return () => clearInterval(id)
  }, [eventCount])

  return (
    <canvas
      ref={canvasRef}
      style={{
        display: "block",
        width: "100%",
        height: 8,
        marginTop: 8,
      }}
    />
  )
}

export function EngineStatus({ feedStatus, eventCount }: Props) {
  const [health, setHealth] = useState<HealthData | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const fetchHealth = useCallback(async () => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    try {
      const res = await fetch(apiUrl("/health"), { signal: controller.signal })
      if (res.ok) setHealth(await res.json() as HealthData)
    } catch {
      // Keep last known health on error
    }
  }, [])

  useEffect(() => {
    fetchHealth()
    const id = setInterval(fetchHealth, 30_000)
    return () => {
      clearInterval(id)
      abortRef.current?.abort()
    }
  }, [fetchHealth])

  const engineLabel = health ? "online" : "offline"
  const uptimeLabel = health ? formatUptime(health.uptime) : "—"

  const feedDot = feedStatus === "open"
    ? { color: "#22c55e", glow: true }
    : feedStatus === "disconnected"
      ? { color: "#ef4444", glow: false }
      : { color: "#b45309", glow: false }

  return (
    <div
      style={{
        marginTop: 24,
        padding: "12px 16px 4px",
        border: "1px solid var(--hairline)",
        borderRadius: 4,
        fontFamily: "var(--font-mono)",
        fontSize: "0.7rem",
        color: "var(--secondary-color)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span>▸ uptime: {uptimeLabel}</span>
        <span>engine: {engineLabel}</span>
        <span>
          feed:{" "}
          <span
            style={{
              display: "inline-block",
              width: 6,
              height: 6,
              borderRadius: "50%",
              backgroundColor: feedDot.color,
              boxShadow: feedDot.glow ? `0 0 4px ${feedDot.color}` : "none",
              verticalAlign: "middle",
              marginRight: 4,
            }}
          />
          {feedStatus}
        </span>
      </div>
      <Heartbeat eventCount={eventCount} />
    </div>
  )
}
