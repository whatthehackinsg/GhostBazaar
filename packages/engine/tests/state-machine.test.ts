import { describe, it, expect } from "vitest"
import {
  TRANSITION_RULES,
  isValidTransition,
} from "../src/state/state-machine.js"
import { SessionState } from "../src/types.js"
import type { EventType } from "../src/types.js"

// ---------------------------------------------------------------------------
// Transition rules map
// ---------------------------------------------------------------------------

describe("TRANSITION_RULES", () => {
  it("defines transitions for all 6 states", () => {
    const states = Object.values(SessionState)
    for (const state of states) {
      expect(TRANSITION_RULES).toHaveProperty(state)
    }
  })

  it("terminal states have no outgoing transitions (COMMITTED allows self-loop audit only)", () => {
    // COMMITTED allows SETTLEMENT_CONFIRMED self-loop (audit event, state unchanged)
    const committedTransitions = TRANSITION_RULES[SessionState.COMMITTED]
    expect(Object.keys(committedTransitions)).toHaveLength(1)
    expect(committedTransitions["SETTLEMENT_CONFIRMED"]).toBe(SessionState.COMMITTED)
    // EXPIRED and CANCELLED are fully terminal
    expect(Object.keys(TRANSITION_RULES[SessionState.EXPIRED])).toHaveLength(0)
    expect(Object.keys(TRANSITION_RULES[SessionState.CANCELLED])).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Valid transitions per Spec §7 traceability matrix
// ---------------------------------------------------------------------------

describe("isValidTransition", () => {
  // --- OPEN state ---

  it("OPEN → NEGOTIATING via OFFER_SUBMITTED", () => {
    expect(isValidTransition("OPEN", "OFFER_SUBMITTED")).toEqual({
      valid: true,
      nextState: "NEGOTIATING",
    })
  })

  it("OPEN → EXPIRED via NEGOTIATION_EXPIRED", () => {
    expect(isValidTransition("OPEN", "NEGOTIATION_EXPIRED")).toEqual({
      valid: true,
      nextState: "EXPIRED",
    })
  })

  it("OPEN → CANCELLED via NEGOTIATION_CANCELLED", () => {
    expect(isValidTransition("OPEN", "NEGOTIATION_CANCELLED")).toEqual({
      valid: true,
      nextState: "CANCELLED",
    })
  })

  // --- NEGOTIATING state ---

  it("NEGOTIATING stays NEGOTIATING on OFFER_SUBMITTED", () => {
    expect(isValidTransition("NEGOTIATING", "OFFER_SUBMITTED")).toEqual({
      valid: true,
      nextState: "NEGOTIATING",
    })
  })

  it("NEGOTIATING stays NEGOTIATING on COUNTER_SENT", () => {
    expect(isValidTransition("NEGOTIATING", "COUNTER_SENT")).toEqual({
      valid: true,
      nextState: "NEGOTIATING",
    })
  })

  it("NEGOTIATING → COMMIT_PENDING via WINNER_SELECTED", () => {
    expect(isValidTransition("NEGOTIATING", "WINNER_SELECTED")).toEqual({
      valid: true,
      nextState: "COMMIT_PENDING",
    })
  })

  it("NEGOTIATING → EXPIRED via NEGOTIATION_EXPIRED", () => {
    expect(isValidTransition("NEGOTIATING", "NEGOTIATION_EXPIRED")).toEqual({
      valid: true,
      nextState: "EXPIRED",
    })
  })

  it("NEGOTIATING → CANCELLED via NEGOTIATION_CANCELLED", () => {
    expect(isValidTransition("NEGOTIATING", "NEGOTIATION_CANCELLED")).toEqual({
      valid: true,
      nextState: "CANCELLED",
    })
  })

  // --- COMMIT_PENDING state ---

  it("COMMIT_PENDING → COMMITTED via QUOTE_COMMITTED", () => {
    expect(isValidTransition("COMMIT_PENDING", "QUOTE_COMMITTED")).toEqual({
      valid: true,
      nextState: "COMMITTED",
    })
  })

  it("COMMIT_PENDING stays COMMIT_PENDING on QUOTE_SIGNED (partial signing)", () => {
    expect(isValidTransition("COMMIT_PENDING", "QUOTE_SIGNED")).toEqual({
      valid: true,
      nextState: "COMMIT_PENDING",
    })
  })

  it("COMMIT_PENDING → NEGOTIATING via COSIGN_DECLINED (rollback)", () => {
    expect(isValidTransition("COMMIT_PENDING", "COSIGN_DECLINED")).toEqual({
      valid: true,
      nextState: "NEGOTIATING",
    })
  })

  it("COMMIT_PENDING → NEGOTIATING via COSIGN_TIMEOUT (rollback)", () => {
    expect(isValidTransition("COMMIT_PENDING", "COSIGN_TIMEOUT")).toEqual({
      valid: true,
      nextState: "NEGOTIATING",
    })
  })

  it("COMMIT_PENDING → EXPIRED via NEGOTIATION_EXPIRED", () => {
    expect(isValidTransition("COMMIT_PENDING", "NEGOTIATION_EXPIRED")).toEqual({
      valid: true,
      nextState: "EXPIRED",
    })
  })

  // --- COMMIT_PENDING self-loop (audit trail marker) ---

  it("COMMIT_PENDING stays COMMIT_PENDING on COMMIT_PENDING event (self-loop)", () => {
    expect(isValidTransition("COMMIT_PENDING", "COMMIT_PENDING")).toEqual({
      valid: true,
      nextState: "COMMIT_PENDING",
    })
  })

  // --- Forbidden transitions ---

  it("rejects OPEN + COUNTER_SENT (can't counter before negotiation starts)", () => {
    expect(isValidTransition("OPEN", "COUNTER_SENT")).toEqual({
      valid: false,
    })
  })

  it("rejects OPEN + WINNER_SELECTED (can't accept before offers)", () => {
    expect(isValidTransition("OPEN", "WINNER_SELECTED")).toEqual({
      valid: false,
    })
  })

  it("rejects NEGOTIATING + QUOTE_COMMITTED (can't commit without pending)", () => {
    expect(isValidTransition("NEGOTIATING", "QUOTE_COMMITTED")).toEqual({
      valid: false,
    })
  })

  it("rejects COMMIT_PENDING + OFFER_SUBMITTED (frozen during commitment)", () => {
    expect(isValidTransition("COMMIT_PENDING", "OFFER_SUBMITTED")).toEqual({
      valid: false,
    })
  })

  it("rejects COMMIT_PENDING + COUNTER_SENT (frozen during commitment)", () => {
    expect(isValidTransition("COMMIT_PENDING", "COUNTER_SENT")).toEqual({
      valid: false,
    })
  })

  it("rejects COMMIT_PENDING + NEGOTIATION_CANCELLED (can't cancel during commitment)", () => {
    expect(isValidTransition("COMMIT_PENDING", "NEGOTIATION_CANCELLED")).toEqual({
      valid: false,
    })
  })

  it("rejects COMMITTED + any event (terminal state)", () => {
    const events: EventType[] = [
      "OFFER_SUBMITTED",
      "COUNTER_SENT",
      "WINNER_SELECTED",
      "QUOTE_SIGNED",
      "QUOTE_COMMITTED",
      "COSIGN_DECLINED",
      "COSIGN_TIMEOUT",
      "NEGOTIATION_EXPIRED",
      "NEGOTIATION_CANCELLED",
    ]
    for (const event of events) {
      expect(isValidTransition("COMMITTED", event)).toEqual({ valid: false })
    }
  })

  it("rejects EXPIRED + any event", () => {
    const events: EventType[] = [
      "OFFER_SUBMITTED",
      "COUNTER_SENT",
      "WINNER_SELECTED",
      "QUOTE_COMMITTED",
      "NEGOTIATION_CANCELLED",
    ]
    for (const event of events) {
      expect(isValidTransition("EXPIRED", event)).toEqual({ valid: false })
    }
  })

  it("rejects CANCELLED + any event", () => {
    const events: EventType[] = [
      "OFFER_SUBMITTED",
      "COUNTER_SENT",
      "WINNER_SELECTED",
      "QUOTE_COMMITTED",
      "NEGOTIATION_EXPIRED",
    ]
    for (const event of events) {
      expect(isValidTransition("CANCELLED", event)).toEqual({ valid: false })
    }
  })

  it("rejects RFQ_CREATED in any state (only valid as first event, not a transition)", () => {
    for (const state of Object.values(SessionState)) {
      expect(isValidTransition(state, "RFQ_CREATED")).toEqual({ valid: false })
    }
  })
})
