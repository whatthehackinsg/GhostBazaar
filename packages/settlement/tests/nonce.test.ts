import { describe, it, expect, beforeEach } from "vitest"
import { isNonceConsumed, consumeNonce, resetNonces } from "../src/nonce.js"

describe("Nonce consumption (MVP in-memory)", () => {
  beforeEach(() => {
    resetNonces()
  })

  it("fresh nonce is not consumed", () => {
    expect(isNonceConsumed("quote-001")).toBe(false)
  })

  it("consumed nonce is detected", () => {
    consumeNonce("quote-001")
    expect(isNonceConsumed("quote-001")).toBe(true)
  })

  it("different quote_ids are independent", () => {
    consumeNonce("quote-001")
    expect(isNonceConsumed("quote-002")).toBe(false)
  })

  it("consuming same nonce twice is idempotent", () => {
    consumeNonce("quote-001")
    consumeNonce("quote-001")
    expect(isNonceConsumed("quote-001")).toBe(true)
  })

  it("resetNonces clears all consumed nonces", () => {
    consumeNonce("quote-001")
    consumeNonce("quote-002")
    resetNonces()
    expect(isNonceConsumed("quote-001")).toBe(false)
    expect(isNonceConsumed("quote-002")).toBe(false)
  })
})
