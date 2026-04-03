/**
 * Quote builder — constructs unsigned quotes from session state.
 *
 * Sources payment_endpoint from RecordedOffer (server-resolved listing
 * provenance at offer time), NOT from current ListingStore. This prevents
 * payment redirection attacks where an attacker modifies a listing after
 * an offer has been submitted.
 */

import { buildUnsignedQuote, computeSpecHash } from "@ghost-bazaar/core"
import type { SignedQuote } from "@ghost-bazaar/core"
import type { DerivedSession } from "../state/session.js"

/** Default quote settlement window: 5 minutes. */
const DEFAULT_SETTLEMENT_WINDOW_MS = 300_000

/** Minimum settlement window: 60 seconds. */
const MIN_SETTLEMENT_WINDOW_MS = 60_000

/** Maximum settlement window: 10 minutes. */
const MAX_SETTLEMENT_WINDOW_MS = 600_000

export interface QuoteBuilderConfig {
  /** Settlement window in ms. Default: 300_000 (5 min). Clamped to [60s, 600s]. */
  readonly settlementWindowMs?: number
}

/**
 * Build an unsigned quote from the current session state and the accepted offer.
 *
 * expires_at = min(rfq.deadline, now + settlementWindow)
 * payment_endpoint sourced from RecordedOffer (listing provenance at offer time).
 * spec_hash computed from rfq.spec if available (Spec §5.5 SHOULD).
 *
 * The returned quote has buyer_signature="" and seller_signature="" per Spec §6.
 */
export function buildQuoteFromSession(
  session: DerivedSession,
  offerId: string,
  config: QuoteBuilderConfig = {},
): SignedQuote {
  const offer = session.offers.find((o) => o.offer_id === offerId)
  if (!offer) {
    throw new Error(`buildQuoteFromSession: offer_id "${offerId}" not found in session`)
  }

  // Clamp settlement window to [60s, 600s]
  const rawWindow = config.settlementWindowMs ?? DEFAULT_SETTLEMENT_WINDOW_MS
  const clampedWindow = Math.max(MIN_SETTLEMENT_WINDOW_MS, Math.min(MAX_SETTLEMENT_WINDOW_MS, rawWindow))

  // Compute deterministic expires_at: min(deadline, now + window)
  const expiresAt = new Date(
    Math.min(
      Date.parse(session.rfq.deadline),
      Date.now() + clampedWindow,
    ),
  ).toISOString()

  // Build via core helper, then override expires_at with our deterministic value.
  // We pass expires_seconds=0 as a placeholder because the core helper independently
  // derives expires_at from it. Our override ensures the quote's expiry respects
  // the rfq.deadline ceiling.
  const quote = buildUnsignedQuote({
    rfq_id: session.rfq.rfq_id,
    buyer: session.rfq.buyer,
    seller: offer.seller,
    service_type: session.rfq.service_type,
    final_price: offer.price,
    currency: offer.currency,
    payment_endpoint: offer.payment_endpoint,
    expires_seconds: 0, // placeholder — overridden below
    spec_hash: session.rfq.spec ? computeSpecHash(session.rfq.spec) : undefined,
  })

  // Override with our deterministic expires_at
  return { ...quote, expires_at: expiresAt }
}
