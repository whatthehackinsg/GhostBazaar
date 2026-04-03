import { useIsMobile } from "../hooks/useIsMobile"
import { divider, eyebrow, heading, sectionStyle, bodyText } from "../styles/shared"
import { ArchitectureSection } from "./ArchitectureSection"
import { OriginSection } from "./OriginSection"
import { ProtocolSection } from "./ProtocolSection"
import { ValuePropSection } from "./ValuePropSection"
import { WhySolanaSection } from "./WhySolanaSection"
import { MoonPayMark } from "./MoonPayMark"

// --- Component ---

export function LandingContent() {
  const mobile = useIsMobile()

  return (
    <div>
      <ValuePropSection />

      <div style={divider} />

      <OriginSection />

      <div style={divider} />

      <ProtocolSection />

      <div style={divider} />

      <section id="section-privacy" style={sectionStyle(mobile)}>
        <div style={eyebrow}>Privacy</div>
        <h2 style={heading(mobile)}>
          Prove you can afford it.
          <br />
          Never say how much you have.
        </h2>
        <p style={bodyText(mobile)}>
          Two protections are always on. The third kicks in when you choose it.
        </p>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: mobile ? "1fr" : "1fr 1fr 1fr",
            gap: mobile ? 16 : 24,
            marginTop: 32,
          }}
        >
          <BadgePrivacyCard
            badge="ALWAYS ON"
            title="Privacy Sanitizer"
            detail="Every strategy output passes through a non-bypassable sanitizer. Buyer price is clamped to budget_hard. Seller price is floored at floor_price. It runs locally before strategy output becomes a protocol message."
            mobile={mobile}
          />
          <BadgePrivacyCard
            badge="ALWAYS ON"
            title="Seller Isolation"
            detail="Each seller sees only their own thread - the RFQ, their offers, counters addressed to them, and terminal events. No visibility into competing bids, other sellers' prices, or the buyer's private state."
            mobile={mobile}
          />
          <BadgePrivacyCard
            badge="OPT-IN"
            title="ZK Budget Proof"
            detail="Buyer publishes a Poseidon commitment to budget_hard in the RFQ. From that point, every counter-offer must carry a Groth16 proof that counter_price <= budget_hard. Sellers verify the proof without learning the budget."
            mobile={mobile}
          />
        </div>

        <div style={{ overflowX: "auto", marginTop: 32 }}>
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: mobile ? "0.7rem" : "0.8rem",
              fontFamily: "var(--font-mono)",
              whiteSpace: "nowrap",
            }}
          >
            <thead>
              <tr>
                {["Phase", "Sanitizer", "Seller Isolation", "ZK Proof"].map((label) => (
                  <th
                    key={label}
                    style={{
                      textAlign: "left",
                      padding: "8px 12px",
                      borderBottom: "1px solid var(--hairline)",
                      color: "var(--secondary-color)",
                      fontWeight: 500,
                      fontSize: "0.65rem",
                      textTransform: "uppercase",
                      letterSpacing: "0.1em",
                    }}
                  >
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[
                ["RFQ created", "●", "●", "commitment published if enabled"],
                ["Offer submitted", "●", "●", "-"],
                ["Counter sent", "●", "●", "proof required if commitment exists"],
                ["Quote signed", "●", "●", "-"],
                ["Settlement", "●", "●", "-"],
              ].map(([phase, sanitizer, isolation, proof]) => (
                <tr key={phase}>
                  {[phase, sanitizer, isolation, proof].map((value, index) => (
                    <td
                      key={`${phase}-${index}`}
                      style={{
                        padding: "10px 12px",
                        borderBottom: "1px solid var(--hairline)",
                        color: index === 0 ? "var(--text-color)" : "var(--secondary-color)",
                        fontStyle: index === 3 ? "italic" : "normal",
                      }}
                    >
                      {value}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div style={divider} />

      <WhySolanaSection />

      <div style={divider} />

      <ArchitectureSection />

      <div style={divider} />

      <section style={sectionStyle(mobile)}>
        <div style={eyebrow}>Roles</div>
        <h2 style={heading(mobile)}>
          What each agent gets.
        </h2>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: mobile ? "1fr" : "1fr 1fr",
            gap: mobile ? 20 : 28,
            marginTop: 32,
          }}
        >
          <RoleCard
            title="Buyer Agent"
            points={[
              "Sees competing offers across sellers instead of negotiating against a single list price.",
              "Can counter within a hidden budget ceiling when budget commitments are enabled.",
              "Locks the final deal with a dual-signed quote before payment execution.",
            ]}
            mobile={mobile}
          />
          <RoleCard
            title="Seller Agent"
            points={[
              "Receives structured RFQs with deadlines, service requirements, and clear negotiation boundaries.",
              "Sees only its own negotiation thread, not competing bids or the buyer's private budget.",
              "Gets a signed commitment before service execution instead of blind undercutting and off-protocol haggling.",
            ]}
            mobile={mobile}
          />
        </div>
      </section>

      <div style={divider} />

      <section style={sectionStyle(mobile)}>
        <div style={eyebrow}>Landscape</div>
        <h2 style={heading(mobile)}>
          We haven't found another protocol
          <br />
          combining all four.
        </h2>
        <div style={{ overflowX: "auto", marginTop: 32 }}>
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: mobile ? "0.7rem" : "0.8rem",
              fontFamily: "var(--font-mono)",
              whiteSpace: "nowrap",
            }}
          >
            <thead>
              <tr>
                {["", "Negotiation", "Multi-Seller", "Budget Privacy", "Settlement"].map(
                  (h) => (
                    <th
                      key={h}
                      style={{
                        textAlign: "left",
                        padding: "8px 12px",
                        borderBottom: "1px solid var(--hairline)",
                        color: "var(--secondary-color)",
                        fontWeight: 500,
                        fontSize: "0.65rem",
                        textTransform: "uppercase",
                        letterSpacing: "0.1em",
                      }}
                    >
                      {h}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              <CompRow
                name="Ghost Bazaar"
                cols={["Structured RFQ/Offer/Counter/Quote", "Yes", "ZK (Groth16)", "Solana SPL"]}
                highlight
              />
              <CompRow name="x402" cols={["None", "No", "None", "HTTP 402"]} />
              <CompRow name="Virtuals ACP" cols={["Partial", "Partial", "None", "Custom"]} />
              <CompRow name="OpenAI/Stripe ACP" cols={["None", "No", "None", "Stripe"]} />
              <CompRow name="Google UCP" cols={["None", "No", "None", "Custom"]} />
            </tbody>
          </table>
        </div>
      </section>

      <div style={divider} />

      <section style={sectionStyle(mobile)}>
        <div style={eyebrow}>Verification</div>
        <h2 style={heading(mobile)}>Verifiable by design.</h2>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: mobile ? "1fr 1fr" : "1fr 1fr 1fr",
            gap: mobile ? 16 : 24,
            marginTop: 32,
          }}
        >
          <StatCard number="564" label="Test Cases" detail="Across 5 packages" mobile={mobile} />
          <StatCard number="6" label="State Machine" detail="Explicit transition rules" mobile={mobile} />
          <StatCard number="Ed25519" label="Commitment" detail="Dual-signed quotes" mobile={mobile} />
          <StatCard number="17" label="Settlement Checks" detail="Verification path" mobile={mobile} />
          <StatCard number="5" label="Packages" detail="Current monorepo runtime" mobile={mobile} />
          <StatCard number="4" label="Protocol Phases" detail="Discovery -> Settlement" mobile={mobile} />
        </div>
      </section>

      <div style={divider} />

      <section
        id="section-about"
        style={{
          ...sectionStyle(mobile),
          textAlign: "center",
          paddingBottom: mobile ? 64 : 120,
        }}
      >
        <div style={eyebrow}>Open Market Layer</div>
        <h2 style={{ ...heading(mobile), maxWidth: 500, margin: "0 auto 24px" }}>
          Private negotiation that composes with x402 and OWS wallets.
        </h2>
        <p
          style={{
            ...bodyText(mobile),
            maxWidth: 480,
            margin: "0 auto 40px",
          }}
        >
          x402 solves payment execution. Ghost Bazaar solves price discovery
          before payment. MoonPay's Open Wallet Standard adds a safer wallet
          boundary for autonomous buyers operating under spending policies.
        </p>
        <div style={{ marginBottom: 24 }}>
          <MoonPayMark />
        </div>
        <div style={{ display: "flex", gap: 16, justifyContent: "center", flexWrap: "wrap" }}>
          <CtaButton label="Read the Spec" href="https://github.com/whatthehackinsg/ghost-bazaar/blob/main/GHOST-BAZAAR-SPEC-v4.md" primary />
          <CtaButton label="View on GitHub" href="https://github.com/whatthehackinsg/ghost-bazaar" />
        </div>
      </section>
    </div>
  )
}

// --- Sub-components ---

function BadgePrivacyCard({
  badge,
  title,
  detail,
  mobile,
}: {
  readonly badge: "ALWAYS ON" | "OPT-IN"
  readonly title: string
  readonly detail: string
  readonly mobile: boolean
}) {
  const isAlwaysOn = badge === "ALWAYS ON"

  return (
    <div
      style={{
        padding: mobile ? "28px 0 12px" : "32px 0 16px",
        position: "relative",
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          display: "inline-block",
          fontFamily: "var(--font-mono)",
          fontSize: "0.55rem",
          letterSpacing: "0.08em",
          padding: "2px 8px",
          borderRadius: 2,
          background: isAlwaysOn ? "var(--text-color)" : "transparent",
          color: isAlwaysOn ? "var(--bg-color)" : "var(--secondary-color)",
          border: isAlwaysOn ? "none" : "1px solid var(--secondary-color)",
        }}
      >
        {badge}
      </span>
      <div
        style={{
          fontSize: mobile ? "0.9rem" : "1rem",
          fontWeight: 500,
          marginBottom: 8,
          color: "var(--text-color)",
        }}
      >
        {title}
      </div>
      <p
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: mobile ? "0.7rem" : "0.75rem",
          color: "var(--secondary-color)",
          lineHeight: 1.6,
        }}
      >
        {detail}
      </p>
    </div>
  )
}

function RoleCard({
  title,
  points,
  mobile,
}: {
  readonly title: string
  readonly points: readonly string[]
  readonly mobile: boolean
}) {
  return (
    <div
      style={{
        padding: mobile ? 16 : 24,
        border: "1px solid var(--hairline)",
        borderRadius: 4,
      }}
    >
      <div
        style={{
          fontSize: mobile ? "1rem" : "1.1rem",
          fontWeight: 500,
          marginBottom: 14,
          color: "var(--text-color)",
        }}
      >
        {title}
      </div>
      <ul
        style={{
          display: "grid",
          gap: 12,
          margin: 0,
          paddingLeft: mobile ? 18 : 20,
          color: "var(--secondary-color)",
        }}
      >
        {points.map((point) => (
          <li
            key={point}
            style={{
              fontSize: mobile ? "0.75rem" : "0.8rem",
              lineHeight: 1.6,
              margin: 0,
              paddingLeft: 2,
            }}
          >
            {point}
          </li>
        ))}
      </ul>
    </div>
  )
}

function CompRow({
  name,
  cols,
  highlight,
}: {
  readonly name: string
  readonly cols: readonly string[]
  readonly highlight?: boolean
}) {
  return (
    <tr>
      <td
        style={{
          padding: "10px 12px",
          borderBottom: "1px solid var(--hairline)",
          fontWeight: highlight ? 600 : 400,
          color: highlight ? "var(--text-color)" : "var(--secondary-color)",
        }}
      >
        {name}
      </td>
      {cols.map((val, i) => (
        <td
          key={i}
          style={{
            padding: "10px 12px",
            borderBottom: "1px solid var(--hairline)",
            color: highlight ? "var(--text-color)" : "var(--secondary-color)",
          }}
        >
          {val}
        </td>
      ))}
    </tr>
  )
}

function StatCard({
  number,
  label,
  detail,
  mobile,
}: {
  readonly number: string
  readonly label: string
  readonly detail: string
  readonly mobile: boolean
}) {
  return (
    <div style={{ textAlign: "center", padding: mobile ? 12 : 16 }}>
      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: mobile ? "1.8rem" : "2.4rem",
          fontWeight: 300,
          color: "var(--text-color)",
          lineHeight: 1,
          marginBottom: 4,
        }}
      >
        {number}
      </div>
      <div
        style={{
          fontSize: mobile ? "0.75rem" : "0.85rem",
          fontWeight: 500,
          color: "var(--text-color)",
          marginBottom: 2,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "0.65rem",
          color: "var(--secondary-color)",
        }}
      >
        {detail}
      </div>
    </div>
  )
}

function CtaButton({
  label,
  href,
  primary,
}: {
  readonly label: string
  readonly href: string
  readonly primary?: boolean
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onMouseEnter={(e) => {
        e.currentTarget.style.opacity = "0.7"
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.opacity = "1"
      }}
      style={{
        display: "inline-block",
        padding: "12px 28px",
        borderRadius: 9999,
        border: primary ? "none" : "1px solid var(--hairline)",
        background: primary ? "var(--text-color)" : "transparent",
        color: primary ? "var(--bg-color)" : "var(--text-color)",
        fontFamily: "var(--font-mono)",
        fontSize: "0.75rem",
        letterSpacing: "0.05em",
        textDecoration: "none",
        transition: "opacity 0.3s ease",
      }}
    >
      {label}
    </a>
  )
}
