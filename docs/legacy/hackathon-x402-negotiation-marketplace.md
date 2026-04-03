# Hackathon Direction: Ghost Bazaar x402 Negotiation Marketplace

## Purpose

This document defines the hackathon implementation profile for Ghost Bazaar: structured, multi-seller price negotiation with x402 settlement.

It is aligned to:

- `GHOST-BAZAAR-SPEC-v0.1.md` (protocol objects and flow)
- `GHOST-BAZAAR-WHITEPAPER-v0.1.md` (design rationale and market positioning)

## Protocol-Aligned Flow

Use the same 4 phases as the spec/whitepaper:

1. **Phase 1: Discovery**
   - Buyer prepares and broadcasts an `RFQ` with `anchor_price`, `currency`, and `deadline`.
   - Buyer never reveals `budget_hard` in protocol messages.
2. **Phase 2: Negotiation**
   - Sellers return `Seller Offer` messages.
   - Buyer runs structured counter-offer rounds until deadline or acceptable offer.
3. **Phase 3: Commitment**
   - Buyer and winner seller co-sign `Signed Quote` (EIP-712 or Ed25519 profile).
   - Quote locks `final_price`, `payment_endpoint`, `expires_at`, and `nonce`.
   - `expires_at` is separate from RFQ `deadline` (settlement window vs negotiation window).
4. **Phase 4: Settlement**
   - Buyer calls seller endpoint with `PAYMENT-SIGNATURE` and `X-Ghost-Bazaar-Quote`.
   - Seller verifies quote signatures, expiry, nonce, and amount match before execution.

## Canonical Objects (Use Spec Names)

### 1. Request for Quote (RFQ)

Required fields for hackathon MVP:

- `rfq_id`
- `buyer`
- `service`
- `spec`
- `currency`
- `anchor_price`
- `deadline`
- `signature`

Notes:

- Keep `anchor_price` as an opening anchor, not the real budget.
- Typical anchor heuristic: open around ~65% of soft target.
- `deadline` bounds negotiation rounds only.

### 2. Seller Offer

Required fields for hackathon MVP:

- `offer_id`
- `rfq_id`
- `seller`
- `price`
- `currency`
- `valid_until`
- `signature`

### 3. Signed Quote

Required fields for hackathon MVP:

- `quote_id`
- `rfq_id`
- `buyer`
- `seller`
- `service`
- `final_price`
- `currency`
- `payment_endpoint`
- `expires_at`
- `nonce`
- `buyer_signature`
- `seller_signature`

## Seller Validation Rules (Settlement Gate)

On `POST /execute`, seller validates in this order:

1. Decode and parse `X-Ghost-Bazaar-Quote`.
2. Verify buyer signature.
3. Verify seller signature.
4. Verify `final_price` equals the x402 payment amount from `PAYMENT-SIGNATURE`.
5. Verify `nonce` has not been consumed.
6. Verify `expires_at` has not elapsed.
7. Execute service and mark nonce as consumed.

If any check fails, return 4xx and do not execute.

## API Shape (Hackathon MVP)

- `GET /listings`
- `GET /listings/:id`
- `POST /rfqs`
- `POST /rfqs/:id/offers`
- `POST /rfqs/:id/accept` (creates `Signed Quote`)
- `GET /rfqs/:id/events`
- `POST /execute` (x402 + quote validation gate)

## MCP Tool Mapping (Hackathon MVP)

- `discover_listings`
- `get_listing_details`
- `broadcast_rfq`
- `submit_offer`
- `accept_offer_and_sign_quote`
- `pay_and_execute`
- `get_negotiation_events`

## Real-Market Profiles

### 1. C2C Marketplace (Carousell-style)

- Terms to negotiate: `price`, `delivery_mode`, `shipping_cost`, `condition`.
- Good fit for agent-assisted second-hand commerce.

### 2. Merchant Marketplace (Amazon-style)

- Terms to negotiate: `unit_price`, `bulk_discount`, `shipping_eta`, `return_window`.
- Good fit for procurement agents and repeat orders.

### 3. Services Marketplace (Upwork-style)

- Terms to negotiate: `price`, `deadline`, `revision_limit`, `deliverable_spec`.
- Best hackathon fit because outputs can be machine-validated where possible.

## Recommended Demo Scope

Prioritize the services profile first:

- clear negotiation signal in live demo
- structured terms that map cleanly to RFQ/Offer/Quote
- direct x402 settlement at service execution

Example demo: `agent code review service` with negotiated price + delivery deadline.

## Implementation Plan

1. Build RFQ and offer exchange routes with append-only event history.
2. Implement Signed Quote generation, co-sign, and verification helpers.
3. Enforce quote-to-payment amount matching in the x402 execution path.
4. Expose the MVP flow through MCP tools for autonomous agents.
5. Run end-to-end demo across one real service-market scenario.

## Delivery Split (3 Isolated Duties)

- Duty 1 (Protocol Core): [docs/duty1.md](./duty1.md)
- Duty 2 (Negotiation Engine): [docs/duty2.md](./duty2.md)
- Duty 3 (Settlement + Agent Interface): [docs/duty3.md](./duty3.md)

Conformance test report:

- [docs/duty-flow-test-report.md](./duty-flow-test-report.md)
