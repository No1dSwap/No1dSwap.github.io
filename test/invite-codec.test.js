import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import {
  CHECKSUM_BYTES,
  CODE_PREFIX,
  KEYS,
  KIND,
  MAX_BYTES,
  MAX_CODE_CHARS,
  NETWORK_SPECS,
  URI_PREFIX,
  URI_SCHEME,
  buildInvitationJson,
  buildInviteUri,
  calculateRate,
  decodeBech32m,
  decodeInvite,
  encodeBech32m,
  encodeInvite,
  ethAddressProblem,
  formatGroupedDecimal,
  inspectInput,
  isPinnedContract,
  keccak256,
  noidAddressProblem,
  parseCode,
  parseInvitationJson,
  parseInviteUri,
  requirePinnedContract,
  sanitizeDisplayText,
  sha256,
  toChecksumAddress,
  toDecimal,
} from "../js/invite-codec.js";

import { DEMO_OFFERS, PROTOCOL_CONSTANTS } from "../js/sample-offers.js";

const SAMPLE_NOID = encodeBech32m(new Uint8Array(32).fill(0x42), "o");
const SAMPLE_ETH = toChecksumAddress("0x111122223333444455556666777788889999aaaa");
const UNPINNED_CONTRACT = toChecksumAddress("0x9999888877776666555544443333222211110000");

function hexOf(bytes) {
  return Buffer.from(bytes).toString("hex");
}

function makeRawCode(payloadText) {
  const payload = Buffer.from(payloadText, "utf8");
  const csum = crypto.createHash("sha256").update(payload).digest().subarray(0, CHECKSUM_BYTES);
  return CODE_PREFIX + Buffer.concat([payload, csum]).toString("base64url");
}

test("pure-JS sha256 matches Node crypto across empty, short, and multi-block inputs", () => {
  const vectors = [
    "",
    "abc",
    "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
    "a".repeat(1000),
    JSON.stringify({ kind: KIND, v: 1, network: "mainnet" }),
  ];
  for (const input of vectors) {
    const got = hexOf(sha256(input));
    const want = crypto.createHash("sha256").update(input, "utf8").digest("hex");
    assert.equal(got, want);
  }
});

test("keccak256 and EIP-55 address checks match pinned Ethereum contracts", () => {
  assert.equal(
    hexOf(keccak256("")),
    "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
  );
  const mainnetContract = "0x4e364cC86EdBF307CC6F336F3a72e1a24d284D70";
  const sepoliaContract = "0x48Ce4D6cf3c175737532017e82B9261b51F8E5eF";
  assert.equal(toChecksumAddress(mainnetContract.toLowerCase()), mainnetContract);
  assert.equal(toChecksumAddress(sepoliaContract.toLowerCase()), sepoliaContract);
  assert.equal(ethAddressProblem(mainnetContract), null);
  assert.equal(ethAddressProblem(mainnetContract.toLowerCase()), null);
  assert.equal(ethAddressProblem(mainnetContract.toUpperCase().replace("0X", "0x")), null);

  // Flip case of one letter to break EIP-55 mixed-case checksum
  const broken = mainnetContract.replace("cC", "Cc");
  assert.notEqual(ethAddressProblem(broken), null);
  assert.notEqual(ethAddressProblem("0x1234"), null);
  assert.notEqual(ethAddressProblem("not-an-address"), null);
});

test("Bech32m Parano1d o1... encode and decode checks", () => {
  const payload = new Uint8Array(32);
  for (let i = 0; i < 32; i++) payload[i] = i;
  const addr = encodeBech32m(payload, "o");
  assert.ok(addr.startsWith("o1"));
  assert.equal(addr.length, 60);

  const decoded = decodeBech32m(addr, "o", 32);
  assert.equal(decoded.ok, true);
  assert.deepEqual(decoded.bytes, payload);
  assert.equal(noidAddressProblem(addr), null);

  // Uppercase, wrong HRP, corrupted character
  assert.notEqual(noidAddressProblem(addr.toUpperCase()), null);
  assert.notEqual(noidAddressProblem("x" + addr.slice(1)), null);
  const mutated = addr.slice(0, -1) + (addr.endsWith("q") ? "p" : "q");
  assert.notEqual(noidAddressProblem(mutated), null);

  // Bidi character in invalid address is sanitized in error reason
  const withBidi = decodeBech32m("o1\u202eabc");
  assert.equal(withBidi.ok, false);
  assert.equal(withBidi.reason.includes("\u202e"), false);
});

test("encodeInvite -> decodeInvite round-trips mainnet and sepolia with exact decimals", () => {
  const main = encodeInvite({
    network: "mainnet",
    noidAmount: "20000",
    ethAmount: "1",
    bobNoid: SAMPLE_NOID,
    bobEth: SAMPLE_ETH,
  });
  assert.equal(main.ok, true);
  assert.ok(main.code.startsWith(CODE_PREFIX));
  assert.equal(main.canonicalCode, main.code);
  assert.equal(main.contractPinned, true);
  assert.match(main.code.slice(CODE_PREFIX.length), /^[A-Za-z0-9_-]+$/);

  const decodedMain = decodeInvite(`  ${main.code}\n`);
  assert.equal(decodedMain.ok, true);
  assert.equal(decodedMain.source, "code");
  assert.equal(decodedMain.canonicalCode, main.code);
  assert.equal(decodedMain.contractPinned, true);
  assert.equal(decodedMain.checks.checksumValid, true);
  assert.equal(decodedMain.checks.matchesPinnedContract, true);
  assert.equal(decodedMain.fields.role, "alice");
  assert.equal(decodedMain.fields.profile, "production");
  assert.equal(decodedMain.fields.network, "mainnet");
  assert.equal(decodedMain.fields.contract, NETWORK_SPECS.mainnet.pinnedContract);
  assert.equal(decodedMain.fields.contract_version, "1");
  assert.equal(decodedMain.fields.noid_amount, "20000");
  assert.equal(decodedMain.fields.eth_amount, "1");
  assert.equal(decodedMain.fields.noid_micronoid, "20000000000");
  assert.equal(decodedMain.fields.eth_wei, "1000000000000000000");
  assert.equal(decodedMain.fields.bob_noid, SAMPLE_NOID);
  assert.equal(decodedMain.fields.bob_eth, SAMPLE_ETH);

  // Exact fractional precision (smallest micro-NOID and smallest wei)
  const sep = encodeInvite({
    network: "sepolia",
    noidAmount: "0.000001",
    ethAmount: "0.000000000000000001",
    contractVersion: 2,
    bobNoid: SAMPLE_NOID,
    bobEth: SAMPLE_ETH,
  });
  assert.equal(sep.ok, true);
  const decodedSep = parseCode(sep.code);
  assert.equal(decodedSep.ok, true);
  assert.equal(decodedSep.fields.profile, "sepolia");
  assert.equal(decodedSep.fields.contract_version, "2");
  assert.equal(decodedSep.fields.noid_amount, "0.000001");
  assert.equal(decodedSep.fields.eth_amount, "0.000000000000000001");
  assert.equal(toDecimal("5000000", 6), "5");

  // Raw JSON fallback parity
  const rawRes = decodeInvite(main.json);
  assert.equal(rawRes.ok, true);
  assert.equal(rawRes.source, "json");
  assert.equal(rawRes.canonicalCode, main.code);
  assert.equal(rawRes.checks.checksumValid, null);
  assert.deepEqual(rawRes.raw, decodedMain.raw);
});

test("canonicalCode is invariant across reordered JSON keys and whitespace", () => {
  const canonical = encodeInvite({
    network: "sepolia",
    noidAmount: "5",
    ethAmount: "0.001",
    bobNoid: SAMPLE_NOID,
    bobEth: SAMPLE_ETH,
  });
  assert.equal(canonical.ok, true);

  // Reordered keys + extra whitespace inside a valid checksummed no1dinv1: code
  const reorderedJson = `{
    "bob_eth": "${SAMPLE_ETH}",
    "bob_noid": "${SAMPLE_NOID}",
    "eth_wei": "1000000000000000",
    "noid_micronoid": "5000000",
    "contract_version": 1,
    "contract": "${NETWORK_SPECS.sepolia.pinnedContract}",
    "network": "sepolia",
    "v": 1,
    "kind": "${KIND}"
  }`;
  const nonCanonicalCode = makeRawCode(reorderedJson);
  assert.notEqual(nonCanonicalCode, canonical.code);

  const d1 = decodeInvite(nonCanonicalCode);
  const d2 = decodeInvite(reorderedJson);
  assert.equal(d1.ok, true);
  assert.equal(d2.ok, true);
  assert.equal(d1.canonicalCode, canonical.canonicalCode);
  assert.equal(d2.canonicalCode, canonical.canonicalCode);

  // buildInviteUri canonicalizes the emitted URI
  const builtUri = buildInviteUri(nonCanonicalCode);
  assert.equal(builtUri.ok, true);
  assert.equal(builtUri.canonicalCode, canonical.canonicalCode);
  assert.equal(builtUri.uri, `${URI_PREFIX}${encodeURIComponent(canonical.canonicalCode)}`);
});

test("contractPinned and requirePinnedContract refuse unpinned contracts", () => {
  assert.equal(isPinnedContract("mainnet", NETWORK_SPECS.mainnet.pinnedContract), true);
  assert.equal(isPinnedContract("sepolia", NETWORK_SPECS.sepolia.pinnedContract), true);
  assert.equal(isPinnedContract("sepolia", UNPINNED_CONTRACT), false);

  const unpinnedJson = JSON.stringify({
    kind: KIND,
    v: 1,
    network: "sepolia",
    contract: UNPINNED_CONTRACT,
    contract_version: 1,
    noid_micronoid: "5000000",
    eth_wei: "1000000000000000",
    bob_noid: SAMPLE_NOID,
    bob_eth: SAMPLE_ETH,
  });
  const unpinnedCode = makeRawCode(unpinnedJson);
  const decoded = decodeInvite(unpinnedCode);
  assert.equal(decoded.ok, true);
  assert.equal(decoded.contractPinned, false);
  assert.equal(decoded.checks.matchesPinnedContract, false);
  assert.equal(decoded.uri, null);

  const enforced = requirePinnedContract(decoded);
  assert.equal(enforced.ok, false);
  assert.equal(enforced.code, "UNPINNED_CONTRACT");

  const uriAttempt = buildInviteUri(unpinnedCode);
  assert.equal(uriAttempt.ok, false);
  assert.equal(uriAttempt.code, "UNPINNED_CONTRACT");
});

test("sanitizeDisplayText strips bidi, zero-width, invisible fillers, variation selectors, control chars, zalgo marks, and enforces max length", () => {
  const dirty = "Hello\u202Eworld\u200B\uFEFF\u2066test\u2069\u061C\x00\x07\n\t  spacing  ";
  assert.equal(sanitizeDisplayText(dirty, 140), "Helloworldtest spacing");

  // Invisible fillers & variation selectors outside \p{Cf}
  const fillers =
    "A\u034FB\u115FC\u1160D\u3164E\uFFA0F\u2800G\u00ADH\u180EI\uFE00J\uFE0FK\u{E0100}L\u{E01EF}M";
  assert.equal(sanitizeDisplayText(fillers, 140), "ABCDEFGHIJKLM");

  // Combining marks capped to at most 2 per base character; leading/post-space combining marks stripped
  const normalDiacritics = "caf\u0065\u0301 \u0065\u0302\u0323";
  assert.equal(sanitizeDisplayText(normalDiacritics, 140), "cafe\u0301 e\u0302\u0323");

  const zalgo = "\u0301\u0302z" + "\u0301\u0302\u0303\u0304\u0305\u0306" + "a \u0308b\u0300\u0301\u0302\u0303";
  assert.equal(sanitizeDisplayText(zalgo, 140), "z\u0301\u0302a b\u0300\u0301");

  const longText = "a".repeat(200);
  assert.equal(sanitizeDisplayText(longText, 140).length, 140);
  assert.equal(sanitizeDisplayText(longText, 20).length, 20);

  // Surrogate pairs are not split
  const emojis = "\uD83D\uDD12".repeat(10);
  assert.equal([...sanitizeDisplayText(emojis, 3)].length, 3);

  assert.equal(sanitizeDisplayText(null), "");
  assert.equal(sanitizeDisplayText(undefined), "");
});

test("rejects checksum corruption, truncation, non-canonical base64url, BOM, and oversize inputs", () => {
  const valid = encodeInvite({
    network: "sepolia",
    noidAmount: "5",
    ethAmount: "0.001",
    bobNoid: SAMPLE_NOID,
    bobEth: SAMPLE_ETH,
  });
  assert.equal(valid.ok, true);
  const body = valid.code.slice(CODE_PREFIX.length);

  // Flip first body character (payload corruption)
  const flippedStart = CODE_PREFIX + (body[0] === "A" ? "B" : "A") + body.slice(1);
  const rStart = decodeInvite(flippedStart);
  assert.equal(rStart.ok, false);
  assert.equal(rStart.code, "CHECKSUM");

  // Flip last character (checksum corruption)
  const flippedEnd = valid.code.slice(0, -1) + (valid.code.endsWith("A") ? "B" : "A");
  const rEnd = decodeInvite(flippedEnd);
  assert.equal(rEnd.ok, false);
  assert.ok(rEnd.code === "CHECKSUM" || rEnd.code === "DAMAGED");

  // Truncated codes
  assert.equal(decodeInvite(valid.code.slice(0, -4)).ok, false);
  assert.equal(decodeInvite(CODE_PREFIX).ok, false);
  assert.equal(decodeInvite(CODE_PREFIX + "AAAA").ok, false);

  // Non-canonical base64url (padded with '=' or invalid chars)
  assert.equal(decodeInvite(valid.code + "=").ok, false);
  assert.equal(decodeInvite(CODE_PREFIX + "!!!invalid!!!").ok, false);

  // Leading UTF-8 BOM on JSON rejected
  assert.equal(decodeInvite("\ufeff" + valid.json).ok, false);

  // Empty & non-string
  assert.equal(decodeInvite("").ok, false);
  assert.equal(decodeInvite("   \n\t ").ok, false);
  assert.equal(decodeInvite(null).ok, false);

  // Oversize code (> MAX_CODE_CHARS)
  const huge = CODE_PREFIX + "A".repeat(MAX_CODE_CHARS);
  const rHuge = decodeInvite(huge);
  assert.equal(rHuge.ok, false);
  assert.equal(rHuge.code, "TOO_LARGE");

  // Oversize JSON payload (> MAX_BYTES) even with valid checksum
  const bigJson = `{"kind":"${KIND}","pad":"${"x".repeat(MAX_BYTES)}"}`;
  const bigCode = makeRawCode(bigJson);
  const rBig = decodeInvite(bigCode);
  assert.equal(rBig.ok, false);
  assert.equal(rBig.code, "TOO_LARGE");
});

test("enforces mainnet and sepolia caps, contract version rules, and address integrity", () => {
  // Over mainnet NOID cap (20,000 NOID)
  const overMainNoid = encodeInvite({
    network: "mainnet",
    noidAmount: "20000.000001",
    ethAmount: "0.1",
    bobNoid: SAMPLE_NOID,
    bobEth: SAMPLE_ETH,
  });
  assert.equal(overMainNoid.ok, false);

  // Over mainnet ETH cap (1 ETH)
  const overMainEth = encodeInvite({
    network: "mainnet",
    noidAmount: "100",
    ethAmount: "1.000000000000000001",
    bobNoid: SAMPLE_NOID,
    bobEth: SAMPLE_ETH,
  });
  assert.equal(overMainEth.ok, false);

  // Over Sepolia NOID cap (20 NOID)
  const overSepNoid = encodeInvite({
    network: "sepolia",
    noidAmount: "20.000001",
    ethAmount: "0.001",
    bobNoid: SAMPLE_NOID,
    bobEth: SAMPLE_ETH,
  });
  assert.equal(overSepNoid.ok, false);

  // Over Sepolia ETH cap (0.01 ETH)
  const overSepEth = encodeInvite({
    network: "sepolia",
    noidAmount: "5",
    ethAmount: "0.010000000000000001",
    bobNoid: SAMPLE_NOID,
    bobEth: SAMPLE_ETH,
  });
  assert.equal(overSepEth.ok, false);

  // Over-cap code crafted externally with valid checksum must be rejected by decodeInvite
  const overCapJson = JSON.stringify({
    kind: KIND,
    v: 1,
    network: "mainnet",
    contract: NETWORK_SPECS.mainnet.pinnedContract,
    contract_version: 1,
    noid_micronoid: "20000000001",
    eth_wei: "100000000000000000",
    bob_noid: SAMPLE_NOID,
    bob_eth: SAMPLE_ETH,
  });
  const rOverCap = decodeInvite(makeRawCode(overCapJson));
  assert.equal(rOverCap.ok, false);
  assert.equal(rOverCap.code, "CAPS");

  // Mainnet rejects contract version 2
  const mainV2 = encodeInvite({
    network: "mainnet",
    contractVersion: 2,
    noidAmount: "10",
    ethAmount: "0.01",
    bobNoid: SAMPLE_NOID,
    bobEth: SAMPLE_ETH,
  });
  assert.equal(mainV2.ok, false);

  // External mainnet v2 code rejected by decodeInvite
  const mainV2Json = JSON.stringify({
    kind: KIND,
    v: 1,
    network: "mainnet",
    contract: NETWORK_SPECS.mainnet.pinnedContract,
    contract_version: 2,
    noid_micronoid: "10000000",
    eth_wei: "1000000000000000",
    bob_noid: SAMPLE_NOID,
    bob_eth: SAMPLE_ETH,
  });
  const rMainV2 = decodeInvite(makeRawCode(mainV2Json));
  assert.equal(rMainV2.ok, false);
  assert.equal(rMainV2.code, "VERSION");

  // Unsupported network ("rehearsal") rejected
  const rehearsalJson = JSON.stringify({
    kind: KIND,
    v: 1,
    network: "rehearsal",
    contract: NETWORK_SPECS.sepolia.pinnedContract,
    contract_version: 1,
    noid_micronoid: "5000000",
    eth_wei: "1000000000000000",
    bob_noid: SAMPLE_NOID,
    bob_eth: SAMPLE_ETH,
  });
  const rReh = decodeInvite(makeRawCode(rehearsalJson));
  assert.equal(rReh.ok, false);
  assert.equal(rReh.code, "NETWORK");

  // Bob ETH cannot equal HTLC contract
  const sameAsContract = encodeInvite({
    network: "mainnet",
    noidAmount: "10",
    ethAmount: "0.01",
    bobNoid: SAMPLE_NOID,
    bobEth: NETWORK_SPECS.mainnet.pinnedContract,
  });
  assert.equal(sameAsContract.ok, false);
});

test("strictly rejects unexpected, secret, and duplicate fields and sanitizes attacker keys", () => {
  // Reject unexpected/secret fields in encodeInvite
  for (const badKey of ["privateKey", "secret", "recoveryCode", "mnemonic", "note", "single_node_ok"]) {
    const res = encodeInvite({
      network: "sepolia",
      noidAmount: "5",
      ethAmount: "0.001",
      bobNoid: SAMPLE_NOID,
      bobEth: SAMPLE_ETH,
      [badKey]: "should-never-be-accepted",
    });
    assert.equal(res.ok, false, `expected ${badKey} to be rejected`);
    assert.equal(res.field, badKey);
  }

  // Reject extra key with bidi/zero-width/huge name in wire code and ensure sanitized error
  const evilKey = "\u202Eevil\u200B" + "x".repeat(80);
  const extraKeyJson = JSON.stringify({
    kind: KIND,
    v: 1,
    network: "sepolia",
    contract: NETWORK_SPECS.sepolia.pinnedContract,
    contract_version: 1,
    noid_micronoid: "5000000",
    eth_wei: "1000000000000000",
    bob_noid: SAMPLE_NOID,
    bob_eth: SAMPLE_ETH,
    [evilKey]: "0xdeadbeef",
  });
  const rExtra = decodeInvite(makeRawCode(extraKeyJson));
  assert.equal(rExtra.ok, false);
  assert.equal(rExtra.code, "UNEXPECTED_FIELD");
  assert.equal(rExtra.error.includes("\u202E"), false);
  assert.equal(rExtra.error.includes("\u200B"), false);
  assert.ok(rExtra.field.length <= 32);

  // Reject duplicate keys (including unicode-escaped duplicate key name)
  const dupJson =
    `{"kind":"${KIND}","v":1,"network":"sepolia","contract":"${NETWORK_SPECS.sepolia.pinnedContract}",` +
    `"contract_version":1,"noid_micronoid":"5000000","eth_wei":"1000000000000000",` +
    `"eth_w\\u0065i":"2000000000000000","bob_noid":"${SAMPLE_NOID}","bob_eth":"${SAMPLE_ETH}"}`;
  const rDup = parseInvitationJson(dupJson);
  assert.equal(rDup.ok, false);
  assert.equal(rDup.code, "DAMAGED");

  // Reject JSON number for amounts (strings required to avoid precision loss)
  const numAmountJson = JSON.stringify({
    kind: KIND,
    v: 1,
    network: "sepolia",
    contract: NETWORK_SPECS.sepolia.pinnedContract,
    contract_version: 1,
    noid_micronoid: 5000000,
    eth_wei: "1000000000000000",
    bob_noid: SAMPLE_NOID,
    bob_eth: SAMPLE_ETH,
  });
  assert.equal(parseInvitationJson(numAmountJson).ok, false);
});

test("no1d-invite://invite URI round-trip and strict validation", () => {
  const inv = encodeInvite({
    network: "mainnet",
    noidAmount: "500",
    ethAmount: "0.1",
    bobNoid: SAMPLE_NOID,
    bobEth: SAMPLE_ETH,
  });
  assert.equal(inv.ok, true);

  const built = buildInviteUri(inv.code);
  assert.equal(built.ok, true);
  assert.ok(built.uri.startsWith("no1d-invite://invite?code=no1dinv1%3A"));

  const parsed = parseInviteUri(built.uri);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.source, "uri");
  assert.equal(parsed.canonicalCode, inv.canonicalCode);
  assert.equal(parsed.contractPinned, true);
  assert.equal(parsed.fields.noid_amount, "500");
  assert.equal(parsed.fields.eth_amount, "0.1");

  // Unified inspectInput handles URI, code, and raw JSON identically
  const viaInspectUri = inspectInput(built.uri);
  const viaInspectCode = inspectInput(inv.code);
  assert.equal(viaInspectUri.ok, true);
  assert.equal(viaInspectCode.ok, true);
  assert.equal(viaInspectUri.canonicalCode, viaInspectCode.canonicalCode);
  assert.deepEqual(viaInspectUri.raw, viaInspectCode.raw);

  // Reject wrong/old schemes, wrong host, extra query param, credentials/port, fragment, oversize
  assert.equal(parseInviteUri(`noidswap://invite?code=${encodeURIComponent(inv.code)}`).ok, false);
  assert.equal(parseInviteUri(`https://invite?code=${encodeURIComponent(inv.code)}`).ok, false);
  assert.equal(parseInviteUri(`no1d-invite://swap?code=${encodeURIComponent(inv.code)}`).ok, false);
  assert.equal(parseInviteUri(`${built.uri}&extra=1`).ok, false);
  assert.equal(parseInviteUri(`${built.uri}#frag`).ok, false);
  assert.equal(parseInviteUri(`no1d-invite://user@invite?code=${encodeURIComponent(inv.code)}`).ok, false);
  assert.equal(parseInviteUri(`no1d-invite://invite:8080?code=${encodeURIComponent(inv.code)}`).ok, false);
  assert.equal(parseInviteUri("no1d-invite://invite?code=not-a-code").ok, false);
  const hugeUri = `no1d-invite://invite?code=${CODE_PREFIX}${"A".repeat(MAX_CODE_CHARS)}`;
  const rHugeUri = parseInviteUri(hugeUri);
  assert.equal(rHugeUri.ok, false);
  assert.equal(rHugeUri.code, "TOO_LARGE");
});

test("implied rate calculation and grouping", () => {
  const exact = calculateRate("5000000", "1000000000000000"); // 5 NOID / 0.001 ETH
  assert.equal(exact.noidInEth, "0.0002");
  assert.equal(exact.ethInNoid, "5000");
  assert.equal(exact.rounded, false);
  assert.equal(exact.noidInEthLabel, "1 NOID = 0.0002 ETH");
  assert.equal(exact.ethInNoidLabel, "1 ETH = 5,000 NOID");

  const repeating = calculateRate("3000000", "1000000000000000"); // 3 NOID / 0.001 ETH
  assert.equal(repeating.rounded, true);
  assert.equal(repeating.noidInEth, "0.000333333");
  assert.equal(formatGroupedDecimal("2500.25"), "2,500.25");
});

test("PROTOCOL_CONSTANTS and Sepolia-only DEMO_OFFERS satisfy all security & accuracy invariants", () => {
  assert.equal(PROTOCOL_CONSTANTS.version, "0.2.0");
  assert.equal(PROTOCOL_CONSTANTS.releaseStatus, "released");
  assert.equal(PROTOCOL_CONSTANTS.releaseKey.publicKeyB64, "Thg9nhwwvqoKG4yOqiZM/PBeqT5LcrFFa7cKAHuqYxk=");
  assert.equal(PROTOCOL_CONSTANTS.mainnet.contract, "0x4e364cC86EdBF307CC6F336F3a72e1a24d284D70");
  assert.equal(
    PROTOCOL_CONSTANTS.mainnet.codeHash,
    "0xf510d2a368c730339fa7cf5e023bcf2429d5732793f043e03025780bb7043ff3",
  );
  assert.equal(PROTOCOL_CONSTANTS.mainnet.maxNoid, "20000");
  assert.equal(PROTOCOL_CONSTANTS.mainnet.maxEth, "1");
  assert.equal(PROTOCOL_CONSTANTS.sepolia.maxNoid, "20");
  assert.equal(PROTOCOL_CONSTANTS.sepolia.maxEth, "0.01");
  assert.equal(PROTOCOL_CONSTANTS.parano1d.finalityBlocks, 18);
  assert.equal(PROTOCOL_CONSTANTS.inviteFormat.uriScheme, URI_SCHEME);
  assert.equal(PROTOCOL_CONSTANTS.inviteFormat.uriPrefix, URI_PREFIX);
  assert.equal(PROTOCOL_CONSTANTS.minerConcentration.recentProducerPct, "about 82%");
  assert.equal(PROTOCOL_CONSTANTS.minerConcentration.recentProducerDateUtc, "2026-11-27");
  assert.equal(
    PROTOCOL_CONSTANTS.minerConcentration.boardWarning,
    "A listing is not a check. The program checks the terms; the miner limit still applies to the ETH side.",
  );

  // Zero stale version or third-party RPC host strings
  const serializedConstants = JSON.stringify(PROTOCOL_CONSTANTS).toLowerCase();
  assert.equal(serializedConstants.includes("0.1.8"), false);
  assert.equal(serializedConstants.includes("publicnode"), false);
  assert.equal(serializedConstants.includes("mevblocker"), false);

  // DEMO_OFFERS: Sepolia-only (zero mainnet codes anywhere), every code decodes & matches pinned contract
  assert.ok(DEMO_OFFERS.length >= 2);
  for (const offer of DEMO_OFFERS) {
    assert.equal(offer.demo, true);
    assert.ok(offer.postedAtUtc.endsWith("Z"), `${offer.id} timestamp must be UTC`);
    assert.equal(offer.uri, undefined, `${offer.id} must not store pre-built URI metadata`);

    const decoded = decodeInvite(offer.code);
    assert.equal(decoded.ok, true, `${offer.id} code failed decode: ${decoded.error}`);
    assert.equal(decoded.fields.network, "sepolia", `${offer.id} must be Sepolia-only`);
    assert.equal(decoded.fields.profile, "sepolia");
    assert.equal(decoded.canonicalCode, offer.code);
    assert.equal(decoded.contractPinned, true);
    assert.equal(decoded.checks.checksumValid, true);
    assert.equal(decoded.checks.withinCaps, true);
    assert.deepEqual(Object.keys(decoded.raw), [...KEYS]);

    // Ensure JSON built from decoded fields has exact 9 keys
    const built = buildInvitationJson({
      network: decoded.fields.network,
      noidAmount: decoded.fields.noid_amount,
      ethAmount: decoded.fields.eth_amount,
      bobNoid: decoded.fields.bob_noid,
      bobEth: decoded.fields.bob_eth,
    });
    assert.equal(built.ok, true);
    assert.equal(Object.keys(built.payload).length, 9);
  }
});
