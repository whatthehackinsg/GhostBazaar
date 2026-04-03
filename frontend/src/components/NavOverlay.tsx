import type { CSSProperties } from "react"
import { LANDING_NAV_ITEMS } from "./LandingSideNav"

interface Props {
  readonly active: boolean
  readonly onClose: () => void
  readonly onNavigate?: (item: string) => void
}

const overlayStyle: CSSProperties = {
  position: "fixed",
  top: 0,
  left: 0,
  width: "100vw",
  height: "100vh",
  background: "var(--bg-overlay)",
  backdropFilter: "blur(10px)",
  zIndex: 2000,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  transition: "opacity 0.4s ease",
  cursor: "none",
}

const itemStyle: CSSProperties = {
  fontSize: "3rem",
  fontWeight: 300,
  color: "var(--secondary-color)",
  cursor: "none",
  transition: "color 0.3s",
  userSelect: "none",
}

export function NavOverlay({ active, onClose, onNavigate }: Props) {
  return (
    <div
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      style={{
        ...overlayStyle,
        opacity: active ? 1 : 0,
        pointerEvents: active ? "auto" : "none",
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "2rem",
          textAlign: "center",
        }}
      >
        {LANDING_NAV_ITEMS.map((item) => (
          <div
            key={item}
            onClick={() => onNavigate?.(item)}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = "var(--text-color)"
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = "var(--secondary-color)"
            }}
            style={itemStyle}
          >
            {item}
          </div>
        ))}

        {/* Skill downloads */}
        <div style={{ display: "flex", gap: "2rem", justifyContent: "center" }}>
          {[
            { label: "↓ Buyer Skill", href: "/skills/ghost-bazaar-buyer/SKILL.md" },
            { label: "↓ Seller Skill", href: "/skills/ghost-bazaar-seller/SKILL.md" },
          ].map(({ label, href }) => (
            <a
              key={href}
              href={href}
              download
              onClick={onClose}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = "#111"
                e.currentTarget.style.borderColor = "#111"
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = "#ccc"
                e.currentTarget.style.borderColor = "#ccc"
              }}
              style={{
                ...itemStyle,
                fontSize: "1.2rem",
                textDecoration: "none",
                border: "1px solid #ccc",
                borderRadius: 9999,
                padding: "8px 24px",
                fontFamily: "var(--font-mono)",
                letterSpacing: "0.05em",
              }}
            >
              {label}
            </a>
          ))}
        </div>

        <div
          onClick={onClose}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = "var(--text-color)"
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = "var(--secondary-color)"
          }}
          style={itemStyle}
        >
          Close
        </div>
      </div>
    </div>
  )
}
