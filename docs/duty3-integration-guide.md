# Duty 3 Integration Guide — Engine API Reference

**Base URL**: `https://ghost-bazaar-engine.fly.dev`

**Local dev**: `http://localhost:3000` (run `pnpm --filter @ghost-bazaar/engine dev`)

---

## Quick Start

```bash
# 1. Verify engine is online
curl https://ghost-bazaar-engine.fly.dev/health
# → {"status":"ok","uptime":...,"sessions":0,"listings":3}

# 2. List available sellers
curl https://ghost-bazaar-engine.fly.dev/listings
# → {"listings":[...3 seed listings...]}
```

---

## Authentication

Two auth modes, depending on the endpoint:

| Route Type | Method | Auth |
|------------|--------|------|
| **Write** (POST/PUT) | Ed25519 signature in request body | Each request body includes a `signature` field signed by the caller's Ed25519 keypair |
| **Read** (GET /quote, GET /events) | GhostBazaar-Ed25519 header | `Authorization: GhostBazaar-Ed25519 <did> <timestamp> <signature>` |
| **Discovery** (GET /listings, GET /health) | None | Public, no auth required |

### Ed25519 Header Auth (for read routes)

```typescript
import { objectSigningPayload, signEd25519, buildDid } from "@ghost-bazaar/core"

const did = buildDid(keypair.publicKey)
const timestamp = Date.now().toString()
const payload = objectSigningPayload({
  action: "authenticate",
  did,
  timestamp,
  signature: "",
})
const signature = await signEd25519(payload, keypair)

// Header format:
// Authorization: GhostBazaar-Ed25519 <did> <timestamp> <base64-signature>
```

**Timestamp drift tolerance**: 60 seconds. Requests with timestamps >60s from server time are rejected.

---

## API Endpoints

### Discovery

#### `GET /listings`
Returns all registered seller listings. No auth required.

```json
{
  "listings": [
    {
      "listing_id": "listing-firm-seller",
      "seller": "did:key:z6Mk...",
      "title": "Smart Contract Audit — Premium",
      "service_type": "smart-contract-audit",
      "negotiation_endpoint": "https://...",
      "payment_endpoint": "https://...",
      "negotiation_profile": { "style": "firm" }
    }
  ]
}
```

#### `POST /listings` — Seller registers a signed listing

```json
{
  "listing_id": "listing-firm-seller",
  "seller": "did:key:z6Mk...",
  "registry_agent_id": "42",
  "title": "Smart Contract Audit — Premium",
  "category": "security",
  "service_type": "smart-contract-audit",
  "negotiation_endpoint": "https://seller.example.com/negotiate",
  "payment_endpoint": "https://seller.example.com/execute",
  "base_terms": { "response_time": "48h" },
  "negotiation_profile": { "style": "firm", "max_rounds": 3, "accepts_counter": true },
  "signature": "<base64>"
}
```

**Response**: `201` with the stored unsigned listing.

Notes:
- `registry_agent_id` is optional
- when provided, the engine verifies that the discovered 8004 DID matches `seller`
- listings are persisted durably and survive restart
- one seller may register multiple listings

### Negotiation — Write Routes

All write routes require Ed25519 signature in the request body.

#### `POST /rfqs` — Buyer broadcasts RFQ

```json
{
  "rfq_id": "uuid",
  "buyer": "did:key:z6Mk...",
  "anchor_price": "45.00",
  "currency": "USDC",
  "deadline": "2026-03-21T15:00:00.000Z",
  "service_type": "smart-contract-audit",
  "signature": "<base64>"
}
```

**Response**: `201 { "rfq_id": "...", "state": "OPEN" }`

**Validation**:
- `anchor_price` must be a decimal string (not a number)
- `deadline` must be in the future
- `currency` must be `"USDC"`
- `signature` must be valid Ed25519 over canonical JSON

#### `POST /rfqs/:id/offers` — Seller submits offer

```json
{
  "offer_id": "uuid",
  "seller": "did:key:z6Mk...",
  "listing_id": "listing-firm-seller",
  "price": "42.00",
  "currency": "USDC",
  "valid_until": "2026-03-21T14:55:00.000Z",
  "signature": "<base64>"
}
```

**Response**: `201 { "offer_id": "...", "state": "NEGOTIATING" }`

**Rules**:
- Max 10 offers per seller per session
- Max 50 total offers per session
- `seller` must match `signature` signer
- `listing_id` must exist for that seller in ListingStore
- `payment_endpoint` is resolved server-side from the bound listing, not supplied in the offer body

#### `POST /rfqs/:id/counter` — Buyer sends counter-offer

```json
{
  "counter_id": "uuid",
  "from": "did:key:z6Mk...(buyer)",
  "to": "did:key:z6Mk...(seller)",
  "price": "38.00",
  "round": 1,
  "signature": "<base64>"
}
```

**Optional ZK budget proof**: If the RFQ includes `budget_commitment`, the counter must include a Groth16 proof that `counter_price <= budget_hard`.

#### `POST /rfqs/:id/accept` — Buyer selects winner

```json
{
  "seller": "did:key:z6Mk...",
  "offer_id": "offer-uuid",
  "envelope_id": "uuid",
  "action": "accept",
  "rfq_id": "...",
  "session_revision": "...",
  "issued_at": "...",
  "expires_at": "...",
  "signature": "<base64>"
}
```

**Response**: `200 { "state": "COMMIT_PENDING", "unsigned_quote": {...} }`

Uses control envelope format with replay protection (envelope_id is one-time-use).

#### `PUT /rfqs/:id/quote/sign` — Buyer signs quote

```json
{
  "buyer_signature": "<base64>",
  "signature": "<base64>"
}
```

#### `PUT /rfqs/:id/cosign` — Seller co-signs quote

```json
{
  "seller_signature": "<base64>",
  "signature": "<base64>"
}
```

**Response**: `200 { "state": "COMMITTED", "quote": {...} }`

After cosign, the deal is committed. Proceed to Duty 3 settlement.

#### `PUT /rfqs/:id/decline` — Seller declines to cosign

```json
{
  "envelope_id": "uuid",
  "action": "decline",
  "rfq_id": "...",
  "session_revision": "...",
  "issued_at": "...",
  "expires_at": "...",
  "signature": "<base64>"
}
```

Session returns to NEGOTIATING. Buyer can select a different seller.

### Negotiation — Read Routes

Require `Authorization: GhostBazaar-Ed25519` header.

#### `GET /rfqs/:id/quote` — Read current quote

Returns the unsigned or signed quote for the session.

#### `GET /rfqs/:id/events` — Event stream

**Content negotiation**:
- `Accept: text/event-stream` → SSE live stream
- `Accept: application/json` → JSON polling

**SSE features**:
- `Last-Event-ID` header for reconnect (cursor-based)
- 15s heartbeat
- Auto-close on terminal state (COMMITTED/EXPIRED/CANCELLED)

**Role-scoped visibility**:
- Buyer sees all events
- Seller sees only: RFQ_CREATED, their own offers, counters addressed to them, terminal events

---

## State Machine

```
OPEN ──(offer)──► NEGOTIATING ──(accept)──► COMMIT_PENDING ──(cosign)──► COMMITTED
  │                    │                          │
  └──(expire)──► EXPIRED ◄──(expire/timeout)──────┘

                 CANCELLED ◄──(cancel)──── NEGOTIATING
```

Terminal states: COMMITTED, EXPIRED, CANCELLED — no further transitions.

Note: `CANCELLED` exists in the state machine, but the public buyer cancel route is intentionally deferred for now. Duty 3 should not assume `POST /rfqs/:id/cancel` is available yet.

---

## Error Format

All errors return:
```json
{
  "error": "error_code",
  "message": "Human-readable description"
}
```

Common error codes:
- `400 malformed_payload` — validation failed
- `401 unauthorized` — missing or invalid signature
- `404 not_found` — session doesn't exist
- `409 invalid_state` — wrong session state for this operation
- `422 invalid_transition` — state machine rejects the event

---

## Typical Integration Flow (Duty 3 Agent Runtime)

```
BuyerAgent                    Engine                    SellerAgent
    │                           │                           │
    │                           │◄──POST /listings─────────│
    │                           │──201 {listing_id}────────►│
    │                           │                           │
    │──POST /rfqs──────────────►│                           │
    │◄─201 {rfq_id, OPEN}──────│                           │
    │                           │                           │
    │                           │◄──POST /offers───────────│
    │                           │──201 {NEGOTIATING}───────►│
    │                           │                           │
    │──POST /counter───────────►│                           │
    │◄─200 {NEGOTIATING}───────│──(seller sees counter)────►│
    │                           │                           │
    │                           │◄──POST /offers (revised)──│
    │                           │                           │
    │──POST /accept────────────►│                           │
    │◄─200 {COMMIT_PENDING}────│                           │
    │                           │                           │
    │──PUT /quote/sign─────────►│                           │
    │                           │──(seller sees signed)────►│
    │                           │                           │
    │                           │◄──PUT /cosign─────────────│
    │◄─(SSE: COMMITTED)────────│──200 {COMMITTED}─────────►│
    │                           │                           │
    └───── Duty 3: Settlement ──┴──── POST /execute ────────┘
```

---

## Environment

| Variable | Value |
|----------|-------|
| Production | `https://ghost-bazaar-engine.fly.dev` |
| Local dev | `http://localhost:3000` |
| Seed listings | 3 inserted only when missing |
| RFQ deadline | Must be future, enforcer checks every 5s |
| Cosign timeout | 60s after COMMIT_PENDING |
| 8004 discovery | Optional, via `AGENT_REGISTRY_RPC_URL` + runtime cache |

---

## Dependencies

Duty 3 agents need:
- `@ghost-bazaar/core` — for `buildDid`, `signEd25519`, `objectSigningPayload`, `verifyEd25519`
- `@ghost-bazaar/zk` (optional) — for budget commitment + Groth16 proof generation
- HTTP client — for calling engine endpoints
