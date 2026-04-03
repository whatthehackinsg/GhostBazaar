import * as snarkjs from "snarkjs"
import path from "path"
import { fileURLToPath } from "url"
import { buildPoseidon } from "circomlibjs"
import { scalePrice } from "./scale.js"
import type { BudgetProof } from "@ghost-bazaar/core"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_WASM_PATH = path.join(__dirname, "../build/BudgetRangeProof_js/BudgetRangeProof.wasm")
const DEFAULT_ZKEY_PATH = path.join(__dirname, "../build/BudgetRangeProof_final.zkey")

let cachedPoseidon: any = null
async function getPoseidon() {
  if (!cachedPoseidon) cachedPoseidon = await buildPoseidon()
  return cachedPoseidon
}

export interface ProverPaths {
  wasmPath?: string
  zkeyPath?: string
}

export async function generateBudgetProof(
  counter_price: string,
  budget_hard: string,
  salt: bigint,
  paths?: ProverPaths
): Promise<BudgetProof> {
  const counter_price_scaled = scalePrice(counter_price)
  const budget_hard_scaled = scalePrice(budget_hard)

  const poseidon = await getPoseidon()
  const commitment = poseidon([budget_hard_scaled, salt])
  const commitmentBigInt = poseidon.F.toObject(commitment)

  const input = {
    counter_price_scaled: counter_price_scaled.toString(),
    budget_commitment: commitmentBigInt.toString(),
    budget_hard_scaled: budget_hard_scaled.toString(),
    commitment_salt: salt.toString(),
  }

  const wasmPath = paths?.wasmPath ?? DEFAULT_WASM_PATH
  const zkeyPath = paths?.zkeyPath ?? DEFAULT_ZKEY_PATH
  const { proof } = await snarkjs.groth16.fullProve(input, wasmPath, zkeyPath)

  return {
    protocol: "groth16",
    curve: "bn128",
    counter_price_scaled: counter_price_scaled.toString(),
    pi_a: proof.pi_a,
    pi_b: proof.pi_b,
    pi_c: proof.pi_c,
  }
}
