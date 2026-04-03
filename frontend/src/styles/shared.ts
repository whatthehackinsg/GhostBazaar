import type { CSSProperties } from "react"

export const sectionStyle = (mobile: boolean): CSSProperties => ({
  padding: mobile ? "48px 20px" : "80px 24px",
  maxWidth: 960,
  margin: "0 auto",
})

export const eyebrow: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "0.65rem",
  letterSpacing: "0.2em",
  textTransform: "uppercase",
  color: "var(--secondary-color)",
  marginBottom: 16,
}

export const heading = (mobile: boolean): CSSProperties => ({
  fontSize: mobile ? "1.8rem" : "2.8rem",
  fontWeight: 300,
  letterSpacing: "-0.02em",
  color: "var(--text-color)",
  marginBottom: 20,
  lineHeight: 1.15,
})

export const bodyText = (mobile: boolean): CSSProperties => ({
  fontSize: mobile ? "0.85rem" : "0.95rem",
  color: "var(--secondary-color)",
  lineHeight: 1.7,
  maxWidth: 600,
})

export const divider: CSSProperties = {
  width: 40,
  height: 1,
  background: "var(--hairline)",
  margin: "0 auto",
}

export function cornerLabel(
  vPos: "top" | "bottom",
  hPos: "left" | "right",
): CSSProperties {
  return {
    position: "absolute",
    [vPos]: 8,
    [hPos]: 12,
    fontFamily: "var(--font-mono)",
    fontSize: "0.55rem",
    letterSpacing: "0.15em",
    textTransform: "uppercase",
    color: "var(--secondary-color)",
    opacity: 0.6,
  }
}
