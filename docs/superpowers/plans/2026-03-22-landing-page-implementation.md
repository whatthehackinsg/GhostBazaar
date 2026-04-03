# Implementation Plan: Landing Page Updates

**Spec:** `docs/superpowers/specs/2026-03-22-landing-page-x402-comparison-design.md`
**Owner:** Frontend teammate
**Scope:** 4 new components, 2 modified sections in `LandingContent.tsx`, 1 shared styles extraction

---

## Prerequisites

- Read the spec first
- `pnpm install` in `frontend/`
- `pnpm dev` on localhost:5173
- Landing page loads with scroll-reveal hero

---

## Step 1: Extract shared styles

**File:** `frontend/src/styles/shared.ts` (NEW)

Extract from `LandingContent.tsx` lines 7-43:
- `sectionStyle(mobile)`
- `eyebrow`
- `heading(mobile)` — use the LandingContent version which has `marginBottom: 20`
- `bodyText(mobile)`
- `divider`
- Also extract `cornerLabel()` from `ProtocolSection.tsx` (lines 196-211) — needed by both ProtocolSection and the new ArchitectureSection

Export all as named exports. Update `LandingContent.tsx` and `ProtocolSection.tsx` to import from `shared.ts`.

**Note:** ProtocolSection's local `heading` omits `marginBottom`. After switching to shared `heading`, ProtocolSection may need to override with `marginBottom: 0` or `undefined` if the spacing looks off. Check visually.

**Verify:** Page renders identically before and after.

---

## Step 2: Create `ValuePropSection.tsx`

**File:** `frontend/src/components/ValuePropSection.tsx` (NEW)

- Eyebrow: "What Is Ghost Bazaar"
- Heading: "The negotiation protocol for autonomous agents."
- Problem hook paragraph:

> Agents know how to pay. They don't know how much. Payment rails exist — what's missing is the haggling. Who sets the price? What if there are five sellers? What if you don't want to show your budget? That's Ghost Bazaar.

- 3-card grid (`gridTemplateColumns: mobile ? "1fr" : "1fr 1fr 1fr"`, gap 24):

| Title | One-liner |
|-------|-----------|
| Multi-Round Negotiation | Structured RFQ → Offer → Counter → Quote. Not one-shot pricing. |
| Competitive Bidding | Multiple sellers compete. Buyer sees all offers. Sellers see only their own. |
| Cryptographic Commitment | Ed25519 dual-signed quotes lock terms before payment. No trust required. |

- Card style: match existing PrivacyCard — no border, title at `mobile ? "0.9rem" : "1rem"` / 500 weight, detail in mono `mobile ? "0.7rem" : "0.75rem"`
- Import shared styles from `../styles/shared`

**Verify:** 3-col desktop, 1-col mobile.

---

## Step 3: Create `OriginSection.tsx`

**File:** `frontend/src/components/OriginSection.tsx` (NEW)

- Eyebrow: "Origin"
- Heading: "Built on the shoulders of x402."
- 3 narrative paragraphs in `bodyText` style:

> x402 got the hard part right: agents paying each other over HTTP with cryptographic receipts. Server names a price, client pays, done.

> We started there. Then we hit the questions it doesn't answer. What if the price should be negotiated, not fixed? What if three sellers can do the job? What if the buyer has a ceiling they can't afford to reveal?

> So we built the layer that sits in front of settlement.

- Last paragraph: `color: var(--text-color)`, `fontWeight: 500`
- Two-column table below (marginTop 32), same style as existing comparison table:

| x402 gives you | Ghost Bazaar adds |
|---|---|
| Fixed server-set price | Multi-round price negotiation |
| Single seller per request | Competitive multi-seller bidding |
| Budget visible in payment | ZK budget proof (Poseidon + Groth16) |
| Pay-then-access | Dual-signed quote commitment before payment |
| No formal state machine | 6-state machine with append-only event log |

- Wrap table in `overflowX: "auto"` for mobile

**Verify:** Narrative reads naturally, table matches comparison table style.

---

## Step 4: Expand Privacy section in `LandingContent.tsx`

**Modify:** `frontend/src/components/LandingContent.tsx`, Privacy section (lines 77-108)

- Keep heading: "Prove you can afford it. Never say how much you have."
- Add subtext below heading: "Two protections are always on. The third kicks in when you choose it."
- Replace 3 existing `PrivacyCard` with new `BadgePrivacyCard` that takes a `badge` prop:
  - Card 1: badge `ALWAYS ON`, title "Privacy Sanitizer", detail: "Every strategy output passes through a non-bypassable sanitizer. Buyer price clamped to budget_hard. Seller price floored at floor_price. Runs locally before any data leaves the agent. Cannot be skipped."
  - Card 2: badge `ALWAYS ON`, title "Seller Isolation", detail: "Each seller sees only their own thread — the RFQ, their offers, counters addressed to them, and terminal events. No visibility into competing bids, other sellers' prices, or the buyer's private state. Enforced by the engine's role-scoped event filter."
  - Card 3: badge `OPT-IN`, title "ZK Budget Proof", detail: "Buyer publishes a Poseidon commitment to budget_hard in the RFQ. From that point, every counter-offer must carry a Groth16 proof that counter_price ≤ budget_hard. Sellers verify the proof without learning the budget. ~200ms to generate, instant to verify."
- Remove old "Non-Repudiation" card (covered by Value Prop's "Cryptographic Commitment")
- Badge styles:
  - `ALWAYS ON`: `background: var(--text-color)`, `color: var(--bg-color)`, mono 0.55rem, padding `2px 8px`, borderRadius 2
  - `OPT-IN`: `border: 1px solid var(--secondary-color)`, `color: var(--secondary-color)`, same font
- Card: add `position: relative`, `paddingTop: 32` for badge space
- Add phase table below cards (marginTop 32, wrapped in `overflowX: "auto"`):

```
Phase               Sanitizer    Seller Isolation    ZK Proof
─────────────────────────────────────────────────────────────
RFQ created              ●              ●           commitment published (if opted in)
Offer submitted          ●              ●           —
Counter sent             ●              ●           proof required (if commitment exists)
Quote signed             ●              ●           —
Settlement               ●              ●           —
```

- Render as `<table>`, mono font, same style as comparison table. Italic for parenthetical text.

**Verify:** Badges render, phase table scrolls on mobile, no overflow.

---

## Step 5: Create `WhySolanaSection.tsx`

**File:** `frontend/src/components/WhySolanaSection.tsx` (NEW)

- Eyebrow: "Why Solana"
- Heading: "Built on Solana for a reason."
- Subtext: "We picked Solana on purpose. Every technical choice maps to something Solana already does well."
- Table (marginTop 32, wrapped in `overflowX: "auto"`), 2 data columns with sub-header rows:

**Sub-header: "Technical Fit"** (colSpan 2, mono 0.6rem uppercase, `--secondary-color`, paddingTop 20)

| What Ghost Bazaar Needs | What Solana Provides |
|---|---|
| Fast settlement confirmation | ~400ms block time, seconds to confirmed commitment vs 12s+ on Ethereum |
| Cheap agent-to-agent transactions | ~$0.00025 per tx vs $0.50+ on Ethereum |
| Ed25519 native signatures | Solana keypairs are Ed25519 — no adapter, DID derivation is direct |
| SPL token payment rails | USDC on SPL with memo program for quote binding |

**Sub-header: "Ecosystem Fit"**

| What Ghost Bazaar Needs | What Solana Provides |
|---|---|
| On-chain agent identity | 8004 Agent Registry on Solana — agents register as Metaplex Core NFTs |
| Reputation engine | ATOM feedback system built on 8004, Sybil-resistant post-settlement scoring |
| Agent commerce momentum | x402 Solana facilitator, agent frameworks, and token infrastructure converging here |

- Table style: match existing comparison table

**Verify:** Sub-headers group rows clearly. Table scrolls on mobile.

---

## Step 6: Create `ArchitectureSection.tsx`

**File:** `frontend/src/components/ArchitectureSection.tsx` (NEW)

- Eyebrow: "Architecture"
- Heading: "Seven layers. One monorepo."
- Subtext: "Each layer does one thing. Dependencies only flow downward."
- Stack diagram in bordered container (same as ProtocolSection's ASCII art box):
  - Use `cornerLabel` from shared styles: top-left "ARCHITECTURE", top-right "v4"
  - Wrap in `overflowX: "auto"` (lines are ~70 chars, will overflow on narrow screens)
  - Content (monospace `<pre>` or styled divs):

```
Layer 7    MCP Server              Exposes tools to Claude Desktop / Claude Code
Layer 6    Agent Runtime            BuyerAgent + SellerAgent orchestrators
Layer 5    Settlement               17-step Solana payment verification
Layer 4    Negotiation Engine       Hono HTTP server, state machine, event log
Layer 3    Strategy                 6 rule-based + 2 LLM strategies, privacy sanitizer
Layer 2    ZK                       Poseidon commitment + Groth16 budget proof
Layer 1    Core                     Schemas, Ed25519 signing, canonical JSON, DIDs
```

- Package grid below (marginTop 32, `gridTemplateColumns: mobile ? "1fr" : "1fr 1fr 1fr"`)
- 7 small cards, each showing:
  - Package name (mono 0.75rem)
  - Test count (mono 0.65rem, `--secondary-color`)

| Package | Tests |
|---------|-------|
| @ghost-bazaar/core | 104 |
| @ghost-bazaar/strategy | 76 |
| @ghost-bazaar/zk | 15 |
| @ghost-bazaar/agents | 26 |
| @ghost-bazaar/engine | 371 |
| @ghost-bazaar/settlement | 50 |
| @ghost-bazaar/mcp | 29 |

**Verify:** Stack diagram readable on all screen sizes (scrolls on narrow). Package grid 3-col desktop / 1-col mobile.

---

## Step 7: Update Verification Stats in `LandingContent.tsx`

**Modify:** `frontend/src/components/LandingContent.tsx`, Stats section (lines 208-224)

- Update test count: 564 → **671**
- Update detail: "Across all packages" → "Across 7 packages"
- Add 2 new StatCards (6 total):

```tsx
<StatCard number="671" label="Test Cases" detail="Across 7 packages" mobile={mobile} />
<StatCard number="6" label="State Machine" detail="Explicit transition rules" mobile={mobile} />
<StatCard number="Ed25519" label="Commitment" detail="Dual-signed quotes" mobile={mobile} />
<StatCard number="17" label="Settlement Checks" detail="Verification path" mobile={mobile} />
<StatCard number="7" label="Packages" detail="Monorepo architecture" mobile={mobile} />
<StatCard number="4" label="Protocol Phases" detail="Discovery → Settlement" mobile={mobile} />
```

- Update grid: `gridTemplateColumns: mobile ? "1fr 1fr" : "1fr 1fr 1fr"` (3-col desktop for 6 cards)

**Verify:** 3x2 grid desktop, 2x3 mobile.

---

## Step 8: Wire everything into `LandingContent.tsx`

**Modify:** `frontend/src/components/LandingContent.tsx`

Add imports and reorder sections:

```tsx
import { ValuePropSection } from "./ValuePropSection"
import { OriginSection } from "./OriginSection"
import { ProtocolSection } from "./ProtocolSection"
import { WhySolanaSection } from "./WhySolanaSection"
import { ArchitectureSection } from "./ArchitectureSection"

// In render — this is the full section order:
<ValuePropSection />        {/* 1. replaces old "The Problem" */}
<div style={divider} />
<OriginSection />            {/* 2. x402 story */}
<div style={divider} />
<ProtocolSection />          {/* 3. existing */}
<div style={divider} />
{/* Privacy section */}      {/* 4. expanded inline */}
<div style={divider} />
<WhySolanaSection />         {/* 5. new */}
<div style={divider} />
<ArchitectureSection />      {/* 6. new */}
<div style={divider} />
{/* Roles section */}        {/* 7. existing */}
<div style={divider} />
{/* Comparison table */}     {/* 8. existing */}
<div style={divider} />
{/* Stats section */}        {/* 9. updated */}
<div style={divider} />
{/* CTA section */}          {/* 10. existing */}
```

**Delete** the old "The Problem" section (lines 52-67).

**Add section IDs** for any new sections that NavOverlay might link to:
- `id="section-origin"` on OriginSection
- `id="section-solana"` on WhySolanaSection
- `id="section-architecture"` on ArchitectureSection

**Update NavOverlay sectionMap** in `LandingPage.tsx` (line 84-88) if adding nav items for new sections. At minimum, verify existing links (Protocol, Privacy, About) still scroll correctly.

**Verify:** All 10 sections render with dividers. No duplicate content. Nav links work.

---

## Step 9: Final check

- [ ] Desktop: all 10 sections, scroll-reveal hero still works
- [ ] Mobile: grids collapse, tables scroll horizontally, badges visible
- [ ] No duplicate content (problem hook in Value Prop only, commitment in Value Prop only)
- [ ] Privacy badges: "ALWAYS ON" = filled, "OPT-IN" = outline
- [ ] Phase table: ● dots render, italic annotations readable
- [ ] Architecture: bordered monospace box with corner labels, package grid
- [ ] Stats: **671** tests (not 564), 6 cards in 3x2 grid
- [ ] Nav links: Protocol, Privacy, About scroll correctly
- [ ] Zero "coming soon" / "future" / "planned" language
- [ ] All claims accurate — nothing about features that aren't built

---

## File Summary

| File | Action |
|------|--------|
| `frontend/src/styles/shared.ts` | CREATE — shared style exports |
| `frontend/src/components/ValuePropSection.tsx` | CREATE — problem hook + 3 cards |
| `frontend/src/components/OriginSection.tsx` | CREATE — x402 narrative + table |
| `frontend/src/components/WhySolanaSection.tsx` | CREATE — tech + ecosystem table |
| `frontend/src/components/ArchitectureSection.tsx` | CREATE — 7-layer stack + package grid |
| `frontend/src/components/LandingContent.tsx` | MODIFY — privacy, stats, section order, imports |
| `frontend/src/components/ProtocolSection.tsx` | MODIFY — import shared styles |
| `frontend/src/pages/LandingPage.tsx` | MODIFY — NavOverlay sectionMap (if adding nav items) |

~7-8 files, ~400-500 lines new code, ~80 lines modified.
