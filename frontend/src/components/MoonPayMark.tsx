interface Props {
  readonly compact?: boolean
}

/**
 * MoonPay wordmark mounted in a dark capsule so it reads cleanly across themes.
 */
export function MoonPayMark({ compact = false }: Props) {
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: compact ? 8 : 10,
        padding: compact ? "8px 10px" : "10px 12px",
        borderRadius: 999,
        border: "1px solid rgba(255,255,255,0.12)",
        background: "#0b0b0b",
        boxShadow: "0 10px 30px rgba(0,0,0,0.18)",
      }}
    >
      <img
        src="https://www.moonpay.com/assets/logo-full-white.svg"
        alt="MoonPay"
        style={{
          display: "block",
          height: compact ? 14 : 16,
          width: "auto",
        }}
      />
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: compact ? "0.55rem" : "0.6rem",
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          color: "rgba(255,255,255,0.72)",
          whiteSpace: "nowrap",
        }}
      >
        Powered Wallet Flow
      </span>
    </div>
  )
}
