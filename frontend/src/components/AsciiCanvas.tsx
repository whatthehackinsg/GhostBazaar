import { useEffect, useRef } from "react"
import type { MousePosition } from "../hooks/useMousePosition"
import { useTheme } from "../hooks/useTheme"

interface Props {
  readonly mouse: React.RefObject<MousePosition>
  /** When true, the render loop pauses to save CPU (e.g. hero scrolled off-screen) */
  readonly paused?: React.RefObject<boolean>
}

// ASCII density ramp — sparse to dense
const DENSITY =
  " .'`^,:;Il!i><~+_-?][}{1)(|\\/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$"

const CHAR_SIZE_DESKTOP = 12
const CHAR_SIZE_MOBILE = 16 // fewer chars on mobile = better perf

// Island exclusion zone at the bottom edge of the canvas.
// Characters inside the ellipse are skipped; characters in the flow zone
// are displaced outward and densified — like a stream parting around a rock.
const ISLAND_DESKTOP = { halfW: 75, halfH: 14, flow: 2.2 }
const ISLAND_MOBILE = { halfW: 55, halfH: 10, flow: 1.8 }

export function AsciiCanvas({ mouse, paused }: Props) {
  const { resolvedTheme } = useTheme()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const timeRef = useRef(0)
  const parentRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const parent = parentRef.current
    if (!canvas || !parent) return

    const ctx = canvas.getContext("2d")
    if (!ctx) return

    let raf: number
    let width = 0
    let height = 0
    // Responsive values — recomputed on resize, stable across frames
    let isMobile = false
    let charSize = CHAR_SIZE_DESKTOP
    let island = ISLAND_DESKTOP
    // Cached layout — updated on resize only (not per frame)
    let canvasTop = 0
    let telEl: HTMLElement | null = null
    let telFrameCount = 0
    let lensRgb = "17, 17, 17"
    let inkRgb = "100, 100, 100"

    const resize = () => {
      width = parent.clientWidth
      height = parent.clientHeight
      const dpr = window.devicePixelRatio || 1
      canvas.width = width * dpr
      canvas.height = height * dpr
      // setTransform replaces the current matrix (no compounding on repeated resizes)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
      // Recompute responsive values inside resize (not before)
      isMobile = width < 768
      charSize = isMobile ? CHAR_SIZE_MOBILE : CHAR_SIZE_DESKTOP
      island = isMobile ? ISLAND_MOBILE : ISLAND_DESKTOP
      // Cache layout values that don't change between resizes
      canvasTop = canvas.getBoundingClientRect().top
      telEl = document.getElementById("render-ms")
      const rootStyles = getComputedStyle(document.documentElement)
      lensRgb =
        rootStyles.getPropertyValue("--canvas-lens-rgb").trim() || "17, 17, 17"
      inkRgb =
        rootStyles.getPropertyValue("--canvas-ink-rgb").trim() || "100, 100, 100"
    }

    const simpleNoise = (x: number, y: number, t: number): number =>
      Math.sin(x * 0.05 + t) * Math.cos(y * 0.05 + t) +
      Math.sin(x * 0.01 - t) * Math.cos(y * 0.12) * 0.5

    const render = () => {
      // Skip rendering when hero is scrolled off-screen or tab hidden
      if (paused?.current || document.hidden) {
        raf = requestAnimationFrame(render)
        return
      }

      const start = performance.now()
      ctx.clearRect(0, 0, width, height)
      ctx.font = `${charSize}px monospace`
      ctx.textAlign = "center"
      ctx.textBaseline = "middle"

      const colsCount = Math.ceil(width / charSize)
      const rowsCount = Math.ceil(height / charSize)

      // Island center — must match the HTML overlay "Scroll to explore"
      const islandCx = width / 2
      const islandCy = height - 20

      for (let y = 0; y < rowsCount; y++) {
        if (y < rowsCount * 0.4) continue

        for (let x = 0; x < colsCount; x++) {
          const posX = x * charSize
          const posY = y * charSize
          const centerX = posX + charSize / 2
          const centerY = posY + charSize / 2

          // --- Island exclusion ---
          const idx = (centerX - islandCx) / island.halfW
          const idy = (centerY - islandCy) / island.halfH
          const islandDist = Math.sqrt(idx * idx + idy * idy)

          if (islandDist < 1) continue

          // Mouse distance for lens effect (skip on mobile — no mouse)
          const dx = posX - mouse.current.x
          const dy = posY - (mouse.current.y - canvasTop)
          const dist = isMobile ? 999 : Math.sqrt(dx * dx + dy * dy)

          const normalizedY = (rowsCount - y) / rowsCount
          const noiseVal = simpleNoise(x, y, timeRef.current * 0.5)
          const mountainHeight =
            0.3 +
            Math.sin(x * 0.05 + timeRef.current * 0.1) * 0.1 +
            Math.cos(x * 0.2) * 0.05

          let char = ""
          let alpha = 0

          if (normalizedY < mountainHeight + noiseVal * 0.1) {
            const index = Math.floor(Math.abs(noiseVal) * DENSITY.length)
            char = DENSITY[index % DENSITY.length]
            alpha = 1 - normalizedY * 2
          }

          // --- Flow zone: displace + densify near island ---
          let flowShiftX = 0
          let flowShiftY = 0

          if (islandDist < island.flow && char) {
            const flowStrength = 1 - (islandDist - 1) / (island.flow - 1)
            // Push outward from island center — strong displacement
            const fdx = centerX - islandCx
            const fdy = centerY - islandCy
            const fLen = Math.sqrt(fdx * fdx + fdy * fdy) || 1
            flowShiftX = (fdx / fLen) * flowStrength * 18
            flowShiftY = (fdy / fLen) * flowStrength * 12

            // Densify — boost alpha and use denser characters near the island
            // Simulates stream compression (water speeds up around obstacles)
            alpha = Math.min(1, alpha + flowStrength * 0.6)
            const denseIndex = Math.min(
              DENSITY.length - 1,
              Math.floor(Math.abs(noiseVal) * DENSITY.length + flowStrength * 25),
            )
            char = DENSITY[denseIndex]
          }

          // Lens effect: binary characters near mouse
          if (dist < 150) {
            const lensStrength = 1 - dist / 150

            if (Math.random() > 0.5) {
              char = Math.random() > 0.5 ? "0" : "1"
              ctx.fillStyle = `rgba(${lensRgb}, ${lensStrength})`
            } else {
              ctx.fillStyle = `rgba(${inkRgb}, ${alpha})`
            }

            const shiftX = dist > 0 ? (dx / dist) * 10 * lensStrength : 0
            const shiftY = dist > 0 ? (dy / dist) * 10 * lensStrength : 0

            ctx.fillText(
              char,
              centerX - shiftX + flowShiftX,
              centerY - shiftY + flowShiftY,
            )
          } else if (char) {
            ctx.fillStyle = `rgba(${inkRgb}, ${alpha})`
            ctx.fillText(char, centerX + flowShiftX, centerY + flowShiftY)
          }
        }
      }

      timeRef.current += 0.01

      // Throttle telemetry to ~4fps (every 15 frames) to reduce DOM writes
      telFrameCount++
      if (telEl && telFrameCount >= 15) {
        telEl.textContent = (performance.now() - start).toFixed(1)
        telFrameCount = 0
      }

      raf = requestAnimationFrame(render)
    }

    resize()
    window.addEventListener("resize", resize)
    raf = requestAnimationFrame(render)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener("resize", resize)
    }
  }, [mouse, paused, resolvedTheme])

  return (
    <div
      ref={parentRef}
      style={{
        position: "relative",
        height: "70vh",
        width: "100%",
        overflow: "hidden",
        borderBottom: "1px solid var(--hairline)",
      }}
    >
      <canvas
        ref={canvasRef}
        style={{ display: "block", width: "100%", height: "100%" }}
      />
    </div>
  )
}
