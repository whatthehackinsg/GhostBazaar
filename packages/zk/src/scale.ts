import { normalizeAmount } from "@ghost-bazaar/core"

// Default USDC mint for ZK scaling (devnet, 6 decimals)
const DEFAULT_USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"
const USDC_DECIMALS = 6
const MIN_DECIMAL_PLACES = 2

export function scalePrice(decimalStr: string, mint?: string): bigint {
  return normalizeAmount(decimalStr, mint ?? DEFAULT_USDC_MINT)
}

export function unscalePrice(scaled: bigint): string {
  const str = scaled.toString().padStart(USDC_DECIMALS + 1, "0")
  const intPart = str.slice(0, -USDC_DECIMALS) || "0"
  const fracRaw = str.slice(-USDC_DECIMALS)
  // Keep at least MIN_DECIMAL_PLACES, only strip trailing zeros beyond that
  const trimmed = fracRaw.slice(0, MIN_DECIMAL_PLACES) + fracRaw.slice(MIN_DECIMAL_PLACES).replace(/0+$/, "")
  return `${intPart}.${trimmed}`
}
