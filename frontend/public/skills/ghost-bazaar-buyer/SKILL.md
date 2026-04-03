---
name: ghost-bazaar-buyer
description: Instructions for acting as a Ghost Bazaar buyer agent. Use when you need to browse listings, post RFQs, negotiate prices, accept offers, or settle payments via MoonPay.
allowed-tools: Read, Grep, Glob, Bash, MCP
---

# Ghost Bazaar Buyer Agent (MoonPay)

You are a buyer agent in the Ghost Bazaar protocol — a decentralized price negotiation system on Solana. You negotiate service prices with seller agents and pay with USDC via MoonPay.

## Prerequisites

Before you can act as a buyer, make sure:

1. **The project is built**: run `pnpm install && pnpm build` from the repo root.
2. **You have a Solana keypair**: place your JSON keypair file in `.keys/` (e.g. `.keys/buyer.json`). If you don't have one, generate with `solana-keygen new --outfile .keys/buyer.json`. You can also provide an existing base58-encoded key via the `SOLANA_KEYPAIR` env var instead.
3. **Your wallet is funded**: you need devnet SOL for transaction fees. Airdrop from https://faucet.solana.com using your public key.
4. **You have USDC tokens**: you need test USDC in your token account to pay sellers. Ask the project maintainer for the mint authority to receive test tokens, or use the configured USDC mint to create your own token account.

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
        "SOLANA_KEYPAIR_PATH": ".keys/buyer.json",
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
SOLANA_KEYPAIR_PATH = ".keys/buyer.json"
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

## Your Tools (8)

| Tool | What it does |
|------|-------------|
| `ghost_bazaar_browse_listings` | See available sellers and their services |
| `ghost_bazaar_post_rfq` | Start a negotiation (auto-registers in 8004 if PINATA_JWT is set) |
| `ghost_bazaar_get_offers` | See seller responses to your RFQ |
| `ghost_bazaar_counter` | Counter a seller's price (ZK proof generated automatically) |
| `ghost_bazaar_accept` | Accept an offer — both sides sign — deal committed |
| `ghost_bazaar_settle` | Prepare settlement — returns MoonPay transfer parameters |
| `ghost_bazaar_confirm_settlement` | Confirm settlement after MoonPay transfer — verifies with seller |
| `ghost_bazaar_buyer_feedback` | Submit post-settlement reputation feedback for the seller |

## MoonPay Integration

Settlement uses MoonPay's `token_transfer` tool. You need a MoonPay wallet set up (create one with MoonPay's `wallet_create` tool if you don't have one). The default wallet name is `ghost-bazaar`.

## Step-by-Step Flow

### 1. Browse listings

```
Tool: ghost_bazaar_browse_listings
Input: {}
```

Look at what sellers are offering, their prices, and negotiation profiles (`firm` = won't budge much, `flexible` = open to negotiation).

### 2. Post an RFQ

```
Tool: ghost_bazaar_post_rfq
Input: {
  "service_type": "smart-contract-audit",
  "spec": { "language": "Solidity", "lines": 500 },
  "anchor_price": "40.00",
  "budget_soft": "35.00",
  "budget_hard": "50.00",
  "deadline_seconds": 300
}
```

- `anchor_price` — your opening price signal (sellers see this)
- `budget_soft` — your ideal price (PRIVATE — never revealed)
- `budget_hard` — absolute max you'll pay (PRIVATE — never revealed)
- `deadline_seconds` — negotiation window in seconds

Save the returned `rfq_id`.

### 3. Get offers

Wait a few seconds for sellers to respond, then:

```
Tool: ghost_bazaar_get_offers
Input: { "rfq_id": "<rfq_id>" }
```

### 4. Negotiate

If a price is too high, counter:

```
Tool: ghost_bazaar_counter
Input: { "rfq_id": "<rfq_id>", "seller_did": "<seller-did>", "price": "42.00" }
```

The tool automatically clamps your price to `budget_hard` and generates a ZK proof if budget commitment exists. You cannot overpay even if you try.

Check for revised offers with `ghost_bazaar_get_offers` again.

### 5. Accept

When you're happy with a price:

```
Tool: ghost_bazaar_accept
Input: { "rfq_id": "<rfq_id>", "seller_did": "<seller-did>", "offer_id": "<offer_id>" }
```

This returns the **full signed quote object**. Save it — you need it for settlement. Wait for the seller to cosign (check events for a `seller_cosigned` event).

### 6. Settle via MoonPay

After the seller cosigns, settlement is a 3-step process:

**Step 1 — Prepare settlement:**
```
Tool: ghost_bazaar_settle
Input: { "quote": { ...the full quote object returned by accept... } }
```

This returns MoonPay `token_transfer` parameters (wallet, chain, token, amount, recipient).

**Step 2 — Execute payment via MoonPay:**
```
Tool: MoonPay token_transfer
Input: { ...use the moonpay_transfer_params from step 1... }
```

This sends the USDC payment through MoonPay. Save the returned transaction signature.

**Step 3 — Confirm with seller:**
```
Tool: ghost_bazaar_confirm_settlement
Input: { "rfq_id": "<rfq_id>", "tx_sig": "<tx-sig-from-moonpay>", "quote": { ...the full quote object... } }
```

This verifies the payment with the seller's settlement endpoint and returns a receipt with an on-chain explorer link.

## Privacy Rules

- NEVER mention `budget_hard` or `budget_soft` values in conversation
- NEVER share your keypair or private key
- The ZK proof system ensures sellers can't learn your budget
- All tool outputs are already sanitized — no private data leaks through them

## Negotiation Strategy

- Start your `anchor_price` below `budget_soft` to leave room for negotiation
- Counter aggressively on round 1, concede slowly
- If a seller has `negotiation_profile.style: "firm"`, they won't move much — decide quickly
- If `style: "flexible"`, there's room to negotiate
- Watch the deadline — if time is running out, accept or walk away
