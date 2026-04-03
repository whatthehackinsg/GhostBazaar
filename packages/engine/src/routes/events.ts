/**
 * Events Route — GET /rfqs/:id/events
 *
 * Dual-mode event streaming:
 * - Accept: text/event-stream → SSE streaming
 * - Accept: application/json → JSON polling
 *
 * Authentication: Injectable authenticateCaller (same pattern as quote-read).
 * Participant check: buyer or seller with at least one offer.
 * Cursor: ?after=<event_id> with session-scoped validation.
 */

import { Hono } from "hono"
import type { EngineEnv } from "../app.js"
import type { SessionManager } from "../state/session-manager.js"
import type { EventStore } from "../types.js"
import { EngineError } from "../middleware/error-handler.js"
import type { ConnectionTracker } from "../util/connection-tracker.js"

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface EventsRouteConfig {
  readonly sessionManager: SessionManager
  readonly eventStore: EventStore
  readonly connectionTracker: ConnectionTracker
  readonly authenticateCaller: (req: Request) => Promise<string>
}

// ---------------------------------------------------------------------------
// Participant check — buyer or seller who has submitted at least one offer
// ---------------------------------------------------------------------------

function isParticipant(
  callerDid: string,
  buyerDid: string,
  offers: ReadonlyArray<{ readonly seller: string }>,
): boolean {
  if (callerDid === buyerDid) return true
  return offers.some((o) => o.seller === callerDid)
}

// ---------------------------------------------------------------------------
// Terminal state set — sessions in these states send a terminal SSE event
// ---------------------------------------------------------------------------

const TERMINAL_STATES: ReadonlySet<string> = new Set([
  "COMMITTED",
  "EXPIRED",
  "CANCELLED",
])

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export function createEventsRoute(config: EventsRouteConfig): Hono<EngineEnv> {
  const { sessionManager, eventStore, connectionTracker, authenticateCaller } = config
  const router = new Hono<EngineEnv>()

  router.get("/rfqs/:id/events", async (c) => {
    const rfqId = c.req.param("id")
    const callerDid = await authenticateCaller(c.req.raw)

    // Session must exist
    const session = sessionManager.getSession(rfqId)
    if (!session) {
      throw new EngineError(404, "session_not_found", "RFQ session not found")
    }

    // Caller must be buyer or a seller with at least one recorded offer
    if (!isParticipant(callerDid, session.rfq.buyer, session.offers)) {
      throw new EngineError(401, "unauthorized", "Only participants can access events")
    }

    // Content negotiation
    const accept = c.req.header("Accept") ?? ""
    const isSSE = accept.includes("text/event-stream")

    // Cursor resolution: Last-Event-ID (SSE reconnect) > ?after query param
    const lastEventId = isSSE ? c.req.header("Last-Event-ID") : undefined
    const afterParam = c.req.query("after")
    const cursor = lastEventId ?? afterParam ?? undefined

    // Validate cursor is session-scoped — prevents cross-session cursor injection
    if (cursor !== undefined && !eventStore.hasCursor(rfqId, cursor)) {
      if (isSSE) {
        return new Response(
          `event: error\ndata: ${JSON.stringify({ code: "invalid_cursor" })}\n\n`,
          {
            status: 200,
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            },
          },
        )
      }
      throw new EngineError(400, "invalid_cursor", "Cursor event_id not found in session")
    }

    // -----------------------------------------------------------------------
    // JSON polling mode
    // -----------------------------------------------------------------------

    if (!isSSE) {
      const rfq = { buyer: session.rfq.buyer }
      const events = eventStore.getEvents(rfqId, callerDid, rfq, cursor)
      const lastEvent = events.length > 0 ? events[events.length - 1] : null
      const responseCursor = lastEvent ? lastEvent.event_id : (cursor ?? null)

      return c.json({
        rfq_id: rfqId,
        events,
        cursor: responseCursor,
        cursor_valid: true,
      }, 200)
    }

    // -----------------------------------------------------------------------
    // SSE streaming mode
    // -----------------------------------------------------------------------

    const rfq = { buyer: session.rfq.buyer }
    const isBuyer = callerDid === session.rfq.buyer
    let connectionId: string | null = null

    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder()

        function send(text: string): boolean {
          try {
            controller.enqueue(encoder.encode(text))
            return true
          } catch {
            return false
          }
        }

        function sendEvent(eventId: string, data: string): boolean {
          return send(`id: ${eventId}\nevent: negotiation\ndata: ${data}\n\n`)
        }

        function sendTerminal(state: string): void {
          send(`event: terminal\ndata: ${JSON.stringify({ state })}\n\n`)
        }

        // Acquire connection slot — enforces per-DID and per-session limits
        connectionId = connectionTracker.acquire({
          rfqId,
          callerDid,
          isBuyer,
          close: () => {
            send(`event: error\ndata: ${JSON.stringify({ code: "evicted" })}\n\n`)
            cleanup()
          },
        })

        if (connectionId === null) {
          send(`event: error\ndata: ${JSON.stringify({ code: "connection_limit" })}\n\n`)
          try { controller.close() } catch { /* already closed */ }
          return
        }

        // Atomic replay+subscribe — eliminates the gap between getEvents and subscribe.
        // Wrapped in try/catch to release the connection slot if subscribeFrom or
        // subscribeTerminal throws (Red Team F7: connection slot leak on throw).
        let sub: ReturnType<EventStore["subscribeFrom"]>
        let unsubTerminal: () => void
        try {
          sub = eventStore.subscribeFrom(
            rfqId, callerDid, rfq, cursor,
            (event) => {
              sendEvent(event.event_id, JSON.stringify(event))
            },
          )

          // Terminal state notification — fires once when session ends
          unsubTerminal = eventStore.subscribeTerminal(rfqId, (state) => {
            sendTerminal(state)
            cleanup()
          })
        } catch {
          // Release connection slot on setup failure
          if (connectionId) {
            connectionTracker.release(connectionId)
            connectionId = null
          }
          send(`event: error\ndata: ${JSON.stringify({ code: "internal_error" })}\n\n`)
          try { controller.close() } catch { /* already closed */ }
          return
        }

        // Flush replay events
        for (const event of sub.replay) {
          sendEvent(event.event_id, JSON.stringify(event))
        }

        // Flush buffered events (arrived between subscribe and replay completion)
        for (const event of sub.buffered) {
          sendEvent(event.event_id, JSON.stringify(event))
        }

        // Check if session is already terminal — send terminal event and close
        const currentSession = sessionManager.getSession(rfqId)
        if (currentSession && TERMINAL_STATES.has(currentSession.state)) {
          sendTerminal(currentSession.state)
          sub.unsubscribe()
          unsubTerminal()
          if (connectionId) {
            connectionTracker.release(connectionId)
            connectionId = null
          }
          try { controller.close() } catch { /* already closed */ }
          return
        }

        // Activate live delivery — replay+buffered have been flushed to the stream.
        // activate() will flush any events that arrived between subscribeFrom()
        // return and now, then switch to direct live delivery.
        sub.activate()

        // Heartbeat every 15s — also serves as a connection health check
        const heartbeatInterval = setInterval(() => {
          if (!send(": heartbeat\n\n")) {
            cleanup()
          }
        }, 15_000)
        if (typeof heartbeatInterval === "object" && "unref" in heartbeatInterval) {
          heartbeatInterval.unref()
        }

        // Re-entrancy guard — cleanup can be called from multiple sources
        // (terminal notification, abort signal, heartbeat failure, eviction).
        // The guard ensures resources are released exactly once. (Red Team F1)
        let cleanedUp = false
        function cleanup(): void {
          if (cleanedUp) return
          cleanedUp = true
          clearInterval(heartbeatInterval)
          sub.unsubscribe()
          unsubTerminal()
          if (connectionId) {
            connectionTracker.release(connectionId)
            connectionId = null
          }
          try { controller.close() } catch { /* already closed */ }
        }

        // Client disconnect — clean up resources when the client aborts
        c.req.raw.signal.addEventListener("abort", cleanup)
      },
    })

    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    })
  })

  return router
}
