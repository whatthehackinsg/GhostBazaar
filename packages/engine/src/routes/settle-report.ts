/**
 * Settle Report Route — POST /rfqs/:id/settle-report
 *
 * Called by seller's onSettled callback after their own /execute verifies payment.
 * Records the settlement fact in the engine's event store.
 *
 * Auth: Seller only (must be the selected seller for this session).
 * Idempotent: Returns 200 if SETTLEMENT_CONFIRMED already exists.
 */

import { Hono } from "hono"
import type { SessionManager } from "../state/session-manager.js"
import type { InternalEventStore } from "../types.js"
import { verifySettlement, type SettlementRequest } from "@ghost-bazaar/settlement"
import { SettlementError } from "@ghost-bazaar/settlement"

export interface SettleReportRouteConfig {
  readonly sessionManager: SessionManager
  readonly eventStore: InternalEventStore
  readonly rpcUrl: string
  readonly usdcMint: string
  readonly cluster?: "mainnet-beta" | "devnet" | "testnet"
  readonly authenticateCaller: (c: any) => Promise<string>
}

export function createSettleReportRoute(config: SettleReportRouteConfig) {
  const app = new Hono()

  app.post("/rfqs/:id/settle-report", async (c) => {
    const rfqId = c.req.param("id")

    // Authenticate caller (pass raw Request, not Hono context)
    const callerDid = await config.authenticateCaller(c.req.raw)

    // Load session
    const session = config.sessionManager.getSession(rfqId)
    if (!session) {
      return c.json({ error: "session_not_found", message: "No session found for this RFQ" }, 404)
    }

    // Must be COMMITTED
    if (session.state !== "COMMITTED") {
      return c.json({ error: "invalid_state", message: `Session is ${session.state}, expected COMMITTED` }, 409)
    }

    // Must be the selected seller
    if (callerDid !== session.selectedSeller) {
      return c.json({ error: "forbidden", message: "Only the selected seller can report settlement" }, 403)
    }

    // Parse body
    const body = await c.req.json<{ tx_sig: string; quote_id: string }>()
    if (!body.tx_sig || !body.quote_id) {
      return c.json({ error: "bad_request", message: "tx_sig and quote_id are required" }, 400)
    }

    // Verify quote_id matches committed quote
    if (session.unsignedQuote?.quote_id && session.unsignedQuote.quote_id !== body.quote_id) {
      return c.json({ error: "quote_mismatch", message: "quote_id does not match committed quote" }, 422)
    }

    // Build verification request from committed quote
    const quote = session.unsignedQuote
    if (!quote) {
      return c.json({ error: "no_quote", message: "No committed quote found in session" }, 409)
    }

    const quoteWithSigs = {
      ...quote,
      buyer_signature: session.buyerSignature ?? "",
      seller_signature: session.sellerSignature ?? "",
    }

    const quoteB64 = Buffer.from(JSON.stringify(quoteWithSigs)).toString("base64")
    const request: SettlementRequest = {
      quoteHeaderB64: quoteB64,
      paymentSignature: body.tx_sig,
      rpcUrl: config.rpcUrl,
      usdcMint: config.usdcMint,
      cluster: config.cluster,
    }

    try {
      const result = await verifySettlement(request)

      // Idempotency check + append inside withLock to prevent duplicate events
      const verifiedAt = new Date().toISOString()
      await config.sessionManager.withLock(rfqId, async () => {
        const existingEvents = config.eventStore.getAllEvents(rfqId)
        const alreadySettled = existingEvents.some(e => e.type === "SETTLEMENT_CONFIRMED")
        if (alreadySettled) return

        config.sessionManager.appendEvent(rfqId, {
          event_id: crypto.randomUUID(),
          rfq_id: rfqId,
          type: "SETTLEMENT_CONFIRMED",
          timestamp: verifiedAt,
          actor: "system:settlement-verifier",
          payload: {
            tx_sig: result.tx_sig,
            quote_id: body.quote_id,
            final_price: result.quote.final_price,
            buyer: result.quote.buyer,
            seller: result.quote.seller,
            verified_at: verifiedAt,
            verification: result.verification,
          },
        })
      })

      return c.json({ settled: true, tx_sig: result.tx_sig, verified_at: verifiedAt })
    } catch (err: unknown) {
      if (err instanceof SettlementError) {
        const status = err.httpStatus >= 400 && err.httpStatus < 500 ? err.httpStatus as 400 : 422
        return c.json({ error: err.code, message: err.message }, status)
      }
      return c.json({ error: "verification_failed", message: "On-chain settlement verification failed" }, 422)
    }
  })

  return app
}
