// Types
export * from "./types.js"

// State
export { InMemoryEventStore } from "./state/event-store.js"
export { TRANSITION_RULES, isValidTransition } from "./state/state-machine.js"
export type { TransitionResult } from "./state/state-machine.js"
export { deriveState } from "./state/session.js"
export type { DerivedSession, RecordedOffer, RecordedCounter } from "./state/session.js"
export { SessionManager, SessionBusyError } from "./state/session-manager.js"
export type { SessionManagerConfig } from "./state/session-manager.js"

// App
export { createApp } from "./app.js"
export type { EngineEnv } from "./app.js"

// Middleware
export { onEngineError, EngineError } from "./middleware/error-handler.js"
export { requireState, assertState } from "./middleware/require-state.js"
export {
  didToPublicKey,
  preCheckSignatureFormat,
  verifySignature,
  verifyQuoteSignature,
} from "./middleware/validate-signature.js"

// Security
export { EnvelopeTombstones, validateControlEnvelope } from "./security/control-envelope.js"
export type { ControlAction, ControlEnvelope } from "./security/control-envelope.js"

// Routes
export { createListingsRoute } from "./routes/listings.js"
export { createRfqRoute } from "./routes/rfqs.js"
export { createOfferRoute } from "./routes/offers.js"
export { createCounterRoute } from "./routes/counters.js"
export type { BudgetProofVerifier, CounterRouteConfig } from "./routes/counters.js"
export { createAcceptRoute } from "./routes/accept.js"
export type { AcceptRouteConfig } from "./routes/accept.js"
export { createQuoteSignRoute } from "./routes/quote-sign.js"
export { createQuoteReadRoute } from "./routes/quote-read.js"
export { createCosignRoute } from "./routes/cosign.js"
export { createDeclineRoute } from "./routes/decline.js"

// Utilities
export { buildQuoteFromSession } from "./util/quote-builder.js"
export type { QuoteBuilderConfig } from "./util/quote-builder.js"

// Registry
export { ListingStore } from "./registry/listing-store.js"
export { enrichListing, enrichListings } from "./registry/listing-enricher.js"
export type { RegistryEnrichment, EnrichedListing } from "./registry/listing-enricher.js"
export { buildBuyerRegistrySignals } from "./strategy/buyer-registry-signals.js"
export type { BuyerRegistrySignal } from "./strategy/buyer-registry-signals.js"
