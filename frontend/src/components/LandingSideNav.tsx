import { useEffect, useState } from "react"
import type { CSSProperties } from "react"
import { HAS_API_BACKEND } from "../api"

export const LANDING_NAV_ITEMS = [
  "Live Feed",
  "Origin",
  "Protocol",
  "Privacy",
  "Solana",
  "Architecture",
  "About",
] as const

export const ACTIVE_LANDING_NAV_ITEMS = HAS_API_BACKEND
  ? LANDING_NAV_ITEMS
  : LANDING_NAV_ITEMS.filter((item) => item !== "Live Feed")

interface Props {
  readonly onNavigate?: (item: string) => void
}

function currentSectionFromScroll(): string | null {
  if (window.scrollY < window.innerHeight * 0.85) return null

  const ids = [
    ["Origin", "section-origin"],
    ["Protocol", "section-protocol"],
    ["Privacy", "section-privacy"],
    ["Solana", "section-solana"],
    ["Architecture", "section-architecture"],
    ["About", "section-about"],
  ] as const

  const probeY = window.innerHeight * 0.35
  let active: string | null = "About"

  for (const [label, id] of ids) {
    const node = document.getElementById(id)
    if (!node) continue
    const rect = node.getBoundingClientRect()
    if (rect.top <= probeY && rect.bottom >= probeY) {
      active = label
      break
    }
    if (rect.top > probeY) {
      active = label
      break
    }
  }

  return active
}

export function LandingSideNav({ onNavigate }: Props) {
  const [active, setActive] = useState<string | null>(null)

  useEffect(() => {
    let ticking = false

    const update = () => {
      setActive(currentSectionFromScroll())
      ticking = false
    }

    const onScroll = () => {
      if (!ticking) {
        ticking = true
        requestAnimationFrame(update)
      }
    }

    update()
    window.addEventListener("scroll", onScroll, { passive: true })
    return () => window.removeEventListener("scroll", onScroll)
  }, [])

  return (
    <nav style={railStyle} aria-label="Landing page sections">
      <div style={eyebrowStyle}>
        <img
          src="/favicon.svg"
          alt=""
          aria-hidden="true"
          style={eyebrowIconStyle}
        />
        <span>Navigate</span>
      </div>
      <div style={stackStyle}>
        {ACTIVE_LANDING_NAV_ITEMS.map((item) => {
          const isActive = active === item || (item === "Live Feed" && location.hash === "#/dashboard")
          return (
            <button
              key={item}
              onClick={() => onNavigate?.(item)}
              style={{
                ...itemStyle,
                color: isActive ? "var(--text-color)" : "var(--secondary-color)",
                borderColor: isActive ? "var(--text-color)" : "transparent",
                opacity: isActive ? 1 : 0.78,
              }}
            >
              <span style={markerStyle}>{isActive ? "▸" : "·"}</span>
              <span>{item}</span>
            </button>
          )
        })}
      </div>
    </nav>
  )
}

const railStyle: CSSProperties = {
  position: "sticky",
  top: "clamp(96px, 38.2vh, calc(100vh - 320px))",
  marginTop: "clamp(72px, 9.8vh, 140px)",
  alignSelf: "flex-start",
  width: 156,
  padding: "14px 12px",
  border: "1px solid var(--hairline)",
  borderRadius: 8,
  background: "var(--bg-panel)",
  backdropFilter: "blur(8px)",
}

const eyebrowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  fontFamily: "var(--font-mono)",
  fontSize: "0.58rem",
  letterSpacing: "0.16em",
  textTransform: "uppercase",
  color: "var(--secondary-color)",
  marginBottom: 12,
}

const eyebrowIconStyle: CSSProperties = {
  width: 22,
  height: 22,
  display: "block",
  opacity: 0.75,
  flexShrink: 0,
}

const stackStyle: CSSProperties = {
  display: "grid",
  gap: 6,
}

const itemStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  width: "100%",
  padding: "6px 4px",
  textAlign: "left",
  background: "transparent",
  border: "1px solid transparent",
  borderRadius: 4,
  fontFamily: "var(--font-mono)",
  fontSize: "0.68rem",
  letterSpacing: "0.03em",
  cursor: "none",
  transition: "color 0.2s ease, border-color 0.2s ease, opacity 0.2s ease",
}

const markerStyle: CSSProperties = {
  width: 10,
  textAlign: "center",
}
