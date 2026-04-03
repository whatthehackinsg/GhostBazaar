/**
 * MCP buyer tools — exposed to Claude Code / MCP-compatible agents.
 *
 * Privacy: budget_hard is accepted as input but NEVER appears in tool output.
 */

import { randomBytes } from "crypto"
import { access } from "fs/promises"
import path from "path"
import { createRequire } from "module"
import { z } from "zod"
import Decimal from "decimal.js"
import { v4 as uuidv4 } from "uuid"
import type { Keypair } from "@solana/web3.js"
import {
  buildDid,
  type Listing,
  objectSigningPayload,
  signEd25519,
  signQuoteAsBuyer,
  type RFQ,
} from "@ghost-bazaar/core"
import { sanitizeBuyerAction, type BuyerPrivate } from "@ghost-bazaar/strategy"
import { EngineClient, recordDealFeedback, registerAgent, type RegisteredAgent } from "@ghost-bazaar/agents"
import type { McpConfig } from "../config.js"

export interface BuyerSessionState {
  budgetSoft: string
  budgetHard: string
  commitmentSalt: bigint
  rfq: RFQ
  round: number
  selectedSellerDid?: string
  selectedOfferId?: string
}

export interface BuyerState {
  /** Per-RFQ private state. budget_hard MUST NOT leave this map. */
  sessions: Map<string, BuyerSessionState>
  /** Cached 8004 registration for this MCP identity, when enabled. */
  registeredAgent: RegisteredAgent | null
  /** Avoid repeated registration attempts in long-lived MCP sessions. */
  registrationAttempted: boolean
}

export function createBuyerState(): BuyerState {
  return {
    sessions: new Map(),
    registeredAgent: null,
    registrationAttempted: false,
  }
}

async function loadBudgetZk() {
  try {
    return await import("@ghost-bazaar/zk")
  } catch {
    return null
  }
}

const require = createRequire(import.meta.url)

async function hasBudgetProofArtifacts(zk: Awaited<ReturnType<typeof loadBudgetZk>>): Promise<boolean> {
  if (!zk) return false
  if (typeof (zk as any).hasBudgetProofArtifacts === "function") return (zk as any).hasBudgetProofArtifacts()

  try {
    const zkEntry = require.resolve("@ghost-bazaar/zk")
    const zkDistDir = path.dirname(zkEntry)
    const wasmPath = path.resolve(zkDistDir, "../build/BudgetRangeProof_js/BudgetRangeProof.wasm")
    const zkeyPath = path.resolve(zkDistDir, "../build/BudgetRangeProof_final.zkey")
    await Promise.all([access(wasmPath), access(zkeyPath)])
    return true
  } catch {
    return false
  }
}

export function defineBuyerTools(config: McpConfig, state: BuyerState) {
  const engine = new EngineClient({ baseUrl: config.engineUrl, keypair: config.keypair })
  const did = buildDid(config.keypair.publicKey)

  async function ensureBuyerRegistered(): Promise<RegisteredAgent | null> {
    if (state.registeredAgent) return state.registeredAgent
    if (state.registrationAttempted || !config.pinataJwt) return null

    state.registrationAttempted = true
    try {
      state.registeredAgent = await registerAgent(
        { signer: config.keypair, pinataJwt: config.pinataJwt, rpcUrl: config.rpcUrl },
        {
          name: `Ghost Bazaar Buyer — ${did.slice(0, 20)}`,
          description: "Autonomous buyer agent using the Ghost Bazaar MCP toolchain",
          negotiationEndpoint: config.engineUrl,
        },
      )
      return state.registeredAgent
    } catch {
      return null
    }
  }

  async function submitFeedback(counterpartyAgentId: string, settledAmount: string, success = true, score?: number) {
    if (!config.pinataJwt) return false
    try {
      await recordDealFeedback(
        { signer: config.keypair, pinataJwt: config.pinataJwt, rpcUrl: config.rpcUrl },
        BigInt(counterpartyAgentId),
        { success, settledAmount, score },
      )
      return true
    } catch {
      return false
    }
  }

  async function resolveSellerRegistryAgentId(quote: { rfq_id?: string; seller?: string; final_price?: string }): Promise<string | null> {
    if (!quote.rfq_id || !quote.seller) return null

    const session = state.sessions.get(quote.rfq_id)
    const events = await engine.getEvents(quote.rfq_id)
    const targetOfferId = session?.selectedOfferId

    const matchingOffer = [...events]
      .reverse()
      .find((event) => {
        if (event.event_type !== "offer" || !event.payload) return false
        const payload = event.payload as Record<string, unknown>
        if (targetOfferId && payload.offer_id === targetOfferId) return true
        return payload.seller === quote.seller && payload.price === quote.final_price
      })

    const listingId = matchingOffer?.payload && typeof (matchingOffer.payload as Record<string, unknown>).listing_id === "string"
      ? (matchingOffer.payload as Record<string, unknown>).listing_id as string
      : null
    if (!listingId) return null

    try {
      const listing = await engine.getListing(listingId) as Listing
      return typeof listing.registry_agent_id === "string" ? listing.registry_agent_id : null
    } catch {
      return null
    }
  }

  return {
    ghost_bazaar_browse_listings: {
      description: "Browse available seller listings, optionally filtered by service type",
      inputSchema: z.object({
        service_type: z.string().optional().describe("Filter listings by service type"),
      }),
      handler: async (input: { service_type?: string }) => {
        const listings = await engine.getListings(input.service_type)
        return { content: [{ type: "text" as const, text: JSON.stringify(listings, null, 2) }] }
      },
    },

    ghost_bazaar_post_rfq: {
      description: "Post a Request for Quotes to find sellers for a service. Generates budget commitment internally.",
      inputSchema: z.object({
        service_type: z.string().describe("Type of service requested"),
        spec: z.record(z.unknown()).describe("Service specification details"),
        anchor_price: z.string().describe("Starting anchor price (decimal string, e.g. '25.00')"),
        budget_soft: z.string().describe("Soft budget limit (decimal string)"),
        budget_hard: z.string().describe("Hard budget limit — PRIVATE, never revealed (decimal string)"),
        deadline_seconds: z.number().describe("Negotiation deadline in seconds from now"),
      }),
      handler: async (input: {
        service_type: string
        spec: Record<string, unknown>
        anchor_price: string
        budget_soft: string
        budget_hard: string
        deadline_seconds: number
      }) => {
        // Generate real commitment salt (254-bit field element)
        const commitmentSalt = BigInt("0x" + randomBytes(31).toString("hex"))

        // Only attach a budget commitment when this workspace can also prove counters.
        // A commitment without prover artifacts creates an RFQ that cannot negotiate.
        let budgetCommitment: string | undefined
        const zk = await loadBudgetZk()
        if (zk && await hasBudgetProofArtifacts(zk)) {
          budgetCommitment = await zk.generateBudgetCommitment(input.budget_hard, commitmentSalt)
        }

        const rfqId = uuidv4()
        const deadline = new Date(Date.now() + input.deadline_seconds * 1000).toISOString()
        const registeredAgent = await ensureBuyerRegistered()

        const rfq: RFQ = {
          rfq_id: rfqId,
          protocol: "ghost-bazaar-v4",
          buyer: did,
          service_type: input.service_type,
          spec: input.spec,
          anchor_price: input.anchor_price,
          currency: "USDC",
          deadline,
          signature: "",
          budget_commitment: budgetCommitment,
          ...(registeredAgent
            ? {
                extensions: {
                  ghost_bazaar_buyer_registry_agent_id: registeredAgent.agentId.toString(),
                },
              }
            : {}),
        }

        // Sign RFQ
        const payload = objectSigningPayload(rfq as unknown as Record<string, unknown>)
        rfq.signature = await signEd25519(payload, config.keypair)

        await engine.postRfq(rfq)

        // Store private state locally (budget_hard stays here, never in output)
        state.sessions.set(rfqId, {
          budgetSoft: input.budget_soft,
          budgetHard: input.budget_hard,
          commitmentSalt,
          rfq,
          round: 0,
        })

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                rfq_id: rfqId,
                buyer: did,
                service_type: input.service_type,
                anchor_price: input.anchor_price,
                deadline,
                has_budget_commitment: !!budgetCommitment,
                registry_agent_id: registeredAgent?.agentId.toString(),
              }),
            },
          ],
        }
      },
    },

    ghost_bazaar_get_offers: {
      description: "Get current seller offers for an RFQ",
      inputSchema: z.object({
        rfq_id: z.string().describe("RFQ identifier"),
      }),
      handler: async (input: { rfq_id: string }) => {
        const events = await engine.getEvents(input.rfq_id)
        const offers = events
          .filter((e) => e.event_type === "offer")
          .map((e) => e.payload)

        return { content: [{ type: "text" as const, text: JSON.stringify(offers, null, 2) }] }
      },
    },

    ghost_bazaar_counter: {
      description: "Send a counter-offer to a seller. ZK proof is generated automatically if budget commitment exists. Price is sanitized against budget_hard.",
      inputSchema: z.object({
        rfq_id: z.string().describe("RFQ identifier"),
        seller_did: z.string().describe("Seller's DID (did:key:z6Mk...)"),
        price: z.string().describe("Counter-offer price (decimal string)"),
      }),
      handler: async (input: { rfq_id: string; seller_did: string; price: string }) => {
        const session = state.sessions.get(input.rfq_id)

        // Sanitize price against budget_hard
        const priv: BuyerPrivate = session
          ? { budget_soft: new Decimal(session.budgetSoft), budget_hard: new Decimal(session.budgetHard) }
          : { budget_soft: new Decimal(input.price), budget_hard: new Decimal(input.price) }

        const rawAction = { type: "counter" as const, seller: input.seller_did, price: new Decimal(input.price) }
        const safeAction = sanitizeBuyerAction(rawAction, priv)
        const safePrice = safeAction.type === "counter" ? safeAction.price.toString() : input.price

        // Increment round
        const round = session ? ++session.round : 1

        const counter: any = {
          counter_id: uuidv4(),
          rfq_id: input.rfq_id,
          round,
          from: did,
          to: input.seller_did,
          price: safePrice,
          currency: "USDC",
          valid_until: session?.rfq.deadline ?? new Date(Date.now() + 300_000).toISOString(),
          signature: "",
        }

        // Generate ZK proof if budget commitment exists
        if (session?.rfq.budget_commitment) {
          const zk = await loadBudgetZk()
          if (!zk || !await hasBudgetProofArtifacts(zk)) {
            throw new Error("Budget proof artifacts are unavailable; build packages/zk before countering this RFQ")
          }

          counter.budget_proof = await zk.generateBudgetProof(
            safePrice,
            session.budgetHard,
            session.commitmentSalt,
          )
        }

        const payload = objectSigningPayload(counter as Record<string, unknown>)
        counter.signature = await signEd25519(payload, config.keypair)

        await engine.postCounter(input.rfq_id, counter)

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ counter_id: counter.counter_id, price: safePrice, round }),
            },
          ],
        }
      },
    },

    ghost_bazaar_accept: {
      description: "Accept a seller's offer, triggering the commitment phase",
      inputSchema: z.object({
        rfq_id: z.string().describe("RFQ identifier"),
        seller_did: z.string().describe("Seller's DID to accept"),
        offer_id: z.string().describe("Offer ID to accept"),
      }),
      handler: async (input: { rfq_id: string; seller_did: string; offer_id: string }) => {
        // Get session revision from latest events for CAS
        const events = await engine.getEvents(input.rfq_id)
        const lastEvent = events.length > 0 ? events[events.length - 1] : null
        const sessionRevision = String(lastEvent?.event_id ?? "0")

        const unsignedQuote = await engine.accept(input.rfq_id, input.seller_did, input.offer_id, sessionRevision)
        const signed = await signQuoteAsBuyer(unsignedQuote, config.keypair)
        await engine.signQuote(input.rfq_id, signed.buyer_signature)
        const session = state.sessions.get(input.rfq_id)
        if (session) {
          session.selectedSellerDid = input.seller_did
          session.selectedOfferId = input.offer_id
        }

        // Return the full signed quote — ghost_bazaar_settle needs it.
        // budget_hard is NOT in the quote object, so this is safe.
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(signed),
            },
          ],
        }
      },
    },

    ghost_bazaar_settle: {
      description:
        "Prepare settlement via MoonPay — returns transfer parameters for the MoonPay token_transfer tool. " +
        "After calling this, use MoonPay's token_transfer with the returned parameters to execute the USDC payment, " +
        "then call ghost_bazaar_confirm_settlement with the transaction signature.",
      inputSchema: z.object({
        quote: z.record(z.unknown()).describe("The fully signed quote object"),
        moonpay_wallet: z.string().optional().describe("MoonPay wallet name to send from (default: 'ghost-bazaar')"),
      }),
      handler: async (input: { quote: Record<string, unknown>; moonpay_wallet?: string }) => {
        const quote = input.quote as any

        if (!quote.buyer_signature || !quote.seller_signature) {
          throw new Error("Quote must be fully signed (both buyer and seller) before settlement")
        }

        const sellerPubkey = didToPublicKey(quote.seller)
        if (!sellerPubkey) throw new Error("Cannot derive seller pubkey from DID")

        // Determine chain — use devnet if USDC mint is the devnet address
        const isMainnet = config.usdcMint === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
        const chain = isMainnet ? "solana" : "solana-devnet"
        const walletName = input.moonpay_wallet ?? "ghost-bazaar"

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                action: "moonpay_transfer",
                instruction: "Use MoonPay token_transfer with these parameters, then call ghost_bazaar_confirm_settlement with the tx signature",
                moonpay_transfer_params: {
                  wallet: walletName,
                  chain,
                  token: config.usdcMint,
                  amount: new Decimal(quote.final_price).toNumber(),
                  to: sellerPubkey.toBase58(),
                },
                quote_id: quote.quote_id,
                rfq_id: quote.rfq_id,
                final_price: quote.final_price,
                seller: quote.seller,
              }),
            },
          ],
        }
      },
    },

    ghost_bazaar_confirm_settlement: {
      description:
        "Confirm settlement after MoonPay token_transfer completes — POSTs the transaction signature to the seller's /execute endpoint for verification",
      inputSchema: z.object({
        rfq_id: z.string().describe("RFQ identifier"),
        tx_sig: z.string().describe("Transaction signature from MoonPay token_transfer"),
        quote: z.record(z.unknown()).describe("The fully signed quote object"),
      }),
      handler: async (input: { rfq_id: string; tx_sig: string; quote: Record<string, unknown> }) => {
        const quote = input.quote as any
        const startMs = Date.now()
      description: "Verify settlement — takes the Solana transaction signature from a MoonPay token_transfer and POSTs the seller's /execute endpoint for verification. Call MoonPay's token_transfer tool FIRST to send USDC, then pass the tx signature here.",
      inputSchema: z.object({
        quote: z.record(z.unknown()).describe("The fully signed quote object"),
        payment_signature: z.string().describe("Solana transaction signature from MoonPay token_transfer"),
      }),
      handler: async (input: { quote: Record<string, unknown>; payment_signature: string }) => {
        const quote = input.quote as any
        const txSig = input.payment_signature

        if (!txSig || txSig.length < 80) {
          throw new Error(
            "Invalid payment_signature. Use MoonPay's token_transfer tool first to send USDC, " +
            "then pass the returned transaction signature here.",
          )
        }

        // POST seller's /execute endpoint with required headers
        const startMs = Date.now()
        const quoteB64 = Buffer.from(JSON.stringify(quote)).toString("base64")
        const executeUrl = quote.payment_endpoint ?? `${config.engineUrl}/execute`

        const executeRes = await fetch(executeUrl, {
          method: "POST",
          headers: {
            "X-Ghost-Bazaar-Quote": quoteB64,
            "Payment-Signature": input.tx_sig,
            "Content-Type": "application/json",
          },
        })

        const settlementMs = Date.now() - startMs
        const isMainnet = config.usdcMint === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
        const clusterParam = isMainnet ? "" : "?cluster=devnet"
        const explorerLink = `https://explorer.solana.com/tx/${input.tx_sig}${clusterParam}`

        if (!executeRes.ok) {
          const errBody = await executeRes.json().catch(() => ({}))
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  tx_sig: input.tx_sig,
                  explorer_url: explorerLink,
                  settlement_ms: settlementMs,
                  settlement_error: errBody,
                }),
              },
            ],
          }
        }

        const receipt = await executeRes.json()
        const sellerRegistryAgentId = await resolveSellerRegistryAgentId(quote)

        const isPendingSeller = receipt?.delivery_status === "pending_seller"
        const feedbackSubmitted = isPendingSeller
          ? false
          : sellerRegistryAgentId
            ? await submitFeedback(sellerRegistryAgentId, String(quote.final_price ?? receipt?.receipt?.final_price ?? "0"), true)
            : false

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                tx_sig: input.tx_sig,
                explorer_url: explorerLink,
                settlement_ms: settlementMs,
                receipt,
                payment_verified: true,
                payment_method: "moonpay",
                service_delivered: !isPendingSeller,
                feedback_submitted: feedbackSubmitted,
                ...(isPendingSeller && {
                  note: "Payment verified on-chain via MoonPay. Seller notified via engine event. Use check_events to track.",
                }),
                seller_registry_agent_id: sellerRegistryAgentId,
              }),
            },
          ],
        }
      },
    },

    ghost_bazaar_buyer_feedback: {
      description: "Submit post-settlement reputation feedback to the 8004/ATOM system for a counterparty agent",
      inputSchema: z.object({
        counterparty_agent_id: z.string().describe("Counterparty 8004 agent ID"),
        success: z.boolean().describe("Whether the deal completed successfully"),
        settled_amount: z.string().describe("Final settled amount as a decimal string"),
        score: z.number().int().min(0).max(100).optional().describe("Optional explicit reputation score override"),
      }),
      handler: async (input: {
        counterparty_agent_id: string
        success: boolean
        settled_amount: string
        score?: number
      }) => {
        const submitted = await submitFeedback(
          input.counterparty_agent_id,
          input.settled_amount,
          input.success,
          input.score,
        )

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                counterparty_agent_id: input.counterparty_agent_id,
                success: input.success,
                settled_amount: input.settled_amount,
                feedback_submitted: submitted,
              }),
            },
          ],
        }
      },
    },
  }
}
