import { Hono } from "hono"
import { validateRfq, normalizeAmount } from "@ghost-bazaar/core"
import type { EngineEnv } from "../app.js"
import type { SessionManager } from "../state/session-manager.js"
import { EngineError } from "../middleware/error-handler.js"
import {
  preCheckSignatureFormat,
  verifySignature,
} from "../middleware/validate-signature.js"
import { mintFor } from "../util/currency.js"
import { SessionState } from "../types.js"

// ---------------------------------------------------------------------------
// Engine-level validation helpers (supplements core's validateRfq)
// ---------------------------------------------------------------------------

const MAX_SPEC_SIZE = 8192
const MAX_EXTENSIONS_SIZE = 4096

/** Validate spec and extensions are plain objects with bounded size. */
function validateSpecAndExtensions(body: Record<string, unknown>): void {
  // spec must be a plain object
  if (typeof body.spec !== "object" || body.spec === null || Array.isArray(body.spec)) {
    throw new EngineError(400, "malformed_payload", "spec must be a plain object")
  }
  if (JSON.stringify(body.spec).length > MAX_SPEC_SIZE) {
    throw new EngineError(400, "malformed_payload", `spec exceeds ${MAX_SPEC_SIZE} bytes`)
  }
  // extensions (if present) must be a plain object
  if (body.extensions !== undefined) {
    if (typeof body.extensions !== "object" || body.extensions === null || Array.isArray(body.extensions)) {
      throw new EngineError(400, "malformed_payload", "extensions must be a plain object")
    }
    if (JSON.stringify(body.extensions).length > MAX_EXTENSIONS_SIZE) {
      throw new EngineError(400, "malformed_payload", `extensions exceeds ${MAX_EXTENSIONS_SIZE} bytes`)
    }
  }
}

/** Extract only known RFQ fields for signature verification. */
function extractRfqFields(body: Record<string, unknown>): Record<string, unknown> {
  const rfq: Record<string, unknown> = {
    rfq_id: body.rfq_id,
    protocol: body.protocol,
    buyer: body.buyer,
    service_type: body.service_type,
    spec: body.spec,
    anchor_price: body.anchor_price,
    currency: body.currency,
    deadline: body.deadline,
    signature: body.signature,
  }
  if (body.budget_commitment !== undefined) {
    rfq.budget_commitment = body.budget_commitment
  }
  if (body.extensions !== undefined) {
    rfq.extensions = body.extensions
  }
  return rfq
}

// ---------------------------------------------------------------------------
// Pagination defaults
// ---------------------------------------------------------------------------

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

/** Valid states for the ?state filter. */
const VALID_STATES = new Set(Object.values(SessionState))

// ---------------------------------------------------------------------------
// GET /rfqs rate limiter — per-IP sliding window
//
// Public unauthenticated endpoint that does O(n) work per request.
// Rate limit prevents DoS amplification.
// ---------------------------------------------------------------------------

const GET_RFQS_WINDOW_MS = 60_000
const GET_RFQS_MAX_PER_IP = 60

const getRfqsRateByIp = new Map<string, { count: number; windowStart: number }>()

function checkGetRfqsRateLimit(ip: string): boolean {
  const now = Date.now()
  const entry = getRfqsRateByIp.get(ip)

  if (!entry || now - entry.windowStart > GET_RFQS_WINDOW_MS) {
    getRfqsRateByIp.set(ip, { count: 1, windowStart: now })
    return true
  }

  if (entry.count >= GET_RFQS_MAX_PER_IP) return false
  entry.count++

  // Periodic eviction — prevent unbounded growth
  if (getRfqsRateByIp.size > 2000) {
    for (const [k, v] of getRfqsRateByIp) {
      if (now - v.windowStart > GET_RFQS_WINDOW_MS) getRfqsRateByIp.delete(k)
    }
  }

  return true
}

// ---------------------------------------------------------------------------
// RFQ Route — POST /rfqs
//
// 9-step RFQ submission verification per Spec §8:
// 1. Parse + validate body via validateRfq() → 400 malformed_payload
// 2. Protocol version check (inside validateRfq)
// 3. Deadline future check (inside validateRfq)
// 4. Pre-check signature format (step 0 DoS filter)
// 5. Full Ed25519 signature verification → 401 invalid_buyer_signature
// 6. Check rfq_id not already in use → 409 duplicate_object_id
// 7. Create session via withLock + appendEvent(RFQ_CREATED)
// 8. Return 201
//
// NOTE: Spec order puts field validation before signature verification.
// validateRfq() covers steps 1-3, then signature verification runs,
// then session creation. This prevents unauthenticated actors from
// creating sessions.
// ---------------------------------------------------------------------------

export function createRfqRoute(sessionManager: SessionManager): Hono<EngineEnv> {
  const router = new Hono<EngineEnv>()

  router.post("/rfqs", async (c) => {
    // Step 1-3: Parse and validate RFQ schema (protocol, deadline, currency, etc.)
    let body: Record<string, unknown>
    try {
      body = await c.req.json()
    } catch {
      throw new EngineError(400, "malformed_payload", "Invalid JSON body")
    }
    const validation = validateRfq(body)
    if (!validation.ok) {
      // Map Spec error codes to correct HTTP status codes
      const status = validation.code === "invalid_amount" || validation.code === "invalid_deadline"
        || validation.code === "currency_mismatch" || validation.code === "unsupported_currency"
        || validation.code === "invalid_budget_commitment_format"
        ? 422 : 400
      throw new EngineError(status, validation.code, `RFQ validation failed: ${validation.code}`)
    }

    // Engine-level validation: spec and extensions must be plain objects with bounded size
    validateSpecAndExtensions(body)

    // After validateRfq passes, all required fields are present and typed.
    // Cast to typed accessors for the rest of the handler.
    const rfq = body as {
      rfq_id: string; protocol: string; buyer: string; service_type: string
      spec: Record<string, unknown>; anchor_price: string; currency: string
      deadline: string; signature: string; budget_commitment?: string
      extensions?: Record<string, unknown>
    }

    // Minimum normalized amount check — prevents zero-payment exploits
    // where a valid-looking decimal truncates to zero on-chain (plan line 229-233)
    const mint = mintFor(rfq.currency)
    if (normalizeAmount(rfq.anchor_price, mint) <= 0n) {
      throw new EngineError(422, "invalid_amount", "anchor_price normalizes to zero")
    }

    // Step 4: Pre-check signature format (~0.1ms DoS filter)
    preCheckSignatureFormat(rfq.signature, rfq.buyer)

    // Step 5: Full Ed25519 signature verification
    // Build a clean object with only known fields for verification —
    // extra fields in body would change the signing payload and cause false rejections
    const rfqForSig = extractRfqFields(body)
    await verifySignature(rfqForSig, rfq.signature, rfq.buyer, "invalid_buyer_signature")

    // Step 6: Check rfq_id not already in use
    if (sessionManager.hasSession(rfq.rfq_id)) {
      throw new EngineError(409, "duplicate_object_id", `RFQ ${rfq.rfq_id} already exists`)
    }

    // Step 7: Create session — append RFQ_CREATED event
    const session = await sessionManager.withLock(rfq.rfq_id, async () => {
      // Double-check inside lock (another request might have created it)
      if (sessionManager.hasSession(rfq.rfq_id)) {
        throw new EngineError(409, "duplicate_object_id", `RFQ ${rfq.rfq_id} already exists`)
      }

      return sessionManager.appendEvent(rfq.rfq_id, {
        event_id: crypto.randomUUID(),
        rfq_id: rfq.rfq_id,
        type: "RFQ_CREATED",
        timestamp: new Date().toISOString(),
        actor: rfq.buyer,
        payload: {
          rfq_id: rfq.rfq_id,
          protocol: rfq.protocol,
          buyer: rfq.buyer,
          service_type: rfq.service_type,
          spec: rfq.spec,
          anchor_price: rfq.anchor_price,
          currency: rfq.currency,
          deadline: rfq.deadline,
          signature: rfq.signature,
          ...(rfq.budget_commitment !== undefined
            ? { budget_commitment: rfq.budget_commitment }
            : {}),
          ...(rfq.extensions !== undefined
            ? { extensions: rfq.extensions }
            : {}),
        },
      })
    })

    // Step 8: Return 201 with session info
    return c.json(
      {
        rfq_id: rfq.rfq_id,
        state: session.state,
        buyer: session.rfq.buyer,
        service_type: session.rfq.service_type,
        anchor_price: session.rfq.anchor_price,
        currency: session.rfq.currency,
        deadline: session.rfq.deadline,
      },
      201,
    )
  })

  // -------------------------------------------------------------------------
  // GET /rfqs — list RFQs with optional filters
  //
  // Public endpoint (no auth). Returns minimal metadata — no budget_commitment,
  // spec, or negotiation details. Sensitive fields live behind per-session
  // auth on GET /rfqs/:id/events.
  //
  // NOTE: buyer DID and anchor_price are intentionally public here — consistent
  // with GET /listings being public. RFQ existence and pricing intent are not
  // secrets; negotiation details (counters, budget_commitment) are protected
  // behind per-session Ed25519 auth on GET /rfqs/:id/events.
  //
  // Default behavior: returns only non-terminal RFQs (OPEN, NEGOTIATING,
  // COMMIT_PENDING) for seller discovery. Pass ?state=COMMITTED etc. to
  // include terminal states, or ?include_terminal=true for all.
  //
  // Results are sorted by deadline ascending (nearest deadline first),
  // then by rfq_id for deterministic pagination.
  //
  // Query params:
  //   ?service_type=X        — filter by RFQ service type (seller discovery)
  //   ?state=OPEN            — filter by exact session state
  //   ?buyer=did:key:…       — filter by buyer DID
  //   ?include_terminal=true — include COMMITTED/EXPIRED/CANCELLED
  //   ?limit=50              — page size (max 200, must be positive integer)
  //   ?offset=0              — pagination offset (must be non-negative integer)
  // -------------------------------------------------------------------------

  router.get("/rfqs", (c) => {
    // Rate limit: 60 req/min per IP (unauthenticated + O(n) work)
    const clientIp = c.req.header("x-forwarded-for")?.split(",")[0]?.trim()
      ?? c.req.header("x-real-ip")
      ?? "unknown"
    if (!checkGetRfqsRateLimit(clientIp)) {
      throw new EngineError(429, "rate_limited", "Too many requests — try again later")
    }

    const serviceType = c.req.query("service_type")
    const stateFilter = c.req.query("state")?.toUpperCase()
    const buyer = c.req.query("buyer")
    const includeTerminal = c.req.query("include_terminal") === "true"
    const limitParam = c.req.query("limit")
    const offsetParam = c.req.query("offset")

    // Validate state filter
    if (stateFilter !== undefined && !VALID_STATES.has(stateFilter as SessionState)) {
      throw new EngineError(
        400,
        "invalid_state",
        `Invalid state "${stateFilter}". Valid: ${[...VALID_STATES].join(", ")}`,
      )
    }

    // Strict integer parsing for pagination params
    let limit = DEFAULT_LIMIT
    if (limitParam !== undefined) {
      if (!/^[1-9]\d*$/.test(limitParam)) {
        throw new EngineError(400, "invalid_param", "limit must be a positive integer")
      }
      limit = Math.min(Number(limitParam), MAX_LIMIT)
    }

    let offset = 0
    if (offsetParam !== undefined) {
      if (!/^\d+$/.test(offsetParam)) {
        throw new EngineError(400, "invalid_param", "offset must be a non-negative integer")
      }
      offset = Number(offsetParam)
    }

    // Terminal states excluded by default (seller discovery use case)
    const terminalStates: ReadonlySet<string> = new Set([
      SessionState.COMMITTED,
      SessionState.EXPIRED,
      SessionState.CANCELLED,
    ])

    // Iterate sessions and collect matching RFQ summaries
    const rfqIds = sessionManager.getActiveSessionIds()
    const matched: Array<{
      rfq_id: string
      buyer: string
      service_type: string
      anchor_price: string
      currency: string
      deadline: string
      state: string
      offer_count: number
    }> = []

    for (const rfqId of rfqIds) {
      const session = sessionManager.getSession(rfqId)
      if (!session) continue

      // Exclude terminal states unless explicitly requested
      if (!includeTerminal && !stateFilter && terminalStates.has(session.state)) continue

      // Apply filters
      if (serviceType && session.rfq.service_type !== serviceType) continue
      if (stateFilter && session.state !== stateFilter) continue
      if (buyer && session.rfq.buyer !== buyer) continue

      matched.push({
        rfq_id: session.rfq.rfq_id,
        buyer: session.rfq.buyer,
        service_type: session.rfq.service_type,
        anchor_price: session.rfq.anchor_price,
        currency: session.rfq.currency,
        deadline: session.rfq.deadline,
        state: session.state,
        offer_count: session.totalOfferCount,
      })
    }

    // Sort by deadline ascending (nearest first), then rfq_id for deterministic pagination
    matched.sort((a, b) =>
      a.deadline.localeCompare(b.deadline) || a.rfq_id.localeCompare(b.rfq_id),
    )

    // Paginate
    const page = matched.slice(offset, offset + limit)

    return c.json({
      rfqs: page,
      total: matched.length,
      limit,
      offset,
    })
  })

  return router
}
