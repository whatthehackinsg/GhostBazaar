/**
 * HTTP handler for POST /execute — the settlement endpoint.
 *
 * Runs on the seller's server. Accepts Payment-Signature and
 * X-Ghost-Bazaar-Quote headers, runs 17-step validation, executes
 * the service, and returns a deal receipt.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "http"
import { verifyAndExecute, type ServiceExecutor, type SettlementRequest } from "./execute.js"
import { SettlementError } from "./errors.js"
import type { SettlementResponse } from "./receipt.js"
import type { SignedQuote } from "@ghost-bazaar/core"

export interface SettlementServerConfig {
  rpcUrl: string
  usdcMint: string
  cluster?: "mainnet-beta" | "devnet" | "testnet"
  port?: number
  /** The service executor — called at step 16 after all validation passes. */
  executor: ServiceExecutor
  /**
   * Optional callback fired after successful settlement.
   * Use this to wire post-settlement actions like 8004 registry feedback
   * and marking agent sessions as settled.
   */
  onSettled?: (quote: SignedQuote, result: SettlementResponse) => void | Promise<void>
}

/**
 * Handle a single settlement HTTP request.
 * Can be used standalone or mounted into an existing HTTP framework.
 */
export async function handleSettlementRequest(
  req: IncomingMessage,
  res: ServerResponse,
  config: SettlementServerConfig,
): Promise<void> {
  // Only accept POST
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ error: "method_not_allowed" }))
    return
  }

  const quoteHeader = req.headers["x-ghost-bazaar-quote"]
  const paymentSig = req.headers["payment-signature"]

  if (!quoteHeader || typeof quoteHeader !== "string") {
    res.writeHead(400, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ error: "malformed_quote_header", message: "X-Ghost-Bazaar-Quote header required" }))
    return
  }

  if (!paymentSig || typeof paymentSig !== "string") {
    res.writeHead(400, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ error: "invalid_payment_signature", message: "Payment-Signature header required" }))
    return
  }

  const request: SettlementRequest = {
    quoteHeaderB64: quoteHeader,
    paymentSignature: paymentSig,
    rpcUrl: config.rpcUrl,
    usdcMint: config.usdcMint,
    cluster: config.cluster,
  }

  try {
    const result = await verifyAndExecute(request, config.executor)

    // Fire post-settlement hook (registry feedback, agent state, etc.)
    if (config.onSettled) {
      const quote = JSON.parse(Buffer.from(quoteHeader, "base64").toString("utf-8"))
      // Best-effort — don't fail the response if hook throws
      try { await config.onSettled(quote, result) } catch { /* noop */ }
    }

    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify(result))
  } catch (err) {
    if (err instanceof SettlementError) {
      res.writeHead(err.httpStatus, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: err.code, message: err.message }))
    } else {
      res.writeHead(500, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: "internal_error", message: "Unexpected server error" }))
    }
  }
}

/**
 * Create a standalone settlement HTTP server.
 * Listens on the given port and handles POST /execute requests.
 */
export function createSettlementServer(config: SettlementServerConfig) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost`)
    if (url.pathname === "/execute" && req.method === "POST") {
      await handleSettlementRequest(req, res, config)
    } else {
      res.writeHead(404, { "Content-Type": "application/json" })
      res.end(JSON.stringify({ error: "not_found" }))
    }
  })

  const port = config.port ?? 3002
  return {
    listen: () =>
      new Promise<void>((resolve) => {
        server.listen(port, () => resolve())
      }),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
      }),
    server,
    port,
  }
}
