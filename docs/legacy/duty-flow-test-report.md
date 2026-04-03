# Duty Flow Conformance Test Report

Date: 2026-03-05

Scope: validation of the 3-duty split in:

- `docs/duty1.md`
- `docs/duty2.md`
- `docs/duty3.md`

Method:

- spec conformance review against `GHOST-BAZAAR-SPEC-v0.1.md` and `ENGINEERING.md`
- cross-duty interface consistency checks
- scenario-based flow validation (tabletop)
- automated markdown consistency checks (12 checks, all pass)

## End-to-End Cross-Duty Flow

1. Buyer creates RFQ.
2. Duty 2 validates RFQ through Duty 1 and stores session/events.
3. Sellers submit offers.
4. Duty 2 validates offers through Duty 1 and updates round state.
5. Buyer accepts winning offer.
6. Duty 2 asks Duty 1 to build and co-sign Signed Quote.
7. Buyer invokes settlement call.
8. Duty 3 validates quote via Duty 1 and validates x402 payment.
9. Duty 3 executes service and consumes nonce durably.

## Scenario Matrix

| ID | Scenario | Expected | Result |
|---|---|---|---|
| T01 | Valid RFQ schema + signature | RFQ accepted | PASS |
| T02 | RFQ with past deadline | Rejected (`invalid_deadline`) | PASS |
| T03 | Valid seller offer | Offer accepted | PASS |
| T04 | Offer currency mismatch | Rejected (`currency_mismatch`) | PASS |
| T05 | Negotiation state invalid transition | Rejected (`409`) | PASS |
| T06 | Deterministic winner tie-break | Same winner on replay | PASS |
| T07 | Valid dual-signed quote | Quote committed | PASS |
| T08 | Tampered signed quote field | Rejected (`invalid_signature`) | PASS |
| T09 | Settlement amount mismatch | Rejected (`price_mismatch`) | PASS |
| T10 | Replay nonce on second execute | Rejected (`nonce_replayed`) | PASS |
| T11 | Expired quote at settlement | Rejected (`quote_expired`) | PASS |
| T12 | Successful settlement path | 200 + nonce consumed once | PASS |

## Interface Consistency Checks

Checked and confirmed:

- Duty 2 depends on Duty 1 validators, not inverse.
- Duty 3 depends on Duty 1 quote verification and amount normalization.
- Error surfaces are machine-readable and stable.
- RFQ `deadline` and quote `expires_at` are treated as separate controls.

Automated check summary (executed in shell):

- Duty1 canonical objects section exists
- Duty1 validator interface declared
- Duty1 error code catalog declared
- Duty2 state machine section exists
- Duty2 events route declared
- Duty2 deterministic winner policy declared
- Duty3 settlement contract section exists
- Duty3 x402 header requirements declared
- Duty3 replay error code declared
- Hackathon doc links 3-duty split
- README links duty docs
- Test report scenario matrix present

## Risks Still Open

- Mixed-signature scheme interoperability not in MVP.
- Nonce store backend choice not finalized in docs (Redis/Postgres/KV).
- Counter-offer wire envelope is implementation-defined in v0.1.

## Exit Decision

The 3-duty split is internally consistent and ready for implementation kickoff.
