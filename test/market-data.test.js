import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  EXPIRE_AFTER_MS,
  LOW_VOLUME_USD_THRESHOLD,
  MARKET_SNAPSHOT_URL,
  MAX_FUTURE_SKEW_MS,
  MAX_MARKET_BYTES,
  STALE_AFTER_MS,
  canShowOfferReferenceDiff,
  computeSwapEstimate,
  formatAgeLabel,
  formatQuoteNumber,
  formatReferenceDiff,
  formatUsd,
  formatUsdVolume,
  getCurrentSnapshot,
  isSameOriginPath,
  loadSameOriginSnapshot,
  onSnapshotChange,
  parseMarketSnapshot,
  parseUtcIsoStrict,
  setCurrentSnapshot,
} from "../js/market-data.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MARKET_JSON_PATH = path.resolve(__dirname, "..", "data", "market.json");

function validSampleObj(overrides = {}) {
  return {
    v: 1,
    generated_at: "2026-11-26T13:30:00Z",
    sources: {
      eth_usd: "Host feed",
      noid_usd: "Host feed",
    },
    eth_usd: 3200,
    noid_usd: 0.64,
    noid_usd_venue: "Exchange X",
    noid_volume_24h_usd: 12500,
    noid_price_ts: "2026-11-26T13:30:00Z",
    noid_price_stale: false,
    parano1d: {
      top_producer_share_pct: 75.0,
      window_blocks: 144,
      measured_at: "2026-11-26T13:30:00Z",
    },
    eth_gas_gwei: 0.8,
    ...overrides,
  };
}

test("default data/market.json matches exact #15+#17 schema, is clearly sample-labelled, and parses cleanly", () => {
  assert.equal(LOW_VOLUME_USD_THRESHOLD, 10000);
  const raw = fs.readFileSync(MARKET_JSON_PATH, "utf8");
  assert.ok(Buffer.byteLength(raw, "utf8") <= MAX_MARKET_BYTES);

  const now = Date.parse("2026-11-26T13:40:00Z");
  const snap = parseMarketSnapshot(raw, now);
  assert.equal(snap.ok, true);
  assert.equal(snap.isSample, true);
  assert.equal(snap.freshness, "fresh");
  assert.equal(snap.pricesVisible, true);
  assert.equal(snap.ethUsd, 3200);
  assert.equal(snap.noidUsd, 0.64);
  assert.equal(snap.noidUsdVenue, "Sample venue (not live)");
  assert.equal(snap.noidVolume24hUsd, 12500);
  assert.equal(snap.noidPriceTsUtc, "2026-11-26T13:30:00Z");
  assert.equal(snap.noidPriceAgeMs, 10 * 60 * 1000);
  assert.equal(snap.noidPriceStale, false);
  assert.equal(snap.noidLowVolume, false);
  assert.equal(snap.noidPriceMuted, false);
  assert.equal(snap.impliedNoidPerEth, 5000);
  assert.equal(snap.impliedEthPerNoid, 0.0002);
  assert.equal(snap.sources.ethUsd, "Sample data");
  assert.equal(snap.sources.noidUsd, "Sample data");
  assert.equal(snap.parano1d.topProducerSharePct, 75);
  assert.equal(snap.parano1d.shareUnavailable, false);
  assert.equal(snap.parano1d.shareStale, false);
  assert.equal(snap.parano1d.shareExpired, false);
  assert.equal(snap.parano1d.windowBlocks, 144);
  assert.equal(snap.parano1d.measuredAtUtc, "2026-11-26T13:30:00Z");
  assert.equal(snap.ethGasGwei, 0.8);
});

test("isSameOriginPath allows only safe relative ./ or / paths on self", () => {
  assert.equal(isSameOriginPath(MARKET_SNAPSHOT_URL), true);
  assert.equal(isSameOriginPath("./data/market.json"), true);
  assert.equal(isSameOriginPath("/data/market.json"), true);

  const rejected = [
    "https://api.example.com/market.json",
    "http://127.0.0.1:8080/data/market.json",
    "//cdn.example.com/market.json",
    "data:application/json,{}",
    "javascript:alert(1)",
    "file:///etc/passwd",
    "blob:https://example.com/123",
    "../secret.json",
    "./data/../secret.json",
    "/data//market.json",
    "./data/market.json?x=1",
    "./data/market.json#frag",
    "./data/market.json\\@evil.example",
    "data/market.json",
    "",
    "   ",
    null,
    undefined,
    42,
  ];
  for (const bad of rejected) {
    assert.equal(isSameOriginPath(bad), false, `expected reject for ${String(bad)}`);
  }
});

test("parseMarketSnapshot ignores unknown keys, sanitizes sources/venue, and enforces age thresholds (<=30m fresh, 31m stale, >6h hidden)", () => {
  const baseMs = Date.parse("2026-11-26T13:30:00Z");

  // Unknown keys ignored + source/venue sanitization
  const withExtras = parseMarketSnapshot(
    validSampleObj({
      extra_future_field: "ignored",
      noid_usd_venue: "Small\u202E\u200B\u3164 Venue\uFE0F",
      sources: {
        eth_usd: "Feed\u202E\u200B\u3164 A\u0301\u0302\u0303\u0304",
        noid_usd: "Feed B\uFE0F",
        extra_source: "ignored",
      },
    }),
    baseMs + 30 * 60 * 1000, // exactly 30 min -> still fresh
  );
  assert.equal(withExtras.ok, true);
  assert.equal(withExtras.freshness, "fresh");
  assert.equal(withExtras.isStale, false);
  assert.equal(withExtras.isExpired, false);
  assert.equal(withExtras.pricesVisible, true);
  assert.equal(withExtras.sources.ethUsd, "Feed A\u0301\u0302");
  assert.equal(withExtras.sources.noidUsd, "Feed B");
  assert.equal(withExtras.noidUsdVenue, "Small Venue");

  // 31 min -> stale (prices still visible, marked stale)
  const staleSnap = parseMarketSnapshot(validSampleObj(), baseMs + STALE_AFTER_MS + 60_000);
  assert.equal(staleSnap.ok, true);
  assert.equal(staleSnap.freshness, "stale");
  assert.equal(staleSnap.isStale, true);
  assert.equal(staleSnap.noidPriceStale, true);
  assert.equal(staleSnap.noidPriceMuted, true);
  assert.equal(staleSnap.isExpired, false);
  assert.equal(staleSnap.pricesVisible, true);
  assert.equal(staleSnap.ethUsd, 3200);
  assert.equal(staleSnap.noidUsd, 0.64);
  assert.equal(staleSnap.impliedNoidPerEth, 5000);

  // Exactly 6 h -> still stale (not yet expired)
  const atSixHours = parseMarketSnapshot(validSampleObj(), baseMs + EXPIRE_AFTER_MS);
  assert.equal(atSixHours.ok, true);
  assert.equal(atSixHours.freshness, "stale");
  assert.equal(atSixHours.isExpired, false);
  assert.equal(atSixHours.pricesVisible, true);

  // 6 h + 1 min -> expired (prices hidden, no implied rate, statusLabel Prices unavailable)
  const expiredSnap = parseMarketSnapshot(validSampleObj(), baseMs + EXPIRE_AFTER_MS + 60_000);
  assert.equal(expiredSnap.ok, true);
  assert.equal(expiredSnap.freshness, "expired");
  assert.equal(expiredSnap.isExpired, true);
  assert.equal(expiredSnap.pricesVisible, false);
  assert.equal(expiredSnap.statusLabel, "Prices unavailable");
  assert.equal(expiredSnap.ethUsd, null);
  assert.equal(expiredSnap.noidUsd, null);
  assert.equal(expiredSnap.impliedNoidPerEth, null);
  assert.equal(expiredSnap.impliedEthPerNoid, null);
  assert.equal(expiredSnap.hasPrices, false);
  assert.equal(expiredSnap.parano1d.shareExpired, true);
  assert.equal(expiredSnap.parano1d.shareUnavailable, true);
  assert.equal(expiredSnap.parano1d.topProducerSharePct, null);

  // Small future clock skew (<= 5 min) is tolerated with ageMs = 0
  assert.equal(MAX_FUTURE_SKEW_MS, 5 * 60 * 1000);
  const slightFuture = parseMarketSnapshot(
    validSampleObj({
      generated_at: "2026-11-26T13:35:00Z",
      noid_price_ts: "2026-11-26T13:35:00Z",
      parano1d: {
        top_producer_share_pct: 75,
        window_blocks: 144,
        measured_at: "2026-11-26T13:35:00Z",
      },
    }),
    baseMs,
  );
  assert.equal(slightFuture.ok, true);
  assert.equal(slightFuture.ageMs, 0);
  assert.equal(slightFuture.noidPriceAgeMs, 0);
  assert.equal(slightFuture.parano1d.measuredAtAgeMs, 0);

  // Timestamps > 5 min ahead fail the entire snapshot ("Prices unavailable")
  for (const futureOverride of [
    { generated_at: "2026-11-26T13:35:01Z" },
    { generated_at: "2030-01-01T00:00:00Z" },
    { noid_price_ts: "2026-11-26T13:35:01Z" },
    { noid_price_ts: "2099-01-01T00:00:00Z" },
    { parano1d: { top_producer_share_pct: 75, window_blocks: 144, measured_at: "2026-11-26T13:35:01Z" } },
  ]) {
    const failed = parseMarketSnapshot(validSampleObj(futureOverride), baseMs);
    assert.equal(failed.ok, false);
    assert.equal(failed.status, "unavailable");
    assert.equal(failed.statusLabel, "Prices unavailable");
    assert.equal(failed.pricesVisible, false);
    assert.equal(failed.ethUsd, null);
    assert.equal(failed.noidUsd, null);
  }

  // Calendar/clock rollovers are strictly rejected
  assert.equal(parseUtcIsoStrict("2026-02-31T00:00:00Z"), null);
  assert.equal(parseUtcIsoStrict("2026-11-26T24:00:00Z"), null);
  assert.equal(parseMarketSnapshot(validSampleObj({ generated_at: "2026-02-31T00:00:00Z" }), baseMs).ok, false);
  assert.equal(parseMarketSnapshot(validSampleObj({ noid_price_ts: "2026-11-26T24:00:00Z" }), baseMs).ok, false);
});

test("parano1d.measured_at enforces 30 min stale and 6 h expiry rules independently", () => {
  const now = Date.parse("2026-11-26T14:00:00Z");

  // 31 min old measured_at while generated_at is fresh -> shareStale: true, still shown
  const staleShare = parseMarketSnapshot(
    validSampleObj({
      generated_at: "2026-11-26T13:55:00Z",
      noid_price_ts: "2026-11-26T13:55:00Z",
      parano1d: {
        top_producer_share_pct: 75,
        window_blocks: 144,
        measured_at: "2026-11-26T13:29:00Z",
      },
    }),
    now,
  );
  assert.equal(staleShare.ok, true);
  assert.equal(staleShare.isStale, false);
  assert.equal(staleShare.parano1d.shareStale, true);
  assert.equal(staleShare.parano1d.shareExpired, false);
  assert.equal(staleShare.parano1d.shareUnavailable, false);
  assert.equal(staleShare.parano1d.topProducerSharePct, 75);

  // > 6 h old measured_at while generated_at is fresh -> share hidden (null), prices remain visible
  const expiredShare = parseMarketSnapshot(
    validSampleObj({
      generated_at: "2026-11-26T13:55:00Z",
      noid_price_ts: "2026-11-26T13:55:00Z",
      parano1d: {
        top_producer_share_pct: 75,
        window_blocks: 144,
        measured_at: "2026-11-26T07:59:00Z",
      },
    }),
    now,
  );
  assert.equal(expiredShare.ok, true);
  assert.equal(expiredShare.pricesVisible, true);
  assert.equal(expiredShare.ethUsd, 3200);
  assert.equal(expiredShare.noidUsd, 0.64);
  assert.equal(expiredShare.parano1d.shareExpired, true);
  assert.equal(expiredShare.parano1d.shareUnavailable, true);
  assert.equal(expiredShare.parano1d.topProducerSharePct, null);
});

test("canShowOfferReferenceDiff restricts diffs to mainnet with fresh, unmuted snapshots only", () => {
  const baseMs = Date.parse("2026-11-26T13:30:00Z");

  const fresh = parseMarketSnapshot(validSampleObj(), baseMs + 5 * 60 * 1000);
  assert.equal(canShowOfferReferenceDiff(fresh, "mainnet"), true);
  assert.equal(canShowOfferReferenceDiff(fresh, "sepolia"), false);

  const staleSnap = parseMarketSnapshot(validSampleObj(), baseMs + STALE_AFTER_MS + 60_000);
  assert.equal(canShowOfferReferenceDiff(staleSnap, "mainnet"), false);

  const thinVol = parseMarketSnapshot(validSampleObj({ noid_volume_24h_usd: 9999 }), baseMs + 5 * 60 * 1000);
  assert.equal(canShowOfferReferenceDiff(thinVol, "mainnet"), false);

  const venueStale = parseMarketSnapshot(validSampleObj({ noid_price_stale: true }), baseMs + 5 * 60 * 1000);
  assert.equal(canShowOfferReferenceDiff(venueStale, "mainnet"), false);

  const expired = parseMarketSnapshot(validSampleObj(), baseMs + EXPIRE_AFTER_MS + 60_000);
  assert.equal(canShowOfferReferenceDiff(expired, "mainnet"), false);
  assert.equal(canShowOfferReferenceDiff(null, "mainnet"), false);
});

test("#17 NOID venue fields: low volume (<10000), noid_price_stale, and >6h noid_price_ts", () => {
  const now = Date.parse("2026-11-26T13:35:00Z");

  // Volume < 10000 (4200 and 0) -> noidLowVolume & noidPriceMuted
  for (const vol of [4200, 0]) {
    const low = parseMarketSnapshot(validSampleObj({ noid_volume_24h_usd: vol }), now);
    assert.equal(low.ok, true);
    assert.equal(low.noidVolume24hUsd, vol);
    assert.equal(low.noidLowVolume, true);
    assert.equal(low.noidPriceStale, false);
    assert.equal(low.noidPriceMuted, true);
  }

  // Boundary: 10000 -> NOT low volume
  const atThreshold = parseMarketSnapshot(validSampleObj({ noid_volume_24h_usd: 10000 }), now);
  assert.equal(atThreshold.ok, true);
  assert.equal(atThreshold.noidLowVolume, false);
  assert.equal(atThreshold.noidPriceMuted, false);

  // noid_price_stale: true -> muted even with fresh generated_at & high volume
  const flagStale = parseMarketSnapshot(validSampleObj({ noid_price_stale: true }), now);
  assert.equal(flagStale.ok, true);
  assert.equal(flagStale.isStale, false);
  assert.equal(flagStale.noidPriceStale, true);
  assert.equal(flagStale.noidPriceMuted, true);

  // noid_price_ts > 30m old (while generated_at is fresh) -> noidPriceStale & muted
  const venueOld35m = parseMarketSnapshot(
    validSampleObj({
      generated_at: "2026-11-26T13:30:00Z",
      noid_price_ts: "2026-11-26T12:55:00Z",
    }),
    now,
  );
  assert.equal(venueOld35m.ok, true);
  assert.equal(venueOld35m.isStale, false);
  assert.equal(venueOld35m.noidPriceStale, true);
  assert.equal(venueOld35m.noidPriceMuted, true);
  assert.equal(venueOld35m.hasNoidPrice, true);

  // noid_price_ts > 6h old (while generated_at is fresh) -> hides NOID price & implied rate, keeps ETH price
  const venueExpired = parseMarketSnapshot(
    validSampleObj({
      generated_at: "2026-11-26T13:30:00Z",
      noid_price_ts: "2026-11-26T07:00:00Z",
    }),
    now,
  );
  assert.equal(venueExpired.ok, true);
  assert.equal(venueExpired.pricesVisible, true);
  assert.equal(venueExpired.ethUsd, 3200);
  assert.equal(venueExpired.noidPriceExpired, true);
  assert.equal(venueExpired.hasNoidPrice, false);
  assert.equal(venueExpired.noidUsd, null);
  assert.equal(venueExpired.impliedNoidPerEth, null);
  assert.equal(venueExpired.impliedEthPerNoid, null);
});

test("noid_usd: null allows null venue/volume/ts and hides NOID USD price and implied rate", () => {
  const now = Date.parse("2026-11-26T13:35:00Z");
  const snap = parseMarketSnapshot(
    validSampleObj({
      noid_usd: null,
      noid_usd_venue: null,
      noid_volume_24h_usd: null,
      noid_price_ts: null,
      sources: { eth_usd: "Exchange A", noid_usd: null },
      eth_gas_gwei: null,
    }),
    now,
  );
  assert.equal(snap.ok, true);
  assert.equal(snap.pricesVisible, true);
  assert.equal(snap.ethUsd, 3200);
  assert.equal(snap.noidUsd, null);
  assert.equal(snap.noidUsdVenue, null);
  assert.equal(snap.noidVolume24hUsd, null);
  assert.equal(snap.noidPriceTsUtc, null);
  assert.equal(snap.hasNoidPrice, false);
  assert.equal(snap.hasPrices, false);
  assert.equal(snap.impliedNoidPerEth, null);
  assert.equal(snap.impliedEthPerNoid, null);
  assert.equal(snap.ethGasGwei, null);
  assert.equal(formatReferenceDiff(5000, snap.impliedNoidPerEth), null);
});

test("#19 eth_usd: null and parano1d.top_producer_share_pct: null degrade gracefully without crashing snapshot", () => {
  const now = Date.parse("2026-11-26T13:35:00Z");

  // eth_usd: null (CoinGecko/Kraken disagreed > 2%) while NOID price stays valid
  const noEth = parseMarketSnapshot(
    validSampleObj({
      eth_usd: null,
      sources: { eth_usd: null, noid_usd: "Host feed" },
    }),
    now,
  );
  assert.equal(noEth.ok, true);
  assert.equal(noEth.hasEthPrice, false);
  assert.equal(noEth.ethUsd, null);
  assert.equal(noEth.hasNoidPrice, true);
  assert.equal(noEth.noidUsd, 0.64);
  assert.equal(noEth.hasPrices, false);
  assert.equal(noEth.impliedNoidPerEth, null);
  assert.equal(noEth.impliedEthPerNoid, null);

  // parano1d.top_producer_share_pct: null (explorer & node disagreed > 3 pts)
  const noShare = parseMarketSnapshot(
    validSampleObj({
      parano1d: { top_producer_share_pct: null, window_blocks: 144, measured_at: "2026-11-23T00:00:00Z" },
    }),
    now,
  );
  assert.equal(noShare.ok, true);
  assert.equal(noShare.parano1d.topProducerSharePct, null);
  assert.equal(noShare.parano1d.shareUnavailable, true);
  assert.equal(noShare.hasEthPrice, true);

  const noShareAllNull = parseMarketSnapshot(
    validSampleObj({
      parano1d: { top_producer_share_pct: null, window_blocks: null, measured_at: null },
    }),
    now,
  );
  assert.equal(noShareAllNull.ok, true);
  assert.equal(noShareAllNull.parano1d.shareUnavailable, true);
  assert.equal(noShareAllNull.parano1d.windowBlocks, null);
  assert.equal(noShareAllNull.parano1d.measuredAtUtc, null);
});

test("parseMarketSnapshot fails closed on missing/invalid fields, <=0/NaN numbers, and >1MB payloads", () => {
  const now = Date.parse("2026-11-26T13:35:00Z");
  const invalidCases = [
    null,
    "not-json",
    "\ufeff" + JSON.stringify(validSampleObj()),
    " ".repeat(MAX_MARKET_BYTES + 1),
    validSampleObj({ v: 2 }),
    validSampleObj({ generated_at: "2026-11-26T13:30:00+02:00" }),
    validSampleObj({ sources: null }),
    validSampleObj({ sources: { eth_usd: "", noid_usd: "Feed" } }),
    validSampleObj({ sources: { eth_usd: "\u200B\u202E", noid_usd: "Feed" } }),
    validSampleObj({ sources: { eth_usd: null, noid_usd: "Feed" } }), // eth_usd present but source null
    validSampleObj({ sources: { eth_usd: "Feed", noid_usd: null } }), // noid_usd present but source null
    validSampleObj({ eth_usd: 0 }),
    validSampleObj({ eth_usd: -100 }),
    validSampleObj({ eth_usd: NaN }),
    validSampleObj({ eth_usd: Infinity }),
    validSampleObj({ eth_usd: "3200" }),
    validSampleObj({ noid_usd: 0 }),
    validSampleObj({ noid_usd: -0.5 }),
    validSampleObj({ noid_usd_venue: null }), // required when noid_usd !== null
    validSampleObj({ noid_usd_venue: "" }),
    validSampleObj({ noid_usd_venue: "\u200B" }),
    validSampleObj({ noid_volume_24h_usd: null }), // required when noid_usd !== null
    validSampleObj({ noid_volume_24h_usd: -1 }),
    validSampleObj({ noid_volume_24h_usd: NaN }),
    validSampleObj({ noid_volume_24h_usd: "12500" }),
    validSampleObj({ noid_price_ts: null }), // required when noid_usd !== null
    validSampleObj({ noid_price_ts: "2026-11-26T13:30:00+02:00" }),
    validSampleObj({ noid_price_stale: undefined }), // required when noid_usd !== null
    validSampleObj({ noid_price_stale: "false" }),
    validSampleObj({ parano1d: null }),
    validSampleObj({ parano1d: { top_producer_share_pct: 0, window_blocks: 144, measured_at: "2026-11-23T00:00:00Z" } }),
    validSampleObj({ parano1d: { top_producer_share_pct: 101, window_blocks: 144, measured_at: "2026-11-23T00:00:00Z" } }),
    validSampleObj({ parano1d: { top_producer_share_pct: 75, window_blocks: 14.5, measured_at: "2026-11-23T00:00:00Z" } }),
    validSampleObj({ parano1d: { top_producer_share_pct: 75, window_blocks: 0, measured_at: "2026-11-23T00:00:00Z" } }),
    validSampleObj({ parano1d: { top_producer_share_pct: 75, window_blocks: 144, measured_at: "invalid" } }),
    validSampleObj({ eth_gas_gwei: 0 }),
    validSampleObj({ eth_gas_gwei: -1 }),
  ];
  for (const bad of invalidCases) {
    const res = parseMarketSnapshot(bad, now);
    assert.equal(res.ok, false);
    assert.equal(res.status, "unavailable");
    assert.equal(res.statusLabel, "Prices unavailable");
    assert.equal(res.pricesVisible, false);
    assert.equal(res.ethUsd, null);
    assert.equal(res.noidUsd, null);
  }
});

test("loadSameOriginSnapshot blocks external URLs before fetch, enforces 1 MB cap, and fails closed", async () => {
  let called = false;
  const spyFetch = async () => {
    called = true;
    throw new Error("should not be called");
  };

  const ext = await loadSameOriginSnapshot("https://api.example.com/prices.json", spyFetch);
  assert.equal(ext.ok, false);
  assert.equal(ext.statusLabel, "Prices unavailable");
  assert.equal(called, false);

  // Oversize response rejected via Content-Length and via body length (> 1 MB)
  const bigHeaderFetch = async () => ({
    ok: true,
    headers: new Headers({ "content-length": String(MAX_MARKET_BYTES + 1) }),
    text: async () => "{}",
  });
  const rBigHeader = await loadSameOriginSnapshot("./data/market.json", bigHeaderFetch);
  assert.equal(rBigHeader.ok, false);
  assert.equal(rBigHeader.statusLabel, "Prices unavailable");

  const bigBodyFetch = async () => ({
    ok: true,
    headers: new Headers(),
    text: async () => "x".repeat(MAX_MARKET_BYTES + 1),
  });
  const rBigBody = await loadSameOriginSnapshot("./data/market.json", bigBodyFetch);
  assert.equal(rBigBody.ok, false);

  // Valid fetch loads data/market.json cleanly with strict fetch options
  let capturedOpts = null;
  const raw = fs.readFileSync(MARKET_JSON_PATH, "utf8");
  const okFetch = async (url, opts) => {
    capturedOpts = { url, opts };
    return {
      ok: true,
      headers: new Headers({ "content-length": String(Buffer.byteLength(raw, "utf8")) }),
      text: async () => raw,
    };
  };
  const loaded = await loadSameOriginSnapshot(
    MARKET_SNAPSHOT_URL,
    okFetch,
    Date.parse("2026-11-26T13:40:00Z"),
  );
  assert.equal(loaded.ok, true);
  assert.equal(loaded.isSample, true);
  assert.equal(capturedOpts.url, "./data/market.json");
  assert.equal(capturedOpts.opts.credentials, "omit");
  assert.equal(capturedOpts.opts.redirect, "error");
  assert.equal(capturedOpts.opts.referrerPolicy, "no-referrer");
});

test("formatReferenceDiff returns plain neutral comparison text or null", () => {
  assert.equal(formatReferenceDiff(4700, 5000), "6% below reference");
  assert.equal(formatReferenceDiff(5200, 5000), "4% above reference");
  assert.equal(formatReferenceDiff(5000, 5000), "at reference");
  assert.equal(formatReferenceDiff(5010, 5000), "at reference");
  assert.equal(formatReferenceDiff(null, 5000), null);
  assert.equal(formatReferenceDiff(5000, null), null);
  assert.equal(formatReferenceDiff(0, 5000), null);
  assert.equal(formatReferenceDiff(5000, -1), null);
  assert.equal(formatReferenceDiff(NaN, 5000), null);
});

test("computeSwapEstimate, format helpers, and shared snapshot pub/sub", () => {
  const small = computeSwapEstimate({ amount: "10", side: "noid", ethUsd: 3200, noidUsd: 0.64 });
  assert.equal(small.ok, true);
  assert.equal(small.noidAmount, 10);
  assert.ok(Math.abs(small.ethAmount - 0.002) < 1e-12);
  assert.ok(Math.abs(small.usdValue - 6.4) < 1e-12);
  assert.equal(small.withinSepoliaCaps, true);
  assert.equal(small.withinMainnetCaps, true);

  const mid = computeSwapEstimate({ amount: "0.25", side: "eth", ethUsd: 3200, noidUsd: 0.64 });
  assert.equal(mid.ok, true);
  assert.equal(mid.withinSepoliaCaps, false);
  assert.equal(mid.withinMainnetCaps, true);

  const over = computeSwapEstimate({ amount: "0.6", side: "eth", ethUsd: 3200, noidUsd: 0.64 });
  assert.equal(over.ok, true);
  assert.equal(over.withinMainnetCaps, false);

  assert.equal(computeSwapEstimate({ amount: "-1", side: "noid", ethUsd: 3200, noidUsd: 0.64 }).ok, false);
  assert.equal(formatUsd(3200), "$3,200.00");
  assert.equal(formatUsd(0.64), "$0.64");
  assert.equal(formatUsd(null), "—");
  assert.equal(formatUsdVolume(0), "$0");
  assert.equal(formatUsdVolume(4200), "$4,200");
  assert.equal(formatUsdVolume(12500), "$12,500");
  assert.equal(formatUsdVolume(-1), "—");
  assert.equal(formatUsdVolume(null), "—");
  assert.equal(formatQuoteNumber(5000), "5,000");
  assert.equal(formatAgeLabel(0), "just now");
  assert.equal(formatAgeLabel(10 * 60 * 1000), "10 min ago");
  assert.equal(formatAgeLabel(2 * 60 * 60 * 1000), "2 h ago");

  // Shared snapshot store
  const seen = [];
  const unsub = onSnapshotChange((s) => seen.push(s));
  const snap = parseMarketSnapshot(validSampleObj(), Date.parse("2026-11-26T13:35:00Z"));
  setCurrentSnapshot(snap);
  assert.equal(getCurrentSnapshot(), snap);
  assert.equal(seen.length, 1);
  unsub();
  setCurrentSnapshot(null);
  assert.equal(getCurrentSnapshot(), null);
  assert.equal(seen.length, 1);
});
