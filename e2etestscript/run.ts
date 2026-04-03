/**
 * Ghost Bazaar Full E2E Test — Live Engine + Solana Devnet
 *
 * Runs the complete flow against the LIVE engine at ghost-bazaar-engine.fly.dev
 * and real Solana devnet transactions:
 *
 *   Block 1:  Load keypairs & register test USDC mint
 *   Block 2:  Seller registers listing on live engine (POST /listings)
 *   Block 3:  Buyer posts RFQ
 *   Block 4:  Seller discovers RFQ via GET /rfqs
 *   Block 5:  Seller posts offer
 *   Block 6:  Buyer counters
 *   Block 7:  Seller posts revised offer
 *   Block 8:  Buyer accepts → unsigned quote
 *   Block 9:  Buyer signs quote
 *   Block 10: Seller cosigns quote → COMMITTED
 *   Block 11: Buyer sends USDC + memo on Solana devnet
 *   Block 12: Settlement verification via local /execute
 *   Block 13: Verify receipt & check balances
 *
 * Usage:
 *   pnpm --filter e2e-test-script e2e
 */

import { readFileSync } from "fs"
import { createServer } from "http"
import {
  Keypair,
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js"
import {
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token"
import {
  buildDid,
  objectSigningPayload,
  signEd25519,
  canonicalJson,
  normalizeAmount,
  registerMint,
} from "@ghost-bazaar/core"
import {
  handleSettlementRequest,
  type SettlementServerConfig,
} from "@ghost-bazaar/settlement"

// ═══════════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════════

const ENGINE_URL = "https://ghost-bazaar-engine.fly.dev"
const RPC_URL = "https://api.devnet.solana.com"
const TEST_USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"
const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr")
const SETTLEMENT_PORT = 9999

// ═══════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════

function hr(label: string) {
  console.log(`\n${"═".repeat(65)}`)
  console.log(`  ${label}`)
  console.log("═".repeat(65))
}

async function signObj(obj: Record<string, unknown>, kp: Keypair): Promise<string> {
  return signEd25519(objectSigningPayload(obj), kp)
}

async function signQuotePayload(quote: Record<string, unknown>, kp: Keypair): Promise<string> {
  const stripped = { ...quote, buyer_signature: "", seller_signature: "" }
  return signEd25519(canonicalJson(stripped), kp)
}

async function buildAuthHeader(kp: Keypair): Promise<Record<string, string>> {
  const did = buildDid(kp.publicKey)
  const timestamp = new Date().toISOString()
  const payload = objectSigningPayload({ action: "authenticate", did, timestamp, signature: "" })
  const sig = await signEd25519(payload, kp)
  return { Authorization: `GhostBazaar-Ed25519 ${did} ${timestamp} ${sig}` }
}

async function enginePost(path: string, body: any) {
  const res = await fetch(`${ENGINE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  const data = await res.json() as any
  if (!res.ok) throw new Error(`POST ${path} → ${res.status}: ${JSON.stringify(data)}`)
  return data
}

async function enginePut(path: string, body: any) {
  const res = await fetch(`${ENGINE_URL}${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  const data = await res.json() as any
  if (!res.ok) throw new Error(`PUT ${path} → ${res.status}: ${JSON.stringify(data)}`)
  return data
}

async function engineGet(path: string, kp?: Keypair) {
  const headers: Record<string, string> = { Accept: "application/json" }
  if (kp) Object.assign(headers, await buildAuthHeader(kp))
  const res = await fetch(`${ENGINE_URL}${path}`, { headers })
  const data = await res.json() as any
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}: ${JSON.stringify(data)}`)
  return data
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

// ═══════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════

async function main() {
  console.log("\n🌐  Ghost Bazaar Full E2E — Live Engine + Solana Devnet\n")
  console.log(`  Engine: ${ENGINE_URL}`)
  console.log(`  RPC:    ${RPC_URL}`)

  // ─────────────────────────────────────────────────────────────────
  // BLOCK 1: Load keypairs & register test USDC mint
  // ─────────────────────────────────────────────────────────────────

  hr("BLOCK 1: Load keypairs & register test USDC mint")

  const buyerKp = Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(readFileSync("../.keys/buyer.json", "utf-8"))),
  )
  const sellerKp = Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(readFileSync("../.keys/seller.json", "utf-8"))),
  )
  const buyerDid = buildDid(buyerKp.publicKey)
  const sellerDid = buildDid(sellerKp.publicKey)

  registerMint(TEST_USDC_MINT, 6)

  console.log("  Buyer pubkey: ", buyerKp.publicKey.toBase58())
  console.log("  Seller pubkey:", sellerKp.publicKey.toBase58())
  console.log("  Buyer DID:    ", buyerDid)
  console.log("  Seller DID:   ", sellerDid)

  const connection = new Connection(RPC_URL, "confirmed")
  const buyerSol = await connection.getBalance(buyerKp.publicKey)
  const sellerSol = await connection.getBalance(sellerKp.publicKey)
  console.log(`  Buyer SOL:     ${buyerSol / 1e9}`)
  console.log(`  Seller SOL:    ${sellerSol / 1e9}`)

  // ─────────────────────────────────────────────────────────────────
  // BLOCK 2: Seller registers listing on LIVE engine
  // ─────────────────────────────────────────────────────────────────

  hr("BLOCK 2: Seller registers listing on live engine")

  const listingId = `listing-e2e-${Date.now()}`
  const listingBody: Record<string, unknown> = {
    listing_id: listingId,
    seller: sellerDid,
    title: "Smart Contract Audit — E2E Live Test",
    category: "security",
    service_type: "smart-contract-audit",
    negotiation_endpoint: ENGINE_URL,
    payment_endpoint: "https://localhost/execute",
    base_terms: { coverage: "full", turnaround: "24h" },
    negotiation_profile: { style: "flexible", max_rounds: 5, accepts_counter: true },
    signature: "",
  }
  listingBody.signature = await signObj(listingBody, sellerKp)

  const listingRes = await enginePost("/listings", listingBody)
  console.log("  Listing ID:   ", listingRes.listing_id ?? listingId)
  console.log("  Seller:       ", sellerDid.slice(0, 30) + "...")
  console.log("  Service:       smart-contract-audit")

  // ─────────────────────────────────────────────────────────────────
  // BLOCK 3: Buyer posts RFQ
  // ─────────────────────────────────────────────────────────────────

  hr("BLOCK 3: Buyer posts RFQ")

  const rfqId = crypto.randomUUID()
  const deadline = new Date(Date.now() + 120_000).toISOString()
  const rfq: Record<string, unknown> = {
    rfq_id: rfqId,
    protocol: "ghost-bazaar-v4",
    buyer: buyerDid,
    service_type: "smart-contract-audit",
    spec: { language: "Solidity", lines: 500 },
    anchor_price: "40.00",
    currency: "USDC",
    deadline,
    signature: "",
  }
  rfq.signature = await signObj(rfq, buyerKp)

  const rfqRes = await enginePost("/rfqs", rfq)
  console.log("  RFQ ID:   ", rfqId)
  console.log("  State:     ", rfqRes.state ?? "OPEN")
  console.log("  Anchor:     $40.00 USDC")
  console.log("  Deadline:  ", deadline)

  // ─────────────────────────────────────────────────────────────────
  // BLOCK 4: Seller discovers RFQ via GET /rfqs
  // ─────────────────────────────────────────────────────────────────

  hr("BLOCK 4: Seller discovers RFQ")

  const rfqsRes = await engineGet(`/rfqs?status=open`)
  const rfqs = rfqsRes.rfqs ?? rfqsRes
  const foundRfq = rfqs.find((r: any) => r.rfq_id === rfqId)
  console.log("  Open RFQs:    ", rfqs.length)
  console.log("  Found ours:   ", foundRfq ? "YES" : "NO")
  if (foundRfq) {
    console.log("  Anchor price:  $" + foundRfq.anchor_price, "USDC")
  }

  // ─────────────────────────────────────────────────────────────────
  // BLOCK 5: Seller posts offer at $55
  // ─────────────────────────────────────────────────────────────────

  hr("BLOCK 5: Seller posts offer")

  const offer1Id = crypto.randomUUID()
  const offer1: Record<string, unknown> = {
    offer_id: offer1Id,
    rfq_id: rfqId,
    seller: sellerDid,
    listing_id: listingId,
    price: "55.00",
    currency: "USDC",
    valid_until: deadline,
    signature: "",
  }
  offer1.signature = await signObj(offer1, sellerKp)

  await enginePost(`/rfqs/${rfqId}/offers`, offer1)
  console.log("  Offer ID:  ", offer1Id)
  console.log("  Price:      $55.00 USDC")

  // ─────────────────────────────────────────────────────────────────
  // BLOCK 6: Buyer counters at $42
  // ─────────────────────────────────────────────────────────────────

  hr("BLOCK 6: Buyer counters")

  const counter: Record<string, unknown> = {
    counter_id: crypto.randomUUID(),
    rfq_id: rfqId,
    round: 1,
    from: buyerDid,
    to: sellerDid,
    price: "42.00",
    currency: "USDC",
    valid_until: deadline,
    signature: "",
  }
  counter.signature = await signObj(counter, buyerKp)

  await enginePost(`/rfqs/${rfqId}/counter`, counter)
  console.log("  Counter:    $42.00 USDC (round 1)")

  // ─────────────────────────────────────────────────────────────────
  // BLOCK 7: Seller posts revised offer at $48
  // ─────────────────────────────────────────────────────────────────

  hr("BLOCK 7: Seller revises offer")

  const offer2Id = crypto.randomUUID()
  const offer2: Record<string, unknown> = {
    offer_id: offer2Id,
    rfq_id: rfqId,
    seller: sellerDid,
    listing_id: listingId,
    price: "48.00",
    currency: "USDC",
    valid_until: deadline,
    signature: "",
  }
  offer2.signature = await signObj(offer2, sellerKp)

  await enginePost(`/rfqs/${rfqId}/offers`, offer2)
  console.log("  Revised:    $48.00 USDC")

  // ─────────────────────────────────────────────────────────────────
  // BLOCK 8: Buyer accepts → unsigned quote
  // ─────────────────────────────────────────────────────────────────

  hr("BLOCK 8: Buyer accepts offer")

  // Get session revision from events
  const eventsRes = await engineGet(`/rfqs/${rfqId}/events`, buyerKp)
  const events = eventsRes.events ?? eventsRes
  const lastEventId = events.length > 0 ? String(events[events.length - 1].event_id) : "0"

  const envelope: Record<string, unknown> = {
    envelope_id: crypto.randomUUID(),
    action: "accept",
    rfq_id: rfqId,
    session_revision: lastEventId,
    payload: { seller: sellerDid, offer_id: offer2Id },
    issued_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    signature: "",
  }
  envelope.signature = await signObj(envelope, buyerKp)

  const unsignedQuote = await enginePost(`/rfqs/${rfqId}/accept`, envelope)
  console.log("  Quote ID:     ", unsignedQuote.quote_id)
  console.log("  Final price:   $" + unsignedQuote.final_price, "USDC")
  console.log("  Memo policy:  ", unsignedQuote.memo_policy)
  console.log("  Nonce:        ", unsignedQuote.nonce?.slice(0, 18) + "...")

  // ─────────────────────────────────────────────────────────────────
  // BLOCK 9: Buyer signs quote
  // ─────────────────────────────────────────────────────────────────

  hr("BLOCK 9: Buyer signs quote")

  const buyerSig = await signQuotePayload(unsignedQuote, buyerKp)
  const buyerSignedQuote = await enginePut(`/rfqs/${rfqId}/quote/sign`, { buyer_signature: buyerSig })

  console.log("  Buyer sig:     ✓ ", buyerSignedQuote.buyer_signature?.slice(0, 25) + "...")
  console.log("  Seller sig:    (pending)")

  // ─────────────────────────────────────────────────────────────────
  // BLOCK 10: Seller cosigns → COMMITTED
  // ─────────────────────────────────────────────────────────────────

  hr("BLOCK 10: Seller cosigns → COMMITTED")

  const sellerSig = await signQuotePayload(buyerSignedQuote, sellerKp)
  const committedQuote = await enginePut(`/rfqs/${rfqId}/cosign`, { seller_signature: sellerSig })

  console.log("  ✅ DEAL COMMITTED")
  console.log("  Quote:      ", committedQuote.quote_id)
  console.log("  Price:       $" + committedQuote.final_price, "USDC")
  console.log("  Buyer sig:   ✓")
  console.log("  Seller sig:  ✓")
  console.log("  Nonce:      ", committedQuote.nonce?.slice(0, 18) + "...")

  // ─────────────────────────────────────────────────────────────────
  // BLOCK 11: Buyer sends USDC + memo on Solana devnet
  // ─────────────────────────────────────────────────────────────────

  hr("BLOCK 11: Send USDC payment on Solana devnet")

  const usdcMint = new PublicKey(TEST_USDC_MINT)
  const amount = normalizeAmount(committedQuote.final_price, TEST_USDC_MINT)
  const buyerAta = getAssociatedTokenAddressSync(usdcMint, buyerKp.publicKey)
  const sellerAta = getAssociatedTokenAddressSync(usdcMint, sellerKp.publicKey)

  console.log("  Amount:      ", amount.toString(), `micro-units ($${committedQuote.final_price})`)
  console.log("  From ATA:    ", buyerAta.toBase58())
  console.log("  To ATA:      ", sellerAta.toBase58())

  const tx = new Transaction()
  tx.add(
    createTransferCheckedInstruction(buyerAta, usdcMint, sellerAta, buyerKp.publicKey, amount, 6),
  )

  const memoContent = `GhostBazaar:quote_id:${committedQuote.quote_id}`
  tx.add(
    new TransactionInstruction({
      keys: [{ pubkey: buyerKp.publicKey, isSigner: true, isWritable: false }],
      programId: MEMO_PROGRAM_ID,
      data: Buffer.from(memoContent),
    }),
  )

  console.log("  Memo:        ", memoContent)
  console.log("  Sending tx to devnet...")

  const txSig = await connection.sendTransaction(tx, [buyerKp])
  console.log("  Tx sig:      ", txSig)
  console.log("  Explorer:     https://explorer.solana.com/tx/" + txSig + "?cluster=devnet")

  console.log("  Waiting for confirmation...")
  await connection.confirmTransaction(txSig, "confirmed")
  console.log("  ✅ Transaction confirmed!")

  // ─────────────────────────────────────────────────────────────────
  // BLOCK 12: Settlement verification via local /execute
  // ─────────────────────────────────────────────────────────────────

  hr("BLOCK 12: Settlement verification via /execute")

  let serviceExecuted = false
  const settlementConfig: SettlementServerConfig = {
    rpcUrl: RPC_URL,
    usdcMint: TEST_USDC_MINT,
    cluster: "devnet",
    executor: async (quote) => {
      console.log("  ⚡ Service executor called!")
      console.log("    Quote:  ", quote.quote_id)
      console.log("    Price:   $" + quote.final_price)
      serviceExecuted = true
    },
    onSettled: async (_quote, result) => {
      console.log("  📋 onSettled hook fired")
      console.log("    Latency: ", result.settlement_ms + "ms")
    },
  }

  const settlementServer = createServer(async (req, res) => {
    if (req.url === "/execute" && req.method === "POST") {
      await handleSettlementRequest(req, res, settlementConfig)
    } else {
      res.writeHead(404)
      res.end()
    }
  })

  await new Promise<void>((resolve) => settlementServer.listen(SETTLEMENT_PORT, resolve))
  console.log("  Settlement server on port", SETTLEMENT_PORT)

  console.log("  Waiting 3s for RPC indexing...")
  await sleep(3000)

  const quoteB64 = Buffer.from(JSON.stringify(committedQuote)).toString("base64")
  console.log("  POSTing /execute...")

  const executeRes = await fetch(`http://localhost:${SETTLEMENT_PORT}/execute`, {
    method: "POST",
    headers: {
      "X-Ghost-Bazaar-Quote": quoteB64,
      "Payment-Signature": txSig,
      "Content-Type": "application/json",
    },
  })
  const executeBody = await executeRes.json() as any

  // ─────────────────────────────────────────────────────────────────
  // BLOCK 13: Results
  // ─────────────────────────────────────────────────────────────────

  hr("BLOCK 13: Results")

  if (executeRes.ok) {
    console.log("  ✅ SETTLEMENT SUCCESSFUL!")
    console.log("")
    console.log("  Receipt:")
    console.log("    Quote ID:       ", executeBody.receipt.quote_id)
    console.log("    Final price:     $" + executeBody.receipt.final_price, "USDC")
    console.log("    Buyer pubkey:   ", executeBody.receipt.buyer_pubkey)
    console.log("    Seller pubkey:  ", executeBody.receipt.seller_pubkey)
    console.log("    Settled at:     ", executeBody.receipt.settled_at)
    console.log("    Settlement ms:  ", executeBody.settlement_ms)
    console.log("    Explorer:       ", executeBody.explorer_tx)
    console.log("")
    console.log("  Service executed: ", serviceExecuted)
  } else {
    console.log("  ❌ SETTLEMENT FAILED!")
    console.log("  Status:", executeRes.status)
    console.log("  Error: ", JSON.stringify(executeBody, null, 2))
  }

  // Final balances
  console.log("")
  const buyerTokenBalance = await connection.getTokenAccountBalance(buyerAta)
  const sellerTokenBalance = await connection.getTokenAccountBalance(sellerAta)
  console.log("  Final balances:")
  console.log("    Buyer USDC:  ", buyerTokenBalance.value.uiAmountString)
  console.log("    Seller USDC: ", sellerTokenBalance.value.uiAmountString)

  settlementServer.close()

  console.log("\n" + "═".repeat(65))
  if (executeRes.ok) {
    console.log("  🎉 FULL E2E TEST PASSED — Live Engine + Solana Devnet")
  } else {
    console.log("  ❌ E2E TEST FAILED")
  }
  console.log("═".repeat(65) + "\n")

  process.exit(executeRes.ok ? 0 : 1)
}

main().catch((err) => {
  console.error("\n❌ E2E test failed:", err)
  process.exit(1)
})
