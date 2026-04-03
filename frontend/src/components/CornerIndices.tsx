// Uses CSS var(--pad) which is 24px desktop, 16px mobile

import type { CSSProperties } from "react"

interface Props {
  readonly onTriggerNav: () => void
}

const pillStyle: CSSProperties = {
  cursor: "none",
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "6px 12px",
  borderRadius: 9999,
  border: "1px solid var(--hairline)",
  transition: "border-color 0.3s ease, transform 0.3s ease",
  userSelect: "none",
  textDecoration: "none",
  color: "var(--text-color)",
  fontFamily: "var(--font-mono)",
  fontSize: "0.6rem",
  letterSpacing: "0.1em",
  textTransform: "uppercase" as const,
  opacity: 0.7,
}

function SkillPill({ label, href }: { readonly label: string; readonly href: string }) {
  return (
    <a
      href={href}
      download
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = "var(--text-color)"
        e.currentTarget.style.opacity = "1"
        e.currentTarget.style.transform = "scale(1.05)"
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = "var(--hairline)"
        e.currentTarget.style.opacity = "0.7"
        e.currentTarget.style.transform = "scale(1)"
      }}
      style={pillStyle}
    >
      <span style={{ fontSize: "0.7rem" }}>↓</span>
      {label}
    </a>
  )
}

export function CornerIndices({ onTriggerNav }: Props) {
  return (
    <>
      <style>{`
        .menu-btn:hover .menu-line {
          background-color: var(--text-color) !important;
        }
        .menu-btn:hover .menu-label {
          opacity: 1 !important;
        }
        @media (max-width: 768px) {
          .skill-pills { display: none !important; }
        }
      `}</style>

      <div
        style={{
          position: "fixed",
          top: "var(--pad)",
          left: "var(--pad)",
          zIndex: 1000,
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <div
          className="menu-btn"
          onClick={onTriggerNav}
          onMouseEnter={(e) => {
            e.currentTarget.style.borderColor = "var(--text-color)"
            e.currentTarget.style.transform = "scale(1.05)"
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.borderColor = "var(--hairline)"
            e.currentTarget.style.transform = "scale(1)"
          }}
          style={{
            cursor: "none",
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "8px 16px",
            borderRadius: 9999,
            border: "1px solid var(--hairline)",
            transition: "border-color 0.3s ease, transform 0.3s ease",
            userSelect: "none",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 3.5 }}>
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="menu-line"
                style={{
                  width: 16,
                  height: 1.5,
                  backgroundColor: "var(--secondary-color)",
                  borderRadius: 1,
                  transition: "background-color 0.3s ease",
                }}
              />
            ))}
          </div>
          <span
            className="menu-label"
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "0.65rem",
              letterSpacing: "0.15em",
              textTransform: "uppercase",
              color: "var(--text-color)",
              opacity: 0.6,
              transition: "opacity 0.3s ease",
            }}
          >
            MENU
          </span>
        </div>

        <div className="skill-pills" style={{ display: "flex", gap: 6 }}>
          <SkillPill label="Buyer Skill" href="/skills/ghost-bazaar-buyer/SKILL.md" />
          <SkillPill label="Seller Skill" href="/skills/ghost-bazaar-seller/SKILL.md" />
        </div>
      </div>
    </>
  )
}
