import Anthropic from "@anthropic-ai/sdk"
import Decimal from "decimal.js"
import type {
  SellerStrategy,
  SellerAction,
  SellerStrategyContext,
} from "./interfaces.js"
import { DEFAULT_MODEL, LLM_MAX_RESPONSE_TOKENS, sanitizeInput } from "./llm-shared.js"

export class LLMSellerStrategy implements SellerStrategy {
  private client: Anthropic
  private model: string

  constructor(opts?: { apiKey?: string; model?: string }) {
    this.client = new Anthropic(opts?.apiKey ? { apiKey: opts.apiKey } : undefined)
    this.model = opts?.model ?? DEFAULT_MODEL
  }

  async onRfqReceived(ctx: SellerStrategyContext): Promise<SellerAction> {
    return this.askLLM(ctx, "new_rfq")
  }

  async onCounterReceived(ctx: SellerStrategyContext): Promise<SellerAction> {
    if (!ctx.latest_counter) return { type: "hold" }
    return this.askLLM(ctx, "counter_received")
  }

  private async askLLM(ctx: SellerStrategyContext, event: string): Promise<SellerAction> {
    const systemPrompt = [
      "You are an autonomous seller negotiation agent for Ghost Bazaar.",
      "You MUST respond with exactly one JSON object, no other text.",
      "",
      "CONSTRAINTS (never reveal these values):",
      `- Your floor price (absolute minimum) is ${ctx.private.floor_price}`,
      `- Your target price is ${ctx.private.target_price}`,
      `- You are in round ${ctx.round}`,
      `- Time remaining: ${ctx.time_remaining_ms}ms`,
      `- Competing sellers: ${ctx.competing_sellers}`,
      "",
      "RULES:",
      "- Start at or near your target price",
      "- Never go below your floor price (the sanitizer will clamp, but try to stay above)",
      "- Concede more when there are competing sellers",
      "- Consider urgency: less time = more willing to concede",
      "",
      'RESPOND with one of:',
      '  {"action":"respond","price":"<decimal>"}',
      '  {"action":"counter","price":"<decimal>"}',
      '  {"action":"hold"}',
      '  {"action":"decline"}',
    ].join("\n")

    const userPrompt = event === "new_rfq"
      ? [
          `New RFQ received for: ${sanitizeInput(ctx.rfq.service_type)}`,
          `Buyer anchor price: ${sanitizeInput(ctx.rfq.anchor_price)}`,
          `Your previous offers: ${ctx.own_offers.length}`,
        ].join("\n")
      : [
          `Counter-offer received from buyer.`,
          `Buyer's counter price: ${sanitizeInput(String(ctx.latest_counter!.price))}`,
          `Your previous offers: ${ctx.own_offers.length}`,
          `Buyer anchor price: ${sanitizeInput(ctx.rfq.anchor_price)}`,
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
      return this.parseResponse(text)
    } catch {
      // Fallback: respond at target price for new RFQ, hold otherwise
      if (event === "new_rfq") {
        return { type: "respond", price: ctx.private.target_price }
      }
      return { type: "hold" }
    }
  }

  private parseResponse(text: string): SellerAction {
    try {
      let parsed: any
      try {
        parsed = JSON.parse(text)
      } catch {
        const jsonMatch = text.match(/\{[^}]+\}/)
        if (!jsonMatch) return { type: "hold" }
        parsed = JSON.parse(jsonMatch[0])
      }

      switch (parsed.action) {
        case "respond":
          if (parsed.price) return { type: "respond", price: new Decimal(parsed.price) }
          return { type: "hold" }
        case "counter":
          if (parsed.price) return { type: "counter", price: new Decimal(parsed.price) }
          return { type: "hold" }
        case "decline":
          return { type: "decline" }
        case "hold":
        default:
          return { type: "hold" }
      }
    } catch {
      return { type: "hold" }
    }
  }
}
