/**
 * Zero-dependency BIP-340 Schnorr (secp256k1), NIP-01 event serialization/id,
 * and NIP-13 proof-of-work verification for the No1d Swap host updater.
 *
 * Pure Node.js ESM using BigInt secp256k1 arithmetic and `node:crypto` SHA-256.
 * No external packages.
 *
 * Notes:
 * - Intended for host-side verification of untrusted public Nostr events (and
 *   deterministic offline test fixtures). Secret keys are never logged or
 *   included in error messages.
 * - Follows BIP-340 exact specification, NIP-01 exact string escaping for
 *   canonical event IDs, and NIP-13 committed-target PoW rules.
 */

import crypto from "node:crypto";

export const SECP256K1_P =
  0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
export const SECP256K1_N =
  0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const SECP256K1_GX =
  0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n;
const SECP256K1_GY =
  0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n;
const SQRT_EXP = (SECP256K1_P + 1n) >> 2n;

const HEX64_RE = /^[0-9a-f]{64}$/;
const HEX128_RE = /^[0-9a-f]{128}$/;

export const NOSTR_KINDS = Object.freeze({
  DELETION: 5,
  OFFER: 32871,
  HEARTBEAT: 32872,
});

export const NOSTR_LIMITS = Object.freeze({
  maxContentChars: 32768,
  maxTags: 100,
  maxTagItems: 16,
  maxTagItemChars: 6144,
});

const NOTE_KEYS = Object.freeze([
  "id",
  "pubkey",
  "created_at",
  "kind",
  "tags",
  "content",
  "sig",
]);

// ---------------------------------------------------------------------------
// Modular arithmetic & secp256k1 Jacobian point operations
// ---------------------------------------------------------------------------

function mod(a, m = SECP256K1_P) {
  const r = a % m;
  return r >= 0n ? r : r + m;
}

function modPow(base, exp, m = SECP256K1_P) {
  let result = 1n;
  let b = mod(base, m);
  let e = exp;
  while (e > 0n) {
    if ((e & 1n) === 1n) result = (result * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return result;
}

function modInv(a, m = SECP256K1_P) {
  let t = 0n;
  let newT = 1n;
  let r = m;
  let newR = mod(a, m);
  if (newR === 0n) throw new Error("Modular inverse of zero does not exist.");
  while (newR !== 0n) {
    const q = r / newR;
    [t, newT] = [newT, t - q * newT];
    [r, newR] = [newR, r - q * newR];
  }
  if (r !== 1n) throw new Error("Value is not invertible modulo prime.");
  return t < 0n ? t + m : t;
}

const G_JAC = Object.freeze({ x: SECP256K1_GX, y: SECP256K1_GY, z: 1n });

function jacDouble(p) {
  if (!p || p.z === 0n || p.y === 0n) return null;
  const { x: x1, y: y1, z: z1 } = p;
  const y1Sq = (y1 * y1) % SECP256K1_P;
  const s = (4n * x1 * y1Sq) % SECP256K1_P;
  const m = (3n * x1 * x1) % SECP256K1_P;
  const x3 = mod(m * m - 2n * s);
  const y1Fourth = (y1Sq * y1Sq) % SECP256K1_P;
  const y3 = mod(m * (s - x3) - 8n * y1Fourth);
  const z3 = (2n * y1 * z1) % SECP256K1_P;
  if (z3 === 0n) return null;
  return { x: x3, y: y3, z: z3 };
}

function jacAdd(p, q) {
  if (!p || p.z === 0n) return q;
  if (!q || q.z === 0n) return p;
  const z1Sq = (p.z * p.z) % SECP256K1_P;
  const z2Sq = (q.z * q.z) % SECP256K1_P;
  const u1 = (p.x * z2Sq) % SECP256K1_P;
  const u2 = (q.x * z1Sq) % SECP256K1_P;
  const s1 = (((p.y * q.z) % SECP256K1_P) * z2Sq) % SECP256K1_P;
  const s2 = (((q.y * p.z) % SECP256K1_P) * z1Sq) % SECP256K1_P;
  const h = mod(u2 - u1);
  const r = mod(s2 - s1);
  if (h === 0n) {
    if (r === 0n) return jacDouble(p);
    return null;
  }
  const h2 = (h * h) % SECP256K1_P;
  const h3 = (h * h2) % SECP256K1_P;
  const u1h2 = (u1 * h2) % SECP256K1_P;
  const x3 = mod(r * r - h3 - 2n * u1h2);
  const y3 = mod(r * (u1h2 - x3) - s1 * h3);
  const z3 = (((p.z * q.z) % SECP256K1_P) * h) % SECP256K1_P;
  if (z3 === 0n) return null;
  return { x: x3, y: y3, z: z3 };
}

function jacMul(point, scalar) {
  let k = mod(scalar, SECP256K1_N);
  if (k === 0n || !point) return null;
  let result = null;
  let addend = point;
  while (k > 0n) {
    if ((k & 1n) === 1n) result = jacAdd(result, addend);
    addend = jacDouble(addend);
    k >>= 1n;
  }
  return result;
}

function jacToAffine(p) {
  if (!p || p.z === 0n) return null;
  if (p.z === 1n) return { x: p.x, y: p.y };
  const zInv = modInv(p.z, SECP256K1_P);
  const zInv2 = (zInv * zInv) % SECP256K1_P;
  const zInv3 = (zInv2 * zInv) % SECP256K1_P;
  return {
    x: (p.x * zInv2) % SECP256K1_P,
    y: (p.y * zInv3) % SECP256K1_P,
  };
}

/**
 * BIP-340 `lift_x(x)`: returns the point (x, y) on secp256k1 with even y,
 * or `null` if x >= p or x^3 + 7 has no square root mod p.
 */
export function liftX(x) {
  if (typeof x !== "bigint" || x < 0n || x >= SECP256K1_P) return null;
  const c = mod(modPow(x, 3n, SECP256K1_P) + 7n, SECP256K1_P);
  const y = modPow(c, SQRT_EXP, SECP256K1_P);
  if ((y * y) % SECP256K1_P !== c) return null;
  return { x, y: (y & 1n) === 0n ? y : SECP256K1_P - y };
}

// ---------------------------------------------------------------------------
// Byte helpers & BIP-340 tagged SHA-256
// ---------------------------------------------------------------------------

function toBytes(input, expectedLen, label) {
  let buf;
  if (typeof input === "string") {
    if (!/^[0-9a-fA-F]*$/.test(input) || input.length % 2 !== 0) {
      throw new Error(`${label} must be valid hex.`);
    }
    buf = Buffer.from(input, "hex");
  } else if (input instanceof Uint8Array) {
    buf = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  } else {
    throw new Error(`${label} must be hex or Uint8Array.`);
  }
  if (expectedLen !== null && buf.length !== expectedLen) {
    throw new Error(`${label} must be ${expectedLen} bytes.`);
  }
  return buf;
}

function bytesToBigInt(bytes) {
  return BigInt(`0x${Buffer.from(bytes).toString("hex")}`);
}

function bigIntToBytes32(n) {
  if (typeof n !== "bigint" || n < 0n) throw new Error("Expected non-negative BigInt.");
  const hex = n.toString(16).padStart(64, "0");
  if (hex.length > 64) throw new Error("BigInt exceeds 32 bytes.");
  return Buffer.from(hex, "hex");
}

function sha256Buf(data) {
  return crypto.createHash("sha256").update(data).digest();
}

const TAG_HASH_CACHE = new Map();

export function taggedHash(tag, ...parts) {
  let tagHash = TAG_HASH_CACHE.get(tag);
  if (!tagHash) {
    tagHash = sha256Buf(Buffer.from(tag, "utf8"));
    TAG_HASH_CACHE.set(tag, tagHash);
  }
  const h = crypto.createHash("sha256");
  h.update(tagHash);
  h.update(tagHash);
  for (const part of parts) h.update(part);
  return h.digest();
}

// ---------------------------------------------------------------------------
// BIP-340 Schnorr public key, sign, and verify
// ---------------------------------------------------------------------------

/**
 * Derives the 32-byte x-only BIP-340 public key (lowercase hex) for a secret key.
 * @param {string|Uint8Array} secretKey
 * @returns {string} 64-char lowercase hex x-only public key
 */
export function schnorrGetPublicKey(secretKey) {
  const sk = toBytes(secretKey, 32, "secretKey");
  const d = bytesToBigInt(sk);
  if (d <= 0n || d >= SECP256K1_N) {
    throw new Error("Secret key is out of valid secp256k1 scalar range.");
  }
  const P = jacToAffine(jacMul(G_JAC, d));
  if (!P) throw new Error("Invalid public key point.");
  return bigIntToBytes32(P.x).toString("hex");
}

/**
 * Produces a 64-byte BIP-340 Schnorr signature (lowercase hex) over `msg`.
 * Note: pure-JS BigInt scalar multiplication is not constant-time; intended for
 * offline test fixtures and local tooling only (the host updater only verifies).
 * @param {string|Uint8Array} msg
 * @param {string|Uint8Array} secretKey
 * @param {string|Uint8Array} [auxRand] 32 bytes (defaults to OS CSPRNG)
 * @returns {string} 128-char lowercase hex signature
 */
export function schnorrSign(msg, secretKey, auxRand = crypto.randomBytes(32)) {
  const m = toBytes(msg, null, "msg");
  const sk = toBytes(secretKey, 32, "secretKey");
  const a = toBytes(auxRand, 32, "auxRand");

  const dPrime = bytesToBigInt(sk);
  if (dPrime <= 0n || dPrime >= SECP256K1_N) {
    throw new Error("Secret key is out of valid secp256k1 scalar range.");
  }
  const P = jacToAffine(jacMul(G_JAC, dPrime));
  if (!P) throw new Error("Invalid public key point.");

  const d = (P.y & 1n) === 0n ? dPrime : SECP256K1_N - dPrime;
  const dBytes = bigIntToBytes32(d);
  const pBytes = bigIntToBytes32(P.x);

  const auxHash = taggedHash("BIP0340/aux", a);
  const t = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) t[i] = dBytes[i] ^ auxHash[i];

  const rand = taggedHash("BIP0340/nonce", t, pBytes, m);
  const kPrime = mod(bytesToBigInt(rand), SECP256K1_N);
  if (kPrime === 0n) {
    throw new Error("Nonce derivation produced zero scalar.");
  }
  const R = jacToAffine(jacMul(G_JAC, kPrime));
  if (!R) throw new Error("Invalid nonce point.");
  const k = (R.y & 1n) === 0n ? kPrime : SECP256K1_N - kPrime;
  const rBytes = bigIntToBytes32(R.x);

  const e = mod(
    bytesToBigInt(taggedHash("BIP0340/challenge", rBytes, pBytes, m)),
    SECP256K1_N,
  );
  const s = mod(k + e * d, SECP256K1_N);
  const sig = Buffer.concat([rBytes, bigIntToBytes32(s)]);

  if (!schnorrVerify(sig, m, pBytes)) {
    throw new Error("Generated BIP-340 signature failed self-verification.");
  }
  return sig.toString("hex");
}

/**
 * Verifies a 64-byte BIP-340 Schnorr signature against `msg` and 32-byte x-only `pubkey`.
 * Never throws; returns `true` only on strictly valid signatures.
 * @param {string|Uint8Array} sig
 * @param {string|Uint8Array} msg
 * @param {string|Uint8Array} pubkey
 * @returns {boolean}
 */
export function schnorrVerify(sig, msg, pubkey) {
  try {
    const sigBuf = toBytes(sig, 64, "sig");
    const msgBuf = toBytes(msg, null, "msg");
    const pkBuf = toBytes(pubkey, 32, "pubkey");

    const px = bytesToBigInt(pkBuf);
    const P = liftX(px);
    if (!P) return false;

    const rBytes = sigBuf.subarray(0, 32);
    const sBytes = sigBuf.subarray(32, 64);
    const r = bytesToBigInt(rBytes);
    const s = bytesToBigInt(sBytes);
    if (r >= SECP256K1_P || s >= SECP256K1_N) return false;

    const e = mod(
      bytesToBigInt(taggedHash("BIP0340/challenge", rBytes, pkBuf, msgBuf)),
      SECP256K1_N,
    );

    const sG = jacMul(G_JAC, s);
    const negE = mod(SECP256K1_N - e, SECP256K1_N);
    const negEP = jacMul({ x: P.x, y: P.y, z: 1n }, negE);
    const R = jacToAffine(jacAdd(sG, negEP));
    if (!R) return false;
    if ((R.y & 1n) !== 0n) return false;
    return R.x === r;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// NIP-01 Event Serialization, ID Calculation, Signing, and Verification
// ---------------------------------------------------------------------------

const NIP01_ESCAPES = Object.freeze({
  "\n": "\\n",
  '"': '\\"',
  "\\": "\\\\",
  "\r": "\\r",
  "\t": "\\t",
  "\b": "\\b",
  "\f": "\\f",
});
const NIP01_ESCAPE_RE = /[\n"\\\r\t\x08\f]/g;
const NIP01_OTHER_CONTROL_RE = /[\x00-\x07\x0b\x0e-\x1f]/;

function nip01JsonString(str) {
  return `"${str.replace(NIP01_ESCAPE_RE, (c) => NIP01_ESCAPES[c])}"`;
}

export function isHex64(value) {
  return typeof value === "string" && HEX64_RE.test(value);
}

export function isHex128(value) {
  return typeof value === "string" && HEX128_RE.test(value);
}

const isSafeIntInRange = (n, lo, hi) => Number.isSafeInteger(n) && n >= lo && n <= hi;

/**
 * Exact NIP-01 canonical serialization string whose UTF-8 SHA-256 is `ev.id`.
 */
export function serializeNostrEventForId(ev) {
  const tags =
    "[" +
    ev.tags.map((t) => "[" + t.map(nip01JsonString).join(",") + "]").join(",") +
    "]";
  return (
    "[0," +
    nip01JsonString(ev.pubkey) +
    "," +
    String(ev.created_at) +
    "," +
    String(ev.kind) +
    "," +
    tags +
    "," +
    nip01JsonString(ev.content) +
    "]"
  );
}

export function computeNostrEventId(ev) {
  return crypto
    .createHash("sha256")
    .update(serializeNostrEventForId(ev), "utf8")
    .digest("hex");
}

export function nostrEventShapeProblem(ev, { needPubkey = true, strictControlChars = false } = {}) {
  if (!ev || typeof ev !== "object" || Array.isArray(ev)) return "not an object";
  if (needPubkey && !isHex64(ev.pubkey)) return "pubkey is not 64 lowercase hex";
  if (!isSafeIntInRange(ev.created_at, 0, 2 ** 40)) {
    return "created_at is not a whole number of seconds";
  }
  if (!isSafeIntInRange(ev.kind, 0, 65535)) {
    return "kind is not an integer in 0..65535";
  }
  if (typeof ev.content !== "string") return "content is not a string";
  if (ev.content.length > NOSTR_LIMITS.maxContentChars) return "content is too long";
  if (typeof ev.content.isWellFormed === "function" && !ev.content.isWellFormed()) {
    return "content is not well-formed UTF-16";
  }
  if (!Array.isArray(ev.tags) || ev.tags.length > NOSTR_LIMITS.maxTags) {
    return "tags must be a bounded array";
  }
  for (const tag of ev.tags) {
    if (!Array.isArray(tag) || tag.length < 1 || tag.length > NOSTR_LIMITS.maxTagItems) {
      return "tag must be a bounded non-empty array";
    }
    for (const item of tag) {
      if (
        typeof item !== "string" ||
        item.length > NOSTR_LIMITS.maxTagItemChars ||
        (typeof item.isWellFormed === "function" && !item.isWellFormed())
      ) {
        return "tag item is not a bounded well-formed string";
      }
      if (strictControlChars && NIP01_OTHER_CONTROL_RE.test(item)) {
        return "tag item contains an unescaped control character";
      }
    }
  }
  if (strictControlChars && NIP01_OTHER_CONTROL_RE.test(ev.content)) {
    return "content contains an unescaped control character";
  }
  return null;
}

/**
 * Full verification of an untrusted NIP-01 event:
 * exact 7-key object, strict field shapes, recomputed canonical SHA-256 `id`,
 * and valid BIP-340 Schnorr signature over the 32-byte `id`.
 * Never throws; returns `true` or `false`.
 */
export function verifyNostrEvent(ev) {
  try {
    if (!ev || typeof ev !== "object" || Array.isArray(ev)) return false;
    if (Object.getPrototypeOf(ev) !== Object.prototype) return false;
    const keys = Object.keys(ev);
    if (keys.length !== NOTE_KEYS.length || !NOTE_KEYS.every((k) => keys.includes(k))) {
      return false;
    }
    if (nostrEventShapeProblem(ev, { needPubkey: true, strictControlChars: false })) {
      return false;
    }
    if (!isHex64(ev.id) || !isHex128(ev.sig)) return false;
    const expectedId = computeNostrEventId(ev);
    if (expectedId !== ev.id) return false;
    return schnorrVerify(ev.sig, ev.id, ev.pubkey) === true;
  } catch {
    return false;
  }
}

/**
 * Signs a NIP-01 event template with `secretKey` (used for test fixtures and CLI tools).
 */
export function finalizeNostrEvent(template, secretKey, { auxRand } = {}) {
  const pubkey = schnorrGetPublicKey(secretKey);
  if (!template || typeof template !== "object" || Array.isArray(template)) {
    throw new Error("Event template must be an object.");
  }
  for (const k of Object.keys(template)) {
    if (!["created_at", "kind", "tags", "content", "pubkey"].includes(k)) {
      throw new Error(`Unexpected template property: ${k}`);
    }
  }
  if (template.pubkey !== undefined && template.pubkey !== pubkey) {
    throw new Error("Template pubkey does not match secret key.");
  }
  const ev = {
    pubkey,
    created_at: template.created_at,
    kind: template.kind,
    tags: template.tags,
    content: template.content,
  };
  const why = nostrEventShapeProblem(ev, { needPubkey: true, strictControlChars: true });
  if (why) throw new Error(`Invalid event template: ${why}`);
  const id = computeNostrEventId(ev);
  const sig = schnorrSign(id, secretKey, auxRand);
  return {
    id,
    pubkey,
    created_at: ev.created_at,
    kind: ev.kind,
    tags: ev.tags,
    content: ev.content,
    sig,
  };
}

// ---------------------------------------------------------------------------
// Tag helpers & NIP-13 Proof-of-Work (matching desktop board/pow.js)
// ---------------------------------------------------------------------------

export function tagsNamed(ev, name) {
  if (!ev || !Array.isArray(ev.tags)) return [];
  return ev.tags.filter((t) => Array.isArray(t) && t[0] === name).map((t) => t.slice(1));
}

export function oneExactTag(ev, name) {
  const all = tagsNamed(ev, name);
  return all.length === 1 && all[0].length === 1 ? all[0][0] : null;
}

/**
 * Counts leading zero bits of a lowercase hex string.
 */
export function countLeadingZeroBits(hex) {
  if (typeof hex !== "string" || hex.length === 0) return 0;
  let count = 0;
  for (let i = 0; i < hex.length; i++) {
    const nibble = parseInt(hex[i], 16);
    if (Number.isNaN(nibble)) return 0;
    if (nibble === 0) {
      count += 4;
      continue;
    }
    count += Math.clz32(nibble) - 28;
    break;
  }
  return count;
}

export function difficultyOf(ev) {
  return ev && typeof ev.id === "string" ? countLeadingZeroBits(ev.id) : 0;
}

/**
 * Extracts the committed NIP-13 target from a single `["nonce", "<decimal>", "<target>"]` tag,
 * or `null` if missing, repeated, or malformed.
 */
export function committedPowTarget(ev) {
  const all = tagsNamed(ev, "nonce");
  if (
    all.length !== 1 ||
    all[0].length !== 2 ||
    !/^\d{1,18}$/.test(all[0][0]) ||
    !/^(0|[1-9]\d{0,2})$/.test(all[0][1])
  ) {
    return null;
  }
  const target = Number(all[0][1]);
  return target <= 256 ? target : null;
}

/**
 * Checks NIP-13 proof of work on an already-verified event:
 * requires a committed target >= `minBits` AND actual difficulty >= committed target.
 */
export function checkNip13Pow(ev, minBits) {
  const bits = difficultyOf(ev);
  const target = committedPowTarget(ev);
  if (typeof minBits !== "number" || !Number.isInteger(minBits) || minBits < 0 || minBits > 256) {
    return { ok: false, bits, target, reason: "invalid minimum PoW difficulty" };
  }
  if (minBits === 0) {
    return { ok: true, bits, target };
  }
  if (target === null) {
    return { ok: false, bits, target, reason: "missing or malformed NIP-13 nonce target" };
  }
  if (target < minBits) {
    return { ok: false, bits, target, reason: `committed target ${target} is below ${minBits}` };
  }
  if (bits < target) {
    return { ok: false, bits, target, reason: `difficulty ${bits} is below committed target ${target}` };
  }
  return { ok: true, bits, target };
}

/**
 * Mines a NIP-13 nonce tag for a template (for offline tests / CLI tooling).
 */
export function mineNip13Pow(template, pubkey, bits, { maxIterations = 2 ** 24 } = {}) {
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) {
    throw new Error("PoW difficulty bits must be an integer in 0..32.");
  }
  const baseTags = (template.tags || []).filter((t) => t[0] !== "nonce");
  if (bits === 0) {
    return { ...template, tags: [...baseTags, ["nonce", "0", "0"]] };
  }
  for (let n = 0; n < maxIterations; n++) {
    const tags = [...baseTags, ["nonce", String(n), String(bits)]];
    const id = computeNostrEventId({
      pubkey,
      created_at: template.created_at,
      kind: template.kind,
      tags,
      content: template.content,
    });
    if (countLeadingZeroBits(id) >= bits) {
      return { ...template, tags };
    }
  }
  throw new Error("No NIP-13 nonce found within iteration limit.");
}
