import { describe, it, expect } from "vitest"
import { normalizeAmount, decimalStringCompare, computeSpecHash, registerMint } from "../src/amounts.js"

// Devnet test USDC mint (6 decimals)
const USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"

describe("normalizeAmount", () => {
  it("scales 36.50 USDC to 36500000", () => {
    expect(normalizeAmount("36.50", USDC_MINT)).toBe(36_500_000n)
  })

  it("scales 100.00 to 100000000", () => {
    expect(normalizeAmount("100.00", USDC_MINT)).toBe(100_000_000n)
  })

  it("scales 0.01 to 10000", () => {
    expect(normalizeAmount("0.01", USDC_MINT)).toBe(10_000n)
  })

  it("handles 0.1 without float precision bugs", () => {
    expect(normalizeAmount("0.1", USDC_MINT)).toBe(100_000n)
  })

  it("handles integer without decimal point", () => {
    expect(normalizeAmount("42", USDC_MINT)).toBe(42_000_000n)
  })

  it("handles 2.80 correctly", () => {
    expect(normalizeAmount("2.80", USDC_MINT)).toBe(2_800_000n)
  })

  it("handles 1000000.00 (large amount)", () => {
    expect(normalizeAmount("1000000.00", USDC_MINT)).toBe(1_000_000_000_000n)
  })

  it("handles 28.50", () => {
    expect(normalizeAmount("28.50", USDC_MINT)).toBe(28_500_000n)
  })

  it("handles smallest unit 0.000001", () => {
    expect(normalizeAmount("0.000001", USDC_MINT)).toBe(1n)
  })

  it("truncates excess decimal precision", () => {
    expect(normalizeAmount("36.1234567", USDC_MINT)).toBe(36_123_456n)
  })

  it("works with mainnet USDC mint too", () => {
    expect(normalizeAmount("36.50", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")).toBe(36_500_000n)
  })

  it("throws on unknown mint address", () => {
    expect(() => normalizeAmount("10.00", "UnknownMint111111111111111111111111111111111")).toThrow("Unknown mint address")
  })
})

describe("registerMint", () => {
  it("registers a custom mint and normalizes correctly", () => {
    const customMint = "CustomTestMint111111111111111111111111111111"
    registerMint(customMint, 9) // 9 decimals
    expect(normalizeAmount("1.5", customMint)).toBe(1_500_000_000n)
  })

  it("allows overriding decimal count for existing mint", () => {
    const testMint = "OverrideMint1111111111111111111111111111111"
    registerMint(testMint, 6)
    expect(normalizeAmount("1.0", testMint)).toBe(1_000_000n)
    registerMint(testMint, 8)
    expect(normalizeAmount("1.0", testMint)).toBe(100_000_000n)
  })
})

describe("decimalStringCompare", () => {
  it("36.50 < 38.00 → -1", () => {
    expect(decimalStringCompare("36.50", "38.00")).toBe(-1)
  })
  it("38.00 > 36.50 → 1", () => {
    expect(decimalStringCompare("38.00", "36.50")).toBe(1)
  })
  it("36.50 == 36.50 → 0", () => {
    expect(decimalStringCompare("36.50", "36.50")).toBe(0)
  })
  it("0.1 == 0.10 → 0", () => {
    expect(decimalStringCompare("0.1", "0.10")).toBe(0)
  })
})

describe("computeSpecHash", () => {
  it("produces sha256:<hex> format", () => {
    const hash = computeSpecHash({ language: "solidity", lines: 500 })
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it("is deterministic regardless of key order", () => {
    const a = computeSpecHash({ b: 2, a: 1 })
    const b = computeSpecHash({ a: 1, b: 2 })
    expect(a).toBe(b)
  })

  it("different specs produce different hashes", () => {
    const a = computeSpecHash({ language: "solidity" })
    const b = computeSpecHash({ language: "rust" })
    expect(a).not.toBe(b)
  })
})
