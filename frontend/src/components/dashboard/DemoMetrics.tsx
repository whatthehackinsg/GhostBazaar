import type { DemoMetrics } from "../../demo/scenario"
import { PRIVACY_BREAKDOWN } from "../../demo/scenario"

interface Props {
  readonly metrics: DemoMetrics
  readonly mobile?: boolean
}

/**
 * Screen 2 — Metrics summary after demo negotiation.
 * Shows negotiation stats, price comparison, ZK proof count, privacy score.
 */
export function DemoMetricsPanel({ metrics, mobile }: Props) {
  const privacyPercent = Math.round((metrics.privacy_score / metrics.privacy_max) * 100)
  const barFilled = Math.round((metrics.privacy_score / metrics.privacy_max) * 10)
  const barEmpty = 10 - barFilled

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
      <div style={{ fontSize: "0.75rem", textTransform: "uppercase", letterSpacing: "0.15em", color: "var(--text-color)", marginBottom: 16, textAlign: "center", paddingBottom: 12, borderBottom: "1px solid var(--hairline)" }}>
        NEGOTIATION METRICS
      </div>

      <div style={{ display: "grid", gridTemplateColumns: mobile ? "1fr" : "1fr 1fr", gap: 8, lineHeight: 2 }}>
        <MetricRow label="negotiation rounds" value={String(metrics.negotiation_rounds)} />
        <MetricRow label="ZK proofs verified" value={`${metrics.zk_proofs_verified}  ✓`} highlight />
        <MetricRow label="negotiation time" value={`${(metrics.negotiation_time_ms / 1000).toFixed(1)}s`} />
        <MetricRow label="final price" value={`${metrics.final_price} USDC`} />
        <MetricRow label="settled via" value="MoonPay ✓" highlight />
        <MetricRow label="anchor price" value={`${metrics.anchor_price} USDC`} />
        <MetricRow label="savings vs budget" value={`${metrics.savings_vs_budget} USDC (${metrics.savings_percent}%)`} highlight />
      </div>

      {/* Privacy Score */}
      <div style={{ marginTop: 20, paddingTop: 16, borderTop: "1px solid var(--hairline)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
          <span style={{ color: "var(--secondary-color)" }}>privacy score</span>
          <span style={{ color: "var(--text-color)" }}>
            {metrics.privacy_score}/{metrics.privacy_max}{"  "}
            <span style={{ color: "#22c55e" }}>{"█".repeat(barFilled)}</span>
            <span style={{ opacity: 0.2 }}>{"░".repeat(barEmpty)}</span>
            {"  "}{privacyPercent}%
          </span>
        </div>

        {/* Breakdown */}
        <div style={{ fontSize: mobile ? "0.6rem" : "0.65rem", lineHeight: 1.8, color: "var(--secondary-color)" }}>
          {PRIVACY_BREAKDOWN.map((item) => (
            <div key={item.label} style={{ display: "flex", gap: 8 }}>
              <span style={{ color: item.private ? "#22c55e" : "#ef4444", minWidth: 16 }}>
                {item.private ? "✓" : "✗"}
              </span>
              <span>{item.label}</span>
              <span style={{ opacity: 0.5, marginLeft: "auto" }}>{item.mechanism}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function MetricRow({ label, value, highlight }: { readonly label: string; readonly value: string; readonly highlight?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between" }}>
      <span style={{ color: "var(--secondary-color)" }}>{label}</span>
      <span style={{ color: highlight ? "#22c55e" : "var(--text-color)" }}>{value}</span>
    </div>
  )
}
