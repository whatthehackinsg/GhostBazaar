import { Hono } from "hono"
import type { DerivedSession } from "./state/session.js"
import type { SessionManager } from "./state/session-manager.js"
import type { EventStore } from "./types.js"
import { onEngineError } from "./middleware/error-handler.js"

// ---------------------------------------------------------------------------
// EngineEnv — Hono environment type for the engine
//
// Defines the variables available in route handlers via c.get()/c.set().
// ---------------------------------------------------------------------------

export type EngineEnv = {
  Variables: {
    /** Current session state — set by withLock before route logic runs */
    session: DerivedSession | null
    /** The rfqId from the route parameter */
    rfqId: string
    /** Caller DID extracted from request authentication */
    callerDid: string
  }
  Bindings: {
    sessionManager: SessionManager
    /** Public EventStore — route handlers only see role-scoped reads.
     *  InternalEventStore (with getAllEvents) stays inside SessionManager. */
    eventStore: EventStore
  }
}

// ---------------------------------------------------------------------------
// createApp — Hono app factory
//
// Creates the base Hono app with global error handler.
// Route modules are registered separately via app.route().
// ---------------------------------------------------------------------------

export function createApp(): Hono<EngineEnv> {
  const app = new Hono<EngineEnv>()

  // Global error handler — catches all errors and returns uniform JSON
  app.onError(onEngineError)

  return app
}
