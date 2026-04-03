import { describe, it, expect } from "vitest"
import { existsSync } from "fs"
import { join, dirname } from "path"
import { fileURLToPath } from "url"
import { scalePrice, unscalePrice } from "../src/scale.js"
import { generateBudgetCommitment } from "../src/commitment.js"

const __dirname = dirname(fileURLToPath(import.meta.url))
const CIRCUIT_READY = existsSync(join(__dirname, "../build/BudgetRangeProof_js/BudgetRangeProof.wasm"))

describe("scalePrice", () => {
  it("scales 36.50 USDC to micro-units", () => {
    expect(scalePrice("36.50")).toBe(36_500_000n)
  })

  it("scales integer 100 USDC", () => {
    expect(scalePrice("100")).toBe(100_000_000n)
  })

  it("scales smallest unit 0.000001", () => {
    expect(scalePrice("0.000001")).toBe(1n)
  })

  it("scales 0.1 without float error", () => {
    expect(scalePrice("0.1")).toBe(100_000n)
  })

  it("truncates excess decimal precision", () => {
    expect(scalePrice("36.1234567")).toBe(36_123_456n)
  })
})

describe("unscalePrice", () => {
  it("round-trips 36.50", () => {
    expect(unscalePrice(36_500_000n)).toBe("36.50")
  })

  it("handles exact dollars", () => {
    expect(unscalePrice(100_000_000n)).toBe("100.00")
  })

  it("handles sub-cent", () => {
    expect(unscalePrice(1n)).toBe("0.000001")
  })

  it("handles zero", () => {
    expect(unscalePrice(0n)).toBe("0.00")
  })

  it("round-trips 28.50", () => {
    expect(unscalePrice(scalePrice("28.50"))).toBe("28.50")
  })

  it("round-trips all trailing-zero variants", () => {
    for (const price of ["1.00", "36.50", "100.10", "0.10", "42.00"]) {
      expect(unscalePrice(scalePrice(price))).toBe(price)
    }
  })
})

describe("generateBudgetCommitment", () => {
  it("format is poseidon:<64-hex>", async () => {
    const commitment = await generateBudgetCommitment("45.00", 12345678901234567890n)
    expect(commitment).toMatch(/^poseidon:[0-9a-f]{64}$/)
  })

  it("is deterministic — same inputs same output", async () => {
    const a = await generateBudgetCommitment("45.00", 99999n)
    const b = await generateBudgetCommitment("45.00", 99999n)
    expect(a).toBe(b)
  })

  it("different salt produces different commitment", async () => {
    const a = await generateBudgetCommitment("45.00", 111n)
    const b = await generateBudgetCommitment("45.00", 222n)
    expect(a).not.toBe(b)
  })

  it("different budget produces different commitment", async () => {
    const a = await generateBudgetCommitment("45.00", 111n)
    const b = await generateBudgetCommitment("46.00", 111n)
    expect(a).not.toBe(b)
  })
})

// Tests below require circuit artifacts (circom setup).
// Run `pnpm run setup` in packages/zk after installing circom.
// These tests are skipped when artifacts are missing.

describe("ZK proof lifecycle", () => {
  it.skipIf(!CIRCUIT_READY)("commitment → proof → verify round-trip", async () => {
    const { generateBudgetProof } = await import("../src/prover.js")
    const { verifyBudgetProof } = await import("../src/verifier.js")

    const salt = 12345678901234567890n
    const budget_hard = "45.00"

    const commitment = await generateBudgetCommitment(budget_hard, salt)
    const proof = await generateBudgetProof("36.00", budget_hard, salt)
    expect(proof.protocol).toBe("groth16")
    expect(proof.curve).toBe("bn128")
    expect(proof.counter_price_scaled).toBe("36000000")

    const valid = await verifyBudgetProof(proof, scalePrice("36.00"), commitment)
    expect(valid).toBe(true)
  }, 30_000)

  it.skipIf(!CIRCUIT_READY)("proof at exactly budget_hard ceiling passes", async () => {
    const { generateBudgetProof } = await import("../src/prover.js")
    const { verifyBudgetProof } = await import("../src/verifier.js")

    const salt = 12345678901234567890n
    const budget_hard = "45.00"

    const commitment = await generateBudgetCommitment(budget_hard, salt)
    const proof = await generateBudgetProof("45.00", budget_hard, salt)
    const valid = await verifyBudgetProof(proof, scalePrice("45.00"), commitment)
    expect(valid).toBe(true)
  }, 30_000)

  it.skipIf(!CIRCUIT_READY)("wrong counter_price_scaled in verify fails", async () => {
    const { generateBudgetProof } = await import("../src/prover.js")
    const { verifyBudgetProof } = await import("../src/verifier.js")

    const salt = 12345678901234567890n
    const budget_hard = "45.00"

    const commitment = await generateBudgetCommitment(budget_hard, salt)
    const proof = await generateBudgetProof("36.00", budget_hard, salt)
    const valid = await verifyBudgetProof(proof, scalePrice("37.00"), commitment)
    expect(valid).toBe(false)
  }, 30_000)

  it.skipIf(!CIRCUIT_READY)("proof above budget_hard ceiling fails at proof generation", async () => {
    const { generateBudgetProof } = await import("../src/prover.js")

    const salt = 12345678901234567890n
    const budget_hard = "45.00"

    // counter_price > budget_hard → circuit constraint violation at witness generation
    await expect(generateBudgetProof("46.00", budget_hard, salt)).rejects.toThrow()
  }, 30_000)

  it.skipIf(!CIRCUIT_READY)("wrong commitment in verify fails", async () => {
    const { generateBudgetProof } = await import("../src/prover.js")
    const { verifyBudgetProof } = await import("../src/verifier.js")

    const salt1 = 111n
    const salt2 = 222n
    const budget_hard = "45.00"

    const commitment2 = await generateBudgetCommitment(budget_hard, salt2)
    const proof = await generateBudgetProof("36.00", budget_hard, salt1)
    const valid = await verifyBudgetProof(proof, scalePrice("36.00"), commitment2)
    expect(valid).toBe(false)
  }, 30_000)
})
