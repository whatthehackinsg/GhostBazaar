import Decimal from "decimal.js"
import { sha256 } from "@noble/hashes/sha256"
import { canonicalJson } from "./canonical.js"

// Mint → decimals lookup. USDC is always 6 decimals.
const MINT_DECIMALS: Record<string, number> = {
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": 6, // mainnet USDC
  "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU": 6, // devnet USDC
}

/**
 * Convert decimal string to integer micro-units using mint's decimal count.
 * Uses integer arithmetic on the decimal string — never parseFloat.
 */
export function normalizeAmount(decimalStr: string, mintAddress: string): bigint {
  const decimals = MINT_DECIMALS[mintAddress]
  if (decimals === undefined) {
    throw new Error(`Unknown mint address: "${mintAddress}". Register it with registerMint() first.`)
  }
  return normalizeWithDecimals(decimalStr, decimals)
}

function normalizeWithDecimals(decimalStr: string, decimals: number): bigint {
  if (!/^\d+(\.\d+)?$/.test(decimalStr)) {
    throw new Error(`Invalid decimal string: "${decimalStr}"`)
  }
  const parts = decimalStr.split(".")
  const intPart = parts[0] || "0"
  let fracPart = parts[1] || ""

  // Pad or truncate fractional part to exactly `decimals` digits
  if (fracPart.length < decimals) {
    fracPart = fracPart.padEnd(decimals, "0")
  } else {
    fracPart = fracPart.slice(0, decimals)
  }

  return BigInt(intPart + fracPart)
}

export function decimalStringCompare(a: string, b: string): -1 | 0 | 1 {
  const da = new Decimal(a)
  const db = new Decimal(b)
  return da.lt(db) ? -1 : da.gt(db) ? 1 : 0
}

export function computeSpecHash(spec: Record<string, unknown>): string {
  const bytes = canonicalJson(spec)
  const hash = sha256(bytes)
  const hex = Buffer.from(hash).toString("hex")
  return `sha256:${hex}`
}

/** Register a custom mint address with its decimal count (for devnet test mints). */
export function registerMint(mintAddress: string, decimals: number): void {
  MINT_DECIMALS[mintAddress] = decimals
}
