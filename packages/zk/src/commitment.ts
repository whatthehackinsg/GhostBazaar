import { buildPoseidon } from "circomlibjs"
import { scalePrice } from "./scale.js"

let poseidonInstance: any = null

async function getPoseidon() {
  if (!poseidonInstance) poseidonInstance = await buildPoseidon()
  return poseidonInstance
}

export async function generateBudgetCommitment(
  budget_hard: string,
  salt: bigint
): Promise<string> {
  const poseidon = await getPoseidon()
  const scaled = scalePrice(budget_hard)
  const hash = poseidon([scaled, salt])
  const hex = poseidon.F.toString(hash, 16).padStart(64, "0")
  return `poseidon:${hex}`
}
