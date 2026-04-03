import { useEffect, useRef, useState } from "react"
import type { MousePosition } from "../hooks/useMousePosition"
import { useIsMobile } from "../hooks/useIsMobile"
import { CornerIndices } from "../components/CornerIndices"
import { LandingSideNav } from "../components/LandingSideNav"
import { NavOverlay } from "../components/NavOverlay"
import { AsciiCanvas } from "../components/AsciiCanvas"
import { HeroText } from "../components/HeroText"
import { BottomPanel } from "../components/BottomPanel"
import { LandingContent } from "../components/LandingContent"

interface Props {
  readonly mouse: React.RefObject<MousePosition>
  readonly onNavigate: (hash: string) => void
}

/**
 * Landing page — scroll-driven split reveal animation.
 *
 * The hero (canvas + panel) is fixed at 100vh. As the user scrolls,
 * the canvas slides UP and the panel slides DOWN from the split line,
 * revealing a content section behind them. All transforms are applied
 * via refs (no React re-renders) for 60fps performance.
 */
export function LandingPage({ mouse, onNavigate }: Props) {
  const mobile = useIsMobile()
  const [navOpen, setNavOpen] = useState(false)

  const topRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const heroLayerRef = useRef<HTMLDivElement>(null)
  const indicatorRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const canvasPaused = useRef(false)

  useEffect(() => {
    let ticking = false
    let lastProgress = -1

    const applyScroll = () => {
      const p = Math.min(1, window.scrollY / window.innerHeight)

      if (Math.abs(p - lastProgress) < 0.005) {
        ticking = false
        return
      }
      lastProgress = p

      canvasPaused.current = p > 0.95

      if (topRef.current) {
        topRef.current.style.transform = `translateY(-${p * 100}vh)`
      }
      if (bottomRef.current) {
        bottomRef.current.style.transform = `translateY(${p * 100}vh)`
      }
      if (indicatorRef.current) {
        indicatorRef.current.style.opacity = String(Math.max(0, 1 - p * 4))
      }
      if (contentRef.current) {
        contentRef.current.style.opacity = String(p)
      }
      if (heroLayerRef.current) {
        heroLayerRef.current.style.pointerEvents = p > 0.95 ? "none" : "auto"
      }

      ticking = false
    }

    const onScroll = () => {
      if (!ticking) {
        ticking = true
        requestAnimationFrame(applyScroll)
      }
    }

    window.addEventListener("scroll", onScroll, { passive: true })
    return () => window.removeEventListener("scroll", onScroll)
  }, [])

  const handleNavItem = (item: string) => {
    setNavOpen(false)
    if (item === "Live Feed" || item === "Metrics") {
      onNavigate("#/dashboard")
      return
    }
    const sectionMap: Record<string, string> = {
      Protocol: "section-protocol",
      Privacy: "section-privacy",
      Origin: "section-origin",
      Solana: "section-solana",
      Architecture: "section-architecture",
      About: "section-about",
    }
    const id = sectionMap[item]
    if (id) {
      document.getElementById(id)?.scrollIntoView({ behavior: "smooth" })
    }
  }

  return (
    <div style={{ minHeight: "200vh" }}>
      <>
        <CornerIndices onTriggerNav={() => setNavOpen(true)} />
        <NavOverlay
          active={navOpen}
          onClose={() => setNavOpen(false)}
          onNavigate={handleNavItem}
        />
      </>

      <div
        ref={heroLayerRef}
        style={{
          position: "fixed",
          top: 0,
          left: 0,
          width: "100%",
          height: "100vh",
          zIndex: 10,
        }}
      >
        <div ref={topRef} style={{ willChange: "transform" }}>
          <div style={{ position: "relative" }}>
            <AsciiCanvas mouse={mouse} paused={canvasPaused} />
            <HeroText />

            <div
              ref={indicatorRef}
              style={{
                position: "absolute",
                bottom: 14,
                left: "50%",
                transform: "translateX(-50%)",
                cursor: "none",
                zIndex: 20,
                whiteSpace: "nowrap",
                fontSize: "0.7rem",
                letterSpacing: "0.05em",
                color: "var(--secondary-color)",
                animation: "fade-pulse 3s ease-in-out infinite",
              }}
            >
              Scroll to explore
            </div>
          </div>
        </div>

        <div ref={bottomRef} style={{ willChange: "transform", position: "relative" }}>
          <div
            style={{
              position: "absolute",
              top: 8,
              left: "50%",
              transform: "translateX(-50%)",
              zIndex: 20,
              animation: "bounce-down 2s ease-in-out infinite",
            }}
          >
            <svg
              width="14"
              height="8"
              viewBox="0 0 14 8"
              fill="none"
              style={{ display: "block" }}
            >
              <path
                d="M1 1L7 7L13 1"
                stroke="var(--secondary-color)"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <BottomPanel mouse={mouse} />
        </div>
      </div>

      <div
        ref={contentRef}
        style={{
          paddingTop: "100vh",
          opacity: 0,
        }}
      >
        {mobile ? (
          <LandingContent />
        ) : (
          <div
            style={{
              maxWidth: 1220,
              margin: "0 auto",
              padding: "0 24px",
              display: "grid",
              gridTemplateColumns: "180px minmax(0, 1fr)",
              gap: 28,
              alignItems: "start",
            }}
          >
            <LandingSideNav onNavigate={handleNavItem} />
            <LandingContent />
          </div>
        )}
      </div>
    </div>
  )
}
