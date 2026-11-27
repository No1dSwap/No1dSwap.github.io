/**
 * No1d Swap Invitation Code (`no1dinv1:`) Codec & Validator
 *
 * Pure ES module with zero external dependencies. Runs identically in modern
 * browsers and Node.js. Implements byte-for-byte parity with the No1d Swap
 * desktop program's `no1dinv1:` invitation codec (`ui/app/lib/invitation.js`,
 * `bech32.js`, `keccak.js`, `walletrun.js`, `swapform.js`, `programsettings.js`).
 *
 * Public swap terms only: strictly rejects unknown keys, private keys, secrets,
 * oversized inputs, truncated payloads, non-canonical base64url, bad checksums,
 * invalid addresses, unsupported networks/versions, and over-cap amounts.
 */

export const KIND = "no1d-swap-invitation";
export const CODE_PREFIX = "no1dinv1:";
export const URI_SCHEME = "no1d-invite:";
export const URI_PREFIX = "no1d-invite://invite?code=";
export const MAX_BYTES = 4096;
export const MAX_CODE_CHARS = 6144;
export const CHECKSUM_BYTES = 4;
export const MAX_JSON_DEPTH = 8;

export const KEYS = Object.freeze([
  "kind",
  "v",
  "network",
  "contract",
  "contract_version",
  "noid_micronoid",
  "eth_wei",
  "bob_noid",
  "bob_eth",
]);

export const NETWORK_SPECS = Object.freeze({
  mainnet: Object.freeze({
    network: "mainnet",
    profile: "production",
    label: "Ethereum Mainnet",
    chainId: 1,
    pinnedContract: "0x4e364cC86EdBF307CC6F336F3a72e1a24d284D70",
    allowedContractVersions: Object.freeze([1]),
    maxNoidMicro: 2_500_000_000n,
    maxEthWei: 500_000_000_000_000_000n,
    maxNoid: "2500",
    maxEth: "0.5",
  }),
  sepolia: Object.freeze({
    network: "sepolia",
    profile: "sepolia",
    label: "Sepolia Testnet",
    chainId: 11155111,
    pinnedContract: "0x48Ce4D6cf3c175737532017e82B9261b51F8E5eF",
    allowedContractVersions: Object.freeze([1, 2]),
    maxNoidMicro: 20_000_000n,
    maxEthWei: 10_000_000_000_000_000n,
    maxNoid: "20",
    maxEth: "0.01",
  }),
});

const NOID_MICRO_RE = /^[1-9][0-9]{0,15}$/;
const ETH_WEI_RE = /^[1-9][0-9]{0,30}$/;
const ETH_ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const DEC_NOID_RE = /^(0|[1-9][0-9]{0,9})(\.[0-9]{1,6})?$/;
const DEC_ETH_RE = /^(0|[1-9][0-9]{0,12})(\.[0-9]{1,18})?$/;

const ALLOWED_INPUT_KEYS = new Set([
  "network",
  "contract",
  "contractVersion",
  "contract_version",
  "noidAmount",
  "noid_amount",
  "noidMicronoid",
  "noid_micronoid",
  "ethAmount",
  "eth_amount",
  "ethWei",
  "eth_wei",
  "bobNoid",
  "bob_noid",
  "bobEth",
  "bob_eth",
]);

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER_FATAL = new TextDecoder("utf-8", { fatal: true });

const isPlainObject = (o) =>
  o !== null &&
  typeof o === "object" &&
  !Array.isArray(o) &&
  Object.getPrototypeOf(o) === Object.prototype;

const utf8Bytes = (str) => TEXT_ENCODER.encode(str);
const utf8ByteLength = (str) => utf8Bytes(str).length;

const UNSAFE_DISPLAY_CHARS_RE =
  /[\u00AD\u034F\u061C\u115F\u1160\u180E\u200B-\u200F\u202A-\u202E\u2066-\u2069\u2800\u3164\uFE00-\uFE0F\uFEFF\uFFA0\u{E0100}-\u{E01EF}\p{Cf}\p{Cc}]/gu;
const COMBINING_MARK_RE = /^\p{M}$/u;
const MAX_COMBINING_MARKS = 2;

/**
 * Strips Unicode format, bidi override/isolate, zero-width, BOM, invisible fillers,
 * variation selectors, and control characters, caps consecutive combining marks per base
 * character (at most 2), collapses whitespace, and caps output length (by Unicode code points)
 * for safe UI display.
 * @param {unknown} text
 * @param {number} [maxLen=140]
 * @returns {string}
 */
export function sanitizeDisplayText(text, maxLen = 140) {
  if (typeof text !== "string") return "";
  const limit = Number.isInteger(maxLen) && maxLen > 0 ? maxLen : 140;
  const stripped = text
    .replace(/[\r\n\t]+/g, " ")
    .replace(UNSAFE_DISPLAY_CHARS_RE, "");

  const kept = [];
  let combiningRun = 0;
  let hasBase = false;
  for (const ch of stripped) {
    if (COMBINING_MARK_RE.test(ch)) {
      if (hasBase && combiningRun < MAX_COMBINING_MARKS) {
        kept.push(ch);
        combiningRun++;
      }
      continue;
    }
    kept.push(ch);
    combiningRun = 0;
    hasBase = !/\s/u.test(ch);
  }

  const collapsed = kept.join("").replace(/\s+/g, " ").trim();
  const chars = [...collapsed];
  return chars.length > limit ? chars.slice(0, limit).join("").trim() : collapsed;
}

/**
 * Returns true if `contract` matches the pinned HTLC contract address for `network`
 * (`"mainnet"` / `"production"` or `"sepolia"`).
 * @param {string} network
 * @param {string} contract
 * @returns {boolean}
 */
export function isPinnedContract(network, contract) {
  if (typeof network !== "string" || typeof contract !== "string") return false;
  const key = network === "production" ? "mainnet" : network;
  const spec = NETWORK_SPECS[key];
  if (!spec) return false;
  return contract.toLowerCase() === spec.pinnedContract.toLowerCase();
}

/**
 * Enforces that a decoded invitation matches the pinned HTLC contract for its network.
 * Returns the original decoded result when pinned, or a refusal object when unpinned.
 * @param {object} decoded Result of `decodeInvite()` or `inspectInput()`
 */
export function requirePinnedContract(decoded) {
  if (!decoded || decoded.ok !== true) {
    return decoded || { ok: false, code: "DAMAGED", error: "Invitation could not be decoded." };
  }
  if (!decoded.contractPinned) {
    const netLabel = decoded.fields ? decoded.fields.network_label : "this network";
    return {
      ok: false,
      code: "UNPINNED_CONTRACT",
      field: "contract",
      error: `Refused: HTLC contract address does not match the pinned contract for ${netLabel}.`,
    };
  }
  return decoded;
}

// ---------------------------------------------------------------------------
// Pure-JS synchronous SHA-256 (FIPS 180-4)
// ---------------------------------------------------------------------------

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr32 = (x, n) => (x >>> n) | (x << (32 - n));

/**
 * Synchronous SHA-256 over Uint8Array or UTF-8 string.
 * @param {Uint8Array|string} input
 * @returns {Uint8Array} 32-byte digest
 */
export function sha256(input) {
  const data = typeof input === "string" ? utf8Bytes(input) : new Uint8Array(input);
  const len = data.length;
  const bitLenHi = Math.floor((len * 8) / 0x100000000);
  const bitLenLo = (len * 8) >>> 0;
  const paddedLen = Math.ceil((len + 9) / 64) * 64;
  const buf = new Uint8Array(paddedLen);
  buf.set(data);
  buf[len] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(paddedLen - 8, bitLenHi, false);
  view.setUint32(paddedLen - 4, bitLenLo, false);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const w = new Uint32Array(64);

  for (let off = 0; off < paddedLen; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr32(w[i - 15], 7) ^ rotr32(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr32(w[i - 2], 17) ^ rotr32(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let i = 0; i < 64; i++) {
      const S1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const S0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, h0, false);
  outView.setUint32(4, h1, false);
  outView.setUint32(8, h2, false);
  outView.setUint32(12, h3, false);
  outView.setUint32(16, h4, false);
  outView.setUint32(20, h5, false);
  outView.setUint32(24, h6, false);
  outView.setUint32(28, h7, false);
  return out;
}

// ---------------------------------------------------------------------------
// Pure-JS synchronous Keccak-256 (Ethereum hash, 0x01 padding, for EIP-55)
// ---------------------------------------------------------------------------

const KECCAK_MASK = (1n << 64n) - 1n;
const KECCAK_RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
const KECCAK_ROTC = [1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44];
const KECCAK_PILN = [10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1];

const rotl64 = (x, n) => ((x << BigInt(n)) | (x >> BigInt(64 - n))) & KECCAK_MASK;

function keccakF(st) {
  const bc = new Array(5);
  for (let round = 0; round < 24; round++) {
    for (let i = 0; i < 5; i++) bc[i] = st[i] ^ st[i + 5] ^ st[i + 10] ^ st[i + 15] ^ st[i + 20];
    for (let i = 0; i < 5; i++) {
      const t = bc[(i + 4) % 5] ^ rotl64(bc[(i + 1) % 5], 1);
      for (let j = 0; j < 25; j += 5) st[j + i] ^= t;
    }
    let t = st[1];
    for (let i = 0; i < 24; i++) {
      const j = KECCAK_PILN[i];
      const tmp = st[j];
      st[j] = rotl64(t, KECCAK_ROTC[i]);
      t = tmp;
    }
    for (let j = 0; j < 25; j += 5) {
      for (let i = 0; i < 5; i++) bc[i] = st[j + i];
      for (let i = 0; i < 5; i++) st[j + i] ^= (~bc[(i + 1) % 5] & KECCAK_MASK) & bc[(i + 2) % 5];
    }
    st[0] ^= KECCAK_RC[round];
  }
}

/**
 * Synchronous Ethereum Keccak-256 over Uint8Array or UTF-8 string.
 * @param {Uint8Array|string} input
 * @returns {Uint8Array} 32-byte digest
 */
export function keccak256(input) {
  const data = typeof input === "string" ? utf8Bytes(input) : new Uint8Array(input);
  const rate = 136;
  const padded = new Uint8Array(Math.ceil((data.length + 1) / rate) * rate);
  padded.set(data);
  padded[data.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;
  const view = new DataView(padded.buffer);
  const st = new Array(25).fill(0n);
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) st[i] ^= view.getBigUint64(off + i * 8, true);
    keccakF(st);
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 4; i++) outView.setBigUint64(i * 8, st[i], true);
  return out;
}

function bytesToHex(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}

// ---------------------------------------------------------------------------
// Strict canonical unpadded base64url (RFC 4648 Section 5)
// ---------------------------------------------------------------------------

const B64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const B64URL_LOOKUP = new Int16Array(128).fill(-1);
for (let i = 0; i < B64URL_ALPHABET.length; i++) B64URL_LOOKUP[B64URL_ALPHABET.charCodeAt(i)] = i;

function base64urlEncode(bytes) {
  let out = "";
  const len = bytes.length;
  for (let i = 0; i < len; i += 3) {
    const b0 = bytes[i];
    const has1 = i + 1 < len;
    const has2 = i + 2 < len;
    const b1 = has1 ? bytes[i + 1] : 0;
    const b2 = has2 ? bytes[i + 2] : 0;
    out += B64URL_ALPHABET[b0 >>> 2];
    out += B64URL_ALPHABET[((b0 & 0x03) << 4) | (b1 >>> 4)];
    if (has1) out += B64URL_ALPHABET[((b1 & 0x0f) << 2) | (b2 >>> 6)];
    if (has2) out += B64URL_ALPHABET[b2 & 0x3f];
  }
  return out;
}

function base64urlDecodeCanonical(str) {
  if (typeof str !== "string" || str.length === 0 || !BASE64URL_RE.test(str)) return null;
  const rem = str.length % 4;
  if (rem === 1) return null;
  const outLen = Math.floor((str.length * 3) / 4);
  const out = new Uint8Array(outLen);
  let p = 0;
  for (let i = 0; i < str.length; i += 4) {
    const c0 = B64URL_LOOKUP[str.charCodeAt(i)];
    const c1 = B64URL_LOOKUP[str.charCodeAt(i + 1)];
    const has2 = i + 2 < str.length;
    const has3 = i + 3 < str.length;
    const c2 = has2 ? B64URL_LOOKUP[str.charCodeAt(i + 2)] : 0;
    const c3 = has3 ? B64URL_LOOKUP[str.charCodeAt(i + 3)] : 0;
    if (c0 < 0 || c1 < 0 || c2 < 0 || c3 < 0) return null;
    out[p++] = (c0 << 2) | (c1 >>> 4);
    if (has2) out[p++] = ((c1 & 0x0f) << 4) | (c2 >>> 2);
    if (has3) out[p++] = ((c2 & 0x03) << 6) | c3;
  }
  // Canonical check: rejects non-zero unused trailing bits.
  if (base64urlEncode(out) !== str) return null;
  return out;
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Bech32m (Parano1d `o1...`, HRP "o", 32-byte payload)
// ---------------------------------------------------------------------------

const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32_GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
const BECH32M_CONST = 0x2bc830a3;

function bech32Polymod(values) {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= BECH32_GEN[i];
  }
  return chk >>> 0;
}

function bech32HrpExpand(hrp) {
  const hi = [];
  const lo = [];
  for (let i = 0; i < hrp.length; i++) {
    const c = hrp.charCodeAt(i);
    hi.push(c >> 5);
    lo.push(c & 31);
  }
  return hi.concat([0], lo);
}

/**
 * Validates and decodes a lower-case Bech32m address (default HRP "o", 32-byte payload).
 * @param {string} s
 * @param {string} [hrp="o"]
 * @param {number} [payloadBytes=32]
 * @returns {{ok:true, bytes:Uint8Array}|{ok:false, reason:string}}
 */
export function decodeBech32m(s, hrp = "o", payloadBytes = 32) {
  if (typeof s !== "string" || s !== s.toLowerCase() || s.length > 90) {
    return { ok: false, reason: "lower-case bech32m expected" };
  }
  const pos = s.lastIndexOf("1");
  if (pos < 1 || s.slice(0, pos) !== hrp) {
    return { ok: false, reason: `the address must start with ${hrp}1` };
  }
  const data = [];
  for (const c of s.slice(pos + 1)) {
    const v = BECH32_CHARSET.indexOf(c);
    if (v < 0) {
      const safe = sanitizeDisplayText(c, 1);
      return {
        ok: false,
        reason: safe
          ? `character "${safe}" is not in the bech32 alphabet`
          : "an unsupported character is not in the bech32 alphabet",
      };
    }
    data.push(v);
  }
  if (data.length < 7) return { ok: false, reason: "too short" };
  if (bech32Polymod(bech32HrpExpand(hrp).concat(data)) !== BECH32M_CONST) {
    return { ok: false, reason: "checksum does not match (a typo?)" };
  }
  let acc = 0;
  let bits = 0;
  const out = [];
  for (const v of data.slice(0, -6)) {
    acc = (acc << 5) | v;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
    acc &= (1 << bits) - 1;
  }
  if (bits >= 5 || acc !== 0) return { ok: false, reason: "bad padding" };
  if (out.length !== payloadBytes) {
    return { ok: false, reason: `the payload is ${out.length} bytes, ${payloadBytes} expected` };
  }
  return { ok: true, bytes: new Uint8Array(out) };
}

/**
 * Encodes a 32-byte payload into a lower-case Bech32m address (default HRP "o").
 * @param {Uint8Array} bytes
 * @param {string} [hrp="o"]
 * @returns {string}
 */
export function encodeBech32m(bytes, hrp = "o") {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 32) {
    throw new Error("encodeBech32m expects a 32-byte Uint8Array");
  }
  const data = [];
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < bytes.length; i++) {
    acc = (acc << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      data.push((acc >> bits) & 31);
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) data.push((acc << (5 - bits)) & 31);
  const polymodInput = bech32HrpExpand(hrp).concat(data, [0, 0, 0, 0, 0, 0]);
  const mod = bech32Polymod(polymodInput) ^ BECH32M_CONST;
  const checksum = [];
  for (let i = 0; i < 6; i++) checksum.push((mod >>> (5 * (5 - i))) & 31);
  return `${hrp}1${data.concat(checksum).map((v) => BECH32_CHARSET[v]).join("")}`;
}

// ---------------------------------------------------------------------------
// Address validation (EIP-55 Ethereum & Parano1d Bech32m)
// ---------------------------------------------------------------------------

/**
 * Computes the EIP-55 mixed-case checksum of an Ethereum address, or null if invalid shape.
 * @param {string} addr
 * @returns {string|null}
 */
export function toChecksumAddress(addr) {
  if (typeof addr !== "string" || !ETH_ADDR_RE.test(addr)) return null;
  const lower = addr.slice(2).toLowerCase();
  const hashHex = bytesToHex(keccak256(lower));
  let out = "0x";
  for (let i = 0; i < lower.length; i++) {
    out += parseInt(hashHex[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i];
  }
  return out;
}

/**
 * Returns an error description if `addr` is not a valid Ethereum address (checking EIP-55
 * whenever mixed case is used), or null if valid.
 * @param {string} addr
 * @returns {string|null}
 */
export function ethAddressProblem(addr) {
  if (typeof addr !== "string" || !ETH_ADDR_RE.test(addr)) {
    return "must be 0x followed by 40 hexadecimal characters";
  }
  const body = addr.slice(2);
  if (body !== body.toLowerCase() && body !== body.toUpperCase() && toChecksumAddress(addr) !== addr) {
    return "mixed-case EIP-55 checksum does not match (a character may be mistyped)";
  }
  return null;
}

/**
 * Validates an Ethereum address and returns its EIP-55 checksummed form.
 * @param {string} addr
 * @returns {{ok:true, address:string, checksum:string}|{ok:false, error:string}}
 */
export function validateEthAddress(addr) {
  const err = ethAddressProblem(addr);
  if (err) return { ok: false, error: err };
  return { ok: true, address: addr, checksum: toChecksumAddress(addr) };
}

/**
 * Returns an error description if `addr` is not a valid Parano1d `o1...` Bech32m address,
 * or null if valid.
 * @param {string} addr
 * @returns {string|null}
 */
export function noidAddressProblem(addr) {
  if (typeof addr !== "string") return "must be a Parano1d o1... address";
  const decoded = decodeBech32m(addr, "o", 32);
  return decoded.ok ? null : `not a valid Parano1d address (o1...): ${decoded.reason}`;
}

/**
 * Validates a Parano1d `o1...` Bech32m address.
 * @param {string} addr
 * @returns {{ok:true, address:string}|{ok:false, error:string}}
 */
export function validateNoidAddress(addr) {
  const err = noidAddressProblem(addr);
  if (err) return { ok: false, error: err };
  return { ok: true, address: addr };
}

// ---------------------------------------------------------------------------
// Strict JSON parser (no BOM, size ceiling, depth cap, no duplicate keys)
// ---------------------------------------------------------------------------

function strictJsonParse(text) {
  if (typeof text !== "string") throw new Error("text expected");
  if (utf8ByteLength(text) > MAX_BYTES) {
    const err = new Error("too large");
    err.code = "TOO_LARGE";
    throw err;
  }
  if (text.charCodeAt(0) === 0xfeff) throw new Error("byte order mark is not allowed");
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("not valid JSON");
  }

  // Scan raw JSON text for duplicate keys at any depth (including unicode escapes).
  let i = 0;
  const ws = () => {
    while (i < text.length && " \t\r\n".includes(text[i])) i++;
  };
  const readStr = () => {
    let out = "";
    i++; // opening quote
    while (i < text.length && text[i] !== '"') {
      if (text[i] === "\\") {
        const n = text[i + 1] === "u" ? 6 : 2;
        out += text.slice(i, i + n);
        i += n;
      } else {
        out += text[i++];
      }
    }
    i++; // closing quote
    return out;
  };
  const walk = (depth) => {
    if (depth > MAX_JSON_DEPTH) throw new Error("nested too deeply");
    ws();
    const c = text[i];
    if (c === "{") {
      i++;
      const seen = new Set();
      ws();
      if (text[i] === "}") {
        i++;
        return;
      }
      for (;;) {
        ws();
        const k = JSON.parse(`"${readStr()}"`);
        if (seen.has(k)) throw new Error("duplicate key");
        seen.add(k);
        ws();
        i++; // ':'
        walk(depth + 1);
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        i++; // '}'
        return;
      }
    }
    if (c === "[") {
      i++;
      ws();
      if (text[i] === "]") {
        i++;
        return;
      }
      for (;;) {
        walk(depth + 1);
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        i++; // ']'
        return;
      }
    }
    if (c === '"') {
      readStr();
      return;
    }
    while (i < text.length && !",}] \t\r\n".includes(text[i])) i++;
  };
  walk(0);
  return value;
}

// ---------------------------------------------------------------------------
// Exact BigInt decimal & implied-rate math
// ---------------------------------------------------------------------------

const pow10 = (n) => 10n ** BigInt(n);

/**
 * Formats an integer base-unit string (micro-NOID or wei) into an exact decimal string
 * with no trailing zeros ("5000000", 6 -> "5"; "1", 6 -> "0.000001").
 * @param {string|bigint} digits
 * @param {number} places
 * @returns {string}
 */
export function toDecimal(digits, places) {
  const n = typeof digits === "bigint" ? digits : BigInt(digits);
  const unit = pow10(places);
  const whole = n / unit;
  const frac = (n % unit).toString().padStart(places, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/**
 * Converts a validated decimal string to BigInt base units, or null if malformed.
 * @param {string} str
 * @param {number} places
 * @returns {bigint|null}
 */
export function decimalToInt(str, places) {
  if (typeof str !== "string") return null;
  const trimmed = str.trim();
  const re = places === 6 ? DEC_NOID_RE : places === 18 ? DEC_ETH_RE : new RegExp(`^(0|[1-9][0-9]{0,15})(\\.[0-9]{1,${places}})?$`);
  if (!re.test(trimmed)) return null;
  const [w, f = ""] = trimmed.split(".");
  return BigInt(w) * pow10(places) + BigInt(f.padEnd(places, "0") || "0");
}

/**
 * Groups the integer portion of a decimal string with commas ("2500.5" -> "2,500.5").
 * @param {string} decimalStr
 * @returns {string}
 */
export function formatGroupedDecimal(decimalStr) {
  const [w, f] = String(decimalStr).split(".");
  const grouped = w.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return f === undefined ? grouped : `${grouped}.${f}`;
}

function significantRatio(n, d, digits = 6) {
  if (typeof n !== "bigint" || typeof d !== "bigint" || d <= 0n || n <= 0n) {
    return { text: "0", rounded: false };
  }
  const ge = (ex) => (ex >= 0 ? n >= d * pow10(ex) : n * pow10(-ex) >= d);
  let e = n.toString().length - d.toString().length;
  while (!ge(e)) e--;
  while (ge(e + 1)) e++;
  let shift = digits - 1 - e;
  let num = n;
  let den = d;
  if (shift >= 0) num = n * pow10(shift);
  else den = d * pow10(-shift);
  let q = num / den;
  const r = num % den;
  const rounded = r !== 0n;
  if (r * 2n >= den) q += 1n;
  if (q === pow10(digits)) {
    q /= 10n;
    shift -= 1;
  }
  let s = q.toString();
  if (shift <= 0) {
    s += "0".repeat(-shift);
  } else {
    if (s.length <= shift) s = "0".repeat(shift - s.length + 1) + s;
    s = `${s.slice(0, s.length - shift)}.${s.slice(s.length - shift)}`
      .replace(/0+$/, "")
      .replace(/\.$/, "");
  }
  return { text: s, rounded };
}

/**
 * Computes exact-precision implied swap rates from micro-NOID and wei (matching
 * `ui/app/lib/launchfacts.js` `rate()`).
 * @param {string|bigint} noidMicro
 * @param {string|bigint} ethWei
 * @returns {{noidInEth:string, ethInNoid:string, rounded:boolean, noidInEthLabel:string, ethInNoidLabel:string}|null}
 */
export function calculateRate(noidMicro, ethWei) {
  let n;
  let e;
  try {
    n = typeof noidMicro === "bigint" ? noidMicro : BigInt(noidMicro);
    e = typeof ethWei === "bigint" ? ethWei : BigInt(ethWei);
  } catch {
    return null;
  }
  if (n <= 0n || e <= 0n) return null;
  const a = significantRatio(e, n * pow10(12), 6);
  const b = significantRatio(n * pow10(12), e, 6);
  const ab = a.rounded || b.rounded ? "about " : "";
  return {
    noidInEth: a.text,
    ethInNoid: b.text,
    rounded: a.rounded || b.rounded,
    noidInEthLabel: `1 NOID = ${ab}${formatGroupedDecimal(a.text)} ETH`,
    ethInNoidLabel: `1 ETH = ${ab}${formatGroupedDecimal(b.text)} NOID`,
  };
}

// ---------------------------------------------------------------------------
// Core Invitation JSON Parser, Encoder, Decoder, and URI Helpers
// ---------------------------------------------------------------------------

function makeCodeFromRaw(rawObj) {
  const ordered = {
    kind: rawObj.kind,
    v: rawObj.v,
    network: rawObj.network,
    contract: rawObj.contract,
    contract_version: rawObj.contract_version,
    noid_micronoid: rawObj.noid_micronoid,
    eth_wei: rawObj.eth_wei,
    bob_noid: rawObj.bob_noid,
    bob_eth: rawObj.bob_eth,
  };
  const compact = JSON.stringify(ordered);
  const payload = utf8Bytes(compact);
  const csum = sha256(payload).subarray(0, CHECKSUM_BYTES);
  const combined = new Uint8Array(payload.length + CHECKSUM_BYTES);
  combined.set(payload, 0);
  combined.set(csum, payload.length);
  return {
    compact,
    pretty: `${JSON.stringify(ordered, null, 2)}\n`,
    code: CODE_PREFIX + base64urlEncode(combined),
  };
}

/**
 * Parses and validates raw 9-key invitation JSON text with full desktop parity.
 * @param {string} text
 * @param {{checksumValid?:boolean|null, source?:"code"|"json"}} [meta]
 */
export function parseInvitationJson(text, meta = {}) {
  const fail = (code, error, field) => (field ? { ok: false, code, error, field } : { ok: false, code, error });
  if (typeof text !== "string") {
    return fail("DAMAGED", "Invitation input must be text.");
  }
  if (utf8ByteLength(text) > MAX_BYTES) {
    return fail("TOO_LARGE", `Invitation payload is too large (limit is ${MAX_BYTES} bytes).`);
  }
  let o;
  try {
    o = strictJsonParse(text);
  } catch (err) {
    if (err && err.code === "TOO_LARGE") {
      return fail("TOO_LARGE", `Invitation payload is too large (limit is ${MAX_BYTES} bytes).`);
    }
    return fail("DAMAGED", "Invitation is not valid strict JSON (or contains duplicate keys / BOM).");
  }
  if (!isPlainObject(o)) {
    return fail("DAMAGED", "Invitation must be a JSON object.");
  }

  const keys = Object.keys(o);
  const unexpected = keys.filter((k) => !KEYS.includes(k));
  if (unexpected.length > 0) {
    const safeKey = sanitizeDisplayText(unexpected[0], 32);
    return fail(
      "UNEXPECTED_FIELD",
      safeKey
        ? `Invitation contains unexpected field "${safeKey}". Only the 9 public invitation fields are allowed.`
        : "Invitation contains an unexpected field. Only the 9 public invitation fields are allowed.",
      safeKey || "unknown",
    );
  }
  const missing = KEYS.filter((k) => !Object.prototype.hasOwnProperty.call(o, k));
  if (missing.length > 0) {
    return fail("DAMAGED", `Invitation is missing required field "${missing[0]}".`, missing[0]);
  }
  if (o.kind !== KIND || o.v !== 1) {
    return fail("DAMAGED", "This is not a valid No1d Swap v1 invitation.");
  }
  if (typeof o.network !== "string" || !Object.prototype.hasOwnProperty.call(NETWORK_SPECS, o.network)) {
    return fail(
      "NETWORK",
      "Unsupported network. Only Ethereum mainnet (mainnet) and Sepolia (sepolia) invitations are accepted.",
      "network",
    );
  }
  const spec = NETWORK_SPECS[o.network];
  if (o.contract_version !== 1 && o.contract_version !== 2) {
    return fail("VALUE", "Contract version must be 1 or 2.", "contract_version");
  }
  for (const k of ["contract", "noid_micronoid", "eth_wei", "bob_noid", "bob_eth"]) {
    if (typeof o[k] !== "string") {
      return fail("VALUE", `Field "${k}" must be a string.`, k);
    }
  }
  const contractErr = ethAddressProblem(o.contract);
  if (contractErr) return fail("VALUE", `Invalid HTLC contract address: ${contractErr}.`, "contract");
  if (!NOID_MICRO_RE.test(o.noid_micronoid)) {
    return fail("VALUE", "NOID amount (micro-NOID) must be a positive integer string.", "noid_micronoid");
  }
  if (!ETH_WEI_RE.test(o.eth_wei)) {
    return fail("VALUE", "ETH amount (wei) must be a positive integer string.", "eth_wei");
  }
  const bobNoidErr = noidAddressProblem(o.bob_noid);
  if (bobNoidErr) return fail("VALUE", `Invalid Bob NOID address: ${bobNoidErr}.`, "bob_noid");
  const bobEthErr = ethAddressProblem(o.bob_eth);
  if (bobEthErr) return fail("VALUE", `Invalid Bob Ethereum address: ${bobEthErr}.`, "bob_eth");

  if (!spec.allowedContractVersions.includes(o.contract_version)) {
    return fail(
      "VERSION",
      "Ethereum mainnet invitations only allow HTLC contract version 1.",
      "contract_version",
    );
  }

  const noidMicro = BigInt(o.noid_micronoid);
  const ethWei = BigInt(o.eth_wei);
  if (noidMicro > spec.maxNoidMicro) {
    return fail(
      "CAPS",
      `NOID amount exceeds the ${spec.label} per-swap cap of ${formatGroupedDecimal(spec.maxNoid)} NOID.`,
      "noid_micronoid",
    );
  }
  if (ethWei > spec.maxEthWei) {
    return fail(
      "CAPS",
      `ETH amount exceeds the ${spec.label} per-swap cap of ${spec.maxEth} ETH.`,
      "eth_wei",
    );
  }

  const raw = {
    kind: o.kind,
    v: o.v,
    network: o.network,
    contract: o.contract,
    contract_version: o.contract_version,
    noid_micronoid: o.noid_micronoid,
    eth_wei: o.eth_wei,
    bob_noid: o.bob_noid,
    bob_eth: o.bob_eth,
  };
  const built = makeCodeFromRaw(raw);
  const noidAmount = toDecimal(o.noid_micronoid, 6);
  const ethAmount = toDecimal(o.eth_wei, 18);
  const rate = calculateRate(noidMicro, ethWei);
  const contractPinned = isPinnedContract(spec.network, o.contract);

  return {
    ok: true,
    source: meta.source || "json",
    code: built.code,
    canonicalCode: built.code,
    contractPinned,
    uri: contractPinned ? `${URI_PREFIX}${encodeURIComponent(built.code)}` : null,
    raw,
    fields: {
      role: "alice",
      profile: spec.profile,
      network: spec.network,
      network_label: spec.label,
      chain_id: spec.chainId,
      contract_version: String(o.contract_version),
      noid_amount: noidAmount,
      eth_amount: ethAmount,
      noid_micronoid: o.noid_micronoid,
      eth_wei: o.eth_wei,
      contract: o.contract,
      bob_noid: o.bob_noid,
      bob_eth: o.bob_eth,
    },
    rate,
    checks: {
      checksumValid: meta.checksumValid !== undefined ? meta.checksumValid : null,
      withinCaps: true,
      matchesPinnedContract: contractPinned,
      contractVersionValid: true,
      bobNoidValid: true,
      bobEthValid: true,
    },
  };
}

/**
 * Decodes either a compact `no1dinv1:...` invite code or raw 9-key invitation JSON.
 * Verifies canonical base64url, size ceilings, 4-byte SHA-256 checksum, UTF-8 validity,
 * strict 9-key schema, address checksums, and network caps.
 * @param {string} input
 */
export function decodeInvite(input) {
  const fail = (code, error, field) => (field ? { ok: false, code, error, field } : { ok: false, code, error });
  if (typeof input !== "string") {
    return fail("DAMAGED", "Paste a no1dinv1: invitation code or raw invitation JSON.");
  }
  // Strip ASCII whitespace only (preserve leading UTF-8 BOM so strict JSON rejects it).
  const trimmed = input.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");
  if (!trimmed) {
    return fail("DAMAGED", "Invitation input is empty.");
  }
  if (utf8ByteLength(trimmed) > MAX_CODE_CHARS) {
    return fail("TOO_LARGE", `Invitation code is too large (limit is ${MAX_CODE_CHARS} characters).`);
  }
  if (!trimmed.startsWith(CODE_PREFIX)) {
    return parseInvitationJson(trimmed, { checksumValid: null, source: "json" });
  }

  const body = trimmed.slice(CODE_PREFIX.length);
  if (!body) {
    return fail("TRUNCATED", "Invitation code is incomplete after the no1dinv1: prefix.");
  }
  if (!BASE64URL_RE.test(body)) {
    return fail("DAMAGED", "Invitation code contains invalid characters outside the base64url alphabet.");
  }
  const raw = base64urlDecodeCanonical(body);
  if (!raw) {
    return fail("DAMAGED", "Invitation code is truncated or uses non-canonical base64url encoding.");
  }
  if (raw.length > MAX_BYTES + CHECKSUM_BYTES) {
    return fail("TOO_LARGE", `Decoded invitation exceeds the ${MAX_BYTES}-byte limit.`);
  }
  if (raw.length <= CHECKSUM_BYTES) {
    return fail("TRUNCATED", "Invitation code is truncated and too short to hold a payload and checksum.");
  }

  const payload = raw.subarray(0, raw.length - CHECKSUM_BYTES);
  const gotChecksum = raw.subarray(raw.length - CHECKSUM_BYTES);
  const wantChecksum = sha256(payload).subarray(0, CHECKSUM_BYTES);
  if (!constantTimeEqual(gotChecksum, wantChecksum)) {
    return fail(
      "CHECKSUM",
      "Checksum mismatch — this invitation code was altered, truncated, or mistyped. Nothing was accepted.",
    );
  }

  let jsonText;
  try {
    jsonText = TEXT_DECODER_FATAL.decode(payload);
  } catch {
    return fail("DAMAGED", "Invitation payload is not valid UTF-8 text.");
  }

  return parseInvitationJson(jsonText, { checksumValid: true, source: "code" });
}

/** Alias matching the desktop program's `invitation.parseCode`. */
export const parseCode = decodeInvite;

/**
 * Validates public offer fields and constructs the canonical 9-key invitation JSON.
 * Strictly rejects any unexpected or secret-looking properties.
 * @param {object} offer
 */
export function buildInvitationJson(offer) {
  const fail = (error, field) => (field ? { ok: false, error, field } : { ok: false, error });
  if (!isPlainObject(offer)) {
    return fail("Offer must be a plain object of public swap fields.");
  }
  for (const k of Object.keys(offer)) {
    if (!ALLOWED_INPUT_KEYS.has(k)) {
      const safeKey = sanitizeDisplayText(k, 32);
      return fail(
        safeKey
          ? `Unexpected field "${safeKey}". Only public swap terms are allowed — never enter private keys, secrets, or recovery codes.`
          : "Unexpected field. Only public swap terms are allowed — never enter private keys, secrets, or recovery codes.",
        safeKey || "unknown",
      );
    }
  }

  const rawNetwork = typeof offer.network === "string" ? offer.network.trim().toLowerCase() : "";
  const network = rawNetwork === "production" ? "mainnet" : rawNetwork;
  if (!Object.prototype.hasOwnProperty.call(NETWORK_SPECS, network)) {
    return fail("Choose Ethereum mainnet (mainnet) or Sepolia (sepolia).", "network");
  }
  const spec = NETWORK_SPECS[network];

  // Contract version (default 1)
  const rawVer = offer.contractVersion !== undefined ? offer.contractVersion : offer.contract_version;
  let contractVersion = 1;
  if (rawVer !== undefined && rawVer !== null && rawVer !== "") {
    if (typeof rawVer === "number" && Number.isInteger(rawVer)) {
      contractVersion = rawVer;
    } else if (typeof rawVer === "string" && /^[12]$/.test(rawVer.trim())) {
      contractVersion = Number(rawVer.trim());
    } else {
      return fail("Contract version must be 1 or 2.", "contractVersion");
    }
  }
  if (!spec.allowedContractVersions.includes(contractVersion)) {
    return fail("Ethereum mainnet only allows HTLC contract version 1.", "contractVersion");
  }

  // Contract address (defaults to pinned contract for the chosen network)
  const rawContract = typeof offer.contract === "string" ? offer.contract.trim() : "";
  const contract = rawContract || spec.pinnedContract;
  const contractErr = ethAddressProblem(contract);
  if (contractErr) return fail(`Contract address ${contractErr}.`, "contract");

  // NOID amount: accept either decimal noidAmount or integer micro-NOID noidMicronoid
  const microInput = offer.noidMicronoid !== undefined ? offer.noidMicronoid : offer.noid_micronoid;
  const noidDecInput = offer.noidAmount !== undefined ? offer.noidAmount : offer.noid_amount;
  let noidMicroBig = null;
  if (microInput !== undefined && microInput !== null && String(microInput).trim() !== "") {
    const s = String(microInput).trim();
    if (!NOID_MICRO_RE.test(s)) return fail("NOID micro-units must be a positive integer.", "noidAmount");
    noidMicroBig = BigInt(s);
  } else if (noidDecInput !== undefined && noidDecInput !== null && String(noidDecInput).trim() !== "") {
    noidMicroBig = decimalToInt(String(noidDecInput).trim(), 6);
    if (noidMicroBig === null || noidMicroBig <= 0n) {
      return fail("Enter a positive NOID amount with up to 6 decimals (e.g. 250 or 12.5).", "noidAmount");
    }
  } else {
    return fail("NOID amount is required.", "noidAmount");
  }
  if (noidMicroBig > spec.maxNoidMicro) {
    return fail(
      `NOID amount exceeds the ${spec.label} limit of ${formatGroupedDecimal(spec.maxNoid)} NOID per swap.`,
      "noidAmount",
    );
  }

  // ETH amount: accept either decimal ethAmount or integer wei ethWei
  const weiInput = offer.ethWei !== undefined ? offer.ethWei : offer.eth_wei;
  const ethDecInput = offer.ethAmount !== undefined ? offer.ethAmount : offer.eth_amount;
  let ethWeiBig = null;
  if (weiInput !== undefined && weiInput !== null && String(weiInput).trim() !== "") {
    const s = String(weiInput).trim();
    if (!ETH_WEI_RE.test(s)) return fail("ETH wei must be a positive integer.", "ethAmount");
    ethWeiBig = BigInt(s);
  } else if (ethDecInput !== undefined && ethDecInput !== null && String(ethDecInput).trim() !== "") {
    ethWeiBig = decimalToInt(String(ethDecInput).trim(), 18);
    if (ethWeiBig === null || ethWeiBig <= 0n) {
      return fail("Enter a positive ETH amount with up to 18 decimals (e.g. 0.05).", "ethAmount");
    }
  } else {
    return fail("ETH amount is required.", "ethAmount");
  }
  if (ethWeiBig > spec.maxEthWei) {
    return fail(
      `ETH amount exceeds the ${spec.label} limit of ${spec.maxEth} ETH per swap.`,
      "ethAmount",
    );
  }

  // Bob's Parano1d NOID payout address
  const rawBobNoid = offer.bobNoid !== undefined ? offer.bobNoid : offer.bob_noid;
  const bobNoid = typeof rawBobNoid === "string" ? rawBobNoid.trim() : "";
  if (!bobNoid) return fail("Bob's Parano1d NOID payout address (o1...) is required.", "bobNoid");
  const bobNoidErr = noidAddressProblem(bobNoid);
  if (bobNoidErr) return fail(`Bob's NOID address: ${bobNoidErr}.`, "bobNoid");

  // Bob's Ethereum swap address
  const rawBobEth = offer.bobEth !== undefined ? offer.bobEth : offer.bob_eth;
  const bobEth = typeof rawBobEth === "string" ? rawBobEth.trim() : "";
  if (!bobEth) return fail("Bob's Ethereum address (0x...) is required.", "bobEth");
  const bobEthErr = ethAddressProblem(bobEth);
  if (bobEthErr) return fail(`Bob's Ethereum address ${bobEthErr}.`, "bobEth");

  if (bobEth.toLowerCase() === contract.toLowerCase()) {
    return fail("Bob's Ethereum address cannot be the HTLC contract address.", "bobEth");
  }

  const payload = {
    kind: KIND,
    v: 1,
    network,
    contract,
    contract_version: contractVersion,
    noid_micronoid: noidMicroBig.toString(),
    eth_wei: ethWeiBig.toString(),
    bob_noid: bobNoid,
    bob_eth: bobEth,
  };
  const built = makeCodeFromRaw(payload);
  const check = parseInvitationJson(built.pretty);
  if (!check.ok) return fail(check.error, check.field);

  return {
    ok: true,
    json: built.pretty,
    compactJson: built.compact,
    payload,
  };
}

/**
 * Encodes public offer fields into a desktop-compatible `no1dinv1:` invite code and
 * `no1d-invite://invite?code=...` pre-fill handoff URI. Verifies round-trip decode before returning.
 * @param {object} offer
 */
export function encodeInvite(offer) {
  const built = buildInvitationJson(offer);
  if (!built.ok) return built;
  const encoded = makeCodeFromRaw(built.payload);
  const verified = decodeInvite(encoded.code);
  if (!verified.ok) return { ok: false, error: verified.error, field: verified.field };
  return {
    ok: true,
    code: verified.canonicalCode,
    canonicalCode: verified.canonicalCode,
    contractPinned: verified.contractPinned,
    uri: verified.uri,
    json: built.json,
    raw: verified.raw,
    fields: verified.fields,
    rate: verified.rate,
    checks: verified.checks,
  };
}

/**
 * Builds a `no1d-invite://invite?code=<encoded>` desktop pre-fill handoff URI from a valid,
 * pinned-contract `no1dinv1:` code. Pre-fill only: identical to pasting the code in the desktop program.
 * Always rebuilds from `canonicalCode` and refuses unpinned contracts.
 * @param {string} code
 * @returns {{ok:true, uri:string, code:string, canonicalCode:string}|{ok:false, error:string, code?:string}}
 */
export function buildInviteUri(code) {
  if (typeof code !== "string") {
    return { ok: false, error: "Invite code must be a string." };
  }
  const trimmed = code.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");
  if (!trimmed.startsWith(CODE_PREFIX)) {
    return { ok: false, error: "Invite URI requires a valid no1dinv1: code." };
  }
  const decoded = decodeInvite(trimmed);
  if (!decoded.ok) return { ok: false, code: decoded.code, error: decoded.error };
  const pinnedCheck = requirePinnedContract(decoded);
  if (!pinnedCheck.ok) return pinnedCheck;
  const uri = `${URI_PREFIX}${encodeURIComponent(decoded.canonicalCode)}`;
  if (utf8ByteLength(uri) > MAX_CODE_CHARS) {
    return { ok: false, code: "TOO_LARGE", error: `Invite URI exceeds the ${MAX_CODE_CHARS}-byte limit.` };
  }
  return {
    ok: true,
    code: decoded.canonicalCode,
    canonicalCode: decoded.canonicalCode,
    uri,
  };
}

/**
 * Parses and validates a `no1d-invite://invite?code=<encoded>` URI, returning the decoded invite.
 * Enforces the same size cap (MAX_CODE_CHARS) and strict refusal rules as `no1dinv1:` paste:
 * rejects unexpected schemes, hosts, paths, credentials, ports, fragments, or extra query parameters.
 * @param {string} uri
 */
export function parseInviteUri(uri) {
  const fail = (error, code = "INVALID_URI") => ({ ok: false, code, error });
  if (typeof uri !== "string") return fail("Invite URI must be text.");
  const trimmed = uri.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");
  if (!trimmed) return fail("Invite URI is empty.");
  if (utf8ByteLength(trimmed) > MAX_CODE_CHARS) {
    return fail(`Invite URI is too large (limit is ${MAX_CODE_CHARS} bytes).`, "TOO_LARGE");
  }
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return fail("Not a valid no1d-invite://invite URI.");
  }
  if (parsed.protocol !== URI_SCHEME) {
    return fail("Invite URI must use the no1d-invite:// scheme.");
  }
  const host = parsed.hostname.toLowerCase();
  if (host !== "invite" || (parsed.pathname !== "" && parsed.pathname !== "/")) {
    return fail("Invite URI must target no1d-invite://invite?code=...");
  }
  if (parsed.username !== "" || parsed.password !== "" || parsed.port !== "" || parsed.hash !== "") {
    return fail("Invite URI cannot include credentials, a port, or a fragment.");
  }
  const paramKeys = [...parsed.searchParams.keys()];
  if (paramKeys.length !== 1 || paramKeys[0] !== "code") {
    return fail("Invite URI must contain only the single ?code= parameter.");
  }
  const code = parsed.searchParams.get("code");
  if (!code || !code.startsWith(CODE_PREFIX)) {
    return fail("Invite URI ?code= parameter must be a valid no1dinv1: code.");
  }
  const decoded = decodeInvite(code);
  if (!decoded.ok) return decoded;
  return {
    ...decoded,
    source: "uri",
    uri: decoded.contractPinned ? `${URI_PREFIX}${encodeURIComponent(decoded.canonicalCode)}` : null,
  };
}

/**
 * Unified inspector entry point: accepts a `no1dinv1:` code, a `no1d-invite://invite?code=...` URI,
 * or raw 9-key invitation JSON.
 * @param {string} input
 */
export function inspectInput(input) {
  if (typeof input !== "string") {
    return { ok: false, code: "DAMAGED", error: "Paste a no1dinv1: code or no1d-invite:// URI." };
  }
  const trimmed = input.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");
  if (trimmed.toLowerCase().startsWith("no1d-invite:")) {
    return parseInviteUri(trimmed);
  }
  return decodeInvite(input);
}
