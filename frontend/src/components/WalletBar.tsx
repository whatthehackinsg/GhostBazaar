import { useEffect, useRef, useState } from "react"
import { useIsMobile } from "../hooks/useIsMobile"
import { formatWalletLabel, useWallet } from "../context/WalletContext"

export function WalletBar() {
  const mobile = useIsMobile()
  const { address, balance, isConnected, isConnecting, error, connect, disconnect } = useWallet()
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) return

    const handlePointerDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setMenuOpen(false)
      }
    }

    window.addEventListener("mousedown", handlePointerDown)
    return () => window.removeEventListener("mousedown", handlePointerDown)
  }, [menuOpen])

  const shellPadding = mobile ? "10px 14px" : "10px 24px"

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        width: "100%",
        minHeight: "var(--wallet-bar-height)",
        zIndex: 1500,
        borderBottom: "1px solid var(--hairline)",
        background: "color-mix(in srgb, var(--bg-overlay) 92%, transparent)",
        backdropFilter: "blur(16px)",
      }}
    >
      <div
        style={{
          maxWidth: 1400,
          margin: "0 auto",
          padding: shellPadding,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 16,
        }}
      >
        <a
          href="/#/"
          style={{
            color: "var(--text-color)",
            textDecoration: "none",
            fontFamily: "var(--font-mono)",
            fontSize: mobile ? "0.7rem" : "0.75rem",
            letterSpacing: "0.16em",
            textTransform: "uppercase",
            whiteSpace: "nowrap",
          }}
        >
          Ghost Bazaar
        </a>

        <div
          ref={menuRef}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            position: "relative",
          }}
        >
          {isConnected && (
            <div
              style={{
                display: mobile ? "none" : "inline-flex",
                alignItems: "center",
                padding: "8px 10px",
                border: "1px solid var(--hairline)",
                borderRadius: 999,
                fontFamily: "var(--font-mono)",
                fontSize: "0.65rem",
                letterSpacing: "0.08em",
                color: "var(--secondary-color)",
                whiteSpace: "nowrap",
              }}
            >
              {balance ?? "Balance unavailable"}
            </div>
          )}

          {isConnected ? (
            <>
              <button
                type="button"
                onClick={() => setMenuOpen((open) => !open)}
                style={{
                  border: "1px solid var(--text-color)",
                  background: "transparent",
                  color: "var(--text-color)",
                  borderRadius: 999,
                  padding: mobile ? "8px 12px" : "8px 14px",
                  fontFamily: "var(--font-mono)",
                  fontSize: mobile ? "0.65rem" : "0.7rem",
                  letterSpacing: "0.1em",
                  textTransform: "uppercase",
                  cursor: "none",
                  whiteSpace: "nowrap",
                }}
              >
                {formatWalletLabel(address)}
              </button>

              {menuOpen && (
                <div
                  style={{
                    position: "absolute",
                    top: "calc(100% + 10px)",
                    right: 0,
                    minWidth: mobile ? 220 : 260,
                    padding: 14,
                    border: "1px solid var(--hairline)",
                    borderRadius: 12,
                    background: "var(--bg-panel)",
                    backdropFilter: "blur(18px)",
                    boxShadow: "0 24px 60px rgba(0,0,0,0.18)",
                  }}
                >
                  <div
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: "0.58rem",
                      letterSpacing: "0.16em",
                      textTransform: "uppercase",
                      color: "var(--secondary-color)",
                      marginBottom: 8,
                    }}
                  >
                    MoonPay Wallet
                  </div>
                  <div
                    style={{
                      fontFamily: "var(--font-mono)",
                      fontSize: "0.72rem",
                      lineHeight: 1.6,
                      color: "var(--text-color)",
                      wordBreak: "break-all",
                    }}
                  >
                    {address}
                  </div>
                  <div
                    style={{
                      marginTop: 10,
                      fontFamily: "var(--font-mono)",
                      fontSize: "0.65rem",
                      color: "var(--secondary-color)",
                    }}
                  >
                    {balance ?? "Balance unavailable"}
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setMenuOpen(false)
                      disconnect()
                    }}
                    style={{
                      marginTop: 14,
                      width: "100%",
                      border: "1px solid var(--hairline)",
                      background: "transparent",
                      color: "var(--text-color)",
                      borderRadius: 999,
                      padding: "9px 12px",
                      fontFamily: "var(--font-mono)",
                      fontSize: "0.62rem",
                      letterSpacing: "0.14em",
                      textTransform: "uppercase",
                      cursor: "none",
                    }}
                  >
                    Disconnect
                  </button>
                </div>
              )}
            </>
          ) : (
            <button
              type="button"
              onClick={() => void connect()}
              disabled={isConnecting}
              style={{
                border: "1px solid var(--text-color)",
                background: isConnecting ? "transparent" : "var(--text-color)",
                color: isConnecting ? "var(--text-color)" : "var(--bg-color)",
                borderRadius: 999,
                padding: mobile ? "8px 12px" : "8px 14px",
                fontFamily: "var(--font-mono)",
                fontSize: mobile ? "0.65rem" : "0.7rem",
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                cursor: isConnecting ? "wait" : "none",
                whiteSpace: "nowrap",
                opacity: isConnecting ? 0.7 : 1,
              }}
            >
              {isConnecting ? "Connecting..." : "Connect Wallet"}
            </button>
          )}
        </div>
      </div>

      {error && (
        <div
          style={{
            maxWidth: 1400,
            margin: "0 auto",
            padding: mobile ? "0 14px 10px" : "0 24px 10px",
            fontFamily: "var(--font-mono)",
            fontSize: mobile ? "0.6rem" : "0.64rem",
            color: "var(--status-warning)",
            letterSpacing: "0.04em",
          }}
        >
          MoonPay fallback: {error}
        </div>
      )}
    </div>
  )
}
