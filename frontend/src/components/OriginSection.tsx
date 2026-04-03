import { useIsMobile } from "../hooks/useIsMobile"
import { bodyText, eyebrow, heading, sectionStyle } from "../styles/shared"

const rows = [
  ["Fixed server-set price", "Multi-round price negotiation"],
  ["Single seller per request", "Competitive multi-seller bidding"],
  ["Budget visible in payment flow", "ZK budget proof"],
  ["Pay-then-access", "Dual-signed quote commitment before payment"],
  ["No formal state machine", "Explicit six-state negotiation flow"],
] as const

export function OriginSection() {
  const mobile = useIsMobile()

  return (
    <section id="section-origin" style={sectionStyle(mobile)}>
      <div style={eyebrow}>Origin</div>
      <h2 style={heading(mobile)}>Built on the shoulders of x402.</h2>

      <div style={{ display: "grid", gap: 18 }}>
        <p style={bodyText(mobile)}>
          x402 got the hard part right: agents paying each other over HTTP with
          cryptographic receipts. Server names a price, client pays, done.
        </p>
        <p style={bodyText(mobile)}>
          We started there. Then we hit the questions it does not answer. What
          if the price should be negotiated, not fixed? What if three sellers
          can do the job? What if the buyer has a ceiling they cannot afford to
          reveal?
        </p>
        <p
          style={{
            ...bodyText(mobile),
            color: "var(--text-color)",
            fontWeight: 500,
          }}
        >
          So we built the layer that sits in front of settlement.
        </p>
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
              {["x402 gives you", "Ghost Bazaar adds"].map((title) => (
                <th
                  key={title}
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
                  {title}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(([left, right]) => (
              <tr key={left}>
                <td
                  style={{
                    padding: "10px 12px",
                    borderBottom: "1px solid var(--hairline)",
                    color: "var(--secondary-color)",
                  }}
                >
                  {left}
                </td>
                <td
                  style={{
                    padding: "10px 12px",
                    borderBottom: "1px solid var(--hairline)",
                    color: "var(--text-color)",
                  }}
                >
                  {right}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
