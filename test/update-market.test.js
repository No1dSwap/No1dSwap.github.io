import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { parseMarketSnapshot } from "../js/market-data.js";
import {
  ALLOWED_NOID_VENUES,
  DEFAULT_NOID_VENUE,
  ENDPOINTS,
  SINGLE_SOURCE_MIN_SHARE_PCT,
  FETCH_TIMEOUT_MS,
  MAX_RESPONSE_BYTES,
  RATE_LIMIT_MS,
  USER_AGENT,
  assertPublicHttpsUrl,
  assertRpcUrl,
  crossCheckEthUsd,
  crossCheckProducerShare,
  fetchJsonStrict,
  fetchNoidiumWindow,
  parseNoidiumBlocksPage,
  normalizeUtcIso,
  parseCoinGeckoEthUsd,
  parseKrakenEthUsd,
  parseNoidExplorerMiners,
  parseNoidiumOverview,
  runUpdate,
} from "../scripts/update-market.mjs";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = path.resolve(__dirname, "..", "scripts", "update-market.mjs");

const BASE_NOW_MS = Date.parse("2026-11-26T14:00:00Z");

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "noid-market-test-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function makeJsonResponse(data, { status = 200, headers = {} } = {}) {
  const text = typeof data === "string" ? data : JSON.stringify(data);
  const bytes = Buffer.from(text, "utf8");
  const headerMap = new Map(
    Object.entries({ "content-type": "application/json", ...headers }).map(([k, v]) => [
      k.toLowerCase(),
      String(v),
    ]),
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name) => headerMap.get(String(name).toLowerCase()) ?? null,
    },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(bytes));
        controller.close();
      },
    }),
  };
}

function makeMockFetch(routes, recorder = []) {
  return async (url, init) => {
    recorder.push({ url, init });
    const handler = routes[url] ?? routes[url.replace(/&before=[0-9]+$/, "")];
    if (!handler) {
      throw new Error(`Unexpected URL in offline test: ${url}`);
    }
    if (typeof handler === "function") {
      return handler(url, init);
    }
    return handler;
  };
}

const TOP_ADDR = `o1${"q".repeat(30)}`;
const OTHER_ADDR = `o1${"p".repeat(30)}`;
const THIRD_ADDR = `o1${"n".repeat(30)}`;
const WIN_TO = Date.parse("2026-11-26T13:58:00Z") / 1000;
const WIN_FROM = WIN_TO - 4 * 3600;

function explorerPayload({ top = 379, other = 88, topAddress = TOP_ADDR, blocks } = {}) {
  return {
    range: "4h",
    from: WIN_FROM,
    to: WIN_TO,
    blocks: blocks ?? top + other,
    addresses: 2,
    top: [
      { address: topAddress, blocks: top, last: WIN_TO - 30 },
      { address: OTHER_ADDR, blocks: other, last: WIN_TO - 60 },
    ],
  };
}

// Newest first: 3 blocks after the window, the window itself, then `older` blocks before it.
function noidiumChain({ top = 379, other = 88, topAddress = TOP_ADDR, older = 40, newer = 3 } = {}) {
  const miners = [];
  for (let i = 0; i < top; i += 1) miners.push(topAddress);
  for (let i = 0; i < other; i += 1) miners.push(OTHER_ADDR);
  // Deterministic interleave so the top miner is spread across the window.
  const inWindow = [];
  let ti = 0;
  let oi = 0;
  const n = top + other;
  for (let i = 0; i < n; i += 1) {
    const wantTop = ti / top <= oi / Math.max(other, 1) || oi >= other;
    if (wantTop && ti < top) {
      inWindow.push(topAddress);
      ti += 1;
    } else {
      inWindow.push(OTHER_ADDR);
      oi += 1;
    }
  }
  const out = [];
  let height = 343_981 + newer;
  for (let i = 0; i < newer; i += 1) {
    out.push({ height, hash: "00", ts: WIN_TO + 60 * (newer - i), miner: THIRD_ADDR, tx_count: 1, canonical: true, orphaned_at: null });
    height -= 1;
  }
  for (let i = 0; i < n; i += 1) {
    out.push({
      height,
      hash: "00",
      ts: WIN_TO - Math.floor((i * (WIN_TO - WIN_FROM)) / n),
      miner: inWindow[i],
      tx_count: 1,
      canonical: true,
      orphaned_at: null,
    });
    height -= 1;
  }
  for (let i = 0; i < older; i += 1) {
    out.push({ height, hash: "00", ts: WIN_FROM - 30 * (i + 1), miner: THIRD_ADDR, tx_count: 1, canonical: true, orphaned_at: null });
    height -= 1;
  }
  return out;
}

// Serves `all` (newest first) in pages like the real endpoint: limit up to pageSize, `before` = heights below it.
function noidiumBlocksHandler(all, { pageSize = 500, recorder = null } = {}) {
  return (url) => {
    if (recorder) recorder.push(url);
    const before = new URL(url).searchParams.get("before");
    const rows = before === null ? all : all.filter((b) => b.height < Number(before));
    return makeJsonResponse(rows.slice(0, pageSize));
  };
}

function defaultRoutes(overrides = {}) {
  return {
    [ENDPOINTS.noidium]: () =>
      makeJsonResponse({
        noid_usd: {
          price_usd: 0.64,
          ts: "2026-11-26T13:55:00Z",
          stale: false,
          volume_24h_usd: 15200,
          source: "SafeTrade",
          pair: "NOID/USDT",
        },
      }),
    [ENDPOINTS.coingecko]: () =>
      makeJsonResponse({
        ethereum: { usd: 3200.0 },
      }),
    [ENDPOINTS.kraken]: () =>
      makeJsonResponse({
        error: [],
        result: {
          XETHZUSD: {
            c: ["3220.00000", "0.50000"],
          },
        },
      }),
    [ENDPOINTS.noidexplorer]: () => makeJsonResponse(explorerPayload()),
    [ENDPOINTS.noidiumBlocks]: noidiumBlocksHandler(noidiumChain()),
    ...overrides,
  };
}

test("happy path atomic write validates via parseMarketSnapshot with zero leftover temp files", async () => {
  await withTempDir(async (dir) => {
    const outPath = path.join(dir, "market.json");
    const calls = [];
    const res = await runUpdate({
      outputPath: outPath,
      fetchImpl: makeMockFetch(defaultRoutes(), calls),
      nowMs: BASE_NOW_MS,
    });

    assert.equal(res.ok, true);
    assert.equal(res.skipped, false);
    assert.equal(calls.length, 5);

    // Every outbound request must use plain User-Agent and redirect: "error".
    for (const { init } of calls) {
      assert.equal(init.redirect, "error");
      assert.equal(init.headers["User-Agent"], USER_AGENT);
      assert.ok(init.signal instanceof AbortSignal);
    }

    // Only market.json exists in directory (no leftover temp/lock/state files).
    const entries = await fs.readdir(dir);
    assert.deepEqual(entries, ["market.json"]);

    const diskText = await fs.readFile(outPath, "utf8");
    const parsed = parseMarketSnapshot(diskText, BASE_NOW_MS);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.isSample, false);
    assert.equal(parsed.freshness, "fresh");
    assert.equal(parsed.ethUsd, 3210);
    assert.equal(parsed.sources.ethUsd, "CoinGecko + Kraken");
    assert.equal(parsed.noidUsd, 0.64);
    assert.equal(parsed.sources.noidUsd, "Noidium");
    assert.equal(parsed.noidUsdVenue, "SafeTrade NOID/USDT");
    assert.equal(parsed.noidVolume24hUsd, 15200);
    assert.equal(parsed.noidPriceTsUtc, "2026-11-26T13:55:00Z");
    assert.equal(parsed.noidPriceStale, false);
    // Explorer and Noidium agree (379 of 467 blocks, 81.16 %): the explorer's share is written.
    assert.equal(parsed.parano1d.topProducerSharePct, 81.16);
    assert.equal(parsed.parano1d.shareUnavailable, false);
    assert.equal(parsed.parano1d.windowBlocks, 467);
    assert.equal(parsed.parano1d.measuredAtUtc, "2026-11-26T13:58:00Z");
    assert.equal(parsed.ethGasGwei, null);
  });
});

test("10-minute rate limit skips all fetches when existing market.json is < 10 min old", async () => {
  await withTempDir(async (dir) => {
    const outPath = path.join(dir, "market.json");
    const existingText = `${JSON.stringify(
      {
        v: 1,
        generated_at: "2026-11-26T13:50:01Z", // 9m59s before BASE_NOW_MS
        sources: { eth_usd: "CoinGecko + Kraken", noid_usd: "Noidium" },
        eth_usd: 3100,
        noid_usd: 0.5,
        noid_usd_venue: "SafeTrade NOID/USDT",
        noid_volume_24h_usd: 11000,
        noid_price_ts: "2026-11-26T13:50:00Z",
        noid_price_stale: false,
        parano1d: {
          top_producer_share_pct: 74,
          window_blocks: 144,
          measured_at: "2026-11-26T13:50:00Z",
        },
        eth_gas_gwei: null,
      },
      null,
      2,
    )}\n`;
    await fs.writeFile(outPath, existingText, "utf8");

    let fetchCount = 0;
    const res = await runUpdate({
      outputPath: outPath,
      fetchImpl: async () => {
        fetchCount += 1;
        throw new Error("Should not fetch while rate-limited");
      },
      nowMs: BASE_NOW_MS,
    });

    assert.equal(RATE_LIMIT_MS, 600_000);
    assert.equal(res.ok, true);
    assert.equal(res.skipped, true);
    assert.equal(res.reason, "rate_limited");
    assert.equal(fetchCount, 0);
    assert.equal(await fs.readFile(outPath, "utf8"), existingText);

    // At exactly 10 min + 0 ms (>= 600_000 ms), update proceeds normally.
    const calls = [];
    const resAfter = await runUpdate({
      outputPath: outPath,
      fetchImpl: makeMockFetch(defaultRoutes(), calls),
      nowMs: Date.parse("2026-11-26T14:00:01Z"),
    });
    assert.equal(resAfter.ok, true);
    assert.equal(resAfter.skipped, false);
    assert.equal(calls.length, 5);

    // Future generated_at (> 5 min ahead) or malformed/rollover generated_at MUST NOT rate-limit.
    for (const badGen of [
      "2030-01-01T00:00:00Z",
      "2026-11-26T14:05:01Z",
      "2026-02-31T00:00:00Z",
      "2026-11-26T13:55:00+02:00",
      "not-a-timestamp",
    ]) {
      await fs.writeFile(outPath, JSON.stringify({ v: 1, generated_at: badGen }) + "\n", "utf8");
      const futureCalls = [];
      const resFuture = await runUpdate({
        outputPath: outPath,
        fetchImpl: makeMockFetch(defaultRoutes(), futureCalls),
        nowMs: BASE_NOW_MS,
      });
      assert.equal(resFuture.ok, true, `expected update to run for generated_at=${badGen}`);
      assert.equal(resFuture.skipped, false, `must not rate-limit for generated_at=${badGen}`);
      assert.equal(futureCalls.length, 5);
      assert.equal(resFuture.payload.generated_at, "2026-11-26T14:00:00Z");
    }

    // Small clock skew (<= 5 min ahead) still rate-limits normally.
    await fs.writeFile(
      outPath,
      JSON.stringify({ v: 1, generated_at: "2026-11-26T14:04:00Z" }) + "\n",
      "utf8",
    );
    const resSkew = await runUpdate({
      outputPath: outPath,
      fetchImpl: async () => {
        throw new Error("Should remain rate-limited within 5 min future skew");
      },
      nowMs: BASE_NOW_MS,
    });
    assert.equal(resSkew.ok, true);
    assert.equal(resSkew.skipped, true);
    assert.equal(resSkew.reason, "rate_limited");
  });
});

test("ETH/USD cross-check: agrees <=2% writes midpoint; >2% or one source failing writes null", async () => {
  // Pure unit checks for exact boundary
  const exact2Pct = crossCheckEthUsd(3000, 3060);
  assert.equal(exact2Pct.agreed, true);
  assert.equal(exact2Pct.ethUsd, 3030);
  assert.equal(exact2Pct.source, "CoinGecko + Kraken");

  const over2Pct = crossCheckEthUsd(3200, 3280); // 2.5%
  assert.equal(over2Pct.agreed, false);
  assert.equal(over2Pct.ethUsd, null);
  assert.equal(over2Pct.source, null);

  // Kraken strictly requires result.XETHZUSD (no fallback to arbitrary keys)
  assert.equal(parseKrakenEthUsd({ error: [], result: { XETHZUSD: { c: ["3199.75", "1"] } } }), 3199.75);
  assert.equal(parseKrakenEthUsd({ error: [], result: { ETHUSD: { c: ["3199.75", "1"] } } }), null);
  assert.equal(parseKrakenEthUsd({ error: ["EQuery:Invalid asset pair"], result: {} }), null);
  assert.equal(parseCoinGeckoEthUsd({ ethereum: { usd: 3200.5 } }), 3200.5);
  assert.equal(parseCoinGeckoEthUsd({ ethereum: { usd: 0 } }), null);

  // Integration: >2% divergence (2.5%) writes eth_usd: null & sources.eth_usd: null
  await withTempDir(async (dir) => {
    const outPath = path.join(dir, "market.json");
    const res = await runUpdate({
      outputPath: outPath,
      fetchImpl: makeMockFetch(
        defaultRoutes({
          [ENDPOINTS.coingecko]: () => makeJsonResponse({ ethereum: { usd: 3200 } }),
          [ENDPOINTS.kraken]: () =>
            makeJsonResponse({ error: [], result: { XETHZUSD: { c: ["3280.00", "1"] } } }),
        }),
      ),
      nowMs: BASE_NOW_MS,
    });

    assert.equal(res.ok, true);
    assert.equal(res.payload.eth_usd, null);
    assert.equal(res.payload.sources.eth_usd, null);
    assert.equal(res.snapshot.hasEthPrice, false);
    assert.equal(res.snapshot.hasNoidPrice, true);
    assert.equal(res.snapshot.impliedNoidPerEth, null);

    const diskParsed = parseMarketSnapshot(await fs.readFile(outPath, "utf8"), BASE_NOW_MS);
    assert.equal(diskParsed.ok, true);
    assert.equal(diskParsed.ethUsd, null);
  });

  // Integration: one source fails -> eth_usd: null
  await withTempDir(async (dir) => {
    const outPath = path.join(dir, "market.json");
    const res = await runUpdate({
      outputPath: outPath,
      fetchImpl: makeMockFetch(
        defaultRoutes({
          [ENDPOINTS.coingecko]: () => makeJsonResponse("upstream error", { status: 503 }),
        }),
      ),
      nowMs: BASE_NOW_MS,
    });

    assert.equal(res.ok, true);
    assert.equal(res.payload.eth_usd, null);
    assert.equal(res.payload.sources.eth_usd, null);
  });
});

async function runShare(routeOverrides) {
  return withTempDir(async (dir) => {
    const outPath = path.join(dir, "market.json");
    const res = await runUpdate({
      outputPath: outPath,
      fetchImpl: makeMockFetch(defaultRoutes(routeOverrides)),
      nowMs: BASE_NOW_MS,
    });
    assert.equal(res.ok, true);
    return res;
  });
}

test("Producer share: explorer + Noidium agree -> explorer share, window and time written", async () => {
  assert.equal(ENDPOINTS.noidexplorer, "https://noidexplorer.org/api/premium/miners?range=4h");
  assert.equal(ENDPOINTS.noidiumBlocks, "https://noidium.com/api/v1/blocks?limit=500");
  const res = await runShare({});
  assert.equal(res.payload.parano1d.top_producer_share_pct, 81.16);
  assert.equal(res.payload.parano1d.window_blocks, 467);
  assert.equal(res.payload.parano1d.measured_at, "2026-11-26T13:58:00Z");
  assert.equal(res.snapshot.parano1d.shareUnavailable, false);

  // A 2.9 point difference (Noidium 78.3 %) still agrees; the explorer's own value is written.
  const near = await runShare({
    [ENDPOINTS.noidiumBlocks]: noidiumBlocksHandler(noidiumChain({ top: 365, other: 102 })),
  });
  assert.equal(near.payload.parano1d.top_producer_share_pct, 81.16);
});

test("Producer share: more than 3 points apart writes null (window and time kept)", async () => {
  // Explorer 81.16 %, Noidium 350/467 = 74.95 %.
  const res = await runShare({
    [ENDPOINTS.noidiumBlocks]: noidiumBlocksHandler(noidiumChain({ top: 350, other: 117 })),
  });
  assert.equal(res.payload.parano1d.top_producer_share_pct, null);
  assert.equal(res.payload.parano1d.window_blocks, 467);
  assert.equal(res.snapshot.parano1d.shareUnavailable, true);
});

test("Producer share: a different top address writes null", async () => {
  const res = await runShare({
    [ENDPOINTS.noidiumBlocks]: noidiumBlocksHandler(noidiumChain({ topAddress: THIRD_ADDR })),
  });
  assert.equal(res.payload.parano1d.top_producer_share_pct, null);
});

test("Producer share: fewer than 300 blocks in either window writes null", async () => {
  // Explorer window too small (shares agree).
  const smallExplorer = await runShare({
    [ENDPOINTS.noidexplorer]: () => makeJsonResponse(explorerPayload({ top: 200, other: 60 })),
    [ENDPOINTS.noidiumBlocks]: noidiumBlocksHandler(noidiumChain({ top: 200, other: 60 })),
  });
  assert.equal(smallExplorer.payload.parano1d.top_producer_share_pct, null);

  // Noidium window too small although the shares agree (explorer says 467 blocks, Noidium sees 280).
  const smallNoidium = await runShare({
    [ENDPOINTS.noidiumBlocks]: noidiumBlocksHandler(noidiumChain({ top: 227, other: 53 })),
  });
  assert.equal(smallNoidium.payload.parano1d.top_producer_share_pct, null);
});

test("Producer share: a Noidium failure writes null and still writes the prices", async () => {
  for (const handler of [
    () => makeJsonResponse("down", { status: 503 }),
    () => makeJsonResponse({ not: "an array" }),
    () => makeJsonResponse([]),
    () => {
      throw new Error("connection refused");
    },
  ]) {
    const res = await runShare({ [ENDPOINTS.noidiumBlocks]: handler });
    assert.equal(res.payload.parano1d.top_producer_share_pct, null);
    assert.equal(res.payload.eth_usd, 3210);
    assert.equal(res.payload.noid_usd, 0.64);
  }

  // Explorer and Noidium both down: share, window, time and source are all null.
  const neither = await runShare({
    [ENDPOINTS.noidexplorer]: () => makeJsonResponse("down", { status: 500 }),
    [ENDPOINTS.noidiumBlocks]: () => makeJsonResponse("down", { status: 503 }),
  });
  assert.equal(neither.payload.parano1d.top_producer_share_pct, null);
  assert.equal(neither.payload.parano1d.window_blocks, null);
  assert.equal(neither.payload.parano1d.measured_at, null);
  assert.equal(neither.payload.parano1d.share_source, null);
});

test("Producer share: explorer unreachable -> Noidium alone, labelled, only at or above the 75 % floor", async () => {
  const explorerDown = { [ENDPOINTS.noidexplorer]: () => makeJsonResponse("forbidden", { status: 403 }) };

  const solo = await runShare(explorerDown);
  const pct = solo.payload.parano1d.top_producer_share_pct;
  assert.equal(typeof pct, "number");
  assert.ok(pct >= SINGLE_SOURCE_MIN_SHARE_PCT);
  assert.ok(solo.payload.parano1d.window_blocks >= 300);
  assert.equal(typeof solo.payload.parano1d.measured_at, "string");
  assert.equal(solo.payload.parano1d.share_source, "noidium");
  assert.equal(solo.snapshot.parano1d.shareSingleSource, true);

  // Below the floor (an understated share is the harmful error): withheld.
  const low = await runShare({
    ...explorerDown,
    [ENDPOINTS.noidiumBlocks]: noidiumBlocksHandler(noidiumChain({ top: 230, other: 237 })),
  });
  assert.equal(low.payload.parano1d.top_producer_share_pct, null);
  assert.equal(low.payload.parano1d.share_source, null);

  // Explorer answers and disagrees: no fallback to Noidium alone.
  const disagree = await runShare({
    [ENDPOINTS.noidiumBlocks]: noidiumBlocksHandler(noidiumChain({ top: 330, other: 137 })),
  });
  assert.equal(disagree.payload.parano1d.top_producer_share_pct, null);
  assert.equal(disagree.payload.parano1d.share_source, null);

  // Two sources agreeing are labelled as such.
  const both = await runShare({});
  assert.equal(both.payload.parano1d.share_source, "noidexplorer+noidium");
  assert.equal(both.snapshot.parano1d.shareSingleSource, false);
});

test("Producer share: invalid Noidium entries are skipped up to 5 %, above that the source fails", async () => {
  const chain = noidiumChain();
  const withBad = (count) => {
    const copy = chain.map((b) => ({ ...b }));
    // Corrupt entries that lie outside the window so counts stay unchanged.
    const olderStart = copy.length - 40;
    for (let i = 0; i < count; i += 1) {
      const bad = copy[olderStart + (i % 40)];
      if (i % 4 === 0) bad.miner = "not-an-address";
      else if (i % 4 === 1) bad.height = -5;
      else if (i % 4 === 2) bad.canonical = "yes";
      else bad.ts = 1.5;
    }
    return copy;
  };
  // 4 invalid of 510 is under 5 %: skipped, share still agrees.
  const okRes = await runShare({ [ENDPOINTS.noidiumBlocks]: noidiumBlocksHandler(withBad(4)) });
  assert.equal(okRes.payload.parano1d.top_producer_share_pct, 81.16);

  // 30 invalid of 510 is above 5 %: the source fails.
  const failRes = await runShare({ [ENDPOINTS.noidiumBlocks]: noidiumBlocksHandler(withBad(30)) });
  assert.equal(failRes.payload.parano1d.top_producer_share_pct, null);

  const page = parseNoidiumBlocksPage([
    { height: 5, ts: 10, miner: TOP_ADDR, canonical: true },
    { height: 0, ts: 10, miner: TOP_ADDR, canonical: true },
    { height: 4, ts: 10, miner: "o1UPPER", canonical: true },
    { height: 3, ts: 10, miner: TOP_ADDR, canonical: 1 },
    null,
  ]);
  assert.equal(page.blocks.length, 1);
  assert.equal(page.invalid, 4);
  assert.equal(parseNoidiumBlocksPage({}), null);
});

test("Producer share: non-canonical, out-of-window and duplicate Noidium blocks are not counted", async () => {
  const chain = noidiumChain();
  const extra = chain.filter((b) => b.ts >= WIN_FROM && b.ts <= WIN_TO).slice(0, 5);
  const noisy = [
    ...chain,
    // Duplicates by height (same block served twice) must not count twice.
    ...extra.map((b) => ({ ...b })),
  ].sort((x, y) => y.height - x.height);
  // Orphaned block for the other miner inside the window (not canonical) must not count.
  noisy.push({ height: 1, hash: "00", ts: WIN_TO - 100, miner: OTHER_ADDR, canonical: false, orphaned_at: 9 });
  const win = await fetchNoidiumWindow(
    "https://noidium.com/api/v1/blocks?limit=500",
    { from: WIN_FROM, to: WIN_TO },
    { fetchImpl: makeMockFetch({ "https://noidium.com/api/v1/blocks?limit=500": () => makeJsonResponse(noisy) }) },
  );
  assert.equal(win.windowBlocks, 467);
  assert.equal(win.topBlocks, 379);
  assert.equal(win.topAddress, TOP_ADDR);
});

test("Producer share: Noidium pagination uses &before=<lowest height> and stops once the window is covered", async () => {
  // Pages of 200 force pagination: 510 blocks need 3 pages to cover 467 window blocks + 40 older.
  const all = noidiumChain();
  const urls = [];
  const res = await runShare({
    [ENDPOINTS.noidiumBlocks]: noidiumBlocksHandler(all, { pageSize: 200, recorder: urls }),
  });
  assert.equal(res.payload.parano1d.top_producer_share_pct, 81.16);
  assert.equal(urls.length, 3);
  assert.equal(urls[0], ENDPOINTS.noidiumBlocks);
  const lowest0 = all.slice(0, 200).reduce((m, b) => Math.min(m, b.height), Infinity);
  assert.equal(urls[1], `${ENDPOINTS.noidiumBlocks}&before=${lowest0}`);

  // Single page that already reaches before the window start: exactly one request.
  const one = [];
  await runShare({ [ENDPOINTS.noidiumBlocks]: noidiumBlocksHandler(all, { recorder: one }) });
  assert.equal(one.length, 1);

  // More than 3 pages would be needed: at most 3 requests and the source fails (window not covered).
  const many = [];
  const limited = await runShare({
    [ENDPOINTS.noidiumBlocks]: noidiumBlocksHandler(all, { pageSize: 100, recorder: many }),
  });
  assert.equal(many.length, 3);
  assert.equal(limited.payload.parano1d.top_producer_share_pct, null);

  // A stalled cursor (the server keeps returning the same page) fails instead of looping.
  const stuck = [];
  const stalled = await runShare({
    [ENDPOINTS.noidiumBlocks]: (url) => {
      stuck.push(url);
      return makeJsonResponse(all.slice(0, 100));
    },
  });
  assert.ok(stuck.length <= 2);
  assert.equal(stalled.payload.parano1d.top_producer_share_pct, null);
});

test("Producer share: explorer parser and pure cross-check rules", async () => {
  const good = parseNoidExplorerMiners(explorerPayload(), BASE_NOW_MS);
  assert.equal(good.topProducerSharePct, 81.16);
  assert.equal(good.windowBlocks, 467);
  assert.equal(good.measuredAt, "2026-11-26T13:58:00Z");
  assert.equal(good.topAddress, TOP_ADDR);
  assert.equal(good.from, WIN_FROM);

  // Malformed, inconsistent, expired (> 6 h) or future (> 5 min) payloads -> null.
  assert.equal(parseNoidExplorerMiners({ ...explorerPayload(), top: [] }, BASE_NOW_MS), null);
  assert.equal(parseNoidExplorerMiners({ ...explorerPayload(), blocks: 100 }, BASE_NOW_MS), null);
  assert.equal(parseNoidExplorerMiners({ ...explorerPayload(), from: undefined }, BASE_NOW_MS), null);
  assert.equal(parseNoidExplorerMiners({ ...explorerPayload(), to: WIN_FROM - 1 }, BASE_NOW_MS), null);
  assert.equal(
    parseNoidExplorerMiners(
      { ...explorerPayload(), top: [{ address: "o1top", blocks: 9, last: 1 }], blocks: 20 },
      BASE_NOW_MS,
    ),
    null,
  );
  assert.equal(parseNoidExplorerMiners(explorerPayload(), BASE_NOW_MS + 7 * 3600 * 1000), null);
  assert.equal(parseNoidExplorerMiners(explorerPayload(), BASE_NOW_MS - 20 * 60 * 1000), null);

  const ex = { topProducerSharePct: 80, windowBlocks: 400, measuredAt: "2026-11-26T13:58:00Z", topAddress: TOP_ADDR };
  const nd = (over) => ({ topProducerSharePct: 78, windowBlocks: 400, topAddress: TOP_ADDR, ...over });
  assert.equal(crossCheckProducerShare(ex, nd({ topProducerSharePct: 77 })).agreed, true); // exactly 3 points
  assert.equal(crossCheckProducerShare(ex, nd({ topProducerSharePct: 76.9 })).agreed, false);
  assert.equal(crossCheckProducerShare(ex, nd({ windowBlocks: 299 })).agreed, false);
  assert.equal(crossCheckProducerShare(ex, nd({ windowBlocks: 300 })).agreed, true);
  assert.equal(crossCheckProducerShare(ex, null).topProducerSharePct, null);
  assert.equal(crossCheckProducerShare(null, nd()).windowBlocks, null);
});

test("NOID/USD: handles stale, low volume, unix-s/ms vs ISO ts, default venue, and broken payloads", async () => {
  // Unix seconds + stale: true + low volume + omitted venue -> default venue
  const unixSec = Math.floor(Date.parse("2026-11-26T13:52:00Z") / 1000);
  await withTempDir(async (dir) => {
    const outPath = path.join(dir, "market.json");
    const res = await runUpdate({
      outputPath: outPath,
      fetchImpl: makeMockFetch(
        defaultRoutes({
          [ENDPOINTS.noidium]: () =>
            makeJsonResponse({
              noid_usd: {
                price_usd: 0.58,
                ts: unixSec,
                stale: true,
                volume_24h_usd: 3400,
              },
            }),
        }),
      ),
      nowMs: BASE_NOW_MS,
    });

    assert.equal(res.ok, true);
    assert.equal(res.payload.noid_usd, 0.58);
    assert.equal(res.payload.noid_usd_venue, DEFAULT_NOID_VENUE);
    assert.equal(res.payload.noid_volume_24h_usd, 3400);
    assert.equal(res.payload.noid_price_ts, "2026-11-26T13:52:00Z");
    assert.equal(res.payload.noid_price_stale, true);
    assert.equal(res.snapshot.noidLowVolume, true);
    assert.equal(res.snapshot.noidPriceStale, true);
    assert.equal(res.snapshot.noidPriceMuted, true);
  });

  // Unix milliseconds, ISO with offset, rollover rejection, and strict venue allowlist
  const unixMs = Date.parse("2026-11-26T13:45:30Z");
  const parsedAllowed = parseNoidiumOverview({
    noid_usd: { price_usd: 0.61, ts: unixMs, stale: false, volume_24h_usd: 0, source: "SafeTrade" },
  });
  assert.equal(parsedAllowed.ts, "2026-11-26T13:45:30Z");
  assert.equal(parsedAllowed.volume24hUsd, 0);
  assert.equal(parsedAllowed.venue, ALLOWED_NOID_VENUES.safetrade);

  const parsedUntrustedVenue = parseNoidiumOverview({
    noid_usd: { price_usd: 0.61, ts: unixMs, stale: false, volume_24h_usd: 0, source: "Arbitrary Untrusted Venue" },
  });
  assert.equal(parsedUntrustedVenue.venue, DEFAULT_NOID_VENUE);

  assert.equal(normalizeUtcIso("2026-11-26T15:00:00+02:00"), "2026-11-26T13:00:00Z");
  assert.equal(normalizeUtcIso("2026-02-31T00:00:00Z"), null);
  assert.equal(normalizeUtcIso("2026-11-26T24:00:00Z"), null);

  // Broken Noidium payloads -> noid_usd: null and sibling fields cleared
  assert.equal(parseNoidiumOverview({}), null);
  assert.equal(parseNoidiumOverview({ noid_usd: { price_usd: -1, ts: unixSec, volume_24h_usd: 100 } }), null);
  assert.equal(parseNoidiumOverview({ noid_usd: { price_usd: 0.5, ts: "bad-date", volume_24h_usd: 100 } }), null);
  assert.equal(parseNoidiumOverview({ noid_usd: { price_usd: 0.5, ts: unixSec, volume_24h_usd: -5 } }), null);

  await withTempDir(async (dir) => {
    const outPath = path.join(dir, "market.json");
    const res = await runUpdate({
      outputPath: outPath,
      fetchImpl: makeMockFetch(
        defaultRoutes({
          [ENDPOINTS.noidium]: () => makeJsonResponse({ noid_usd: { price_usd: "broken" } }),
        }),
      ),
      nowMs: BASE_NOW_MS,
    });

    assert.equal(res.ok, true);
    assert.equal(res.payload.noid_usd, null);
    assert.equal(res.payload.sources.noid_usd, null);
    assert.equal(res.payload.noid_usd_venue, null);
    assert.equal(res.payload.noid_volume_24h_usd, null);
    assert.equal(res.payload.noid_price_ts, null);
    assert.equal(res.payload.noid_price_stale, false);
    assert.equal(res.snapshot.hasNoidPrice, false);
    assert.equal(res.snapshot.hasEthPrice, true);
  });
});

test("Strict HTTP fetch wrapper: 10 s timeout, >1 MB cap, redirect error, HTTPS-only, plain User-Agent", async (t) => {
  assert.equal(FETCH_TIMEOUT_MS, 10_000);
  assert.equal(MAX_RESPONSE_BYTES, 1_048_576);
  assert.equal(USER_AGENT, "no1d-swap-board/0.2.0");

  // 1. Non-HTTPS rejection for public endpoints & insecure remote RPC rejection
  assert.throws(() => assertPublicHttpsUrl("http://noidium.com/api/v1/overview"), /non-HTTPS/i);
  assert.throws(() => assertPublicHttpsUrl("file:///etc/passwd"), /non-HTTPS/i);
  assert.throws(() => assertPublicHttpsUrl("https://user:pass@noidium.com/api"), /credentials/i);
  assert.throws(() => assertRpcUrl("http://remote.example.com:8545"), /insecure RPC/i);
  assert.doesNotThrow(() => assertRpcUrl("http://127.0.0.1:8545"));
  assert.doesNotThrow(() => assertRpcUrl("https://rpc.example.com"));

  await assert.rejects(
    fetchJsonStrict("http://noidium.com/api/v1/overview", {
      fetchImpl: async () => {
        throw new Error("Should never call fetchImpl for HTTP public URL");
      },
    }),
    /non-HTTPS/i,
  );

  // 2. Plain User-Agent & redirect: "error" verification
  let seenInit = null;
  await fetchJsonStrict(ENDPOINTS.coingecko, {
    fetchImpl: async (_url, init) => {
      seenInit = init;
      return makeJsonResponse({ ethereum: { usd: 3200 } });
    },
  });
  assert.equal(seenInit.redirect, "error");
  assert.equal(seenInit.headers["User-Agent"], USER_AGENT);

  // 3. Redirect rejection (both TypeError from redirect:"error" and 302 status)
  await assert.rejects(
    fetchJsonStrict(ENDPOINTS.coingecko, {
      fetchImpl: async () => makeJsonResponse("", { status: 302, headers: { location: "https://evil.test" } }),
    }),
    /redirect/i,
  );
  await assert.rejects(
    fetchJsonStrict(ENDPOINTS.coingecko, {
      fetchImpl: async (_url, init) => {
        assert.equal(init.redirect, "error");
        throw new TypeError("fetch failed: unexpected redirect");
      },
    }),
    /redirect/i,
  );

  // 4. >1 MB response cap rejection (streamed chunks without Content-Length AND declared Content-Length)
  await assert.rejects(
    fetchJsonStrict(ENDPOINTS.coingecko, {
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: { get: () => null },
        body: new ReadableStream({
          start(controller) {
            const chunk = new Uint8Array(600_000).fill(0x20); // 1.2 MB total across 2 chunks
            controller.enqueue(chunk);
            controller.enqueue(chunk);
            controller.close();
          },
        }),
      }),
    }),
    /cap/i,
  );

  await assert.rejects(
    fetchJsonStrict(ENDPOINTS.coingecko, {
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: {
          get: (k) => (k.toLowerCase() === "content-length" ? String(MAX_RESPONSE_BYTES + 1) : null),
        },
        body: null,
      }),
    }),
    /cap/i,
  );

  // 5. Exact 10 s default timeout aborts a hung request via fake timers
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let aborted = false;
  const hungPromise = fetchJsonStrict(ENDPOINTS.coingecko, {
    fetchImpl: (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          aborted = true;
          reject(init.signal.reason || new Error("Aborted"));
        });
      }),
  });
  t.mock.timers.tick(FETCH_TIMEOUT_MS - 1);
  assert.equal(aborted, false);
  t.mock.timers.tick(1);
  assert.equal(aborted, true);
  await assert.rejects(hungPromise, /timed out/i);
});

test("Optional ETH RPC gas gwei is null by default and populated only when explicitly configured", async () => {
  await withTempDir(async (dir) => {
    const outPath = path.join(dir, "market.json");
    const routes = defaultRoutes({
      "http://127.0.0.1:8545": async (_url, init) => {
        const body = JSON.parse(init.body);
        assert.equal(body.method, "eth_gasPrice");
        // 0.8 gwei = 800,000,000 wei = 0x2faf0800
        return makeJsonResponse({ jsonrpc: "2.0", id: 1, result: "0x2faf0800" });
      },
    });
    const res = await runUpdate({
      outputPath: outPath,
      fetchImpl: makeMockFetch(routes),
      nowMs: BASE_NOW_MS,
      ethRpcUrl: "http://127.0.0.1:8545",
    });

    assert.equal(res.ok, true);
    assert.equal(res.payload.eth_gas_gwei, 0.8);
    assert.equal(res.snapshot.ethGasGwei, 0.8);
  });
});

test("Total failure keeps previous market.json byte-for-byte untouched with zero leftover temp files", async () => {
  await withTempDir(async (dir) => {
    const outPath = path.join(dir, "market.json");
    const sentinel = `${JSON.stringify(
      {
        v: 1,
        generated_at: "2026-11-26T12:00:00Z", // 2 hours old (past 10-min rate limit)
        sources: { eth_usd: "CoinGecko + Kraken", noid_usd: "Noidium" },
        eth_usd: 3150.25,
        noid_usd: 0.62,
        noid_usd_venue: "SafeTrade NOID/USDT",
        noid_volume_24h_usd: 14000,
        noid_price_ts: "2026-11-26T11:58:00Z",
        noid_price_stale: false,
        parano1d: {
          top_producer_share_pct: 74.5,
          window_blocks: 144,
          measured_at: "2026-11-26T11:59:00Z",
        },
        eth_gas_gwei: null,
      },
      null,
      2,
    )}\n`;
    await fs.writeFile(outPath, sentinel, "utf8");

    const res = await runUpdate({
      outputPath: outPath,
      fetchImpl: async () => {
        throw new Error("Simulated offline total network failure");
      },
      nowMs: BASE_NOW_MS,
    });

    assert.equal(res.ok, false);
    assert.equal(res.reason, "all_sources_failed");

    // Previous market.json is byte-for-byte untouched and no temp files exist.
    const afterBytes = await fs.readFile(outPath);
    assert.deepEqual(afterBytes, Buffer.from(sentinel, "utf8"));
    const entries = await fs.readdir(dir);
    assert.deepEqual(entries, ["market.json"]);
  });
});

test("CLI entry supports --help and exits 0 cleanly on rate-limited file without hitting network", async () => {
  const { stdout: helpOut } = await execFileAsync(process.execPath, [SCRIPT_PATH, "--help"]);
  assert.match(helpOut, /--out/);
  assert.doesNotMatch(helpOut, /--parano1d-rpc/);
  assert.match(helpOut, /--soft-fail/);
  assert.match(helpOut, /--eth-rpc/);

  await withTempDir(async (dir) => {
    const outPath = path.join(dir, "market.json");
    const freshIso = new Date(Date.now() - 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
    const freshPayload = `${JSON.stringify({ v: 1, generated_at: freshIso })}\n`;
    await fs.writeFile(outPath, freshPayload, "utf8");

    const { stdout } = await execFileAsync(process.execPath, [SCRIPT_PATH, "--out", outPath]);
    const parsedOut = JSON.parse(stdout.trim());
    assert.deepEqual(parsedOut, { skipped: true, reason: "rate_limited" });
    assert.equal(await fs.readFile(outPath, "utf8"), freshPayload);
  });
});
