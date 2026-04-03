import type { DashboardStats, StatsStatus } from "../../hooks/useDashboardStats"

interface Props {
  readonly stats: DashboardStats | null
  readonly status: StatsStatus
  readonly mobile?: boolean
}

const CARDS = [
  { key: "active_sessions", label: "ACTIVE" },
  { key: "completed_deals", label: "DEALS" },
  { key: "unique_buyers", label: "BUYERS" },
  { key: "unique_sellers", label: "SELLERS" },
  { key: "listings", label: "LISTINGS" },
] as const

export function StatsCards({ stats, status, mobile }: Props) {
  const getValue = (key: typeof CARDS[number]["key"]): string => {
    if (!stats) return "—"
    return String(stats[key])
  }

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
      {CARDS.map(({ key, label }, index) => (
        <div
          key={key}
          style={{
            border: `1px solid var(--hairline)`,
            borderRadius: 4,
            padding: mobile ? 10 : 16,
            textAlign: "center",
            opacity: status === "loading" ? 0.4 : 1,
            transition: "opacity 0.3s",
            gridColumn: index === CARDS.length - 1 ? "1 / -1" : undefined,
          }}
        >
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: mobile ? "1.4rem" : "1.8rem",
              fontWeight: 300,
              color: "var(--text-color)",
            }}
          >
            {getValue(key)}
          </div>
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "0.6rem",
              textTransform: "uppercase",
              letterSpacing: "0.1em",
              color: "var(--secondary-color)",
              marginTop: 4,
            }}
          >
            {label}
          </div>
        </div>
      ))}
      {status === "stale" && (
        <div
          style={{
            gridColumn: "1 / -1",
            fontFamily: "var(--font-mono)",
            fontSize: "0.6rem",
            color: "#b45309",
            textAlign: "center",
          }}
        >
          ● data may be stale
        </div>
      )}
    </div>
  )
}
