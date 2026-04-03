import { useEffect, useRef, useState } from "react"
import type { MousePosition } from "../hooks/useMousePosition"
import { useIsMobile } from "../hooks/useIsMobile"
import { MoonPayMark } from "./MoonPayMark"

interface Props {
  readonly mouse: React.RefObject<MousePosition>
}

const BOTTOM_LINKS = [
  { label: "Live Feed", href: "#/dashboard" },
  { label: "Documentation", href: "https://github.com/whatthehackinsg/ghost-bazaar/blob/main/ENGINEERING.md" },
  { label: "GitHub", href: "https://github.com/whatthehackinsg/ghost-bazaar" },
  { label: "Protocol Spec", href: "https://github.com/whatthehackinsg/ghost-bazaar/blob/main/GHOST-BAZAAR-SPEC-v4.md" },
  { label: "@whatthehackinsg", href: "https://x.com/whatthehackinsg" },
] as const

/**
 * Bottom panel — responsive:
 * Desktop: 30vh, 3-column grid (identity / links / telemetry)
 * Mobile: auto height, single column, compact spacing
 *
 * Mouse telemetry updates via direct DOM writes (ref), NOT setState,
 * to avoid re-rendering the entire panel tree at 60fps.
 */
export function BottomPanel({ mouse }: Props) {
  const [clocks, setClocks] = useState({ local: "", utc: "", et: "" })
  const mouseXRef = useRef<HTMLSpanElement>(null)
  const mouseYRef = useRef<HTMLSpanElement>(null)
  const mobile = useIsMobile()

  // Triple clock: Local + UTC (on-chain) + ET (US markets)
  useEffect(() => {
    const fmt = (tz: string) =>
      new Date().toLocaleTimeString("en-US", { hour12: false, timeZone: tz })

    const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone
    const tick = () => {
      setClocks({
        local: fmt(localTz) + " " + localTz,
        utc: fmt("UTC") + " UTC",
        et: fmt("America/New_York") + " ET",
      })
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [])

  // Mouse coord display — direct DOM write via refs (no re-render)
  useEffect(() => {
    if (mobile) return
    let raf: number
    const update = () => {
      if (mouseXRef.current) mouseXRef.current.textContent = String(mouse.current.x)
      if (mouseYRef.current) mouseYRef.current.textContent = String(mouse.current.y)
      raf = requestAnimationFrame(update)
    }
    raf = requestAnimationFrame(update)
    return () => cancelAnimationFrame(raf)
  }, [mouse, mobile])

  return (
    <div
      style={{
        height: mobile ? "auto" : "30vh",
        minHeight: mobile ? "30vh" : undefined,
        width: "100%",
        padding: mobile ? "32px 16px 16px" : "48px 24px 24px",
        display: "grid",
        gridTemplateColumns: mobile ? "1fr" : "2fr 1.5fr 1fr",
        gap: mobile ? 16 : 40,
        alignContent: "space-between",
        fontSize: "0.85rem",
        lineHeight: 1.5,
      }}
    >
      {/* Col 1: Identity */}
      <div style={{ display: "flex", flexDirection: "column", gap: mobile ? 12 : 24 }}>
        <div>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: mobile ? 8 : 12,
              color: "var(--secondary-color)",
              fontSize: mobile ? "0.65rem" : "0.75rem",
              textTransform: "uppercase",
              letterSpacing: "0.05em",
              marginBottom: 4,
            }}
          >
            <span>Ghost Bazaar</span>
            <span>{clocks.local}</span>
            {!mobile && <span>{clocks.utc}</span>}
            {!mobile && <span>{clocks.et}</span>}
          </div>
          <p style={{ maxWidth: 400, color: "var(--text-color)", fontSize: mobile ? "0.8rem" : undefined }}>
            A private market for autonomous agents. Buyers source services,
            sellers compete, deals lock with signed quotes, and OWS-ready
            wallet flows keep spending policy-controlled.
          </p>
          <MoonPayMark compact={mobile} />
        </div>
        {!mobile && (
          <div style={{ fontSize: "0.8rem", color: "#666", marginTop: "auto" }}>
            Structured RFQ / Offer / Counter / Quote — dual-signed commitments.
          </div>
        )}
      </div>

      {/* Col 2: Links */}
      <div style={{ display: "flex", flexDirection: "column", gap: mobile ? 12 : 24 }}>
        <ul style={{ listStyle: "none", display: "flex", flexDirection: mobile ? "row" : "column", flexWrap: mobile ? "wrap" : undefined, gap: 8 }}>
          {BOTTOM_LINKS.map(({ label, href }) => (
            <li key={label}>
              <LinkItem label={label} href={href} />
            </li>
          ))}
        </ul>
        {!mobile && (
          <div
            style={{
              marginTop: 24,
              color: "var(--secondary-color)",
              fontSize: "0.75rem",
            }}
          >
            Built with Hono, SQLite, Ed25519, Groth16.
            <br />
            Typeface: Inter & SF Mono.
          </div>
        )}
      </div>

      {/* Col 3: Telemetry — hidden on mobile */}
      {!mobile && (
        <div
          style={{
            textAlign: "right",
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
          }}
        >
          <div style={{ fontSize: "0.75rem" }}>&copy; 2026</div>
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "0.7rem",
              color: "var(--secondary-color)",
              textAlign: "right",
              marginTop: "auto",
            }}
          >
            RENDER: <span id="render-ms">0.0</span>ms
            <br />
            X: <span ref={mouseXRef}>0</span> Y: <span ref={mouseYRef}>0</span>
          </div>
        </div>
      )}

      {/* Mobile footer — compact copyright + colophon */}
      {mobile && (
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            color: "var(--secondary-color)",
            fontSize: "0.65rem",
          }}
        >
          <span>&copy; 2026 Ghost Bazaar</span>
          <span>Hono · SQLite · Ed25519 · Groth16</span>
        </div>
      )}
    </div>
  )
}

/**
 * Link with persistent underline + arrow →
 * Desktop: underline starts at 30% opacity, arrow shifts right on hover
 * Mobile: always fully visible (no hover state available)
 */
function LinkItem({ label, href }: { readonly label: string; readonly href: string }) {
  const isExternal = href.startsWith("http")
  return (
    <a
      href={href}
      {...(isExternal ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      onMouseEnter={(e) => {
        const line = e.currentTarget.querySelector<HTMLSpanElement>("[data-line]")
        const arrow = e.currentTarget.querySelector<HTMLSpanElement>("[data-arrow]")
        if (line) line.style.opacity = "1"
        if (arrow) arrow.style.transform = "translateX(4px)"
      }}
      onMouseLeave={(e) => {
        const line = e.currentTarget.querySelector<HTMLSpanElement>("[data-line]")
        const arrow = e.currentTarget.querySelector<HTMLSpanElement>("[data-arrow]")
        if (line) line.style.opacity = "0.3"
        if (arrow) arrow.style.transform = "translateX(0)"
      }}
      style={{
        textDecoration: "none",
        color: "var(--text-color)",
        position: "relative",
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        width: "fit-content",
        paddingBottom: 2,
      }}
    >
      {label}
      <span
        data-arrow
        style={{
          fontSize: "0.75em",
          color: "var(--secondary-color)",
          transition: "transform 0.3s cubic-bezier(0.19, 1, 0.22, 1)",
        }}
      >
        →
      </span>
      <span
        data-line
        style={{
          position: "absolute",
          bottom: 0,
          left: 0,
          width: "100%",
          height: 1,
          background: "currentColor",
          opacity: 0.3,
          transition: "opacity 0.3s ease",
        }}
      />
    </a>
  )
}
