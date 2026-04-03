import { useEffect, useState } from "react"

/**
 * Hash-based routing — returns current location.hash.
 * Lightweight alternative to React Router for 2-page apps (saves 40KB).
 */
export function useHash(): string {
  const [hash, setHash] = useState(location.hash)

  useEffect(() => {
    const handler = () => setHash(location.hash)
    window.addEventListener("hashchange", handler)
    return () => window.removeEventListener("hashchange", handler)
  }, [])

  return hash
}
