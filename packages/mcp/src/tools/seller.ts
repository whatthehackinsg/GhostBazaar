/**
 * MCP seller tools — exposed to Claude Code / MCP-compatible agents.
 *
 * Privacy: floor_price and target_price are accepted as input but NEVER appear in tool output.
 */

import { z } from "zod"
import Decimal from "decimal.js"
import { v4 as uuidv4 } from "uuid"
import { buildDid, objectSigningPayload, signEd25519, signQuoteAsSeller } from "@ghost-bazaar/core"
import {
  sanitizeSellerAction,
  FirmSeller,
  FlexibleSeller,
  CompetitiveSeller,
  type SellerPrivate,
  type SellerStrategy,
  type SellerStrategyContext,
  type NegotiationProfile,
} from "@ghost-bazaar/strategy"
import { EngineClient, recordDealFeedback, registerAgent, type RegisteredAgent } from "@ghost-bazaar/agents"
import type { McpConfig } from "../config.js"

export interface SellerSessionState {
  rfqId: string
  floorPrice: string
  targetPrice: string
  round: number
  strategyStyle: "firm" | "flexible" | "competitive" | "deadline-sensitive"
}

export interface SellerState {
  /** Per-RFQ private state. floor_price/target_price MUST NOT leave this map. */
  sessions: Map<string, SellerSessionState>
  registeredAgent: RegisteredAgent | null
  registrationAttempted: boolean
}

export function createSellerState(): SellerState {
  return {
    sessions: new Map(),
    registeredAgent: null,
    registrationAttempted: false,
  }
}

function buildStrategy(style: string): SellerStrategy {
  switch (style) {
    case "firm":
      return new FirmSeller()
    case "flexible":
      return new FlexibleSeller()
    case "competitive":
      return new CompetitiveSeller()
    default:
      return new FlexibleSeller()
  }
}

export function defineSellerTools(config: McpConfig, state: SellerState = createSellerState()) {
  const engine = new EngineClient({ baseUrl: config.engineUrl, keypair: config.keypair })
  const did = buildDid(config.keypair.publicKey)
  // Tracks the seller's registered listing_id (set by ghost_bazaar_register_listing)
  let sellerListingId: string | undefined
  let sellerNegotiationProfile: NegotiationProfile | undefined

  async function ensureSellerRegistered(params: {
    serviceType: string
    negotiationProfileStyle?: "firm" | "flexible" | "competitive" | "deadline-sensitive"
  }): Promise<RegisteredAgent | null> {
    if (state.registeredAgent) return state.registeredAgent
    if (state.registrationAttempted || !config.pinataJwt) return null

    state.registrationAttempted = true
    try {
      state.registeredAgent = await registerAgent(
        { signer: config.keypair, pinataJwt: config.pinataJwt, rpcUrl: config.rpcUrl },
        {
          name: `Ghost Bazaar Seller — ${did.slice(0, 20)}`,
          description: "Autonomous seller agent using the Ghost Bazaar MCP toolchain",
          negotiationEndpoint: config.engineUrl,
          paymentEndpoint: `${config.engineUrl}/execute`,
          serviceType: params.serviceType,
          negotiationProfile: params.negotiationProfileStyle,
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

  return {
    ghost_bazaar_register_listing: {
      description: "Register a new seller listing on the negotiation engine",
      inputSchema: z.object({
        title: z.string().describe("Listing title"),
        category: z.string().describe("Service category"),
        service_type: z.string().describe("Service type identifier"),
        base_terms: z.record(z.unknown()).describe("Base terms for the service"),
        floor_price: z.string().describe("Minimum acceptable price — PRIVATE, never revealed (decimal string, e.g. '30.00')"),
        target_price: z.string().describe("Ideal selling price — PRIVATE, never revealed (decimal string, e.g. '55.00')"),
        registry_agent_id: z
          .string()
          .optional()
          .describe("Existing 8004 registry agent ID. If omitted and PINATA_JWT is configured, MCP auto-registers this seller."),
        negotiation_profile: z
          .object({
            style: z.enum(["firm", "flexible", "competitive", "deadline-sensitive"]),
            max_rounds: z.number().optional(),
            accepts_counter: z.boolean().optional(),
          })
          .optional()
          .describe("Negotiation behavior profile — determines strategy: firm (5%/round), flexible (25%/round), competitive (adapts to competition)"),
      }),
      handler: async (input: {
        title: string
        category: string
        service_type: string
        base_terms: Record<string, unknown>
        floor_price: string
        target_price: string
        registry_agent_id?: string
        negotiation_profile?: {
          style: "firm" | "flexible" | "competitive" | "deadline-sensitive"
          max_rounds?: number
          accepts_counter?: boolean
        }
      }) => {
        const listingId = uuidv4()
        const profileStyle = input.negotiation_profile?.style ?? "flexible"

        // Store the negotiation profile for later use
        sellerNegotiationProfile = input.negotiation_profile ?? { style: profileStyle }

        const autoRegisteredAgent = input.registry_agent_id
          ? null
          : await ensureSellerRegistered({
              serviceType: input.service_type,
              negotiationProfileStyle: profileStyle,
            })
        const listing = await engine.createListing({
          listing_id: listingId,
          seller: did,
          title: input.title,
          category: input.category,
          service_type: input.service_type,
          negotiation_endpoint: config.engineUrl,
          payment_endpoint: `${config.engineUrl}/execute`,
          base_terms: input.base_terms,
          registry_agent_id: input.registry_agent_id ?? autoRegisteredAgent?.agentId.toString(),
          negotiation_profile: input.negotiation_profile,
        } as any)

        sellerListingId = listing.listing_id ?? listingId

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                listing_id: listing.listing_id,
                seller: did,
                strategy: profileStyle,
                registry_agent_id: listing.registry_agent_id ?? autoRegisteredAgent?.agentId.toString(),
              }),
            },
          ],
        }
      },
    },

    ghost_bazaar_get_rfqs: {
      description: "Get open RFQs from the engine. Filter by listing_id to see RFQs relevant to your listing, or by status to see only open ones.",
      inputSchema: z.object({
        service_type: z.string().optional().describe("Filter by service type"),
        listing_id: z.string().optional().describe("Filter to RFQs targeting your listing"),
        status: z.string().optional().describe("Filter by status (e.g. 'open')"),
      }),
      handler: async (input: { service_type?: string; listing_id?: string; status?: string }) => {
        const rfqs = await engine.getRfqs({
          serviceType: input.service_type,
          listingId: input.listing_id ?? sellerListingId,
          status: input.status,
        })
        return { content: [{ type: "text" as const, text: JSON.stringify(rfqs, null, 2) }] }
      },
    },

    ghost_bazaar_respond_offer: {
      description:
        "Submit an offer in response to an RFQ. Uses the seller strategy to suggest a price if not provided. " +
        "Price is sanitized against floor_price — you can never accidentally underbid.",
      inputSchema: z.object({
        rfq_id: z.string().describe("RFQ identifier"),
        price: z.string().optional().describe("Offer price (decimal string). If omitted, the strategy suggests one based on target_price."),
        floor_price: z.string().optional().describe("Floor price override for this RFQ — PRIVATE (decimal string). Uses listing default if omitted."),
        target_price: z.string().optional().describe("Target price override for this RFQ — PRIVATE (decimal string). Uses listing default if omitted."),
        listing_id: z.string().optional().describe("Your listing ID (auto-filled if you registered one)"),
      }),
      handler: async (input: { rfq_id: string; price?: string; floor_price?: string; target_price?: string; listing_id?: string }) => {
        const listingId = input.listing_id ?? sellerListingId
        if (!listingId) throw new Error("No listing_id — register a listing first with ghost_bazaar_register_listing")

        // Resolve private pricing constraints
        const session = state.sessions.get(input.rfq_id)
        const floorPrice = input.floor_price ?? session?.floorPrice ?? input.price
        const targetPrice = input.target_price ?? session?.targetPrice ?? input.price

        if (!floorPrice || !targetPrice) {
          throw new Error("floor_price and target_price are required — provide them here or in ghost_bazaar_register_listing")
        }

        const priv: SellerPrivate = {
          floor_price: new Decimal(floorPrice),
          target_price: new Decimal(targetPrice),
        }

        const strategyStyle = session?.strategyStyle ?? sellerNegotiationProfile?.style ?? "flexible"

        // If no price given, let the strategy decide
        let offerPrice: string
        if (input.price) {
          // Sanitize the agent's chosen price against floor
          const rawAction = { type: "respond" as const, price: new Decimal(input.price) }
          const safeAction = sanitizeSellerAction(rawAction, priv)
          if (safeAction.type === "respond") {
            const decimals = input.price.includes(".") ? input.price.split(".")[1]!.length : 0
            offerPrice = safeAction.price.toFixed(decimals)
          } else {
            offerPrice = input.price
          }
        } else {
          // Use strategy to compute initial offer (always starts at target_price)
          const strategy = buildStrategy(strategyStyle)
          const ctx: SellerStrategyContext = {
            rfq: {} as any, // RFQ details are not needed for onRfqReceived in rule-based strategies
            private: priv,
            latest_counter: null,
            own_offers: [],
            round: 0,
            time_remaining_ms: 300_000,
            competing_sellers: 0,
            seller_listing_profile: sellerNegotiationProfile ?? null,
          }
          const action = await strategy.onRfqReceived(ctx)
          const safeAction = sanitizeSellerAction(action, priv)
          offerPrice = (safeAction.type === "respond" || safeAction.type === "counter") ? safeAction.price.toString() : priv.target_price.toString()
        }

        // Store session state
        state.sessions.set(input.rfq_id, {
          rfqId: input.rfq_id,
          floorPrice,
          targetPrice,
          round: 0,
          strategyStyle,
        })

        // Use 5-minute validity — we can't read events before first offer
        // (engine restricts event access to participants only)
        const offer = {
          offer_id: uuidv4(),
          rfq_id: input.rfq_id,
          seller: did,
          listing_id: listingId,
          price: offerPrice,
          currency: "USDC",
          valid_until: new Date(Date.now() + 300_000).toISOString(),
          signature: "",
        }

        const payload = objectSigningPayload(offer as Record<string, unknown>)
        offer.signature = await signEd25519(payload, config.keypair)

        await engine.postOffer(input.rfq_id, offer as any)

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                offer_id: offer.offer_id,
                price: offerPrice,
                strategy_used: input.price ? "manual (sanitized)" : strategyStyle,
              }),
            },
          ],
        }
      },
    },

    ghost_bazaar_respond_counter: {
      description:
        "Respond to a buyer's counter-offer with a new price. Uses the seller strategy to compute a concession if price is not provided. " +
        "Price is sanitized against floor_price — you can never go below your floor.",
      inputSchema: z.object({
        rfq_id: z.string().describe("RFQ identifier"),
        counter_id: z.string().describe("Counter-offer ID being responded to"),
        price: z.string().optional().describe("Response price (decimal string). If omitted, the strategy computes a concession."),
      }),
      handler: async (input: { rfq_id: string; counter_id: string; price?: string }) => {
        const listingId = sellerListingId
        if (!listingId) throw new Error("No listing_id — register a listing first")

        const session = state.sessions.get(input.rfq_id)
        if (!session) throw new Error("No session for this RFQ — submit an initial offer first with ghost_bazaar_respond_offer")

        const priv: SellerPrivate = {
          floor_price: new Decimal(session.floorPrice),
          target_price: new Decimal(session.targetPrice),
        }

        // Increment round
        session.round++

        let offerPrice: string
        let strategyUsed: string

        if (input.price) {
          // Sanitize the agent's chosen price against floor
          const rawAction = { type: "counter" as const, price: new Decimal(input.price) }
          const safeAction = sanitizeSellerAction(rawAction, priv)
          offerPrice = (safeAction.type === "counter" || safeAction.type === "respond") ? safeAction.price.toString() : input.price
          strategyUsed = "manual (sanitized)"
        } else {
          // Use strategy to compute concession
          const strategy = buildStrategy(session.strategyStyle)

          // Fetch events to get the buyer's counter price and competing seller count
          let buyerCounterPrice: string | undefined
          let competingSellers = 0
          try {
            const events = await engine.getEvents(input.rfq_id)
            const counterEvent = events.find(
              (e) => e.event_type === "counter" && (e.payload as any)?.counter_id === input.counter_id,
            )
            if (counterEvent) {
              buyerCounterPrice = (counterEvent.payload as any)?.price
            }
            // Count distinct sellers who submitted offers
            const sellerSet = new Set<string>()
            for (const e of events) {
              if (e.event_type === "offer" && (e.payload as any)?.seller) {
                sellerSet.add((e.payload as any).seller)
              }
            }
            competingSellers = sellerSet.size
          } catch {
            // If events fail, proceed with defaults
          }

          const ctx: SellerStrategyContext = {
            rfq: {} as any,
            private: priv,
            latest_counter: buyerCounterPrice
              ? ({ price: buyerCounterPrice, counter_id: input.counter_id } as any)
              : null,
            own_offers: [],
            round: session.round,
            time_remaining_ms: 300_000,
            competing_sellers: competingSellers,
            seller_listing_profile: sellerNegotiationProfile ?? null,
          }

          const action = await strategy.onCounterReceived(ctx)
          const safeAction = sanitizeSellerAction(action, priv)

          if (safeAction.type === "decline") {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    action: "decline",
                    reason: "Strategy recommends declining this counter-offer",
                    round: session.round,
                  }),
                },
              ],
            }
          }

          if (safeAction.type === "hold") {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    action: "hold",
                    reason: "Strategy recommends holding — wait for a better counter",
                    round: session.round,
                  }),
                },
              ],
            }
          }

          offerPrice = safeAction.price.toString()
          strategyUsed = session.strategyStyle
        }

        const offer = {
          offer_id: uuidv4(),
          rfq_id: input.rfq_id,
          seller: did,
          listing_id: listingId,
          price: offerPrice,
          currency: "USDC",
          valid_until: new Date(Date.now() + 300_000).toISOString(),
          signature: "",
        }

        const payload = objectSigningPayload(offer as Record<string, unknown>)
        offer.signature = await signEd25519(payload, config.keypair)

        await engine.postOffer(input.rfq_id, offer as any)

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                offer_id: offer.offer_id,
                in_response_to: input.counter_id,
                price: offerPrice,
                round: session.round,
                strategy_used: strategyUsed,
              }),
            },
          ],
        }
      },
    },

    ghost_bazaar_check_events: {
      description: "Get the full negotiation event log for an RFQ",
      inputSchema: z.object({
        rfq_id: z.string().describe("RFQ identifier"),
      }),
      handler: async (input: { rfq_id: string }) => {
        const events = await engine.getEvents(input.rfq_id)
        return { content: [{ type: "text" as const, text: JSON.stringify(events, null, 2) }] }
      },
    },

    ghost_bazaar_cosign: {
      description: "Cosign a buyer-signed quote to finalize the deal. Call this after the buyer has accepted and signed — completes the COMMITTED state.",
      inputSchema: z.object({
        rfq_id: z.string().describe("RFQ identifier"),
      }),
      handler: async (input: { rfq_id: string }) => {
        // Fetch the buyer-signed quote from the engine
        const quote = await engine.getQuote(input.rfq_id)

        if (!quote || !quote.buyer_signature) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: "Quote not ready — buyer has not signed yet" }) }],
          }
        }

        if (quote.seller_signature) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ status: "already_cosigned", quote }) }],
          }
        }

        // Cosign with seller keypair
        const cosigned = await signQuoteAsSeller(quote, config.keypair)
        const committed = await engine.cosignQuote(input.rfq_id, cosigned.seller_signature)

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(committed),
            },
          ],
        }
      },
    },

    ghost_bazaar_seller_feedback: {
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
