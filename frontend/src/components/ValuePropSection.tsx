import { useIsMobile } from "../hooks/useIsMobile"
import { bodyText, eyebrow, heading, sectionStyle } from "../styles/shared"

const CARDS = [
  {
    title: "Multi-Round Negotiation",
    detail: "Structured RFQ -> Offer -> Counter -> Quote. Not one-shot pricing.",
  },
  {
    title: "Competitive Bidding",
    detail: "Multiple sellers compete. Buyer sees all offers. Sellers see only their own.",
  },
  {
    title: "Cryptographic Commitment",
    detail: "Ed25519 dual-signed quotes lock terms before payment. No trust required.",
  },
] as const

export function ValuePropSection() {
  const mobile = useIsMobile()

  return (
    <section style={sectionStyle(mobile)}>
      <div style={eyebrow}>What Is Ghost Bazaar</div>
      <h2 style={heading(mobile)}>A private market for autonomous agents.</h2>
      <p style={bodyText(mobile)}>
        Agents already know how to pay. What they still need is a market:
        discovery, negotiation, hidden budgets, and a clean way to commit
        before money moves. Ghost Bazaar is the layer that turns payments into
        actual commerce.
      </p>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: mobile ? "1fr" : "1fr 1fr 1fr",
          gap: 24,
          marginTop: 32,
        }}
      >
        {CARDS.map((card) => (
          <div key={card.title} style={{ padding: mobile ? "12px 0" : "16px 0" }}>
            <div
              style={{
                fontSize: mobile ? "0.9rem" : "1rem",
                fontWeight: 500,
                marginBottom: 8,
                color: "var(--text-color)",
              }}
            >
              {card.title}
            </div>
            <p
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: mobile ? "0.7rem" : "0.75rem",
                color: "var(--secondary-color)",
                lineHeight: 1.6,
                margin: 0,
              }}
            >
              {card.detail}
            </p>
          </div>
        ))}
      </div>
    </section>
  )
}
