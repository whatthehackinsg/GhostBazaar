/**
 * BuyerAgent — autonomous buyer runtime for Ghost Bazaar negotiation.
 *
 * Responsibilities:
 * - Solana keypair = identity
 * - Polls /rfqs/:id/events every 500ms with ?after= cursor
 * - Calls strategy.onOffersReceived() → BuyerAction
 * - Runs privacy sanitizer → safe action
 * - Calls zk.generateBudgetProof() before every counter POST
 * - Fires HTTP protocol actions
 * - Records negotiation_committed_at for settlement timer
 */

import { randomBytes } from "crypto"
import { v4 as uuidv4 } from "uuid"
import Decimal from "decimal.js"
import { Keypair } from "@solana/web3.js"
import {
  buildDid,
  objectSigningPayload,
  signEd25519,
  type RFQ,
  type SellerOffer,
  type CounterOffer,
  type SignedQuote,
} from "@ghost-bazaar/core"
import {
  type BuyerStrategy,
  type BuyerPrivate,
  type BuyerStrategyContext,
  type NegotiationEvent,
  sanitizeBuyerAction,
} from "@ghost-bazaar/strategy"
import { EngineClient } from "./engine-client.js"
import {
  registerAgent,
  recordDealFeedback,
  type RegistryConfig,
  type RegisteredAgent,
} from "./registry.js"

export interface BuyerAgentConfig {
  keypair: Keypair
  strategy: BuyerStrategy
  budgetSoft: string
  budgetHard: string
  engineUrl: string
  /** If provided, ZK proofs will be generated for counters. */
  zkProver?: ZkProver
  /** If provided, agent will register in 8004 Agent Registry on startup. */
  registryConfig?: {
    pinataJwt?: string
    name?: string
    description?: string
  }
}

export interface ZkProver {
  generateBudgetCommitment(budgetHard: string, salt: bigint): Promise<string>
  generateBudgetProof(counterPrice: string, budgetHard: string, salt: bigint): Promise<any>
}

export interface BuyerAgentSession {
  rfqId: string
  rfq: RFQ
  offers: SellerOffer[]
  countersSent: CounterOffer[]
  events: NegotiationEvent[]
  round: number
  lastEventId?: string | number
  committedAt: number | null
  quote: SignedQuote | null
  stopped: boolean
}

export class BuyerAgent {
  readonly did: string
  private readonly keypair: Keypair
  private readonly strategy: BuyerStrategy
  private readonly priv: BuyerPrivate
  private readonly engine: EngineClient
  private readonly zkProver: ZkProver | undefined
  private readonly commitmentSalt: bigint
  private readonly registryConfig: BuyerAgentConfig["registryConfig"]
  private registeredAgent: RegisteredAgent | null = null
  private sessions = new Map<string, BuyerAgentSession>()

  constructor(config: BuyerAgentConfig) {
    this.keypair = config.keypair
    this.did = buildDid(config.keypair.publicKey)
    this.strategy = config.strategy
    this.priv = {
      budget_soft: new Decimal(config.budgetSoft),
      budget_hard: new Decimal(config.budgetHard),
    }
    this.engine = new EngineClient({ baseUrl: config.engineUrl, keypair: config.keypair })
    this.zkProver = config.zkProver
    this.registryConfig = config.registryConfig
    // Random 254-bit field element, kept local for session lifetime
    this.commitmentSalt = BigInt("0x" + randomBytes(31).toString("hex"))
  }

  /** Post an RFQ and start the negotiation polling loop. */
  async postRfq(params: {
    serviceType: string
    spec: Record<string, unknown>
    anchorPrice: string
    deadlineSeconds: number
  }): Promise<BuyerAgentSession> {
    const budgetCommitment = this.zkProver
      ? await this.zkProver.generateBudgetCommitment(this.priv.budget_hard.toString(), this.commitmentSalt)
      : undefined

    const rfq: RFQ = {
      rfq_id: uuidv4(),
      protocol: "ghost-bazaar-v4",
      buyer: this.did,
      service_type: params.serviceType,
      spec: params.spec,
      anchor_price: params.anchorPrice,
      currency: "USDC",
      deadline: new Date(Date.now() + params.deadlineSeconds * 1000).toISOString(),
      signature: "",
      budget_commitment: budgetCommitment,
    }

    // Sign RFQ
    const payload = objectSigningPayload(rfq as unknown as Record<string, unknown>)
    rfq.signature = await signEd25519(payload, this.keypair)

    await this.engine.postRfq(rfq)

    const session: BuyerAgentSession = {
      rfqId: rfq.rfq_id,
      rfq,
      offers: [],
      countersSent: [],
      events: [],
      round: 0,
      committedAt: null,
      quote: null,
      stopped: false,
    }
    this.sessions.set(rfq.rfq_id, session)
    return session
  }

  /** Run one poll cycle: fetch events, apply strategy, fire actions. */
  async poll(rfqId: string): Promise<void> {
    const session = this.sessions.get(rfqId)
    if (!session || session.stopped) return

    // Fetch new events with cursor
    const newEvents = await this.engine.getEvents(rfqId, session.lastEventId)
    if (newEvents.length === 0) return

    // Process events
    for (const event of newEvents) {
      session.events.push(event)
      session.lastEventId = event.event_id

      if (event.event_type === "offer" && event.payload) {
        const offer = event.payload as SellerOffer
        const existing = session.offers.find((o) => o.offer_id === offer.offer_id)
        if (!existing) session.offers.push(offer)
      }

      if (event.event_type === "quote_committed") {
        session.committedAt = Date.now()
        session.quote = event.payload as SignedQuote
      }
    }

    // Skip strategy if no offers yet or already committed
    if (session.offers.length === 0 || session.quote) return

    // Build strategy context
    const deadlineMs = Date.parse(session.rfq.deadline)
    const timeRemainingMs = Math.max(0, deadlineMs - Date.now())

    const ctx: BuyerStrategyContext = {
      rfq: session.rfq,
      private: this.priv,
      current_offers: session.offers,
      seller_registry: {},
      counters_sent: session.countersSent,
      round: session.round,
      time_remaining_ms: timeRemainingMs,
      history: session.events,
    }

    const action = await this.strategy.onOffersReceived(ctx)
    const safeAction = sanitizeBuyerAction(action, this.priv)

    // Execute action
    switch (safeAction.type) {
      case "counter": {
        // Deadline guard: skip counter if < 500ms remaining
        if (timeRemainingMs < 500) break

        session.round++

        const counter: CounterOffer = {
          counter_id: uuidv4(),
          rfq_id: rfqId,
          round: session.round,
          from: this.did,
          to: safeAction.seller,
          price: safeAction.price.toString(),
          currency: "USDC",
          valid_until: session.rfq.deadline,
          signature: "",
        }

        // Generate ZK proof if budget commitment was provided
        if (session.rfq.budget_commitment && this.zkProver) {
          counter.budget_proof = await this.zkProver.generateBudgetProof(
            safeAction.price.toString(),
            this.priv.budget_hard.toString(),
            this.commitmentSalt,
          )
        }

        // Sign counter
        const counterPayload = objectSigningPayload(counter as unknown as Record<string, unknown>)
        counter.signature = await signEd25519(counterPayload, this.keypair)

        await this.engine.postCounter(rfqId, counter)
        session.countersSent.push(counter)
        break
      }

      case "accept": {
        // Find the best offer from the target seller
        const targetOffer = session.offers.find((o) => o.seller === safeAction.seller)
        if (!targetOffer) break

        const lastEventId = String(session.lastEventId ?? "0")
        const unsignedQuote = await this.engine.accept(rfqId, safeAction.seller, targetOffer.offer_id, lastEventId)
        session.committedAt = Date.now()

        // Sign quote as buyer and send just the signature
        const { signQuoteAsBuyer } = await import("@ghost-bazaar/core")
        const buyerSigned = await signQuoteAsBuyer(unsignedQuote, this.keypair)
        await this.engine.signQuote(rfqId, buyerSigned.buyer_signature)
        session.quote = buyerSigned
        break
      }

      case "cancel":
        session.stopped = true
        break

      case "wait":
        break
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

  getSession(rfqId: string): BuyerAgentSession | undefined {
    return this.sessions.get(rfqId)
  }

  /** Register in 8004 Agent Registry (optional, call at startup). */
  async register(): Promise<RegisteredAgent | null> {
    if (!this.registryConfig) return null
    try {
      this.registeredAgent = await registerAgent(
        { signer: this.keypair, pinataJwt: this.registryConfig.pinataJwt },
        {
          name: this.registryConfig.name ?? `Ghost Bazaar Buyer — ${this.did.slice(0, 20)}`,
          description: this.registryConfig.description ?? "Autonomous buyer agent",
          negotiationEndpoint: this.engine["baseUrl"],
        },
      )
      return this.registeredAgent
    } catch {
      // Registration is optional — don't block the agent
      return null
    }
  }

  /** Record post-settlement reputation feedback for a seller. */
  async recordSettlementFeedback(
    sellerAgentId: bigint,
    success: boolean,
    settledAmount: string,
  ): Promise<void> {
    if (!this.registryConfig) return
    try {
      await recordDealFeedback(
        { signer: this.keypair, pinataJwt: this.registryConfig.pinataJwt },
        sellerAgentId,
        { success, settledAmount },
      )
    } catch {
      // Feedback is best-effort — don't fail the settlement flow
    }
  }

  getRegisteredAgent(): RegisteredAgent | null {
    return this.registeredAgent
  }
}
