/**
 * SellerAgent — autonomous seller runtime for Ghost Bazaar negotiation.
 *
 * Responsibilities:
 * - Solana keypair = identity
 * - Polls /listings and event log
 * - Calls strategy.onRfqReceived(), strategy.onCounterReceived()
 * - Runs privacy sanitizer → safe action
 * - Fires HTTP protocol actions (POST /offers, GET /quote, PUT /cosign, POST /decline)
 * - Records settled_at on execution
 */

import { v4 as uuidv4 } from "uuid"
import Decimal from "decimal.js"
import { Keypair } from "@solana/web3.js"
import {
  buildDid,
  objectSigningPayload,
  signEd25519,
  signQuoteAsSeller,
  type RFQ,
  type SellerOffer,
  type SignedQuote,
} from "@ghost-bazaar/core"
import {
  type SellerStrategy,
  type SellerPrivate,
  type SellerStrategyContext,
  type NegotiationEvent,
  type NegotiationProfile,
  sanitizeSellerAction,
} from "@ghost-bazaar/strategy"
import { EngineClient } from "./engine-client.js"
import {
  registerAgent,
  recordDealFeedback,
  type RegistryConfig,
  type RegisteredAgent,
} from "./registry.js"

export interface SellerAgentConfig {
  keypair: Keypair
  strategy: SellerStrategy
  floorPrice: string
  targetPrice: string
  engineUrl: string
  /** The listing_id for this seller's registered listing. Required for offers. */
  listingId: string
  listingProfile?: NegotiationProfile
  /** If provided, agent will register in 8004 Agent Registry on startup. */
  registryConfig?: {
    pinataJwt?: string
    name?: string
    description?: string
    serviceType?: string
    paymentEndpoint?: string
  }
}

export interface SellerAgentSession {
  rfqId: string
  rfq: RFQ
  ownOffers: SellerOffer[]
  events: NegotiationEvent[]
  round: number
  lastEventId?: string | number
  settledAt: number | null
  quote: SignedQuote | null
  stopped: boolean
}

export class SellerAgent {
  readonly did: string
  private readonly keypair: Keypair
  private readonly strategy: SellerStrategy
  private readonly priv: SellerPrivate
  private readonly engine: EngineClient
  private readonly listingId: string
  private readonly listingProfile: NegotiationProfile | null
  private readonly registryConfig: SellerAgentConfig["registryConfig"]
  private registeredAgent: RegisteredAgent | null = null
  private sessions = new Map<string, SellerAgentSession>()

  constructor(config: SellerAgentConfig) {
    this.keypair = config.keypair
    this.did = buildDid(config.keypair.publicKey)
    this.strategy = config.strategy
    this.priv = {
      floor_price: new Decimal(config.floorPrice),
      target_price: new Decimal(config.targetPrice),
    }
    this.engine = new EngineClient({ baseUrl: config.engineUrl, keypair: config.keypair })
    this.listingId = config.listingId
    this.listingProfile = config.listingProfile ?? null
    this.registryConfig = config.registryConfig
  }

  /** Respond to an RFQ that this seller wants to participate in. */
  async respondToRfq(rfq: RFQ): Promise<SellerAgentSession> {
    const session: SellerAgentSession = {
      rfqId: rfq.rfq_id,
      rfq,
      ownOffers: [],
      events: [],
      round: 0,
      settledAt: null,
      quote: null,
      stopped: false,
    }
    this.sessions.set(rfq.rfq_id, session)

    // Build strategy context for initial offer
    const ctx = this.buildContext(session, null)
    const action = await this.strategy.onRfqReceived(ctx)
    const safeAction = sanitizeSellerAction(action, this.priv)

    if (safeAction.type === "respond") {
      await this.sendOffer(session, safeAction.price)
    } else if (safeAction.type === "decline") {
      session.stopped = true
    }

    return session
  }

  /** Run one poll cycle: fetch events, apply strategy, fire actions. */
  async poll(rfqId: string): Promise<void> {
    const session = this.sessions.get(rfqId)
    if (!session || session.stopped) return

    const newEvents = await this.engine.getEvents(rfqId, session.lastEventId)
    if (newEvents.length === 0) return

    for (const event of newEvents) {
      session.events.push(event)
      session.lastEventId = event.event_id

      // Handle counter-offer from buyer
      if (event.event_type === "counter" && event.actor !== this.did) {
        session.round++
        const ctx = this.buildContext(session, event)
        const action = await this.strategy.onCounterReceived(ctx)
        const safeAction = sanitizeSellerAction(action, this.priv)

        switch (safeAction.type) {
          case "respond":
          case "counter":
            await this.sendOffer(session, safeAction.price)
            break
          case "decline":
            session.stopped = true
            break
          case "hold":
            break
        }
      }

      // Handle quote ready for cosigning
      if (event.event_type === "quote_ready" || event.event_type === "buyer_signed") {
        try {
          const quote = await this.engine.getQuote(rfqId)
          if (quote && quote.buyer_signature && !quote.seller_signature) {
            const cosigned = await signQuoteAsSeller(quote, this.keypair)
            await this.engine.cosignQuote(rfqId, cosigned.seller_signature)
            session.quote = cosigned
            // NOTE: settledAt is set in markSettled(), NOT here.
            // Cosigning is commitment, not settlement — settlement happens
            // after service execution on the /execute endpoint.
          }
        } catch {
          // Quote may not be ready yet; will retry on next poll
        }
      }
    }
  }

  /** Start polling loop. Returns a stop function. */
  startPolling(rfqId: string, intervalMs = 500): () => void {
    const timer = setInterval(() => this.poll(rfqId), intervalMs)
    return () => {
      clearInterval(timer)
      const session = this.sessions.get(rfqId)
      if (session) session.stopped = true
    }
  }

  getSession(rfqId: string): SellerAgentSession | undefined {
    return this.sessions.get(rfqId)
  }

  /**
   * Respond to multiple RFQs at once.
   * Note: The engine has no GET /rfqs endpoint — sellers receive RFQs
   * through their negotiation_endpoint or external signaling.
   */
  async respondToRfqs(rfqs: RFQ[]): Promise<SellerAgentSession[]> {
    const sessions: SellerAgentSession[] = []
    for (const rfq of rfqs) {
      if (!this.sessions.has(rfq.rfq_id)) {
        const session = await this.respondToRfq(rfq)
        sessions.push(session)
      }
    }
    return sessions
  }

  /** Mark a session as settled (call after service execution, not at cosign). */
  markSettled(rfqId: string): void {
    const session = this.sessions.get(rfqId)
    if (session) session.settledAt = Date.now()
  }

  /** Register in 8004 Agent Registry (optional, call at startup). */
  async register(): Promise<RegisteredAgent | null> {
    if (!this.registryConfig) return null
    try {
      this.registeredAgent = await registerAgent(
        { signer: this.keypair, pinataJwt: this.registryConfig.pinataJwt },
        {
          name: this.registryConfig.name ?? `Ghost Bazaar Seller — ${this.did.slice(0, 20)}`,
          description: this.registryConfig.description ?? "Autonomous seller agent",
          negotiationEndpoint: this.engine["baseUrl"],
          paymentEndpoint: this.registryConfig.paymentEndpoint,
          serviceType: this.registryConfig.serviceType,
        },
      )
      return this.registeredAgent
    } catch {
      return null
    }
  }

  /** Record post-settlement reputation feedback for the buyer. */
  async recordSettlementFeedback(
    buyerAgentId: bigint,
    success: boolean,
    settledAmount: string,
  ): Promise<void> {
    if (!this.registryConfig) return
    try {
      await recordDealFeedback(
        { signer: this.keypair, pinataJwt: this.registryConfig.pinataJwt },
        buyerAgentId,
        { success, settledAmount },
      )
    } catch {
      // Best-effort — don't fail the settlement flow
    }
  }

  getRegisteredAgent(): RegisteredAgent | null {
    return this.registeredAgent
  }

  // ── Private helpers ──

  private async sendOffer(session: SellerAgentSession, price: Decimal): Promise<void> {
    const offer: SellerOffer = {
      offer_id: uuidv4(),
      rfq_id: session.rfqId,
      seller: this.did,
      listing_id: this.listingId,
      price: price.toString(),
      currency: "USDC",
      valid_until: session.rfq.deadline,
      signature: "",
    }

    const payload = objectSigningPayload(offer as unknown as Record<string, unknown>)
    offer.signature = await signEd25519(payload, this.keypair)

    await this.engine.postOffer(session.rfqId, offer)
    session.ownOffers.push(offer)
  }

  private buildContext(session: SellerAgentSession, latestEvent: NegotiationEvent | null): SellerStrategyContext {
    const deadlineMs = Date.parse(session.rfq.deadline)
    const latestCounter = latestEvent?.event_type === "counter"
      ? latestEvent.payload as any
      : null

    // Count distinct sellers from events
    const sellerDids = new Set<string>()
    for (const event of session.events) {
      if (event.event_type === "offer" && event.actor !== this.did) {
        sellerDids.add(event.actor)
      }
    }

    return {
      rfq: session.rfq,
      private: this.priv,
      latest_counter: latestCounter,
      own_offers: session.ownOffers,
      round: session.round,
      time_remaining_ms: Math.max(0, deadlineMs - Date.now()),
      competing_sellers: sellerDids.size,
      seller_listing_profile: this.listingProfile,
    }
  }
}
