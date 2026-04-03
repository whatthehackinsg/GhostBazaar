import type { MiddlewareHandler } from "hono"
import type { EngineEnv } from "../app.js"
import type { SessionState } from "../types.js"
import { EngineError } from "./error-handler.js"

// ---------------------------------------------------------------------------
// requireState middleware factory
//
// Creates a middleware that checks the current session's state against
// a set of allowed states. If the state does not match, returns 409.
//
// Usage in route: app.post("/rfqs/:id/offers", requireState("OPEN", "NEGOTIATING"), handler)
//
// NOTE: Per Spec §8 data flow, signature verification runs BEFORE state
// guard in route handlers. This middleware is used INSIDE the withLock
// callback after the session is derived, not as top-level Hono middleware.
// It is exported as a helper function, not a Hono middleware, because
// the session state is only available inside the lock context.
// ---------------------------------------------------------------------------

/**
 * Hono middleware factory that validates session state.
 * Reads session from c.get("session") and throws EngineError(409) if
 * the state does not match any of the allowed states.
 *
 * Use this for routes where session is already set in Hono context.
 * For use inside withLock callbacks (no Hono context), use assertState() instead.
 */
export function requireState(
  ...allowedStates: SessionState[]
): MiddlewareHandler<EngineEnv> {
  const allowed = new Set(allowedStates)
  return async (c, next) => {
    const session = c.get("session")
    if (!session) {
      throw new EngineError(404, "session_not_found", "RFQ session not found")
    }
    if (!allowed.has(session.state)) {
      // SECURITY: Do not reveal actual session state — authenticated but
      // unauthorized actors (e.g., competing sellers) should not learn state.
      throw new EngineError(
        409,
        "invalid_state_transition",
        "Operation not allowed in current session state",
      )
    }
    await next()
  }
}

/**
 * Standalone state check function — for use inside withLock callbacks
 * where Hono middleware context is not available.
 */
export function assertState(
  currentState: SessionState,
  ...allowedStates: SessionState[]
): void {
  const allowed = new Set(allowedStates)
  if (!allowed.has(currentState)) {
    throw new EngineError(
      409,
      "invalid_state_transition",
      "Operation not allowed in current session state",
    )
  }
}
