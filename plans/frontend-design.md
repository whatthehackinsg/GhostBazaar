# Frontend Design — Dashboard + Routing + Polish

> Reviewed by Codex (technical) + Gemini (creative). Incorporates feedback from both.

## Design Language

Continue the existing aesthetic: white background, monospace accents (`--font-mono`),
`Inter` body text, `--hairline` borders, minimal/terminal vibe. No new dependencies.

**Color rule (Gemini):** Stay 95% monochrome. Use color only for transient states:
- Terminal green `#22c55e` — flash on successful deal events, fade to gray in 500ms
- Red dot `#ef4444` — static indicator when SSE disconnected
- Faint `text-shadow` glow on active SSE indicator (tube monitor effect)

---

## 1. Route Structure

```
/                   Landing page (existing)
#/dashboard         Public live dashboard (no auth)
```

Hash-based navigation. No React Router (saves 40KB).
`useHash()` hook drives the top-level render switch.

---

## 2. Dashboard Page Design

### Layout (desktop) — 2-column asymmetric

```
┌──────────────────────────────────────────────────────┐
│  ← BACK                           GHOST BAZAAR DASHBOARD │
├──────────────────────────────────────────────────────┤
│                              │                       │
│  LIVE FEED                   │  STATS                │
│  ┌───────────────────────┐   │  ┌─────┐  ┌─────┐    │
│  │ 12:01:55  buyer       │   │  │  0  │  │  0  │    │
│  │   RFQ_CREATED → OPEN  │   │  │ACTVE│  │DEALS│    │
│  │ 12:01:56  seller      │   │  ├─────┤  ├─────┤    │
│  │   OFFER → NEGOTIATING │   │  │  0  │  │  3  │    │
│  │ 12:01:58  buyer       │   │  │AGETS│  │LSTNG│    │
│  │   COUNTER → NEGOT...  │   │  └─────┘  └─────┘    │
│  │                       │   │                       │
│  │  ·                    │   │  ACTIVITY (5 min)     │
│  │                       │   │  ▁▂▃▅▇  events/min   │
│  │  SCANNING FOR RFQS... │   │  -4  -3  -2  -1  now │
│  └───────────────────────┘   │                       │
│                              │  success: 0%          │
│                              │  avg rounds: 0        │
├──────────────────────────────┴───────────────────────┤
│  ▸ uptime: 3h 24m  │  engine: online  │  feed: ●    │
│  ▁▁▁▂▁▁▁▁▃▁▁▁▁▁▁▂▁▁▁▁▁▁▁▁▁▁▁▁▁▁  ← heartbeat     │
└──────────────────────────────────────────────────────┘
```

**Key:** Feed is the focal point (60% width). Stats + activity on the right (40%).
Bottom bar shows engine health + 1px scrolling heartbeat waveform (Gemini idea).

### Layout (mobile)

Single column stack: Stats (2x2 grid) → Activity → Feed → Status.
Stats become horizontally scrollable ticker (swipeable).

---

## 3. Component Architecture

```
src/
  pages/
    LandingPage.tsx          — Extracted from current App.tsx
    DashboardPage.tsx        — Dashboard layout + data orchestration
  components/
    dashboard/
      StatsCards.tsx          — 4 stat cards (active, deals, agents, listings)
      ActivityChart.tsx       — ASCII bar chart from events_per_minute[5]
      LiveFeed.tsx            — SSE-driven scrolling event list
      EngineStatus.tsx        — uptime + heartbeat + connection indicator
  hooks/
    useHash.ts               — Hash-based routing hook
    useDashboardStats.ts     — Poll /dashboard/stats every 10s
    useDashboardActivity.ts  — Poll /dashboard/activity every 30s
    useLiveFeed.ts           — EventSource + useSyncExternalStore
```

---

## 4. Data Fetching

### Stats (polling)
```typescript
// useDashboardStats.ts
// Poll GET /dashboard/stats every 10 seconds
// Returns DashboardStats interface
// States: "loading" | "ok" | "stale" (last fetch >30s ago) | "error"
// Uses AbortController on unmount
```

### Activity (polling)
```typescript
// useDashboardActivity.ts
// Poll GET /dashboard/activity every 30 seconds
// Returns: { events_per_minute: number[5], new_sessions_last_hour, deals_last_hour }
// Note: activity windows reset on engine restart (process-lifetime counters)
// Display "since restart" context when uptime < 5min
```

### Live Feed (SSE) — Codex-reviewed
```typescript
// useLiveFeed.ts
// EventSource → GET /dashboard/feed
// Each event: { type, actor_role: "buyer"|"seller"|"system", state_after }
//
// Storage: circular buffer (50 items) exposed via useSyncExternalStore
// (Codex: ref-only won't trigger renders; useSyncExternalStore bridges
//  external data → React without per-event setState overhead)
//
// Connection states: "connecting" | "open" | "disconnected" | "at-capacity"
// - 503 → "at-capacity": show message, exponential backoff retry
// - Disconnect → preserve last snapshot, show "Reconnecting..."
// - Best-effort live (no event IDs/cursors in backend)
//
// Actor role styling:
//   buyer  → dark text (#111)
//   seller → gray text (#666)
//   system → light italic (#999)
```

---

## 5. Visual Components

### StatsCards
- 4 cards: Active Sessions, Completed Deals, Unique Agents (buyers+sellers), Listings
- Desktop: 2x2 grid in right panel
- Mobile: horizontal swipeable ticker (sticky top)
- Monospace numbers, large font weight
- Count-up animation on value change (via ref, not state)
- `--hairline` border

### ActivityChart (ASCII)
- 5 vertical bars from `events_per_minute` array
- Characters: `▁▂▃▄▅▆▇█` (Unicode block elements)
- Monospace font, matches terminal aesthetic
- Labels: `-4m -3m -2m -1m now`
- Below: `success_rate` + `avg_rounds_per_session`
- `aria-label` with text summary for accessibility (Codex)

### LiveFeed
- Scrolling list, newest on top, max 50 events
- Each row: `HH:MM:SS  role  EVENT_TYPE  → STATE`
- Hover: row inverts (black bg, white text) for highlight (Gemini)
- Successful deals flash green (#22c55e) for 500ms then fade (Gemini)
- Connection indicator: green dot (open), red dot (disconnected), yellow (reconnecting)
- **Empty state (Gemini):** ASCII pulse line animation + "SCANNING FOR AGENT RFQS..."
  instead of dead "No events" — makes emptiness feel like active observation

### EngineStatus
- Bottom bar, full width, monospace
- Left: uptime (formatted `3h 24m`)
- Center: engine health (polls /health every 30s)
- Right: SSE indicator with faint glow when active
- **Heartbeat waveform (Gemini):** 1px scrolling line at bottom edge mapping SSE
  message frequency — gives the dashboard a "living" feel

---

## 6. Navigation Updates

### Hash Router
```typescript
// useHash.ts — ~10 lines
function useHash() {
  const [hash, setHash] = useState(location.hash)
  useEffect(() => {
    const handler = () => setHash(location.hash)
    window.addEventListener("hashchange", handler)
    return () => window.removeEventListener("hashchange", handler)
  }, [])
  return hash
}
```

### App.tsx changes
```tsx
const hash = useHash()
const page = hash === "#/dashboard" ? "dashboard" : "landing"

return page === "dashboard"
  ? <DashboardPage />
  : <LandingPage />  // existing App content extracted
```

### Fix dead links

| Current | Target |
|---------|--------|
| Nav "Live Feed" | `#/dashboard` |
| Nav "Metrics" | `#/dashboard` |
| Nav "Protocol" | scroll to protocol section |
| Nav "Privacy" | scroll to privacy section |
| Nav "About" | scroll to CTA section |
| CTA "Read the Spec" | `https://github.com/whatthehackinsg/GhostBazaar/blob/main/GHOST-BAZAAR-SPEC-v4.md` |
| CTA "View on GitHub" | `https://github.com/whatthehackinsg/GhostBazaar` |
| Bottom "Documentation" | `https://github.com/whatthehackinsg/GhostBazaar/blob/main/ENGINEERING.md` |
| Bottom "GitHub" | `https://github.com/whatthehackinsg/GhostBazaar` |
| Bottom "Live Feed" | `#/dashboard` |
| Bottom "Protocol Spec" | `https://github.com/whatthehackinsg/GhostBazaar/blob/main/GHOST-BAZAAR-SPEC-v4.md` |

---

## 7. SEO / Meta

Add to `index.html`:
```html
<meta name="description" content="Ghost Bazaar — Solana-native agent-to-agent negotiation protocol. AI agents discover, negotiate, and settle autonomously with ZK budget privacy." />
<meta property="og:title" content="Ghost Bazaar — Agent-to-Agent Negotiation" />
<meta property="og:description" content="Autonomous price discovery on Solana. Optional ZK budget privacy." />
<meta property="og:type" content="website" />
<meta property="og:url" content="https://ghost-bazaar-protocol.vercel.app" />
<meta name="twitter:card" content="summary" />
<meta name="twitter:title" content="Ghost Bazaar Protocol" />
<meta name="twitter:description" content="Solana-native agent-to-agent negotiation with ZK budget privacy." />
```

---

## 8. Error Handling (Codex review)

| State | Visual | Behavior |
|-------|--------|----------|
| **loading** | Skeleton cards + "Connecting..." | Initial page load |
| **ok** | Normal display | Polling + SSE active |
| **stale** | Yellow warning badge | Last successful fetch >30s ago |
| **disconnected** | Red dot + "Reconnecting..." | SSE closed, auto-retry with backoff |
| **at-capacity** | "Feed at capacity" message | 503 from engine, retry with backoff |
| **error** | "Engine unreachable" | Fetch failed, show last known data |

All fetch hooks use `AbortController` on unmount.
SSE reconnect uses exponential backoff (1s, 2s, 4s, max 30s).

---

## 9. Implementation Order

1. **useHash + routing** — Extract LandingPage, add hash router (~20 min)
2. **Dashboard skeleton** — DashboardPage with 2-column layout (~20 min)
3. **Data hooks** — useDashboardStats, useDashboardActivity, useLiveFeed (~40 min)
4. **Dashboard components** — StatsCards, ActivityChart, LiveFeed, EngineStatus (~60 min)
5. **Empty state + heartbeat** — ASCII pulse, scanning text, waveform (~20 min)
6. **Fix dead links** — Wire Nav, CTA, BottomPanel links (~15 min)
7. **SEO meta tags** — Add to index.html (~5 min)
8. **Polish** — Mobile, error states, deal flash animation (~30 min)

---

## 10. Zero New Dependencies

Everything built with React 19 + native APIs:
- `EventSource` for SSE (built-in)
- `useSyncExternalStore` for feed state (React 19 built-in)
- `fetch` + `AbortController` for polling (built-in)
- Hash-based routing via `hashchange` event (built-in)
- ASCII bar chart via Unicode block characters (no chart library)

Bundle target: stays at ~68KB gzip.

---

## Review Credits

- **Codex:** useSyncExternalStore for feed, 4 connection states, system role handling,
  AbortController cleanup, activity window restart caveat, aria-label on chart
- **Gemini:** 2-column asymmetric layout, transient green flash on deals, empty state
  as active observation ("SCANNING..."), heartbeat waveform, hover inversion on feed rows
