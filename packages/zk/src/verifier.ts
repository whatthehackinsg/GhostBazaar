import * as snarkjs from "snarkjs"
import { readFileSync } from "fs"
import path from "path"
import { fileURLToPath } from "url"
import type { BudgetProof } from "@ghost-bazaar/core"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_VKEY_PATH = path.join(__dirname, "../keys/vkey.json")

let cachedVkey: any = null
let cachedVkeyPath: string | null = null
function getVkey(vkeyPath: string) {
  if (!cachedVkey || cachedVkeyPath !== vkeyPath) {
    cachedVkey = JSON.parse(readFileSync(vkeyPath, "utf8"))
    cachedVkeyPath = vkeyPath
  }
  return cachedVkey
}

export interface VerifierPaths {
  vkeyPath?: string
}

export async function verifyBudgetProof(
  proof: BudgetProof,
  counter_price_scaled: bigint,
  budget_commitment: string,
  paths?: VerifierPaths
): Promise<boolean> {
  const commitmentDecimal = BigInt("0x" + budget_commitment.slice(9)).toString()

  const publicSignals = [
    counter_price_scaled.toString(),
    commitmentDecimal,
  ]

  const proofForSnarkjs = {
    pi_a: proof.pi_a,
    pi_b: proof.pi_b,
    pi_c: proof.pi_c,
    protocol: "groth16",
    curve: "bn128",
  }

  const vkeyPath = paths?.vkeyPath ?? DEFAULT_VKEY_PATH
  let vkey: any
  try {
    vkey = getVkey(vkeyPath)
  } catch (err) {
    // Configuration errors (missing vkey, bad JSON) must not be silent
    throw new Error(`Failed to load verification key from "${vkeyPath}": ${err instanceof Error ? err.message : err}`)
  }

  try {
    return await snarkjs.groth16.verify(vkey, publicSignals, proofForSnarkjs)
  } catch {
    // Proof verification math errors → invalid proof
    return false
  }
}
