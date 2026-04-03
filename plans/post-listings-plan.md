# Plan: POST /listings — Seller Listing Registration + Multi-Listing Support

> Status: Planned
> Priority: High (blocks Duty 3 seller onboarding)
> Scope: 6 files modified, 0 new dependencies

## Background

Duty 2 spec (`docs/duty2.md` line 74) defines `POST /listings` but it was never implemented.
Currently listings are hardcoded as seed data in `server.ts`. Sellers have no way to
dynamically register their services.

The current engine also hard-gates offer submission to **exactly one listing per seller**.
`POST /rfqs/:id/offers` currently resolves `payment_endpoint` by seller DID alone, so
multi-listing sellers are rejected as `ambiguous_listing`. This plan fixes both gaps
together:

1. add `POST /listings`
2. upgrade offer provenance so each offer carries a signed `listing_id`

That allows one seller DID to register multiple services safely.

## What Already Exists

| Component | Status | Location |
|-----------|--------|----------|
| `Listing` interface | Done | `packages/core/src/schemas.ts:73` |
| `ListingStore.add()` | Done | `packages/engine/src/registry/listing-store.ts:54` |
| `ListingStore.findBySellerAndId()` | Done | `packages/engine/src/registry/listing-store.ts:90` |
| `validateListing()` | Done | `listing-store.ts:33` — DID, HTTPS, service_type, capacity |
| `preCheckSignatureFormat()` | Done | `packages/engine/src/middleware/validate-signature.ts` |
| `verifySignature()` | Done | `packages/engine/src/middleware/validate-signature.ts` |
| `objectSigningPayload()` | Done | `packages/core/src/signing.ts` |
| `GET /listings` | Done | `routes/listings.ts:37` |
| `GET /listings/:id` | Done | `routes/listings.ts:52` |
| `RecordedOffer.listing_id` | Done | `packages/engine/src/state/session.ts:46` |
| `StatsCollector.setListingCount()` | Done | `stats/stats-collector.ts` |
| **`POST /listings`** | **Missing** | — |
| **Signed `offer.listing_id`** | **Missing** | — |

## Design

### Part A: `POST /listings` Auth

`POST /listings` should follow the repo’s existing write-route pattern: **signed body,
not header auth**.

```json
{
  "listing_id": "listing-my-service",
  "seller": "did:key:z6Mk...",
  "title": "My Service",
  "category": "security",
  "service_type": "smart-contract-audit",
  "negotiation_endpoint": "https://my-agent.example.com/negotiate",
  "payment_endpoint": "https://my-agent.example.com/execute",
  "base_terms": { "response_time": "24h" },
  "negotiation_profile": {
    "style": "flexible",
    "max_rounds": 5,
    "accepts_counter": true
  },
  "signature": "ed25519:..."
}
```

The engine verifies:

1. `signature` format via `preCheckSignatureFormat(signature, seller)`
2. Full Ed25519 verification via `verifySignature(body, signature, seller, "invalid_seller_signature")`

This keeps `POST /listings` aligned with the current README / engine README contract:
read routes use header auth, write routes use body signatures.

### Part B: Offer Provenance Upgrade

To support multiple listings per seller, `SellerOffer` must include `listing_id` and
that field must be covered by the seller signature.

```json
{
  "offer_id": "uuid-v4",
  "rfq_id": "uuid-v4",
  "seller": "did:key:z6Mk...",
  "listing_id": "listing-my-service",
  "price": "28.50",
  "currency": "USDC",
  "valid_until": "2026-03-21T12:00:00Z",
  "signature": "ed25519:..."
}
```

The engine then resolves provenance by:

```ts
listingStore.findBySellerAndId(offer.seller, offer.listing_id)
```

instead of the current ambiguous:

```ts
listingStore.findAllBySeller(offer.seller)
```

This makes `payment_endpoint` selection deterministic and keeps the existing
anti-redirection security property.

### `POST /listings` Response

```json
201 Created
{
  "listing_id": "listing-my-service",
  "seller": "did:key:z6Mk...",
  "title": "My Service",
  "category": "security",
  "service_type": "smart-contract-audit",
  "negotiation_endpoint": "https://my-agent.example.com/negotiate",
  "payment_endpoint": "https://my-agent.example.com/execute",
  "base_terms": { "response_time": "24h" },
  "negotiation_profile": {
    "style": "flexible",
    "max_rounds": 5,
    "accepts_counter": true
  }
}
```

The response should return the stored unsigned listing, **not** echo `signature`.

## Error Responses

### `POST /listings`

| Status | Code | When |
|--------|------|------|
| 400 | `malformed_payload` | Invalid JSON, non-object body, or malformed / missing `signature` |
| 401 | `invalid_seller_signature` | Signature does not verify against `seller` DID |
| 409 | `duplicate_listing` | `listing_id` already exists |
| 422 | `invalid_listing` | Validation failed (bad DID, non-HTTPS, missing fields, bad negotiation_profile) |
| 503 | `capacity_exceeded` | ListingStore at 10,000 limit |

### `POST /rfqs/:id/offers`

| Status | Code | When |
|--------|------|------|
| 422 | `missing_listing` | `listing_id` missing or seller has not registered that listing |
| 422 | `missing_payment_endpoint` | Resolved listing has no payment endpoint |

`ambiguous_listing` is removed in this design because `listing_id` makes the mapping explicit.

## Validation

### Listing Registration Validation

`ListingStore` validation is **not** full `Listing` schema validation. The route still
needs to reject malformed registration payloads before store insertion.

Store-level checks already exist for:

- `listing_id`: required non-empty string
- `seller`: valid `did:key:z6Mk...` format
- `negotiation_endpoint`: HTTPS URL
- `payment_endpoint`: HTTPS URL
- `service_type`: required non-empty string
- Capacity: max 10,000 listings
- No duplicate `listing_id`

Additional route-level checks still needed:

- body must be a plain object (not `null`, array, or scalar)
- `signature` must be a string
- `title` and `category` must be non-empty strings
- `base_terms` must be an object
- if present, `negotiation_profile.style` must be one of:
  - `firm`
  - `flexible`
  - `competitive`
  - `deadline-sensitive`
- if present, `negotiation_profile.max_rounds` must be a positive integer
- if present, `negotiation_profile.accepts_counter` must be boolean

### Offer Validation Upgrade

`validateOffer()` must now also require:

- `listing_id`
- `listing_id` is a non-empty string

`extractOfferFields()` must include `listing_id`, so the seller signature binds the
offer to the intended listing.

## Implementation

### File 1: `packages/core/src/schemas.ts`

Add a signed registration shape owned by core:

```typescript
export interface SignedListing extends Listing {
  signature: string
}
```

Upgrade `SellerOffer`:

```typescript
export interface SellerOffer {
  offer_id: string
  rfq_id: string
  seller: string
  listing_id: string
  price: string
  currency: string
  valid_until: string
  signature: string
  extensions?: Record<string, unknown>
}
```

Update `validateOffer()` so `listing_id` is required and validated before signature verification.

### File 2: `packages/engine/src/routes/listings.ts`

Add `POST /listings` to existing route factory:

```typescript
export interface ListingsRouteConfig {
  readonly listingStore: ListingStore
  readonly discover?: DiscoverFn
  readonly onListingAdded?: () => void
}

router.post("/listings", async (c) => {
  let body: SignedListing
  try {
    body = await c.req.json() as SignedListing
  } catch {
    throw new EngineError(400, "malformed_payload", "Invalid JSON body")
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new EngineError(400, "malformed_payload", "Listing body must be an object")
  }
  if (typeof body.signature !== "string") {
    throw new EngineError(400, "malformed_payload", "Missing or invalid signature")
  }
  // validate remaining Listing fields here (or via core validator)

  preCheckSignatureFormat(body.signature, body.seller)
  await verifySignature(body, body.signature, body.seller, "invalid_seller_signature")

  const { signature: _sig, ...listing } = body
  try {
    listingStore.add(listing)
  } catch (err) {
    throw mapListingStoreError(err)
  }

  onListingAdded?.()
  return c.json(listing, 201)
})
```

Add a small `mapListingStoreError()` helper in the same file:

- duplicate `listing_id` → `409 duplicate_listing`
- capacity limit → `503 capacity_exceeded`
- all validation failures → `422 invalid_listing`

Backward-compatibility note: current call sites use the bare `ListingStore` form.
This plan introduces the config-object mount in `server.ts` to wire stats updates,
while preserving the bare-store path for existing read-only callers and tests.

### File 3: `packages/engine/src/routes/offers.ts`

Upgrade offer handling for explicit listing provenance:

```typescript
function extractOfferFields(body: Record<string, unknown>): Record<string, unknown> {
  return {
    offer_id: body.offer_id,
    rfq_id: body.rfq_id,
    seller: body.seller,
    listing_id: body.listing_id,
    price: body.price,
    currency: body.currency,
    valid_until: body.valid_until,
    signature: body.signature,
    ...(body.extensions !== undefined ? { extensions: body.extensions } : {}),
  }
}

// ...
const listingId = body.listing_id as string
const resolvedListing = listingStore.findBySellerAndId(sellerDid, listingId)
if (!resolvedListing) {
  throw new EngineError(422, "missing_listing", "Seller has not registered the referenced listing")
}
```

Append `OFFER_SUBMITTED` with the seller-provided, verified `listing_id` and the
resolved `payment_endpoint`.

### File 4: `packages/engine/src/server.ts`

Update route wiring to pass stats callback:

```typescript
app.route("/", createListingsRoute({
  listingStore,
  onListingAdded: () => statsCollector.setListingCount(listingStore.getAll().length),
}))
```

### File 5: `packages/engine/tests/listings.test.ts`

Add tests for POST:

```text
POST /listings
  ✓ creates listing with valid seller signature → 201
  ✓ returns created listing in response body
  ✓ does not echo signature in response body
  ✓ listing appears in GET /listings after creation
  ✓ allows a second listing for the same seller with a different listing_id → 201
  ✓ rejects scalar / null / array body → 400
  ✓ rejects missing signature → 400
  ✓ rejects malformed signature format → 400
  ✓ rejects wrong signing key for seller DID → 401
  ✓ rejects duplicate listing_id → 409
  ✓ rejects invalid seller DID format → 422
  ✓ rejects missing title/category/base_terms → 422
  ✓ rejects malformed negotiation_profile → 422
  ✓ rejects non-HTTPS negotiation_endpoint → 422
  ✓ rejects non-HTTPS payment_endpoint → 422
  ✓ rejects missing service_type → 422
  ✓ updates /dashboard/stats listing count after successful POST
  ✓ keeps GET /listings public (no auth required)
```

### File 6: `packages/engine/tests/offers.test.ts`

Add / update tests for explicit listing selection:

```text
POST /rfqs/:id/offers
  ✓ accepts offer when seller references one of multiple registered listings
  ✓ resolves payment_endpoint from seller + listing_id
  ✓ rejects missing listing_id → 400/422 (per validateOffer mapping)
  ✓ rejects listing_id not owned by seller → 422 missing_listing
  ✓ rejects unknown listing_id → 422 missing_listing
  ✓ signature covers listing_id (tamper listing_id after signing → 401 invalid_seller_signature)
  ✓ removes old ambiguous_listing failure path
```

## Not Changing

- `ListingStore` remains the in-memory storage backend
- `RecordedOffer` / quote flow still source payment provenance from the stored offer event
- existing discovery GET routes and optional enrichment hook
- No new dependencies
- No database changes (listings remain in-memory for now)

## Notes

- Listings are in-memory only. Engine restart loses dynamically added listings.
  Seed listings re-populate on startup. This is acceptable for the current demo phase.
- Seed listings are enabled by default, but they no longer consume a seller’s “only slot”.
  A seeded seller may register additional listings under this design.
- Future: persist listings (and any discovery cache) alongside events. Engine event
  persistence already exists; only listing/cache persistence is deferred here.
- The `onListingAdded` callback pattern keeps the route decoupled from StatsCollector.
- This plan intentionally chooses the **non-MVP auth path**: signed listing body,
  not `GhostBazaar-Ed25519` header auth.
- This plan intentionally implements the **current seller-DID-based discovery model**,
  not the older Duty 2 text about warming an in-memory 8004 agent-ID cache from
  `POST /listings`. A separate follow-up is still needed to choose one contract:
  either add agent-ID/mapping material to registration, or revise Duty 2 docs to
  match the existing `discover(sellerDid)` route abstraction.
- Restart implication: after reboot, dynamic listings disappear, discovery metadata
  sourced from them disappears, and health/dashboard listing counts fall back to
  seed-only values.
