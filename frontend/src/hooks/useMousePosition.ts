import { useEffect, useRef } from "react"

export interface MousePosition {
  readonly x: number
  readonly y: number
}

/**
 * Tracks mouse position via a mutable ref (no re-renders).
 * Components read .current in rAF loops for zero-cost reactivity.
 */
export function useMousePosition(): React.RefObject<MousePosition> {
  const pos = useRef<MousePosition>({ x: 0, y: 0 })

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      pos.current = { x: e.clientX, y: e.clientY }
    }
    window.addEventListener("mousemove", handler)
    return () => window.removeEventListener("mousemove", handler)
  }, [])

  return pos
}
