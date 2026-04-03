/**
 * Execute Route — POST /execute
 *
 * Engine-hosted settlement verification endpoint.
 * Active when a listing's payment_endpoint points to the engine URL.
 *
 * Flow:
 * 1. Buyer sends USDC on-chain (Solana SPL Transfer)
 * 2. Buyer POSTs here with X-Ghost-Bazaar-Quote + Payment-Signature headers
 * 3. Engine calls verifySettlement() — pure on-chain verification (no nonce, no expiry check)
 * 4. On success, appends SETTLEMENT_CONFIRMED audit event (self-loop on COMMITTED)
 * 5. Returns standard SettlementResponse + delivery_status: "pending_seller"
 *
 * This is a supported deployment mode where the engine acts as the default
 * settlement verifier. Sellers running their own /execute server use the
 * /settle-report callback instead.
 */

import { Hono } from "hono"
import type { SessionManager } from "../state/session-manager.js"
import type { InternalEventStore } from "../types.js"
import {
  verifySettlement,
  type SettlementRequest,
} from "@ghost-bazaar/settlement"
import { SettlementError } from "@ghost-bazaar/settlement"

export interface ExecuteRouteConfig {
  readonly sessionManager: SessionManager
  readonly eventStore: InternalEventStore
  readonly rpcUrl: string
  readonly usdcMint: string
  readonly cluster?: "mainnet-beta" | "devnet" | "testnet"
}

export function createExecuteRoute(config: ExecuteRouteConfig) {
  const app = new Hono()

  app.post("/execute", async (c) => {
    const quoteHeaderB64 = c.req.header("X-Ghost-Bazaar-Quote")
    const paymentSignature = c.req.header("Payment-Signature")

    if (!quoteHeaderB64 || typeof quoteHeaderB64 !== "string") {
      return c.json({ error: "malformed_quote_header", message: "X-Ghost-Bazaar-Quote header required" }, 400)
    }

    if (!paymentSignature || typeof paymentSignature !== "string") {
      return c.json({ error: "invalid_payment_signature", message: "Payment-Signature header required" }, 400)
    }

    const request: SettlementRequest = {
      quoteHeaderB64,
      paymentSignature,
      rpcUrl: config.rpcUrl,
      usdcMint: config.usdcMint,
      cluster: config.cluster,
    }

    try {
      const result = await verifySettlement(request)

      // Load session and verify quote binding
      const rfqId = result.quote.rfq_id
      const session = config.sessionManager.getSession(rfqId)

      if (!session) {
        return c.json({ error: "session_not_found", message: "No session found for this RFQ" }, 404)
      }

      if (session.state !== "COMMITTED") {
        return c.json({ error: "invalid_state", message: `Session is ${session.state}, expected COMMITTED` }, 409)
      }

      // Verify quote_id matches the committed quote
      if (session.unsignedQuote?.quote_id && session.unsignedQuote.quote_id !== result.quote.quote_id) {
        return c.json({ error: "quote_mismatch", message: "quote_id does not match committed quote" }, 422)
      }

      // Idempotency check + append inside withLock to prevent duplicate events under concurrency
      await config.sessionManager.withLock(rfqId, async () => {
        const existingEvents = config.eventStore.getAllEvents(rfqId)
        const alreadySettled = existingEvents.some(e => e.type === "SETTLEMENT_CONFIRMED")
        if (!alreadySettled) {
          config.sessionManager.appendEvent(rfqId, {
            event_id: crypto.randomUUID(),
            rfq_id: rfqId,
            type: "SETTLEMENT_CONFIRMED",
            timestamp: new Date().toISOString(),
            actor: "system:settlement-verifier",
            payload: {
              tx_sig: result.tx_sig,
              quote_id: result.quote.quote_id,
              final_price: result.quote.final_price,
              buyer: result.quote.buyer,
              seller: result.quote.seller,
              verified_at: new Date().toISOString(),
              verification: result.verification,
            },
          })
        }
      })

      // Resolve DIDs to Solana pubkeys for receipt compatibility
      const { didToPublicKey } = await import("@ghost-bazaar/core")
      const buyerPk = didToPublicKey(result.quote.buyer)
      const sellerPk = didToPublicKey(result.quote.seller)

      return c.json({
        receipt: {
          quote_id: result.quote.quote_id,
          final_price: result.quote.final_price,
          buyer_pubkey: buyerPk?.toBase58() ?? result.quote.buyer,
          seller_pubkey: sellerPk?.toBase58() ?? result.quote.seller,
          settled_at: new Date().toISOString(),
        },
        explorer_tx: result.verification.solana_explorer,
        settlement_ms: 0,
        delivery_status: "pending_seller",
      })
    } catch (err: unknown) {
      if (err instanceof SettlementError) {
        const status = err.httpStatus >= 400 && err.httpStatus < 500 ? err.httpStatus as 400 : 422
        return c.json({ error: err.code, message: err.message }, status)
      }
      return c.json({ error: "internal_error", message: "Unexpected settlement verification error" }, 500)
    }
  })

  return app
}
