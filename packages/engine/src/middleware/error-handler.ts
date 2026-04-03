import type { ErrorHandler } from "hono"
import type { EngineEnv } from "../app.js"

// ---------------------------------------------------------------------------
// EngineError — typed error with HTTP status and error code
// ---------------------------------------------------------------------------

export class EngineError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = "EngineError"
  }
}

// ---------------------------------------------------------------------------
// errorHandler — Hono onError handler for uniform JSON error responses
//
// Response format: { error: string, message: string }
// SECURITY: Never includes stack traces, internal state, or private values.
// ---------------------------------------------------------------------------

export const onEngineError: ErrorHandler<EngineEnv> = (err, c) => {
  if (err instanceof EngineError) {
    return c.json(
      { error: err.code, message: err.message },
      err.status as 400,
    )
  }

  // Generic error — extract status/code if present, default to 500
  const errObj = err as unknown as Record<string, unknown>
  const status =
    typeof errObj.status === "number"
      ? (errObj.status as 400)
      : (500 as const)
  const code =
    typeof errObj.code === "string" ? errObj.code : "internal_error"
  // SECURITY: For 500 errors, never return the raw message — it may contain
  // stack fragments, file paths, or private state from dependencies.
  const message =
    status === 500
      ? "Internal server error"
      : err instanceof Error
        ? err.message
        : "Internal server error"

  return c.json({ error: code, message }, status)
}
