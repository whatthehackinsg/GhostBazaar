import * as ed25519 from "@noble/ed25519"
import { sha512 } from "@noble/hashes/sha512"
import bs58 from "bs58"
import { type Keypair, PublicKey } from "@solana/web3.js"
import { canonicalJson } from "./canonical.js"

// noble/ed25519 v2 requires setting sha512
ed25519.etc.sha512Sync = (...m: Uint8Array[]) => {
  const h = sha512.create()
  for (const msg of m) h.update(msg)
  return h.digest()
}

export { canonicalJson } from "./canonical.js"

/**
 * Construct the signing payload for an RFQ, Offer, or CounterOffer.
 * Per v4 §6: signature field is present but set to empty string "".
 */
export function objectSigningPayload(obj: Record<string, unknown>): Uint8Array {
  return canonicalJson({ ...obj, signature: "" })
}

export async function signEd25519(payload: Uint8Array, keypair: Keypair): Promise<string> {
  const sig = await ed25519.signAsync(payload, keypair.secretKey.slice(0, 32))
  const b64 = Buffer.from(sig).toString("base64")
  return `ed25519:${b64}`
}

export async function verifyEd25519(payload: Uint8Array, sig: string, pubkey: PublicKey): Promise<boolean> {
  if (!sig.startsWith("ed25519:")) return false
  const sigBytes = Buffer.from(sig.slice(8), "base64")
  try {
    return await ed25519.verifyAsync(sigBytes, payload, pubkey.toBytes())
  } catch {
    return false
  }
}

export function buildDid(pubkey: PublicKey): string {
  // multicodec ed25519-pub = 0xed01 (varint: 0xed 0x01)
  const multicodec = new Uint8Array([0xed, 0x01, ...pubkey.toBytes()])
  return `did:key:z${bs58.encode(multicodec)}`
}
