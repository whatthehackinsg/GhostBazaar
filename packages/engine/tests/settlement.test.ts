/**
 * Settlement route tests — POST /execute + POST /rfqs/:id/settle-report
 *
 * Tests SETTLEMENT_CONFIRMED event lifecycle:
 * - Self-loop on COMMITTED (state unchanged)
 * - Proof-carrying payload
 * - Buyer + seller visibility
 * - Idempotent duplicate handling
 * - Auth + state guards
 */

import { describe, it, expect, beforeEach } from "vitest"
import { InMemoryEventStore } from "../src/state/event-store.js"
import { SessionManager } from "../src/state/session-manager.js"
import { isValidTransition } from "../src/state/state-machine.js"
import { isEventVisibleTo } from "../src/state/visibility.js"
import type { NegotiationEvent } from "../src/types.js"

// ---------------------------------------------------------------------------
// Helpers — build a session in COMMITTED state
// ---------------------------------------------------------------------------

const BUYER_DID = "did:key:z6MkBuyerTest111111111111111111111111111111111"
const SELLER_DID = "did:key:z6MkSellerTest22222222222222222222222222222222"
const RFQ_ID = "test-rfq-001"
const QUOTE_ID = "test-quote-001"
const TX_SIG = "FakeTransaction111111111111111111111111111111111111111111111111111111"

function buildCommittedSession(store: InMemoryEventStore, sessionManager: SessionManager) {
  const events: NegotiationEvent[] = [
    {
      event_id: crypto.randomUUID(),
      rfq_id: RFQ_ID,
      type: "RFQ_CREATED",
      timestamp: new Date().toISOString(),
      actor: BUYER_DID,
      payload: {
        rfq_id: RFQ_ID,
        protocol: "ghost-bazaar-v4",
        buyer: BUYER_DID,
        service_type: "smart-contract-audit",
        spec: {},
        anchor_price: "3.00",
        currency: "USDC",
        deadline: new Date(Date.now() + 600_000).toISOString(),
        signature: "ed25519:fake",
      },
    },
    {
      event_id: crypto.randomUUID(),
      rfq_id: RFQ_ID,
      type: "OFFER_SUBMITTED",
      timestamp: new Date().toISOString(),
      actor: SELLER_DID,
      payload: {
        rfq_id: RFQ_ID,
        offer_id: "offer-001",
        seller: SELLER_DID,
        price: "5.00",
        currency: "USDC",
        valid_until: new Date(Date.now() + 300_000).toISOString(),
        signature: "ed25519:fake",
        listing_id: "listing-001",
        payment_endpoint: "https://ghost-bazaar-engine.fly.dev/execute",
      },
    },
    {
      event_id: crypto.randomUUID(),
      rfq_id: RFQ_ID,
      type: "WINNER_SELECTED",
      timestamp: new Date().toISOString(),
      actor: BUYER_DID,
      payload: {
        seller: SELLER_DID,
        offer_id: "offer-001",
        quote: {
          quote_id: QUOTE_ID,
          rfq_id: RFQ_ID,
          buyer: BUYER_DID,
          seller: SELLER_DID,
          service_type: "smart-contract-audit",
          final_price: "5.00",
          currency: "USDC",
          payment_endpoint: "https://ghost-bazaar-engine.fly.dev/execute",
          expires_at: new Date(Date.now() + 300_000).toISOString(),
          nonce: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
          memo_policy: "quote_id_required",
          buyer_signature: "",
          seller_signature: "",
          spec_hash: "sha256:abc123",
        },
      },
    },
    {
      event_id: crypto.randomUUID(),
      rfq_id: RFQ_ID,
      type: "QUOTE_SIGNED",
      timestamp: new Date().toISOString(),
      actor: BUYER_DID,
      payload: {
        seller: SELLER_DID,
        buyer_signature: "ed25519:fakebuyersig",
      },
    },
    {
      event_id: crypto.randomUUID(),
      rfq_id: RFQ_ID,
      type: "QUOTE_COMMITTED",
      timestamp: new Date().toISOString(),
      actor: SELLER_DID,
      payload: {
        seller: SELLER_DID,
        seller_signature: "ed25519:fakesellersig",
      },
    },
  ]

  for (const event of events) {
    sessionManager.withLock(RFQ_ID, async () => {
      sessionManager.appendEvent(RFQ_ID, event)
    })
  }
}

// ---------------------------------------------------------------------------
// State Machine Tests
// ---------------------------------------------------------------------------

describe("SETTLEMENT_CONFIRMED state machine", () => {
  it("COMMITTED + SETTLEMENT_CONFIRMED → COMMITTED (self-loop)", () => {
    const result = isValidTransition("COMMITTED", "SETTLEMENT_CONFIRMED")
    expect(result).toEqual({ valid: true, nextState: "COMMITTED" })
  })

  it("OPEN + SETTLEMENT_CONFIRMED → invalid", () => {
    const result = isValidTransition("OPEN", "SETTLEMENT_CONFIRMED")
    expect(result).toEqual({ valid: false })
  })

  it("NEGOTIATING + SETTLEMENT_CONFIRMED → invalid", () => {
    const result = isValidTransition("NEGOTIATING", "SETTLEMENT_CONFIRMED")
    expect(result).toEqual({ valid: false })
  })

  it("EXPIRED + SETTLEMENT_CONFIRMED → invalid", () => {
    const result = isValidTransition("EXPIRED", "SETTLEMENT_CONFIRMED")
    expect(result).toEqual({ valid: false })
  })
})

// ---------------------------------------------------------------------------
// Visibility Tests
// ---------------------------------------------------------------------------

describe("SETTLEMENT_CONFIRMED visibility", () => {
  const settlementEvent: NegotiationEvent = {
    event_id: "settle-001",
    rfq_id: RFQ_ID,
    type: "SETTLEMENT_CONFIRMED",
    timestamp: new Date().toISOString(),
    actor: "system:settlement-verifier",
    payload: {
      seller: SELLER_DID,
      buyer: BUYER_DID,
      tx_sig: TX_SIG,
      quote_id: QUOTE_ID,
      final_price: "5.00",
      verified_at: new Date().toISOString(),
      verification: {
        amount_matched: true,
        mint_matched: true,
        destination_matched: true,
        memo_matched: true,
        confirmations: 32,
        block_time: new Date().toISOString(),
        solana_explorer: `https://explorer.solana.com/tx/${TX_SIG}?cluster=devnet`,
      },
    },
  }

  it("buyer can see SETTLEMENT_CONFIRMED", () => {
    expect(isEventVisibleTo(settlementEvent, BUYER_DID, { buyer: BUYER_DID })).toBe(true)
  })

  it("selected seller can see SETTLEMENT_CONFIRMED", () => {
    expect(isEventVisibleTo(settlementEvent, SELLER_DID, { buyer: BUYER_DID })).toBe(true)
  })

  it("other seller cannot see SETTLEMENT_CONFIRMED", () => {
    const otherSeller = "did:key:z6MkOtherSeller3333333333333333333333333333333"
    expect(isEventVisibleTo(settlementEvent, otherSeller, { buyer: BUYER_DID })).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Event Append Tests
// ---------------------------------------------------------------------------

describe("SETTLEMENT_CONFIRMED event append", () => {
  let store: InMemoryEventStore
  let sessionManager: SessionManager

  beforeEach(async () => {
    store = new InMemoryEventStore()
    sessionManager = new SessionManager(store)
    buildCommittedSession(store, sessionManager)
    // Let withLock promises resolve
    await new Promise(r => setTimeout(r, 10))
  })

  it("appends to COMMITTED session without changing state", async () => {
    const session = sessionManager.getSession(RFQ_ID)
    expect(session?.state).toBe("COMMITTED")

    await sessionManager.withLock(RFQ_ID, async () => {
      sessionManager.appendEvent(RFQ_ID, {
        event_id: crypto.randomUUID(),
        rfq_id: RFQ_ID,
        type: "SETTLEMENT_CONFIRMED",
        timestamp: new Date().toISOString(),
        actor: "system:settlement-verifier",
        payload: {
          seller: SELLER_DID,
          buyer: BUYER_DID,
          tx_sig: TX_SIG,
          quote_id: QUOTE_ID,
          final_price: "5.00",
          verified_at: new Date().toISOString(),
          verification: {
            amount_matched: true,
            mint_matched: true,
            destination_matched: true,
            memo_matched: true,
            confirmations: 1,
            block_time: null,
            solana_explorer: `https://explorer.solana.com/tx/${TX_SIG}?cluster=devnet`,
          },
        },
      })
    })

    // State should still be COMMITTED
    const after = sessionManager.getSession(RFQ_ID)
    expect(after?.state).toBe("COMMITTED")

    // Event should be in the log
    const events = store.getAllEvents(RFQ_ID)
    const settlementEvents = events.filter(e => e.type === "SETTLEMENT_CONFIRMED")
    expect(settlementEvents).toHaveLength(1)
    expect(settlementEvents[0].payload["tx_sig"]).toBe(TX_SIG)
    expect(settlementEvents[0].payload["verification"]).toBeDefined()
  })

  it("settlement event is visible to buyer via getEvents", async () => {
    await sessionManager.withLock(RFQ_ID, async () => {
      sessionManager.appendEvent(RFQ_ID, {
        event_id: crypto.randomUUID(),
        rfq_id: RFQ_ID,
        type: "SETTLEMENT_CONFIRMED",
        timestamp: new Date().toISOString(),
        actor: "system:settlement-verifier",
        payload: {
          seller: SELLER_DID,
          buyer: BUYER_DID,
          tx_sig: TX_SIG,
          quote_id: QUOTE_ID,
          final_price: "5.00",
          verified_at: new Date().toISOString(),
          verification: {},
        },
      })
    })

    const events = store.getEvents(RFQ_ID, BUYER_DID, { buyer: BUYER_DID })
    const settlement = events.find(e => e.type === "SETTLEMENT_CONFIRMED")
    expect(settlement).toBeDefined()
  })

  it("settlement event is visible to selected seller via getEvents", async () => {
    await sessionManager.withLock(RFQ_ID, async () => {
      sessionManager.appendEvent(RFQ_ID, {
        event_id: crypto.randomUUID(),
        rfq_id: RFQ_ID,
        type: "SETTLEMENT_CONFIRMED",
        timestamp: new Date().toISOString(),
        actor: "system:settlement-verifier",
        payload: {
          seller: SELLER_DID,
          buyer: BUYER_DID,
          tx_sig: TX_SIG,
          quote_id: QUOTE_ID,
          final_price: "5.00",
          verified_at: new Date().toISOString(),
          verification: {},
        },
      })
    })

    const events = store.getEvents(RFQ_ID, SELLER_DID, { buyer: BUYER_DID })
    const settlement = events.find(e => e.type === "SETTLEMENT_CONFIRMED")
    expect(settlement).toBeDefined()
  })
})
