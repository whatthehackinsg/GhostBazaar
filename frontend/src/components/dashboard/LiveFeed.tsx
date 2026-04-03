import { useState } from "react"
import type { FeedEvent, FeedStatus } from "../../hooks/useLiveFeed"

interface Props {
  readonly events: readonly FeedEvent[]
  readonly status: FeedStatus
  readonly mobile?: boolean
}

const STATUS_DOT: Record<FeedStatus, { color: string; label: string }> = {
  connecting: { color: "var(--status-warning)", label: "connecting" },
  open: { color: "var(--status-open)", label: "open" },
  disconnected: { color: "var(--status-error)", label: "disconnected" },
  "at-capacity": { color: "var(--status-warning)", label: "at capacity" },
}

const ROLE_STYLE: Record<string, { color: string; fontStyle?: string }> = {
  buyer: { color: "var(--role-buyer)" },
  seller: { color: "var(--role-seller)" },
  system: { color: "var(--role-system)", fontStyle: "italic" },
}

const DEAL_EVENTS = new Set(["QUOTE_COMMITTED"])

export function LiveFeed({ events, status, mobile }: Props) {
  const [hoveredIdx, setHoveredIdx] = useState(-1)
  const dot = STATUS_DOT[status]

  return (
    <div
      style={{
        border: "1px solid var(--hairline)",
        borderRadius: 4,
        padding: mobile ? 16 : 24,
        fontFamily: "var(--font-mono)",
        fontSize: mobile ? "0.7rem" : "0.8rem",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 16,
          fontSize: "0.7rem",
          textTransform: "uppercase",
          letterSpacing: "0.1em",
        }}
      >
        <span style={{ color: "var(--text-color)" }}>LIVE FEED</span>
        <span style={{ color: dot.color }}>
          <span style={{
            display: "inline-block",
            width: 6,
            height: 6,
            borderRadius: "50%",
            backgroundColor: dot.color,
            marginRight: 6,
            boxShadow: status === "open" ? `0 0 4px ${dot.color}` : "none",
          }} />
          {dot.label}
        </span>
      </div>

      {/* Event list — fixed height with scroll */}
      <div style={{ overflow: "auto", maxHeight: mobile ? 180 : 360 }}>
        {events.length === 0 ? (
          <EmptyState status={status} />
        ) : (
          events.map((event, i) => {
            const isHovered = hoveredIdx === i
            const isDeal = DEAL_EVENTS.has(event.type)
            const roleStyle = ROLE_STYLE[event.actor_role] ?? ROLE_STYLE.system

            return (
              <div
                key={`${event.timestamp}-${i}`}
                onMouseEnter={() => setHoveredIdx(i)}
                onMouseLeave={() => setHoveredIdx(-1)}
                style={{
                  padding: "4px 8px",
                  borderRadius: 2,
                  fontSize: "0.75rem",
                  lineHeight: 1.8,
                  backgroundColor: isHovered ? "var(--text-color)" : "transparent",
                  color: isHovered ? "var(--bg-color)" : roleStyle.color,
                  fontStyle: roleStyle.fontStyle,
                  transition: "background-color 0.15s, color 0.15s",
                  animation: isDeal ? "deal-flash 0.5s ease-out" : undefined,
                }}
              >
                <span style={{ opacity: isHovered ? 0.7 : 0.5 }}>
                  {formatTime(event.timestamp)}
                </span>
                {"  "}
                <span>{event.actor_role.padEnd(6)}</span>
                {"  "}
                <span>{event.type}</span>
                {"  → "}
                <span>{event.state_after}</span>
              </div>
            )
          })
        )}
      </div>

      {/* Deal flash animation */}
      <style>{`
        @keyframes deal-flash {
          0% { background-color: rgba(var(--status-open-rgb), 0.3); }
          100% { background-color: transparent; }
        }
      `}</style>
    </div>
  )
}

function EmptyState({ status }: { readonly status: FeedStatus }) {
  if (status === "connecting") {
    return (
      <div style={{ textAlign: "center", paddingTop: 120, color: "var(--secondary-color)", opacity: 0.5 }}>
        Connecting to engine...
      </div>
    )
  }

  if (status === "disconnected") {
    return (
      <div style={{ textAlign: "center", paddingTop: 120, color: "var(--status-error)", opacity: 0.7 }}>
        Reconnecting...
      </div>
    )
  }

  // Active but no events — scanning state
  return (
    <div style={{ textAlign: "center", paddingTop: 100, color: "var(--secondary-color)" }}>
      <div style={{ fontSize: "1.2rem", letterSpacing: "0.2em", opacity: 0.3, marginBottom: 16 }}>
        ─ ─ ─ ∿ ─ ─ ─ ─ ─ ∿ ─ ─
      </div>
      <div
        style={{
          fontSize: "0.7rem",
          letterSpacing: "0.15em",
          textTransform: "uppercase",
          animation: "fade-pulse 3s ease-in-out infinite",
        }}
      >
        SCANNING FOR AGENT RFQS...
      </div>
    </div>
  )
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  return d.toLocaleTimeString("en-US", { hour12: false })
}
