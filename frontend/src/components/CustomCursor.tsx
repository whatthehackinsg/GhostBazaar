import { useEffect, useRef } from "react"
import type { MousePosition } from "../hooks/useMousePosition"

interface Props {
  readonly mouse: React.RefObject<MousePosition>
}

/**
 * Dual-layer custom cursor: instant dot + spring-follow outline.
 * Hidden on touch devices (pointer: coarse) — no rAF loop started.
 *
 * Optimization: rAF loop only runs while the spring is in motion.
 * Starts on mousemove, stops once the outline has settled (< 0.5px delta).
 */
export function CustomCursor({ mouse }: Props) {
  const dotRef = useRef<HTMLDivElement>(null)
  const outlineRef = useRef<HTMLDivElement>(null)
  const trailPos = useRef({ x: 0, y: 0 })
  const rafRef = useRef(0)
  const runningRef = useRef(false)

  useEffect(() => {
    if (window.matchMedia("(pointer: coarse)").matches) return

    const loop = () => {
      const dot = dotRef.current
      const outline = outlineRef.current
      if (!dot || !outline) return

      const { x, y } = mouse.current

      dot.style.left = `${x}px`
      dot.style.top = `${y}px`

      const dx = x - trailPos.current.x
      const dy = y - trailPos.current.y
      trailPos.current = {
        x: trailPos.current.x + dx * 0.15,
        y: trailPos.current.y + dy * 0.15,
      }

      outline.style.left = `${trailPos.current.x}px`
      outline.style.top = `${trailPos.current.y}px`

      // Stop rAF once the spring has settled (< 0.5px movement)
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) {
        runningRef.current = false
        return
      }

      rafRef.current = requestAnimationFrame(loop)
    }

    const startLoop = () => {
      if (!runningRef.current) {
        runningRef.current = true
        rafRef.current = requestAnimationFrame(loop)
      }
    }

    // Drive animation from mouse movement, not continuous polling
    window.addEventListener("mousemove", startLoop)
    return () => {
      cancelAnimationFrame(rafRef.current)
      window.removeEventListener("mousemove", startLoop)
    }
  }, [mouse])

  // Don't render cursor elements on touch devices
  if (typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches) {
    return null
  }

  return (
    <>
      <div
        ref={dotRef}
        style={{
          position: "fixed",
          top: 0,
          left: 0,
          width: 6,
          height: 6,
          backgroundColor: "white",
          borderRadius: "50%",
          transform: "translate(-50%, -50%)",
          zIndex: 9999,
          pointerEvents: "none",
          mixBlendMode: "difference",
        }}
      />
      <div
        ref={outlineRef}
        style={{
          position: "fixed",
          top: 0,
          left: 0,
          width: 40,
          height: 40,
          border: "1px solid white",
          borderRadius: "50%",
          transform: "translate(-50%, -50%)",
          zIndex: 9999,
          pointerEvents: "none",
          mixBlendMode: "difference",
          transition: "width 0.2s, height 0.2s",
        }}
      />
    </>
  )
}
