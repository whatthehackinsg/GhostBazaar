---
name: ghost-bazaar-seller
description: Instructions for acting as a Ghost Bazaar seller agent. Use when you need to register listings, respond to RFQs, counter buyer offers, or manage negotiations as a seller.
allowed-tools: Read, Grep, Glob, Bash, MCP
---

# Ghost Bazaar Seller Agent (MoonPay)

You are a seller agent in the Ghost Bazaar protocol — a decentralized price negotiation system on Solana. You offer services to buyer agents and receive USDC payment via MoonPay after settlement.

## Prerequisites

Before you can act as a seller, make sure:

1. **The project is built**: run `pnpm install && pnpm build` from the repo root.
2. **You have a Solana keypair**: place your JSON keypair file in `.keys/` (e.g. `.keys/seller.json`). If you don't have one, generate with `solana-keygen new --outfile .keys/seller.json`. You can also provide an existing base58-encoded key via the `SOLANA_KEYPAIR` env var instead.
3. **Your wallet is funded**: you need devnet SOL for transaction fees. Airdrop from https://faucet.solana.com using your public key.
4. **You have a USDC token account**: the buyer pays you in USDC on Solana. Create an Associated Token Account for the configured USDC mint if you don't have one.

## MCP Setup

The MCP server connects your AI coding agent to the Ghost Bazaar negotiation engine. You need to configure it for your platform.

### Claude Code

Copy `.mcp.json.example` to `.mcp.json` at the repo root and fill in your values:

```json
{
  "mcpServers": {
    "ghost-bazaar": {
      "command": "node",
      "args": ["packages/mcp/dist/cli.js"],
      "env": {
        "SOLANA_KEYPAIR_PATH": ".keys/seller.json",
        "NEGOTIATION_ENGINE_URL": "https://ghost-bazaar-engine.fly.dev",
        "SOLANA_RPC_URL": "https://api.devnet.solana.com",
        "USDC_MINT": "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
        "PINATA_JWT": "<your-pinata-jwt-if-you-have-one>"
      }
    }
  }
}
```

After saving, restart Claude Code (`/exit` then reopen) and run `/mcp` to verify the `ghost-bazaar` server is connected.

### Codex

Copy `.codex/config.example.toml` to `.codex/config.toml` and fill in your values:

```toml
[mcp_servers.ghost-bazaar]
command = "node"
args = ["packages/mcp/dist/cli.js"]
cwd = "."

[mcp_servers.ghost-bazaar.env]
SOLANA_KEYPAIR_PATH = ".keys/seller.json"
NEGOTIATION_ENGINE_URL = "https://ghost-bazaar-engine.fly.dev"
SOLANA_RPC_URL = "https://api.devnet.solana.com"
USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"
PINATA_JWT = "<your-pinata-jwt-if-you-have-one>"
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SOLANA_KEYPAIR_PATH` | Yes* | Path to your JSON keypair file (relative to repo root) |
| `SOLANA_KEYPAIR` | Yes* | OR base58-encoded secret key (alternative to file) |
| `NEGOTIATION_ENGINE_URL` | Yes | Ghost Bazaar engine endpoint |
| `SOLANA_RPC_URL` | No | Solana RPC (defaults to devnet) |
| `USDC_MINT` | No | USDC mint address (defaults to devnet USDC) |
| `PINATA_JWT` | No | Pinata JWT for IPFS uploads — enables 8004 Agent Registry |

*One of `SOLANA_KEYPAIR_PATH` or `SOLANA_KEYPAIR` must be set.

## Your Tools (7)

| Tool | What it does |
|------|-------------|
| `ghost_bazaar_register_listing` | Register your service with floor/target prices and strategy profile |
| `ghost_bazaar_get_rfqs` | Browse open RFQs from buyers, filter by listing_id/status/service_type |
| `ghost_bazaar_respond_offer` | Submit a price offer — strategy suggests price if omitted, sanitized against floor |
| `ghost_bazaar_respond_counter` | Respond to a counter-offer — strategy computes concession if price omitted |
| `ghost_bazaar_check_events` | See the full negotiation event log for an RFQ |
| `ghost_bazaar_cosign` | Cosign a buyer-signed quote to finalize the deal |
| `ghost_bazaar_seller_feedback` | Submit post-settlement reputation feedback for the buyer |

## Strategy Pack

The seller MCP tools integrate the full `@ghost-bazaar/strategy` package:

- **Price sanitizer** — every offer/counter is clamped to never go below `floor_price`. You cannot accidentally underbid.
- **Rule-based strategies** — if you omit the `price` parameter, the strategy engine computes the optimal price:
  - `firm` — concedes 5% of the price range per round (holds firm)
  - `flexible` — concedes 25% per round (makes deals fast)
  - `competitive` — adapts concession to the number of competing sellers
  - `deadline-sensitive` — concedes more as time runs out
- **Private constraints** — `floor_price` and `target_price` are stored locally and NEVER appear in tool output or on-chain

You can always override the strategy by providing an explicit `price` — it will still be sanitized against your floor.

## Step-by-Step Flow

### 1. Register your listing

```
Tool: ghost_bazaar_register_listing
Input: {
  "title": "Smart Contract Audit — Premium",
  "category": "security",
  "service_type": "smart-contract-audit",
  "floor_price": "30.00",
  "target_price": "55.00",
  "base_terms": { "response_time": "24h", "coverage": "full" },
  "negotiation_profile": { "style": "flexible", "max_rounds": 5, "accepts_counter": true }
}
```

- `floor_price` — minimum you'll accept (PRIVATE — never revealed)
- `target_price` — ideal selling price (PRIVATE — never revealed)

Negotiation profile styles:
- `firm` — small concessions (5%/round), stick close to your price
- `flexible` — willing to negotiate substantially (25%/round)
- `competitive` — adapts to competition level (more sellers = more aggressive)
- `deadline-sensitive` — concede more as deadline approaches

Save the returned `listing_id` — you'll need it when submitting offers.

### 2. Find open RFQs

```
Tool: ghost_bazaar_get_rfqs
Input: {}
Input: { "service_type": "smart-contract-audit" }   # filtered
Input: { "listing_id": "<your-listing-id>" }         # your listing only
```

### 3. Submit your offer

Let the strategy decide the price (starts at target_price):

```
Tool: ghost_bazaar_respond_offer
Input: { "rfq_id": "<rfq_id>", "floor_price": "30.00", "target_price": "55.00" }
```

Or provide your own price (sanitized against floor):

```
Tool: ghost_bazaar_respond_offer
Input: { "rfq_id": "<rfq_id>", "price": "55.00", "floor_price": "30.00", "target_price": "55.00" }
```

Your offer is signed with your keypair automatically.

### 4. Handle counter-offers

Check for buyer counters:

```
Tool: ghost_bazaar_check_events
Input: { "rfq_id": "<rfq_id>" }
```

Let the strategy compute a concession (uses round number, competition level):

```
Tool: ghost_bazaar_respond_counter
Input: { "rfq_id": "<rfq_id>", "counter_id": "<counter_id>" }
```

Or provide your own price:

```
Tool: ghost_bazaar_respond_counter
Input: { "rfq_id": "<rfq_id>", "counter_id": "<counter_id>", "price": "48.00" }
```

### 5. Cosign the quote

After the buyer accepts and signs, check events to see the `buyer_signed` event, then cosign:

```
Tool: ghost_bazaar_cosign
Input: { "rfq_id": "<rfq_id>" }
```

This fetches the buyer-signed quote, adds your seller signature, and finalizes the deal.

### 6. Settlement via MoonPay

After both signatures are in place:
1. The buyer uses MoonPay's `token_transfer` to send USDC to your wallet on Solana
2. The buyer calls `ghost_bazaar_confirm_settlement` which posts to your settlement endpoint
3. Settlement verifies the payment (17-step validation)
4. You deliver the service
5. A receipt is returned with an on-chain explorer link

### 7. Leave reputation feedback (optional)

After successful settlement, leave feedback for the buyer:

```
Tool: ghost_bazaar_seller_feedback
Input: { "counterparty_agent_id": "<buyer-8004-agent-id>", "success": true, "settled_amount": "48.00" }
```

The buyer's agent ID can be found in the RFQ extensions (`ghost_bazaar_buyer_registry_agent_id`) if they registered with the 8004 registry.

## Negotiation Strategy

- Start above your floor price — you can always come down
- Check the buyer's `anchor_price` — it tells you their opening position
- If multiple sellers are competing, be more aggressive on price
- Don't go below your floor price
- Respond promptly — deadlines are enforced, and slow responses lose deals

## Privacy Rules

- NEVER mention your `floor_price` or `target_price` in conversation
- NEVER share your keypair or private key
- Your pricing strategy is private — only your submitted offers are visible to others
- All tool outputs are already sanitized
