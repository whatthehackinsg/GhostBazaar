/**
 * Dashboard Routes — Public API for community traffic display.
 *
 * All routes are unauthenticated. Data is anonymized aggregates only.
 * No DIDs, no prices, no session IDs, no event payloads.
 *
 * Endpoints:
 *   GET /dashboard/stats          — aggregate metrics
 *   GET /dashboard/activity       — per-minute event rate
 *   GET /dashboard/feed           — anonymized live event stream (SSE)
 *   GET /dashboard/privacy        — educational: buyer vs seller visibility
 *   GET /dashboard/comparison     — protocol comparison table
 */

import { Hono } from "hono"
import type { EngineEnv } from "../app.js"
import type { StatsCollector } from "../stats/stats-collector.js"
import type { EventBroadcaster } from "../stats/event-broadcaster.js"
import type { InternalEventStore } from "../types.js"
import type { SessionManager } from "../state/session-manager.js"

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface DashboardRouteConfig {
  readonly statsCollector: StatsCollector
  readonly broadcaster: EventBroadcaster
  readonly eventStore: InternalEventStore
  readonly sessionManager: SessionManager
}

const MAX_PUBLIC_FEED = 100
let publicFeedConnections = 0

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export function createDashboardRoute(config: DashboardRouteConfig) {
  const app = new Hono<EngineEnv>()

  // --- Aggregate stats ---
  app.get("/dashboard/stats", (c) => {
    return c.json(config.statsCollector.getStats())
  })

  // --- Per-minute activity pulse ---
  app.get("/dashboard/activity", (c) => {
    return c.json(config.statsCollector.getActivity())
  })

  // --- Anonymized live event feed (SSE) ---
  app.get("/dashboard/feed", (c) => {
    if (publicFeedConnections >= MAX_PUBLIC_FEED) {
      return c.json({ error: "too_many_connections", message: "Feed at capacity, try again later" }, 503)
    }

    publicFeedConnections++
    let cleanedUp = false

    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder()
        let heartbeat: ReturnType<typeof setInterval>
        let unsub: () => void

        const cleanup = () => {
          if (cleanedUp) return
          cleanedUp = true
          clearInterval(heartbeat)
          unsub?.()
          publicFeedConnections--
          try { controller.close() } catch { /* already closed */ }
        }

        const send = (data: string): boolean => {
          try { controller.enqueue(encoder.encode(`data: ${data}\n\n`)); return true }
          catch { cleanup(); return false }
        }

        heartbeat = setInterval(() => {
          try { controller.enqueue(encoder.encode(": heartbeat\n\n")) }
          catch { cleanup() }
        }, 15_000)
        if (typeof heartbeat === "object" && "unref" in heartbeat) {
          heartbeat.unref()
        }

        // Subscribe to broadcaster — receives pre-serialized anonymized strings
        // (1x stringify in broadcaster, not per-connection)
        unsub = config.broadcaster.subscribePublic((serialized) => {
          send(serialized)
        })

        // Cleanup on client disconnect
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

  // --- Recent feed events (historical replay, anonymized) ---
  // Returns the most recent N anonymized events so the LiveFeed has
  // content immediately on page load, not just after new events arrive.
  const RECENT_FEED_DEFAULT = 20
  const RECENT_FEED_MAX = 100

  app.get("/dashboard/feed/recent", (c) => {
    const limitParam = c.req.query("limit")
    const limit = limitParam !== undefined
      ? Math.min(Math.max(1, Number(limitParam) || RECENT_FEED_DEFAULT), RECENT_FEED_MAX)
      : RECENT_FEED_DEFAULT

    // Collect all events across all sessions, anonymize, sort by time desc
    const allSessionIds = config.sessionManager.getActiveSessionIds()

    const anonymized: Array<{
      type: string
      actor_role: string
      state_after: string
      timestamp: string
    }> = []

    for (const rfqId of allSessionIds) {
      const session = config.sessionManager.getSession(rfqId)
      if (!session) continue

      const events = config.eventStore.getAllEvents(rfqId)
      // Walk events to derive state_after per event (same as admin SSE replay)
      let currentState = "OPEN"
      for (const event of events) {
        if (event.type === "OFFER_SUBMITTED" && currentState === "OPEN") currentState = "NEGOTIATING"
        else if (event.type === "WINNER_SELECTED") currentState = "COMMIT_PENDING"
        else if (event.type === "QUOTE_COMMITTED") currentState = "COMMITTED"
        else if (event.type === "NEGOTIATION_EXPIRED") currentState = "EXPIRED"
        else if (event.type === "NEGOTIATION_CANCELLED") currentState = "CANCELLED"
        else if ((event.type === "COSIGN_DECLINED" || event.type === "COSIGN_TIMEOUT") && currentState === "COMMIT_PENDING") currentState = "NEGOTIATING"

        const role = event.actor === session.rfq.buyer
          ? "buyer"
          : event.actor.startsWith("engine/")
            ? "system"
            : "seller"

        anonymized.push({
          type: event.type,
          actor_role: role,
          state_after: currentState,
          timestamp: event.timestamp,
        })
      }
    }

    // Sort newest first, take top N
    anonymized.sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    const recent = anonymized.slice(0, limit)

    return c.json({ events: recent, total: anonymized.length })
  })

  // --- Privacy explainer (static educational content) ---
  app.get("/dashboard/privacy", (c) => {
    return c.json({
      buyer_sees: [
        "All offers from all sellers (information advantage)",
        "All counter-offers they sent",
        "Selected winner + dual-signed quote",
        "Terminal events (expired, cancelled, committed)",
      ],
      seller_sees: [
        "The RFQ (service request + deadline)",
        "Only their own offers",
        "Only counters addressed to them",
        "Winner notification (only if they won)",
        "Terminal events (expired, cancelled)",
      ],
      seller_never_sees: [
        "Other sellers' offers or prices",
        "Other sellers' identities",
        "Buyer's budget (protected by ZK proof)",
        "How many other sellers are competing",
      ],
      zk_proof_protects: [
        "budget_hard — buyer's maximum willingness to pay",
        "Groth16 proof verifies counter_price <= budget_hard without revealing budget_hard",
        "Poseidon commitment in RFQ binds the budget without exposing it",
      ],
    })
  })

  // --- Protocol comparison table (static) ---
  app.get("/dashboard/comparison", (c) => {
    return c.json({
      protocols: [
        {
          name: "Ghost Bazaar",
          negotiation: "Structured RFQ/offer/counter/quote",
          multi_seller: true,
          budget_privacy: "ZK (Groth16)",
          privacy_score: "83%",
          settlement: "Solana SPL",
        },
        {
          name: "x402",
          negotiation: "None (fixed price)",
          multi_seller: false,
          budget_privacy: "N/A",
          privacy_score: "0%",
          settlement: "On-chain",
        },
        {
          name: "Virtuals ACP",
          negotiation: "Partial",
          multi_seller: false,
          budget_privacy: "None",
          privacy_score: "0%",
          settlement: "Native on-chain",
        },
        {
          name: "Google A2A",
          negotiation: "None",
          multi_seller: false,
          budget_privacy: "N/A",
          privacy_score: "0%",
          settlement: "None",
        },
      ],
    })
  })

  return app
}
