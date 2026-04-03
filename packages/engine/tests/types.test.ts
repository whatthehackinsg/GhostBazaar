import { describe, it, expect } from "vitest"
import { SessionState, EVENT_TYPES } from "../src/types.js"

describe("SessionState enum", () => {
  it("defines exactly 6 states per Spec §7", () => {
    const states = Object.values(SessionState)
    expect(states).toHaveLength(6)
  })

  it("contains all required states", () => {
    expect(SessionState.OPEN).toBe("OPEN")
    expect(SessionState.NEGOTIATING).toBe("NEGOTIATING")
    expect(SessionState.COMMIT_PENDING).toBe("COMMIT_PENDING")
    expect(SessionState.COMMITTED).toBe("COMMITTED")
    expect(SessionState.EXPIRED).toBe("EXPIRED")
    expect(SessionState.CANCELLED).toBe("CANCELLED")
  })

  it("values are string-typed for serialization safety", () => {
    for (const val of Object.values(SessionState)) {
      expect(typeof val).toBe("string")
    }
  })
})

describe("EVENT_TYPES", () => {
  it("defines exactly 12 event types (9 core + 2 rollback + 1 settlement audit)", () => {
    expect(EVENT_TYPES).toHaveLength(12)
  })

  it("contains all required event types", () => {
    const expected = [
      "RFQ_CREATED",
      "OFFER_SUBMITTED",
      "COUNTER_SENT",
      "WINNER_SELECTED",
      "COMMIT_PENDING",
      "QUOTE_SIGNED",
      "QUOTE_COMMITTED",
      "COSIGN_DECLINED",
      "COSIGN_TIMEOUT",
      "NEGOTIATION_EXPIRED",
      "NEGOTIATION_CANCELLED",
      "SETTLEMENT_CONFIRMED",
    ]
    expect(EVENT_TYPES).toEqual(expect.arrayContaining(expected))
    expect(expected).toEqual(expect.arrayContaining([...EVENT_TYPES]))
  })
})
