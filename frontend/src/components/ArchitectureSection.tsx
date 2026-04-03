import { useIsMobile } from "../hooks/useIsMobile"
import { bodyText, cornerLabel, eyebrow, heading, sectionStyle } from "../styles/shared"

const layers = [
  ["Layer 5", "Engine", "Hono HTTP server, state machine, SQLite event log"],
  ["Layer 4", "Strategy", "Rule-based + LLM strategies, privacy sanitizer"],
  ["Layer 3", "Agents", "Registry helpers and verified identity bindings"],
  ["Layer 2", "ZK", "Poseidon commitment + Groth16 budget proof"],
  ["Layer 1", "Core", "Schemas, Ed25519 signing, canonical JSON, DIDs"],
] as const

const packages = [
  ["@ghost-bazaar/core", "104 tests"],
  ["@ghost-bazaar/strategy", "76 tests"],
  ["@ghost-bazaar/zk", "20 cases"],
  ["@ghost-bazaar/agents", "12 tests"],
  ["@ghost-bazaar/engine", "352 tests"],
] as const

export function ArchitectureSection() {
  const mobile = useIsMobile()

  return (
    <section id="section-architecture" style={sectionStyle(mobile)}>
      <div style={eyebrow}>Architecture</div>
      <h2 style={heading(mobile)}>Five packages. One engine.</h2>
      <p style={bodyText(mobile)}>
        Each package does one thing. Dependencies only flow downward, so the
        protocol core stays reusable while the engine orchestrates the runtime.
      </p>

      <div
        style={{
          marginTop: 32,
          border: "1px solid var(--hairline)",
          borderRadius: 4,
          padding: mobile ? "24px 12px 12px" : "32px 24px 16px",
          overflowX: "auto",
          position: "relative",
        }}
      >
        <span style={cornerLabel("top", "left")}>ARCHITECTURE</span>
        <span style={cornerLabel("top", "right")}>CURRENT</span>
        <pre
          style={{
            margin: 0,
            minWidth: 620,
            fontFamily: "var(--font-mono)",
            fontSize: mobile ? "0.7rem" : "0.75rem",
            lineHeight: 1.9,
            color: "var(--secondary-color)",
            whiteSpace: "pre",
          }}
        >
          {layers.map((layer) => layer.join("    ")).join("\n")}
        </pre>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: mobile ? "1fr" : "1fr 1fr 1fr",
          gap: 20,
          marginTop: 32,
        }}
      >
        {packages.map(([name, tests]) => (
          <div
            key={name}
            style={{
              padding: mobile ? 16 : 18,
              border: "1px solid var(--hairline)",
              borderRadius: 4,
            }}
          >
            <div
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "0.75rem",
                color: "var(--text-color)",
                marginBottom: 8,
              }}
            >
              {name}
            </div>
            <div
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "0.65rem",
                color: "var(--secondary-color)",
              }}
            >
              {tests}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
