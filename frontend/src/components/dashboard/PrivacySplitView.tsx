import { useState } from "react"
import type { CSSProperties } from "react"
import type { DemoMetrics } from "../../demo/scenario"

interface Props {
  readonly metrics: DemoMetrics
  readonly mobile?: boolean
}

const sectionTitle = (mobile?: boolean): CSSProperties => ({
  fontSize: mobile ? "0.65rem" : "0.75rem",
  textTransform: "uppercase",
  letterSpacing: "0.15em",
  color: "var(--text-color)",
  textAlign: "center",
  paddingBottom: 10,
  marginBottom: 14,
  borderBottom: "1px solid var(--hairline)",
  fontWeight: 500,
})

interface SellerView {
  readonly name: string
  readonly label: string
  readonly offer: string
  readonly isWinner: boolean
  readonly sawCounter: boolean
  readonly counterPrice?: string
  readonly sawQuote: boolean
}

const SELLERS: readonly SellerView[] = [
  {
    name: "FlexibleSeller",
    label: "FlexibleSeller (winner)",
    offer: "38.00",
    isWinner: true,
    sawCounter: true,
    counterPrice: "34.00",
    sawQuote: true,
  },
  {
    name: "FirmSeller",
    label: "FirmSeller",
    offer: "50.00",
    isWinner: false,
    sawCounter: false,
    sawQuote: false,
  },
  {
    name: "CompetitiveSeller",
    label: "CompetitiveSeller",
    offer: "42.00",
    isWinner: false,
    sawCounter: true,
    counterPrice: "35.00",
    sawQuote: false,
  },
]

/**
 * Screen 3 — Privacy split-view with seller tab switcher.
 * Shows what each seller could see vs buyer's truth.
 */
export function PrivacySplitView({ metrics, mobile }: Props) {
  const [sellerIdx, setSellerIdx] = useState(0)
  const seller = SELLERS[sellerIdx]
  const mono = { fontFamily: "var(--font-mono)", fontSize: mobile ? "0.6rem" : "0.7rem" }

  return (
    <div
      style={{
        border: "1px solid var(--hairline)",
        borderRadius: 4,
        overflow: "hidden",
        ...mono,
      }}
    >
      {/* Two columns */}
      <div style={{ display: "grid", gridTemplateColumns: mobile ? "1fr" : "1fr 1fr" }}>
        {/* Left: Seller's View */}
        <div style={{ borderRight: mobile ? "none" : "1px solid var(--hairline)", borderBottom: mobile ? "1px solid var(--hairline)" : "none" }}>
          {/* Seller tabs — inside seller column */}
          <div style={{ display: "flex", borderBottom: "1px solid var(--hairline)" }}>
            {SELLERS.map((s, i) => (
              <button
                key={s.name}
                onClick={() => setSellerIdx(i)}
                style={{
                  flex: 1,
                  padding: mobile ? "8px 4px" : "10px 12px",
                  border: "none",
                  borderBottom: i === sellerIdx ? "2px solid var(--text-color)" : "2px solid transparent",
                  background: "transparent",
                  fontFamily: "var(--font-mono)",
                  fontSize: mobile ? "0.5rem" : "0.6rem",
                  color: i === sellerIdx ? "var(--text-color)" : "var(--secondary-color)",
                  cursor: "pointer",
                  textTransform: "uppercase",
                  letterSpacing: "0.03em",
                  transition: "color 0.2s, border-color 0.2s",
                }}
              >
                {s.name}
                {s.isWinner && " ✓"}
              </button>
            ))}
          </div>
          <div style={{ padding: mobile ? 12 : 20 }}>
          <Line label="RFQ received" value="smart-contract-audit" />
          <Line label="anchor_price" value={`${metrics.anchor_price} USDC`} />
          <Line label="budget_commitment" value="poseidon:a3f1..." dim />
          <Line label="" value="(opaque hash — can't reverse)" dim />
          <div style={{ height: 12 }} />
          <Line label="My offer" value={`${seller.offer} USDC`} />
          <Line label="" value="(can't see other sellers' offers)" dim />

          {seller.sawCounter && (
            <>
              <div style={{ height: 12 }} />
              <Line label="Counter received" value={`${seller.counterPrice} USDC`} />
              <Line label="ZK proof" value="✓ valid" color="#22c55e" />
              <Line label="" value={`(proves ${seller.counterPrice} is within budget`} dim />
              <Line label="" value=" but budget could be anything higher)" dim />
            </>
          )}

          {seller.sawQuote ? (
            <>
              <div style={{ height: 12 }} />
              <Line label="Selected as winner" value="✓" color="#22c55e" />
              <Line label="Final price" value={`${metrics.final_price} USDC`} />
              <Line label="Signed quote" value="✓ dual-signed" color="#22c55e" />
            </>
          ) : (
            <>
              <div style={{ height: 12 }} />
              <Line label="Selected as winner" value="✗ not selected" color="#ef4444" />
              <Line label="" value="(no further visibility into session)" dim />
            </>
          )}
          </div>
        </div>

        {/* Right: Buyer's Truth */}
        <div style={{ padding: mobile ? 12 : 20 }}>
          <div style={sectionTitle(mobile)}>
            BUYER'S TRUTH (private)
          </div>
          <Line label="budget_soft" value={`${metrics.budget_soft} USDC`} color="#22c55e" />
          <Line label="budget_hard" value={`${metrics.budget_hard} USDC`} color="#22c55e" />
          <Line label="anchor_price" value={`${metrics.anchor_price} USDC`} />
          <div style={{ height: 12 }} />
          <Line label="Sees all 3 offers:" value="" />
          <Line label="  FirmSeller" value="50.00" />
          <Line label="  FlexibleSeller" value="38.00  ← winner" color="#22c55e" />
          <Line label="  CompetitiveSeller" value="42.00" />
          <div style={{ height: 12 }} />
          <Line label="Counter sent" value="34.00 USDC (to FlexibleSeller)" />
          <Line label="Counter sent" value="35.00 USDC (to CompetitiveSeller)" />
          <Line label="ZK proof" value="counter ≤ budget_hard" color="#22c55e" />
          <Line label="" value="(sellers verified without learning" dim />
          <Line label="" value={` that budget_hard = ${metrics.budget_hard})`} dim />
          <div style={{ height: 12 }} />
          <Line label="Final price" value={`${metrics.final_price} USDC`} />
          <Line label="Saved" value={`${metrics.savings_vs_budget} vs budget (${metrics.savings_percent}%)`} color="#22c55e" />
        </div>
      </div>

      {/* Bottom: On-chain vs Never on-chain */}
      <div style={{ display: "grid", gridTemplateColumns: mobile ? "1fr" : "1fr 1fr", borderTop: "1px solid var(--hairline)" }}>
        <div style={{ padding: mobile ? 12 : 16, borderRight: mobile ? "none" : "1px solid var(--hairline)", borderBottom: mobile ? "1px solid var(--hairline)" : "none" }}>
          <div style={sectionTitle(mobile)}>
            ON-CHAIN (visible)
          </div>
          <Line label="MoonPay transfer" value={`${metrics.final_price} USDC`} color="#ef4444" />
          <Line label="Agent NFT" value="registered ✓" />
          <Line label="settlement" value="via MoonPay ✓" color="#7c3aed" />
        </div>
        <div style={{ padding: mobile ? 12 : 16 }}>
          <div style={sectionTitle(mobile)}>
            NEVER ON-CHAIN
          </div>
          <Line label="budget_hard" value={metrics.budget_hard} color="#22c55e" />
          <Line label="budget_soft" value={metrics.budget_soft} color="#22c55e" />
          <Line label="floor_price" value={`${metrics.seller_floor} (seller)`} color="#22c55e" />
        </div>
      </div>

      {/* Privacy score bar */}
      <div
        style={{
          padding: "12px 20px",
          borderTop: "1px solid var(--hairline)",
          textAlign: "center",
          color: "var(--secondary-color)",
          fontSize: mobile ? "0.65rem" : "0.75rem",
        }}
      >
        privacy score: {metrics.privacy_score}/{metrics.privacy_max}{"  "}
        <span style={{ color: "#22c55e" }}>{"██████████".slice(0, metrics.privacy_score * 2)}</span>
        <span style={{ opacity: 0.2 }}>{"░░".repeat(metrics.privacy_max - metrics.privacy_score)}</span>
        {"  "}{Math.round((metrics.privacy_score / metrics.privacy_max) * 100)}%
      </div>
    </div>
  )
}

function Line({ label, value, color, dim }: {
  readonly label: string
  readonly value: string
  readonly color?: string
  readonly dim?: boolean
}) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", opacity: dim ? 0.4 : 1, lineHeight: 1.7 }}>
      <span style={{ color: "var(--secondary-color)" }}>{label}</span>
      <span style={{ color: color ?? "var(--text-color)" }}>{value}</span>
    </div>
  )
}
