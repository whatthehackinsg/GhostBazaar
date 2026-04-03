# 03. Why We Need Ghost Bazaar

Date: 2026-03-06

## Problem-Solution Fit

Ghost Bazaar is needed because it fills the missing middle between:

- agent interoperability (communication/task coordination)
- payment settlement (transfer execution)

Ghost Bazaar adds the missing primitives for market-grade negotiation:

- RFQ
- structured offers/counter-offers
- dual-signed quote commitment
- settlement-time quote/payment consistency checks

## What Ghost Bazaar Adds That Existing Layers Don’t

1. Multi-seller competitive price discovery
- Buyer can compare and pressure offers across sellers in a bounded window.

2. Budget privacy by design
- Buyer can negotiate via anchor/counter strategy without exposing `budget_hard`.

3. Cryptographic commitment object (`Signed Quote`)
- Both parties sign the same final terms.
- Any mutation becomes detectable.

4. Settlement bridge to x402
- Execution requires quote validity + amount match + nonce freshness + expiry checks.

## Why Ghost Bazaar Is Timely Now

- Agent interoperability standards are accelerating.
- Payment rails for agents are maturing.
- Research indicates unstructured agent negotiation has predictable failure modes.

This creates a narrow but high-value design opportunity: standardize negotiation and commitment before the ecosystem fragments into incompatible ad hoc bargaining patterns.

## Practical Value By Stakeholder

For buyers:

- better price outcomes
- stronger assurance on agreed terms

For sellers:

- interoperable way to participate in competitive demand
- verifiable negotiation trail for operations

For platforms/ecosystem builders:

- composable protocol boundary between discovery/interop and settlement
- lower integration ambiguity across stacks

## How This Maps To Current Ghost Bazaar Work

- Specification baseline: `GHOST-BAZAAR-SPEC-v0.1.md`
- Draft extension profile: `GHOST-BAZAAR-SPEC-v2.md`
- Implementation duties:
  - `docs/duty1.md`
  - `docs/duty2.md`
  - `docs/duty3.md`
- Conformance framing:
  - `docs/duty-flow-test-report.md`

## Recommendation

Treat Ghost Bazaar as the negotiation standardization layer in agent commerce:

- keep transport-agnostic negotiation messages
- keep settlement rail-agnostic commitment checks, with x402 as first-class profile
- ship one real-market profile first (services marketplace), then extend to C2C and merchant profiles

## References

- Google A2A announcement: https://developers.googleblog.com/en/a2a-a-new-era-of-agent-interoperability/
- x402 docs: https://docs.cdp.coinbase.com/x402/welcome
- x402 v2 launch: https://www.x402.org/writing/x402-v2-launch
- ACP checkout RFC: https://raw.githubusercontent.com/agentic-commerce-protocol/agentic-commerce-protocol/main/rfcs/rfc.agentic_checkout.md
- ACP capability RFC: https://raw.githubusercontent.com/agentic-commerce-protocol/agentic-commerce-protocol/main/rfcs/rfc.capability_negotiation.md
- Microsoft Magentic Marketplace: https://www.microsoft.com/en-us/research/video/magentic-marketplace-ai-as-workers-and-users-in-marketplaces/
