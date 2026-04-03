import { Connection, PublicKey } from "@solana/web3.js"
import { getAssociatedTokenAddressSync } from "@solana/spl-token"
import bs58 from "bs58"
import { sha256 } from "@noble/hashes/sha256"
import {
  verifyQuote,
  didToPublicKey,
  normalizeAmount,
  canonicalJson,
  NONCE_RE,
  type SignedQuote,
} from "@ghost-bazaar/core"
import {
  malformedQuoteHeader,
  invalidBuyerSignature,
  invalidSellerSignature,
  invalidPaymentSignature,
  transactionNotFound,
  transactionFailed,
  transactionNotConfirmed,
  transferInstructionMissing,
  transferDestinationMismatch,
  transferMintMismatch,
  priceMismatch,
  memoMissing,
  memoMismatch,
  invalidNonceFormat,
  nonceReplayed,
  expiredQuote,
  executionFailed,
  SettlementError,
} from "./errors.js"
import { isNonceConsumed, consumeNonce } from "./nonce.js"
import { buildReceipt, type SettlementResponse } from "./receipt.js"

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
const MEMO_PROGRAM_V2 = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"
const MEMO_PROGRAM_V1 = "Memo1UhkJBfCR1EPHNqwLDxhZMM2Yfc3G2YfZeVMQwE1"

export type ServiceExecutor = (quote: SignedQuote) => Promise<void>

export interface SettlementRequest {
  quoteHeaderB64: string
  paymentSignature: string
  rpcUrl: string
  usdcMint: string
  /** Solana cluster for explorer URL. Defaults to "devnet". */
  cluster?: "mainnet-beta" | "devnet" | "testnet"
}

// ---------------------------------------------------------------------------
// VerificationResult — returned by verifySettlement()
// ---------------------------------------------------------------------------

export interface VerificationResult {
  readonly valid: true
  readonly quote: SignedQuote
  readonly tx_sig: string
  readonly verification: {
    readonly amount_matched: boolean
    readonly mint_matched: boolean
    readonly destination_matched: boolean
    readonly memo_matched: boolean
    readonly confirmations: number
    readonly block_time: string | null
    readonly solana_explorer: string
  }
}

/**
 * Pure settlement verification — no side effects.
 *
 * Verifies the on-chain Solana transaction against the quote:
 * - Decodes and validates the quote from base64 header
 * - Verifies buyer + seller Ed25519 signatures
 * - Fetches transaction from Solana RPC
 * - Validates: amount, mint, destination, memo
 *
 * Unlike verifyAndExecute(), this function:
 * - Does NOT consume nonce (safe to retry)
 * - Does NOT check expires_at (supports delayed callbacks)
 * - Does NOT execute any service
 *
 * Used by engine settlement recording routes.
 */
export async function verifySettlement(
  request: SettlementRequest,
): Promise<VerificationResult> {
  // ── Step 1: Decode X-Ghost-Bazaar-Quote header ──
  let quote: SignedQuote
  try {
    const json = Buffer.from(request.quoteHeaderB64, "base64").toString("utf-8")
    quote = JSON.parse(json) as SignedQuote
    if (!quote || typeof quote !== "object" || !quote.quote_id) {
      throw new Error("missing quote_id")
    }
  } catch {
    throw malformedQuoteHeader()
  }

  // ── Steps 2-3: Verify buyer + seller signatures ──
  // NOTE: verifyQuote() also checks expires_at, but for pure settlement
  // verification we intentionally skip expiry — a valid on-chain payment
  // should be recordable even after the quote's temporal window closes.
  const quoteVerification = await verifyQuote(quote)
  if (!quoteVerification.ok) {
    if (quoteVerification.code === "invalid_buyer_signature") throw invalidBuyerSignature()
    if (quoteVerification.code === "invalid_seller_signature") throw invalidSellerSignature()
    // Skip expired_quote — delayed callbacks are valid for settlement recording
    if (quoteVerification.code === "expired_quote") { /* intentionally ignored */ }
    else throw malformedQuoteHeader(`Quote verification failed: ${quoteVerification.code}`)
  }

  // ── Step 4: Validate Payment-Signature ──
  let txSignatureBytes: Uint8Array
  try {
    txSignatureBytes = bs58.decode(request.paymentSignature)
    if (txSignatureBytes.length !== 64) throw new Error("invalid length")
  } catch {
    throw invalidPaymentSignature()
  }
  const txSignature = request.paymentSignature

  // ── Step 5: getTransaction via RPC ──
  const connection = new Connection(request.rpcUrl, "confirmed")
  const tx = await connection.getTransaction(txSignature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  })
  if (!tx) throw transactionNotFound()

  // ── Step 6: Confirm tx status ──
  if (tx.meta?.err) throw transactionFailed()
  if (!tx.slot) throw transactionNotConfirmed()

  // ── Steps 7-10: SPL token transfer verification ──
  const sellerPubkey = didToPublicKey(quote.seller)
  if (!sellerPubkey) throw malformedQuoteHeader("Cannot derive seller pubkey from DID")

  const usdcMint = new PublicKey(request.usdcMint)
  const expectedAmount = normalizeAmount(quote.final_price, request.usdcMint)
  const expectedDestination = getAssociatedTokenAddressSync(usdcMint, sellerPubkey)

  const transferInfo = extractSplTransfer(tx)
  if (!transferInfo) throw transferInstructionMissing()

  const destinationMatched = transferInfo.destination === expectedDestination.toBase58()
  if (!destinationMatched) throw transferDestinationMismatch()

  const mintMatched = transferInfo.mint === request.usdcMint
  if (!mintMatched) throw transferMintMismatch()

  const amountMatched = BigInt(transferInfo.amount) === expectedAmount
  if (!amountMatched) throw priceMismatch()

  // ── Steps 11-12: Memo verification ──
  let memoMatched = true
  if (quote.memo_policy !== "optional") {
    const memoData = extractMemo(tx)
    if (!memoData) throw memoMissing()

    if (quote.memo_policy === "quote_id_required") {
      if (!memoData.includes(quote.quote_id)) throw memoMismatch()
    } else if (quote.memo_policy === "hash_required") {
      const quoteBytes = canonicalJson(quote as unknown as Record<string, unknown>)
      const hash = Buffer.from(sha256(quoteBytes)).toString("hex")
      if (!hash || !memoData.includes(hash)) throw memoMismatch()
    }
  }

  const cluster = request.cluster ?? "devnet"
  const clusterParam = cluster === "mainnet-beta" ? "" : `?cluster=${cluster}`

  return {
    valid: true,
    quote,
    tx_sig: txSignature,
    verification: {
      amount_matched: amountMatched,
      mint_matched: mintMatched,
      destination_matched: destinationMatched,
      memo_matched: memoMatched,
      confirmations: tx.slot ? 1 : 0,
      block_time: tx.blockTime ? new Date(tx.blockTime * 1000).toISOString() : null,
      solana_explorer: `https://explorer.solana.com/tx/${txSignature}${clusterParam}`,
    },
  }
}

/**
 * 17-step settlement validation per GHOST BAZAAR-SPEC-v4 §9.
 *
 * Steps are executed in strict normative order. On any failure, a
 * SettlementError is thrown with the corresponding error code and HTTP status.
 */
export async function verifyAndExecute(
  request: SettlementRequest,
  executor: ServiceExecutor,
): Promise<SettlementResponse> {
  const startMs = Date.now()

  // ── Step 1: Decode X-Ghost-Bazaar-Quote header (base64 → JSON) ──
  let quote: SignedQuote
  try {
    const json = Buffer.from(request.quoteHeaderB64, "base64").toString("utf-8")
    quote = JSON.parse(json) as SignedQuote
    if (!quote || typeof quote !== "object" || !quote.quote_id) {
      throw new Error("missing quote_id")
    }
  } catch {
    throw malformedQuoteHeader()
  }

  // ── Step 2 & 3: Verify buyer + seller Ed25519 signatures ──
  const quoteVerification = await verifyQuote(quote)
  if (!quoteVerification.ok) {
    if (quoteVerification.code === "invalid_buyer_signature") throw invalidBuyerSignature()
    if (quoteVerification.code === "invalid_seller_signature") throw invalidSellerSignature()
    // verifyQuote may also return expired_quote or other codes;
    // map them to the appropriate settlement error
    if (quoteVerification.code === "expired_quote") throw expiredQuote()
    throw malformedQuoteHeader(`Quote verification failed: ${quoteVerification.code}`)
  }

  // ── Step 4: Base58-decode Payment-Signature header ──
  let txSignatureBytes: Uint8Array
  try {
    txSignatureBytes = bs58.decode(request.paymentSignature)
    if (txSignatureBytes.length !== 64) throw new Error("invalid length")
  } catch {
    throw invalidPaymentSignature()
  }
  const txSignature = request.paymentSignature

  // ── Step 5: getTransaction via RPC ──
  const connection = new Connection(request.rpcUrl, "confirmed")
  const tx = await connection.getTransaction(txSignature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  })
  if (!tx) throw transactionNotFound()

  // ── Step 6: Confirm tx status is confirmed or finalized ──
  if (tx.meta?.err) throw transactionFailed()
  // If we got a result with commitment "confirmed", the tx is at least confirmed.
  // Double-check slot exists as a sanity check.
  if (!tx.slot) throw transactionNotConfirmed()

  // ── Steps 7-10: Extract and verify SPL token transfer ──
  const sellerPubkey = didToPublicKey(quote.seller)
  if (!sellerPubkey) throw malformedQuoteHeader("Cannot derive seller pubkey from DID")

  const usdcMint = new PublicKey(request.usdcMint)
  const expectedAmount = normalizeAmount(quote.final_price, request.usdcMint)

  // Derive seller's expected ATA for USDC
  const expectedDestination = getAssociatedTokenAddressSync(usdcMint, sellerPubkey)

  const transferInfo = extractSplTransfer(tx)
  if (!transferInfo) throw transferInstructionMissing()

  // Step 8: Verify destination matches seller
  if (transferInfo.destination !== expectedDestination.toBase58()) {
    throw transferDestinationMismatch()
  }

  // Step 9: Verify mint matches USDC (reject if mint is unknown or wrong)
  if (!transferInfo.mint || transferInfo.mint !== request.usdcMint) {
    throw transferMintMismatch()
  }

  // Step 10: Verify amount matches final_price
  if (BigInt(transferInfo.amount) !== expectedAmount) {
    throw priceMismatch()
  }

  // ── Steps 11-12: Memo verification ──
  if (quote.memo_policy !== "optional") {
    const memoData = extractMemo(tx)
    if (!memoData) throw memoMissing()

    if (quote.memo_policy === "quote_id_required") {
      // Memo should contain quote_id (may be prefixed with "GhostBazaar:quote_id:")
      if (!memoData.includes(quote.quote_id)) {
        throw memoMismatch()
      }
    } else if (quote.memo_policy === "hash_required") {
      // Memo should contain sha256 of canonical quote
      const quoteBytes = canonicalJson(quote as unknown as Record<string, unknown>)
      const hash = Buffer.from(sha256(quoteBytes)).toString("hex")
      if (!memoData.includes(hash)) {
        throw memoMismatch()
      }
    }
  }

  // ── Step 13: Verify nonce format ──
  if (!NONCE_RE.test(quote.nonce)) {
    throw invalidNonceFormat()
  }

  // ── Step 14: Check nonce is not consumed ──
  if (isNonceConsumed(quote.quote_id)) {
    throw nonceReplayed()
  }

  // ── Step 15: Verify expires_at is in the future ──
  const expiresMs = Date.parse(quote.expires_at)
  if (isNaN(expiresMs) || expiresMs <= Date.now()) {
    throw expiredQuote()
  }

  // ── Step 16: Execute service ──
  try {
    await executor(quote)
  } catch (err) {
    throw executionFailed(err instanceof Error ? err.message : "Unknown execution error")
  }

  // ── Step 17: Persist nonce atomically with execution ──
  consumeNonce(quote.quote_id)

  const settlementMs = Date.now() - startMs
  return buildReceipt(quote, txSignature, settlementMs, { cluster: request.cluster })
}

// ── Transaction parsing helpers ──

interface TransferInfo {
  source: string
  destination: string
  amount: string
  mint: string | null
}

function extractSplTransfer(tx: any): TransferInfo | null {
  // Try parsed inner instructions and top-level instructions
  const allInstructions = collectInstructions(tx)

  for (const ix of allInstructions) {
    if (!ix.parsed) continue
    const programId = ix.programId?.toString?.() ?? ix.program ?? ""

    // SPL Token program
    if (programId === TOKEN_PROGRAM_ID.toBase58() || ix.program === "spl-token") {
      const parsed = ix.parsed
      if (parsed.type === "transferChecked" && parsed.info) {
        return {
          source: parsed.info.source,
          destination: parsed.info.destination,
          amount: parsed.info.tokenAmount?.amount ?? String(parsed.info.amount),
          mint: parsed.info.mint ?? null,
        }
      }
      if (parsed.type === "transfer" && parsed.info) {
        return {
          source: parsed.info.source,
          destination: parsed.info.destination,
          amount: String(parsed.info.amount),
          mint: null, // plain transfer doesn't include mint
        }
      }
    }
  }

  // Fallback: scan raw instructions by program ID
  const message = tx.transaction?.message
  if (message?.accountKeys && message?.instructions) {
    for (const ix of message.instructions) {
      const progId = message.accountKeys[ix.programIdIndex]?.toString?.() ??
        message.accountKeys[ix.programIdIndex]
      if (progId === TOKEN_PROGRAM_ID.toBase58() && ix.data) {
        const data = bs58.decode(ix.data)
        // SPL Token Transfer = instruction type 3, TransferChecked = type 12
        if (data[0] === 3 && data.length >= 9) {
          const amount = readU64LE(data, 1)
          return {
            source: resolveAccountKey(message, ix.accounts[0]),
            destination: resolveAccountKey(message, ix.accounts[1]),
            amount: amount.toString(),
            mint: null,
          }
        }
        if (data[0] === 12 && data.length >= 10) {
          const amount = readU64LE(data, 1)
          return {
            source: resolveAccountKey(message, ix.accounts[0]),
            destination: resolveAccountKey(message, ix.accounts[2]),
            amount: amount.toString(),
            mint: resolveAccountKey(message, ix.accounts[1]),
          }
        }
      }
    }
  }

  return null
}

function extractMemo(tx: any): string | null {
  const allInstructions = collectInstructions(tx)

  for (const ix of allInstructions) {
    const programId = ix.programId?.toString?.() ?? ix.program ?? ""
    if (programId === MEMO_PROGRAM_V2 || programId === MEMO_PROGRAM_V1 || ix.program === "spl-memo") {
      // Parsed memo
      if (ix.parsed && typeof ix.parsed === "string") return ix.parsed
      // Raw memo data
      if (ix.data) {
        try {
          return Buffer.from(bs58.decode(ix.data)).toString("utf-8")
        } catch {
          return ix.data
        }
      }
    }
  }

  // Check log messages for memo content
  if (tx.meta?.logMessages) {
    for (const log of tx.meta.logMessages) {
      const match = log.match(/^Program log: Memo \(len \d+\): "(.*)"$/)
      if (match) return match[1]
      // Some memo logs appear as: "Program log: <memo content>"
      if (log.startsWith("Program log: ") && log.includes("Ghost Bazaar:")) {
        return log.slice("Program log: ".length)
      }
    }
  }

  return null
}

function collectInstructions(tx: any): any[] {
  const result: any[] = []

  // Top-level instructions
  const msg = tx.transaction?.message
  if (msg?.instructions) {
    for (const ix of msg.instructions) {
      result.push(ix)
    }
  }

  // Inner instructions (from CPI calls)
  if (tx.meta?.innerInstructions) {
    for (const inner of tx.meta.innerInstructions) {
      if (inner.instructions) {
        for (const ix of inner.instructions) {
          result.push(ix)
        }
      }
    }
  }

  return result
}

function resolveAccountKey(message: any, index: number): string {
  const key = message.accountKeys[index]
  return key?.pubkey?.toString?.() ?? key?.toString?.() ?? String(key)
}

function readU64LE(data: Uint8Array, offset: number): bigint {
  let value = 0n
  for (let i = 0; i < 8; i++) {
    value |= BigInt(data[offset + i]) << BigInt(i * 8)
  }
  return value
}
