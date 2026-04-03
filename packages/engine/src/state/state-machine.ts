import { SessionState } from "../types.js"
import type { EventType } from "../types.js"

// ---------------------------------------------------------------------------
// Transition Rules — Spec §7 state machine
//
// Maps (currentState, eventType) → nextState.
// Only transitions present in this map are valid. All others are rejected.
// RFQ_CREATED is not a transition — it is the session initializer (state = OPEN).
// ---------------------------------------------------------------------------

type TransitionMap = Record<string, SessionState>

export const TRANSITION_RULES: Record<SessionState, TransitionMap> = {
  [SessionState.OPEN]: {
    OFFER_SUBMITTED: SessionState.NEGOTIATING,
    NEGOTIATION_EXPIRED: SessionState.EXPIRED,
    NEGOTIATION_CANCELLED: SessionState.CANCELLED,
  },

  [SessionState.NEGOTIATING]: {
    OFFER_SUBMITTED: SessionState.NEGOTIATING,
    COUNTER_SENT: SessionState.NEGOTIATING,
    WINNER_SELECTED: SessionState.COMMIT_PENDING,
    NEGOTIATION_EXPIRED: SessionState.EXPIRED,
    NEGOTIATION_CANCELLED: SessionState.CANCELLED,
  },

  [SessionState.COMMIT_PENDING]: {
    // Self-loop: COMMIT_PENDING event is an audit-trail marker emitted
    // alongside WINNER_SELECTED. It doesn't change state but must be valid.
    COMMIT_PENDING: SessionState.COMMIT_PENDING,
    QUOTE_SIGNED: SessionState.COMMIT_PENDING,
    QUOTE_COMMITTED: SessionState.COMMITTED,
    COSIGN_DECLINED: SessionState.NEGOTIATING,
    COSIGN_TIMEOUT: SessionState.NEGOTIATING,
    NEGOTIATION_EXPIRED: SessionState.EXPIRED,
  },

  // COMMITTED is terminal per Spec §7. SETTLEMENT_CONFIRMED is a self-loop
  // audit event — records on-chain payment verification without changing state.
  [SessionState.COMMITTED]: {
    SETTLEMENT_CONFIRMED: SessionState.COMMITTED,
  },

  // Terminal states — no outgoing transitions
  [SessionState.EXPIRED]: {},
  [SessionState.CANCELLED]: {},
}

// ---------------------------------------------------------------------------
// Transition validator
// ---------------------------------------------------------------------------

export type TransitionResult =
  | { readonly valid: true; readonly nextState: SessionState }
  | { readonly valid: false }

export function isValidTransition(
  currentState: SessionState,
  eventType: EventType,
): TransitionResult {
  const transitions = TRANSITION_RULES[currentState]
  const nextState = transitions[eventType]
  if (nextState !== undefined) {
    return { valid: true, nextState }
  }
  return { valid: false }
}
