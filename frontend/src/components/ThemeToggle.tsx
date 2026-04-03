import type { CSSProperties } from "react"
import { useIsMobile } from "../hooks/useIsMobile"
import { useTheme, type ThemePreference } from "../hooks/useTheme"

const OPTIONS: readonly ThemePreference[] = ["light", "dark", "system"]

export function ThemeToggle() {
  const mobile = useIsMobile()
  const { themePreference, setThemePreference } = useTheme()

  return (
    <div
      style={{
        position: "fixed",
        top: "calc(var(--wallet-bar-height) + var(--pad))",
        right: "var(--pad)",
        zIndex: 1400,
        display: "flex",
        gap: 4,
        padding: mobile ? "5px" : "6px",
        border: "1px solid var(--hairline)",
        borderRadius: 9999,
        background: "var(--bg-panel)",
        backdropFilter: "blur(8px)",
      }}
      aria-label="Theme switcher"
    >
      {OPTIONS.map((option) => {
        const active = themePreference === option
        return (
          <button
            key={option}
            type="button"
            aria-pressed={active}
            onClick={() => setThemePreference(option)}
            style={{
              ...buttonStyle,
              padding: mobile ? "6px 8px" : "7px 10px",
              color: active ? "var(--bg-color)" : "var(--secondary-color)",
              background: active ? "var(--text-color)" : "transparent",
              opacity: active ? 1 : 0.9,
            }}
          >
            {option}
          </button>
        )
      })}
    </div>
  )
}

const buttonStyle: CSSProperties = {
  border: "none",
  borderRadius: 9999,
  fontFamily: "var(--font-mono)",
  fontSize: "0.58rem",
  letterSpacing: "0.14em",
  textTransform: "uppercase",
  cursor: "none",
  transition: "background 0.2s ease, color 0.2s ease, opacity 0.2s ease",
}
