import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  NETWORK_SPECS,
  encodeBech32m,
  encodeInvite,
  sha256,
  toChecksumAddress,
} from "../js/invite-codec.js";
import {
  EXPIRE_AFTER_MS,
  LIVENESS_ONLINE_MS,
  LIVENESS_RECENT_MS,
  MAX_FUTURE_SKEW_MS,
  MAX_OFFERS_BYTES,
  OFFERS_SNAPSHOT_URL,
  STALE_AFTER_MS,
  computeLivenessBucket,
  formatPubkeyShort,
  getCurrentOffersSnapshot,
  loadSameOriginOffersSnapshot,
  onOffersSnapshotChange,
  parseOffersSnapshot,
  setCurrentOffersSnapshot,
} from "../js/offers-data.js";
import { parseMarketSnapshot } from "../js/market-data.js";
import { mountMarketStrip } from "../js/market-ui.js";
import { mountBoardWidgets, resolveOfferForDisplay } from "../js/board-ui.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
const OFFERS_JSON_PATH = path.resolve(ROOT_DIR, "data", "offers.json");

const BASE_NOW_MS = Date.parse("2026-11-26T20:30:00Z");

function makeTestNoidAddr(seed) {
  const bytes = new Uint8Array(32);
  bytes[0] = 0x42;
  for (let i = 1; i < 32; i++) bytes[i] = (seed * 29 + i * 7) & 0xff;
  return encodeBech32m(bytes, "o");
}

function makeTestEthAddr(seed) {
  const hex = seed.toString(16).padStart(4, "0");
  return toChecksumAddress(`0x110000000000000000000000000000000000${hex}`);
}

function makeValidInviteCode({
  network = "mainnet",
  noidAmount = "100",
  ethAmount = "0.02",
  seed = 1,
  contract = undefined,
  contractVersion = 1,
} = {}) {
  const enc = encodeInvite({
    network,
    noidAmount,
    ethAmount,
    bobNoid: makeTestNoidAddr(seed),
    bobEth: makeTestEthAddr(seed),
    ...(contract ? { contract } : {}),
    contractVersion,
  });
  assert.equal(enc.ok, true, `encodeInvite failed: ${enc.error}`);
  return enc.canonicalCode;
}

function makePowEventId(fillChar, zeroNibbles = 5) {
  return "0".repeat(zeroNibbles) + fillChar.repeat(64 - zeroNibbles);
}

function makeRawOffer(overrides = {}) {
  const code = overrides.code || makeValidInviteCode();
  return {
    event_id: makePowEventId("a"),
    d: "1".repeat(32),
    pubkey: "b".repeat(64),
    created_at: "2026-11-26T20:25:00Z",
    expires_at: "2026-11-26T22:25:00Z",
    pow_bits: 16,
    code,
    note: "Small test offer",
    liveness: {
      status: "online",
      last_seen_at: "2026-11-26T20:28:00Z",
      has_heartbeat: true,
    },
    flags: {
      duplicate_payload: false,
      is_earliest_payload: true,
      earliest_pubkey: "b".repeat(64),
      repeated_bob_address: false,
    },
    relays: ["wss://relay.example.org"],
    ...overrides,
  };
}

function makeRawSnapshot(overrides = {}) {
  return {
    v: 1,
    sample: false,
    generated_at: "2026-11-26T20:29:00Z",
    min_pow_bits: 16,
    relays: [
      {
        url: "wss://relay.example.org",
        ok: true,
        events_received: 2,
        events_accepted: 1,
      },
    ],
    offers: [makeRawOffer()],
    ...overrides,
  };
}

test("offers snapshot accepts an optional boolean truncated per relay and drops relay entries with a non-boolean one", () => {
  const base = { url: "wss://relay.example.org", ok: true, events_received: 2, events_accepted: 1 };
  const parse = (relays) => parseOffersSnapshot(makeRawSnapshot({ relays }), BASE_NOW_MS);
  assert.equal(parse([base]).relays[0].truncated, false);
  assert.equal(parse([{ ...base, truncated: true }]).relays[0].truncated, true);
  assert.equal(parse([{ ...base, truncated: false }]).relays[0].truncated, false);
  assert.equal(parse([{ ...base, truncated: "true" }]).relays.length, 0);
  assert.equal(parse([{ ...base, truncated: 1 }]).relays.length, 0);
});

test("default data/offers.json is clearly sample-labelled, <= 1 MB, has zero fake mainnet offers, and sample snapshots never render as live", () => {
  const raw = fs.readFileSync(OFFERS_JSON_PATH, "utf8");
  assert.ok(Buffer.byteLength(raw, "utf8") <= MAX_OFFERS_BYTES);

  const snap = parseOffersSnapshot(raw, BASE_NOW_MS);
  assert.equal(snap.ok, true);
  assert.equal(snap.isSample, true);
  assert.equal(snap.offersVisible, false);
  assert.equal(snap.offers.length, 0);

  // Even if a sample:true snapshot contains valid mainnet offers, it MUST NOT expose them as live
  const sampleWithOffers = parseOffersSnapshot(
    makeRawSnapshot({ sample: true, offers: [makeRawOffer()] }),
    BASE_NOW_MS,
  );
  assert.equal(sampleWithOffers.ok, true);
  assert.equal(sampleWithOffers.isSample, true);
  assert.equal(sampleWithOffers.offersVisible, false);
  assert.equal(sampleWithOffers.offers.length, 0);
  assert.equal(sampleWithOffers.droppedCount, 1);
});

test("parseOffersSnapshot enforces fail-closed limits, BOM, schema version, and age thresholds (<=30m fresh, >30m stale, >6h hidden)", () => {
  // Invalid payloads fail closed
  const invalidPayloads = [
    null,
    "not-json",
    "\ufeff" + JSON.stringify(makeRawSnapshot()),
    " ".repeat(MAX_OFFERS_BYTES + 1),
    makeRawSnapshot({ v: 2 }),
    makeRawSnapshot({ generated_at: "2026-02-31T00:00:00Z" }),
    makeRawSnapshot({ generated_at: "2026-11-26T20:35:01Z" }), // > 5 min future
    makeRawSnapshot({ offers: "not-an-array" }),
    makeRawSnapshot({ min_pow_bits: -1 }),
    makeRawSnapshot({ min_pow_bits: 300 }),
    makeRawSnapshot({ sample: "yes" }),
  ];
  for (const bad of invalidPayloads) {
    const res = parseOffersSnapshot(bad, BASE_NOW_MS);
    assert.equal(res.ok, false);
    assert.equal(res.offersVisible, false);
    assert.equal(res.offers.length, 0);
  }

  // <= 30 min: fresh
  const genMs = Date.parse("2026-11-26T20:00:00Z");
  const snapObj = makeRawSnapshot({
    generated_at: "2026-11-26T20:00:00Z",
    offers: [
      makeRawOffer({
        created_at: "2026-11-26T19:55:00Z",
        expires_at: "2026-11-27T05:00:00Z",
        liveness: { status: "online", last_seen_at: "2026-11-26T19:58:00Z", has_heartbeat: true },
      }),
    ],
  });
  const fresh = parseOffersSnapshot(snapObj, genMs + STALE_AFTER_MS);
  assert.equal(fresh.ok, true);
  assert.equal(fresh.freshness, "fresh");
  assert.equal(fresh.isStale, false);
  assert.equal(fresh.offersVisible, true);
  assert.equal(fresh.offers.length, 1);

  // 31 min: stale (still visible, marked stale, and liveness degrades independently!)
  const stale = parseOffersSnapshot(snapObj, genMs + STALE_AFTER_MS + 60_000);
  assert.equal(stale.ok, true);
  assert.equal(stale.freshness, "stale");
  assert.equal(stale.isStale, true);
  assert.equal(stale.offersVisible, true);
  assert.equal(stale.offers.length, 1);
  // 33 min since last_seen_at -> "recent", even though raw JSON claimed "online"
  assert.equal(stale.offers[0].liveness.status, "recent");

  // > 6 h: expired (offers hidden fail-closed)
  const expired = parseOffersSnapshot(snapObj, genMs + EXPIRE_AFTER_MS + 60_000);
  assert.equal(expired.ok, true);
  assert.equal(expired.freshness, "expired");
  assert.equal(expired.isExpired, true);
  assert.equal(expired.offersVisible, false);
  assert.equal(expired.offers.length, 0);
});

test("parseOffersSnapshot defense-in-depth: refuses unpinned contracts, expired offers, raw JSON codes, bad PoW, and ignores tampered metadata", () => {
  const unpinnedCode = makeValidInviteCode({
    network: "mainnet",
    contract: toChecksumAddress("0xdead00000000000000000000000000000000beef"),
    seed: 9,
  });
  const validMainnetCode = makeValidInviteCode({
    network: "mainnet",
    noidAmount: "500",
    ethAmount: "0.1",
    seed: 2,
  });

  // Construct tampered offer with misleading top-level fields (must be completely ignored)
  const tamperedValid = makeRawOffer({
    event_id: makePowEventId("c"),
    d: "2".repeat(32),
    pubkey: "d".repeat(64),
    code: validMainnetCode,
    eth_amount: "999.0",
    noid_amount: "1",
    network: "sepolia",
    bob_eth: "0x0000000000000000000000000000000000000001",
    uri: "javascript:alert(1)",
    note: "Clean\u202E\u200B\u3164 note\u0301\u0302\u0303\u0304",
  });

  // Raw JSON invitation (no `no1dinv1:` prefix) must be refused
  const rawJsonCode = JSON.stringify({
    kind: "no1d-swap-invitation",
    v: 1,
    network: "mainnet",
    contract: NETWORK_SPECS.mainnet.pinnedContract,
    contract_version: 1,
    noid_micronoid: "100000000",
    eth_wei: "20000000000000000",
    bob_noid: makeTestNoidAddr(5),
    bob_eth: makeTestEthAddr(5),
  });

  const snap = parseOffersSnapshot(
    makeRawSnapshot({
      min_pow_bits: 16,
      offers: [
        tamperedValid,
        // Unpinned contract -> dropped
        makeRawOffer({ event_id: makePowEventId("1"), d: "a".repeat(32), code: unpinnedCode }),
        // Raw JSON instead of no1dinv1: -> dropped
        makeRawOffer({ event_id: makePowEventId("2"), d: "b".repeat(32), code: rawJsonCode }),
        // Expired offer -> dropped
        makeRawOffer({
          event_id: makePowEventId("3"),
          d: "c".repeat(32),
          created_at: "2026-11-26T18:00:00Z",
          expires_at: "2026-11-26T20:00:00Z",
        }),
        // Future created_at (> 5 min) -> dropped
        makeRawOffer({
          event_id: makePowEventId("4"),
          d: "d".repeat(32),
          created_at: "2026-11-26T20:36:00Z",
          expires_at: "2026-11-26T22:00:00Z",
        }),
        // Below min_pow_bits -> dropped
        makeRawOffer({ event_id: makePowEventId("5"), d: "e".repeat(32), pow_bits: 12 }),
        // Tampered checksum -> dropped
        makeRawOffer({
          event_id: makePowEventId("6"),
          d: "f".repeat(32),
          code: validMainnetCode.slice(0, -1) + (validMainnetCode.endsWith("A") ? "B" : "A"),
        }),
        // Inflated pow_bits (claims 32 bits on 0-bit event_id) -> dropped by browser leading-zero check
        makeRawOffer({
          event_id: "f".repeat(64),
          d: "7".repeat(32),
          pow_bits: 32,
          code: validMainnetCode,
        }),
        // Claims 17 bits on 16-bit event_id (0x00008...) -> dropped
        makeRawOffer({
          event_id: "00008" + "a".repeat(59),
          d: "8".repeat(32),
          pow_bits: 17,
          code: validMainnetCode,
        }),
      ],
    }),
    BASE_NOW_MS,
  );

  assert.equal(snap.ok, true);
  assert.equal(snap.offers.length, 1);
  assert.equal(snap.droppedCount, 8);

  const kept = snap.offers[0];
  assert.equal(kept.decoded.fields.network, "mainnet");
  assert.equal(kept.decoded.fields.eth_amount, "0.1");
  assert.equal(kept.decoded.fields.noid_amount, "500");
  assert.equal(kept.decoded.fields.bob_eth, makeTestEthAddr(2));
  assert.equal(kept.note, "Clean note\u0301\u0302");
  assert.equal(kept.pubkeyShort, formatPubkeyShort("d".repeat(64)));
});

test("parseOffersSnapshot independently recomputes copied/duplicate offers across pubkeys, repeated Bob addresses, and liveness buckets", () => {
  const sharedCode = makeValidInviteCode({ network: "mainnet", noidAmount: "200", ethAmount: "0.04", seed: 10 });
  const sameBobDifferentTerms = encodeInvite({
    network: "mainnet",
    noidAmount: "300",
    ethAmount: "0.06",
    bobNoid: makeTestNoidAddr(10), // repeated bob_noid
    bobEth: makeTestEthAddr(11),
  }).canonicalCode;

  const id1 = makePowEventId("1");
  const id2 = makePowEventId("2");
  const id3 = makePowEventId("3");

  const snap = parseOffersSnapshot(
    makeRawSnapshot({
      offers: [
        // Earliest poster of sharedCode (pubkey 1)
        makeRawOffer({
          event_id: id1,
          d: "1".repeat(32),
          pubkey: "a".repeat(64),
          created_at: "2026-11-26T20:10:00Z",
          code: sharedCode,
          liveness: { status: "stale", last_seen_at: "2026-11-26T20:25:00Z", has_heartbeat: true },
          // Tampered flags claiming NOT duplicate — browser must ignore and recompute!
          flags: { duplicate_payload: false, is_earliest_payload: false, repeated_bob_address: false },
        }),
        // Copycat poster of identical sharedCode (pubkey 2, later timestamp)
        makeRawOffer({
          event_id: id2,
          d: "2".repeat(32),
          pubkey: "b".repeat(64),
          created_at: "2026-11-26T20:20:00Z",
          code: sharedCode,
          liveness: { status: "online", last_seen_at: "2026-11-26T17:00:00Z", has_heartbeat: false },
          flags: { duplicate_payload: false, is_earliest_payload: true, repeated_bob_address: false },
        }),
        // Distinct offer reusing Bob's NOID address
        makeRawOffer({
          event_id: id3,
          d: "3".repeat(32),
          pubkey: "c".repeat(64),
          created_at: "2026-11-26T20:22:00Z",
          code: sameBobDifferentTerms,
          liveness: { status: "online", last_seen_at: "2026-11-26T19:45:00Z", has_heartbeat: false },
        }),
      ],
    }),
    BASE_NOW_MS,
  );

  assert.equal(snap.ok, true);
  assert.equal(snap.offers.length, 3);

  const byId = new Map(snap.offers.map((o) => [o.eventId, o]));
  const original = byId.get(id1);
  const copy = byId.get(id2);
  const repeatedBob = byId.get(id3);

  // Neutral duplicate flags recomputed independently (never trusts self-declared created_at to assign blame)
  assert.equal(original.flags.duplicatePayload, true);
  assert.equal(original.flags.duplicateCount, 2);
  assert.equal(original.flags.distinctPubkeys, 2);
  assert.equal(original.flags.duplicateAcrossPubkeys, true);
  assert.equal(original.flags.repeatedBobAddress, true);
  assert.equal(original.liveness.status, "online"); // 5 min old WITH signed heartbeat
  assert.equal(original.liveness.hasHeartbeat, true);

  assert.equal(copy.flags.duplicatePayload, true);
  assert.equal(copy.flags.duplicateCount, 2);
  assert.equal(copy.flags.distinctPubkeys, 2);
  assert.equal(copy.flags.duplicateAcrossPubkeys, true);
  // Without a signed heartbeat, a 10-min-old offer MUST NOT be "online" (stays "recent")
  assert.equal(copy.liveness.hasHeartbeat, false);
  assert.equal(copy.liveness.status, "recent");

  assert.equal(repeatedBob.flags.duplicatePayload, false);
  assert.equal(repeatedBob.flags.repeatedBobAddress, true);
  assert.equal(repeatedBob.liveness.hasHeartbeat, false);
  assert.equal(repeatedBob.liveness.status, "recent");
  assert.equal(computeLivenessBucket(BASE_NOW_MS - LIVENESS_ONLINE_MS, BASE_NOW_MS), "online");
  assert.equal(computeLivenessBucket(BASE_NOW_MS - LIVENESS_ONLINE_MS - 1000, BASE_NOW_MS), "recent");
  assert.equal(computeLivenessBucket(BASE_NOW_MS - LIVENESS_RECENT_MS - 1000, BASE_NOW_MS), "stale");
});

test("loadSameOriginOffersSnapshot blocks external URLs, enforces 1 MB cap, and sets strict fetch options", async () => {
  let called = false;
  const spyFetch = async () => {
    called = true;
    throw new Error("should not be called");
  };

  for (const badUrl of [
    "https://relay.example.org/offers.json",
    "http://127.0.0.1:8080/data/offers.json",
    "//evil.example/offers.json",
    "../offers.json",
    "./data/offers.json?x=1",
  ]) {
    const res = await loadSameOriginOffersSnapshot(badUrl, spyFetch, BASE_NOW_MS);
    assert.equal(res.ok, false);
    assert.equal(called, false);
  }

  // Content-Length > 1 MB
  const bigHeader = await loadSameOriginOffersSnapshot(
    OFFERS_SNAPSHOT_URL,
    async () => ({
      ok: true,
      headers: new Headers({ "content-length": String(MAX_OFFERS_BYTES + 1) }),
      text: async () => "{}",
    }),
    BASE_NOW_MS,
  );
  assert.equal(bigHeader.ok, false);

  // Streamed body > 1 MB
  const bigStream = await loadSameOriginOffersSnapshot(
    OFFERS_SNAPSHOT_URL,
    async () => ({
      ok: true,
      headers: new Headers(),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(600_000).fill(0x20));
          controller.enqueue(new Uint8Array(600_000).fill(0x20));
          controller.close();
        },
      }),
    }),
    BASE_NOW_MS,
  );
  assert.equal(bigStream.ok, false);

  // Happy path loads shipped data/offers.json with strict fetch options
  let captured = null;
  const raw = fs.readFileSync(OFFERS_JSON_PATH, "utf8");
  const okRes = await loadSameOriginOffersSnapshot(
    OFFERS_SNAPSHOT_URL,
    async (url, opts) => {
      captured = { url, opts };
      return {
        ok: true,
        headers: new Headers({ "content-length": String(Buffer.byteLength(raw, "utf8")) }),
        text: async () => raw,
      };
    },
    BASE_NOW_MS,
  );
  assert.equal(okRes.ok, true);
  assert.equal(okRes.isSample, true);
  assert.equal(captured.url, "./data/offers.json");
  assert.equal(captured.opts.credentials, "omit");
  assert.equal(captured.opts.redirect, "error");
  assert.equal(captured.opts.referrerPolicy, "no-referrer");
  assert.equal(captured.opts.cache, "no-store");

  // Pub/sub store
  const seen = [];
  const unsub = onOffersSnapshotChange((s) => seen.push(s));
  setCurrentOffersSnapshot(okRes);
  assert.equal(getCurrentOffersSnapshot(), okRes);
  assert.equal(seen.length, 1);
  unsub();
  setCurrentOffersSnapshot(null);
  assert.equal(seen.length, 1);
});

test("DOM-free security audit: zero HTML-string sinks in JS, resolveOfferForDisplay fails closed, and UI widgets render safely", async () => {
  // 1. Static source check: zero HTML-string sinks across all browser modules
  for (const rel of ["js/offers-data.js", "js/board-ui.js", "js/market-ui.js", "js/market-data.js"]) {
    const src = fs.readFileSync(path.resolve(ROOT_DIR, rel), "utf8");
    assert.doesNotMatch(src, /\.innerHTML\s*=/);
    assert.doesNotMatch(src, /\.outerHTML\s*=/);
    assert.doesNotMatch(src, /insertAdjacentHTML\s*\(/);
    assert.doesNotMatch(src, /document\.write\s*\(/);
  }

  // 2. resolveOfferForDisplay refuses unpinned contracts and ignores untrusted fields
  const unpinnedCode = makeValidInviteCode({
    network: "mainnet",
    contract: toChecksumAddress("0xdead00000000000000000000000000000000beef"),
    seed: 99,
  });
  assert.equal(resolveOfferForDisplay({ code: unpinnedCode }), null);
  assert.equal(resolveOfferForDisplay({ code: "not-a-code" }), null);

  // 3. Minimal mock DOM check for market-ui.js Unconfirmed copy polish & board-ui.js live offer badges
  class MockNode {
    constructor(tag) {
      this.tagName = tag.toUpperCase();
      this.className = "";
      this.attrs = new Map();
      this.children = [];
      this.parentNode = null;
      this._text = "";
      this.dataset = {};
      this.hidden = false;
      this.disabled = false;
      this.value = "";
      this.type = "";
      this.listeners = new Map();
      this.classList = {
        add: (cls) => {
          this.className = `${this.className} ${cls}`.trim();
        },
        remove: (cls) => {
          this.className = this.className
            .split(/\s+/)
            .filter((c) => c && c !== cls)
            .join(" ");
        },
      };
    }
    set textContent(v) {
      this._text = String(v);
      this.children = [];
    }
    get textContent() {
      if (this.children.length === 0) return this._text;
      return this.children.map((c) => c.textContent).join("");
    }
    get firstChild() {
      return this.children[0] || null;
    }
    appendChild(child) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    }
    removeChild(child) {
      const idx = this.children.indexOf(child);
      if (idx >= 0) {
        this.children.splice(idx, 1);
        child.parentNode = null;
      }
      return child;
    }
    setAttribute(k, v) {
      this.attrs.set(k, String(v));
      if (k === "id") this.id = String(v);
    }
    getAttribute(k) {
      return this.attrs.has(k) ? this.attrs.get(k) : null;
    }
    removeAttribute(k) {
      this.attrs.delete(k);
    }
    addEventListener(ev, fn) {
      const list = this.listeners.get(ev) || [];
      list.push(fn);
      this.listeners.set(ev, list);
    }
    focus() {}
    scrollIntoView() {}
  }

  const elementsById = new Map();
  const marketRoot = new MockNode("div");
  marketRoot.setAttribute("id", "market-strip-root");
  elementsById.set("market-strip-root", marketRoot);

  const boardRoot = new MockNode("div");
  boardRoot.setAttribute("id", "bulletin-board-root");
  elementsById.set("bulletin-board-root", boardRoot);

  const prevDoc = globalThis.document;
  globalThis.document = {
    readyState: "complete",
    body: new MockNode("body"),
    createElement: (tag) => new MockNode(tag),
    createTextNode: (txt) => {
      const n = new MockNode("#text");
      n._text = String(txt);
      return n;
    },
    getElementById: (id) => elementsById.get(id) || null,
    querySelector: () => null,
    addEventListener: () => {},
  };

  try {
    // Check market-ui.js when top_producer_share_pct is null ("Unconfirmed"):
    // b2185ed keeps STATIC_PRODUCER_WARNING (Measured on 2026-11-23, about 75 %) right next to "Unconfirmed"
    const unconfirmedSnap = parseMarketSnapshot(
      {
        v: 1,
        generated_at: "2026-11-26T20:25:00Z",
        sources: { eth_usd: "CoinGecko + Kraken", noid_usd: "Noidium" },
        eth_usd: 3200,
        noid_usd: 0.64,
        noid_usd_venue: "SafeTrade NOID/USDT",
        noid_volume_24h_usd: 15000,
        noid_price_ts: "2026-11-26T20:25:00Z",
        noid_price_stale: false,
        parano1d: {
          top_producer_share_pct: null,
          window_blocks: 144,
          measured_at: "2026-11-26T20:25:00Z",
        },
        eth_gas_gwei: null,
      },
      BASE_NOW_MS,
    );
    await mountMarketStrip({ snapshot: unconfirmedSnap });
    const marketText = marketRoot.textContent;
    assert.match(marketText, /Unconfirmed/);
    assert.match(marketText, /about 75 ?%/);
    assert.match(marketText, /2026-11-23/);
    assert.match(marketText, /65%/);

    // Check board-ui.js renders live Nostr offers with pubkey, PoW, liveness, copied offer warning, and repeated Bob warning
    const sharedCode = makeValidInviteCode({ network: "mainnet", noidAmount: "500", ethAmount: "0.1", seed: 20 });
    const offersSnap = parseOffersSnapshot(
      makeRawSnapshot({
        offers: [
          makeRawOffer({
            event_id: makePowEventId("1"),
            d: "1".repeat(32),
            pubkey: "a".repeat(64),
            created_at: "2026-11-26T20:15:00Z",
            pow_bits: 18,
            code: sharedCode,
            liveness: { status: "online", last_seen_at: "2026-11-26T20:28:00Z", has_heartbeat: true },
          }),
          makeRawOffer({
            event_id: makePowEventId("2"),
            d: "2".repeat(32),
            pubkey: "b".repeat(64),
            created_at: "2026-11-26T20:20:00Z",
            pow_bits: 16,
            code: sharedCode,
            liveness: { status: "recent", last_seen_at: "2026-11-26T20:20:00Z", has_heartbeat: false },
          }),
        ],
      }),
      BASE_NOW_MS,
    );

    mountBoardWidgets({ offersSnapshot: offersSnap, nowMs: BASE_NOW_MS });
    const boardText = boardRoot.textContent;
    assert.match(boardText, /Live Nostr offer \(untrusted\)/);
    assert.match(boardText, /PoW 18b/);
    assert.match(boardText, /Maker online/);
    assert.match(boardText, /Maker recent/);
    assert.match(boardText, /Same code from 2 keys/);
    assert.match(boardText, /times are self-declared/);
    assert.doesNotMatch(boardText, /Copied offer warning/);
    assert.match(boardText, /Repeated Bob address/);
    assert.match(boardText, /aaaaaaaa…aaaaaaaa/);
    assert.match(boardText, /bbbbbbbb…bbbbbbbb/);
    assert.match(boardText, /at reference/); // 500 NOID / 0.1 ETH = 5000 NOID/ETH == 3200 / 0.64

    // Verify "Maker online" badge uses neutral styling (never badge-safe green)
    const findNodes = (node, pred, out = []) => {
      if (pred(node)) out.push(node);
      for (const c of node.children || []) findNodes(c, pred, out);
      return out;
    };
    const onlineBadges = findNodes(boardRoot, (n) => n.textContent === "Maker online");
    assert.equal(onlineBadges.length, 1);
    assert.equal(onlineBadges[0].className, "badge badge-neutral");

    // Verify a sample:true snapshot with offers NEVER renders as live in board-ui.js
    const sampleSnapWithOffer = parseOffersSnapshot(
      makeRawSnapshot({
        sample: true,
        offers: [
          makeRawOffer({
            event_id: makePowEventId("9"),
            d: "9".repeat(32),
            pubkey: "e".repeat(64),
            code: sharedCode,
          }),
        ],
      }),
      BASE_NOW_MS,
    );
    mountBoardWidgets({ offersSnapshot: sampleSnapWithOffer, nowMs: BASE_NOW_MS });
    assert.doesNotMatch(boardRoot.textContent, /Live Nostr offer \(untrusted\)/);
    assert.doesNotMatch(boardRoot.textContent, /eeeeeeee…eeeeeeee/);

    // A relay reported as truncated shows one short neutral notice; none otherwise
    const CUT_NOTICE = "Some relay answers were cut short (possibly spam), so offers may be missing.";
    assert.doesNotMatch(boardRoot.textContent, /cut short/);
    const truncSnap = parseOffersSnapshot(
      makeRawSnapshot({
        relays: [{ url: "wss://relay.example.org", ok: true, events_received: 2, events_accepted: 1, truncated: true }],
      }),
      BASE_NOW_MS,
    );
    assert.equal(truncSnap.relays[0].truncated, true);
    mountBoardWidgets({ offersSnapshot: truncSnap, nowMs: BASE_NOW_MS });
    assert.ok(boardRoot.textContent.includes(CUT_NOTICE));

    // 4. Browser defense-in-depth rejects bob_eth === contract and bob_eth === 0x0000...0000
    const makeRawCode = (bobEth) => {
      const payload = Buffer.from(
        JSON.stringify({
          kind: "no1d-swap-invitation",
          v: 1,
          network: "mainnet",
          contract: NETWORK_SPECS.mainnet.pinnedContract,
          contract_version: 1,
          noid_micronoid: "100000000",
          eth_wei: "20000000000000000",
          bob_noid: makeTestNoidAddr(50),
          bob_eth: bobEth,
        }),
        "utf8",
      );
      const csum = Buffer.from(sha256(payload).subarray(0, 4));
      return `no1dinv1:${Buffer.concat([payload, csum]).toString("base64url")}`;
    };
    const badBobSnap = parseOffersSnapshot(
      makeRawSnapshot({
        offers: [
          makeRawOffer({
            event_id: makePowEventId("9"),
            d: "9".repeat(32),
            code: makeRawCode(NETWORK_SPECS.mainnet.pinnedContract),
          }),
          makeRawOffer({
            event_id: makePowEventId("8"),
            d: "8".repeat(32),
            code: makeRawCode("0x0000000000000000000000000000000000000000"),
          }),
        ],
      }),
      BASE_NOW_MS,
    );
    assert.equal(badBobSnap.ok, true);
    assert.equal(badBobSnap.offers.length, 0);
    assert.equal(badBobSnap.droppedCount, 2);

    // 5. Expired snapshot under Mainnet filter shows expired/unavailable message instead of generic empty text
    const expiredSnap = parseOffersSnapshot(
      makeRawSnapshot({ generated_at: "2026-11-26T12:00:00Z" }),
      BASE_NOW_MS,
    );
    assert.equal(expiredSnap.isExpired, true);
    mountBoardWidgets({ offersSnapshot: expiredSnap, nowMs: BASE_NOW_MS });
    const findNode = (node, pred) => {
      if (pred(node)) return node;
      for (const ch of node.children) {
        const hit = findNode(ch, pred);
        if (hit) return hit;
      }
      return null;
    };
    const mainnetBtn = findNode(
      boardRoot,
      (n) => n.tagName === "BUTTON" && n.textContent === "Mainnet",
    );
    assert.ok(mainnetBtn);
    for (const fn of mainnetBtn.listeners.get("click") || []) fn();
    assert.match(boardRoot.textContent, /older than 6 h \(expired\)/i);
  } finally {
    globalThis.document = prevDoc;
  }
});
