/**
 * MCP server configuration — loads from environment variables.
 *
 * SOLANA_KEYPAIR      — base58-encoded 64-byte secret key (preferred)
 * SOLANA_KEYPAIR_PATH — path to JSON keypair file (fallback)
 * SOLANA_RPC_URL      — RPC endpoint (default: devnet)
 * NEGOTIATION_ENGINE_URL — base URL of running engine
 * USDC_MINT           — USDC mint address (default: devnet)
 * PINATA_JWT          — Pinata JWT for IPFS uploads (optional)
 */

import { readFileSync } from "fs"
import { resolve, isAbsolute } from "path"
import { Keypair } from "@solana/web3.js"
import bs58 from "bs58"
import { registerMint } from "@ghost-bazaar/core"

const DEVNET_RPC = "https://api.devnet.solana.com"
const DEVNET_USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"

export interface McpConfig {
  keypair: Keypair
  rpcUrl: string
  engineUrl: string
  usdcMint: string
  pinataJwt?: string
}

export function loadConfig(): McpConfig {
  const keypair = loadKeypair()
  const rpcUrl = process.env.SOLANA_RPC_URL ?? DEVNET_RPC
  const engineUrl = process.env.NEGOTIATION_ENGINE_URL
  if (!engineUrl) {
    throw new Error("NEGOTIATION_ENGINE_URL environment variable is required")
  }
  const usdcMint = process.env.USDC_MINT ?? DEVNET_USDC
  const pinataJwt = process.env.PINATA_JWT

  // Register custom mint so normalizeAmount() knows its decimals
  registerMint(usdcMint, 6)

  return { keypair, rpcUrl, engineUrl, usdcMint, pinataJwt }
}

function loadKeypair(): Keypair {
  // Prefer base58-encoded secret key from env
  const b58Key = process.env.SOLANA_KEYPAIR
  if (b58Key) {
    const secretKey = bs58.decode(b58Key)
    return Keypair.fromSecretKey(secretKey)
  }

  // Fallback to JSON keypair file
  const keyPath = process.env.SOLANA_KEYPAIR_PATH
  if (keyPath) {
    // Resolve relative paths from the project root (2 levels up from dist/config.js)
    const resolved = isAbsolute(keyPath)
      ? keyPath
      : resolve(process.cwd(), keyPath)
    const json = readFileSync(resolved, "utf-8")
    const secretKey = new Uint8Array(JSON.parse(json))
    return Keypair.fromSecretKey(secretKey)
  }

  throw new Error("Either SOLANA_KEYPAIR or SOLANA_KEYPAIR_PATH must be set")
}
