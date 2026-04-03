import { MoonPayMark } from "./MoonPayMark"
import { bodyText, eyebrow, heading, sectionStyle } from "../styles/shared"
import { useIsMobile } from "../hooks/useIsMobile"

const USE_CASES = [
  {
    title: "GPU Compute Rental",
    detail: "Spot pricing fluctuates 10x daily. Agents negotiate the right rate before they lock scarce capacity.",
  },
  {
    title: "Dataset Access",
    detail: "Proprietary data can price by recency, breadth, or query complexity. Buyers negotiate per-access instead of paying the highest list price.",
  },
  {
    title: "Security Audits",
    detail: "Audit scope changes contract to contract. Negotiation prevents simple reviews from getting priced like emergency incident response.",
  },
  {
    title: "API Monetization",
    detail: "Providers compete on latency, reliability, and usage tiers while the buyer agent settles only after the quote is signed.",
  },
] as const

const BENEFITS = [
  "Spend policies — per-session and per-vendor budget caps",
  "Multi-chain settlement — one wallet, any chain",
  "Audit trails — every negotiation logged, every payment traceable",
] as const

export function OWSSection() {
  const mobile = useIsMobile()

  return (
    <section style={sectionStyle(mobile)}>
      <div style={eyebrow}>OWS Wallet Layer</div>
      <h2 style={heading(mobile)}>Extending x402 for the Autonomous Economy.</h2>
      <p style={bodyText(mobile)}>
        x402 enables single-shot HTTP payments. Ghost Bazaar adds what high-value
        agent commerce is missing: multi-round negotiation, competitive bidding,
        and ZK-private budgets so autonomous buyers stop overpaying when markets
        move faster than a fixed price can.
      </p>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: mobile ? "1fr" : "1fr 1fr",
          gap: mobile ? 16 : 20,
          marginTop: 32,
        }}
      >
        {USE_CASES.map((useCase) => (
          <article
            key={useCase.title}
            style={{
              padding: mobile ? 18 : 22,
              border: "1px solid var(--hairline)",
              borderRadius: 16,
              background: "linear-gradient(180deg, color-mix(in srgb, var(--bg-elevated) 82%, transparent), transparent)",
              minHeight: mobile ? undefined : 180,
            }}
          >
            <div
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "0.62rem",
                letterSpacing: "0.18em",
                textTransform: "uppercase",
                color: "var(--secondary-color)",
                marginBottom: 14,
              }}
            >
              Use Case
            </div>
            <h3
              style={{
                fontSize: mobile ? "1rem" : "1.1rem",
                fontWeight: 500,
                color: "var(--text-color)",
                marginBottom: 10,
              }}
            >
              {useCase.title}
            </h3>
            <p
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: mobile ? "0.72rem" : "0.76rem",
                lineHeight: 1.7,
                color: "var(--secondary-color)",
              }}
            >
              {useCase.detail}
            </p>
          </article>
        ))}
      </div>

      <div
        style={{
          marginTop: 32,
          padding: mobile ? 18 : 24,
          border: "1px solid var(--hairline)",
          borderRadius: 18,
          background: "var(--bg-elevated)",
          display: "grid",
          gridTemplateColumns: mobile ? "1fr" : "1.2fr 1fr",
          gap: mobile ? 20 : 28,
          alignItems: "start",
        }}
      >
        <div>
          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "0.62rem",
              letterSpacing: "0.18em",
              textTransform: "uppercase",
              color: "var(--secondary-color)",
              marginBottom: 14,
            }}
          >
            OWS + MoonPay
          </div>
          <p
            style={{
              fontSize: mobile ? "0.95rem" : "1.05rem",
              lineHeight: 1.6,
              color: "var(--text-color)",
              maxWidth: 560,
            }}
          >
            With OWS wallets via MoonPay, every agent gets identity, policy
            rails, and a wallet surface that fits a multi-step commercial flow
            instead of a single payment prompt.
          </p>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <MoonPayMark compact={mobile} />
          <div
            style={{
              display: "grid",
              gap: 10,
            }}
          >
            {BENEFITS.map((benefit) => (
              <div
                key={benefit}
                style={{
                  display: "flex",
                  gap: 10,
                  alignItems: "flex-start",
                  fontFamily: "var(--font-mono)",
                  fontSize: mobile ? "0.7rem" : "0.74rem",
                  lineHeight: 1.7,
                  color: "var(--secondary-color)",
                }}
              >
                <span style={{ color: "var(--text-color)" }}>•</span>
                <span>{benefit}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}
