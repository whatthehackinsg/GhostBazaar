# Landing Page: x402 Comparison, Why Solana, Value Prop & Privacy Expansion

**Date:** 2026-03-22
**Status:** Design approved, pending implementation

---

## Context

The current landing page (`frontend/src/components/LandingContent.tsx`) mentions x402 briefly in two places but doesn't explain the relationship clearly. Hackathon judges and visitors need to understand: where Ghost Bazaar came from, what it adds, why Solana, and how privacy works at each protocol phase.

This spec adds 3 new sections and expands 1 existing section in the landing page content area (below the scroll-reveal hero).

## Design Constraints

- **Existing design system must be preserved:** CSS variables from `globals.css` (`--bg-color`, `--text-color`, `--secondary-color`, `--hairline`, `--font-main`, `--font-mono`), shared style patterns (eyebrow, heading, bodyText, divider, sectionStyle) from `LandingContent.tsx`.
- **No new CSS files or external dependencies.** Inline styles via CSSProperties, consistent with existing components.
- **Mobile responsive** via existing `useIsMobile()` hook.
- **No emojis, no decorative icons.** Text and structure only, matching existing minimalist aesthetic.
- **Extensible for Colosseum:** Section structure should accommodate future additions (ZK encrypted negotiation, reverse auction, MEV protection) without reorganizing.

---

## Page Order (Final)

```
Hero (existing — scroll-reveal with ASCII canvas, no changes)
  ↓ scroll
 1. VALUE PROP (NEW)          ← "The negotiation protocol for autonomous agents"
    divider
 2. X402 EVOLUTION (NEW)      ← "Built on the shoulders of x402"
    divider
 3. PROTOCOL FLOW (existing ProtocolSection — no changes)
    divider
 4. PRIVACY (EXPANDED)        ← "Three layers of privacy. Not all optional."
    divider
 5. WHY SOLANA (NEW)          ← "Built on Solana for a reason"
    divider
 6. ARCHITECTURE (NEW)        ← "Seven layers. One monorepo."
    divider
 7. ROLES (existing — no changes)
    divider
 8. COMPARISON TABLE (existing — no changes)
    divider
 9. VERIFICATION STATS (UPDATED) ← 671 tests, 7 packages, updated numbers
    divider
10. CTA (existing — no changes)
```

---

## Section 1: Value Prop (NEW)

**Position:** First section after hero reveal, before x402 story. **Replaces** the existing "The Problem" section (eyebrow: "The Problem", heading: "Agents know how to pay...").

**Eyebrow:** `What Is Ghost Bazaar`

**Heading:** `The negotiation protocol for autonomous agents.`

**Problem hook** (preserves the effective framing from the current page):
> "Agents know how to pay. They don't know how much. Payment rails exist — what's missing is the haggling. Who sets the price? What if there are five sellers? What if you don't want to show your budget? That's Ghost Bazaar."

**3 cards in a horizontal grid** (1-column on mobile):

| Card | Title | One-liner |
|------|-------|-----------|
| 1 | Multi-Round Negotiation | Structured RFQ → Offer → Counter → Quote. Not one-shot pricing. |
| 2 | Competitive Bidding | Multiple sellers compete. Buyer sees all offers. Sellers see only their own. |
| 3 | Cryptographic Commitment | Ed25519 dual-signed quotes lock terms before payment. No trust required. |

**Implementation notes:**
- Card grid: `gridTemplateColumns: mobile ? "1fr" : "1fr 1fr 1fr"`, gap 24.
- Card style: No border, just padding. Title in `--text-color` at `mobile ? "0.9rem" : "1rem"` / 500 weight. One-liner in `--font-mono` at `mobile ? "0.7rem" : "0.75rem"` in `--secondary-color`. Matches existing PrivacyCard pattern.
- Context sentence: `bodyText` style, centered, maxWidth 600.
- **Note:** Copy shared styles (`sectionStyle`, `eyebrow`, `heading`, `bodyText`) from `LandingContent.tsx`, not from `ProtocolSection.tsx` (which has divergent copies).

---

## Section 2: x402 Evolution Story (NEW)

**Position:** After value prop, before protocol flow.

**Eyebrow:** `Origin`

**Heading:** `Built on the shoulders of x402.`

**Narrative block** (3 short paragraphs in `bodyText` style):

> x402 got the hard part right: agents paying each other over HTTP with cryptographic receipts. Server names a price, client pays, done.
>
> We started there. Then we hit the questions it doesn't answer. What if the price should be negotiated, not fixed? What if three sellers can do the job? What if the buyer has a ceiling they can't afford to reveal?
>
> So we built the layer that sits in front of settlement.

**Two-column before/after table below narrative:**

| x402 gives you | Ghost Bazaar adds |
|---|---|
| Fixed server-set price | Multi-round price negotiation |
| Single seller per request | Competitive multi-seller bidding |
| Budget visible in payment | ZK budget proof (Poseidon + Groth16) |
| Pay-then-access | Dual-signed quote commitment before payment |
| No formal state machine | 6-state machine with append-only event log |

**Implementation notes:**
- Narrative paragraphs: `bodyText(mobile)` style with `marginBottom: 16` between paragraphs. Last paragraph ("Ghost Bazaar picks up...") in `--text-color` with `fontWeight: 500` for emphasis.
- Table: Same `<table>` style as existing comparison table in `LandingContent.tsx` — monospace, `borderCollapse: collapse`, `0.8rem` font, `--hairline` row borders. Two columns, no highlight row.
- Table marginTop: 32.

---

## Section 3: Privacy — Expanded (REPLACES existing Privacy section)

**Position:** After protocol flow (same position as current privacy section).

**Eyebrow:** `Privacy`

**Heading:** `Prove you can afford it. Never say how much you have.` (preserved from current landing page — strong copy)

**Subtext:** `Two protections are always on. The third kicks in when you choose it.`

**3 cards with status badges** (the existing "Non-Repudiation" card is removed here — dual-signed commitment is now covered in the Value Prop section's "Cryptographic Commitment" card, so it doesn't need to be repeated under Privacy):

| Card | Badge | Title | Detail |
|------|-------|-------|--------|
| 1 | `ALWAYS ON` | Privacy Sanitizer | Every strategy output passes through a non-bypassable sanitizer. Buyer price clamped to budget_hard. Seller price floored at floor_price. Runs locally before any data leaves the agent. Cannot be skipped. |
| 2 | `ALWAYS ON` | Seller Isolation | Each seller sees only their own thread — the RFQ, their offers, counters addressed to them, and terminal events. No visibility into competing bids, other sellers' prices, or the buyer's private state. Enforced by the engine's role-scoped event filter. |
| 3 | `OPT-IN` | ZK Budget Proof | Buyer publishes a Poseidon commitment to budget_hard in the RFQ. From that point, every counter-offer must carry a Groth16 proof that counter_price ≤ budget_hard. Sellers verify the proof without learning the budget. ~200ms to generate, instant to verify. |

**Phase table below cards — shows when each layer is active:**

```
Phase               Sanitizer    Seller Isolation    ZK Proof
─────────────────────────────────────────────────────────────
RFQ created              ●              ●           commitment published (if opted in)
Offer submitted          ●              ●           —
Counter sent             ●              ●           proof required (if commitment exists)
Quote signed             ●              ●           —
Settlement               ●              ●           —
```

**Implementation notes:**

- Badge: Small `<span>` positioned top-left of card.
  - `ALWAYS ON` badge: `background: var(--text-color)`, `color: var(--bg-color)`, monospace 0.55rem, padding `2px 8px`, borderRadius 2.
  - `OPT-IN` badge: `border: 1px solid var(--secondary-color)`, `color: var(--secondary-color)`, same font/size.
- Card style: Same as existing PrivacyCard but with `position: relative` and `paddingTop: 32` to leave room for badge.
- Grid: `gridTemplateColumns: mobile ? "1fr" : "1fr 1fr 1fr"`, gap 24.
- Phase table: Rendered as `<table>` in monospace, same style as comparison table. The `●` character rendered directly. "commitment published (if opted in)" and "proof required (if commitment exists)" in `--secondary-color` italic.
- Phase table marginTop: 32.
- Phase table must be wrapped in `overflowX: "auto"` container for mobile (long text in ZK Proof column will overflow).

---

## Section 4: Why Solana (NEW)

**Position:** After privacy, before roles.

**Eyebrow:** `Why Solana`

**Heading:** `Built on Solana for a reason.`

**Subtext:** `We picked Solana on purpose. Every technical choice maps to something Solana already does well.`

**Table with 3 columns:**

| What Ghost Bazaar Needs | What Solana Provides | Category |
|---|---|---|
| Fast settlement confirmation | ~400ms block time, seconds to confirmed commitment vs 12s+ on Ethereum | Technical |
| Cheap agent-to-agent transactions | ~$0.00025 per tx vs $0.50+ on Ethereum | Technical |
| Ed25519 native signatures | Solana keypairs are Ed25519 — no adapter, DID derivation is direct | Technical |
| SPL token payment rails | USDC on SPL with memo program for quote binding | Technical |
| On-chain agent identity | 8004 Agent Registry on Solana — agents register as Metaplex Core NFTs | Ecosystem |
| Reputation engine | ATOM feedback system built on 8004, Sybil-resistant post-settlement scoring | Ecosystem |
| Agent commerce momentum | x402 Solana facilitator, agent frameworks, and token infrastructure converging here | Ecosystem |

**Implementation notes:**
- Same `<table>` style as existing comparison table.
- Use two sub-header rows within the table: `Technical Fit` and `Ecosystem Fit` as full-width section rows (colSpan 2, uppercase monospace 0.6rem, `--secondary-color`, paddingTop 20). No separate category column — keeps the table clean at 2 columns.
- Table marginTop: 32.

---

## Components to Create

| Component | File | Purpose |
|-----------|------|---------|
| `ValuePropSection` | New standalone file | Section 1: problem hook + 3 cards |
| `OriginSection` | New standalone file | Section 2: x402 narrative + before/after table |
| `WhySolanaSection` | New standalone file | Section 4: technical + ecosystem fit table |
| `ArchitectureSection` | New standalone file | Section 5: 7-layer stack + package grid |
| (modified) Privacy section | In `LandingContent.tsx` | Section 3: badge variant + phase table |
| (modified) Stats section | In `LandingContent.tsx` | Section 6: 671 tests, 6 stat cards |

**Decision: inline vs separate files.** The existing `LandingContent.tsx` already contains all section sub-components inline (PrivacyCard, RoleCard, CompRow, StatCard, CtaButton). Follow this pattern: add new sections and sub-components inline in the same file. Extract to separate files only if `LandingContent.tsx` exceeds ~600 lines, which it likely will — in that case, extract each new section into its own file under `frontend/src/components/` following the `ProtocolSection.tsx` pattern (self-contained with local styles).

**Recommended approach:** Extract each new section as a standalone component file:
- `frontend/src/components/ValuePropSection.tsx`
- `frontend/src/components/OriginSection.tsx`
- `frontend/src/components/WhySolanaSection.tsx`

Modify the existing privacy section inline in `LandingContent.tsx` since it's a modification, not a new section.

---

## Section 5: Architecture (NEW)

**Position:** After Why Solana, before Roles. Shows the 7-layer stack so judges understand the engineering depth.

**Eyebrow:** `Architecture`

**Heading:** `Seven layers. One monorepo.`

**Subtext:** `Each layer does one thing. Dependencies only flow downward.`

**Vertical stack diagram** (rendered as a styled list or ASCII-style block, not an image):

```
Layer 7    MCP Server              Exposes tools to Claude Desktop / Claude Code
Layer 6    Agent Runtime            BuyerAgent + SellerAgent orchestrators
Layer 5    Settlement               17-step Solana payment verification
Layer 4    Negotiation Engine       Hono HTTP server, state machine, event log
Layer 3    Strategy                 6 rule-based + 2 LLM strategies, privacy sanitizer
Layer 2    ZK                       Poseidon commitment + Groth16 budget proof
Layer 1    Core                     Schemas, Ed25519 signing, canonical JSON, DIDs
```

**Below the stack, a compact package status grid** (3-column on desktop, 1-column on mobile):

| Package | Status | Key numbers |
|---------|--------|-------------|
| `@ghost-bazaar/core` | Complete | 104 tests |
| `@ghost-bazaar/strategy` | Complete | 76 tests |
| `@ghost-bazaar/zk` | Complete | 15 tests |
| `@ghost-bazaar/agents` | Complete | 26 tests |
| `@ghost-bazaar/engine` | Complete | 371 tests |
| `@ghost-bazaar/settlement` | Complete | 50 tests |
| `@ghost-bazaar/mcp` | Complete | 29 tests |

**Implementation notes:**
- Stack diagram: Rendered as a monospace block inside a bordered container (same `border: 1px solid var(--hairline)` + `borderRadius: 4` pattern as ProtocolSection's ASCII art box). Use `cornerLabel` pattern (extract from ProtocolSection.tsx or duplicate): top-left "ARCHITECTURE", top-right "v4". Wrap in `overflowX: "auto"` for mobile (lines are ~70 chars wide).
- Package status grid: `gridTemplateColumns: mobile ? "1fr" : "1fr 1fr 1fr"` with small cards. Each card shows package name (mono, 0.75rem), status as a small badge, and test count.

---

## Section 6: Verification Stats (UPDATED — replaces existing stats section)

The existing stats section shows stale numbers. Update with current counts:

| Stat | Old Value | New Value |
|------|-----------|-----------|
| Test Cases | 564 | **671** |
| State Machine | 6 | 6 (unchanged) |
| Commitment | Ed25519 | Ed25519 (unchanged) |
| Settlement Checks | 17 | 17 (unchanged) |

**Add 2 new stat cards** to the existing 4 (6 total, 3x2 grid on desktop, 2x3 on mobile):

| number | label | detail |
|--------|-------|--------|
| 671 | Test Cases | Across 7 packages |
| 6 | State Machine | Explicit transition rules |
| Ed25519 | Commitment | Dual-signed quotes |
| 17 | Settlement Checks | Verification path |
| 7 | Packages | Monorepo architecture |
| 4 | Protocol Phases | Discovery → Settlement |

**Implementation notes:**
- Update grid to `gridTemplateColumns: mobile ? "1fr 1fr" : "1fr 1fr 1fr"` (3 columns desktop for 6 cards, 2 columns mobile).
- Same `StatCard` component, just updated data.

---

## Existing Sections — No Changes

The following sections remain untouched:

- **ProtocolSection** (`ProtocolSection.tsx`) — 4-phase carousel with ASCII art
- **Roles section** — Buyer/Seller RoleCards
- **Comparison table** — Ghost Bazaar vs x402 vs Virtuals vs OpenAI vs Google
- **CTA** — "The negotiation layer designed to compose with x402-style settlement"

---

## Style Reference

All new components must use these existing patterns from `globals.css` and `LandingContent.tsx`. **Important:** Copy from `LandingContent.tsx` (canonical source), not from `ProtocolSection.tsx` which has divergent copies. Consider extracting shared styles into `frontend/src/styles/shared.ts` during implementation to prevent further duplication (5 files will share these styles).

```typescript
// CSS Variables (from globals.css)
--bg-color: #ffffff
--text-color: #111111
--secondary-color: #888888
--hairline: #e5e5e5
--font-main: "Inter", ...
--font-mono: "SF Mono", "Menlo", ...

// Shared styles (from LandingContent.tsx — copy or import)
sectionStyle(mobile)  // padding + maxWidth 960 + margin auto
eyebrow               // monospace 0.65rem uppercase, --secondary-color
heading(mobile)        // 1.8/2.8rem, weight 300, --text-color
bodyText(mobile)       // 0.85/0.95rem, --secondary-color, lineHeight 1.7
divider                // width 40, height 1, --hairline, margin auto
```

---

## Extensibility Notes (Internal — not shown on landing page)

This section structure supports future additions without reorganization:

- **ZK encrypted negotiation:** Add to Privacy section as a 4th card
- **Reverse auction / MEV protection:** Add as new section between Origin and Protocol, or new cards in Value Prop
- **New packages:** Add row to Architecture stack + package grid
- **Cross-chain:** Add row to Why Solana table

The value prop heading ("The negotiation protocol for autonomous agents") is stable regardless of these additions. No "coming soon" or "future" language should appear on the landing page — only ship what's built.
