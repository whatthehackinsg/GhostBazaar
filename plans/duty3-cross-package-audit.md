# Duty 3 Cross-Package Integration Audit

Audited: `origin/feat/duty3-settlement-agents-mcp` vs `main`
Date: 2026-03-22

---

## 1. Engine-Client -> Engine API Alignment

| engine-client method | HTTP | URL path | Engine route | Status |
|---|---|---|---|---|
| `getListings(serviceType?)` | GET | `/listings?service_type=X` | `GET /listings` accepts `?service_type` | **ALIGNED** |
| `getListing(id)` | GET | `/listings/:id` | `GET /listings/:id` | **ALIGNED** |
| `createListing(listing)` | POST | `/listings` | `POST /listings` | **ALIGNED** |
| `getRfqs(filters?)` | GET | `/rfqs?service_type&listing_id&status` | `GET /rfqs` accepts `?service_type`, `?state`, `?buyer` | **MISMATCHED** |
| `postRfq(rfq)` | POST | `/rfqs` | `POST /rfqs` | **ALIGNED** |
| `postOffer(rfqId, offer)` | POST | `/rfqs/:id/offers` | `POST /rfqs/:id/offers` | **ALIGNED** |
| `postCounter(rfqId, counter)` | POST | `/rfqs/:id/counter` | `POST /rfqs/:id/counter` | **ALIGNED** |
| `accept(rfqId, ...)` | POST | `/rfqs/:id/accept` | `POST /rfqs/:id/accept` (router.post) | **ALIGNED** |
| `signQuote(rfqId, sig)` | PUT | `/rfqs/:id/quote/sign` | `PUT /rfqs/:id/quote/sign` | **ALIGNED** |
| `cosignQuote(rfqId, sig)` | PUT | `/rfqs/:id/cosign` | `PUT /rfqs/:id/cosign` | **ALIGNED** |
| `getQuote(rfqId)` | GET | `/rfqs/:id/quote` (with auth) | `GET /rfqs/:id/quote` | **ALIGNED** |
| `decline(rfqId, ...)` | PUT | `/rfqs/:id/decline` | `PUT /rfqs/:id/decline` | **ALIGNED** |
| `getEvents(rfqId, after?)` | GET | `/rfqs/:id/events?after=N` (with auth) | `GET /rfqs/:id/events` | **ALIGNED** |

### Detailed Findings

#### MISMATCHED: `getRfqs` query param `status` vs engine's `state`

**Severity: HIGH**

The engine-client sends `?status=X` but the engine reads `c.req.query("state")`. The `status` parameter is silently ignored by the engine, so any filter by state from agents/MCP will return unfiltered results.

```
// engine-client.ts line 92:
if (filters?.status) params.set("status", filters.status)

// engine rfqs.ts:
const stateFilter = c.req.query("state")?.toUpperCase()
```

The engine does NOT read a `?status` param at all. There is also no `?listing_id` param on the engine GET /rfqs route -- the engine only supports `?service_type`, `?state`, `?buyer`, `?include_terminal`, `?limit`, `?offset`.

This means the MCP seller tool `ghost_bazaar_get_rfqs` which passes `listing_id` and `status` filters will:
- Never filter by listing_id (engine ignores it)
- Never filter by state (engine reads `state`, client sends `status`)

#### ALIGNED: `getListings` response shape

Engine returns `{ listings: [...] }`. Client does `data.listings ?? data`. Safe.

#### ALIGNED: `postRfq` body

Client sends the full `RFQ` object. Engine validates via `validateRfq()` which checks: `rfq_id`, `protocol`, `buyer`, `service_type`, `spec`, `anchor_price`, `currency`, `deadline`, `signature`. The MCP buyer tool builds all required fields.

#### ALIGNED: `postOffer` body

Client sends the full `SellerOffer` object. Engine validates via `validateOffer()` which checks: `offer_id`, `rfq_id`, `seller`, `price`, `currency`, `valid_until`, `signature`. The MCP seller tool builds all required fields.

#### ALIGNED: Accept control envelope

Client builds: `{ envelope_id, action: "accept", rfq_id, session_revision, payload: { seller, offer_id }, issued_at, expires_at, signature }`. Engine's accept route validates via `validateControlEnvelope()`.

---

## 2. MCP -> Settlement Call Chain

| Call | From | To | Status |
|---|---|---|---|
| `ghost_bazaar_settle` builds Solana tx | MCP buyer.ts | Solana RPC | **ALIGNED** |
| `ghost_bazaar_settle` POSTs to `/execute` | MCP buyer.ts | Settlement HTTP handler | **MISMATCHED** |
| Settlement `verifyAndExecute` | settlement/execute.ts | internal | **MISMATCHED** |

### Detailed Findings

#### MISMATCHED: `ghost_bazaar_settle` builds raw HTTP POST, but settlement expects `SettlementRequest` interface

**Severity: HIGH**

The MCP `ghost_bazaar_settle` tool constructs a raw HTTP POST to the seller's payment_endpoint:
```
headers: {
  "X-Ghost-Bazaar-Quote": quoteB64,       // base64-encoded quote JSON
  "Payment-Signature": txSig,          // Solana tx signature
}
```

The settlement's `verifyAndExecute()` expects a `SettlementRequest` object:
```typescript
interface SettlementRequest {
  quoteHeaderB64: string
  paymentSignature: string
  rpcUrl: string
  usdcMint: string
  cluster?: "mainnet-beta" | "devnet" | "testnet"
}
```

The settlement HTTP handler (`handleSettlementRequest`) bridges this gap by extracting headers `X-Ghost-Bazaar-Quote` and `Payment-Signature` and passing them as `quoteHeaderB64` and `paymentSignature` along with server-side config for `rpcUrl` and `usdcMint`. This is correctly wired.

However, the header name differs: MCP sends `Payment-Signature` but the HTTP handler must read it as `payment-signature` (HTTP headers are case-insensitive, so this works in practice). **Functionally ALIGNED** but fragile.

#### MISMATCHED: `ghost_bazaar_settle` fallback URL is wrong

**Severity: MEDIUM**

```typescript
const executeUrl = quote.payment_endpoint ?? `${config.engineUrl}/execute`
```

The engine does NOT have a `/execute` route. If `payment_endpoint` is missing from the quote, the fallback silently sends to a non-existent engine endpoint. This should fail explicitly rather than fall back to a wrong URL.

#### ALIGNED: Quote object completeness

The quote passed from MCP `ghost_bazaar_accept` to `ghost_bazaar_settle` is the full `SignedQuote` object returned by `engine.signQuote()`. It contains all fields needed by settlement: `quote_id`, `rfq_id`, `buyer`, `seller`, `final_price`, `currency`, `payment_endpoint`, `nonce`, `memo_policy`, `buyer_signature`, `seller_signature`.

---

## 3. Agents -> Core Type Alignment

| Object built by agents | Core interface | Status |
|---|---|---|
| BuyerAgent builds `RFQ` | `core.RFQ` interface | **ALIGNED** |
| SellerAgent builds `SellerOffer` | `core.SellerOffer` (validateOffer required fields) | **ALIGNED** |
| BuyerAgent builds `CounterOffer` | `core.CounterOffer` (validateCounter required fields) | **ALIGNED** |
| MCP buyer `ghost_bazaar_post_rfq` builds RFQ | `core.RFQ` interface | **ALIGNED** |
| MCP seller `ghost_bazaar_respond_offer` builds offer | `core.SellerOffer` (validateOffer) | **ALIGNED** |
| MCP buyer `ghost_bazaar_counter` builds counter | `core.CounterOffer` (validateCounter) | **ALIGNED** |

### Detailed Findings

#### ALIGNED: RFQ fields

Core requires: `rfq_id, protocol, buyer, service_type, spec, anchor_price, currency, deadline, signature`. Optional: `budget_commitment, extensions`.

Both BuyerAgent and MCP buyer tool build all required fields. Protocol is hardcoded to `"ghost-bazaar-v4"`. Currency is hardcoded to `"USDC"`.

#### ALIGNED: Offer fields

Core validateOffer requires: `offer_id, rfq_id, seller, price, currency, valid_until, signature`. Also checks `rfq_id` matches the RFQ.

MCP seller's `ghost_bazaar_respond_offer` builds all required fields and adds `listing_id` (which the engine's offer route uses for provenance checking but is not in core's required list).

#### ALIGNED: Counter fields

Core validateCounter requires: `counter_id, rfq_id, round, from, to, price, currency, valid_until, signature`.

MCP buyer's `ghost_bazaar_counter` builds all required fields. The `round` is tracked in buyer session state and incremented per counter.

---

## 4. Trust Boundary Audit

### Auth Requirements Matrix

| Engine endpoint | Auth required | engine-client provides auth | Status |
|---|---|---|---|
| `GET /listings` | None | None | **ALIGNED** |
| `GET /listings/:id` | None | None | **ALIGNED** |
| `POST /listings` | None (body-signed) | None | **ALIGNED** |
| `POST /rfqs` | None (body-signed) | None | **ALIGNED** |
| `GET /rfqs` | None | None | **ALIGNED** |
| `POST /rfqs/:id/offers` | None (body-signed) | None | **ALIGNED** |
| `POST /rfqs/:id/counter` | None (body-signed) | None | **ALIGNED** |
| `POST /rfqs/:id/accept` | Envelope-signed | Signed envelope | **ALIGNED** |
| `PUT /rfqs/:id/decline` | Envelope-signed | Signed envelope | **ALIGNED** |
| `PUT /rfqs/:id/cosign` | Body contains seller_signature | Seller signature | **ALIGNED** |
| `PUT /rfqs/:id/quote/sign` | Body contains buyer_signature | Buyer signature | **ALIGNED** |
| `GET /rfqs/:id/quote` | GhostBazaar-Ed25519 header | `buildAuthHeader()` | **ALIGNED** |
| `GET /rfqs/:id/events` | GhostBazaar-Ed25519 header | `buildAuthHeader()` | **ALIGNED** |

### Settlement Handler Auth

| Check | Status |
|---|---|
| `handleSettlementRequest` rejects non-POST | **ALIGNED** (returns 405) |
| Settlement verifies buyer signature on quote | **ALIGNED** (step 2) |
| Settlement verifies seller signature on quote | **ALIGNED** (step 3) |
| Settlement verifies Solana tx signer matches buyer DID | **ALIGNED** (step 8) |
| Nonce replay protection | **ALIGNED** (step 14) |

### MCP State Isolation

| Check | Status |
|---|---|
| Buyer tools use `BuyerState` | Separate state object per `defineBuyerTools()` call | **ALIGNED** |
| Seller tools use closure-scoped `sellerListingId` | Separate closure per `defineSellerTools()` call | **ALIGNED** |
| Buyer cannot call seller tools | Separate tool definitions, separate MCP registration | **ALIGNED** |
| Buyer budget_hard never leaks to output | Verified: output only shows `has_budget_commitment: boolean` | **ALIGNED** |

---

## Summary of Issues

### CRITICAL / HIGH

| ID | Issue | Component | Impact |
|---|---|---|---|
| **H1** | `getRfqs` sends `?status=X` but engine reads `?state=X` | engine-client.ts:92 | State filtering silently broken for seller discovery |
| **H2** | `getRfqs` sends `?listing_id=X` but engine has no such param | engine-client.ts:91 | Listing-based RFQ filtering silently broken |
| **H3** | `ghost_bazaar_settle` fallback URL `${engineUrl}/execute` does not exist | mcp/buyer.ts | Settlement fails with 404 if quote lacks `payment_endpoint` |

### MEDIUM

| ID | Issue | Component | Impact |
|---|---|---|---|
| **M1** | `ghost_bazaar_accept` does not indicate quote needs seller cosign | mcp/buyer.ts | LLM may call `ghost_bazaar_settle` before quote is fully committed |
| **M2** | `ghost_bazaar_respond_counter` re-posts a new offer instead of using counter semantics | mcp/seller.ts | Works but confuses negotiation round tracking on the engine |
| **M3** | `getEvents` response parsing checks `event_type` in MCP but engine emits `type` | mcp/buyer.ts | Offer filtering uses `e.event_type === "offer"` which may not match engine's event shape |

### LOW / Informational

| ID | Issue | Component | Impact |
|---|---|---|---|
| **L1** | `getRfqs` response unwrap does `data.rfqs ?? data` but engine returns `{ rfqs: [...], total, limit, offset }` | engine-client.ts | Works correctly (rfqs field exists) |
| **L2** | Settlement nonce store is in-memory (not durable) | settlement/nonce.ts | Restart allows nonce replay; acceptable for devnet |
