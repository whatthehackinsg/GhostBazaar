/**
 * MVP nonce consumption — in-memory Set<string> keyed by quote_id.
 *
 * Week-2 upgrade path: replace with PDA-based nonce via Anchor program
 * using seed ["ghost_bazaar_nonce", quote_id_bytes].
 */

const consumedNonces = new Set<string>()

export function isNonceConsumed(quoteId: string): boolean {
  return consumedNonces.has(quoteId)
}

export function consumeNonce(quoteId: string): void {
  consumedNonces.add(quoteId)
}

/** Reset all consumed nonces (test utility only). */
export function resetNonces(): void {
  consumedNonces.clear()
}
