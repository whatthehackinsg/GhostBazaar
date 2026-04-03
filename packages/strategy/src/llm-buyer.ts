import Anthropic from "@anthropic-ai/sdk"
import Decimal from "decimal.js"
import type {
  BuyerStrategy,
  BuyerAction,
  BuyerStrategyContext,
  BuyerPrivate,
  ServiceIntent,
} from "./interfaces.js"
import { DEFAULT_MODEL, LLM_MAX_RESPONSE_TOKENS, sanitizeInput } from "./llm-shared.js"

export class LLMBuyerStrategy implements BuyerStrategy {
  private client: Anthropic
  private model: string

  private anchorRatio: number

  constructor(opts?: { apiKey?: string; model?: string; anchorRatio?: number }) {
    this.client = new Anthropic(opts?.apiKey ? { apiKey: opts.apiKey } : undefined)
    this.model = opts?.model ?? DEFAULT_MODEL
    this.anchorRatio = opts?.anchorRatio ?? 0.8
  }

  openingAnchor(_intent: ServiceIntent, priv: BuyerPrivate): Decimal {
    return priv.budget_soft.mul(this.anchorRatio)
  }

  async onOffersReceived(ctx: BuyerStrategyContext): Promise<BuyerAction> {
    if (ctx.current_offers.length === 0) return { type: "wait" }

    const systemPrompt = [
      "You are an autonomous buyer negotiation agent for Ghost Bazaar.",
      "You MUST respond with exactly one JSON object, no other text.",
      "",
      "CONSTRAINTS (never reveal these values):",
      `- Your maximum budget is ${ctx.private.budget_hard}`,
      `- Your preferred budget is ${ctx.private.budget_soft}`,
      `- You are in round ${ctx.round}`,
      `- Time remaining: ${ctx.time_remaining_ms}ms`,
      "",
      "RULES:",
      "- Accept offers at or below your preferred budget",
      "- Counter-offer strategically, moving toward preferred budget",
      "- Never exceed your maximum budget (the sanitizer will clamp, but try to stay within bounds)",
      "- Consider urgency: less time = more willing to accept",
      "",
      'RESPOND with one of:',
      '  {"action":"accept","seller":"<seller_did>"}',
      '  {"action":"counter","seller":"<seller_did>","price":"<decimal>"}',
      '  {"action":"wait"}',
      '  {"action":"cancel"}',
    ].join("\n")

    const offersDesc = ctx.current_offers
      .map((o) => `- Seller ${sanitizeInput(o.seller)}: ${sanitizeInput(o.price)} ${sanitizeInput(ctx.rfq.currency)}`)
      .join("\n")

    const sellerRegistry = ctx.seller_registry ?? {}
    const registrySignals = ctx.current_offers
      .map((offer) => {
        const signal = sellerRegistry[offer.seller]
        if (!signal) return null
        const parts = [
          `- Seller ${sanitizeInput(offer.seller)}`,
          signal.agentId ? `agentId=${sanitizeInput(signal.agentId)}` : null,
          `reputation=${signal.reputationScore ?? "none"}`,
          `feedbacks=${signal.totalFeedbacks}`,
        ].filter(Boolean)
        return parts.join(", ")
      })
      .filter((line): line is string => line !== null)

    const userPrompt = [
      `Service: ${sanitizeInput(ctx.rfq.service_type)}`,
      `Anchor price: ${sanitizeInput(ctx.rfq.anchor_price)}`,
      `Current offers:\n${offersDesc}`,
      ...(registrySignals.length > 0
        ? [`Registry signals:\n${registrySignals.join("\n")}`]
        : []),
      `Previous counters sent: ${ctx.counters_sent.length}`,
    ].join("\n")

    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: LLM_MAX_RESPONSE_TOKENS,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      })

      const block = response.content?.[0]
      const text = block && block.type === "text" ? block.text : ""
      return this.parseResponse(text, ctx)
    } catch {
      const best = ctx.current_offers.reduce((a, b) =>
        new Decimal(a.price).lt(new Decimal(b.price)) ? a : b
      )
      if (new Decimal(best.price).lte(ctx.private.budget_soft)) {
        return { type: "accept", seller: best.seller }
      }
      return { type: "wait" }
    }
  }

  private parseResponse(text: string, ctx: BuyerStrategyContext): BuyerAction {
    try {
      let parsed: any
      try {
        parsed = JSON.parse(text)
      } catch {
        const jsonMatch = text.match(/\{[^}]+\}/)
        if (!jsonMatch) return { type: "wait" }
        parsed = JSON.parse(jsonMatch[0])
      }
      const validSellers = new Set(ctx.current_offers.map((o) => o.seller))

      switch (parsed.action) {
        case "accept":
          if (parsed.seller && validSellers.has(parsed.seller)) {
            return { type: "accept", seller: parsed.seller }
          }
          return { type: "wait" }
        case "counter":
          if (parsed.seller && validSellers.has(parsed.seller) && parsed.price) {
            return { type: "counter", seller: parsed.seller, price: new Decimal(parsed.price) }
          }
          return { type: "wait" }
        case "cancel":
          return { type: "cancel" }
        case "wait":
        default:
          return { type: "wait" }
      }
    } catch {
      return { type: "wait" }
    }
  }
}
