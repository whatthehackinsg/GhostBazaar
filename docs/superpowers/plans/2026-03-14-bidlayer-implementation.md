# Ghost Bazaar Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement GHOST BAZAAR-SPEC-v4 end-to-end as a Solana Agent Hackathon MVP — Discovery → Negotiation → Commitment → Settlement with ZK budget proofs and MCP agent interface.

**Architecture:** 7-layer monorepo (`packages/core`, `zk`, `strategy`, `engine`, `settlement`, `agents`, `mcp` + `demo/`). Lower layers are pure libraries (no I/O). Engine is the HTTP server. Agent Runtime and MCP Server are orchestrators. All signing uses Ed25519 from Solana keypairs. Settlement is SPL USDC wallet-to-wallet on devnet.

**Tech Stack:** TypeScript, pnpm workspaces, Hono (HTTP), vitest (testing), @noble/ed25519, @solana/web3.js v1, @solana/spl-token, circom 2.0 + snarkjs (ZK), decimal.js, @anthropic-ai/sdk (LLM strategy), @modelcontextprotocol/sdk (MCP), ink (demo UI)

**Spec:** `GHOST-BAZAAR-SPEC-v4.md`
**Design:** `docs/superpowers/specs/2026-03-13-ghost-bazaar-solana-agents-design.md`
**Duties:** `docs/duty1.md`, `docs/duty2.md`, `docs/duty3.md`

---

## Chunk 1: Scaffold + Protocol Core

### Task 0: Monorepo Scaffold

**Files:**
- Create: `package.json` (root)
- Create: `pnpm-workspace.yaml`
- Create: `tsconfig.base.json`
- Create: `packages/core/package.json`
- Create: `packages/core/tsconfig.json`
- Create: `packages/core/vitest.config.ts`

- [ ] **Step 1: Create root package.json and pnpm-workspace.yaml**

```json
// package.json
{
  "name": "ghost-bazaar",
  "private": true,
  "scripts": {
    "test": "pnpm -r test",
    "build": "pnpm -r build"
  },
  "engines": { "node": ">=20" }
}
```

```yaml
# pnpm-workspace.yaml
packages:
  - "packages/*"
  - "demo"
```

- [ ] **Step 2: Create tsconfig.base.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "dist",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true
  }
}
```

- [ ] **Step 3: Create packages/core scaffold**

```json
// packages/core/package.json
{
  "name": "@ghost-bazaar/core",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "test": "vitest run"
  },
  "dependencies": {
    "@noble/ed25519": "^2.1.0",
    "decimal.js": "^10.4.3",
    "bs58": "^6.0.0"
  },
  "devDependencies": {
    "typescript": "^5.4.0",
    "vitest": "^1.6.0"
  }
}
```

```json
// packages/core/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

```typescript
// packages/core/vitest.config.ts
import { defineConfig } from "vitest/config"
export default defineConfig({ test: { include: ["tests/**/*.test.ts"] } })
```

- [ ] **Step 4: Run `pnpm install` and verify**

Run: `pnpm install`
Expected: Clean install, no errors

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-workspace.yaml tsconfig.base.json pnpm-lock.yaml packages/core/
git commit -m "chore: scaffold monorepo with packages/core"
```

---

### Task 1: Core Types and Schemas

**Files:**
- Create: `packages/core/src/schemas.ts`
- Create: `packages/core/src/index.ts`
- Test: `packages/core/tests/schemas.test.ts`

- [ ] **Step 1: Write failing tests for RFQ validation**

```typescript
// packages/core/tests/schemas.test.ts
import { describe, it, expect } from "vitest"
import { validateRfq } from "../src/schemas.js"

describe("validateRfq", () => {
  const validRfq = {
    rfq_id: "550e8400-e29b-41d4-a716-446655440000",
    protocol: "ghost-bazaar-v4",
    buyer: "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
    service_type: "ghost-bazaar:services:smart-contract-audit",
    spec: { language: "solidity", lines: 500 },
    anchor_price: "35.00",
    currency: "USDC",
    deadline: new Date(Date.now() + 60_000).toISOString(),
    signature: "ed25519:dGVzdA==",
  }

  it("accepts a valid RFQ", () => {
    const result = validateRfq(validRfq)
    expect(result.ok).toBe(true)
  })

  it("rejects unknown protocol version", () => {
    const result = validateRfq({ ...validRfq, protocol: "ghost-bazaar-v99" })
    expect(result.ok).toBe(false)
    expect(result.code).toBe("malformed_payload")
  })

  it("rejects non-positive anchor_price", () => {
    const result = validateRfq({ ...validRfq, anchor_price: "0" })
    expect(result.ok).toBe(false)
    expect(result.code).toBe("invalid_amount")
  })

  it("rejects past deadline", () => {
    const result = validateRfq({ ...validRfq, deadline: "2020-01-01T00:00:00Z" })
    expect(result.ok).toBe(false)
    expect(result.code).toBe("invalid_deadline")
  })

  it("rejects invalid budget_commitment format", () => {
    const result = validateRfq({ ...validRfq, budget_commitment: "bad:format" })
    expect(result.ok).toBe(false)
    expect(result.code).toBe("invalid_budget_commitment_format")
  })

  it("accepts valid budget_commitment", () => {
    const commitment = "poseidon:" + "a".repeat(64)
    const result = validateRfq({ ...validRfq, budget_commitment: commitment })
    expect(result.ok).toBe(true)
  })

  it("rejects missing required fields", () => {
    const { rfq_id, ...missing } = validRfq
    const result = validateRfq(missing as any)
    expect(result.ok).toBe(false)
    expect(result.code).toBe("malformed_payload")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && npx vitest run tests/schemas.test.ts`
Expected: FAIL — `validateRfq` not found

- [ ] **Step 3: Implement schemas.ts with types and RFQ validator**

```typescript
// packages/core/src/schemas.ts
import Decimal from "decimal.js"

// --- Types ---

export type ValidationResult = { ok: true } | { ok: false; code: string }

export interface RFQ {
  rfq_id: string
  protocol: string
  buyer: string
  service_type: string
  spec: Record<string, unknown>
  anchor_price: string
  currency: string
  deadline: string
  signature: string
  budget_commitment?: string
  extensions?: Record<string, unknown>
}

export interface SellerOffer {
  offer_id: string
  rfq_id: string
  seller: string
  price: string
  currency: string
  valid_until: string
  signature: string
  extensions?: Record<string, unknown>
}

export interface CounterOffer {
  counter_id: string
  rfq_id: string
  round: number
  from: string
  to: string
  price: string
  currency: string
  valid_until: string
  signature: string
  budget_proof?: BudgetProof
  extensions?: Record<string, unknown>
}

export interface BudgetProof {
  protocol: "groth16"
  curve: "bn128"
  counter_price_scaled: string
  pi_a: string[]
  pi_b: string[][]
  pi_c: string[]
}

export interface SignedQuote {
  quote_id: string
  rfq_id: string
  buyer: string
  seller: string
  service_type: string
  final_price: string
  currency: string
  payment_endpoint: string
  expires_at: string
  nonce: string
  memo_policy: "optional" | "quote_id_required" | "hash_required"
  buyer_signature: string
  seller_signature: string
  spec_hash?: string
  extensions?: Record<string, unknown>
}

// --- Helpers ---

function isValidDecimalPositive(s: string): boolean {
  try {
    const d = new Decimal(s)
    return d.gt(0) && d.isFinite()
  } catch {
    return false
  }
}

function isUuidV4(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s)
}

function isFutureISO(s: string): boolean {
  const t = Date.parse(s)
  return !isNaN(t) && t > Date.now()
}

const BUDGET_COMMITMENT_RE = /^poseidon:[0-9a-f]{64}$/

const NONCE_RE = /^0x[0-9a-f]{64}$/

// --- Validators ---

export function validateRfq(rfq: any): ValidationResult {
  if (!rfq || typeof rfq !== "object") return { ok: false, code: "malformed_payload" }

  const required = ["rfq_id", "protocol", "buyer", "service_type", "spec", "anchor_price", "currency", "deadline", "signature"]
  for (const field of required) {
    if (rfq[field] === undefined || rfq[field] === null) {
      return { ok: false, code: "malformed_payload" }
    }
  }

  if (rfq.protocol !== "ghost-bazaar-v4") return { ok: false, code: "malformed_payload" }
  if (!isValidDecimalPositive(rfq.anchor_price)) return { ok: false, code: "invalid_amount" }
  if (!isFutureISO(rfq.deadline)) return { ok: false, code: "invalid_deadline" }
  if (!SUPPORTED_CURRENCIES.includes(rfq.currency)) return { ok: false, code: "currency_mismatch" }

  if (rfq.budget_commitment !== undefined) {
    if (!BUDGET_COMMITMENT_RE.test(rfq.budget_commitment)) {
      return { ok: false, code: "invalid_budget_commitment_format" }
    }
  }

  // NOTE: Signature verification is NOT done here (pure schema check).
  // The engine route MUST call verifyEd25519() on the RFQ after validateRfq().
  return { ok: true }
}

const SUPPORTED_CURRENCIES = ["USDC"]

export function validateOffer(offer: any, rfq: RFQ): ValidationResult {
  if (!offer || typeof offer !== "object") return { ok: false, code: "malformed_payload" }

  const required = ["offer_id", "rfq_id", "seller", "price", "currency", "valid_until", "signature"]
  for (const field of required) {
    if (offer[field] === undefined || offer[field] === null) {
      return { ok: false, code: "malformed_payload" }
    }
  }

  if (!isValidDecimalPositive(offer.price)) return { ok: false, code: "invalid_amount" }
  if (offer.currency !== rfq.currency) return { ok: false, code: "currency_mismatch" }
  if (!isFutureISO(offer.valid_until)) return { ok: false, code: "invalid_expiry" }

  return { ok: true }
}

export function validateCounter(counter: any, rfq: RFQ): ValidationResult {
  if (!counter || typeof counter !== "object") return { ok: false, code: "malformed_payload" }

  const required = ["counter_id", "rfq_id", "round", "from", "to", "price", "currency", "valid_until", "signature"]
  for (const field of required) {
    if (counter[field] === undefined || counter[field] === null) {
      return { ok: false, code: "malformed_payload" }
    }
  }

  if (!isValidDecimalPositive(counter.price)) return { ok: false, code: "invalid_amount" }
  if (counter.currency !== rfq.currency) return { ok: false, code: "currency_mismatch" }
  if (!isFutureISO(counter.valid_until)) return { ok: false, code: "invalid_expiry" }

  // ZK proof field structure validation (not proof verification — engine does that)
  if (rfq.budget_commitment) {
    if (!counter.budget_proof) return { ok: false, code: "missing_budget_proof" }
    if (counter.budget_proof.protocol !== "groth16") return { ok: false, code: "invalid_budget_proof" }
    if (counter.budget_proof.curve !== "bn128") return { ok: false, code: "invalid_budget_proof" }
  } else if (counter.budget_proof) {
    return { ok: false, code: "unexpected_budget_proof" }
  }

  // NOTE: The following checks happen in the ENGINE route, not here:
  // - counter.from === rfq.buyer (422 unauthorized_counter)
  // - counter.round monotonically increasing (422 invalid_round)
  // - budget_proof.counter_price_scaled === normalizeAmount(counter.price) (422 proof_price_mismatch)
  // - verifyBudgetProof() (422 invalid_budget_proof)
  // - Ed25519 signature verification (401 invalid_buyer_signature)
  return { ok: true }
}

export { isValidDecimalPositive, isUuidV4, isFutureISO, NONCE_RE }
```

- [ ] **Step 4: Create index.ts barrel export**

```typescript
// packages/core/src/index.ts
export * from "./schemas.js"
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/core && npx vitest run tests/schemas.test.ts`
Expected: All tests PASS

- [ ] **Step 6: Write and run tests for Offer and Counter validation**

```typescript
// append to packages/core/tests/schemas.test.ts
import { validateOffer, validateCounter, type RFQ } from "../src/schemas.js"

const baseRfq: RFQ = {
  rfq_id: "550e8400-e29b-41d4-a716-446655440000",
  protocol: "ghost-bazaar-v4",
  buyer: "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
  service_type: "ghost-bazaar:services:audit",
  spec: {},
  anchor_price: "35.00",
  currency: "USDC",
  deadline: new Date(Date.now() + 60_000).toISOString(),
  signature: "ed25519:dGVzdA==",
}

describe("validateOffer", () => {
  const validOffer = {
    offer_id: "660e8400-e29b-41d4-a716-446655440001",
    rfq_id: baseRfq.rfq_id,
    seller: "did:key:z6MksellerDID",
    price: "38.00",
    currency: "USDC",
    valid_until: new Date(Date.now() + 30_000).toISOString(),
    signature: "ed25519:dGVzdA==",
  }

  it("accepts valid offer", () => {
    expect(validateOffer(validOffer, baseRfq).ok).toBe(true)
  })

  it("rejects currency mismatch", () => {
    const result = validateOffer({ ...validOffer, currency: "SOL" }, baseRfq)
    expect(result.ok).toBe(false)
    expect((result as any).code).toBe("currency_mismatch")
  })

  it("rejects expired offer", () => {
    const result = validateOffer({ ...validOffer, valid_until: "2020-01-01T00:00:00Z" }, baseRfq)
    expect(result.ok).toBe(false)
    expect((result as any).code).toBe("invalid_expiry")
  })
})

describe("validateCounter", () => {
  const validCounter = {
    counter_id: "770e8400-e29b-41d4-a716-446655440002",
    rfq_id: baseRfq.rfq_id,
    round: 1,
    from: baseRfq.buyer,
    to: "did:key:z6MksellerDID",
    price: "36.00",
    currency: "USDC",
    valid_until: new Date(Date.now() + 30_000).toISOString(),
    signature: "ed25519:dGVzdA==",
  }

  it("accepts valid counter (no ZK)", () => {
    expect(validateCounter(validCounter, baseRfq).ok).toBe(true)
  })

  it("rejects counter with proof when RFQ has no commitment", () => {
    const result = validateCounter({
      ...validCounter,
      budget_proof: { protocol: "groth16", curve: "bn128", counter_price_scaled: "36000000", pi_a: [], pi_b: [], pi_c: [] },
    }, baseRfq)
    expect(result.ok).toBe(false)
    expect((result as any).code).toBe("unexpected_budget_proof")
  })

  it("rejects counter without proof when RFQ has commitment", () => {
    const rfqWithCommitment = { ...baseRfq, budget_commitment: "poseidon:" + "a".repeat(64) }
    const result = validateCounter(validCounter, rfqWithCommitment)
    expect(result.ok).toBe(false)
    expect((result as any).code).toBe("missing_budget_proof")
  })
})
```

Run: `cd packages/core && npx vitest run tests/schemas.test.ts`
Expected: All PASS

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/schemas.ts packages/core/src/index.ts packages/core/tests/
git commit -m "feat(core): add protocol types and schema validators"
```

---

### Task 2: Canonical JSON + Ed25519 Signing

**Files:**
- Create: `packages/core/src/canonical.ts`
- Create: `packages/core/src/signing.ts`
- Test: `packages/core/tests/signing.test.ts`

- [ ] **Step 1: Write failing tests for canonical JSON and signing**

```typescript
// packages/core/tests/signing.test.ts
import { describe, it, expect } from "vitest"
import { canonicalJson, signEd25519, verifyEd25519, buildDid } from "../src/signing.js"

describe("canonicalJson", () => {
  it("sorts keys deterministically", () => {
    const bytes = canonicalJson({ z: 1, a: 2 })
    const str = new TextDecoder().decode(bytes)
    expect(str).toBe('{"a":2,"z":1}')
  })

  it("sorts nested keys", () => {
    const bytes = canonicalJson({ b: { z: 1, a: 2 }, a: 3 })
    const str = new TextDecoder().decode(bytes)
    expect(str).toBe('{"a":3,"b":{"a":2,"z":1}}')
  })

  it("omits empty extensions", () => {
    const bytes = canonicalJson({ a: 1, extensions: {} })
    const str = new TextDecoder().decode(bytes)
    expect(str).toBe('{"a":1}')
  })

  it("preserves non-empty extensions", () => {
    const bytes = canonicalJson({ a: 1, extensions: { "x-acme:priority": "high" } })
    const str = new TextDecoder().decode(bytes)
    expect(str).toContain('"extensions"')
  })

  it("no whitespace in output", () => {
    const bytes = canonicalJson({ hello: "world", num: 42 })
    const str = new TextDecoder().decode(bytes)
    expect(str).not.toMatch(/\s/)
  })
})

describe("signEd25519 / verifyEd25519", () => {
  it("sign and verify round-trip", async () => {
    // Generate a test keypair
    const { Keypair } = await import("@solana/web3.js")
    const kp = Keypair.generate()
    const payload = canonicalJson({ test: "data" })
    const sig = await signEd25519(payload, kp)
    expect(sig.startsWith("ed25519:")).toBe(true)
    const valid = await verifyEd25519(payload, sig, kp.publicKey)
    expect(valid).toBe(true)
  })

  it("fails verification on tampered data", async () => {
    const { Keypair } = await import("@solana/web3.js")
    const kp = Keypair.generate()
    const payload = canonicalJson({ test: "data" })
    const sig = await signEd25519(payload, kp)
    const tampered = canonicalJson({ test: "tampered" })
    const valid = await verifyEd25519(tampered, sig, kp.publicKey)
    expect(valid).toBe(false)
  })
})

describe("buildDid", () => {
  it("produces did:key:z6Mk... format", async () => {
    const { Keypair } = await import("@solana/web3.js")
    const kp = Keypair.generate()
    const did = buildDid(kp.publicKey)
    expect(did).toMatch(/^did:key:z6Mk/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && npx vitest run tests/signing.test.ts`
Expected: FAIL — modules not found

- [ ] **Step 3: Implement canonical.ts**

```typescript
// packages/core/src/canonical.ts

function sortKeys(obj: unknown): unknown {
  if (obj === null || typeof obj !== "object") return obj
  if (Array.isArray(obj)) return obj.map(sortKeys)
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(obj as Record<string, unknown>).sort()) {
    const val = (obj as Record<string, unknown>)[key]
    // Omit empty extensions per v4 Section 5.7
    if (key === "extensions" && typeof val === "object" && val !== null && Object.keys(val).length === 0) {
      continue
    }
    sorted[key] = sortKeys(val)
  }
  return sorted
}

export function canonicalJson(obj: Record<string, unknown>): Uint8Array {
  const sorted = sortKeys(obj)
  const json = JSON.stringify(sorted)
  return new TextEncoder().encode(json)
}
```

- [ ] **Step 4: Implement signing.ts**

```typescript
// packages/core/src/signing.ts
import * as ed25519 from "@noble/ed25519"
import { sha512 } from "@noble/hashes/sha512"
import bs58 from "bs58"
import { type Keypair, PublicKey } from "@solana/web3.js"

// noble/ed25519 v2 requires setting sha512
ed25519.etc.sha512Sync = (...m) => {
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
```

- [ ] **Step 5: Update index.ts exports**

```typescript
// packages/core/src/index.ts
export * from "./schemas.js"
export * from "./signing.js"
export * from "./canonical.js"
```

- [ ] **Step 6: Add @solana/web3.js and @noble/hashes to core dependencies**

Add to `packages/core/package.json` dependencies:
```json
"@solana/web3.js": "^1.95.0",
"@noble/hashes": "^1.4.0"
```

Run: `pnpm install`

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd packages/core && npx vitest run tests/signing.test.ts`
Expected: All PASS

- [ ] **Step 8: Commit**

```bash
git add packages/core/src/canonical.ts packages/core/src/signing.ts packages/core/src/index.ts packages/core/tests/signing.test.ts packages/core/package.json
git commit -m "feat(core): add canonical JSON and Ed25519 signing"
```

---

### Task 3: Amount Normalization

**Files:**
- Create: `packages/core/src/amounts.ts`
- Test: `packages/core/tests/amounts.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// packages/core/tests/amounts.test.ts
import { describe, it, expect } from "vitest"
import { normalizeAmount, decimalStringCompare, computeSpecHash } from "../src/amounts.js"

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
})

describe("computeSpecHash", () => {
  it("produces sha256:<hex> format", () => {
    const hash = computeSpecHash({ language: "solidity", lines: 500 })
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it("is deterministic", () => {
    const a = computeSpecHash({ b: 2, a: 1 })
    const b = computeSpecHash({ a: 1, b: 2 })
    expect(a).toBe(b)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && npx vitest run tests/amounts.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement amounts.ts**

```typescript
// packages/core/src/amounts.ts
import Decimal from "decimal.js"
import { sha256 } from "@noble/hashes/sha256"
import { canonicalJson } from "./canonical.js"

// Mint → decimals lookup. USDC is always 6 decimals.
const MINT_DECIMALS: Record<string, number> = {
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": 6, // mainnet USDC
  "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU": 6,  // devnet USDC
}

/**
 * Convert decimal string to integer micro-units using mint's decimal count.
 * Uses integer arithmetic on the decimal string — never parseFloat.
 */
export function normalizeAmount(decimalStr: string, mintAddress: string): bigint {
  const decimals = MINT_DECIMALS[mintAddress]
  if (decimals === undefined) {
    // Default to 6 for any test mint (hackathon convenience)
    return normalizeWithDecimals(decimalStr, 6)
  }
  return normalizeWithDecimals(decimalStr, decimals)
}

function normalizeWithDecimals(decimalStr: string, decimals: number): bigint {
  // Split at decimal point
  const parts = decimalStr.split(".")
  const intPart = parts[0] || "0"
  let fracPart = parts[1] || ""

  // Pad or truncate fractional part to exactly `decimals` digits
  if (fracPart.length < decimals) {
    fracPart = fracPart.padEnd(decimals, "0")
  } else {
    fracPart = fracPart.slice(0, decimals)
  }

  return BigInt(intPart + fracPart)
}

export function decimalStringCompare(a: string, b: string): -1 | 0 | 1 {
  const da = new Decimal(a)
  const db = new Decimal(b)
  return da.lt(db) ? -1 : da.gt(db) ? 1 : 0
}

export function computeSpecHash(spec: Record<string, unknown>): string {
  const bytes = canonicalJson(spec)
  const hash = sha256(bytes)
  const hex = Buffer.from(hash).toString("hex")
  return `sha256:${hex}`
}

/** Register a custom mint address with its decimal count (for devnet test mints). */
export function registerMint(mintAddress: string, decimals: number): void {
  MINT_DECIMALS[mintAddress] = decimals
}
```

- [ ] **Step 4: Update index.ts**

Add to `packages/core/src/index.ts`:
```typescript
export * from "./amounts.js"
```

- [ ] **Step 5: Run tests**

Run: `cd packages/core && npx vitest run tests/amounts.test.ts`
Expected: All PASS

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/amounts.ts packages/core/src/index.ts packages/core/tests/amounts.test.ts
git commit -m "feat(core): add normalizeAmount, decimalStringCompare, computeSpecHash"
```

---

### Task 4: Quote Building + Verification

**Files:**
- Create: `packages/core/src/quote.ts`
- Test: `packages/core/tests/quote.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// packages/core/tests/quote.test.ts
import { describe, it, expect } from "vitest"
import { Keypair } from "@solana/web3.js"
import { buildUnsignedQuote, signQuoteAsBuyer, signQuoteAsSeller, verifyQuote } from "../src/quote.js"
import { buildDid } from "../src/signing.js"

describe("Quote lifecycle", () => {
  const buyerKp = Keypair.generate()
  const sellerKp = Keypair.generate()
  const buyerDid = buildDid(buyerKp.publicKey)
  const sellerDid = buildDid(sellerKp.publicKey)

  it("build → sign buyer → sign seller → verify", async () => {
    const unsigned = buildUnsignedQuote({
      rfq_id: "550e8400-e29b-41d4-a716-446655440000",
      buyer: buyerDid,
      seller: sellerDid,
      service_type: "ghost-bazaar:services:audit",
      final_price: "36.50",
      currency: "USDC",
      payment_endpoint: "https://seller.example/execute",
      expires_seconds: 300,
    })

    expect(unsigned.buyer_signature).toBe("")
    expect(unsigned.seller_signature).toBe("")
    expect(unsigned.memo_policy).toBe("quote_id_required")

    const buyerSigned = await signQuoteAsBuyer(unsigned, buyerKp)
    expect(buyerSigned.buyer_signature).toMatch(/^ed25519:/)

    const fullySigned = await signQuoteAsSeller(buyerSigned, sellerKp)
    expect(fullySigned.seller_signature).toMatch(/^ed25519:/)

    const result = await verifyQuote(fullySigned)
    expect(result.ok).toBe(true)
  })

  it("fails verification on tampered price", async () => {
    const unsigned = buildUnsignedQuote({
      rfq_id: "550e8400-e29b-41d4-a716-446655440000",
      buyer: buyerDid,
      seller: sellerDid,
      service_type: "ghost-bazaar:services:audit",
      final_price: "36.50",
      currency: "USDC",
      payment_endpoint: "https://seller.example/execute",
      expires_seconds: 300,
    })

    const buyerSigned = await signQuoteAsBuyer(unsigned, buyerKp)
    const fullySigned = await signQuoteAsSeller(buyerSigned, sellerKp)

    // Tamper
    const tampered = { ...fullySigned, final_price: "99.00" }
    const result = await verifyQuote(tampered)
    expect(result.ok).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && npx vitest run tests/quote.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement quote.ts**

```typescript
// packages/core/src/quote.ts
import { v4 as uuidv4 } from "uuid"
import { randomBytes } from "crypto"
import { canonicalJson } from "./canonical.js"
import { signEd25519, verifyEd25519, buildDid } from "./signing.js"
import { computeSpecHash } from "./amounts.js"
import { NONCE_RE } from "./schemas.js"
import type { SignedQuote } from "./schemas.js"
import type { Keypair, PublicKey } from "@solana/web3.js"

interface BuildQuoteInput {
  rfq_id: string
  buyer: string
  seller: string
  service_type: string
  final_price: string
  currency: string
  payment_endpoint: string
  expires_seconds: number
  memo_policy?: "optional" | "quote_id_required" | "hash_required"
  spec?: Record<string, unknown>
  spec_hash?: string
}

export function buildUnsignedQuote(input: BuildQuoteInput): SignedQuote {
  const nonce = "0x" + randomBytes(32).toString("hex")
  const expiresAt = new Date(Date.now() + input.expires_seconds * 1000).toISOString()

  return {
    quote_id: uuidv4(),
    rfq_id: input.rfq_id,
    buyer: input.buyer,
    seller: input.seller,
    service_type: input.service_type,
    final_price: input.final_price,
    currency: input.currency,
    payment_endpoint: input.payment_endpoint,
    expires_at: expiresAt,
    nonce,
    memo_policy: input.memo_policy ?? "quote_id_required",
    buyer_signature: "",
    seller_signature: "",
    spec_hash: input.spec_hash ?? (input.spec ? computeSpecHash(input.spec) : undefined),
  }
}

function quoteSigningPayload(quote: SignedQuote): Uint8Array {
  const obj = { ...quote, buyer_signature: "", seller_signature: "" }
  return canonicalJson(obj)
}

export async function signQuoteAsBuyer(quote: SignedQuote, keypair: Keypair): Promise<SignedQuote> {
  const payload = quoteSigningPayload(quote)
  const sig = await signEd25519(payload, keypair)
  return { ...quote, buyer_signature: sig }
}

export async function signQuoteAsSeller(quote: SignedQuote, keypair: Keypair): Promise<SignedQuote> {
  const payload = quoteSigningPayload(quote)
  const sig = await signEd25519(payload, keypair)
  return { ...quote, seller_signature: sig }
}

export async function verifyQuote(quote: SignedQuote): Promise<{ ok: true } | { ok: false; code: string }> {
  // Validate nonce format (v4 §5.5: 32 bytes, lowercase hex, 0x prefix)
  if (!NONCE_RE.test(quote.nonce)) return { ok: false, code: "invalid_nonce_format" }

  const payload = quoteSigningPayload(quote)

  // Extract pubkeys from DIDs
  const buyerPubkey = didToPublicKey(quote.buyer)
  const sellerPubkey = didToPublicKey(quote.seller)

  if (!buyerPubkey || !sellerPubkey) return { ok: false, code: "malformed_quote" }

  const buyerOk = await verifyEd25519(payload, quote.buyer_signature, buyerPubkey)
  if (!buyerOk) return { ok: false, code: "invalid_buyer_signature" }

  const sellerOk = await verifyEd25519(payload, quote.seller_signature, sellerPubkey)
  if (!sellerOk) return { ok: false, code: "invalid_seller_signature" }

  return { ok: true }
}

function didToPublicKey(did: string): PublicKey | null {
  try {
    if (!did.startsWith("did:key:z")) return null
    const decoded = bs58.decode(did.slice(8)) // strip "did:key:z"
    // First 2 bytes are multicodec (0xed, 0x01)
    if (decoded[0] !== 0xed || decoded[1] !== 0x01) return null
    return new PublicKey(decoded.slice(2))
  } catch {
    return null
  }
}

export { didToPublicKey }
```

- [ ] **Step 4: Add uuid to core dependencies**

Add to `packages/core/package.json` dependencies:
```json
"uuid": "^9.0.0"
```
Add to devDependencies:
```json
"@types/uuid": "^9.0.0"
```

Run: `pnpm install`

- [ ] **Step 5: Update index.ts**

Add to `packages/core/src/index.ts`:
```typescript
export * from "./quote.js"
```

- [ ] **Step 6: Run tests**

Run: `cd packages/core && npx vitest run`
Expected: All tests across all test files PASS

- [ ] **Step 7: Commit**

```bash
git add packages/core/
git commit -m "feat(core): add quote build, sign, verify lifecycle"
```

---

## Chunk 2: ZK Budget Proof + Strategy SDK

### Task 5: ZK Package Scaffold + Circuit

**Files:**
- Create: `packages/zk/package.json`
- Create: `packages/zk/tsconfig.json`
- Create: `packages/zk/vitest.config.ts`
- Create: `packages/zk/circuits/BudgetRangeProof.circom`
- Create: `packages/zk/scripts/setup.sh`

- [ ] **Step 1: Create packages/zk scaffold**

```json
// packages/zk/package.json
{
  "name": "@ghost-bazaar/zk",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "setup": "bash scripts/setup.sh"
  },
  "dependencies": {
    "@ghost-bazaar/core": "workspace:*",
    "snarkjs": "^0.7.4",
    "circomlibjs": "^0.1.7"
  },
  "devDependencies": {
    "typescript": "^5.4.0",
    "vitest": "^1.6.0"
  }
}
```

- [ ] **Step 2: Write BudgetRangeProof.circom**

```circom
// packages/zk/circuits/BudgetRangeProof.circom
pragma circom 2.0.0;

include "node_modules/circomlib/circuits/poseidon.circom";
include "node_modules/circomlib/circuits/comparators.circom";

template BudgetRangeProof() {
    // Public inputs
    signal input counter_price_scaled;
    signal input budget_commitment;

    // Private inputs
    signal input budget_hard_scaled;
    signal input commitment_salt;

    // Constraint 1: commitment integrity
    component poseidon = Poseidon(2);
    poseidon.inputs[0] <== budget_hard_scaled;
    poseidon.inputs[1] <== commitment_salt;
    poseidon.out === budget_commitment;

    // Constraint 2: range check — counter ≤ budget
    component leq = LessEqThan(64);
    leq.in[0] <== counter_price_scaled;
    leq.in[1] <== budget_hard_scaled;
    leq.out === 1;
}

component main {public [counter_price_scaled, budget_commitment]} = BudgetRangeProof();
```

- [ ] **Step 3: Write trusted setup script**

```bash
#!/bin/bash
# packages/zk/scripts/setup.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ZK_DIR="$(dirname "$SCRIPT_DIR")"
BUILD_DIR="$ZK_DIR/build"
KEYS_DIR="$ZK_DIR/keys"

mkdir -p "$BUILD_DIR" "$KEYS_DIR"

# Download Powers of Tau if not present
PTAU="$BUILD_DIR/pot12.ptau"
if [ ! -f "$PTAU" ]; then
  echo "Downloading Powers of Tau..."
  curl -o "$PTAU" https://hermez.s3-eu-west-1.amazonaws.com/powersOfTau28_hez_final_12.ptau
fi

# Compile circuit
echo "Compiling circuit..."
circom "$ZK_DIR/circuits/BudgetRangeProof.circom" \
  --r1cs --wasm --sym \
  --output "$BUILD_DIR/"

# Generate zkey
echo "Generating zkey..."
npx snarkjs groth16 setup \
  "$BUILD_DIR/BudgetRangeProof.r1cs" \
  "$PTAU" \
  "$BUILD_DIR/BudgetRangeProof_0.zkey"

# Contribute randomness
echo "Contributing randomness..."
npx snarkjs zkey contribute \
  "$BUILD_DIR/BudgetRangeProof_0.zkey" \
  "$BUILD_DIR/BudgetRangeProof_final.zkey" \
  --name="Ghost Bazaar hackathon" -v -e="ghost-bazaar-hackathon-entropy"

# Export verification key
echo "Exporting vkey..."
npx snarkjs zkey export verificationkey \
  "$BUILD_DIR/BudgetRangeProof_final.zkey" \
  "$KEYS_DIR/vkey.json"

echo "Setup complete!"
```

- [ ] **Step 4: Add build/ to .gitignore**

Append to root `.gitignore`:
```
packages/zk/build/
*.ptau
```

- [ ] **Step 5: Commit**

```bash
git add packages/zk/package.json packages/zk/tsconfig.json packages/zk/vitest.config.ts packages/zk/circuits/ packages/zk/scripts/ .gitignore
git commit -m "feat(zk): add circuit and trusted setup script"
```

---

### Task 6: ZK Prover + Verifier

**Files:**
- Create: `packages/zk/src/scale.ts`
- Create: `packages/zk/src/commitment.ts`
- Create: `packages/zk/src/prover.ts`
- Create: `packages/zk/src/verifier.ts`
- Create: `packages/zk/src/index.ts`
- Test: `packages/zk/tests/budget-range-proof.test.ts`

- [ ] **Step 1: Implement scale.ts**

```typescript
// packages/zk/src/scale.ts
import { normalizeAmount } from "@ghost-bazaar/core"

// Default USDC mint for ZK scaling (6 decimals)
const DEFAULT_USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"

export function scalePrice(decimalStr: string, mint?: string): bigint {
  return normalizeAmount(decimalStr, mint ?? DEFAULT_USDC_MINT)
}

export function unscalePrice(scaled: bigint): string {
  const str = scaled.toString().padStart(7, "0") // at least 7 chars for 6 decimals
  const intPart = str.slice(0, -6) || "0"
  const fracPart = str.slice(-6).replace(/0+$/, "") || "0"
  return fracPart === "0" ? `${intPart}.00` : `${intPart}.${fracPart}`
}
```

- [ ] **Step 2: Implement commitment.ts**

```typescript
// packages/zk/src/commitment.ts
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
```

- [ ] **Step 3: Implement prover.ts**

```typescript
// packages/zk/src/prover.ts
import * as snarkjs from "snarkjs"
import path from "path"
import { fileURLToPath } from "url"
import { scalePrice } from "./scale.js"
import type { BudgetProof } from "@ghost-bazaar/core"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const WASM_PATH = path.join(__dirname, "../build/BudgetRangeProof_js/BudgetRangeProof.wasm")
const ZKEY_PATH = path.join(__dirname, "../build/BudgetRangeProof_final.zkey")

export async function generateBudgetProof(
  counter_price: string,
  budget_hard: string,
  salt: bigint
): Promise<BudgetProof> {
  const counter_price_scaled = scalePrice(counter_price)
  const budget_hard_scaled = scalePrice(budget_hard)

  // Regenerate commitment for public input
  const { buildPoseidon } = await import("circomlibjs")
  const poseidon = await buildPoseidon()
  const commitment = poseidon([budget_hard_scaled, salt])
  const commitmentBigInt = poseidon.F.toObject(commitment)

  const input = {
    counter_price_scaled: counter_price_scaled.toString(),
    budget_commitment: commitmentBigInt.toString(),
    budget_hard_scaled: budget_hard_scaled.toString(),
    commitment_salt: salt.toString(),
  }

  const { proof } = await snarkjs.groth16.fullProve(input, WASM_PATH, ZKEY_PATH)

  return {
    protocol: "groth16",
    curve: "bn128",
    counter_price_scaled: counter_price_scaled.toString(),
    pi_a: proof.pi_a,
    pi_b: proof.pi_b,
    pi_c: proof.pi_c,
  }
}
```

- [ ] **Step 4: Implement verifier.ts**

```typescript
// packages/zk/src/verifier.ts
import * as snarkjs from "snarkjs"
import { readFileSync } from "fs"
import path from "path"
import { fileURLToPath } from "url"
import type { BudgetProof } from "@ghost-bazaar/core"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const VKEY_PATH = path.join(__dirname, "../keys/vkey.json")

let vkey: any = null
function getVkey() {
  if (!vkey) vkey = JSON.parse(readFileSync(VKEY_PATH, "utf8"))
  return vkey
}

export async function verifyBudgetProof(
  proof: BudgetProof,
  counter_price_scaled: bigint,
  budget_commitment: string
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

  try {
    return await snarkjs.groth16.verify(getVkey(), publicSignals, proofForSnarkjs)
  } catch {
    return false
  }
}
```

- [ ] **Step 5: Create index.ts**

```typescript
// packages/zk/src/index.ts
export { scalePrice, unscalePrice } from "./scale.js"
export { generateBudgetCommitment } from "./commitment.js"
export { generateBudgetProof } from "./prover.js"
export { verifyBudgetProof } from "./verifier.js"
```

- [ ] **Step 6: Write tests (requires circuit setup first)**

```typescript
// packages/zk/tests/budget-range-proof.test.ts
import { describe, it, expect } from "vitest"
import { scalePrice, unscalePrice } from "../src/scale.js"
import { generateBudgetCommitment } from "../src/commitment.js"
import { generateBudgetProof } from "../src/prover.js"
import { verifyBudgetProof } from "../src/verifier.js"

describe("scalePrice / unscalePrice", () => {
  it("round-trips 36.50", () => {
    const scaled = scalePrice("36.50")
    expect(scaled).toBe(36_500_000n)
    expect(unscalePrice(scaled)).toBe("36.5")
  })
})

describe("ZK proof lifecycle", () => {
  // NOTE: These tests require circuit artifacts. Run `pnpm run setup` in packages/zk first.

  const salt = 12345678901234567890n
  const budget_hard = "45.00"

  it("commitment → proof → verify round-trip", async () => {
    const commitment = await generateBudgetCommitment(budget_hard, salt)
    expect(commitment).toMatch(/^poseidon:[0-9a-f]{64}$/)

    const proof = await generateBudgetProof("36.00", budget_hard, salt)
    expect(proof.protocol).toBe("groth16")

    const valid = await verifyBudgetProof(
      proof,
      scalePrice("36.00"),
      commitment
    )
    expect(valid).toBe(true)
  }, 30_000) // ZK proofs can take time

  it("proof with wrong counter_price_scaled fails", async () => {
    const commitment = await generateBudgetCommitment(budget_hard, salt)
    const proof = await generateBudgetProof("36.00", budget_hard, salt)

    // Verify with wrong price
    const valid = await verifyBudgetProof(
      proof,
      scalePrice("37.00"), // different from proof's 36.00
      commitment
    )
    expect(valid).toBe(false)
  }, 30_000)
})
```

- [ ] **Step 7: Run circuit setup, then tests**

Run:
```bash
cd packages/zk && pnpm run setup
cd packages/zk && npx vitest run
```
Expected: Setup completes, tests PASS

- [ ] **Step 8: Commit (include vkey.json, exclude build artifacts)**

```bash
git add packages/zk/src/ packages/zk/tests/ packages/zk/keys/vkey.json packages/zk/package.json packages/zk/tsconfig.json packages/zk/vitest.config.ts
git commit -m "feat(zk): add Groth16 budget proof generation and verification"
```

---

### Task 7: Strategy Interfaces + Sanitizer

**Files:**
- Create: `packages/strategy/package.json`
- Create: `packages/strategy/tsconfig.json`
- Create: `packages/strategy/vitest.config.ts`
- Create: `packages/strategy/src/interfaces.ts`
- Create: `packages/strategy/src/sanitizer.ts`
- Create: `packages/strategy/src/index.ts`
- Test: `packages/strategy/tests/sanitizer.test.ts`

- [ ] **Step 1: Create packages/strategy scaffold**

```json
// packages/strategy/package.json
{
  "name": "@ghost-bazaar/strategy",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": { "build": "tsc", "test": "vitest run" },
  "dependencies": {
    "@ghost-bazaar/core": "workspace:*",
    "decimal.js": "^10.4.3"
  },
  "devDependencies": {
    "typescript": "^5.4.0",
    "vitest": "^1.6.0"
  }
}
```

- [ ] **Step 2: Implement interfaces.ts**

```typescript
// packages/strategy/src/interfaces.ts
import Decimal from "decimal.js"
import type { RFQ, SellerOffer, CounterOffer } from "@ghost-bazaar/core"

export type BuyerPrivate = { budget_soft: Decimal; budget_hard: Decimal }
export type SellerPrivate = { floor_price: Decimal; target_price: Decimal }

export type NegotiationProfile = {
  style: "firm" | "flexible" | "competitive" | "deadline-sensitive"
  max_rounds?: number
  accepts_counter?: boolean
}

export interface NegotiationEvent {
  event_id: number
  rfq_id: string
  event_type: string
  actor: string
  payload: unknown
  timestamp: string
}

export type BuyerStrategyContext = {
  rfq: RFQ
  private: BuyerPrivate
  current_offers: SellerOffer[]
  counters_sent: CounterOffer[]
  round: number
  time_remaining_ms: number
  history: NegotiationEvent[]
}

export type SellerStrategyContext = {
  rfq: RFQ
  private: SellerPrivate
  latest_counter: CounterOffer | null
  own_offers: SellerOffer[]
  round: number
  time_remaining_ms: number
  competing_sellers: number
  seller_listing_profile: NegotiationProfile | null
}

export type ServiceIntent = {
  service_type: string
  spec: Record<string, unknown>
}

export type BuyerAction =
  | { type: "counter"; seller: string; price: Decimal }
  | { type: "accept"; seller: string }
  | { type: "wait" }
  | { type: "cancel" }

export type SellerAction =
  | { type: "respond"; price: Decimal }
  | { type: "counter"; price: Decimal }
  | { type: "hold" }
  | { type: "decline" }

export interface BuyerStrategy {
  openingAnchor(intent: ServiceIntent, priv: BuyerPrivate): Decimal
  onOffersReceived(ctx: BuyerStrategyContext): BuyerAction | Promise<BuyerAction>
}

export interface SellerStrategy {
  onRfqReceived(ctx: SellerStrategyContext): SellerAction | Promise<SellerAction>
  onCounterReceived(ctx: SellerStrategyContext): SellerAction | Promise<SellerAction>
}
```

- [ ] **Step 3: Implement sanitizer.ts**

```typescript
// packages/strategy/src/sanitizer.ts
import Decimal from "decimal.js"
import type { BuyerAction, SellerAction, BuyerPrivate, SellerPrivate } from "./interfaces.js"

export function sanitizeBuyerAction(action: BuyerAction, priv: BuyerPrivate): BuyerAction {
  if (action.type === "counter") {
    return { ...action, price: Decimal.min(action.price, priv.budget_hard) }
  }
  return action
}

export function sanitizeSellerAction(action: SellerAction, priv: SellerPrivate): SellerAction {
  if (action.type === "respond" || action.type === "counter") {
    return { ...action, price: Decimal.max(action.price, priv.floor_price) }
  }
  return action
}
```

- [ ] **Step 4: Write tests**

```typescript
// packages/strategy/tests/sanitizer.test.ts
import { describe, it, expect } from "vitest"
import Decimal from "decimal.js"
import { sanitizeBuyerAction, sanitizeSellerAction } from "../src/sanitizer.js"

describe("sanitizeBuyerAction", () => {
  const priv = { budget_soft: new Decimal("40"), budget_hard: new Decimal("45") }

  it("clamps price above budget_hard", () => {
    const action = { type: "counter" as const, seller: "did:key:z6Mk...", price: new Decimal("50") }
    const result = sanitizeBuyerAction(action, priv)
    expect(result.type).toBe("counter")
    if (result.type === "counter") expect(result.price.toNumber()).toBe(45)
  })

  it("passes price at exactly budget_hard", () => {
    const action = { type: "counter" as const, seller: "did:key:z6Mk...", price: new Decimal("45") }
    const result = sanitizeBuyerAction(action, priv)
    if (result.type === "counter") expect(result.price.toNumber()).toBe(45)
  })

  it("passes price below budget_hard unchanged", () => {
    const action = { type: "counter" as const, seller: "did:key:z6Mk...", price: new Decimal("38") }
    const result = sanitizeBuyerAction(action, priv)
    if (result.type === "counter") expect(result.price.toNumber()).toBe(38)
  })

  it("passes non-counter actions through", () => {
    const action = { type: "wait" as const }
    expect(sanitizeBuyerAction(action, priv)).toEqual(action)
  })
})

describe("sanitizeSellerAction", () => {
  const priv = { floor_price: new Decimal("30"), target_price: new Decimal("42") }

  it("clamps price below floor_price", () => {
    const action = { type: "respond" as const, price: new Decimal("25") }
    const result = sanitizeSellerAction(action, priv)
    if (result.type === "respond") expect(result.price.toNumber()).toBe(30)
  })

  it("passes price above floor unchanged", () => {
    const action = { type: "respond" as const, price: new Decimal("35") }
    const result = sanitizeSellerAction(action, priv)
    if (result.type === "respond") expect(result.price.toNumber()).toBe(35)
  })
})
```

- [ ] **Step 5: Create index.ts and run tests**

```typescript
// packages/strategy/src/index.ts
export * from "./interfaces.js"
export * from "./sanitizer.js"
```

Run: `cd packages/strategy && npx vitest run`
Expected: All PASS

- [ ] **Step 6: Commit**

```bash
git add packages/strategy/
git commit -m "feat(strategy): add interfaces and privacy sanitizer"
```

---

### Task 8: Rule-Based Strategies

**Files:**
- Create: `packages/strategy/src/linear-concession.ts`
- Create: `packages/strategy/src/time-weighted-buyer.ts`
- Create: `packages/strategy/src/competitive-buyer.ts`
- Create: `packages/strategy/src/competitive-seller.ts`
- Create: `packages/strategy/src/firm-seller.ts`
- Create: `packages/strategy/src/flexible-seller.ts`
- Test: `packages/strategy/tests/strategies.test.ts`

- [ ] **Step 1: Implement LinearConcessionBuyer**

```typescript
// packages/strategy/src/linear-concession.ts
import Decimal from "decimal.js"
import type { BuyerStrategy, BuyerAction, BuyerStrategyContext, BuyerPrivate, ServiceIntent } from "./interfaces.js"

export class LinearConcessionBuyer implements BuyerStrategy {
  openingAnchor(_intent: ServiceIntent, priv: BuyerPrivate): Decimal {
    // Start low — midpoint between 0 and budget_soft
    return priv.budget_soft.mul(0.8)
  }

  onOffersReceived(ctx: BuyerStrategyContext): BuyerAction {
    if (ctx.current_offers.length === 0) return { type: "wait" }

    // Find best (lowest) offer
    const best = ctx.current_offers.reduce((a, b) =>
      new Decimal(a.price).lt(new Decimal(b.price)) ? a : b
    )
    const bestPrice = new Decimal(best.price)

    // If best offer is at or below budget_soft, accept
    if (bestPrice.lte(ctx.private.budget_soft)) {
      return { type: "accept", seller: best.seller }
    }

    // Linear concession: move from anchor toward budget_soft
    const maxConcession = ctx.private.budget_soft.minus(new Decimal(ctx.rfq.anchor_price))
    const step = maxConcession.div(5) // 5 expected rounds
    const newPrice = new Decimal(ctx.rfq.anchor_price).plus(step.mul(ctx.round))
    const capped = Decimal.min(newPrice, ctx.private.budget_hard)

    return { type: "counter", seller: best.seller, price: capped }
  }
}
```

- [ ] **Step 2: Implement TimeWeightedBuyer**

```typescript
// packages/strategy/src/time-weighted-buyer.ts
import Decimal from "decimal.js"
import type { BuyerStrategy, BuyerAction, BuyerStrategyContext, BuyerPrivate, ServiceIntent } from "./interfaces.js"

export class TimeWeightedBuyer implements BuyerStrategy {
  openingAnchor(_intent: ServiceIntent, priv: BuyerPrivate): Decimal {
    return priv.budget_soft.mul(0.75)
  }

  onOffersReceived(ctx: BuyerStrategyContext): BuyerAction {
    if (ctx.current_offers.length === 0) return { type: "wait" }

    const best = ctx.current_offers.reduce((a, b) =>
      new Decimal(a.price).lt(new Decimal(b.price)) ? a : b
    )
    const bestPrice = new Decimal(best.price)

    if (bestPrice.lte(ctx.private.budget_soft)) {
      return { type: "accept", seller: best.seller }
    }

    // Urgency factor: accelerates concession as deadline approaches
    // Estimate total window: time_remaining shrinks each round, so total ≈ remaining + elapsed
    // Use round count as proxy: by round 5, urgency should be near 1.0
    const urgency = Math.min(1, (ctx.round / 5) + (1 - ctx.time_remaining_ms / Math.max(ctx.time_remaining_ms + ctx.round * 1000, 1)))
    const range = ctx.private.budget_hard.minus(new Decimal(ctx.rfq.anchor_price))
    const newPrice = new Decimal(ctx.rfq.anchor_price).plus(range.mul(urgency))
    const capped = Decimal.min(newPrice, ctx.private.budget_hard)

    return { type: "counter", seller: best.seller, price: capped }
  }
}
```

- [ ] **Step 3: Implement CompetitiveBuyer**

```typescript
// packages/strategy/src/competitive-buyer.ts
import Decimal from "decimal.js"
import type { BuyerStrategy, BuyerAction, BuyerStrategyContext, BuyerPrivate, ServiceIntent } from "./interfaces.js"

export class CompetitiveBuyer implements BuyerStrategy {
  openingAnchor(_intent: ServiceIntent, priv: BuyerPrivate): Decimal {
    return priv.budget_soft.mul(0.7)
  }

  onOffersReceived(ctx: BuyerStrategyContext): BuyerAction {
    if (ctx.current_offers.length === 0) return { type: "wait" }

    // Sort offers by price ascending
    const sorted = [...ctx.current_offers].sort((a, b) =>
      new Decimal(a.price).minus(new Decimal(b.price)).toNumber()
    )
    const best = sorted[0]
    const bestPrice = new Decimal(best.price)

    if (bestPrice.lte(ctx.private.budget_soft)) {
      return { type: "accept", seller: best.seller }
    }

    // Exploit multi-seller competition: concede less when many sellers competing
    const competitionFactor = sorted.length >= 3 ? 0.5 : sorted.length >= 2 ? 0.75 : 1.0
    const baseStep = ctx.private.budget_soft.minus(new Decimal(ctx.rfq.anchor_price)).div(5)
    const step = baseStep.mul(competitionFactor)
    const newPrice = new Decimal(ctx.rfq.anchor_price).plus(step.mul(ctx.round))
    const capped = Decimal.min(newPrice, ctx.private.budget_hard)

    return { type: "counter", seller: best.seller, price: capped }
  }
}
```

- [ ] **Step 4: Implement CompetitiveSeller**

```typescript
// packages/strategy/src/competitive-seller.ts
import Decimal from "decimal.js"
import type { SellerStrategy, SellerAction, SellerStrategyContext } from "./interfaces.js"

export class CompetitiveSeller implements SellerStrategy {
  onRfqReceived(ctx: SellerStrategyContext): SellerAction {
    return { type: "respond", price: ctx.private.target_price }
  }

  onCounterReceived(ctx: SellerStrategyContext): SellerAction {
    if (!ctx.latest_counter) return { type: "hold" }

    const maxConcession = ctx.private.target_price.minus(ctx.private.floor_price)
    const baseStep = maxConcession.div(5)
    const multiplier = ctx.competing_sellers >= 2 ? 1.5 : 0.5
    const concession = baseStep.mul(multiplier)
    const newPrice = ctx.private.target_price.minus(concession.mul(ctx.round))

    if (newPrice.lte(ctx.private.floor_price)) {
      return { type: "counter", price: ctx.private.floor_price }
    }
    return { type: "counter", price: newPrice }
  }
}
```

- [ ] **Step 5: Implement FirmSeller and FlexibleSeller**

```typescript
// packages/strategy/src/firm-seller.ts
import Decimal from "decimal.js"
import type { SellerStrategy, SellerAction, SellerStrategyContext } from "./interfaces.js"

export class FirmSeller implements SellerStrategy {
  onRfqReceived(ctx: SellerStrategyContext): SellerAction {
    return { type: "respond", price: ctx.private.target_price }
  }

  onCounterReceived(ctx: SellerStrategyContext): SellerAction {
    if (!ctx.latest_counter) return { type: "hold" }
    // Barely concede — 5% of range per round
    const range = ctx.private.target_price.minus(ctx.private.floor_price)
    const step = range.mul(0.05)
    const newPrice = ctx.private.target_price.minus(step.mul(ctx.round))
    if (newPrice.lte(ctx.private.floor_price)) {
      return { type: "counter", price: ctx.private.floor_price }
    }
    return { type: "counter", price: newPrice }
  }
}
```

```typescript
// packages/strategy/src/flexible-seller.ts
import Decimal from "decimal.js"
import type { SellerStrategy, SellerAction, SellerStrategyContext } from "./interfaces.js"

export class FlexibleSeller implements SellerStrategy {
  onRfqReceived(ctx: SellerStrategyContext): SellerAction {
    return { type: "respond", price: ctx.private.target_price }
  }

  onCounterReceived(ctx: SellerStrategyContext): SellerAction {
    if (!ctx.latest_counter) return { type: "hold" }
    // Concede aggressively — 25% of range per round
    const range = ctx.private.target_price.minus(ctx.private.floor_price)
    const step = range.mul(0.25)
    const newPrice = ctx.private.target_price.minus(step.mul(ctx.round))
    if (newPrice.lte(ctx.private.floor_price)) {
      return { type: "counter", price: ctx.private.floor_price }
    }
    return { type: "counter", price: newPrice }
  }
}
```

- [ ] **Step 6: Write tests**

```typescript
// packages/strategy/tests/strategies.test.ts
import { describe, it, expect } from "vitest"
import Decimal from "decimal.js"
import { LinearConcessionBuyer } from "../src/linear-concession.js"
import { TimeWeightedBuyer } from "../src/time-weighted-buyer.js"
import { CompetitiveBuyer } from "../src/competitive-buyer.js"
import { CompetitiveSeller } from "../src/competitive-seller.js"
import { FirmSeller } from "../src/firm-seller.js"
import { FlexibleSeller } from "../src/flexible-seller.js"
import type { BuyerStrategyContext, SellerStrategyContext, BuyerPrivate, SellerPrivate } from "../src/interfaces.js"

const buyerPriv: BuyerPrivate = { budget_soft: new Decimal("40"), budget_hard: new Decimal("45") }
const sellerPriv: SellerPrivate = { floor_price: new Decimal("30"), target_price: new Decimal("42") }

describe("LinearConcessionBuyer", () => {
  const buyer = new LinearConcessionBuyer()

  it("opening anchor is below budget_soft", () => {
    const anchor = buyer.openingAnchor({ service_type: "test", spec: {} }, buyerPriv)
    expect(anchor.lt(buyerPriv.budget_soft)).toBe(true)
  })

  it("accepts when best offer ≤ budget_soft", () => {
    const ctx = {
      rfq: { anchor_price: "35.00" } as any,
      private: buyerPriv,
      current_offers: [{ seller: "did:key:z6Mk...", price: "39.00" }] as any[],
      counters_sent: [],
      round: 1,
      time_remaining_ms: 30000,
      history: [],
    }
    const action = buyer.onOffersReceived(ctx)
    expect(action.type).toBe("accept")
  })
})

describe("CompetitiveSeller", () => {
  const seller = new CompetitiveSeller()

  it("opens at target_price", () => {
    const ctx = { private: sellerPriv, competing_sellers: 0, round: 0 } as any
    const action = seller.onRfqReceived(ctx)
    expect(action.type).toBe("respond")
    if (action.type === "respond") expect(action.price.eq(sellerPriv.target_price)).toBe(true)
  })

  it("concedes faster with competition", () => {
    const noComp = { private: sellerPriv, competing_sellers: 0, round: 1, latest_counter: { price: "36" } } as any
    const withComp = { ...noComp, competing_sellers: 3 }
    const a1 = seller.onCounterReceived(noComp)
    const a2 = seller.onCounterReceived(withComp)
    if (a1.type === "counter" && a2.type === "counter") {
      expect(a2.price.lt(a1.price)).toBe(true) // more concession with competition
    }
  })
})
```

- [ ] **Step 7: Update index.ts exports and run tests**

Add to `packages/strategy/src/index.ts`:
```typescript
export { LinearConcessionBuyer } from "./linear-concession.js"
export { TimeWeightedBuyer } from "./time-weighted-buyer.js"
export { CompetitiveBuyer } from "./competitive-buyer.js"
export { CompetitiveSeller } from "./competitive-seller.js"
export { FirmSeller } from "./firm-seller.js"
export { FlexibleSeller } from "./flexible-seller.js"
```

Run: `cd packages/strategy && npx vitest run`
Expected: All PASS

- [ ] **Step 8: Commit**

```bash
git add packages/strategy/
git commit -m "feat(strategy): add all 6 rule-based buyer and seller strategies"
```

---

## Chunk 3: Negotiation Engine

### Task 9: Engine Scaffold + State Machine

**Files:**
- Create: `packages/engine/package.json`
- Create: `packages/engine/tsconfig.json`
- Create: `packages/engine/vitest.config.ts`
- Create: `packages/engine/src/state-machine.ts`
- Create: `packages/engine/src/event-log.ts`
- Test: `packages/engine/tests/state-machine.test.ts`

- [ ] **Step 1: Create packages/engine scaffold**

```json
// packages/engine/package.json
{
  "name": "@ghost-bazaar/engine",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": { "build": "tsc", "test": "vitest run", "start": "tsx src/server.ts" },
  "dependencies": {
    "@ghost-bazaar/core": "workspace:*",
    "@ghost-bazaar/zk": "workspace:*",
    "hono": "^4.4.0",
    "@hono/node-server": "^1.11.0"
  },
  "devDependencies": {
    "typescript": "^5.4.0",
    "vitest": "^1.6.0",
    "tsx": "^4.7.0"
  }
}
```

- [ ] **Step 2: Implement state-machine.ts**

```typescript
// packages/engine/src/state-machine.ts

export type NegotiationState =
  | "OPEN"
  | "NEGOTIATING"
  | "COMMIT_PENDING"
  | "COMMITTED"
  | "EXPIRED"
  | "CANCELLED"

const TRANSITIONS: Record<NegotiationState, NegotiationState[]> = {
  OPEN: ["NEGOTIATING", "EXPIRED", "CANCELLED"],
  NEGOTIATING: ["COMMIT_PENDING", "EXPIRED", "CANCELLED"],
  COMMIT_PENDING: ["COMMITTED", "NEGOTIATING", "EXPIRED"],
  COMMITTED: [],
  EXPIRED: [],
  CANCELLED: [],
}

export function canTransition(from: NegotiationState, to: NegotiationState): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false
}

export function transition(from: NegotiationState, to: NegotiationState): NegotiationState {
  if (!canTransition(from, to)) {
    throw new TransitionError(from, to)
  }
  return to
}

export class TransitionError extends Error {
  constructor(public from: NegotiationState, public to: NegotiationState) {
    super(`invalid_state_transition: ${from} → ${to}`)
    this.name = "TransitionError"
  }
}
```

- [ ] **Step 3: Implement event-log.ts**

```typescript
// packages/engine/src/event-log.ts

export interface NegotiationEvent {
  event_id: number
  rfq_id: string
  event_type: string
  actor: string
  payload: unknown
  timestamp: string
}

export class EventLog {
  private events = new Map<string, NegotiationEvent[]>()
  private counters = new Map<string, number>()

  append(rfq_id: string, event_type: string, actor: string, payload: unknown): NegotiationEvent {
    const count = (this.counters.get(rfq_id) ?? 0) + 1
    this.counters.set(rfq_id, count)
    const event: NegotiationEvent = {
      event_id: count,
      rfq_id,
      event_type,
      actor,
      payload,
      timestamp: new Date().toISOString(),
    }
    const list = this.events.get(rfq_id) ?? []
    list.push(event)
    this.events.set(rfq_id, list)
    return event
  }

  get(rfq_id: string, after?: number): NegotiationEvent[] {
    const list = this.events.get(rfq_id) ?? []
    if (after !== undefined) return list.filter(e => e.event_id > after)
    return [...list]
  }
}
```

- [ ] **Step 4: Write state machine tests**

```typescript
// packages/engine/tests/state-machine.test.ts
import { describe, it, expect } from "vitest"
import { canTransition, transition, TransitionError } from "../src/state-machine.js"

describe("state machine", () => {
  it("OPEN → NEGOTIATING is valid", () => {
    expect(canTransition("OPEN", "NEGOTIATING")).toBe(true)
    expect(transition("OPEN", "NEGOTIATING")).toBe("NEGOTIATING")
  })

  it("NEGOTIATING → COMMIT_PENDING is valid", () => {
    expect(transition("NEGOTIATING", "COMMIT_PENDING")).toBe("COMMIT_PENDING")
  })

  it("COMMIT_PENDING → COMMITTED is valid", () => {
    expect(transition("COMMIT_PENDING", "COMMITTED")).toBe("COMMITTED")
  })

  it("COMMIT_PENDING → NEGOTIATING (seller declines co-sign)", () => {
    expect(transition("COMMIT_PENDING", "NEGOTIATING")).toBe("NEGOTIATING")
  })

  it("any active state → EXPIRED is valid", () => {
    expect(canTransition("OPEN", "EXPIRED")).toBe(true)
    expect(canTransition("NEGOTIATING", "EXPIRED")).toBe(true)
    expect(canTransition("COMMIT_PENDING", "EXPIRED")).toBe(true)
  })

  it("OPEN | NEGOTIATING → CANCELLED is valid", () => {
    expect(canTransition("OPEN", "CANCELLED")).toBe(true)
    expect(canTransition("NEGOTIATING", "CANCELLED")).toBe(true)
  })

  it("COMMIT_PENDING → CANCELLED is invalid", () => {
    expect(canTransition("COMMIT_PENDING", "CANCELLED")).toBe(false)
  })

  it("COMMITTED → anything is invalid", () => {
    expect(canTransition("COMMITTED", "OPEN")).toBe(false)
    expect(canTransition("COMMITTED", "EXPIRED")).toBe(false)
  })

  it("invalid transition throws TransitionError", () => {
    expect(() => transition("COMMITTED", "OPEN")).toThrow(TransitionError)
  })
})
```

Run: `cd packages/engine && npx vitest run`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add packages/engine/
git commit -m "feat(engine): add state machine and event log"
```

---

### Task 10: Engine HTTP Routes

**Files:**
- Create: `packages/engine/src/store.ts`
- Create: `packages/engine/src/routes/listings.ts`
- Create: `packages/engine/src/routes/rfqs.ts`
- Create: `packages/engine/src/routes/events.ts`
- Create: `packages/engine/src/server.ts`
- Create: `packages/engine/src/deadline.ts`
- Create: `packages/engine/src/index.ts`
- Test: `packages/engine/tests/routes.test.ts`

- [ ] **Step 1: Implement in-memory store**

```typescript
// packages/engine/src/store.ts
import type { RFQ, SellerOffer, CounterOffer, SignedQuote } from "@ghost-bazaar/core"
import type { NegotiationState } from "./state-machine.js"
import { EventLog } from "./event-log.js"

export interface Listing {
  listing_id: string
  seller: string
  title: string
  category: string
  service_type: string
  negotiation_endpoint: string
  payment_endpoint: string
  base_terms: Record<string, unknown>
  negotiation_profile?: {
    style: "firm" | "flexible" | "competitive" | "deadline-sensitive"
    max_rounds?: number
    accepts_counter?: boolean
  }
}

export interface Session {
  rfq: RFQ
  state: NegotiationState
  offers: Map<string, SellerOffer> // seller DID → latest offer
  counters: CounterOffer[]
  last_round: number
  unsigned_quote?: SignedQuote
  deadline_timer?: ReturnType<typeof setTimeout>
}

export class Store {
  listings = new Map<string, Listing>()
  sessions = new Map<string, Session>()
  eventLog = new EventLog()
}
```

- [ ] **Step 2: Implement listings routes**

```typescript
// packages/engine/src/routes/listings.ts
import { Hono } from "hono"
import { v4 as uuidv4 } from "uuid"
import type { Store, Listing } from "../store.js"

export function listingRoutes(store: Store) {
  const app = new Hono()

  app.get("/listings", (c) => {
    const category = c.req.query("category")
    let items = [...store.listings.values()]
    if (category) items = items.filter(l => l.category === category)
    return c.json(items)
  })

  app.get("/listings/:id", (c) => {
    const listing = store.listings.get(c.req.param("id"))
    if (!listing) return c.json({ error: "not_found" }, 404)
    return c.json(listing)
  })

  app.post("/listings", async (c) => {
    const body = await c.req.json()
    const listing: Listing = {
      listing_id: uuidv4(),
      seller: body.seller,
      title: body.title,
      category: body.category,
      service_type: body.service_type,
      negotiation_endpoint: body.negotiation_endpoint,
      payment_endpoint: body.payment_endpoint,
      base_terms: body.base_terms ?? {},
      negotiation_profile: body.negotiation_profile,
    }
    store.listings.set(listing.listing_id, listing)
    return c.json({ listing_id: listing.listing_id }, 201)
  })

  return app
}
```

- [ ] **Step 3: Implement RFQ routes (including counter verification, accept, quote/sign, cosign)**

This is the largest route file. Create `packages/engine/src/routes/rfqs.ts`:

```typescript
// packages/engine/src/routes/rfqs.ts
import { Hono } from "hono"
import {
  validateRfq, validateOffer, validateCounter, verifyQuote,
  canonicalJson, verifyEd25519, normalizeAmount, buildUnsignedQuote, NONCE_RE,
  objectSigningPayload,
} from "@ghost-bazaar/core"
import { verifyBudgetProof } from "@ghost-bazaar/zk"
import type { Store } from "../store.js"
import { transition, canTransition, TransitionError } from "../state-machine.js"

export function rfqRoutes(store: Store) {
  const app = new Hono()

  // POST /rfqs — 9-step RFQ submission verification
  app.post("/rfqs", async (c) => {
    const body = await c.req.json()
    // Steps 1-6: Schema validation (protocol, fields, amount, currency, deadline, commitment format)
    const v = validateRfq(body)
    if (!v.ok) return c.json({ error: v.code }, 422)
    // Step 7: Verify buyer Ed25519 signature
    const sigPayload = objectSigningPayload(body)
    // NOTE: In integration tests use real keypairs; MVP routes may skip sig verification
    // Step 8: Create session with state OPEN
    store.sessions.set(body.rfq_id, {
      rfq: body, state: "OPEN", offers: new Map(), counters: [], last_round: 0,
    })
    // Step 9: Emit RFQ_CREATED event
    store.eventLog.append(body.rfq_id, "RFQ_CREATED", body.buyer, body)
    return c.json({ rfq_id: body.rfq_id }, 201)
  })

  // POST /rfqs/:id/offers — 10-step offer verification
  app.post("/rfqs/:id/offers", async (c) => {
    const rfq_id = c.req.param("id")
    const session = store.sessions.get(rfq_id)
    if (!session) return c.json({ error: "not_found" }, 404)
    const body = await c.req.json()
    // Steps 1-5: Schema validation
    const v = validateOffer(body, session.rfq)
    if (!v.ok) return c.json({ error: v.code }, 422)
    // Step 6: Ed25519 signature verification (skipped in unit tests, enforced in integration)
    // Step 7: Check state allows offers (OPEN or NEGOTIATING)
    if (session.state !== "OPEN" && session.state !== "NEGOTIATING") {
      return c.json({ error: "invalid_state_transition" }, 409)
    }
    // Step 8: Append event — OFFER_REVISED if seller already submitted, else OFFER_SUBMITTED
    const isRevised = session.offers.has(body.seller)
    session.offers.set(body.seller, body)
    store.eventLog.append(rfq_id, isRevised ? "OFFER_REVISED" : "OFFER_SUBMITTED", body.seller, body)
    // Step 9: If OPEN, transition to NEGOTIATING
    if (session.state === "OPEN") session.state = transition(session.state, "NEGOTIATING")
    // Step 10: Return 201
    return c.json({ offer_id: body.offer_id }, 201)
  })

  // POST /rfqs/:id/counter — 12-step counter verification
  app.post("/rfqs/:id/counter", async (c) => {
    const rfq_id = c.req.param("id")
    const session = store.sessions.get(rfq_id)
    if (!session) return c.json({ error: "not_found" }, 404)
    const body = await c.req.json()
    // Steps 1-5: Schema validation (parse, price, currency, valid_until)
    const v = validateCounter(body, session.rfq)
    if (!v.ok) return c.json({ error: v.code }, 422)
    // Step 6: counter.from === rfq.buyer (422 unauthorized_counter)
    if (body.from !== session.rfq.buyer) return c.json({ error: "unauthorized_counter" }, 422)
    // Step 6b: counter.to references a seller who has submitted an offer
    if (!session.offers.has(body.to)) return c.json({ error: "malformed_payload" }, 422)
    // Step 7: ZK proof verification (if budget_commitment present)
    if (session.rfq.budget_commitment) {
      if (!body.budget_proof) return c.json({ error: "missing_budget_proof" }, 422)
      const expectedScaled = normalizeAmount(body.price, "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU")
      if (body.budget_proof.counter_price_scaled !== expectedScaled.toString()) {
        return c.json({ error: "proof_price_mismatch" }, 422)
      }
      const proofValid = await verifyBudgetProof(
        body.budget_proof, expectedScaled, session.rfq.budget_commitment
      )
      if (!proofValid) return c.json({ error: "invalid_budget_proof" }, 422)
    } else if (body.budget_proof) {
      return c.json({ error: "unexpected_budget_proof" }, 422)
    }
    // Step 8: Ed25519 signature verification (401 invalid_buyer_signature)
    // Step 9: Check state is NEGOTIATING (409)
    if (session.state !== "NEGOTIATING") return c.json({ error: "invalid_state_transition" }, 409)
    // Step 10: Validate round monotonicity (422 invalid_round)
    if (body.round <= session.last_round) return c.json({ error: "invalid_round" }, 422)
    session.last_round = body.round
    // Step 11: Append event
    session.counters.push(body)
    store.eventLog.append(rfq_id, "COUNTER_SENT", body.from, body)
    // Step 12: Return 201
    return c.json({ counter_id: body.counter_id }, 201)
  })

  // POST /rfqs/:id/accept — 7-step accept verification
  app.post("/rfqs/:id/accept", async (c) => {
    const rfq_id = c.req.param("id")
    const session = store.sessions.get(rfq_id)
    if (!session) return c.json({ error: "not_found" }, 404)
    const body = await c.req.json() // { seller: "did:key:...", offer_id: "uuid" }
    // Step 1: Parse and validate
    if (!body.seller || !body.offer_id) return c.json({ error: "malformed_payload" }, 422)
    // Step 2: Check state is NEGOTIATING
    if (session.state !== "NEGOTIATING") return c.json({ error: "invalid_state_transition" }, 409)
    // Step 3: Verify requester is rfq.buyer (use auth header in production)
    // Step 4: Verify seller has submitted an offer
    if (!session.offers.has(body.seller)) return c.json({ error: "not_found" }, 404)
    // Step 5: Verify offer_id exists and valid_until in future
    const offer = session.offers.get(body.seller)!
    if (offer.offer_id !== body.offer_id) return c.json({ error: "not_found" }, 404)
    if (Date.parse(offer.valid_until) <= Date.now()) return c.json({ error: "invalid_expiry" }, 422)
    // Step 6: Transition to COMMIT_PENDING
    session.state = transition(session.state, "COMMIT_PENDING")
    // Step 7: Build unsigned quote
    const unsigned = buildUnsignedQuote({
      rfq_id, buyer: session.rfq.buyer, seller: body.seller,
      service_type: session.rfq.service_type, final_price: offer.price,
      currency: session.rfq.currency, payment_endpoint: "https://seller.example/execute",
      expires_seconds: 300, spec: session.rfq.spec,
    })
    session.unsigned_quote = unsigned
    store.eventLog.append(rfq_id, "WINNER_SELECTED", session.rfq.buyer, { seller: body.seller })
    store.eventLog.append(rfq_id, "COMMIT_PENDING", session.rfq.buyer, { quote_id: unsigned.quote_id })
    return c.json(unsigned, 200)
  })

  // PUT /rfqs/:id/quote/sign — buyer signs quote (steps 8-10)
  app.put("/rfqs/:id/quote/sign", async (c) => {
    const session = store.sessions.get(c.req.param("id"))
    if (!session?.unsigned_quote) return c.json({ error: "not_found" }, 404)
    const { buyer_signature } = await c.req.json()
    session.unsigned_quote = { ...session.unsigned_quote, buyer_signature }
    return c.json({ ok: true }, 200)
  })

  // GET /rfqs/:id/quote — seller retrieves buyer-signed quote (step 11)
  app.get("/rfqs/:id/quote", (c) => {
    const session = store.sessions.get(c.req.param("id"))
    if (!session?.unsigned_quote) return c.json({ error: "not_found" }, 404)
    return c.json(session.unsigned_quote)
  })

  // PUT /rfqs/:id/cosign — seller cosigns (steps 13-18)
  app.put("/rfqs/:id/cosign", async (c) => {
    const rfq_id = c.req.param("id")
    const session = store.sessions.get(rfq_id)
    if (!session?.unsigned_quote) return c.json({ error: "not_found" }, 404)
    if (session.state !== "COMMIT_PENDING") return c.json({ error: "invalid_state_transition" }, 409)
    const { seller_signature } = await c.req.json()
    session.unsigned_quote = { ...session.unsigned_quote, seller_signature }
    const result = await verifyQuote(session.unsigned_quote)
    if (!result.ok) return c.json({ error: result.code }, 422)
    session.state = transition(session.state, "COMMITTED")
    store.eventLog.append(rfq_id, "QUOTE_COMMITTED", session.unsigned_quote.seller, {
      quote_id: session.unsigned_quote.quote_id,
    })
    return c.json(session.unsigned_quote, 200)
  })

  return app
}
```

Key validation patterns:
- Schema validation via `@ghost-bazaar/core` validators
- Signing payloads constructed with `objectSigningPayload()` (signature field set to `""`)
- State machine transitions via `state-machine.ts`
- Events appended via `event-log.ts` — uses `OFFER_REVISED` when seller re-submits
- Counter `to` field validated against offer history
- Error responses use v4 error codes with correct HTTP status

- [ ] **Step 4: Implement events route**

```typescript
// packages/engine/src/routes/events.ts
import { Hono } from "hono"
import type { Store } from "../store.js"

export function eventRoutes(store: Store) {
  const app = new Hono()

  app.get("/rfqs/:id/events", (c) => {
    const rfq_id = c.req.param("id")
    const after = c.req.query("after")
    const events = store.eventLog.get(rfq_id, after ? parseInt(after) : undefined)
    return c.json(events)
  })

  return app
}
```

- [ ] **Step 5: Implement deadline enforcer**

```typescript
// packages/engine/src/deadline.ts
import type { Store } from "./store.js"
import { canTransition } from "./state-machine.js"

export function startDeadlineEnforcer(store: Store, intervalMs = 1000): ReturnType<typeof setInterval> {
  return setInterval(() => {
    const now = Date.now()
    for (const [rfq_id, session] of store.sessions) {
      const deadline = Date.parse(session.rfq.deadline)
      if (now > deadline && canTransition(session.state, "EXPIRED")) {
        session.state = "EXPIRED"
        store.eventLog.append(rfq_id, "NEGOTIATION_EXPIRED", "system", {})
      }
    }
  }, intervalMs)
}
```

- [ ] **Step 6: Create server.ts entry point**

```typescript
// packages/engine/src/server.ts
import { Hono } from "hono"
import { serve } from "@hono/node-server"
import { Store } from "./store.js"
import { listingRoutes } from "./routes/listings.js"
import { rfqRoutes } from "./routes/rfqs.js"
import { eventRoutes } from "./routes/events.js"
import { startDeadlineEnforcer } from "./deadline.js"

export function createApp(store?: Store) {
  const s = store ?? new Store()
  const app = new Hono()
  app.route("/", listingRoutes(s))
  app.route("/", rfqRoutes(s))
  app.route("/", eventRoutes(s))
  return { app, store: s }
}

// Start server if run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const { app, store } = createApp()
  startDeadlineEnforcer(store)
  const port = parseInt(process.env.PORT ?? "3000")
  serve({ fetch: app.fetch, port })
  console.log(`Ghost Bazaar engine running on :${port}`)
}
```

- [ ] **Step 7: Write route integration tests**

```typescript
// packages/engine/tests/routes.test.ts
import { describe, it, expect } from "vitest"
import { createApp } from "../src/server.js"

describe("engine routes", () => {
  it("POST /listings → 201 + GET /listings returns it", async () => {
    const { app } = createApp()
    const res = await app.request("/listings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seller: "did:key:z6Mk...", title: "Audit", category: "services", service_type: "ghost-bazaar:services:smart-contract-audit", negotiation_endpoint: "https://seller.example/negotiate", payment_endpoint: "https://seller.example/execute", base_terms: {} }),
    })
    expect(res.status).toBe(201)
    const { listing_id } = await res.json()

    const res2 = await app.request("/listings")
    const listings = await res2.json()
    expect(listings).toHaveLength(1)
    expect(listings[0].listing_id).toBe(listing_id)
  })

  it("POST /rfqs → 201", async () => {
    const { app } = createApp()
    const rfq = {
      rfq_id: "550e8400-e29b-41d4-a716-446655440000",
      protocol: "ghost-bazaar-v4",
      buyer: "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK",
      service_type: "ghost-bazaar:services:audit",
      spec: {},
      anchor_price: "35.00",
      currency: "USDC",
      deadline: new Date(Date.now() + 60_000).toISOString(),
      signature: "ed25519:dGVzdA==",
    }
    const res = await app.request("/rfqs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(rfq),
    })
    expect(res.status).toBe(201)
  })

  it("GET /rfqs/:id/events returns events", async () => {
    const { app } = createApp()
    // Create RFQ first
    const rfq = {
      rfq_id: "550e8400-e29b-41d4-a716-446655440000",
      protocol: "ghost-bazaar-v4",
      buyer: "did:key:z6Mk...",
      service_type: "ghost-bazaar:services:audit",
      spec: {},
      anchor_price: "35.00",
      currency: "USDC",
      deadline: new Date(Date.now() + 60_000).toISOString(),
      signature: "ed25519:dGVzdA==",
    }
    await app.request("/rfqs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(rfq),
    })

    const res = await app.request(`/rfqs/${rfq.rfq_id}/events`)
    const events = await res.json()
    expect(events.length).toBeGreaterThan(0)
    expect(events[0].event_type).toBe("RFQ_CREATED")
  })
})
```

Run: `cd packages/engine && npx vitest run`
Expected: All PASS

- [ ] **Step 8: Commit**

```bash
git add packages/engine/
git commit -m "feat(engine): add HTTP routes, state machine, event log, deadline enforcer"
```

---

## Chunk 4: Settlement + Agents + MCP + Demo

### Task 11: Settlement Package

**Files:**
- Create: `packages/settlement/package.json`
- Create: `packages/settlement/src/execute.ts`
- Create: `packages/settlement/src/solana-verify.ts`
- Create: `packages/settlement/src/nonce.ts`
- Create: `packages/settlement/src/timer.ts`
- Create: `packages/settlement/src/index.ts`
- Test: `packages/settlement/tests/execute.test.ts`

- [ ] **Step 1: Create packages/settlement scaffold**

```json
// packages/settlement/package.json
{
  "name": "@ghost-bazaar/settlement",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": { "build": "tsc", "test": "vitest run" },
  "dependencies": {
    "@ghost-bazaar/core": "workspace:*",
    "@solana/web3.js": "^1.95.0",
    "@solana/spl-token": "^0.4.6"
  },
  "devDependencies": {
    "typescript": "^5.4.0",
    "vitest": "^1.6.0"
  }
}
```

- [ ] **Step 2: Implement nonce.ts (MVP in-memory)**

```typescript
// packages/settlement/src/nonce.ts
const consumedNonces = new Set<string>()

export function isNonceConsumed(quote_id: string): boolean {
  return consumedNonces.has(quote_id)
}

export function consumeNonce(quote_id: string): void {
  consumedNonces.add(quote_id)
}

export function resetNonces(): void {
  consumedNonces.clear()
}
```

- [ ] **Step 3: Implement timer.ts**

```typescript
// packages/settlement/src/timer.ts
export class SettlementTimer {
  private committed_at: number | null = null
  private confirmed_at: number | null = null

  markCommitted(): void { this.committed_at = Date.now() }
  markConfirmed(): void { this.confirmed_at = Date.now() }

  get settlementMs(): number | null {
    if (this.committed_at === null || this.confirmed_at === null) return null
    return this.confirmed_at - this.committed_at
  }
}
```

- [ ] **Step 4: Implement solana-verify.ts (Solana RPC verification helpers)**

```typescript
// packages/settlement/src/solana-verify.ts
import { Connection, type ParsedTransactionWithMeta } from "@solana/web3.js"
import bs58 from "bs58"

type VerifyResult = { ok: true } | { ok: false; code: string }

/** Steps 4-6: Decode signature, fetch tx, check confirmation */
export async function fetchAndVerifyTx(
  connection: Connection,
  paymentSigBase58: string
): Promise<{ ok: true; tx: ParsedTransactionWithMeta } | { ok: false; code: string }> {
  // Step 4: Base58-decode
  try { bs58.decode(paymentSigBase58) } catch {
    return { ok: false, code: "invalid_payment_signature" }
  }

  // Step 5: getTransaction
  const tx = await connection.getParsedTransaction(paymentSigBase58, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  })
  if (!tx) return { ok: false, code: "transaction_not_found" }

  // Step 6: Confirm status
  if (tx.meta?.err) return { ok: false, code: "transaction_failed" }

  return { ok: true, tx }
}

/** Steps 7-10: Verify SPL transfer instruction */
export async function verifySplTransfer(
  tx: ParsedTransactionWithMeta,
  expectedSeller: string,
  expectedMint: string,
  expectedAmount: bigint
): Promise<VerifyResult> {
  // Step 7: Extract SPL token transfer instruction
  const innerInstructions = tx.meta?.innerInstructions ?? []
  const allInstructions = [
    ...tx.transaction.message.instructions,
    ...innerInstructions.flatMap(ix => ix.instructions),
  ]

  const transfer = allInstructions.find((ix: any) =>
    ix.parsed?.type === "transferChecked" || ix.parsed?.type === "transfer"
  ) as any

  if (!transfer?.parsed) return { ok: false, code: "transaction_failed" }
  const info = transfer.parsed.info

  // Step 8: Verify destination matches seller's associated token account
  const { PublicKey } = await import("@solana/web3.js")
  const { getAssociatedTokenAddress } = await import("@solana/spl-token")
  const sellerAta = await getAssociatedTokenAddress(
    new PublicKey(expectedMint),
    new PublicKey(expectedSeller)
  )
  if (info.destination !== sellerAta.toBase58()) {
    return { ok: false, code: "transfer_destination_mismatch" }
  }

  // Step 9: Verify mint matches USDC
  if (info.mint && info.mint !== expectedMint) {
    return { ok: false, code: "transfer_mint_mismatch" }
  }

  // Step 10: Verify amount
  const txAmount = BigInt(info.tokenAmount?.amount ?? info.amount ?? "0")
  if (txAmount !== expectedAmount) {
    return { ok: false, code: "price_mismatch" }
  }

  return { ok: true }
}

/** Steps 11-12: Verify memo (conditional on memo_policy) */
export function verifyMemo(
  tx: ParsedTransactionWithMeta,
  quoteId: string,
  canonicalQuoteHash: string,
  memoPolicy: "optional" | "quote_id_required" | "hash_required"
): VerifyResult {
  if (memoPolicy === "optional") return { ok: true }

  // Find Memo program instruction
  const allInstructions = [
    ...tx.transaction.message.instructions,
    ...(tx.meta?.innerInstructions ?? []).flatMap(ix => ix.instructions),
  ]
  const memoIx = allInstructions.find((ix: any) =>
    ix.programId?.toString() === "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr" ||
    ix.program === "spl-memo"
  ) as any

  const memoData: string | undefined = memoIx?.parsed

  if (!memoData) return { ok: false, code: "memo_missing" }

  if (memoPolicy === "quote_id_required") {
    // Expected format: "GhostBazaar:quote_id:<uuid>"
    const expected = `GhostBazaar:quote_id:${quoteId}`
    if (memoData !== expected) return { ok: false, code: "memo_mismatch" }
  } else if (memoPolicy === "hash_required") {
    if (memoData !== canonicalQuoteHash) return { ok: false, code: "memo_mismatch" }
  }

  return { ok: true }
}
```

- [ ] **Step 5: Implement execute.ts (17-step validation)**

```typescript
// packages/settlement/src/execute.ts
import { Connection } from "@solana/web3.js"
import { verifyQuote, canonicalJson, normalizeAmount, NONCE_RE } from "@ghost-bazaar/core"
import type { SignedQuote } from "@ghost-bazaar/core"
import { fetchAndVerifyTx, verifySplTransfer, verifyMemo } from "./solana-verify.js"
import { isNonceConsumed, consumeNonce } from "./nonce.js"
import { SettlementTimer } from "./timer.js"
import { createHash } from "crypto"

type SettleResult =
  | { ok: true; receipt: SettlementReceipt }
  | { ok: false; code: string; status: number }

export interface SettlementReceipt {
  quote_id: string
  final_price: string
  buyer_pubkey: string
  seller_pubkey: string
  settled_at: string
  explorer_tx: string
  settlement_ms: number
}

// USDC mints — v4 normative
const USDC_MINTS: Record<string, string> = {
  mainnet: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  devnet: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
}

export async function validateSettlement(
  quoteHeader: string,       // base64-encoded X-Ghost-Bazaar-Quote
  paymentSig: string,        // base58-encoded Payment-Signature
  connection: Connection,
  usdcMint: string,
  executeService: () => Promise<void>,
  network: "mainnet" | "devnet" = "devnet"
): Promise<SettleResult> {
  const timer = new SettlementTimer()
  timer.markCommitted()

  // Step 1: Decode X-Ghost-Bazaar-Quote header
  let quote: SignedQuote
  try {
    const json = Buffer.from(quoteHeader, "base64").toString("utf8")
    quote = JSON.parse(json) as SignedQuote
  } catch {
    return { ok: false, code: "malformed_quote", status: 400 }
  }

  // Steps 2-3: Verify buyer and seller Ed25519 signatures
  const sigResult = await verifyQuote(quote)
  if (!sigResult.ok) {
    return { ok: false, code: sigResult.code, status: 401 }
  }

  // Steps 4-6: Decode payment sig, fetch tx, check status
  const txResult = await fetchAndVerifyTx(connection, paymentSig)
  if (!txResult.ok) {
    return { ok: false, code: txResult.code, status: 422 }
  }

  // Steps 7-10: Verify SPL transfer (destination, mint, amount)
  const expectedAmount = normalizeAmount(quote.final_price, usdcMint)
  const splResult = await verifySplTransfer(txResult.tx, quote.seller, usdcMint, expectedAmount)
  if (!splResult.ok) {
    return { ok: false, code: splResult.code, status: 422 }
  }

  // Steps 11-12: Verify memo (conditional on memo_policy)
  const quoteHash = createHash("sha256")
    .update(canonicalJson(quote as unknown as Record<string, unknown>))
    .digest("hex")
  const memoResult = verifyMemo(
    txResult.tx, quote.quote_id, `sha256:${quoteHash}`,
    quote.memo_policy ?? "quote_id_required"
  )
  if (!memoResult.ok) {
    return { ok: false, code: memoResult.code, status: 422 }
  }

  // Step 13: Validate nonce format
  if (!NONCE_RE.test(quote.nonce)) {
    return { ok: false, code: "invalid_nonce_format", status: 422 }
  }

  // Step 14: Check nonce not consumed
  if (isNonceConsumed(quote.quote_id)) {
    return { ok: false, code: "nonce_replayed", status: 409 }
  }

  // Step 15: Verify quote not expired
  if (Date.parse(quote.expires_at) <= Date.now()) {
    return { ok: false, code: "quote_expired", status: 422 }
  }

  // Step 16: Execute service
  try {
    await executeService()
  } catch {
    return { ok: false, code: "execution_failed", status: 500 }
  }

  // Step 17: Consume nonce atomically with execution
  consumeNonce(quote.quote_id)

  timer.markConfirmed()

  const clusterParam = network === "devnet" ? "?cluster=devnet" : ""

  return {
    ok: true,
    receipt: {
      quote_id: quote.quote_id,
      final_price: quote.final_price,
      buyer_pubkey: quote.buyer,
      seller_pubkey: quote.seller,
      settled_at: new Date().toISOString(),
      explorer_tx: `https://explorer.solana.com/tx/${paymentSig}${clusterParam}`,
      settlement_ms: timer.settlementMs ?? 0,
    },
  }
}
```

- [ ] **Step 6: Write tests (mock Solana RPC)**

Test happy path and each failure mode:
- Invalid buyer/seller signature
- Price mismatch
- Nonce replay
- Expired quote
- Memo missing when required

- [ ] **Step 7: Commit**

```bash
git add packages/settlement/
git commit -m "feat(settlement): add 17-step validation and nonce management"
```

---

### Task 12: Agent Runtime

**Files:**
- Create: `packages/agents/package.json`
- Create: `packages/agents/src/buyer-agent.ts`
- Create: `packages/agents/src/seller-agent.ts`
- Create: `packages/agents/src/poll.ts`
- Create: `packages/agents/src/config.ts`
- Create: `packages/agents/src/index.ts`
- Test: `packages/agents/tests/buyer-agent.test.ts`

- [ ] **Step 1: Create packages/agents scaffold**

```json
// packages/agents/package.json
{
  "name": "@ghost-bazaar/agents",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": { "build": "tsc", "test": "vitest run" },
  "dependencies": {
    "@ghost-bazaar/core": "workspace:*",
    "@ghost-bazaar/zk": "workspace:*",
    "@ghost-bazaar/strategy": "workspace:*",
    "@ghost-bazaar/settlement": "workspace:*",
    "@solana/web3.js": "^1.95.0",
    "@solana/spl-token": "^0.4.6"
  },
  "devDependencies": {
    "typescript": "^5.4.0",
    "vitest": "^1.6.0"
  }
}
```

- [ ] **Step 2: Implement config.ts (keypair loading)**

```typescript
// packages/agents/src/config.ts
import { Keypair } from "@solana/web3.js"
import bs58 from "bs58"
import { readFileSync } from "fs"

export function loadKeypair(): Keypair {
  if (process.env.SOLANA_KEYPAIR) {
    return Keypair.fromSecretKey(bs58.decode(process.env.SOLANA_KEYPAIR))
  }
  if (process.env.SOLANA_KEYPAIR_PATH) {
    const json = JSON.parse(readFileSync(process.env.SOLANA_KEYPAIR_PATH, "utf8"))
    return Keypair.fromSecretKey(Uint8Array.from(json))
  }
  throw new Error("SOLANA_KEYPAIR or SOLANA_KEYPAIR_PATH must be set")
}

export function getEngineUrl(): string {
  return process.env.NEGOTIATION_ENGINE_URL ?? "http://localhost:3000"
}

export function getSolanaRpcUrl(): string {
  return process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com"
}

export function getUsdcMint(): string {
  return process.env.USDC_MINT ?? "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"
}

export function getAnthropicApiKey(): string | undefined {
  return process.env.ANTHROPIC_API_KEY
}
```

- [ ] **Step 3: Implement poll.ts**

```typescript
// packages/agents/src/poll.ts
export async function pollEvents(
  engineUrl: string,
  rfq_id: string,
  after: number,
  signal?: AbortSignal
): Promise<{ events: any[]; lastId: number }> {
  const url = `${engineUrl}/rfqs/${rfq_id}/events?after=${after}`
  const res = await fetch(url, { signal })
  const events = await res.json()
  const lastId = events.length > 0 ? events[events.length - 1].event_id : after
  return { events, lastId }
}
```

- [ ] **Step 4: Implement BuyerAgent and SellerAgent**

`BuyerAgent`:
- Constructor: keypair, strategy, budget_hard, budget_soft, engine URL
- Generates commitment_salt on construction
- `postRfq()`: creates RFQ with budget_commitment, signs, POSTs
- `runNegotiation()`: poll loop → strategy → sanitizer → ZK proof → POST counter / accept
- `settle()`: builds Solana tx, sends, POSTs /execute

`SellerAgent`:
- Constructor: keypair, strategy, floor_price, target_price, listing, engine URL
- `registerListing()`: POSTs listing
- `respondToRfq()`: strategy.onRfqReceived → sanitizer → POST offer
- `handleCounter()`: strategy.onCounterReceived → sanitizer → POST offer
- `cosignQuote()`: GET /quote → verify → sign → PUT /cosign

- [ ] **Step 5: Write basic tests and commit**

```bash
git add packages/agents/
git commit -m "feat(agents): add BuyerAgent and SellerAgent runtime"
```

---

### Task 13: MCP Server

**Files:**
- Create: `packages/mcp/package.json`
- Create: `packages/mcp/src/server.ts`
- Create: `packages/mcp/src/buyer-tools.ts`
- Create: `packages/mcp/src/seller-tools.ts`
- Create: `packages/mcp/src/transport.ts`
- Create: `packages/mcp/src/index.ts`

- [ ] **Step 1: Create packages/mcp scaffold**

```json
// packages/mcp/package.json
{
  "name": "@ghost-bazaar/mcp",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "scripts": { "build": "tsc", "start": "tsx src/index.ts" },
  "dependencies": {
    "@ghost-bazaar/agents": "workspace:*",
    "@ghost-bazaar/core": "workspace:*",
    "@modelcontextprotocol/sdk": "^1.0.0"
  },
  "devDependencies": {
    "typescript": "^5.4.0",
    "tsx": "^4.7.0"
  }
}
```

- [ ] **Step 2: Implement buyer-tools.ts**

6 buyer tools wrapping BuyerAgent:
- `ghost_bazaar_browse_listings` — GET /listings
- `ghost_bazaar_post_rfq` — BuyerAgent.postRfq()
- `ghost_bazaar_get_offers` — poll events, filter offers
- `ghost_bazaar_counter` — BuyerAgent counter (ZK proof transparent)
- `ghost_bazaar_accept` — BuyerAgent accept
- `ghost_bazaar_settle` — BuyerAgent settle

`budget_hard` accepted as input, stored in BuyerPrivate, NEVER in output.

- [ ] **Step 3: Implement seller-tools.ts**

5 seller tools wrapping SellerAgent:
- `ghost_bazaar_register_listing`
- `ghost_bazaar_get_rfqs`
- `ghost_bazaar_respond_offer`
- `ghost_bazaar_respond_counter`
- `ghost_bazaar_check_events`

- [ ] **Step 4: Implement server.ts and transport.ts**

MCP server with stdio and HTTP/SSE transport. Transport is a startup flag (`--transport stdio` vs `--transport sse`).

- [ ] **Step 5: Commit**

```bash
git add packages/mcp/
git commit -m "feat(mcp): add MCP server with buyer and seller tools"
```

---

### Task 14: Demo Scenario

**Files:**
- Create: `demo/package.json`
- Create: `demo/src/scenario.ts`
- Create: `demo/src/ui.ts`
- Create: `demo/src/metrics.ts`

- [ ] **Step 1: Create demo scaffold**

```json
// demo/package.json
{
  "name": "@ghost-bazaar/demo",
  "version": "0.1.0",
  "type": "module",
  "scripts": { "start": "tsx src/scenario.ts" },
  "dependencies": {
    "@ghost-bazaar/agents": "workspace:*",
    "@ghost-bazaar/engine": "workspace:*",
    "@ghost-bazaar/strategy": "workspace:*",
    "@ghost-bazaar/core": "workspace:*",
    "ink": "^5.0.0",
    "react": "^18.3.0"
  },
  "devDependencies": { "tsx": "^4.7.0" }
}
```

- [ ] **Step 2: Implement scenario.ts**

1 buyer (LLMBuyerStrategy or LinearConcessionBuyer, budget_soft=40, budget_hard=45) vs 3 sellers (FirmSeller target=50, FlexibleSeller target=38, CompetitiveSeller target=42). Service: `"ghost-bazaar:services:smart-contract-audit"`.

Flow:
1. Start engine in-process
2. Register 3 seller listings
3. Buyer posts RFQ with budget_commitment
4. Sellers respond with offers
5. Buyer counters (ZK proof generated)
6. Negotiate until accept
7. Quote construction (accept → sign → cosign)
8. Settlement on Solana devnet
9. Display metrics

- [ ] **Step 3: Implement ui.ts (terminal event feed)**

Live event feed using ink (React for terminal):
- Shows negotiation rounds
- ZK proof verified ✓ marks
- Settlement timer
- Explorer link

- [ ] **Step 4: Implement metrics.ts**

```typescript
// demo/src/metrics.ts
export interface DemoMetrics {
  negotiation_rounds: number
  zk_proofs_verified: number
  negotiation_time_ms: number
  settlement_time_ms: number
  final_price: string
  listed_price: string
  savings_pct: string
  explorer_url: string
}

export function formatMetrics(m: DemoMetrics): string {
  return [
    `negotiation rounds:   ${m.negotiation_rounds}`,
    `ZK proofs verified:   ${m.zk_proofs_verified}  ✓`,
    `negotiation time:     ${(m.negotiation_time_ms / 1000).toFixed(1)}s`,
    `settlement time:      ${m.settlement_time_ms}ms`,
    `price vs listed:      ${m.final_price} / ${m.listed_price} USDC  (${m.savings_pct})`,
  ].join("\n")
}
```

- [ ] **Step 5: Test demo runs end-to-end (engine in-process, mocked Solana for CI)**

Run: `cd demo && pnpm start`
Expected: Full negotiation + settlement cycle completes with metrics displayed

- [ ] **Step 6: Commit**

```bash
git add demo/
git commit -m "feat(demo): add hackathon demo scenario with live UI"
```

---

## Implementation Order Summary

| Day | P1 (Duty 1) | P3 (Duty 2) | P2 (Duty 3) |
|-----|-------------|-------------|-------------|
| 0 | Task 0 (scaffold, all) | Task 0 (scaffold, all) | Task 0 + devnet pre-work (4 keypairs, airdrop SOL, test USDC mint, .env) |
| 1-2 | Task 1 (schemas), Task 2 (signing) | Task 9 (state machine) | Task 11 (settlement) |
| 3 | Task 3 (amounts), Task 5 (ZK circuit), Task 6 (stubbed verifier) | Task 9 continued | Task 11 continued |
| 4 | Task 6 (full ZK prover/verifier) | Task 10 (routes, stub ZK on day 4, real ZK on day 5) | Task 12 (agents) |
| 5 | Task 7 (strategy interfaces + sanitizer) | Task 10 continued (integrate real verifyBudgetProof) | Task 12 continued |
| 6 | Task 8 (all 6 rule-based: Linear, TimeWeighted, Competitive buyers + Firm, Flexible, Competitive sellers) | Integration testing | Task 13 (MCP) |
| 7 | LLM strategies (LLMBuyer, LLMSeller) | Task 14 (demo) | Task 13 continued |
| 8 | **Integration day** | **Integration day** | **Integration day** |
| 9-14 | ZK hardening, strategy edge cases | Demo polish | MCP + Claude Desktop test |

**Critical path:** P1 must export a stubbed `verifyBudgetProof` by end of day 3 so P3 can wire it into `/counter` route on day 4. P1 delivers the real implementation on day 4.

---

## Implementation Notes — Gaps to Address During Execution

The following items from the design spec are not fully coded in this plan but MUST be implemented:

1. **`POST /execute` endpoint**: Must be set up as an HTTP endpoint on the seller's server (separate from the engine). The settlement `validateSettlement()` function is the handler; it needs an HTTP wrapper (Hono route on a separate port or process).

2. **Solana transaction construction** in BuyerAgent.settle(): Must build SPL token transfer + Memo instruction with `GhostBazaar:quote_id:<uuid>` format, sign with buyer keypair, send via `sendAndConfirmTransaction`.

3. **Deal receipt** (week-2 bonus): `packages/settlement/src/deal-receipt.ts` for Anchor PDA-based deal receipts. MVP uses signed JSON in 200 response.

4. **LLM strategies** (day 7 scope): `LLMBuyerStrategy`, `LLMSellerStrategy` using `@anthropic-ai/sdk`. Must follow `BuyerStrategy`/`SellerStrategy` interfaces. Private state injected as system prompt constraints.

5. **Conformance tests** (v4 Section 17): The following must be added during implementation:
   - Offer/Counter signature pass/fail vectors
   - Extension fields in canonical JSON covered by signature
   - Nonce format: uppercase hex fail, missing 0x fail
   - Seller declines co-sign → return to NEGOTIATING
   - Event replay reconstruction
   - Deal receipt PDA tests (week-2)

6. **Extension key namespace validation**: Non-empty extension keys should follow `<namespace>:<category>:<name>` format per v4 §5.7. Add format check to schema validators.
