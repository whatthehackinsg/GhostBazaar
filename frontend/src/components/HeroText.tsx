import { useCallback } from "react"
import { useTextScramble } from "../hooks/useTextScramble"
import { useIsMobile } from "../hooks/useIsMobile"

const HEADLINE = "Ghost Bazaar"
const SUBLINE = "Private agent commerce on Solana with signed deals and policy-ready wallets."

/**
 * Hero headline with text scramble effect on hover.
 * Responsive: smaller type + tighter spacing on mobile.
 */
export function HeroText() {
  const { ref, scramble } = useTextScramble()
  const mobile = useIsMobile()

  const handleEnter = useCallback(() => {
    scramble(HEADLINE)
  }, [scramble])

  const handleLeave = useCallback(() => {
    setTimeout(() => scramble(HEADLINE), 200)
  }, [scramble])

  return (
    <div
        style={{
          position: "absolute",
          top: "38.2%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          pointerEvents: "auto",
          textAlign: "center",
          width: mobile ? "90%" : "auto",
        }}
      >
        <div
          ref={ref as React.RefObject<HTMLDivElement>}
          onMouseEnter={handleEnter}
          onMouseLeave={handleLeave}
          style={{
            fontSize: mobile ? "1.5rem" : "3rem",
            fontWeight: 400,
            letterSpacing: "-0.03em",
            color: "var(--text-color)",
            lineHeight: mobile ? 1.05 : 1,
            marginBottom: 8,
          }}
        >
          {HEADLINE}
        </div>
        <div
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: mobile ? "0.65rem" : "0.8rem",
            color: "var(--secondary-color)",
            marginBottom: mobile ? 14 : 20,
          }}
        >
          {SUBLINE}
        </div>
        <span
          style={{
            display: "inline-block",
            padding: mobile ? "3px 10px" : "4px 14px",
            border: "2px solid var(--text-color)",
            borderRadius: 9999,
            fontFamily: "var(--font-mono)",
            fontSize: mobile ? "0.5rem" : "0.65rem",
            letterSpacing: "0.25em",
            textTransform: "uppercase",
            color: "var(--text-color)",
            fontSmooth: "never",
            WebkitFontSmoothing: "none",
            imageRendering: "pixelated",
            textRendering: "optimizeSpeed",
          }}
        >
          {"GHOST BAZAAR".split("").map((ch, i) => (
            <span
              key={i}
              style={{
                display: "inline-block",
                width: ch === " " ? "0.45em" : "0.7em",
                textAlign: "center",
                fontWeight: 700,
              }}
            >
              {ch}
            </span>
          ))}
        </span>
      </div>
  )
}
