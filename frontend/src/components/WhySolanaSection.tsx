import { Fragment } from "react"
import { useIsMobile } from "../hooks/useIsMobile"
import { bodyText, eyebrow, heading, sectionStyle } from "../styles/shared"

const groups = [
  {
    title: "Technical Fit",
    rows: [
      [
        "Fast settlement confirmation",
        "Sub-second block production and quick finality for agent-to-agent settlement flows",
      ],
      [
        "Cheap machine-driven transactions",
        "Low transaction fees keep negotiation follow-up and settlement practical",
      ],
      [
        "Ed25519 native signatures",
        "Solana keypairs are Ed25519, so signing and DID derivation stay direct",
      ],
      [
        "SPL token payment rails",
        "USDC and token tooling are already first-class in the ecosystem",
      ],
    ],
  },
  {
    title: "Ecosystem Fit",
    rows: [
      [
        "On-chain agent identity",
        "Ghost Bazaar can bind listings to ERC-8004-style Solana agent registry entries",
      ],
      [
        "Registry-backed discovery",
        "Seller metadata and identity checks can come from verified on-chain records",
      ],
      [
        "Agent commerce momentum",
        "Payment rails, registry work, and agent tooling are converging in the same stack",
      ],
    ],
  },
] as const

export function WhySolanaSection() {
  const mobile = useIsMobile()

  return (
    <section id="section-solana" style={sectionStyle(mobile)}>
      <div style={eyebrow}>Why Solana</div>
      <h2 style={heading(mobile)}>Built on Solana for a reason.</h2>
      <p style={bodyText(mobile)}>
        We picked Solana on purpose. Every technical choice maps to something
        Solana already does well.
      </p>

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
          <tbody>
            {groups.map((group) => (
              <Fragment key={group.title}>
                <tr key={`${group.title}-heading`}>
                  <td
                    colSpan={2}
                    style={{
                      padding: "20px 12px 8px",
                      color: "var(--secondary-color)",
                      fontSize: "0.6rem",
                      textTransform: "uppercase",
                      letterSpacing: "0.15em",
                    }}
                  >
                    {group.title}
                  </td>
                </tr>
                {group.rows.map(([need, provide]) => (
                  <tr key={`${group.title}-${need}`}>
                    <td
                      style={{
                        width: "38%",
                        padding: "10px 12px",
                        borderBottom: "1px solid var(--hairline)",
                        color: "var(--secondary-color)",
                      }}
                    >
                      {need}
                    </td>
                    <td
                      style={{
                        padding: "10px 12px",
                        borderBottom: "1px solid var(--hairline)",
                        color: "var(--text-color)",
                      }}
                    >
                      {provide}
                    </td>
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
