/**
 * API configuration for Ghost Bazaar frontend.
 *
 * In development, Vite proxies /dashboard/* and /admin/* to localhost:3000,
 * so API_BASE is empty (same-origin). In production (Vercel), VITE_API_URL
 * points to the Fly.io engine (e.g. https://ghost-bazaar-engine.fly.dev).
 */
export const API_BASE = import.meta.env.VITE_API_URL ?? ""

/** Build a full API URL from a path like "/dashboard/stats" */
export function apiUrl(path: string): string {
  return `${API_BASE}${path}`
}
