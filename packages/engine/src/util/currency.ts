import { EngineError } from "../middleware/error-handler.js"

// ---------------------------------------------------------------------------
// Currency-to-Mint resolution per Spec §9 (SPL Token Mint Table)
//
// Maps protocol currency symbols to Solana mint addresses for
// normalizeAmount() calls. Devnet mints used for MVP.
// ---------------------------------------------------------------------------

const CURRENCY_TO_MINT: Record<string, string> = {
  USDC: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", // devnet USDC
}

/**
 * Resolve a protocol currency symbol to a Solana SPL token mint address.
 * Throws EngineError(422) for unsupported currencies.
 */
export function mintFor(currency: string): string {
  const mint = CURRENCY_TO_MINT[currency]
  if (!mint) {
    throw new EngineError(422, "unsupported_currency", `No mint address for currency "${currency}"`)
  }
  return mint
}
