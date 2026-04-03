import { useCallback, useRef } from "react"

const GLITCH_CHARS = "!<>-_\\/[]{}—=+*^?#________"

interface QueueItem {
  readonly from: string
  readonly to: string
  readonly start: number
  readonly end: number
  char?: string
}

/**
 * Text scramble effect — characters randomly swap before resolving to target text.
 * Returns a ref to attach to the element and a trigger function.
 *
 * Uses textContent instead of innerHTML to avoid HTML parsing on every frame.
 * Glitch characters are rendered as plain text (no styled spans).
 */
export function useTextScramble() {
  const elRef = useRef<HTMLElement>(null)
  const frameRef = useRef(0)
  const rafRef = useRef(0)
  const queueRef = useRef<QueueItem[]>([])
  const resolveRef = useRef<(() => void) | null>(null)

  const update = useCallback(() => {
    const el = elRef.current
    if (!el) return

    let output = ""
    let complete = 0
    const queue = queueRef.current

    for (let i = 0; i < queue.length; i++) {
      const item = queue[i]
      if (frameRef.current >= item.end) {
        complete++
        output += item.to
      } else if (frameRef.current >= item.start) {
        if (!item.char || Math.random() < 0.28) {
          item.char = GLITCH_CHARS[Math.floor(Math.random() * GLITCH_CHARS.length)]
        }
        output += item.char
      } else {
        output += item.from
      }
    }

    // textContent — no HTML parsing, no DOM node creation per frame
    el.textContent = output

    if (complete === queue.length) {
      resolveRef.current?.()
    } else {
      frameRef.current++
      rafRef.current = requestAnimationFrame(update)
    }
  }, [])

  const scramble = useCallback(
    (newText: string) => {
      const el = elRef.current
      if (!el) return Promise.resolve()

      const oldText = el.textContent ?? ""
      const length = Math.max(oldText.length, newText.length)

      const queue: QueueItem[] = []
      for (let i = 0; i < length; i++) {
        const from = oldText[i] ?? ""
        const to = newText[i] ?? ""
        const start = Math.floor(Math.random() * 40)
        const end = start + Math.floor(Math.random() * 40)
        queue.push({ from, to, start, end })
      }

      queueRef.current = queue
      cancelAnimationFrame(rafRef.current)
      frameRef.current = 0

      return new Promise<void>((resolve) => {
        resolveRef.current = resolve
        update()
      })
    },
    [update],
  )

  return { ref: elRef, scramble }
}
