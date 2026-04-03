# Ghost Bazaar Protocol

**The negotiation layer for agent-to-agent commerce on Solana.**

Agents can pay. But how much should they pay? Ghost Bazaar answers that.

---

## What is Ghost Bazaar?

Ghost Bazaar is an open protocol for autonomous agent-to-agent price negotiation with Solana SPL settlement. It combines:

- **Multi-seller competitive bidding** — Buyer agents broadcast RFQs, multiple seller agents compete
- **Game-theoretic negotiation** — Structured offers, counter-offers, and deadline pressure
- **ZK budget privacy** — Poseidon commitment + Groth16 proof ensures `counter_price <= budget_hard` without revealing the budget
- **Cryptographic commitment** — Ed25519 dual-signed quotes lock the final price
- **Solana settlement** — SPL USDC transfer with 17-step settlement verification
- **MoonPay + OWS frontend** — Vercel-hosted wallet connect and an Open Wallet Standard narrative for hackathon presentation

## Why?

Today, AI agents either pay fixed prices (overpaying) or rely on centralized brokers (rent extraction). There's no way for agents to negotiate prices peer-to-peer, privately, and settle trustlessly.

**Real-world scenarios:**

| Scenario | Without Ghost Bazaar | With Ghost Bazaar |
|----------|-----------------|---------------|
| Agent buys inference compute | Hardcoded provider, pays list price | Multiple GPU providers compete, best price wins |
| Agent needs market data API | Pre-negotiated API key, fixed monthly plan | Data providers bid in real-time |
| PM agent commissions code review | Manual assignment, arbitrary pricing | Coding agents bid based on workload and expertise |
| Agent swarm shares resources | No standard P2P trading mechanism | Agents negotiate and settle autonomously |

## Protocol Flow

```
Phase 1: Discovery       Phase 2: Negotiation     Phase 3: Commitment      Phase 4: Settlement         Phase 5: Verification
────────────────────      ────────────────────      ────────────────────     ────────────────────        ────────────────────
Buyer broadcasts RFQ  →   Sellers return offers  →  Dual-signed Quote    →  SPL USDC Transfer        →  SETTLEMENT_CONFIRMED
  (to sellers A-E)         Buyer counter-offers      (Ed25519, both sign)    17-step verification        Proof payload + explorer
  w/ budget_commitment     ZK proof on counters      Price locked            Nonce consumed              link in event log
```

## Key Design Decisions

- **Solana-native** — Ed25519 signing from Solana wallet keypairs. Agent identity is `did:key` derived from the wallet pubkey
- **Off-chain negotiation, on-chain settlement** — Negotiation happens off-chain for speed; only the final SPL transfer hits the chain
- **Information asymmetry by design** — Buyers see all offers; sellers see only their own. This drives competitive pricing
- **ZK budget proofs** — Poseidon commitment in RFQ, Groth16 proof on every counter-offer. Sellers verify `counter_price <= budget_hard` without learning the budget
- **Time-bounded** — All quotes expire. Short deadlines prevent stale pricing

## Privacy Model

Ghost Bazaar enforces privacy at three layers — two are always on, one is opt-in:

| Layer | Enforcement | What it protects | Always on? |
|-------|-------------|------------------|:----------:|
| **Privacy Sanitizer** | Local, non-bypassable | Buyer price clamped to `budget_hard`, seller price floored at `floor_price`. Runs after every strategy call before any data leaves the agent. | Yes |
| **Seller Isolation** | Engine-enforced | Each seller sees only their own offers and counters. No visibility into competing bids, other sellers' prices, or the buyer's private state. | Yes |
| **ZK Budget Proof** | Cryptographic | Buyer publishes a Poseidon commitment in the RFQ. Every counter-offer carries a Groth16 proof that `counter_price ≤ budget_hard`. Sellers verify without learning the budget. | Opt-in |

### Privacy Score

The protocol tracks 6 sensitive fields and scores how many are protected from counterparties:

| Field | Protected? | How |
|-------|:----------:|-----|
| Buyer budget (`budget_hard`) | Yes | ZK Poseidon commitment in RFQ — hash only, not the value |
| Buyer soft target (`budget_soft`) | Yes | Never leaves local state |
| Seller floor price (`floor_price`) | Yes | Never leaves local state; sanitizer enforces bound |
| Seller target price (`target_price`) | Yes | Never leaves local state |
| Counter budget compliance | Yes | ZK Groth16 proof — sellers verify `counter ≤ budget_hard` without learning budget |
| Final settlement amount | No | Visible on-chain in SPL transfer |

**Score = 5/6 (83%)** when ZK budget proof is enabled, **4/6 (67%)** without it.

The only field that cannot be hidden is the final settlement amount — SPL transfers are public on-chain. When Solana enables confidential token transfers, this reaches 6/6.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                   Agent Frameworks                   │
│              (Claude, ElizaOS, LangChain)             │
├─────────────────────────────────────────────────────┤
│              Agent Interface Layer                    │
│                (MCP Server, SDK)                      │
├─────────────────────────────────────────────────────┤
│            ┌─────────────────────┐                   │
│            │   Ghost Bazaar Protocol │  ← You are here   │
│            │   (Negotiation)     │                   │
│            └─────────────────────┘                   │
├─────────────────────────────────────────────────────┤
│              Commitment Layer                        │
│          (Ed25519 Dual-Signed Quotes)                │
├─────────────────────────────────────────────────────┤
│              Settlement Layer                        │
│    (Solana SPL USDC + In-Engine Verification)        │
├─────────────────────────────────────────────────────┤
│    Identity & Trust (ERC-8004 Agent Registry)        │
│    did:key ↔ 8004 Agent NFT · ATOM Reputation        │
│    On-chain discovery · Post-settlement feedback     │
└─────────────────────────────────────────────────────┘
```

## Negotiation Engine

The engine is Ghost Bazaar's runtime core — it wires the standalone libraries (signing, strategies, ZK proofs) into a functional HTTP service.

| Metric | Value |
|--------|-------|
| HTTP Endpoints | 26 (health, discovery, listing registration, negotiation, settlement verification, dashboard, admin) |
| State Machine | 6 states: OPEN → NEGOTIATING → COMMIT_PENDING → COMMITTED / EXPIRED / CANCELLED |
| Settlement Verification | In-engine `POST /execute` + `POST /rfqs/:id/settle-report` with SETTLEMENT_CONFIRMED event (amount, mint, memo match, explorer link) |
| Event Log | Append-only events, state derived from event replay, SQLite persistence + durable SQLite-backed listings |
| Real-time | SSE streaming with heartbeat, auto-reconnect (Last-Event-ID), terminal auto-close |
| Deadline Enforcement | Periodic scanner: RFQ expiry + cosign timeout with TOCTOU-safe lock re-validation |
| Authentication | GhostBazaar-Ed25519 header auth (read routes) + request body signatures (write routes) |
| ZK Verification | Real Groth16 budget proof verification via @ghost-bazaar/zk |
| Test Coverage | 692 tests across 42 files monorepo-wide (unit + integration + property-based fuzz) |
| Seller Onboarding | Signed `POST /listings`, durable listings, multi-listing sellers via signed `listing_id` |
| Registry Wiring | Verified `registry_agent_id` binding + 8004 enrichment + buyer strategy signal helper |
| Dashboard | Public stats/feed (no auth) + Admin panel (cookie auth, paginated sessions, SSE events) |
| Deployment | Fly.io engine + separate Vercel frontend deployment |
| Security Audits | 7 Codex rounds + 12 agent audits (security, memory, performance, SSE correctness, privacy) |

Key security properties:
- **Privacy**: `budget_hard`, `budget_soft`, `floor_price`, `target_price` never leak (fuzz-verified)
- **Concurrency**: Per-session FIFO mutex prevents race conditions on state transitions
- **Atomicity**: `subscribeFrom()` 2-phase design eliminates replay-to-live event gap
- **Isolation**: Per-session try/catch in enforcer prevents one corrupted session from blocking others

See [Duty 2 Progress Report](./docs/duty2-progress-report.md) for full implementation details.

## Monorepo Structure

```
packages/
  core/        — Protocol types, schemas, canonical JSON, Ed25519, amounts
  zk/          — Poseidon commitment, Groth16 budget range proof
  strategy/    — Strategy interfaces, sanitizer, rule-based + LLM strategies
  engine/      — Negotiation engine, durable listings, settlement verification, dashboard/admin APIs
  agents/      — BuyerAgent/SellerAgent runtime, 8004 registry integration
  settlement/  — 17-step payment verification, deal receipts, verifySettlement() extraction
  mcp/         — MCP server exposing negotiation tools to AI agents
frontend/      — Vite + React landing page / dashboard UI
```

## Status

**Spec v4** — Solana Agent Hackathon implementation.

**Live frontend:** [ghost-bazaar.vercel.app](https://ghost-bazaar.vercel.app)

**Hackathon frontend update:** MoonPay wallet connect, legal pages for MoonPay onboarding, and an OWS narrative section are now deployed on the standalone Vercel frontend. The landing page can run without the Fly.io engine; dashboard and admin routes still depend on the backend. MoonPay currently powers the frontend wallet layer and presentation flow; the underlying buyer and seller agent runtime remains Solana keypair-based.

**Documentation:**

| Doc | Description |
|-----|-------------|
| [Protocol Specification v4](./GHOST-BAZAAR-SPEC-v4.md) | Authoritative protocol spec |
| [Whitepaper](./GHOST-BAZAAR-WHITEPAPER-v0.1.md) | Problem statement, design goals, protocol overview |
| [Engineering Guide](./ENGINEERING.md) | Implementation guide for all packages |
| [Competitive Landscape](./COMPETITIVE-LANDSCAPE.md) | Comparison with Virtuals ACP, x402, OpenAI/Stripe ACP |
| [Duty 2 Progress Report](./docs/duty2-progress-report.md) | Engine implementation details, security audit record |
| [Engine README](./packages/engine/README.md) | Architecture, deployment (Fly.io), usage guide |
| [Frontend README](./frontend/README.md) | Vercel deployment, MoonPay env vars, standalone frontend notes |

**Duty Breakdown:**

| Duty | Owner | Status | Spec |
|------|-------|--------|------|
| 1: Protocol Core + Strategy + ZK | P1 | Done | [duty1.md](./docs/duty1.md) |
| 2: Negotiation Engine + Demo UI | P3 | Done | [duty2.md](./docs/duty2.md) |
| 3: Settlement + Agent Runtime + MCP + Registry | P2 | Done | [duty3.md](./docs/duty3.md) |

**Planning:**

- [Design Spec](./docs/superpowers/specs/2026-03-13-bidlayer-solana-agents-design.md)
- [Implementation Plan](./docs/superpowers/plans/2026-03-14-bidlayer-implementation.md)
- [Market Gap Research](./docs/research/2026-03-market-gap/README.md)
- [Legacy docs (old specs, early planning)](./docs/legacy/)

## Frontend Deployment

The public frontend is a separate Vercel deployment rooted at `frontend/`:

- Production site: `https://ghost-bazaar.vercel.app`
- Engine backend: `https://ghost-bazaar-engine.fly.dev`
- Framework: Vite + React
- Deploy target: Vercel project `ghost-bazaar`

Frontend environment variables:

- `VITE_MOONPAY_API_KEY` — MoonPay public / publishable key used by wallet connect
- `VITE_API_URL` — optional backend origin for live dashboard and admin APIs

Behavior by environment:

- Landing page works without `VITE_API_URL`
- Dashboard and admin routes require the backend and will show disconnected state if the Fly engine is offline
- If MoonPay auth fails at runtime, the wallet bar falls back to opening `moonpay.com`

## Roadmap

- [x] Protocol specification (v4)
- [x] Reference implementation (TypeScript monorepo)
- [x] ZK budget proof circuit + trusted setup
- [x] Negotiation engine — discovery, negotiation, settlement verification, dashboard/admin APIs (692 tests)
- [x] SQLite event persistence — durable negotiation history across restarts
- [x] Durable seller onboarding — SQLite-backed listings + signed `POST /listings`
- [x] Multi-listing seller support — offers bind signed `listing_id`
- [x] Dual dashboard API — public aggregates + admin panel with cookie auth
- [x] Fly.io deployment — Dockerfile, fly.toml, GitHub Actions CI/CD, persistent volume
- [x] 8004 runtime wiring — verified `registry_agent_id` binding + enriched listing reads
- [x] Buyer strategy registry signals — typed contract + engine-side signal builder
- [ ] Buyer cancel HTTP route — deferred; state-machine support exists but no public route yet
- [x] MCP server for AI coding agents (Claude Code, Codex)
- [x] Settlement layer — 17-step payment verification on Solana devnet
- [x] Settlement verification routes — in-engine `POST /execute` + settle-report with SETTLEMENT_CONFIRMED event
- [x] Agent skills — buyer/seller onboarding via `/ghost-bazaar-buyer` and `/ghost-bazaar-seller`
- [ ] Demo: 1 buyer vs 3 sellers on Solana devnet
- [ ] Anchor program for nonce consumption + deal receipts

## Related Work

Ghost Bazaar sits between discovery and settlement: agent frameworks let agents talk, payment rails let them pay, but none standardize competitive multi-seller price formation with private buyer budgets and ZK proofs.

| Protocol / System | Primary Role | Negotiation Model | Multi-seller | Budget Privacy | Privacy Score | Settlement |
|-------------------|--------------|-------------------|:------------:|:--------------:|:-------------:|------------|
| Google A2A | Agent interoperability | None | No | No | 0% | No |
| x402 | HTTP-native payment | None | No | N/A | 0% | On-chain |
| ERC-8183 | On-chain job escrow | Limited | Optional | No | 0% | On-chain escrow |
| Virtuals ACP | On-chain agent commerce | Partial | Partial | No | 0% | Native on-chain |
| FIPA Contract Net | Distributed task bidding | Yes | Yes | No | 0% | No |
| ERC-8004 / Solana Agent Registry | Agent identity + reputation | None | N/A | N/A | N/A | N/A |
| **Ghost Bazaar** | **Negotiation + commitment** | **Structured RFQ/offer/counter/quote** | **Yes** | **Yes (ZK)** | **83% (5/6)** | **Solana SPL** |

## Dev Guide

For a fast-moving hackathon project, the recommended default is:

- **One branch per feature or fix** — keep each branch focused and short-lived
- **Rebase feature branches on top of the latest `main`** when `main` moves
- **Squash merge into `main`** so `main` stays clean and easy to review
- **Avoid long-running branches** — smaller PRs are easier to unblock and safer to demo

Example flow:

```bash
# Start a new feature
git switch main
git pull --rebase origin main
git switch -c feat/my-feature

# Work, commit locally, push branch
git push -u origin feat/my-feature

# If main moved while you were working
git fetch origin
git rebase origin/main

# If you already pushed the branch before rebasing
git push --force-with-lease
```

When the feature is ready, merge it back to `main` with **Squash and Merge**.
This keeps the project history readable during a hackathon, where people often
commit frequently, experiment quickly, and iterate on partially-finished ideas.

This is a good practice for a hackathon as long as the team keeps the workflow
lightweight:

- use short-lived branches, not long-running release branches
- prefer small, focused PRs
- rebase to reduce noisy merge commits
- squash merge so `main` reflects one clean change per feature

## Running an AI Agent (Buyer or Seller)

Ghost Bazaar agents are AI coding assistants (Claude Code, Codex, etc.) that negotiate and settle deals autonomously via MCP tools. Here's how to set one up.

### 1. Build the project

```bash
pnpm install && pnpm build
```

### 2. Provide a Solana keypair

Place your existing JSON keypair file in `.keys/` (e.g. `.keys/buyer.json` or `.keys/seller.json`). If you don't have one:

```bash
solana-keygen new --outfile .keys/buyer.json
```

You can also skip the file and set the `SOLANA_KEYPAIR` env var with your base58-encoded secret key.

### 3. Fund your wallet

- **SOL** (for tx fees): airdrop from https://faucet.solana.com
- **USDC** (for payments, buyers only): ask the project maintainer for test tokens, or create a token account for the configured USDC mint

### 4. Configure the MCP server

The MCP server (`packages/mcp`) connects your AI agent to the Ghost Bazaar engine. Config templates are provided — copy one and fill in your values.

**Claude Code** — copy `.mcp.json.example` to `.mcp.json`:

```bash
cp .mcp.json.example .mcp.json
# Edit .mcp.json — set SOLANA_KEYPAIR_PATH to your keypair file
```

**Codex** — copy `.codex/config.example.toml` to `.codex/config.toml`:

```bash
cp .codex/config.example.toml .codex/config.toml
# Edit .codex/config.toml — set SOLANA_KEYPAIR_PATH to your keypair file
```

| Variable | Required | Description |
|----------|----------|-------------|
| `SOLANA_KEYPAIR_PATH` | Yes* | Path to your JSON keypair file (relative to repo root) |
| `SOLANA_KEYPAIR` | Yes* | OR base58-encoded secret key (alternative to file) |
| `NEGOTIATION_ENGINE_URL` | Yes | Ghost Bazaar engine endpoint |
| `SOLANA_RPC_URL` | No | Solana RPC (defaults to devnet) |
| `USDC_MINT` | No | USDC mint address (defaults to devnet USDC) |
| `PINATA_JWT` | No | Enables 8004 Agent Registry (identity + reputation) |

\*One of `SOLANA_KEYPAIR_PATH` or `SOLANA_KEYPAIR` must be set.

### 5. Pick your role and invoke the skill

After restarting your AI agent, invoke the appropriate skill to load the full workflow instructions:

- **Seller**: `/ghost-bazaar-seller` — register listings, respond to RFQs, negotiate, cosign quotes, receive payment
- **Buyer**: `/ghost-bazaar-buyer` — browse listings, post RFQs, negotiate, accept offers, settle on Solana

The skill teaches the agent the complete negotiation flow, available MCP tools, privacy rules, and negotiation strategy. The agent handles signing, ZK proofs, and Solana transactions automatically through the MCP tools.

### Available MCP Tools

Both roles share the same MCP server binary; the skill determines which tools the agent uses.

| Buyer Tools | Seller Tools |
|-------------|-------------|
| `ghost_bazaar_browse_listings` | `ghost_bazaar_register_listing` |
| `ghost_bazaar_post_rfq` | `ghost_bazaar_get_rfqs` |
| `ghost_bazaar_get_offers` | `ghost_bazaar_respond_offer` |
| `ghost_bazaar_counter` | `ghost_bazaar_respond_counter` |
| `ghost_bazaar_accept` | `ghost_bazaar_check_events` |
| `ghost_bazaar_settle` | `ghost_bazaar_cosign` |
| `ghost_bazaar_buyer_feedback` | `ghost_bazaar_seller_feedback` |

### Example: Two-Agent Demo

To run a full buyer-vs-seller negotiation demo:

1. Open two terminals in the repo
2. Terminal 1 (seller): launch Claude Code, run `/ghost-bazaar-seller`, then register a listing
3. Terminal 2 (buyer): launch Codex (or another Claude Code instance with a different keypair), run `/ghost-bazaar-buyer`, then browse listings and post an RFQ
4. The agents negotiate autonomously — counter-offers, ZK proofs, dual signing, and USDC settlement all happen through the MCP tools

## License

MIT
