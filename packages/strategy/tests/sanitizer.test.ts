import { describe, it, expect } from "vitest"
import Decimal from "decimal.js"
import { sanitizeBuyerAction, sanitizeSellerAction } from "../src/sanitizer.js"

describe("sanitizeBuyerAction", () => {
  const priv = { budget_soft: new Decimal("40"), budget_hard: new Decimal("45") }

  it("clamps counter price above budget_hard", () => {
    const action = { type: "counter" as const, seller: "did:key:z6Mk...", price: new Decimal("50") }
    const result = sanitizeBuyerAction(action, priv)
    expect(result.type).toBe("counter")
    if (result.type === "counter") expect(result.price.eq(new Decimal("45"))).toBe(true)
  })

  it("passes counter at exactly budget_hard", () => {
    const action = { type: "counter" as const, seller: "did:key:z6Mk...", price: new Decimal("45") }
    const result = sanitizeBuyerAction(action, priv)
    if (result.type === "counter") expect(result.price.eq(new Decimal("45"))).toBe(true)
  })

  it("passes counter below budget_hard unchanged", () => {
    const action = { type: "counter" as const, seller: "did:key:z6Mk...", price: new Decimal("38") }
    const result = sanitizeBuyerAction(action, priv)
    if (result.type === "counter") expect(result.price.eq(new Decimal("38"))).toBe(true)
  })

  it("clamps price far above budget (100 → 45)", () => {
    const action = { type: "counter" as const, seller: "did:key:z6Mk...", price: new Decimal("100") }
    const result = sanitizeBuyerAction(action, priv)
    if (result.type === "counter") expect(result.price.eq(new Decimal("45"))).toBe(true)
  })

  it("passes 'wait' action through untouched", () => {
    const action = { type: "wait" as const }
    expect(sanitizeBuyerAction(action, priv)).toEqual(action)
  })

  it("passes 'accept' action through untouched", () => {
    const action = { type: "accept" as const, seller: "did:key:z6Mk..." }
    expect(sanitizeBuyerAction(action, priv)).toEqual(action)
  })

  it("passes 'cancel' action through untouched", () => {
    const action = { type: "cancel" as const }
    expect(sanitizeBuyerAction(action, priv)).toEqual(action)
  })
})

describe("sanitizeSellerAction", () => {
  const priv = { floor_price: new Decimal("30"), target_price: new Decimal("42") }

  it("clamps respond price below floor", () => {
    const action = { type: "respond" as const, price: new Decimal("25") }
    const result = sanitizeSellerAction(action, priv)
    if (result.type === "respond") expect(result.price.eq(new Decimal("30"))).toBe(true)
  })

  it("passes respond at exactly floor_price", () => {
    const action = { type: "respond" as const, price: new Decimal("30") }
    const result = sanitizeSellerAction(action, priv)
    if (result.type === "respond") expect(result.price.eq(new Decimal("30"))).toBe(true)
  })

  it("passes respond above floor unchanged", () => {
    const action = { type: "respond" as const, price: new Decimal("35") }
    const result = sanitizeSellerAction(action, priv)
    if (result.type === "respond") expect(result.price.eq(new Decimal("35"))).toBe(true)
  })

  it("clamps 'counter' type below floor", () => {
    const action = { type: "counter" as const, price: new Decimal("20") }
    const result = sanitizeSellerAction(action, priv)
    if (result.type === "counter") expect(result.price.eq(new Decimal("30"))).toBe(true)
  })

  it("passes 'hold' action through untouched", () => {
    const action = { type: "hold" as const }
    expect(sanitizeSellerAction(action, priv)).toEqual(action)
  })

  it("passes 'decline' action through untouched", () => {
    const action = { type: "decline" as const }
    expect(sanitizeSellerAction(action, priv)).toEqual(action)
  })
})
