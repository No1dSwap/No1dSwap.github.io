import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  NETWORK_SPECS,
  encodeBech32m,
  encodeInvite,
  sha256,
  toChecksumAddress,
} from "../js/invite-codec.js";
import { parseOffersSnapshot } from "../js/offers-data.js";
import {
  NOSTR_KINDS,
  SECP256K1_N,
  SECP256K1_P,
  checkNip13Pow,
  computeNostrEventId,
  countLeadingZeroBits,
  finalizeNostrEvent,
  mineNip13Pow,
  schnorrGetPublicKey,
  schnorrSign,
  schnorrVerify,
  verifyNostrEvent,
} from "../scripts/nostr-crypto.mjs";
import {
  DEFAULT_RELAYS,
  DELETION_KIND,
  HEARTBEAT_KIND,
  MAX_RELAY_BYTES,
  OFFER_KIND,
  PUBLIC_WEB_BOARD_TAG,
  RATE_LIMIT_MS,
  RELAY_TIMEOUT_MS,
  aggregateNostrEvents,
  buildAuthorFollowupFilters,
  buildBoardFilters,
  buildOfferFilter,
  normalizeRelayUrl,
  queryRelay,
  runUpdateOffers,
  validateHeartbeatEvent,
  validateOfferEvent,
} from "../scripts/update-offers.mjs";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.resolve(__dirname, "..", "scripts", "update-offers.mjs");

const BASE_NOW_MS = Date.parse("2026-11-26T20:30:00Z");
const BASE_NOW_SEC = Math.floor(BASE_NOW_MS / 1000);

const SK_MAKER_1 = "0000000000000000000000000000000000000000000000000000000000000003";
const SK_MAKER_2 = "b7e151628aed2a6abf7158809cf4f3c762e7160f38b4da56a784d9045190cfef";
const SK_MAKER_3 = "c90fdaa22168c234c4c6628b80dc1cd129024e088a67cc74020bbea63b14e5c9";
const AUX_ZERO = "0000000000000000000000000000000000000000000000000000000000000000";

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "noid-offers-test-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function makeTestNoidAddr(seed) {
  const bytes = new Uint8Array(32);
  bytes[0] = 0x55;
  for (let i = 1; i < 32; i++) bytes[i] = (seed * 31 + i * 11) & 0xff;
  return encodeBech32m(bytes, "o");
}

function makeTestEthAddr(seed) {
  const hex = seed.toString(16).padStart(4, "0");
  return toChecksumAddress(`0x220000000000000000000000000000000000${hex}`);
}

function makeInviteCode({
  network = "mainnet",
  noidAmount = "100",
  ethAmount = "0.02",
  seed = 1,
  bobNoid = undefined,
  bobEth = undefined,
  contract = undefined,
  contractVersion = 1,
} = {}) {
  const res = encodeInvite({
    network,
    noidAmount,
    ethAmount,
    bobNoid: bobNoid || makeTestNoidAddr(seed),
    bobEth: bobEth || makeTestEthAddr(seed),
    ...(contract ? { contract } : {}),
    contractVersion,
  });
  assert.equal(res.ok, true, `encodeInvite failed: ${res.error}`);
  return res.canonicalCode;
}

function makeSignedOfferEvent({
  secretKey = SK_MAKER_1,
  d = "00112233445566778899aabbccddeeff",
  code = makeInviteCode(),
  note = "Mainnet test offer",
  createdAt = BASE_NOW_SEC - 120,
  expiration = BASE_NOW_SEC + 3600,
  powBits = 8,
  status = "open",
  boardTag = PUBLIC_WEB_BOARD_TAG,
  useContentCarrier = false,
} = {}) {
  const pubkey = schnorrGetPublicKey(secretKey);
  const tags = [
    ["d", d],
    ["t", boardTag],
    ["expiration", String(expiration)],
    ["status", status],
  ];
  let content = "";
  if (useContentCarrier) {
    content = note ? `${code}\n${note}` : code;
  } else {
    if (status === "open" && code) tags.push(["invite", code]);
    if (note) tags.push(["note", note]);
  }
  const tpl = mineNip13Pow(
    { kind: OFFER_KIND, created_at: createdAt, tags, content },
    pubkey,
    powBits,
  );
  return finalizeNostrEvent(tpl, secretKey, { auxRand: AUX_ZERO });
}

function makeSignedHeartbeatEvent({
  secretKey = SK_MAKER_1,
  d = "heartbeat",
  createdAt = BASE_NOW_SEC - 60,
  expiration = BASE_NOW_SEC + 1800,
  boardTag = PUBLIC_WEB_BOARD_TAG,
} = {}) {
  return finalizeNostrEvent(
    {
      kind: HEARTBEAT_KIND,
      created_at: createdAt,
      tags: [
        ["d", d],
        ["t", boardTag],
        ["expiration", String(expiration)],
      ],
      content: "",
    },
    secretKey,
    { auxRand: AUX_ZERO },
  );
}

function makeMockWebSocketClass(handlersByUrl) {
  const instances = [];
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.sent = [];
      this.closed = false;
      this.onopen = null;
      this.onmessage = null;
      this.onerror = null;
      this.onclose = null;
      instances.push(this);

      const handler = handlersByUrl[url];
      if (!handler) {
        queueMicrotask(() => {
          if (!this.closed && this.onerror) this.onerror(new Error("unconfigured relay"));
        });
        return;
      }
      queueMicrotask(() => {
        if (this.closed) return;
        handler.onCreate?.(this);
      });
    }
    send(msg) {
      this.sent.push(msg);
      const handler = handlersByUrl[this.url];
      handler?.onSend?.(this, msg);
    }
    close() {
      if (this.closed) return;
      this.closed = true;
      const onclose = this.onclose;
      this.onopen = this.onmessage = this.onerror = this.onclose = null;
      if (onclose) onclose();
    }
    deliver(payload) {
      if (this.closed || !this.onmessage) return;
      this.onmessage({ data: typeof payload === "string" ? payload : JSON.stringify(payload) });
    }
    deliverRaw(rawData) {
      if (this.closed || !this.onmessage) return;
      this.onmessage({ data: rawData });
    }
  }
  return { FakeWebSocket, instances };
}

// ---------------------------------------------------------------------------
// 1. Official BIP-340 Schnorr Test Vectors (Signing + Verification + Failures)
// ---------------------------------------------------------------------------

test("BIP-340 Schnorr: passes official test vectors 0..3 for pubkey, deterministic sign, and verify, plus failure cases", () => {
  // Official BIP-340 test-vectors.csv entries 0..3
  const officialSignVectors = [
    {
      sk: "0000000000000000000000000000000000000000000000000000000000000003",
      pk: "f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9",
      aux: "0000000000000000000000000000000000000000000000000000000000000000",
      msg: "0000000000000000000000000000000000000000000000000000000000000000",
      sig: "e907831f80848d1069a5371b402410364bdf1c5f8307b0084c55f1ce2dca821525f66a4a85ea8b71e482a74f382d2ce5ebeee8fdb2172f477df4900d310536c0",
    },
    {
      sk: "b7e151628aed2a6abf7158809cf4f3c762e7160f38b4da56a784d9045190cfef",
      pk: "dff1d77f2a671c5f36183726db2341be58feae1da2deced843240f7b502ba659",
      aux: "0000000000000000000000000000000000000000000000000000000000000001",
      msg: "243f6a8885a308d313198a2e03707344a4093822299f31d0082efa98ec4e6c89",
      sig: "6896bd60eeae296db48a229ff71dfe071bde413e6d43f917dc8dcf8c78de33418906d11ac976abccb20b091292bff4ea897efcb639ea871cfa95f6de339e4b0a",
    },
    {
      sk: "c90fdaa22168c234c4c6628b80dc1cd129024e088a67cc74020bbea63b14e5c9",
      pk: "dd308afec5777e13121fa72b9cc1b7cc0139715309b086c960e18fd969774eb8",
      aux: "c87aa53824b4d7ae2eb035a2b5bbbccc080e76cdc6d1692c4b0b62d798e6d906",
      msg: "7e2d58d8b3bcdf1abadec7829054f90dda9805aab56c77333024b9d0a508b75c",
      sig: "5831aaeed7b44bb74e5eab94ba9d4294c49bcf2a60728d8b4c200f50dd313c1bab745879a5ad954a72c45a91c3a51d3c7adea98d82f8481e0e1e03674a6f3fb7",
    },
    {
      sk: "0b432b2677937381aef05bb02a66ecd012773062cf3fa2549e44f58ed2401710",
      pk: "25d1dff95105f5253c4022f628a996ad3a0d95fbf21d468a1b33f8c160d8f517",
      aux: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      msg: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      sig: "7eb0509757e246f19449885651611cb965ecc1a187dd51b64fda1edc9637d5ec97582b9cb13db3933705b32ba982af5af25fd78881ebb32771fc5922efc66ea3",
    },
  ];

  for (const [idx, v] of officialSignVectors.entries()) {
    assert.equal(schnorrGetPublicKey(v.sk), v.pk, `vector ${idx} pubkey mismatch`);
    assert.equal(schnorrSign(v.msg, v.sk, v.aux), v.sig, `vector ${idx} sig mismatch`);
    assert.equal(schnorrVerify(v.sig, v.msg, v.pk), true, `vector ${idx} verify failed`);
  }

  // Official BIP-340 verify-only vector 4 (valid) and negative vectors 5..14 (all must return false)
  const officialVerifyVectors = [
    {
      index: 4,
      valid: true,
      pk: "d69c3509bb99e412e68b0fe8544e72837dfa30746d8be2aa65975f29d22dc7b9",
      msg: "4df3c3f68fcc83b27e9d42c90431a72499f17875c81a599b566c9889b9696703",
      sig: "00000000000000000000003b78ce563f89a0ed9414f5aa28ad0d96d6795f9c6376afb1548af603b3eb45c9f8207dee1060cb71c04e80f593060b07d28308d7f4",
    },
    {
      index: 5,
      valid: false, // public key not on curve
      pk: "eefdea4cdb677750a420fee807eacf21eb9898ae79b9768766e4faa04a2d4a34",
      msg: "243f6a8885a308d313198a2e03707344a4093822299f31d0082efa98ec4e6c89",
      sig: "6cff5c3ba86c69ea4b7376f31a9bcb4f74c1976089b2d9963da2e5543e17776969e89b4c5564d00349106b8497785dd7d1d713a8ae82b32fa79d5f7fc407d39b",
    },
    {
      index: 6,
      valid: false, // has_even_y(R) is false
      pk: "dff1d77f2a671c5f36183726db2341be58feae1da2deced843240f7b502ba659",
      msg: "243f6a8885a308d313198a2e03707344a4093822299f31d0082efa98ec4e6c89",
      sig: "fff97bd5755eeea420453a14355235d382f6472f8568a18b2f057a14602975563cc27944640ac607cd107ae10923d9ef7a73c643e166be5ebeafa34b1ac553e2",
    },
    {
      index: 7,
      valid: false, // negated message
      pk: "dff1d77f2a671c5f36183726db2341be58feae1da2deced843240f7b502ba659",
      msg: "243f6a8885a308d313198a2e03707344a4093822299f31d0082efa98ec4e6c89",
      sig: "1fa62e331edbc21c394792d2ab1100a7b432b013df3f6ff4f99fcb33e0e1515f28890b3edb6e7189b630448b515ce4f8622a954cfe545735aaea5134fccdb2bd",
    },
    {
      index: 8,
      valid: false, // negated s value
      pk: "dff1d77f2a671c5f36183726db2341be58feae1da2deced843240f7b502ba659",
      msg: "243f6a8885a308d313198a2e03707344a4093822299f31d0082efa98ec4e6c89",
      sig: "6cff5c3ba86c69ea4b7376f31a9bcb4f74c1976089b2d9963da2e5543e177769961764b3aa9b2ffcb6ef947b6887a226e8d7c93e00c5ed0c1834ff0d0c2e6da6",
    },
    {
      index: 9,
      valid: false, // sG - eP is infinite (r = 0)
      pk: "dff1d77f2a671c5f36183726db2341be58feae1da2deced843240f7b502ba659",
      msg: "243f6a8885a308d313198a2e03707344a4093822299f31d0082efa98ec4e6c89",
      sig: "0000000000000000000000000000000000000000000000000000000000000000123dda8328af9c23a94c1feecfd123ba4fb73476f0d594dcb65c6425bd186051",
    },
    {
      index: 10,
      valid: false, // sG - eP is infinite (r = 1)
      pk: "dff1d77f2a671c5f36183726db2341be58feae1da2deced843240f7b502ba659",
      msg: "243f6a8885a308d313198a2e03707344a4093822299f31d0082efa98ec4e6c89",
      sig: "00000000000000000000000000000000000000000000000000000000000000017615fbaf5ae28864013c099742deadb4dba87f11ac6754f93780d5a1837cf197",
    },
    {
      index: 11,
      valid: false, // sig[0:32] not an X coordinate on curve
      pk: "dff1d77f2a671c5f36183726db2341be58feae1da2deced843240f7b502ba659",
      msg: "243f6a8885a308d313198a2e03707344a4093822299f31d0082efa98ec4e6c89",
      sig: "4a298dacae57395a15d0795ddbfd1dcb564da82b0f269bc70a74f8220429ba1d69e89b4c5564d00349106b8497785dd7d1d713a8ae82b32fa79d5f7fc407d39b",
    },
    {
      index: 12,
      valid: false, // sig[0:32] == p
      pk: "dff1d77f2a671c5f36183726db2341be58feae1da2deced843240f7b502ba659",
      msg: "243f6a8885a308d313198a2e03707344a4093822299f31d0082efa98ec4e6c89",
      sig: "fffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f69e89b4c5564d00349106b8497785dd7d1d713a8ae82b32fa79d5f7fc407d39b",
    },
    {
      index: 13,
      valid: false, // sig[32:64] == n
      pk: "dff1d77f2a671c5f36183726db2341be58feae1da2deced843240f7b502ba659",
      msg: "243f6a8885a308d313198a2e03707344a4093822299f31d0082efa98ec4e6c89",
      sig: "6cff5c3ba86c69ea4b7376f31a9bcb4f74c1976089b2d9963da2e5543e177769fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141",
    },
    {
      index: 14,
      valid: false, // pubkey > p
      pk: "fffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc30",
      msg: "243f6a8885a308d313198a2e03707344a4093822299f31d0082efa98ec4e6c89",
      sig: "6cff5c3ba86c69ea4b7376f31a9bcb4f74c1976089b2d9963da2e5543e17776969e89b4c5564d00349106b8497785dd7d1d713a8ae82b32fa79d5f7fc407d39b",
    },
  ];
  for (const v of officialVerifyVectors) {
    assert.equal(
      schnorrVerify(v.sig, v.msg, v.pk),
      v.valid,
      `official BIP-340 vector ${v.index} expected ${v.valid}`,
    );
  }

  // BIP-340 verification failure cases (official edge cases):
  const v0 = officialSignVectors[0];
  // 1. Wrong message (1 bit flipped)
  assert.equal(
    schnorrVerify(v0.sig, "0000000000000000000000000000000000000000000000000000000000000001", v0.pk),
    false,
  );
  // 2. Wrong pubkey
  assert.equal(schnorrVerify(v0.sig, v0.msg, officialSignVectors[1].pk), false);
  // 3. Flipped bit in signature s
  const badSig = v0.sig.slice(0, -1) + (v0.sig.endsWith("0") ? "1" : "0");
  assert.equal(schnorrVerify(badSig, v0.msg, v0.pk), false);
  // 4. Pubkey >= p (BIP-340 vector 5: 0xffffffff...fffffffefffffc30)
  assert.equal(
    schnorrVerify(v0.sig, v0.msg, (SECP256K1_P + 1n).toString(16).padStart(64, "0")),
    false,
  );
  // 5. Pubkey x not on curve (x = 5 -> 5^3 + 7 = 132 has no sqrt mod p)
  assert.equal(
    schnorrVerify(v0.sig, v0.msg, "0000000000000000000000000000000000000000000000000000000000000005"),
    false,
  );
  // 6. Signature r >= p
  const rGeP = SECP256K1_P.toString(16).padStart(64, "0") + v0.sig.slice(64);
  assert.equal(schnorrVerify(rGeP, v0.msg, v0.pk), false);
  // 7. Signature s >= n
  const sGeN = v0.sig.slice(0, 64) + SECP256K1_N.toString(16).padStart(64, "0");
  assert.equal(schnorrVerify(sGeN, v0.msg, v0.pk), false);
  // 8. Negated s (odd y on R, BIP-340 vector 8 style): s' = n - s
  const negS = (SECP256K1_N - BigInt("0x" + v0.sig.slice(64))).toString(16).padStart(64, "0");
  assert.equal(schnorrVerify(v0.sig.slice(0, 64) + negS, v0.msg, v0.pk), false);
  // 9. Malformed lengths / non-hex never throw
  assert.equal(schnorrVerify("abcd", v0.msg, v0.pk), false);
  assert.equal(schnorrVerify(v0.sig, v0.msg, "zzzz"), false);
});

// ---------------------------------------------------------------------------
// 2. NIP-01 Event Verification, NIP-13 PoW, and Relay URL Rules
// ---------------------------------------------------------------------------

test("NIP-01 verifyNostrEvent and NIP-13 checkNip13Pow reject tampered IDs, forged sigs, and missing/low PoW commitments", () => {
  const valid = makeSignedOfferEvent({ powBits: 10 });
  assert.equal(verifyNostrEvent(valid), true);
  assert.equal(computeNostrEventId(valid), valid.id);
  assert.ok(countLeadingZeroBits(valid.id) >= 10);
  assert.equal(checkNip13Pow(valid, 10).ok, true);
  assert.equal(checkNip13Pow(valid, 11).ok, false);

  // Tampered content -> id mismatch
  assert.equal(verifyNostrEvent({ ...valid, content: "tampered" }), false);
  // Tampered id (recomputed id without valid sig) -> sig mismatch
  const tamperedEv = { ...valid, content: "tampered" };
  tamperedEv.id = computeNostrEventId(tamperedEv);
  assert.equal(verifyNostrEvent(tamperedEv), false);
  // Forged signature
  assert.equal(
    verifyNostrEvent({ ...valid, sig: "0".repeat(128) }),
    false,
  );
  // Extra property rejected
  assert.equal(verifyNostrEvent({ ...valid, extra: 1 }), false);

  // NIP-13 commitment rule: even if event hash happens to have leading zeros, missing or low target fails
  const lowCommit = makeSignedOfferEvent({ powBits: 4 });
  assert.equal(checkNip13Pow(lowCommit, 8).ok, false);
  const noNonce = finalizeNostrEvent(
    {
      kind: OFFER_KIND,
      created_at: BASE_NOW_SEC,
      tags: [["d", "0".repeat(32)], ["t", PUBLIC_WEB_BOARD_TAG]],
      content: "",
    },
    SK_MAKER_1,
    { auxRand: AUX_ZERO },
  );
  assert.equal(checkNip13Pow(noNonce, 1).ok, false);
});

test("normalizeRelayUrl enforces public wss:// hostnames and gates ws://127.0.0.1 behind allowLocalTest", () => {
  assert.deepEqual(DEFAULT_RELAYS, [
    "wss://nos.lol",
    "wss://relay.primal.net",
    "wss://relay.snort.social",
  ]);
  assert.deepEqual(normalizeRelayUrl("wss://relay.primal.net/"), {
    ok: true,
    url: "wss://relay.primal.net",
  });
  assert.deepEqual(normalizeRelayUrl("wss://nos.lol:443/nostr"), {
    ok: true,
    url: "wss://nos.lol/nostr",
  });
  assert.deepEqual(normalizeRelayUrl("wss://nos.lol:8443/nostr/"), {
    ok: true,
    url: "wss://nos.lol:8443/nostr",
  });

  const rejected = [
    "ws://relay.primal.net",
    "ws://127.0.0.1:8080",
    "wss://127.0.0.1:8080",
    "wss://localhost:8080",
    "wss://relay.local",
    "wss://relay.internal",
    "wss://relay.onion",
    "wss://user:pass@relay.primal.net",
    "wss://relay.primal.net/?token=1",
    "wss://relay.primal.net/#frag",
    "https://relay.primal.net",
  ];
  for (const url of rejected) {
    assert.equal(normalizeRelayUrl(url).ok, false, `expected reject for ${url}`);
  }

  assert.deepEqual(
    normalizeRelayUrl("ws://127.0.0.1:18443", { allowLocalTest: true }),
    { ok: true, url: "ws://127.0.0.1:18443" },
  );
  // allowLocalTest still refuses remote ws://
  assert.equal(
    normalizeRelayUrl("ws://relay.primal.net", { allowLocalTest: true }).ok,
    false,
  );
});

// ---------------------------------------------------------------------------
// 3. Hostile Offer Validation, Liveness, Replacements, Deletions & Duplicates
// ---------------------------------------------------------------------------

function makeChecksummedCodeFromRawObj(obj) {
  const payload = Buffer.from(JSON.stringify(obj), "utf8");
  const csum = Buffer.from(sha256(payload).subarray(0, 4));
  return `no1dinv1:${Buffer.concat([payload, csum]).toString("base64url")}`;
}

test("validateOfferEvent refuses unpinned contracts, over-cap offers, invalid contract_version, bad PoW, and expired/future timestamps", () => {
  const ctx = { nowSec: BASE_NOW_SEC, minPowBits: 8 };

  // Valid mainnet (invite tag) and Sepolia (content carrier) accepted
  const goodMainnet = makeSignedOfferEvent({
    code: makeInviteCode({ network: "mainnet", noidAmount: "2500", ethAmount: "0.5", seed: 1 }),
    powBits: 8,
  });
  assert.equal(validateOfferEvent(goodMainnet, ctx).ok, true);

  const goodSepolia = makeSignedOfferEvent({
    d: "aabbccddeeff00112233445566778899",
    code: makeInviteCode({ network: "sepolia", noidAmount: "20", ethAmount: "0.01", seed: 2 }),
    note: "Sepolia \u202E\u200Btest\u3164 note\u0301\u0302\u0303\u0304",
    powBits: 8,
    useContentCarrier: true,
  });
  const sepRes = validateOfferEvent(goodSepolia, ctx);
  assert.equal(sepRes.ok, true);
  assert.equal(sepRes.offer.note, "Sepolia test note\u0301\u0302");

  // External event with raw ASCII control char (\u0007) signed directly -> sanitized cleanly
  const extPub = schnorrGetPublicKey(SK_MAKER_1);
  const extTpl = mineNip13Pow(
    {
      kind: OFFER_KIND,
      created_at: BASE_NOW_SEC - 60,
      tags: [
        ["d", "99887766554433221100ffeeddccbbaa"],
        ["t", PUBLIC_WEB_BOARD_TAG],
        ["expiration", String(BASE_NOW_SEC + 3600)],
        ["status", "open"],
        ["invite", makeInviteCode({ network: "sepolia", noidAmount: "5", ethAmount: "0.001", seed: 21 })],
        ["note", "Bell\u0007 stripped"],
      ],
      content: "",
    },
    extPub,
    8,
  );
  const extId = computeNostrEventId({ pubkey: extPub, ...extTpl });
  const extEv = { id: extId, pubkey: extPub, ...extTpl, sig: schnorrSign(extId, SK_MAKER_1, AUX_ZERO) };
  const extRes = validateOfferEvent(extEv, ctx);
  assert.equal(extRes.ok, true);
  assert.equal(extRes.offer.note, "Bell stripped");

  // Unpinned contract -> refused
  const unpinnedCode = makeInviteCode({
    network: "mainnet",
    contract: toChecksumAddress("0xdead00000000000000000000000000000000beef"),
    seed: 3,
  });
  const unpinnedEv = makeSignedOfferEvent({ code: unpinnedCode, powBits: 8 });
  assert.equal(validateOfferEvent(unpinnedEv, ctx).ok, false);

  // Over-cap mainnet (2501 NOID & 0.51 ETH), over-cap Sepolia (21 NOID & 0.011 ETH), and invalid mainnet contract_version 2
  const hostilePayloads = [
    {
      kind: "no1d-swap-invitation",
      v: 1,
      network: "mainnet",
      contract: NETWORK_SPECS.mainnet.pinnedContract,
      contract_version: 1,
      noid_micronoid: "2501000000", // > 2500 NOID
      eth_wei: "100000000000000000",
      bob_noid: makeTestNoidAddr(4),
      bob_eth: makeTestEthAddr(4),
    },
    {
      kind: "no1d-swap-invitation",
      v: 1,
      network: "mainnet",
      contract: NETWORK_SPECS.mainnet.pinnedContract,
      contract_version: 1,
      noid_micronoid: "100000000",
      eth_wei: "510000000000000000", // > 0.5 ETH
      bob_noid: makeTestNoidAddr(4),
      bob_eth: makeTestEthAddr(4),
    },
    {
      kind: "no1d-swap-invitation",
      v: 1,
      network: "mainnet",
      contract: NETWORK_SPECS.mainnet.pinnedContract,
      contract_version: 2, // invalid for mainnet (only v1 allowed)
      noid_micronoid: "100000000",
      eth_wei: "100000000000000000",
      bob_noid: makeTestNoidAddr(4),
      bob_eth: makeTestEthAddr(4),
    },
    {
      kind: "no1d-swap-invitation",
      v: 1,
      network: "sepolia",
      contract: NETWORK_SPECS.sepolia.pinnedContract,
      contract_version: 1,
      noid_micronoid: "21000000", // > 20 NOID
      eth_wei: "5000000000000000",
      bob_noid: makeTestNoidAddr(5),
      bob_eth: makeTestEthAddr(5),
    },
    {
      kind: "no1d-swap-invitation",
      v: 1,
      network: "sepolia",
      contract: NETWORK_SPECS.sepolia.pinnedContract,
      contract_version: 1,
      noid_micronoid: "10000000",
      eth_wei: "11000000000000000", // > 0.01 ETH
      bob_noid: makeTestNoidAddr(5),
      bob_eth: makeTestEthAddr(5),
    },
  ];
  for (const rawObj of hostilePayloads) {
    const hostileEv = makeSignedOfferEvent({ code: makeChecksummedCodeFromRawObj(rawObj), powBits: 8 });
    assert.equal(validateOfferEvent(hostileEv, ctx).ok, false);
  }

  // Expired offer -> refused
  const expiredEv = makeSignedOfferEvent({
    createdAt: BASE_NOW_SEC - 7200,
    expiration: BASE_NOW_SEC - 10,
    powBits: 8,
  });
  assert.equal(validateOfferEvent(expiredEv, ctx).ok, false);

  // > 5 min future created_at -> refused
  const futureEv = makeSignedOfferEvent({
    createdAt: BASE_NOW_SEC + 301,
    expiration: BASE_NOW_SEC + 3600,
    powBits: 8,
  });
  assert.equal(validateOfferEvent(futureEv, ctx).ok, false);

  // Insufficient PoW -> refused
  const lowPowEv = makeSignedOfferEvent({ powBits: 4 });
  assert.equal(validateOfferEvent(lowPowEv, ctx).ok, false);

  // Bad signature -> refused
  const badSigEv = { ...goodMainnet, sig: "f".repeat(128) };
  assert.equal(validateOfferEvent(badSigEv, ctx).ok, false);
});

test("aggregateNostrEvents handles liveness heartbeats, copied offers across pubkeys, repeated Bob addresses, replacements, and NIP-09 deletions", () => {
  const sharedCode = makeInviteCode({ network: "mainnet", noidAmount: "500", ethAmount: "0.1", seed: 10 });
  const sameBobCode = makeInviteCode({
    network: "mainnet",
    noidAmount: "700",
    ethAmount: "0.14",
    bobNoid: makeTestNoidAddr(10), // same bob_noid as sharedCode
    bobEth: makeTestEthAddr(11),
  });
  const withdrawnCode = makeInviteCode({ network: "sepolia", noidAmount: "5", ethAmount: "0.001", seed: 12 });
  const deletedCode = makeInviteCode({ network: "sepolia", noidAmount: "10", ethAmount: "0.002", seed: 13 });

  // Maker 1 posts sharedCode 3 hours ago (would be stale without heartbeat)
  const offer1 = makeSignedOfferEvent({
    secretKey: SK_MAKER_1,
    d: "11111111111111111111111111111111",
    code: sharedCode,
    createdAt: BASE_NOW_SEC - 3 * 3600,
    expiration: BASE_NOW_SEC + 3600,
    powBits: 6,
  });
  // Maker 1 sends fresh signed heartbeat 2 min ago -> upgrades offer1 to "online" with has_heartbeat: true
  const hb1 = makeSignedHeartbeatEvent({
    secretKey: SK_MAKER_1,
    d: "heartbeat",
    createdAt: BASE_NOW_SEC - 120,
  });

  // Maker 2 copies identical sharedCode 30 min ago (copy across pubkeys!)
  const offer2Copy = makeSignedOfferEvent({
    secretKey: SK_MAKER_2,
    d: "22222222222222222222222222222222",
    code: sharedCode,
    createdAt: BASE_NOW_SEC - 1800,
    expiration: BASE_NOW_SEC + 3600,
    powBits: 6,
  });

  // Maker 3 posts different terms reusing Bob's NOID address 3 hours ago (stale, no heartbeat)
  const offer3SameBob = makeSignedOfferEvent({
    secretKey: SK_MAKER_3,
    d: "33333333333333333333333333333333",
    code: sameBobCode,
    createdAt: BASE_NOW_SEC - 3 * 3600,
    expiration: BASE_NOW_SEC + 3600,
    powBits: 6,
  });

  // Maker 1 posts offer4 then withdraws it via newer status="closed" replacement
  const offer4Open = makeSignedOfferEvent({
    secretKey: SK_MAKER_1,
    d: "44444444444444444444444444444444",
    code: withdrawnCode,
    createdAt: BASE_NOW_SEC - 600,
    expiration: BASE_NOW_SEC + 3600,
    powBits: 6,
  });
  const offer4Closed = makeSignedOfferEvent({
    secretKey: SK_MAKER_1,
    d: "44444444444444444444444444444444",
    code: "",
    status: "closed",
    createdAt: BASE_NOW_SEC - 300,
    expiration: BASE_NOW_SEC + 300,
    powBits: 6,
  });

  // Maker 2 posts offer5 then deletes it via NIP-09 kind 5; Maker 3 tries to delete offer1 (must be ignored!)
  const offer5Open = makeSignedOfferEvent({
    secretKey: SK_MAKER_2,
    d: "55555555555555555555555555555555",
    code: deletedCode,
    createdAt: BASE_NOW_SEC - 600,
    expiration: BASE_NOW_SEC + 3600,
    powBits: 6,
  });
  const del5Own = finalizeNostrEvent(
    {
      kind: DELETION_KIND,
      created_at: BASE_NOW_SEC - 100,
      tags: [
        ["e", offer5Open.id],
        ["k", String(OFFER_KIND)],
      ],
      content: "",
    },
    SK_MAKER_2,
    { auxRand: AUX_ZERO },
  );
  const del1Spoofed = finalizeNostrEvent(
    {
      kind: DELETION_KIND,
      created_at: BASE_NOW_SEC - 50,
      tags: [
        ["e", offer1.id],
        ["k", String(OFFER_KIND)],
      ],
      content: "",
    },
    SK_MAKER_3,
    { auxRand: AUX_ZERO },
  );

  const { offers } = aggregateNostrEvents(
    [offer1, hb1, offer2Copy, offer3SameBob, offer4Open, offer4Closed, offer5Open, del5Own, del1Spoofed].map(
      (event) => ({ event, relayUrl: "wss://relay.primal.net" }),
    ),
    { nowMs: BASE_NOW_MS, minPowBits: 6 },
  );

  // offer4 (closed) and offer5 (deleted by owner) are gone; offer1 survives spoofed deletion
  assert.equal(offers.length, 3);
  const byId = new Map(offers.map((o) => [o.event_id, o]));
  assert.ok(byId.has(offer1.id));
  assert.ok(byId.has(offer2Copy.id));
  assert.ok(byId.has(offer3SameBob.id));
  assert.equal(byId.has(offer4Open.id), false);
  assert.equal(byId.has(offer5Open.id), false);

  // Liveness verification
  assert.equal(byId.get(offer1.id).liveness.status, "online");
  assert.equal(byId.get(offer1.id).liveness.has_heartbeat, true);
  assert.equal(byId.get(offer2Copy.id).liveness.status, "recent");
  assert.equal(byId.get(offer2Copy.id).liveness.has_heartbeat, false);
  assert.equal(byId.get(offer3SameBob.id).liveness.status, "stale");

  // Neutral duplicate payload flags across pubkeys (no self-declared earliest/copy blame)
  const o1 = byId.get(offer1.id);
  const o2 = byId.get(offer2Copy.id);
  const o3 = byId.get(offer3SameBob.id);
  assert.equal(o1.flags.duplicate_payload, true);
  assert.equal(o1.flags.duplicate_count, 2);
  assert.equal(o1.flags.distinct_pubkeys, 2);
  assert.equal(o2.flags.duplicate_payload, true);
  assert.equal(o2.flags.duplicate_count, 2);
  assert.equal(o2.flags.distinct_pubkeys, 2);
  assert.equal(o3.flags.duplicate_payload, false);
  assert.equal(o3.flags.duplicate_count, 1);
  assert.equal(o3.flags.distinct_pubkeys, 1);

  // Repeated Bob address flagged on all 3 sharing makeTestNoidAddr(10)
  assert.equal(o1.flags.repeated_bob_address, true);
  assert.equal(o2.flags.repeated_bob_address, true);
  assert.equal(o3.flags.repeated_bob_address, true);
});

// ---------------------------------------------------------------------------
// 4. Relay Transport Bounds: Timeout, 1 MB Cap, Event Cap, Violations, Teardown
// ---------------------------------------------------------------------------

test("queryRelay enforces exact 10 s timeout, 1 MB cumulative cap, event cap, and clean socket teardown", async (t) => {
  const filters = buildBoardFilters({ nowSec: BASE_NOW_SEC });
  const goodEv = makeSignedOfferEvent({ powBits: 4 });

  // 1. Happy path: sends REQ, collects verified event, receives EOSE, sends CLOSE & closes socket
  const { FakeWebSocket: OkWS, instances: okInst } = makeMockWebSocketClass({
    "wss://relay.primal.net": {
      onCreate: (ws) => ws.onopen?.(),
      onSend: (ws, msg) => {
        const parsed = JSON.parse(msg);
        if (parsed[0] === "REQ") {
          const subId = parsed[1];
          ws.deliver(["EVENT", subId, goodEv]);
          ws.deliver(["EOSE", subId]);
        }
      },
    },
  });
  const okRes = await queryRelay("wss://relay.primal.net", filters, { WebSocketImpl: OkWS });
  assert.equal(okRes.ok, true);
  assert.equal(okRes.eose, true);
  assert.equal(okRes.events.length, 1);
  assert.equal(okInst[0].closed, true);
  assert.equal(JSON.parse(okInst[0].sent[0])[0], "REQ");
  assert.equal(JSON.parse(okInst[0].sent[1])[0], "CLOSE");

  // 2. Relay exceeding 1 MB cumulative byte cap truncates cleanly as ok:true, truncated:true (usable)
  const { FakeWebSocket: BigWS, instances: bigInst } = makeMockWebSocketClass({
    "wss://nos.lol": {
      onCreate: (ws) => ws.onopen?.(),
      onSend: (ws, msg) => {
        const parsed = JSON.parse(msg);
        if (parsed[0] === "REQ") {
          // Send 6 frames of 200 KB NOTICEs (> 1 MB cumulative)
          const bigNotice = JSON.stringify(["NOTICE", "x".repeat(200_000)]);
          for (let i = 0; i < 6; i++) ws.deliver(bigNotice);
        }
      },
    },
  });
  const bigRes = await queryRelay("wss://nos.lol", filters, { WebSocketImpl: BigWS });
  assert.equal(bigRes.ok, true);
  assert.equal(bigRes.truncated, true);
  assert.equal(bigRes.eose, false);
  assert.match(bigRes.reason, /1 MB|cap/i);
  assert.equal(bigInst[0].closed, true);

  // 3. Badly signed events are a poster-side drop: no violations, the relay stays ok and the valid offer is kept
  const { FakeWebSocket: BadSigWS, instances: badInst } = makeMockWebSocketClass({
    "wss://relay.snort.social": {
      onCreate: (ws) => ws.onopen?.(),
      onSend: (ws, msg) => {
        const parsed = JSON.parse(msg);
        if (parsed[0] === "REQ") {
          const subId = parsed[1];
          const forged = { ...goodEv, sig: "0".repeat(128) };
          for (let i = 0; i < 6; i++) ws.deliver(["EVENT", subId, forged]);
          ws.deliver(["EVENT", subId, goodEv]);
          ws.deliver(["EOSE", subId]);
        }
      },
    },
  });
  const badRes = await queryRelay("wss://relay.snort.social", filters, { WebSocketImpl: BadSigWS });
  assert.equal(badRes.ok, true);
  assert.equal(badRes.violations, 0);
  assert.equal(badRes.droppedPolicy, 6);
  assert.equal(badRes.events.length, 1);
  assert.equal(badRes.events[0].id, goodEv.id);
  assert.equal(badInst[0].closed, true);

  // 3b. Close code 1009 (frame too large) after one valid event: truncated but usable
  const { FakeWebSocket: BigFrameWS } = makeMockWebSocketClass({
    "wss://relay.big-frame.example": {
      onCreate: (ws) => ws.onopen?.(),
      onSend: (ws, msg) => {
        const parsed = JSON.parse(msg);
        if (parsed[0] === "REQ") {
          ws.deliver(["EVENT", parsed[1], goodEv]);
          ws.onerror?.(new Error("frame too large"));
          ws.onclose?.({ code: 1009 });
        }
      },
    },
  });
  const bigFrameRes = await queryRelay("wss://relay.big-frame.example", filters, { WebSocketImpl: BigFrameWS });
  assert.equal(bigFrameRes.ok, true);
  assert.equal(bigFrameRes.truncated, true);
  assert.equal(bigFrameRes.events.length, 1);
  assert.equal(bigFrameRes.events[0].id, goodEv.id);

  // 3c. Any other close before EOSE still fails the relay
  const { FakeWebSocket: EarlyCloseWS } = makeMockWebSocketClass({
    "wss://relay.early-close.example": {
      onCreate: (ws) => ws.onopen?.(),
      onSend: (ws, msg) => {
        const parsed = JSON.parse(msg);
        if (parsed[0] === "REQ") {
          ws.deliver(["EVENT", parsed[1], goodEv]);
          ws.onclose?.({ code: 1006 });
        }
      },
    },
  });
  const earlyRes = await queryRelay("wss://relay.early-close.example", filters, { WebSocketImpl: EarlyCloseWS });
  assert.equal(earlyRes.ok, false);
  assert.equal(earlyRes.truncated, false);
  assert.equal(earlyRes.reason, "socket closed before EOSE");

  // 4. Exact 10 s timeout via fake timers aborts hung relay and closes socket
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { FakeWebSocket: HungWS, instances: hungInst } = makeMockWebSocketClass({
    "wss://relay.primal.net": {
      onCreate: (ws) => ws.onopen?.(),
      onSend: () => {
        /* never replies */
      },
    },
  });
  let settled = false;
  const p = queryRelay("wss://relay.primal.net", filters, { WebSocketImpl: HungWS }).then((r) => {
    settled = true;
    return r;
  });
  await Promise.resolve();
  t.mock.timers.tick(RELAY_TIMEOUT_MS - 1);
  await Promise.resolve();
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  const timeoutRes = await p;
  assert.equal(timeoutRes.ok, false);
  assert.equal(timeoutRes.reason, "timeout");
  assert.equal(hungInst[0].closed, true);
});

// ---------------------------------------------------------------------------
// 5. End-to-End runUpdateOffers: Atomic Write, 10-Min Rate Limit, Fail-Closed
// ---------------------------------------------------------------------------

test("runUpdateOffers performs atomic write, enforces 10-minute rate limit, --force override, and preserves last-good file on total relay failure", async () => {
  const offer1 = makeSignedOfferEvent({
    secretKey: SK_MAKER_1,
    d: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    code: makeInviteCode({ network: "mainnet", noidAmount: "250", ethAmount: "0.05", seed: 30 }),
    powBits: 8,
  });

  const makeGoodRelayRunner = () => {
    let calls = 0;
    return {
      getCalls: () => calls,
      queryRelayImpl: async (url) => {
        calls += 1;
        return {
          url,
          ok: true,
          reason: null,
          events: [offer1],
          eventsReceived: 1,
          bytesReceived: 1024,
          violations: 0,
          eose: true,
        };
      },
    };
  };

  await withTempDir(async (dir) => {
    const outPath = path.join(dir, "offers.json");
    const runner = makeGoodRelayRunner();

    // 1. Happy path atomic write with zero leftover temp files
    const res1 = await runUpdateOffers({
      outputPath: outPath,
      relays: ["wss://relay.primal.net", "wss://nos.lol"],
      nowMs: BASE_NOW_MS,
      minPowBits: 8,
      queryRelayImpl: runner.queryRelayImpl,
    });
    assert.equal(res1.ok, true);
    assert.equal(res1.skipped, false);
    // 2 relays x (Pass 1 offers + Pass 2 author-scoped heartbeats/deletions) = 4 queries
    assert.equal(runner.getCalls(), 4);
    assert.deepEqual(await fs.readdir(dir), ["offers.json"]);

    const diskText = await fs.readFile(outPath, "utf8");
    const parsed = parseOffersSnapshot(diskText, BASE_NOW_MS);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.isSample, false);
    assert.equal(parsed.offers.length, 1);
    assert.equal(parsed.offers[0].eventId, offer1.id);
    assert.equal(parsed.offers[0].decoded.fields.noid_amount, "250");
    assert.equal(parsed.offers[0].decoded.fields.eth_amount, "0.05");

    // 2. Rate-limited within 10 min (9m59s later) -> skips all relays
    const resLimited = await runUpdateOffers({
      outputPath: outPath,
      relays: ["wss://relay.primal.net"],
      nowMs: BASE_NOW_MS + RATE_LIMIT_MS - 1000,
      minPowBits: 8,
      queryRelayImpl: async () => {
        throw new Error("must not query relays while rate-limited");
      },
    });
    assert.equal(resLimited.ok, true);
    assert.equal(resLimited.skipped, true);
    assert.equal(resLimited.reason, "rate_limited");
    assert.equal(await fs.readFile(outPath, "utf8"), diskText);

    // 3. Explicit force: true bypasses rate limit
    const resForced = await runUpdateOffers({
      outputPath: outPath,
      relays: ["wss://relay.primal.net"],
      nowMs: BASE_NOW_MS + 60_000,
      minPowBits: 8,
      force: true,
      queryRelayImpl: runner.queryRelayImpl,
    });
    assert.equal(resForced.ok, true);
    assert.equal(resForced.skipped, false);

    // 4. Tampered >5 min future or malformed generated_at MUST NOT rate-limit
    for (const badTs of ["2030-01-01T00:00:00Z", "2026-02-31T00:00:00Z", "not-a-ts"]) {
      await fs.writeFile(
        outPath,
        `${JSON.stringify({ v: 1, generated_at: badTs, offers: [] })}\n`,
        "utf8",
      );
      const resRecover = await runUpdateOffers({
        outputPath: outPath,
        relays: ["wss://relay.primal.net"],
        nowMs: BASE_NOW_MS,
        minPowBits: 8,
        queryRelayImpl: runner.queryRelayImpl,
      });
      assert.equal(resRecover.ok, true);
      assert.equal(resRecover.skipped, false);
    }

    // 5. All relays fail -> preserves previous offers.json byte-for-byte untouched
    const sentinel = await fs.readFile(outPath, "utf8");
    const resFail = await runUpdateOffers({
      outputPath: outPath,
      relays: ["wss://relay.primal.net", "wss://nos.lol"],
      nowMs: BASE_NOW_MS + RATE_LIMIT_MS + 1000,
      minPowBits: 8,
      queryRelayImpl: async (url) => ({
        url,
        ok: false,
        reason: "timeout",
        events: [],
        eventsReceived: 0,
        bytesReceived: 0,
        violations: 0,
        eose: false,
      }),
    });
    assert.equal(resFail.ok, false);
    assert.equal(resFail.reason, "all_relays_failed");
    assert.equal(await fs.readFile(outPath, "utf8"), sentinel);
    assert.deepEqual(await fs.readdir(dir), ["offers.json"]);
  });
});

test("CLI entry supports --help and exits 0 cleanly on rate-limited file without hitting network", async () => {
  const { stdout: helpOut } = await execFileAsync(process.execPath, [SCRIPT_PATH, "--help"]);
  assert.match(helpOut, /--out/);
  assert.match(helpOut, /--relays/);
  assert.match(helpOut, /--min-pow/);
  assert.match(helpOut, /--force/);

  await withTempDir(async (dir) => {
    const outPath = path.join(dir, "offers.json");
    const freshIso = new Date(Date.now() - 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
    const freshPayload = `${JSON.stringify({ v: 1, generated_at: freshIso, offers: [] })}\n`;
    await fs.writeFile(outPath, freshPayload, "utf8");

    const { stdout } = await execFileAsync(process.execPath, [SCRIPT_PATH, "--out", outPath]);
    assert.deepEqual(JSON.parse(stdout.trim()), { skipped: true, reason: "rate_limited" });
    assert.equal(await fs.readFile(outPath, "utf8"), freshPayload);
  });
});

test("Hardening regressions: binary WS frame byte-cap/disconnect, heartbeat tag & status validation, and verified-only relay attribution", async () => {
  const filters = buildBoardFilters({ nowSec: BASE_NOW_SEC });

  // 1a. Oversize binary WS frame (> 256 KB) is caught by frame byte cap and closes immediately
  const { FakeWebSocket: BigBinWS, instances: bigBinInst } = makeMockWebSocketClass({
    "wss://relay.primal.net": {
      onCreate: (ws) => ws.onopen?.(),
      onSend: (ws, msg) => {
        if (JSON.parse(msg)[0] === "REQ") {
          ws.deliverRaw(new Uint8Array(300_000));
        }
      },
    },
  });
  const bigBinRes = await queryRelay("wss://relay.primal.net", filters, { WebSocketImpl: BigBinWS });
  assert.equal(bigBinRes.ok, false);
  assert.match(bigBinRes.reason, /frame exceeds byte cap/i);
  assert.equal(bigBinInst[0].closed, true);

  // 1b. Small binary WS frame is counted in bytesReceived and closes immediately as non-text
  const { FakeWebSocket: SmallBinWS, instances: smallBinInst } = makeMockWebSocketClass({
    "wss://nos.lol": {
      onCreate: (ws) => ws.onopen?.(),
      onSend: (ws, msg) => {
        if (JSON.parse(msg)[0] === "REQ") {
          ws.deliverRaw(new Uint8Array(128));
        }
      },
    },
  });
  const smallBinRes = await queryRelay("wss://nos.lol", filters, { WebSocketImpl: SmallBinWS });
  assert.equal(smallBinRes.ok, false);
  assert.equal(smallBinRes.reason, "non-text frame");
  assert.equal(smallBinRes.bytesReceived, 128);
  assert.equal(smallBinInst[0].closed, true);

  // 2. Heartbeat tag-bypass & status interop checks
  const makeHbWithTags = (tags) =>
    finalizeNostrEvent(
      { kind: HEARTBEAT_KIND, created_at: BASE_NOW_SEC - 30, tags, content: "" },
      SK_MAKER_1,
      { auxRand: AUX_ZERO },
    );
  const hbCtx = { nowSec: BASE_NOW_SEC };

  // Valid online heartbeat (compatible with maker-bot status tag)
  assert.equal(
    validateHeartbeatEvent(
      makeHbWithTags([
        ["d", "heartbeat"],
        ["t", PUBLIC_WEB_BOARD_TAG],
        ["status", "online"],
        ["expiration", String(BASE_NOW_SEC + 600)],
      ]),
      hbCtx,
    ).ok,
    true,
  );
  // Duplicate expiration tags (attempt to bypass expired timestamp) -> rejected
  assert.equal(
    validateHeartbeatEvent(
      makeHbWithTags([
        ["d", "heartbeat"],
        ["t", PUBLIC_WEB_BOARD_TAG],
        ["expiration", String(BASE_NOW_SEC - 10)],
        ["expiration", String(BASE_NOW_SEC + 600)],
      ]),
      hbCtx,
    ).ok,
    false,
  );
  // Extra element on expiration tag -> rejected
  assert.equal(
    validateHeartbeatEvent(
      makeHbWithTags([
        ["d", "heartbeat"],
        ["t", PUBLIC_WEB_BOARD_TAG],
        ["expiration", String(BASE_NOW_SEC - 10), "extra"],
      ]),
      hbCtx,
    ).ok,
    false,
  );
  // Duplicate d tags -> rejected
  assert.equal(
    validateHeartbeatEvent(
      makeHbWithTags([
        ["d", "heartbeat"],
        ["d", "11111111111111111111111111111111"],
        ["t", PUBLIC_WEB_BOARD_TAG],
      ]),
      hbCtx,
    ).ok,
    false,
  );
  // Paused or offline status heartbeats are accepted as NIP-33 tombstones (never upgrade maker to online),
  // while unknown status values are rejected.
  for (const nonOnlineStatus of ["paused", "offline"]) {
    const nonOnlineHb = makeHbWithTags([
      ["d", "heartbeat"],
      ["t", PUBLIC_WEB_BOARD_TAG],
      ["status", nonOnlineStatus],
      ["expiration", String(BASE_NOW_SEC + 600)],
    ]);
    const res = validateHeartbeatEvent(nonOnlineHb, hbCtx);
    assert.equal(res.ok, true);
    assert.equal(res.heartbeat.status, nonOnlineStatus);
  }
  assert.equal(
    validateHeartbeatEvent(
      makeHbWithTags([
        ["d", "heartbeat"],
        ["t", PUBLIC_WEB_BOARD_TAG],
        ["status", "bogus"],
        ["expiration", String(BASE_NOW_SEC + 600)],
      ]),
      hbCtx,
    ).ok,
    false,
  );

  // 3. Unverified relay attribution: forged event reusing valid offer's ev.id cannot inject relay URL
  const validOffer = makeSignedOfferEvent({
    secretKey: SK_MAKER_1,
    d: "1234567890abcdef1234567890abcdef",
    code: makeInviteCode({ network: "mainnet", noidAmount: "100", ethAmount: "0.02", seed: 44 }),
    createdAt: BASE_NOW_SEC - 3 * 3600,
    expiration: BASE_NOW_SEC + 3600,
    powBits: 6,
  });
  const forgedSameId = { ...validOffer, sig: "0".repeat(128) };
  const pausedHb = makeHbWithTags([
    ["d", "heartbeat"],
    ["t", PUBLIC_WEB_BOARD_TAG],
    ["status", "paused"],
    ["expiration", String(BASE_NOW_SEC + 600)],
  ]);

  const { offers } = aggregateNostrEvents(
    [
      { event: forgedSameId, relayUrl: "wss://hostile.relay.example" },
      { event: validOffer, relayUrl: "wss://relay.primal.net" },
      { event: pausedHb, relayUrl: "wss://relay.primal.net" },
    ],
    { nowMs: BASE_NOW_MS, minPowBits: 6 },
  );
  assert.equal(offers.length, 1);
  assert.deepEqual(offers[0].relays, ["wss://relay.primal.net"]);
  // Paused heartbeat was rejected so 3-hour-old offer remains stale
  assert.equal(offers[0].liveness.status, "stale");
  assert.equal(offers[0].liveness.has_heartbeat, false);
});

test("Audit regressions: truncation fail-closed, PoW spam resistance, frame cap, failed-relay exclusion, tombstones, e-tag skew, bob_eth checks, and sample rate-limit", async () => {
  const filters = buildBoardFilters({ nowSec: BASE_NOW_SEC });

  // 1. queryRelay fails closed when maxEvents is reached before EOSE, AND drops zero-PoW offer spam without consuming slots or violations
  const zeroPowSpam = [1, 2, 3, 4].map((i) =>
    makeSignedOfferEvent({
      secretKey: SK_MAKER_2,
      d: String(i).repeat(32),
      code: makeInviteCode({ network: "sepolia", noidAmount: "5", ethAmount: "0.001", seed: 60 + i }),
      powBits: 0,
    }),
  );
  const validPowOffer = makeSignedOfferEvent({
    secretKey: SK_MAKER_1,
    d: "f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0",
    code: makeInviteCode({ network: "mainnet", noidAmount: "100", ethAmount: "0.02", seed: 70 }),
    powBits: 8,
  });
  const validPowOffer2 = makeSignedOfferEvent({
    secretKey: SK_MAKER_3,
    d: "e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0",
    code: makeInviteCode({ network: "mainnet", noidAmount: "120", ethAmount: "0.024", seed: 71 }),
    powBits: 8,
  });

  // 1a. 4 zero-PoW spam events + 1 valid 8-bit PoW offer with maxEvents=1 -> succeeds with only the valid PoW offer and 0 violations
  const { FakeWebSocket: SpamFilterWS } = makeMockWebSocketClass({
    "wss://nos.lol": {
      onCreate: (ws) => ws.onopen?.(),
      onSend: (ws, msg) => {
        const parsed = JSON.parse(msg);
        if (parsed[0] === "REQ") {
          const subId = parsed[1];
          for (const spam of zeroPowSpam) ws.deliver(["EVENT", subId, spam]);
          ws.deliver(["EVENT", subId, validPowOffer]);
          // Duplicate delivery of validPowOffer must not double-count eventsReceived
          ws.deliver(["EVENT", subId, validPowOffer]);
          ws.deliver(["EOSE", subId]);
        }
      },
    },
  });
  const spamRes = await queryRelay("wss://nos.lol", filters, {
    WebSocketImpl: SpamFilterWS,
    maxEvents: 1,
    minPowBits: 8,
  });
  assert.equal(spamRes.ok, true);
  assert.equal(spamRes.eose, true);
  assert.equal(spamRes.violations, 0);
  assert.equal(spamRes.events.length, 1);
  assert.equal(spamRes.events[0].id, validPowOffer.id);
  assert.equal(spamRes.eventsReceived, 5); // 4 unique spam + 1 unique valid (duplicate ignored)

  // 1b. Exceeding maxEvents before EOSE truncates cleanly as ok:true, truncated:true (usable, not fatal)
  const { FakeWebSocket: TruncWS, instances: truncInst } = makeMockWebSocketClass({
    "wss://relay.primal.net": {
      onCreate: (ws) => ws.onopen?.(),
      onSend: (ws, msg) => {
        const parsed = JSON.parse(msg);
        if (parsed[0] === "REQ") {
          const subId = parsed[1];
          ws.deliver(["EVENT", subId, validPowOffer]);
          ws.deliver(["EVENT", subId, validPowOffer2]);
          ws.deliver(["EOSE", subId]);
        }
      },
    },
  });
  const offerOnlyFilter = buildOfferFilter({ nowSec: BASE_NOW_SEC });
  const truncRes = await queryRelay("wss://relay.primal.net", offerOnlyFilter, {
    WebSocketImpl: TruncWS,
    maxEvents: 1,
    minPowBits: 8,
  });
  assert.equal(truncRes.ok, true);
  assert.equal(truncRes.truncated, true);
  assert.equal(truncRes.eose, false);
  assert.equal(truncRes.events.length, 1);
  assert.match(truncRes.reason, /event cap reached/i);
  assert.equal(truncInst[0].closed, true);

  // 2. Non-violation frame flood (NOTICE / wrong subId) hits maxFrames cap and truncates cleanly
  const { FakeWebSocket: FloodWS, instances: floodInst } = makeMockWebSocketClass({
    "wss://relay.snort.social": {
      onCreate: (ws) => ws.onopen?.(),
      onSend: (ws, msg) => {
        if (JSON.parse(msg)[0] === "REQ") {
          for (let i = 0; i < 15; i++) ws.deliver(["NOTICE", "ping"]);
        }
      },
    },
  });
  const floodRes = await queryRelay("wss://relay.snort.social", filters, {
    WebSocketImpl: FloodWS,
    maxFrames: 10,
  });
  assert.equal(floodRes.ok, true);
  assert.equal(floodRes.truncated, true);
  assert.match(floodRes.reason, /frame count cap/i);
  assert.equal(floodInst[0].closed, true);

  // 3. Expired "closed" tombstone still supersedes older unexpired "open" offer (prevents resurrection)
  const longOpen = makeSignedOfferEvent({
    secretKey: SK_MAKER_1,
    d: "abababababababababababababababab",
    code: makeInviteCode({ network: "mainnet", noidAmount: "150", ethAmount: "0.03", seed: 72 }),
    createdAt: BASE_NOW_SEC - 3600,
    expiration: BASE_NOW_SEC + 20 * 3600,
    powBits: 6,
    status: "open",
  });
  const expiredClosedTombstone = makeSignedOfferEvent({
    secretKey: SK_MAKER_1,
    d: "abababababababababababababababab",
    code: "",
    createdAt: BASE_NOW_SEC - 1800,
    expiration: BASE_NOW_SEC - 1500, // expired 25 min ago, still within 24h maxOfferAgeSeconds
    powBits: 6,
    status: "closed",
  });
  const tombAgg = aggregateNostrEvents(
    [
      { event: longOpen, relayUrl: "wss://nos.lol" },
      { event: expiredClosedTombstone, relayUrl: "wss://relay.primal.net" },
    ],
    { nowMs: BASE_NOW_MS, minPowBits: 6 },
  );
  assert.equal(tombAgg.offers.length, 0);

  // 4. Newer "paused" / "offline" heartbeat (including expired tombstone) supersedes older "online" heartbeat on (pubkey, d)
  const staleOfferForHb = makeSignedOfferEvent({
    secretKey: SK_MAKER_2,
    d: "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
    code: makeInviteCode({ network: "mainnet", noidAmount: "150", ethAmount: "0.03", seed: 73 }),
    createdAt: BASE_NOW_SEC - 3 * 3600,
    expiration: BASE_NOW_SEC + 3600,
    powBits: 6,
  });
  const olderOnlineHb = makeSignedHeartbeatEvent({
    secretKey: SK_MAKER_2,
    d: "heartbeat",
    createdAt: BASE_NOW_SEC - 300,
    expiration: BASE_NOW_SEC + 600,
  });
  const newerPausedHbExpired = finalizeNostrEvent(
    {
      kind: HEARTBEAT_KIND,
      created_at: BASE_NOW_SEC - 120,
      tags: [
        ["d", "heartbeat"],
        ["t", PUBLIC_WEB_BOARD_TAG],
        ["status", "paused"],
        ["expiration", String(BASE_NOW_SEC - 10)],
      ],
      content: "",
    },
    SK_MAKER_2,
    { auxRand: AUX_ZERO },
  );
  const hbAgg = aggregateNostrEvents(
    [
      { event: staleOfferForHb, relayUrl: "wss://nos.lol" },
      { event: olderOnlineHb, relayUrl: "wss://nos.lol" },
      { event: newerPausedHbExpired, relayUrl: "wss://relay.primal.net" },
    ],
    { nowMs: BASE_NOW_MS, minPowBits: 6 },
  );
  assert.equal(hbAgg.offers.length, 1);
  assert.equal(hbAgg.offers[0].liveness.status, "stale");
  assert.equal(hbAgg.offers[0].liveness.has_heartbeat, false);

  // 5. NIP-09 e-tag deletion with clock skew (del.created_at < offer.created_at) still deletes the offer
  const skewOffer = makeSignedOfferEvent({
    secretKey: SK_MAKER_3,
    d: "efefefefefefefefefefefefefefefef",
    code: makeInviteCode({ network: "sepolia", noidAmount: "10", ethAmount: "0.002", seed: 74 }),
    createdAt: BASE_NOW_SEC + 60,
    expiration: BASE_NOW_SEC + 3600,
    powBits: 6,
  });
  const skewDelE = finalizeNostrEvent(
    {
      kind: DELETION_KIND,
      created_at: BASE_NOW_SEC, // earlier than skewOffer.created_at
      tags: [
        ["e", skewOffer.id],
        ["k", String(OFFER_KIND)],
      ],
      content: "",
    },
    SK_MAKER_3,
    { auxRand: AUX_ZERO },
  );
  const skewDelAgg = aggregateNostrEvents(
    [
      { event: skewOffer, relayUrl: "wss://nos.lol" },
      { event: skewDelE, relayUrl: "wss://nos.lol" },
    ],
    { nowMs: BASE_NOW_MS, minPowBits: 6 },
  );
  assert.equal(skewDelAgg.offers.length, 0);

  // 6. bob_eth === contract and bob_eth === 0x0000...0000 are rejected by validateOfferEvent
  for (const badBobEth of [
    NETWORK_SPECS.mainnet.pinnedContract,
    "0x0000000000000000000000000000000000000000",
  ]) {
    const badCode = makeChecksummedCodeFromRawObj({
      kind: "no1d-swap-invitation",
      v: 1,
      network: "mainnet",
      contract: NETWORK_SPECS.mainnet.pinnedContract,
      contract_version: 1,
      noid_micronoid: "100000000",
      eth_wei: "20000000000000000",
      bob_noid: makeTestNoidAddr(75),
      bob_eth: badBobEth,
    });
    const badEv = makeSignedOfferEvent({ code: badCode, powBits: 6 });
    assert.equal(validateOfferEvent(badEv, { nowSec: BASE_NOW_SEC, minPowBits: 6 }).ok, false);
  }

  // 7. checkNip13Pow fails closed on invalid minBits (NaN, negative, non-integer, > 256)
  for (const badMin of [Number.NaN, -1, 1.5, 257, "16"]) {
    assert.equal(checkNip13Pow(validPowOffer, badMin).ok, false);
  }

  // 8. runUpdateOffers excludes partial events from failed relays AND does not rate-limit on sample:true AND accepts --output alias
  await withTempDir(async (dir) => {
    const outPath = path.join(dir, "offers.json");
    // Fresh sample:true file MUST NOT trigger rate limit
    const freshSampleIso = new Date(BASE_NOW_MS - 30_000).toISOString().replace(/\.\d{3}Z$/, "Z");
    await fs.writeFile(
      outPath,
      `${JSON.stringify({ v: 1, sample: true, generated_at: freshSampleIso, offers: [] })}\n`,
      "utf8",
    );

    const runRes = await runUpdateOffers({
      outputPath: outPath,
      relays: ["wss://nos.lol", "wss://relay.primal.net"],
      nowMs: BASE_NOW_MS,
      minPowBits: 8,
      queryRelayImpl: async (url) => {
        if (url === "wss://nos.lol") {
          return {
            url,
            ok: true,
            reason: null,
            events: [validPowOffer],
            eventsReceived: 1,
            bytesReceived: 512,
            violations: 0,
            eose: true,
          };
        }
        // Failed relay still carries partial validPowOffer2 — MUST be ignored!
        return {
          url,
          ok: false,
          reason: "too many violations",
          events: [validPowOffer2],
          eventsReceived: 1,
          bytesReceived: 512,
          violations: 5,
          eose: false,
        };
      },
    });
    assert.equal(runRes.ok, true);
    assert.equal(runRes.skipped, false);
    assert.equal(runRes.payload.offers.length, 1);
    assert.equal(runRes.payload.offers[0].event_id, validPowOffer.id);
    assert.deepEqual(runRes.payload.offers[0].relays, ["wss://nos.lol"]);
    const failedSummary = runRes.payload.relays.find((r) => r.url === "wss://relay.primal.net");
    assert.equal(failedSummary.ok, false);
    assert.equal(failedSummary.events_accepted, 0);
    assert.equal(failedSummary.truncated, false);
    assert.equal(runRes.payload.relays.find((r) => r.url === "wss://nos.lol").truncated, false);

    // CLI --output alias works identically to --out (now rate-limited by the live snapshot just written)
    const freshNowIso = new Date(Date.now() - 30_000).toISOString().replace(/\.\d{3}Z$/, "Z");
    await fs.writeFile(
      outPath,
      `${JSON.stringify({ v: 1, sample: false, generated_at: freshNowIso, offers: [] })}\n`,
      "utf8",
    );
    const { stdout } = await execFileAsync(process.execPath, [SCRIPT_PATH, "--output", outPath]);
    assert.deepEqual(JSON.parse(stdout.trim()), { skipped: true, reason: "rate_limited" });
  });
});

// ---------------------------------------------------------------------------
// 6. DoS Resilience (a/b/c), Pagination, Replacement-Before-Expiry & Real WS
// ---------------------------------------------------------------------------

test("DoS resilience (a/b/c): poster-side failures never kill relays, per-filter & author-scoped pass-2 budgets, and truncated-but-usable byte cap", async () => {
  const offerFilter = buildOfferFilter({ nowSec: BASE_NOW_SEC });
  const validOffer = makeSignedOfferEvent({
    secretKey: SK_MAKER_1,
    d: "0102030405060708090a0b0c0d0e0f10",
    code: makeInviteCode({ network: "mainnet", noidAmount: "200", ethAmount: "0.04", seed: 81 }),
    createdAt: BASE_NOW_SEC - 120,
    expiration: BASE_NOW_SEC + 3600,
    powBits: 8,
  });

  // (a) 6 signed oversize (>64 KB), 6 signed shape-invalid (>32 KB content), 6 signed off-filter,
  //     and 6 zero-PoW events MUST be dropped with 0 violations so a poster cannot fail any relay.
  const oversizeContent = "a".repeat(33_000);
  const bigShapeEvents = Array.from({ length: 6 }, (_, i) => {
    const pub = schnorrGetPublicKey(SK_MAKER_2);
    const tpl = {
      kind: OFFER_KIND,
      created_at: BASE_NOW_SEC - 60 - i,
      tags: [["d", String(i + 1).repeat(32)], ["t", PUBLIC_WEB_BOARD_TAG]],
      content: oversizeContent,
    };
    const id = computeNostrEventId({ pubkey: pub, ...tpl });
    return { id, pubkey: pub, ...tpl, sig: schnorrSign(id, SK_MAKER_2, AUX_ZERO) };
  });
  const hugeEvent66k = (() => {
    const pub = schnorrGetPublicKey(SK_MAKER_2);
    const tpl = {
      kind: OFFER_KIND,
      created_at: BASE_NOW_SEC - 30,
      tags: [["d", "7".repeat(32)], ["t", PUBLIC_WEB_BOARD_TAG]],
      content: "b".repeat(66_000),
    };
    const id = computeNostrEventId({ pubkey: pub, ...tpl });
    return { id, pubkey: pub, ...tpl, sig: schnorrSign(id, SK_MAKER_2, AUX_ZERO) };
  })();
  const offFilterEvents = Array.from({ length: 6 }, (_, i) =>
    finalizeNostrEvent(
      {
        kind: 1, // text note, not matching OFFER_KIND
        created_at: BASE_NOW_SEC - 50 - i,
        tags: [["t", "unrelated"]],
        content: `off-filter ${i}`,
      },
      SK_MAKER_2,
      { auxRand: AUX_ZERO },
    ),
  );
  const lowPowEvents = Array.from({ length: 6 }, (_, i) =>
    makeSignedOfferEvent({
      secretKey: SK_MAKER_2,
      d: `aa00${String(i).padStart(28, "0")}`,
      code: makeInviteCode({ network: "sepolia", noidAmount: "5", ethAmount: "0.001", seed: 82 + i }),
      powBits: 0,
    }),
  );

  const { FakeWebSocket: PolicySpamWS } = makeMockWebSocketClass({
    "wss://nos.lol": {
      onCreate: (ws) => ws.onopen?.(),
      onSend: (ws, msg) => {
        const parsed = JSON.parse(msg);
        if (parsed[0] === "REQ") {
          const subId = parsed[1];
          for (const ev of [...bigShapeEvents, hugeEvent66k, ...offFilterEvents, ...lowPowEvents]) {
            ws.deliver(["EVENT", subId, ev]);
          }
          ws.deliver(["EVENT", subId, validOffer]);
          ws.deliver(["EOSE", subId]);
        }
      },
    },
  });
  const resA = await queryRelay("wss://nos.lol", offerFilter, {
    WebSocketImpl: PolicySpamWS,
    minPowBits: 8,
  });
  assert.equal(resA.ok, true);
  assert.equal(resA.eose, true);
  assert.equal(resA.violations, 0);
  assert.ok(resA.droppedPolicy >= 19);
  assert.equal(resA.events.length, 1);
  assert.equal(resA.events[0].id, validOffer.id);

  // (b1) Independent per-filter event budgets: 5 heartbeats hitting maxEvents=2 on filter 0
  //      MUST NOT starve filter 1 deletions on the same subscription.
  const authorPk = schnorrGetPublicKey(SK_MAKER_1);
  const followupFilters = buildAuthorFollowupFilters({
    nowSec: BASE_NOW_SEC,
    authors: [authorPk],
    maxEventsPerRelay: 2,
  });
  const hbSpam = Array.from({ length: 5 }, (_, i) =>
    makeSignedHeartbeatEvent({
      secretKey: SK_MAKER_1,
      d: `0000000000000000000000000000000${i}`,
      createdAt: BASE_NOW_SEC - 10 - i,
    }),
  );
  const ownerDel = finalizeNostrEvent(
    {
      kind: DELETION_KIND,
      created_at: BASE_NOW_SEC - 5,
      tags: [
        ["e", validOffer.id],
        ["k", String(OFFER_KIND)],
      ],
      content: "",
    },
    SK_MAKER_1,
    { auxRand: AUX_ZERO },
  );
  const { FakeWebSocket: PerFilterWS } = makeMockWebSocketClass({
    "wss://relay.primal.net": {
      onCreate: (ws) => ws.onopen?.(),
      onSend: (ws, msg) => {
        const parsed = JSON.parse(msg);
        if (parsed[0] === "REQ") {
          const subId = parsed[1];
          for (const hb of hbSpam) ws.deliver(["EVENT", subId, hb]);
          ws.deliver(["EVENT", subId, ownerDel]);
          ws.deliver(["EOSE", subId]);
        }
      },
    },
  });
  const resB1 = await queryRelay("wss://relay.primal.net", followupFilters, {
    WebSocketImpl: PerFilterWS,
    maxEvents: 2,
  });
  assert.equal(resB1.ok, true);
  assert.equal(resB1.eose, true);
  assert.equal(resB1.truncated, true);
  assert.equal(resB1.events.filter((e) => e.kind === HEARTBEAT_KIND).length, 2);
  assert.equal(resB1.events.filter((e) => e.kind === DELETION_KIND).length, 1);

  // (b2) Two-pass author-scoped queries in runUpdateOffers: throwaway-key heartbeats/deletions
  //      never appear in Pass 1 (offers-only) and Pass 2 strictly pins `authors` to valid offer pubkeys.
  const hb1 = makeSignedHeartbeatEvent({
    secretKey: SK_MAKER_1,
    d: "heartbeat",
    createdAt: BASE_NOW_SEC - 60,
  });
  const seenReqs = [];
  const { FakeWebSocket: TwoPassWS } = makeMockWebSocketClass({
    "wss://nos.lol": {
      onCreate: (ws) => ws.onopen?.(),
      onSend: (ws, msg) => {
        const parsed = JSON.parse(msg);
        if (parsed[0] === "REQ") {
          const subId = parsed[1];
          const reqFilters = parsed.slice(2);
          seenReqs.push(reqFilters);
          if (reqFilters.some((f) => f.kinds.includes(OFFER_KIND))) {
            ws.deliver(["EVENT", subId, validOffer]);
          } else if (reqFilters.some((f) => f.kinds.includes(HEARTBEAT_KIND))) {
            assert.deepEqual(reqFilters[0].authors, [authorPk]);
            assert.deepEqual(reqFilters[1].authors, [authorPk]);
            ws.deliver(["EVENT", subId, hb1]);
          }
          ws.deliver(["EOSE", subId]);
        }
      },
    },
  });
  await withTempDir(async (dir) => {
    const outPath = path.join(dir, "offers.json");
    const resB2 = await runUpdateOffers({
      outputPath: outPath,
      relays: ["wss://nos.lol"],
      nowMs: BASE_NOW_MS,
      minPowBits: 8,
      WebSocketImpl: TwoPassWS,
    });
    assert.equal(resB2.ok, true);
    assert.equal(seenReqs.length, 2);
    assert.deepEqual(seenReqs[0][0].kinds, [OFFER_KIND]);
    assert.equal(resB2.payload.offers.length, 1);
    assert.equal(resB2.payload.offers[0].liveness.status, "online");
    assert.equal(resB2.payload.offers[0].liveness.has_heartbeat, true);
  });

  // (c) ~16 events of ~64 KB hitting the 1 MB byte cap truncate cleanly (ok:true, truncated:true)
  //     and runUpdateOffers still succeeds using the verified offers already received before the cap.
  const pad60k = "z".repeat(62_000);
  const filler64kEvents = Array.from({ length: 18 }, (_, i) => {
    const pub = schnorrGetPublicKey(SK_MAKER_3);
    const tpl = {
      kind: OFFER_KIND,
      created_at: BASE_NOW_SEC - 200 - i,
      tags: [["d", `bb${String(i).padStart(30, "0")}`], ["t", PUBLIC_WEB_BOARD_TAG]],
      content: pad60k,
    };
    const id = computeNostrEventId({ pubkey: pub, ...tpl });
    return { id, pubkey: pub, ...tpl, sig: schnorrSign(id, SK_MAKER_3, AUX_ZERO) };
  });
  const { FakeWebSocket: ByteCapWS } = makeMockWebSocketClass({
    "wss://nos.lol": {
      onCreate: (ws) => ws.onopen?.(),
      onSend: (ws, msg) => {
        const parsed = JSON.parse(msg);
        if (parsed[0] === "REQ") {
          const subId = parsed[1];
          const reqFilters = parsed.slice(2);
          if (reqFilters.some((f) => f.kinds.includes(OFFER_KIND))) {
            ws.deliver(["EVENT", subId, validOffer]);
            for (const f of filler64kEvents) ws.deliver(["EVENT", subId, f]);
          } else {
            ws.deliver(["EOSE", subId]);
          }
        }
      },
    },
  });
  await withTempDir(async (dir) => {
    const outPath = path.join(dir, "offers.json");
    const resC = await runUpdateOffers({
      outputPath: outPath,
      relays: ["wss://nos.lol"],
      nowMs: BASE_NOW_MS,
      minPowBits: 8,
      WebSocketImpl: ByteCapWS,
    });
    assert.equal(resC.ok, true);
    assert.equal(resC.relayResults[0].truncated, true);
    assert.equal(resC.payload.offers.length, 1);
    assert.equal(resC.payload.offers[0].event_id, validOffer.id);
    // Without a heartbeat, a 2-minute-old offer is "recent" (never "online")
    assert.equal(resC.payload.offers[0].liveness.has_heartbeat, false);
    assert.equal(resC.payload.offers[0].liveness.status, "recent");
  });
});

test("Pagination (until), expired open replacement-before-expiry, and rejecting no1dinv1: inside note tag", async () => {
  // 1. Bounded `until` pagination recovers valid PoW offer from Page 2 when Page 1 is filled with zero-PoW spam
  const page1Spam = [0, 1, 2].map((i) =>
    makeSignedOfferEvent({
      secretKey: SK_MAKER_2,
      d: `cc${String(i).padStart(30, "0")}`,
      code: makeInviteCode({ network: "sepolia", noidAmount: "5", ethAmount: "0.001", seed: 90 + i }),
      createdAt: BASE_NOW_SEC - 10 - i * 10, // -10, -20, -30
      powBits: 0,
    }),
  );
  const page2Valid = makeSignedOfferEvent({
    secretKey: SK_MAKER_1,
    d: "dd000000000000000000000000000001",
    code: makeInviteCode({ network: "mainnet", noidAmount: "300", ethAmount: "0.06", seed: 95 }),
    createdAt: BASE_NOW_SEC - 100,
    powBits: 8,
  });
  const offerPageReqs = [];
  const { FakeWebSocket: PagingWS } = makeMockWebSocketClass({
    "wss://nos.lol": {
      onCreate: (ws) => ws.onopen?.(),
      onSend: (ws, msg) => {
        const parsed = JSON.parse(msg);
        if (parsed[0] === "REQ") {
          const subId = parsed[1];
          const reqFilters = parsed.slice(2);
          if (reqFilters.some((f) => f.kinds.includes(OFFER_KIND))) {
            offerPageReqs.push(reqFilters[0]);
            if (reqFilters[0].until === undefined) {
              for (const ev of page1Spam) ws.deliver(["EVENT", subId, ev]);
            } else if (reqFilters[0].until === BASE_NOW_SEC - 31) {
              ws.deliver(["EVENT", subId, page2Valid]);
            }
          }
          ws.deliver(["EOSE", subId]);
        }
      },
    },
  });
  await withTempDir(async (dir) => {
    const outPath = path.join(dir, "offers.json");
    const res = await runUpdateOffers({
      outputPath: outPath,
      relays: ["wss://nos.lol"],
      nowMs: BASE_NOW_MS,
      minPowBits: 8,
      maxEventsPerRelay: 3,
      maxOfferPages: 3,
      WebSocketImpl: PagingWS,
    });
    assert.equal(res.ok, true);
    assert.equal(offerPageReqs.length, 2);
    assert.equal(offerPageReqs[0].until, undefined);
    assert.equal(offerPageReqs[1].until, BASE_NOW_SEC - 31);
    assert.equal(res.payload.offers.length, 1);
    assert.equal(res.payload.offers[0].event_id, page2Valid.id);
  });

  // 2. Expired newer "open" replacement on (pubkey, d) supersedes older unexpired "open" offer
  const olderUnexpiredOpen = makeSignedOfferEvent({
    secretKey: SK_MAKER_1,
    d: "ee112233445566778899aabbccddeeff",
    code: makeInviteCode({ network: "mainnet", noidAmount: "100", ethAmount: "0.02", seed: 96 }),
    createdAt: BASE_NOW_SEC - 3600,
    expiration: BASE_NOW_SEC + 10_000,
    powBits: 6,
    status: "open",
  });
  const newerExpiredOpen = makeSignedOfferEvent({
    secretKey: SK_MAKER_1,
    d: "ee112233445566778899aabbccddeeff",
    code: makeInviteCode({ network: "mainnet", noidAmount: "120", ethAmount: "0.024", seed: 96 }),
    createdAt: BASE_NOW_SEC - 1800,
    expiration: BASE_NOW_SEC - 600, // expired 10 min ago, newer created_at
    powBits: 6,
    status: "open",
  });
  const { offers: replacedOffers } = aggregateNostrEvents(
    [
      { event: olderUnexpiredOpen, relayUrl: "wss://nos.lol" },
      { event: newerExpiredOpen, relayUrl: "wss://relay.primal.net" },
    ],
    { nowMs: BASE_NOW_MS, minPowBits: 6 },
  );
  assert.equal(replacedOffers.length, 0);

  // 3. Reject a second no1dinv1: code hidden inside the note tag (bypassing duplicate detection)
  const code1 = makeInviteCode({ network: "mainnet", noidAmount: "100", ethAmount: "0.02", seed: 97 });
  const code2 = makeInviteCode({ network: "mainnet", noidAmount: "200", ethAmount: "0.04", seed: 98 });
  const smuggledNoteEv = makeSignedOfferEvent({
    secretKey: SK_MAKER_1,
    d: "ff112233445566778899aabbccddeeff",
    code: code1,
    note: `See also ${code2}`,
    powBits: 6,
  });
  const smuggledRes = validateOfferEvent(smuggledNoteEv, { nowSec: BASE_NOW_SEC, minPowBits: 6 });
  assert.equal(smuggledRes.ok, false);
  assert.match(smuggledRes.reason, /note tag/i);
});

// Minimal zero-dependency RFC 6455 loopback server for real Node WebSocket testing
function encodeWsTextFrame(str) {
  const payload = Buffer.from(str, "utf8");
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function decodeWsClientFrames(buf) {
  const messages = [];
  let offset = 0;
  while (offset + 2 <= buf.length) {
    const opcode = buf[offset] & 0x0f;
    const masked = (buf[offset + 1] & 0x80) !== 0;
    let len = buf[offset + 1] & 0x7f;
    let pos = offset + 2;
    if (len === 126) {
      if (pos + 2 > buf.length) break;
      len = buf.readUInt16BE(pos);
      pos += 2;
    } else if (len === 127) {
      if (pos + 8 > buf.length) break;
      len = Number(buf.readBigUInt64BE(pos));
      pos += 8;
    }
    const maskLen = masked ? 4 : 0;
    if (pos + maskLen + len > buf.length) break;
    const mask = masked ? buf.subarray(pos, pos + 4) : null;
    pos += maskLen;
    const data = Buffer.from(buf.subarray(pos, pos + len));
    if (mask) {
      for (let i = 0; i < data.length; i += 1) data[i] ^= mask[i & 3];
    }
    messages.push({ opcode, text: opcode === 1 ? data.toString("utf8") : "" });
    offset = pos + len;
  }
  return { messages, remaining: buf.subarray(offset) };
}

test("Real loopback WebSocket path: exercises queryRelay + runUpdateOffers over live Node WebSocket with early frame bounds", async (t) => {
  const offer = makeSignedOfferEvent({
    secretKey: SK_MAKER_1,
    d: "102030405060708090a0b0c0d0e0f001",
    code: makeInviteCode({ network: "mainnet", noidAmount: "400", ethAmount: "0.08", seed: 101 }),
    createdAt: BASE_NOW_SEC - 1800,
    expiration: BASE_NOW_SEC + 3600,
    powBits: 8,
  });
  const hb = makeSignedHeartbeatEvent({
    secretKey: SK_MAKER_1,
    d: "heartbeat",
    createdAt: BASE_NOW_SEC - 60,
  });

  const seenUpgradeHeaders = [];
  const sockets = new Set();
  let mode = "normal";

  const server = http.createServer();
  server.on("upgrade", (req, socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    seenUpgradeHeaders.push(req.headers);
    const key = req.headers["sec-websocket-key"];
    const accept = crypto
      .createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );

    let rxBuf = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      rxBuf = Buffer.concat([rxBuf, chunk]);
      const { messages, remaining } = decodeWsClientFrames(rxBuf);
      rxBuf = remaining;
      for (const m of messages) {
        if (m.opcode === 8) {
          socket.end(Buffer.from([0x88, 0x00]));
          return;
        }
        if (m.opcode !== 1) continue;
        const parsed = JSON.parse(m.text);
        if (parsed[0] === "REQ") {
          const subId = parsed[1];
          const reqFilters = parsed.slice(2);
          if (mode === "oversize") {
            socket.write(encodeWsTextFrame(JSON.stringify(["NOTICE", "X".repeat(8000)])));
            return;
          }
          if (reqFilters.some((f) => f.kinds.includes(OFFER_KIND))) {
            socket.write(encodeWsTextFrame(JSON.stringify(["EVENT", subId, offer])));
          } else if (reqFilters.some((f) => f.kinds.includes(HEARTBEAT_KIND))) {
            socket.write(encodeWsTextFrame(JSON.stringify(["EVENT", subId, hb])));
          }
          socket.write(encodeWsTextFrame(JSON.stringify(["EOSE", subId])));
        }
      }
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const relayUrl = `ws://127.0.0.1:${port}`;

  try {
    // 1. Real Node WebSocket end-to-end Pass 1 + Pass 2 via runUpdateOffers
    await withTempDir(async (dir) => {
      const outPath = path.join(dir, "offers.json");
      const res = await runUpdateOffers({
        outputPath: outPath,
        relays: [relayUrl],
        allowLocalTest: true,
        nowMs: BASE_NOW_MS,
        minPowBits: 8,
      });
      if (!res.ok && res.relayResults?.[0]?.reason === "socket error" && seenUpgradeHeaders.length === 0) {
        t.skip("loopback TCP WebSocket connect blocked by sandbox");
        return;
      }
      assert.equal(res.ok, true);
      assert.equal(res.payload.offers.length, 1);
      assert.equal(res.payload.offers[0].event_id, offer.id);
      assert.equal(res.payload.offers[0].liveness.status, "online");
      assert.equal(res.payload.offers[0].liveness.has_heartbeat, true);
      assert.ok(seenUpgradeHeaders.length >= 2);

      // 2. Real Node WebSocket parser-level early abort on oversize frame > maxFrameBytes
      mode = "oversize";
      const overRes = await queryRelay(relayUrl, buildOfferFilter({ nowSec: BASE_NOW_SEC }), {
        maxFrameBytes: 4096,
        maxTotalBytes: 65_536,
        timeoutMs: 3000,
      });
      assert.equal(overRes.ok, true);
      assert.equal(overRes.truncated, true);
      assert.equal(overRes.events.length, 0);
      assert.equal(overRes.bytesReceived, 0); // aborted inside ByteParser before JS delivery
    });
  } finally {
    for (const s of sockets) s.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});
