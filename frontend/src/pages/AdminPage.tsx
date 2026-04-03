import { useCallback, useEffect, useRef, useState } from "react"
import { useIsMobile } from "../hooks/useIsMobile"
import { apiUrl } from "../api"

interface Props {
  readonly onBack: () => void
}

interface SessionSummary {
  readonly rfq_id: string
  readonly state: string
  readonly buyer: string
  readonly service_type: string
  readonly anchor_price: string
  readonly currency: string
  readonly offer_count: number
  readonly seller_count: number
  readonly selected_seller: string | null
  readonly event_count: number
  readonly deadline: string
}

interface SessionDetail {
  readonly rfq_id: string
  readonly state: string
  readonly rfq: Record<string, unknown>
  readonly offers: readonly Record<string, unknown>[]
  readonly counters: readonly Record<string, unknown>[]
  readonly selected_seller: string | null
  readonly selected_offer_id: string | null
  readonly unsigned_quote: Record<string, unknown> | null
  readonly buyer_signature: string | null
  readonly seller_signature: string | null
  readonly final_price: string | null
  readonly event_count: number
}

type View = "login" | "sessions" | "detail"

/**
 * Admin panel — hidden, no public links.
 * Access only via /#/admin. Cookie-based auth.
 */
export function AdminPage({ onBack }: Props) {
  const mobile = useIsMobile()
  const [view, setView] = useState<View>("login")
  const [password, setPassword] = useState("")
  const [error, setError] = useState("")
  const [sessions, setSessions] = useState<readonly SessionSummary[]>([])
  const [detail, setDetail] = useState<SessionDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  // Check if already logged in
  useEffect(() => {
    fetch(apiUrl("/admin/sessions?limit=1"), { credentials: "include" })
      .then((r) => {
        if (r.ok) {
          setView("sessions")
          loadSessions()
        }
      })
      .catch(() => {})
  }, [])

  const login = async () => {
    setError("")
    setLoading(true)
    try {
      const res = await fetch(apiUrl("/admin/login"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
        credentials: "include",
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setError((body as Record<string, string>).message ?? `Error ${res.status}`)
        return
      }
      setView("sessions")
      loadSessions()
    } catch {
      setError("Connection failed")
    } finally {
      setLoading(false)
    }
  }

  const logout = async () => {
    await fetch(apiUrl("/admin/logout"), { method: "POST", credentials: "include" }).catch(() => {})
    setView("login")
    setSessions([])
    setDetail(null)
    setPassword("")
  }

  const loadSessions = useCallback(async () => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    try {
      const res = await fetch(apiUrl("/admin/sessions?limit=100"), {
        credentials: "include",
        signal: controller.signal,
      })
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) setView("login")
        return
      }
      const data = await res.json() as { sessions: SessionSummary[] }
      setSessions(data.sessions)
    } catch (err) {
      if ((err as Error).name !== "AbortError") setView("login")
    }
  }, [])

  const loadDetail = async (rfqId: string) => {
    setLoading(true)
    try {
      const res = await fetch(apiUrl(`/admin/sessions/${rfqId}`), { credentials: "include" })
      if (!res.ok) return
      setDetail(await res.json() as SessionDetail)
      setView("detail")
    } finally {
      setLoading(false)
    }
  }

  const mono: React.CSSProperties = {
    fontFamily: "var(--font-mono)",
    fontSize: "0.75rem",
  }

  // --- Login ---
  if (view === "login") {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ width: mobile ? "90%" : 320 }}>
          <div style={{ ...mono, fontSize: "0.65rem", color: "var(--secondary-color)", textTransform: "uppercase", letterSpacing: "0.15em", marginBottom: 24 }}>
            Authentication Required
          </div>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && login()}
            placeholder="admin password"
            style={{
              width: "100%",
              padding: "10px 12px",
              border: "1px solid var(--hairline)",
              borderRadius: 4,
              fontFamily: "var(--font-mono)",
              fontSize: "0.8rem",
              outline: "none",
              background: "transparent",
              color: "var(--text-color)",
            }}
          />
          {error && (
            <div style={{ ...mono, color: "var(--status-error)", marginTop: 8, fontSize: "0.7rem" }}>
              {error}
            </div>
          )}
          <button
            onClick={login}
            disabled={loading || !password}
            style={{
              width: "100%",
              marginTop: 12,
              padding: "10px",
              border: "1px solid var(--text-color)",
              borderRadius: 4,
              background: "var(--text-color)",
              color: "var(--bg-color)",
              fontFamily: "var(--font-mono)",
              fontSize: "0.75rem",
              cursor: loading ? "wait" : "pointer",
              opacity: loading || !password ? 0.5 : 1,
            }}
          >
            {loading ? "..." : "Enter"}
          </button>
        </div>
      </div>
    )
  }

  // --- Session Detail ---
  if (view === "detail" && detail) {
    return (
      <div style={{ minHeight: "100vh", padding: mobile ? 16 : 24, maxWidth: 900, margin: "0 auto" }}>
        <Header
          left={<span onClick={() => { setView("sessions"); setDetail(null) }} style={{ cursor: "pointer" }}>← Sessions</span>}
          right={<span onClick={logout} style={{ cursor: "pointer" }}>Logout</span>}
        />
        <div style={{ ...mono, marginBottom: 16 }}>
          <span style={{ color: "var(--secondary-color)" }}>Session </span>
          <span style={{ color: "var(--text-color)", wordBreak: "break-all" }}>{detail.rfq_id}</span>
        </div>
        <StateBadge state={detail.state} />
        <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: mobile ? "1fr" : "1fr 1fr", gap: 12 }}>
          <InfoCard label="Buyer" value={truncDid(detail.rfq.buyer as string)} />
          <InfoCard label="Service" value={detail.rfq.service_type as string} />
          <InfoCard label="Anchor Price" value={`${detail.rfq.anchor_price} ${detail.rfq.currency}`} />
          {detail.final_price && <InfoCard label="Final Price" value={`${detail.final_price} ${detail.rfq.currency}`} />}
          <InfoCard label="Events" value={String(detail.event_count)} />
          <InfoCard label="Offers" value={String(detail.offers.length)} />
          <InfoCard label="Counters" value={String(detail.counters.length)} />
          {detail.selected_seller && <InfoCard label="Selected Seller" value={truncDid(detail.selected_seller)} />}
          {detail.unsigned_quote && <InfoCard label="Quote" value={detail.buyer_signature ? (detail.seller_signature ? "Dual-signed" : "Buyer-signed") : "Unsigned"} />}
        </div>
      </div>
    )
  }

  // --- Session List ---
  return (
    <div style={{ minHeight: "100vh", padding: mobile ? 16 : 24, maxWidth: 1000, margin: "0 auto" }}>
      <Header
        left={<span onClick={onBack} style={{ cursor: "pointer" }}>← Exit</span>}
        right={<span onClick={logout} style={{ cursor: "pointer" }}>Logout</span>}
      />
      <div style={{ ...mono, color: "var(--secondary-color)", marginBottom: 16 }}>
        {sessions.length} session{sessions.length !== 1 ? "s" : ""}
        <span onClick={loadSessions} style={{ marginLeft: 12, cursor: "pointer", color: "var(--text-color)" }}>↻ Refresh</span>
      </div>

      {sessions.length === 0 ? (
        <div style={{ ...mono, color: "var(--secondary-color)", textAlign: "center", paddingTop: 80 }}>
          No sessions found.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {sessions.map((s) => (
            <div
              key={s.rfq_id}
              onClick={() => loadDetail(s.rfq_id)}
              style={{
                border: "1px solid var(--hairline)",
                borderRadius: 4,
                padding: mobile ? 12 : 16,
                cursor: "pointer",
                transition: "border-color 0.2s",
                display: "grid",
                gridTemplateColumns: mobile ? "1fr" : "1fr auto auto auto",
                gap: mobile ? 4 : 16,
                alignItems: "center",
              }}
              onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--text-color)" }}
              onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--hairline)" }}
            >
              <div style={mono}>
                <span style={{ color: "var(--text-color)" }}>{truncDid(s.rfq_id)}</span>
                <span style={{ color: "var(--secondary-color)", marginLeft: 8 }}>{s.service_type}</span>
              </div>
              <StateBadge state={s.state} />
              <div style={{ ...mono, color: "var(--secondary-color)" }}>
                {s.offer_count} offer{s.offer_count !== 1 ? "s" : ""}
              </div>
              <div style={{ ...mono, color: "var(--secondary-color)" }}>
                {s.event_count} events
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// --- Sub-components ---

function Header({ left, right }: { readonly left: React.ReactNode; readonly right: React.ReactNode }) {
  return (
    <div style={{
      display: "flex",
      justifyContent: "space-between",
      marginBottom: 24,
      fontFamily: "var(--font-mono)",
      fontSize: "0.7rem",
      textTransform: "uppercase",
      letterSpacing: "0.1em",
      color: "var(--text-color)",
    }}>
      {left}
      {right}
    </div>
  )
}

function StateBadge({ state }: { readonly state: string }) {
  const color = state === "COMMITTED" ? "#22c55e"
    : state === "EXPIRED" || state === "CANCELLED" ? "#ef4444"
    : "#b45309"
  return (
    <span style={{
      fontFamily: "var(--font-mono)",
      fontSize: "0.6rem",
      padding: "2px 8px",
      borderRadius: 3,
      border: `1px solid ${color}`,
      color,
      textTransform: "uppercase",
      letterSpacing: "0.05em",
    }}>
      {state}
    </span>
  )
}

function InfoCard({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div style={{
      border: "1px solid var(--hairline)",
      borderRadius: 4,
      padding: "8px 12px",
    }}>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: "0.55rem", color: "var(--secondary-color)", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 2 }}>
        {label}
      </div>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: "0.75rem", color: "var(--text-color)", wordBreak: "break-all" }}>
        {value}
      </div>
    </div>
  )
}

function truncDid(did: string): string {
  if (did.length <= 24) return did
  return `${did.slice(0, 16)}...${did.slice(-8)}`
}
