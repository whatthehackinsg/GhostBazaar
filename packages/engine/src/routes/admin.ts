/**
 * Admin Routes — authenticated panel for team ops/debugging.
 *
 * Auth: session cookie (httpOnly + Secure + SameSite=Strict).
 * Login at POST /admin/login, verify cookie on all other /admin/* routes.
 *
 * Endpoints:
 *   POST /admin/login               — verify password, set cookie
 *   POST /admin/logout              — clear cookie
 *   GET  /admin/sessions            — paginated session list
 *   GET  /admin/sessions/:id        — single session detail
 *   GET  /admin/sessions/:id/events — all events (JSON or SSE)
 *   GET  /admin/stats               — extended metrics
 */

import { Hono } from "hono"
import type { EngineEnv } from "../app.js"
import type { SessionManager } from "../state/session-manager.js"
import type { InternalEventStore } from "../types.js"
import type { NegotiationEvent } from "../types.js"
import type { StatsCollector } from "../stats/stats-collector.js"
import type { EventBroadcaster } from "../stats/event-broadcaster.js"
import { handleLogin, handleLogout, requireAdminAuth } from "../middleware/admin-auth.js"
import { EngineError } from "../middleware/error-handler.js"

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface AdminRouteConfig {
  readonly sessionManager: SessionManager
  readonly eventStore: InternalEventStore
  readonly statsCollector: StatsCollector
  readonly broadcaster: EventBroadcaster
}

const MAX_ADMIN_SSE = 5
let adminSseConnections = 0

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export function createAdminRoute(config: AdminRouteConfig) {
  const app = new Hono<EngineEnv>()

  // --- Login (no cookie required) ---
  app.post("/admin/login", async (c) => {
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>))
    const password = body["password"]
    if (!password || typeof password !== "string") {
      throw new EngineError(400, "bad_request", "Missing password field")
    }

    // Extract client IP for per-IP rate limiting
    const clientIp = c.req.header("X-Forwarded-For")?.split(",")[0]?.trim()
      ?? c.req.header("X-Real-IP")
      ?? "unknown"
    const result = handleLogin(password, clientIp)
    if (result === "rate_limited") {
      throw new EngineError(429, "rate_limited", "Too many login attempts — try again in 1 minute")
    }
    if (!result || typeof result === "string") {
      throw new EngineError(401, "unauthorized", "Invalid password or too many active sessions")
    }

    c.header("Set-Cookie", result.cookie)
    return c.json({ status: "ok" })
  })

  // --- Logout (cookie required) ---
  app.post("/admin/logout", (c) => {
    const clearCookie = handleLogout(c.req.raw)
    c.header("Set-Cookie", clearCookie)
    return c.json({ status: "logged_out" })
  })

  // --- Auth middleware for all other /admin/* routes ---
  app.use("/admin/*", async (c, next) => {
    // Skip login/logout routes
    const path = new URL(c.req.url).pathname
    if (path === "/admin/login" || path === "/admin/logout") {
      return next()
    }
    requireAdminAuth(c.req.raw)
    return next()
  })

  // --- Session list (paginated, filterable) ---
  app.get("/admin/sessions", (c) => {
    const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10) || 50, 200)
    const offset = parseInt(c.req.query("offset") ?? "0", 10) || 0
    const stateFilter = c.req.query("state") ?? null

    const allIds = config.sessionManager.getActiveSessionIds()
    const sessions: Array<Record<string, unknown>> = []

    for (const rfqId of allIds) {
      const session = config.sessionManager.getSession(rfqId)
      if (!session) continue
      if (stateFilter && session.state !== stateFilter) continue

      const events = config.eventStore.getAllEvents(rfqId)
      const createdAt = events[0]?.timestamp ?? null
      const lastEvent = events.length > 0 ? events[events.length - 1] : null
      const durationMs = createdAt && lastEvent
        ? new Date(lastEvent.timestamp).getTime() - new Date(createdAt).getTime()
        : null

      // Extract final_price from unsigned quote if available
      const finalPrice = (session.unsignedQuote as Record<string, unknown> | null)?.final_price as string | undefined ?? null

      // Extract listing_id from winning offer
      const winningOffer = session.selectedOfferId
        ? session.offers.find((o) => o.offer_id === session.selectedOfferId)
        : null

      sessions.push({
        rfq_id: rfqId,
        state: session.state,
        buyer: session.rfq.buyer,
        service_type: session.rfq.service_type,
        anchor_price: session.rfq.anchor_price,
        currency: session.rfq.currency,
        offer_count: session.offers.length,
        seller_count: new Set(session.offers.map((o) => o.seller)).size,
        selected_seller: session.selectedSeller,
        created_at: createdAt,
        deadline: session.rfq.deadline,
        event_count: events.length,
        // --- God-view fields ---
        final_price: finalPrice,
        listing_id: winningOffer?.listing_id ?? null,
        duration_ms: durationMs,
        total_accept_attempts: session.totalAcceptAttempts,
      })
    }

    // Sort by event count descending (most active first)
    sessions.sort((a, b) => (b.event_count as number) - (a.event_count as number))

    const total = sessions.length
    const paged = sessions.slice(offset, offset + limit)

    return c.json({ total, limit, offset, sessions: paged })
  })

  // --- Single session detail ---
  app.get("/admin/sessions/:id", (c) => {
    const rfqId = c.req.param("id")
    const session = config.sessionManager.getSession(rfqId)
    if (!session) {
      throw new EngineError(404, "not_found", `Session ${rfqId} not found`)
    }

    // Derive computed fields for god-view debugging
    const events = config.eventStore.getAllEvents(rfqId)
    const createdAt = events[0]?.timestamp ?? null
    const lastEvent = events.length > 0 ? events[events.length - 1] : null
    const durationMs = createdAt && lastEvent
      ? new Date(lastEvent.timestamp).getTime() - new Date(createdAt).getTime()
      : null

    // Extract final_price and listing_id from winning offer
    const winningOffer = session.selectedOfferId
      ? session.offers.find((o) => o.offer_id === session.selectedOfferId)
      : null
    const finalPrice = (session.unsignedQuote as Record<string, unknown> | null)?.final_price as string | undefined ?? null

    return c.json({
      rfq_id: rfqId,
      state: session.state,
      rfq: session.rfq,
      offers: session.offers,
      counters: session.counters,
      selected_seller: session.selectedSeller,
      selected_offer_id: session.selectedOfferId,
      unsigned_quote: session.unsignedQuote,
      buyer_signature: session.buyerSignature,
      seller_signature: session.sellerSignature,
      quote_revision: session.quoteRevision,
      commit_pending_at: session.commitPendingAt,
      event_count: config.eventStore.size(rfqId),
      // --- Fields added for god-view completeness ---
      total_offer_count: session.totalOfferCount,
      offer_count_by_seller: Object.fromEntries(session.offerCountBySeller),
      total_accept_attempts: session.totalAcceptAttempts,
      accept_attempts_by_seller: Object.fromEntries(session.acceptAttemptsBySeller),
      last_event_id: session.lastEventId,
      final_price: finalPrice,
      listing_id: winningOffer?.listing_id ?? null,
      payment_endpoint: winningOffer?.payment_endpoint ?? null,
      created_at: createdAt,
      duration_ms: durationMs,
    })
  })

  // --- Session events (JSON or SSE via content negotiation) ---
  app.get("/admin/sessions/:id/events", (c) => {
    const rfqId = c.req.param("id")
    if (!config.sessionManager.hasSession(rfqId)) {
      throw new EngineError(404, "not_found", `Session ${rfqId} not found`)
    }

    const accept = c.req.header("Accept") ?? ""

    // --- JSON mode ---
    if (!accept.includes("text/event-stream")) {
      const events = config.eventStore.getAllEvents(rfqId)
      const session = config.sessionManager.getSession(rfqId)
      return c.json({
        rfq_id: rfqId,
        state: session?.state ?? null,
        events,
      })
    }

    // --- SSE mode with buffer-first broadcaster pattern ---
    // Subscribe FIRST (buffering), read replay, dedupe, activate.
    // Same atomic pattern as participant SSE (subscribeFrom).
    if (adminSseConnections >= MAX_ADMIN_SSE) {
      return c.json({ error: "too_many_connections", message: "Admin SSE at capacity" }, 503)
    }

    adminSseConnections++
    let cleanedUp = false

    // Phase 1: Subscribe to broadcaster in BUFFERING mode BEFORE reading replay.
    // This closes the gap — events arriving during replay go to buffer.
    const buffer: string[] = []
    let mode: "buffering" | "live" | "stopped" = "buffering"

    const unsub = config.broadcaster.subscribeAdmin(rfqId, (serialized) => {
      if (mode === "stopped") return
      if (mode === "buffering") {
        buffer.push(serialized)
        return
      }
      // Live mode — will be wired to stream.send() below
      streamSend?.(serialized)
    })
    let streamSend: ((data: string, id?: string) => boolean) | null = null

    // Phase 2: Read replay from DB + compute per-event state_after
    const replay = config.eventStore.getAllEvents(rfqId)
    const replayWithState: Array<{ event: NegotiationEvent; state_after: string }> = []
    {
      let currentState = "OPEN"
      for (const event of replay) {
        if (event.type === "OFFER_SUBMITTED" && currentState === "OPEN") currentState = "NEGOTIATING"
        else if (event.type === "WINNER_SELECTED") currentState = "COMMIT_PENDING"
        else if (event.type === "QUOTE_COMMITTED") currentState = "COMMITTED"
        else if (event.type === "NEGOTIATION_EXPIRED") currentState = "EXPIRED"
        else if (event.type === "NEGOTIATION_CANCELLED") currentState = "CANCELLED"
        else if (event.type === "COMMIT_PENDING") currentState = "COMMIT_PENDING"
        else if ((event.type === "COSIGN_DECLINED" || event.type === "COSIGN_TIMEOUT") && currentState === "COMMIT_PENDING") currentState = "NEGOTIATING"
        replayWithState.push({ event, state_after: currentState })
      }
    }

    // Phase 3: Deduplicate buffer against replay.
    // Buffer contains pre-serialized strings from broadcaster — extract event_id for dedup.
    const replayIds = new Set(replay.map((e) => e.event_id))
    const dedupedBuffer = buffer.filter((s) => {
      try {
        const parsed = JSON.parse(s) as { event_id?: string }
        return parsed.event_id ? !replayIds.has(parsed.event_id) : true
      } catch { return true }
    })
    const bufferedSnapshot = [...dedupedBuffer]
    buffer.length = 0

    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder()
        let heartbeat: ReturnType<typeof setInterval>

        const cleanup = () => {
          if (cleanedUp) return
          cleanedUp = true
          mode = "stopped"
          clearInterval(heartbeat)
          unsub()
          adminSseConnections--
          try { controller.close() } catch { /* already closed */ }
        }

        const send = (data: string, id?: string): boolean => {
          try {
            let msg = ""
            if (id) msg += `id: ${id}\n`
            msg += `data: ${data}\n\n`
            controller.enqueue(encoder.encode(msg))
            return true
          } catch { cleanup(); return false }
        }
        streamSend = send

        // Send replay events with per-event state_after
        for (const { event, state_after } of replayWithState) {
          if (cleanedUp) break
          if (!send(JSON.stringify({ ...event, state_after }), event.event_id)) break
        }

        // Send deduped buffered events (pre-serialized from broadcaster)
        for (const serialized of bufferedSnapshot) {
          if (cleanedUp) break
          if (!send(serialized)) break
        }

        // Phase 4: Activate — flush post-snapshot buffer, switch to live
        if (!cleanedUp) {
          const toFlush = [...buffer]
          buffer.length = 0
          mode = "live"
          for (const serialized of toFlush) {
            if (cleanedUp) break
            send(serialized)
          }
        }

        // Guard: if cleanup already ran during replay/buffer send, skip timer + listener
        if (cleanedUp) return

        heartbeat = setInterval(() => {
          try { controller.enqueue(encoder.encode(": heartbeat\n\n")) }
          catch { cleanup() }
        }, 15_000)
        if (typeof heartbeat === "object" && "unref" in heartbeat) {
          heartbeat.unref()
        }

        c.req.raw.signal.addEventListener("abort", cleanup)
      },
    })

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    })
  })

  // --- Extended stats ---
  app.get("/admin/stats", (c) => {
    const publicStats = config.statsCollector.getStats()
    return c.json({
      ...publicStats,
      admin: {
        admin_sse_connections: adminSseConnections,
        session_cache_info: "evicted on removeLock + 5min TTL",
      },
    })
  })

  return app
}
