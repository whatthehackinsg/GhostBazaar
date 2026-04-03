import { useIsMobile } from "../hooks/useIsMobile"

// Desktop: horizontal flow with Buyer/Seller interaction
const DESKTOP_ART = `
  BUYER                                                    SELLER(s)
    │                                                          │
    │  ┌──────────────┐                                        │
    ├──┤  01 DISCOVER  ├──── RFQ + Poseidon commitment ───────▶│
    │  └──────────────┘                                        │
    │                      ┌──────────────┐                    │
    │◀── offer ────────────┤ 02 NEGOTIATE ├──── offer ────────▶│
    │    counter ─────────▶│   (N rounds) │◀── counter ────────┤
    │    ZK proof ────────▶│              │                    │
    │                      └──────────────┘                    │
    │  ┌──────────────┐                                        │
    ├──┤  03 COMMIT   ├──── dual Ed25519 sign ────────────────▶│
    │  │  (Quote)     │◀── seller signature ──────────────────┤
    │  └──────────────┘                                        │
    │  ┌──────────────┐                                        │
    ├──┤  04 SETTLE   ├──── SPL USDC transfer ────────────────▶│
    │  │  (on-chain)  │     17-step verification               │
    │  └──────────────┘                                        │
    ▼                                                          ▼
`

// Mobile: vertical compact flow
const MOBILE_ART = `
    BUYER                 SELLER(s)
      │                       │
      │  ┌──────────────┐     │
      ├──┤ 01 DISCOVER  ├────▶│
      │  │  RFQ + ZK    │     │
      │  └──────────────┘     │
      │                       │
      │  ┌──────────────┐     │
      │◀─┤ 02 NEGOTIATE ├───▶│
      │  │  N rounds    │     │
      │  └──────────────┘     │
      │                       │
      │  ┌──────────────┐     │
      ├──┤ 03 COMMIT    ├────▶│
      │  │  dual-sign   │     │
      │  └──────────────┘     │
      │                       │
      │  ┌──────────────┐     │
      ├──┤ 04 SETTLE    ├────▶│
      │  │  Solana SPL  │     │
      │  └──────────────┘     │
      ▼                       ▼
`

/**
 * ASCII art protocol flow diagram.
 * Renders in a <pre> block with monospace font.
 * Desktop shows full horizontal interaction; mobile shows compact vertical.
 */
export function ProtocolAsciiArt() {
  const mobile = useIsMobile()
  const art = mobile ? MOBILE_ART : DESKTOP_ART

  return (
    <div
      style={{
        display: "flex",
        justifyContent: "center",
        overflowX: "auto",
        WebkitOverflowScrolling: "touch",
      }}
    >
      <pre
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: mobile ? "0.55rem" : "0.7rem",
          lineHeight: 1.5,
          color: "var(--text-color)",
          background: "transparent",
          margin: 0,
          padding: mobile ? "12px 0" : "16px 0",
          whiteSpace: "pre",
          opacity: 0.75,
          letterSpacing: "0.02em",
        }}
      >
        {art.trim()}
      </pre>
    </div>
  )
}
