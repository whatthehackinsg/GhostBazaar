import { describe, it, expect } from "vitest"
import { Hono } from "hono"
import { createApp } from "../src/app.js"
import type { EngineEnv } from "../src/app.js"
import { EngineError } from "../src/middleware/error-handler.js"
import { requireState, assertState } from "../src/middleware/require-state.js"
import {
  preCheckSignatureFormat,
  didToPublicKey,
  verifySignature,
} from "../src/middleware/validate-signature.js"
import { signEd25519, buildDid, objectSigningPayload } from "@ghost-bazaar/core"
import { Keypair } from "@solana/web3.js"
import { SessionState } from "../src/types.js"
import type { DerivedSession } from "../src/state/session.js"

// ---------------------------------------------------------------------------
// error-handler (via createApp onError)
// ---------------------------------------------------------------------------

describe("onEngineError (via createApp)", () => {
  it("catches EngineError and returns JSON with correct status + code", async () => {
    const app = createApp()
    app.get("/fail", () => {
      throw new EngineError(422, "invalid_amount", "Price cannot be zero")
    })

    const res = await app.request("/fail")
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.error).toBe("invalid_amount")
    expect(body.message).toBe("Price cannot be zero")
  })

  it("defaults to 500 for plain errors and hides raw message", async () => {
    const app = createApp()
    app.get("/boom", () => {
      throw new Error("secret internal path /var/db/state.sqlite")
    })

    const res = await app.request("/boom")
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toBe("internal_error")
    // SECURITY: raw error message must NOT leak to client
    expect(body.message).toBe("Internal server error")
    expect(body.message).not.toContain("secret")
    expect(body.message).not.toContain("/var")
  })

  it("returns JSON content-type", async () => {
    const app = createApp()
    app.get("/err", () => {
      throw new EngineError(400, "bad", "test")
    })

    const res = await app.request("/err")
    expect(res.headers.get("content-type")).toContain("application/json")
  })

  it("does not include stack trace in response body", async () => {
    const app = createApp()
    app.get("/err", () => {
      throw new EngineError(500, "boom", "oops")
    })

    const res = await app.request("/err")
    const body = await res.json()
    expect(body.stack).toBeUndefined()
    expect(Object.keys(body)).toEqual(["error", "message"])
  })

  it("handles error with custom status on plain Error", async () => {
    const app = createApp()
    app.get("/custom", () => {
      const err = new Error("custom") as Error & { status: number; code: string }
      err.status = 429
      err.code = "too_many_requests"
      throw err
    })

    const res = await app.request("/custom")
    expect(res.status).toBe(429)
    const body = await res.json()
    expect(body.error).toBe("too_many_requests")
  })
})

// ---------------------------------------------------------------------------
// assertState (standalone function for use in withLock)
// ---------------------------------------------------------------------------

describe("assertState", () => {
  it("does not throw when state matches", () => {
    expect(() =>
      assertState(SessionState.NEGOTIATING, SessionState.OPEN, SessionState.NEGOTIATING),
    ).not.toThrow()
  })

  it("throws EngineError(409) when state does not match", () => {
    expect(() =>
      assertState(SessionState.OPEN, SessionState.NEGOTIATING),
    ).toThrow(EngineError)

    try {
      assertState(SessionState.OPEN, SessionState.NEGOTIATING)
    } catch (err) {
      expect(err).toBeInstanceOf(EngineError)
      expect((err as EngineError).status).toBe(409)
      expect((err as EngineError).code).toBe("invalid_state_transition")
    }
  })
})

// ---------------------------------------------------------------------------
// preCheckSignatureFormat
// ---------------------------------------------------------------------------

describe("preCheckSignatureFormat", () => {
  const VALID_DID = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK"

  it("passes for well-formed signature + DID", () => {
    // 64 bytes = 86 base64 chars (with padding)
    const sig = "ed25519:" + Buffer.from(new Uint8Array(64)).toString("base64")
    expect(() => preCheckSignatureFormat(sig, VALID_DID)).not.toThrow()
  })

  it("rejects signature without ed25519: prefix", () => {
    expect(() =>
      preCheckSignatureFormat("rsa:AAAA", VALID_DID),
    ).toThrow(EngineError)
  })

  it("rejects signature with invalid base64 characters", () => {
    const badSig = "ed25519:!@#$%^&*()_+" + "A".repeat(74)
    expect(() => preCheckSignatureFormat(badSig, VALID_DID)).toThrow(/invalid base64/)
  })

  it("rejects signature with wrong byte count", () => {
    const shortSig = "ed25519:" + Buffer.from(new Uint8Array(32)).toString("base64")
    expect(() => preCheckSignatureFormat(shortSig, VALID_DID)).toThrow(/64 bytes/)
  })

  it("rejects malformed DID", () => {
    const sig = "ed25519:" + Buffer.from(new Uint8Array(64)).toString("base64")
    expect(() => preCheckSignatureFormat(sig, "not-a-did")).toThrow(EngineError)
  })
})

// ---------------------------------------------------------------------------
// didToPublicKey
// ---------------------------------------------------------------------------

describe("didToPublicKey", () => {
  it("extracts public key from valid did:key", () => {
    const did = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK"
    const pubkey = didToPublicKey(did)
    expect(pubkey).toBeDefined()
    expect(pubkey.toBytes()).toHaveLength(32)
  })

  it("throws for non-did:key format", () => {
    expect(() => didToPublicKey("did:web:example.com")).toThrow(EngineError)
  })

  it("throws for missing z prefix", () => {
    expect(() => didToPublicKey("did:key:abc")).toThrow(EngineError)
  })
})

// ---------------------------------------------------------------------------
// verifySignature (full Ed25519 end-to-end)
// ---------------------------------------------------------------------------

describe("verifySignature", () => {
  it("passes for correctly signed object", async () => {
    const keypair = Keypair.generate()
    const did = buildDid(keypair.publicKey)
    const obj = { foo: "bar", signature: "" }
    const payload = objectSigningPayload(obj)
    const sig = await signEd25519(payload, keypair)

    await expect(
      verifySignature({ ...obj, signature: sig }, sig, did, "invalid_sig"),
    ).resolves.toBeUndefined()
  })

  it("rejects signature from wrong signer", async () => {
    const keypair1 = Keypair.generate()
    const keypair2 = Keypair.generate()
    const did2 = buildDid(keypair2.publicKey)
    const obj = { foo: "bar", signature: "" }
    const payload = objectSigningPayload(obj)
    // Sign with keypair1 but verify against keypair2's DID
    const sig = await signEd25519(payload, keypair1)

    await expect(
      verifySignature({ ...obj, signature: sig }, sig, did2, "invalid_sig"),
    ).rejects.toThrow(EngineError)
  })

  it("rejects tampered payload", async () => {
    const keypair = Keypair.generate()
    const did = buildDid(keypair.publicKey)
    const obj = { foo: "bar", signature: "" }
    const payload = objectSigningPayload(obj)
    const sig = await signEd25519(payload, keypair)

    // Tamper with the object
    await expect(
      verifySignature({ foo: "tampered", signature: sig }, sig, did, "invalid_sig"),
    ).rejects.toThrow(EngineError)
  })
})

// ---------------------------------------------------------------------------
// requireState (Hono middleware form via app.request)
// ---------------------------------------------------------------------------

describe("requireState middleware", () => {
  function makeSessionMiddleware(state: SessionState) {
    const app = createApp() as Hono<EngineEnv>
    // Inject a fake session into context before requireState runs
    app.use("/test/*", async (c, next) => {
      c.set("session", { state } as DerivedSession)
      await next()
    })
    app.post("/test/offer", requireState(SessionState.OPEN, SessionState.NEGOTIATING), (c) => {
      return c.json({ ok: true })
    })
    return app
  }

  it("passes when session state matches", async () => {
    const app = makeSessionMiddleware(SessionState.NEGOTIATING)
    const res = await app.request("/test/offer", { method: "POST" })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
  })

  it("returns 409 when session state does not match", async () => {
    const app = makeSessionMiddleware(SessionState.COMMITTED)
    const res = await app.request("/test/offer", { method: "POST" })
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toBe("invalid_state_transition")
    // SECURITY: message must not reveal actual state
    expect(body.message).not.toContain("COMMITTED")
  })

  it("returns 404 when session is null", async () => {
    const app = createApp() as Hono<EngineEnv>
    app.use("/test/*", async (c, next) => {
      c.set("session", null as unknown as DerivedSession)
      await next()
    })
    app.post("/test/offer", requireState(SessionState.OPEN), (c) => {
      return c.json({ ok: true })
    })
    const res = await app.request("/test/offer", { method: "POST" })
    expect(res.status).toBe(404)
  })
})
