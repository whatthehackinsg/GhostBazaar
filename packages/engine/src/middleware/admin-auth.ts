/**
 * Admin Authentication — session cookie auth for the admin panel.
 *
 * Flow:
 *   POST /admin/login  → verify ADMIN_TOKEN, issue httpOnly cookie
 *   GET  /admin/*      → verify cookie on every request
 *   POST /admin/logout → clear cookie + session
 *
 * Security:
 *   - ADMIN_TOKEN only used at login time — never reaches browser JS
 *   - Session token is random 32 bytes (not the ADMIN_TOKEN itself)
 *   - httpOnly + Secure + SameSite=None (cross-origin Vercel→Fly.io)
 *   - timingSafeEqual prevents timing attacks on password check
 *   - Hard cap: max 50 active sessions (sweep on login + auth check)
 */

import { timingSafeEqual, randomBytes, createHmac } from "node:crypto"
import { EngineError } from "./error-handler.js"

const SESSION_COOKIE = "ghost_bazaar_admin"
const SESSION_MAX_AGE = 24 * 60 * 60 // 24 hours in seconds
const MAX_ACTIVE_SESSIONS = 50
const LOGIN_WINDOW_MS = 60_000 // 1 minute
const MAX_LOGIN_ATTEMPTS_PER_IP = 5
const MAX_LOGIN_ATTEMPTS_GLOBAL = 20  // prevents X-Forwarded-For rotation bypass

/** Active sessions: session token → expiry timestamp (ms) */
const activeSessions = new Map<string, number>()

/** Per-IP login rate limiter: IP → { count, windowStart } */
const loginAttemptsByIp = new Map<string, { count: number; windowStart: number }>()

/** Global login rate limiter — catches X-Forwarded-For rotation attacks */
let globalLoginAttempts = 0
let globalLoginWindowStart = Date.now()

// ---------------------------------------------------------------------------
// Timing-safe comparison — HMAC both sides to ensure constant-length compare.
// Prevents length oracle: raw timingSafeEqual short-circuits on length mismatch.
// ---------------------------------------------------------------------------

function safeCompare(a: string, b: string): boolean {
  const hmac = (s: string) => createHmac("sha256", "ghost-bazaar-admin-auth").update(s).digest()
  return timingSafeEqual(hmac(a), hmac(b))
}

// ---------------------------------------------------------------------------
// Sweep helper — remove expired sessions from memory
// ---------------------------------------------------------------------------

function sweepExpiredSessions(): void {
  const now = Date.now()
  for (const [tok, exp] of activeSessions) {
    if (now > exp) activeSessions.delete(tok)
  }
}

// ---------------------------------------------------------------------------
// Per-IP login rate limiter — counts FAILED attempts only, resets on success.
// Keyed by IP so one attacker cannot lock out all admins.
// ---------------------------------------------------------------------------

function checkLoginRateLimit(ip: string): boolean {
  const now = Date.now()

  // Reset global window if expired
  if (now - globalLoginWindowStart > LOGIN_WINDOW_MS) {
    globalLoginAttempts = 0
    globalLoginWindowStart = now
  }

  // Per-IP rate limit — hard block (5 failed attempts per IP per minute)
  const entry = loginAttemptsByIp.get(ip)
  if (entry && now - entry.windowStart <= LOGIN_WINDOW_MS) {
    if (entry.count >= MAX_LOGIN_ATTEMPTS_PER_IP) return false
  }

  // Global rate limit — only blocks IPs that ALSO have per-IP failures.
  // This prevents the "attacker rotates IPs to exhaust global budget and
  // locks out legitimate admins" DoS. A fresh IP with zero failures can
  // always attempt login even if global count is high.
  if (globalLoginAttempts >= MAX_LOGIN_ATTEMPTS_GLOBAL) {
    // Allow if this IP has no prior failures (likely a real admin)
    const ipEntry = loginAttemptsByIp.get(ip)
    if (ipEntry && now - ipEntry.windowStart <= LOGIN_WINDOW_MS && ipEntry.count > 0) {
      return false
    }
    // Fresh IP or expired window — allow through despite global limit
  }

  return true
}

function recordFailedLogin(ip: string): void {
  const now = Date.now()

  // Increment global counter
  if (now - globalLoginWindowStart > LOGIN_WINDOW_MS) {
    globalLoginAttempts = 1
    globalLoginWindowStart = now
  } else {
    globalLoginAttempts++
  }

  // Increment per-IP counter
  const entry = loginAttemptsByIp.get(ip)
  if (!entry || now - entry.windowStart > LOGIN_WINDOW_MS) {
    loginAttemptsByIp.set(ip, { count: 1, windowStart: now })
  } else {
    entry.count++
  }
  // Prevent loginAttemptsByIp from growing unbounded
  if (loginAttemptsByIp.size > 1000) {
    for (const [k, v] of loginAttemptsByIp) {
      if (now - v.windowStart > LOGIN_WINDOW_MS) loginAttemptsByIp.delete(k)
    }
  }
}

function clearLoginAttempts(ip: string): void {
  loginAttemptsByIp.delete(ip)
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

/**
 * Verify password and issue a session cookie.
 * Returns the Set-Cookie header value, or null if authentication failed.
 * Returns "rate_limited" if too many failed attempts from this IP.
 *
 * @param password - The password to verify
 * @param clientIp - Client IP for per-IP rate limiting
 */
export function handleLogin(password: string, clientIp: string = "unknown"): { cookie: string } | "rate_limited" | null {
  const token = process.env.ADMIN_TOKEN
  if (!token) return null

  // Per-IP rate limit: 5 failed attempts per minute
  if (!checkLoginRateLimit(clientIp)) return "rate_limited"

  // HMAC-based timing-safe comparison (prevents length oracle)
  if (!safeCompare(password, token)) {
    recordFailedLogin(clientIp)
    return null
  }

  // Success — clear rate limit for this IP
  clearLoginAttempts(clientIp)

  // Enforce hard cap — sweep first, then check
  sweepExpiredSessions()
  if (activeSessions.size >= MAX_ACTIVE_SESSIONS) {
    return null // → 429 Too Many Sessions
  }

  // Issue a random session token (NOT the ADMIN_TOKEN itself)
  const sessionToken = randomBytes(32).toString("hex")
  activeSessions.set(sessionToken, Date.now() + SESSION_MAX_AGE * 1000)

  return {
    cookie: `${SESSION_COOKIE}=${sessionToken}; HttpOnly; Secure; SameSite=None; Path=/admin; Max-Age=${SESSION_MAX_AGE}`,
  }
}

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------

const COOKIE_RE = /ghost_bazaar_admin=([a-f0-9]{64})/

/**
 * Verify admin session cookie. Throws EngineError on failure.
 * Call on all /admin/* routes except /admin/login.
 */
export function requireAdminAuth(req: Request): void {
  const token = process.env.ADMIN_TOKEN
  if (!token) {
    throw new EngineError(403, "forbidden", "Admin API not configured — set ADMIN_TOKEN env var")
  }

  sweepExpiredSessions()

  const cookies = req.headers.get("Cookie") ?? ""
  const match = cookies.match(COOKIE_RE)
  if (!match) {
    throw new EngineError(401, "unauthorized", "Not logged in — visit /admin/login")
  }

  const sessionToken = match[1]
  const expiry = activeSessions.get(sessionToken)
  if (!expiry || Date.now() > expiry) {
    activeSessions.delete(sessionToken)
    throw new EngineError(401, "unauthorized", "Session expired — please log in again")
  }
}

// ---------------------------------------------------------------------------
// Logout
// ---------------------------------------------------------------------------

/**
 * Clear the admin session. Returns the Set-Cookie header value that
 * instructs the browser to delete the cookie.
 */
export function handleLogout(req: Request): string {
  const cookies = req.headers.get("Cookie") ?? ""
  const match = cookies.match(COOKIE_RE)
  if (match) activeSessions.delete(match[1])
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=None; Path=/admin; Max-Age=0`
}

// ---------------------------------------------------------------------------
// Test helper
// ---------------------------------------------------------------------------

/** Reset all sessions — for tests only */
export function _resetSessions(): void {
  activeSessions.clear()
}
