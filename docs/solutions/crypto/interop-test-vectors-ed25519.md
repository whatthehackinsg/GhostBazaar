---
title: Creating machine-verifiable Ed25519 interop test vectors for protocol specs
date: 2026-02-22
category: crypto
tags: [ed25519, interop, test-vectors, canonical-json, did-key, openssl, protocol-spec]
severity: medium
time_to_solve: 180
---

# Creating Machine-Verifiable Ed25519 Interop Test Vectors for Protocol Specs

## Symptom

A protocol specification (Ghost Bazaar Draft v0.1) had 26 "Implementation Note" paragraphs with ambiguous defaults. Two independent implementations could serialize the same data structure differently, produce different signing inputs, and fail signature verification against each other -- even when both followed the spec correctly.

Key ambiguities that cause interop failures:

```
- JSON serialization: key order, whitespace, number encoding
- Signing input: are signature fields omitted or present-but-empty?
- Signature encoding: raw bytes? hex? base64? with or without padding?
- DID derivation: which multicodec prefix? how many bytes? which base encoding?
- Nonce format: uppercase or lowercase hex?
```

## Root Cause

Draft protocol specs intentionally leave implementation choices open. This is correct for specification flexibility, but catastrophic for interop testing -- cryptographic signatures are binary-exact. A single byte difference in the signing input produces a completely different signature.

The root cause is not a bug but an **architectural gap**: specs define WHAT to sign but not HOW to serialize the signing input to bytes. Without a frozen serialization profile, two correct implementations will diverge.

## Solution

Create a non-normative "interop profile" that freezes every ambiguous choice and embed machine-parsable test vectors that can be reproduced with only `openssl` + `python3` stdlib.

### Step 1: Identify all serialization ambiguities

For each data structure that gets signed, enumerate every choice that affects byte output:

- JSON key ordering (alphabetical? insertion order?)
- Whitespace (pretty-printed? compact?)
- Number encoding (JSON number? string?)
- Field presence (omit null fields? include with empty value?)
- String encoding (UTF-8? ASCII?)
- Signature field in signing input (omit? present and empty?)

### Step 2: Freeze each choice with precise rules

```markdown
Canonical JSON (required):
- Object key ordering: recursively sort by Unicode codepoint order
- Whitespace: none outside strings. Separators: `,` and `:` (no spaces)
- Escaping: standard JSON escaping

Price encoding: decimal strings (e.g., "2.80"), not JSON numbers

Signing inputs: signature fields PRESENT and set to "" (empty string)

Signature encoding: `ed25519:` + base64 (RFC 4648 Section 4, with `=` padding)

Nonce format: 32 bytes, lowercase hex, `0x` prefix

did:key derivation: `did:key:z` + base58btc(0xed 0x01 + raw-32-byte-pubkey)
  - 0xed 0x01 = two raw bytes (unsigned-varint multicodec for Ed25519)
```

### Step 3: Pre-compute test vectors with openssl

Generate Ed25519 keys, sign, and capture every intermediate value:

```bash
# Generate key pair
openssl genpkey -algorithm Ed25519 -out buyer_sk.pem
openssl pkey -in buyer_sk.pem -pubout -out buyer_pk.pem

# Extract raw 32-byte public key
openssl pkey -pubin -in buyer_pk.pem -outform DER | tail -c 32 | xxd -p

# Sign the canonical JSON bytes
echo -n '{"buyer":"...","buyer_signature":"","currency":"USDC",...}' > msg.txt
openssl pkeyutl -sign -inkey buyer_sk.pem -rawin -in msg.txt -out buyer_sig.bin

# Base64-encode the signature
base64 < buyer_sig.bin

# Verify
openssl pkeyutl -verify -pubin -inkey buyer_pk.pem -rawin -in msg.txt -sigfile buyer_sig.bin
```

### Step 4: Embed as machine-parsable block

Use a structured text format with `[SECTION_NAME]` headers so verification scripts can parse it:

```text
[GHOST_BAZAAR_INTEROP_PROFILE]
profile_id=ghost-bazaar-json-ed25519-v0.1

[BUYER_SK_PEM]
-----BEGIN PRIVATE KEY-----
...
-----END PRIVATE KEY-----

[SIGNED_QUOTE_SIGN_INPUT_CANONICAL_JSON]
{"buyer":"did:key:z6Mkk...","buyer_signature":"","currency":"USDC",...}

[SIGNED_QUOTE_SIGN_INPUT_SHA256_HEX]
a6bcfca9e889cb7e39eca2a963d5488b1329315495431f020543ae9e72d3a5c9

[BUYER_SIGNATURE_BASE64]
DqPqs84mYpOmIiohiXJSFY8foFeBKEtuqSHqzfBQmLWggXLzo3wkfPCGmSZoHcM6...
```

### Step 5: Write a deterministic verification script

The script must reproduce every value from the embedded block using only stdlib tools:

1. Parse `[SECTION]` blocks from the markdown
2. Recompute SHA-256 of signing input bytes
3. Re-sign with `openssl pkeyutl` and compare base64
4. Derive `did:key` from raw public key bytes and compare
5. Recompute header base64 from final canonical JSON and compare
6. Verify canonical JSON round-trips (`json.dumps(json.loads(x), sort_keys=True, separators=(',',':'))`)
7. Assert price fields are strings, not numbers
8. Assert signature fields are empty in signing input

## What Didn't Work

1. **Vague canonicalization ("sorted keys, no whitespace")** -- Review agents flagged this as insufficient. "Sorted keys" doesn't specify recursive sorting or codepoint ordering. "No whitespace" doesn't specify separator characters. Fix: algorithmic precision with explicit separator specification.

2. **Unspecified nonce hex case** -- Initial draft said "hex encoded" without specifying case. Lowercase and uppercase hex produce different signing inputs. Fix: explicitly specify "lowercase hex".

3. **Base64 without RFC reference** -- "standard base64" is ambiguous (URL-safe? with padding?). Fix: cite "RFC 4648 Section 4" and explicitly state "with `=` padding".

4. **Multicodec prefix as "0xed01"** -- Could be interpreted as a single 2-byte big-endian value, a varint, or two separate bytes. Fix: clarify "0xed 0x01 as two raw bytes" and note it's the unsigned-varint multicodec identifier.

5. **Signing input with signature field omitted** -- Initial assumption was to omit the signature field entirely when constructing the signing input. This produces a different canonical JSON than having the field present with an empty string. Fix: freeze to "present and set to empty string `""`".

6. **Tooling constraints (no Python crypto libs, no Node)** -- Environment lacked `pynacl`, `cryptography`, or `ethers.js`. Had to use `openssl pkeyutl -rawin` for Ed25519 signing, which requires OpenSSL 3.0+. This actually improved the solution by forcing zero-dependency verification.

## Prevention

1. **Always freeze serialization before writing test vectors** -- Define the canonical form algorithmically, not descriptively. Two engineers reading the spec independently must produce identical byte sequences.

2. **Embed intermediate values in test vectors** -- Don't just provide input and expected output. Include SHA-256 of signing input, raw public key hex, and derived identifiers. This lets implementers pinpoint exactly where their implementation diverges.

3. **Use zero-dependency verification** -- Restrict to `openssl` + `python3` stdlib. This eliminates "works on my machine" issues and makes CI verification trivial.

4. **Run review agents against precision** -- Automated review agents caught three precision issues (nonce case, base64 RFC, multicodec bytes) that humans missed. Build review into the workflow.

5. **Ed25519 is deterministic** -- Unlike ECDSA, Ed25519 signatures are deterministic (same key + same message = same signature). This means test vectors can assert exact signature values, not just verify/fail. Leverage this for byte-exact verification.

6. **Separate normative spec from interop profile** -- Keep the profile non-normative so the spec remains flexible, but give coordinated teams an exact implementation target.

## References

- RFC 8032: Edwards-Curve Digital Signature Algorithm (Ed25519)
- RFC 4648 Section 4: Base64 encoding (standard alphabet with padding)
- did:key method spec: multicodec prefix 0xed01 for Ed25519 public keys
- Ghost Bazaar ENGINEERING.md: `## Interop Profile: ghost-bazaar-json-ed25519-v0.1` (lines 409-531)
- Verification plan: `.sisyphus/plans/ghost-bazaar-interop-profile-and-test-vectors.md`
- Evidence: `.sisyphus/evidence/task-3-interop-vector-verify.txt` (OK)
