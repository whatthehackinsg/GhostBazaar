import { useEffect, useRef, useState, useCallback } from "react"
import type { CSSProperties } from "react"
import { useIsMobile } from "../hooks/useIsMobile"
import { cornerLabel, eyebrow, heading } from "../styles/shared"
import { ProtocolAsciiArt } from "./ProtocolAsciiArt"

const PHASES = [
  {
    number: "01",
    title: "Discovery",
    description:
      "Buyer broadcasts an RFQ. Sellers publish listings. A Poseidon commitment binds the buyer's budget without revealing it.",
  },
  {
    number: "02",
    title: "Negotiation",
    description:
      "Multi-round offers and counter-offers. ZK proofs verify budget sufficiency. Deadline-bounded game theory drives convergence.",
  },
  {
    number: "03",
    title: "Commitment",
    description:
      "Dual Ed25519 signatures lock the agreed price into a Quote. Neither party can repudiate. The nonce prevents replay.",
  },
  {
    number: "04",
    title: "Settlement",
    description:
      "Solana SPL USDC transfer with 17-step on-chain verification. x402-compatible headers. Nonce consumed on first use.",
  },
] as const

const AUTO_INTERVAL = 3500 // ms between auto-advance

/**
 * Protocol section — centered layout.
 * ASCII art centered in a framed box.
 * Desktop: cards auto-carousel (pause on hover). Mobile: manual swipe.
 */
export function ProtocolSection() {
  const mobile = useIsMobile()
  const stripRef = useRef<HTMLDivElement>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  const pausedRef = useRef(false)

  // Auto-advance on desktop
  useEffect(() => {
    if (mobile) return

    const timer = setInterval(() => {
      if (pausedRef.current) return
      setActiveIndex((prev) => (prev + 1) % PHASES.length)
    }, AUTO_INTERVAL)

    return () => clearInterval(timer)
  }, [mobile])

  // Scroll to active card
  useEffect(() => {
    if (mobile) return
    const strip = stripRef.current
    if (!strip) return

    const card = strip.children[activeIndex] as HTMLElement | undefined
    if (!card) return

    strip.scrollTo({
      left: card.offsetLeft - strip.offsetLeft,
      behavior: "smooth",
    })
  }, [activeIndex, mobile])

  const handleDotClick = useCallback((i: number) => {
    setActiveIndex(i)
  }, [])

  return (
    <section
      id="section-protocol"
      style={{
        padding: mobile ? "48px 20px" : "80px 24px",
        maxWidth: 960,
        margin: "0 auto",
      }}
    >
      <div style={eyebrow}>Protocol</div>
      <h2 style={{ ...heading(mobile), marginBottom: 0 }}>Four phases. Zero trust.</h2>

      {/* ASCII art — centered in framed box */}
      <div
        style={{
          marginTop: 32,
          border: "1px solid var(--hairline)",
          borderRadius: 4,
          padding: mobile ? "24px 12px 12px" : "32px 24px 16px",
          overflow: "hidden",
          position: "relative",
        }}
      >
        <span style={cornerLabel("top", "left")}>PROTOCOL FLOW</span>
        <span style={cornerLabel("top", "right")}>v4</span>
        <ProtocolAsciiArt />
      </div>

      {/* Phase cards — carousel */}
      <div
        onMouseEnter={() => { pausedRef.current = true }}
        onMouseLeave={() => { pausedRef.current = false }}
        style={{ marginTop: 32 }}
      >
        <style>{`.phase-strip::-webkit-scrollbar { display: none; }`}</style>
        <div
          ref={stripRef}
          className="phase-strip"
          style={{
            display: "flex",
            gap: mobile ? 12 : 20,
            overflowX: mobile ? "auto" : "hidden",
            scrollSnapType: mobile ? "x mandatory" : undefined,
            WebkitOverflowScrolling: "touch",
            scrollbarWidth: "none",
            paddingBottom: 4,
          }}
        >
          {PHASES.map((phase, i) => (
            <div
              key={phase.number}
              style={{
                minWidth: mobile ? "85%" : 280,
                maxWidth: mobile ? "85%" : 280,
                flexShrink: 0,
                padding: mobile ? 16 : 24,
                border: `1px solid ${!mobile && i === activeIndex ? "var(--text-color)" : "var(--hairline)"}`,
                borderRadius: 4,
                scrollSnapAlign: mobile ? "start" : undefined,
                transition: "border-color 0.3s ease",
              }}
            >
              <div style={phaseNumber}>{phase.number}</div>
              <div style={phaseTitle(mobile)}>{phase.title}</div>
              <p style={phaseBody(mobile)}>{phase.description}</p>
            </div>
          ))}
        </div>

        {/* Interaction hint + dot indicators */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 12,
            marginTop: 16,
          }}
        >
          {/* Dot indicators — desktop only */}
          {!mobile &&
            PHASES.map((_, i) => (
              <button
                key={i}
                onClick={() => handleDotClick(i)}
                style={{
                  width: i === activeIndex ? 24 : 6,
                  height: 6,
                  borderRadius: 3,
                  border: "none",
                  background: i === activeIndex ? "var(--text-color)" : "var(--hairline)",
                  padding: 0,
                  cursor: "none",
                  transition: "width 0.3s ease, background 0.3s ease",
                }}
              />
            ))}

          {/* Hint text */}
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "0.6rem",
              color: "var(--secondary-color)",
              opacity: 0.5,
              letterSpacing: "0.05em",
              marginLeft: mobile ? 0 : 8,
            }}
          >
            {mobile ? "swipe →" : "auto"}
          </span>
        </div>
      </div>
    </section>
  )
}

const phaseNumber: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: "0.65rem",
  color: "var(--secondary-color)",
  marginBottom: 8,
}

const phaseTitle = (mobile: boolean): CSSProperties => ({
  fontSize: mobile ? "1rem" : "1.1rem",
  fontWeight: 500,
  marginBottom: 8,
  color: "var(--text-color)",
})

const phaseBody = (mobile: boolean): CSSProperties => ({
  fontSize: mobile ? "0.75rem" : "0.8rem",
  color: "var(--secondary-color)",
  lineHeight: 1.6,
})
