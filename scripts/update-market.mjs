#!/usr/bin/env node
/**
 * Host market-snapshot updater for No1d Swap bulletin board.
 *
 * Pure Node.js ESM with zero external dependencies. Fetches public reference
 * quotes and producer-share data under strict transport bounds (HTTPS-only for
 * public endpoints, 10 s timeout, 1 MB streamed cap, redirect refusal, plain
 * User-Agent), cross-checks ETH/USD across CoinGecko and Kraken (<= 2% spread),
 * cross-checks the Parano1d top-producer share between two public indexers
 * (NoidExplorer and Noidium, <= 3 percentage points over the same window),
 * validates the candidate snapshot through
 * `parseMarketSnapshot()`, and atomically replaces ONLY `market.json`.
 *
 * Rate-limited to at most once every 10 minutes based on existing
 * `market.json`'s `generated_at`. On fatal failure, exits non-zero and leaves
 * any existing `market.json` untouched.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { sanitizeDisplayText } from "../js/invite-codec.js";
import {
  EXPIRE_AFTER_MS,
  MAX_FUTURE_SKEW_MS,
  MAX_MARKET_BYTES,
  parseMarketSnapshot,
  parseUtcIsoStrict,
} from "../js/market-data.js";

export const USER_AGENT = "no1d-swap-board/0.2.0";
export const FETCH_TIMEOUT_MS = 10_000;
export const MAX_RESPONSE_BYTES = MAX_MARKET_BYTES; // 1_048_576 (1 MB)
export const RATE_LIMIT_MS = 10 * 60 * 1000; // 600_000 ms (10 minutes)
export const ETH_CROSS_CHECK_MAX_DIFF = 0.02; // 2%
export const PRODUCER_SHARE_MAX_DIFF_PTS = 3; // 3 percentage points
export const DEFAULT_NOID_VENUE = "SafeTrade NOID/USDT";
export const ALLOWED_NOID_VENUES = Object.freeze({
  safetrade: "SafeTrade",
  "safetrade noid/usdt": "SafeTrade NOID/USDT",
  "safetrade noid/usd": "SafeTrade NOID/USD",
});
export const DEFAULT_WINDOW_BLOCKS = 144;

export const ENDPOINTS = Object.freeze({
  noidium: "https://noidium.com/api/v1/overview",
  coingecko: "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd",
  kraken: "https://api.kraken.com/0/public/Ticker?pair=XETHZUSD",
  noidexplorer: "https://noidexplorer.org/api/premium/miners?range=4h",
  noidiumBlocks: "https://noidium.com/api/v1/blocks?limit=500",
});

export const MIN_WINDOW_BLOCKS_FOR_SHARE = 300;
export const NOIDIUM_MAX_PAGES = 3;
export const NOIDIUM_MAX_INVALID_RATIO = 0.05;
const MINER_ADDRESS_RE = /^o1[02-9ac-hj-np-z]{20,100}$/;

const MAX_USD_PRICE = 1e9;
const MAX_VOLUME_USD = 1e15;
const MAX_GAS_GWEI = 1e6;
const MIN_VALID_EPOCH_MS = Date.UTC(2020, 0, 1);
const TEXT_DECODER_FATAL = new TextDecoder("utf-8", { fatal: true });
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

const isPlainObject = (v) =>
  v !== null &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  Object.getPrototypeOf(v) === Object.prototype;

function toUtcIso(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function roundTo(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * Normalizes an ISO-8601 string or Unix seconds/milliseconds timestamp into a
 * strict UTC ISO-8601 string (`YYYY-MM-DDTHH:MM:SSZ`). Returns `null` on any
 * invalid or out-of-range value.
 * @param {unknown} value
 * @returns {string|null}
 */
export function normalizeUtcIso(value) {
  let ms = NaN;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return null;
    ms = value < 1e11 ? Math.round(value * 1000) : Math.round(value);
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
      const n = Number(trimmed);
      if (!Number.isFinite(n) || n <= 0) return null;
      ms = n < 1e11 ? Math.round(n * 1000) : Math.round(n);
    } else {
      // Require explicit timezone (Z or +/-HH:MM) and reject calendar/clock rollovers.
      const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(
        trimmed,
      );
      if (!m) return null;
      const year = Number(m[1]);
      const month = Number(m[2]);
      const day = Number(m[3]);
      const hour = Number(m[4]);
      const minute = Number(m[5]);
      const second = Number(m[6]);
      const fracMs = m[7] ? Number(m[7].slice(0, 3).padEnd(3, "0")) : 0;
      if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
        return null;
      }
      const localAsUtc = Date.UTC(year, month - 1, day, hour, minute, second, fracMs);
      const check = new Date(localAsUtc);
      if (
        check.getUTCFullYear() !== year ||
        check.getUTCMonth() !== month - 1 ||
        check.getUTCDate() !== day ||
        check.getUTCHours() !== hour ||
        check.getUTCMinutes() !== minute ||
        check.getUTCSeconds() !== second
      ) {
        return null;
      }
      let offsetMs = 0;
      if (m[8] !== "Z") {
        const offHours = Number(m[10]);
        const offMins = Number(m[11]);
        if (offHours > 23 || offMins > 59) return null;
        const sign = m[9] === "+" ? 1 : -1;
        offsetMs = sign * (offHours * 60 + offMins) * 60 * 1000;
      }
      ms = localAsUtc - offsetMs;
    }
  } else {
    return null;
  }

  if (!Number.isFinite(ms) || ms < MIN_VALID_EPOCH_MS) return null;
  return toUtcIso(ms);
}

/**
 * Validates that a public endpoint URL uses `https:` and contains no embedded
 * credentials.
 * @param {unknown} rawUrl
 * @returns {URL}
 */
export function assertPublicHttpsUrl(rawUrl) {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) {
    throw new Error("Endpoint URL must be a non-empty string.");
  }
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Endpoint URL is malformed.");
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`Refused non-HTTPS public endpoint protocol: ${parsed.protocol}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error("Public endpoint URL must not contain embedded credentials.");
  }
  return parsed;
}

/**
 * Validates an operator-configured RPC URL: allows `https:` anywhere, or
 * `http:` strictly on loopback (`localhost`, `127.0.0.1`, `[::1]`).
 * @param {unknown} rawUrl
 * @returns {URL}
 */
export function assertRpcUrl(rawUrl) {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) {
    throw new Error("RPC URL must be a non-empty string.");
  }
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("RPC URL is malformed.");
  }
  if (parsed.protocol === "https:") {
    return parsed;
  }
  if (parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) {
    return parsed;
  }
  throw new Error(`Refused insecure RPC URL protocol/host: ${parsed.protocol}//${parsed.hostname}`);
}

async function readBodyBytesBounded(response, maxBytes, signal) {
  const declared =
    response.headers && typeof response.headers.get === "function"
      ? Number(response.headers.get("content-length"))
      : NaN;
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`Response content-length exceeds ${maxBytes}-byte cap.`);
  }

  if (response.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    const onAbort = () => {
      reader.cancel().catch(() => {});
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
        throw new Error("Request timed out while reading response body.");
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    try {
      for (;;) {
        if (signal && signal.aborted) {
          throw new Error("Request timed out while reading response body.");
        }
        const { done, value } = await reader.read();
        if (done) break;
        const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
        total += bytes.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new Error(`Response body exceeds ${maxBytes}-byte cap.`);
        }
        chunks.push(bytes);
      }
    } catch (err) {
      await reader.cancel().catch(() => {});
      throw err;
    } finally {
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return merged;
  }

  if (typeof response.arrayBuffer === "function") {
    const buf = new Uint8Array(await response.arrayBuffer());
    if (buf.byteLength > maxBytes) {
      throw new Error(`Response body exceeds ${maxBytes}-byte cap.`);
    }
    return buf;
  }

  if (typeof response.text === "function") {
    const text = await response.text();
    const buf = Buffer.from(text, "utf8");
    if (buf.byteLength > maxBytes) {
      throw new Error(`Response body exceeds ${maxBytes}-byte cap.`);
    }
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  throw new Error("Response object does not provide a readable body.");
}

/**
 * Strict JSON HTTP fetch wrapper:
 * - Enforces HTTPS for public endpoints (or HTTPS / loopback HTTP for RPC)
 * - 10 s AbortController timeout
 * - 1 MB streamed/counted response cap before JSON parsing
 * - `redirect: "error"` plus explicit 3xx rejection
 * - Plain `User-Agent` header (`no1d-swap-board/0.2.0`)
 */
export async function fetchJsonStrict(
  url,
  {
    fetchImpl = globalThis.fetch,
    timeoutMs = FETCH_TIMEOUT_MS,
    maxBytes = MAX_RESPONSE_BYTES,
    allowHttpLocal = false,
    method = "GET",
    headers = {},
    body = undefined,
  } = {},
) {
  if (allowHttpLocal) {
    assertRpcUrl(url);
  } else {
    assertPublicHttpsUrl(url);
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("Fetch API is unavailable.");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`Request timed out after ${timeoutMs} ms.`));
  }, timeoutMs);
  if (typeof timer.unref === "function") {
    timer.unref();
  }

  try {
    const requestInit = {
      method,
      redirect: "error",
      signal: controller.signal,
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json",
        ...headers,
      },
    };
    if (body !== undefined) {
      requestInit.body = body;
    }

    const response = await fetchImpl(url, requestInit);
    if (!response) {
      throw new Error("Empty response from fetch.");
    }
    if (typeof response.status === "number" && response.status >= 300 && response.status < 400) {
      throw new Error(`Refused HTTP redirect (${response.status}).`);
    }
    if (!response.ok) {
      throw new Error(`HTTP request failed with status ${response.status}.`);
    }

    const bytes = await readBodyBytesBounded(response, maxBytes, controller.signal);
    if (controller.signal.aborted) {
      throw new Error(`Request timed out after ${timeoutMs} ms.`);
    }

    let text;
    try {
      text = TEXT_DECODER_FATAL.decode(bytes);
    } catch {
      throw new Error("Response body is not valid UTF-8.");
    }
    if (text.length > 0 && text.charCodeAt(0) === 0xfeff) {
      throw new Error("Response body must not contain a UTF-8 BOM.");
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("Response body is not valid JSON.");
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parses `https://noidium.com/api/v1/overview` `noid_usd` section.
 * Validates finite `price_usd > 0`, finite `volume_24h_usd >= 0`, valid UTC `ts`
 * (ISO or unix-s/ms), boolean `stale`, and the venue from `source` + `pair` (defaulting to
 * `"SafeTrade NOID/USDT"`).
 */
export function parseNoidiumOverview(payload) {
  if (!isPlainObject(payload) || !isPlainObject(payload.noid_usd)) {
    return null;
  }
  const entry = payload.noid_usd;

  const price = entry.price_usd;
  if (typeof price !== "number" || !Number.isFinite(price) || price <= 0 || price > MAX_USD_PRICE) {
    return null;
  }

  const volume = entry.volume_24h_usd;
  if (
    typeof volume !== "number" ||
    !Number.isFinite(volume) ||
    volume < 0 ||
    volume > MAX_VOLUME_USD
  ) {
    return null;
  }

  const ts = normalizeUtcIso(entry.ts);
  if (!ts) {
    return null;
  }

  if (entry.stale !== undefined && typeof entry.stale !== "boolean") {
    return null;
  }
  const stale = entry.stale === true;

  // Noidium names the venue as source ("SafeTrade") plus pair ("NOID/USDT").
  let venue = DEFAULT_NOID_VENUE;
  if (entry.source !== undefined && entry.source !== null) {
    if (typeof entry.source !== "string") {
      return null;
    }
    if (entry.pair !== undefined && entry.pair !== null && typeof entry.pair !== "string") {
      return null;
    }
    const label = typeof entry.pair === "string" ? `${entry.source} ${entry.pair}` : entry.source;
    const key = sanitizeDisplayText(label, 120).toLowerCase();
    if (Object.prototype.hasOwnProperty.call(ALLOWED_NOID_VENUES, key)) {
      venue = ALLOWED_NOID_VENUES[key];
    }
  }

  return {
    price,
    volume24hUsd: volume,
    ts,
    stale,
    venue,
    source: "Noidium",
  };
}

/**
 * Parses CoinGecko simple price response (`ethereum.usd`).
 * @param {unknown} payload
 * @returns {number|null}
 */
export function parseCoinGeckoEthUsd(payload) {
  if (!isPlainObject(payload) || !isPlainObject(payload.ethereum)) {
    return null;
  }
  const usd = payload.ethereum.usd;
  if (typeof usd !== "number" || !Number.isFinite(usd) || usd <= 0 || usd > MAX_USD_PRICE) {
    return null;
  }
  return usd;
}

/**
 * Parses Kraken Ticker response (`result.XETHZUSD.c[0]`). Requires the exact
 * `XETHZUSD` pair key with no fallback to arbitrary keys.
 * @param {unknown} payload
 * @returns {number|null}
 */
export function parseKrakenEthUsd(payload) {
  if (!isPlainObject(payload)) return null;
  if (Array.isArray(payload.error) && payload.error.length > 0) return null;
  if (!isPlainObject(payload.result)) return null;

  const ticker = payload.result.XETHZUSD;
  if (!isPlainObject(ticker) || !Array.isArray(ticker.c) || ticker.c.length === 0) {
    return null;
  }

  const rawLast = ticker.c[0];
  let price = NaN;
  if (typeof rawLast === "number") {
    price = rawLast;
  } else if (typeof rawLast === "string" && /^\d+(?:\.\d+)?$/.test(rawLast.trim())) {
    price = Number(rawLast.trim());
  }
  if (!Number.isFinite(price) || price <= 0 || price > MAX_USD_PRICE) {
    return null;
  }
  return price;
}

/**
 * Cross-checks CoinGecko and Kraken ETH/USD quotes. Returns midpoint rounded to
 * 2 decimals and `"CoinGecko + Kraken"` ONLY when both quotes are finite `> 0`
 * and agree within 2% (`|a - b| / min(a, b) <= 0.02`).
 */
export function crossCheckEthUsd(coinGeckoUsd, krakenUsd) {
  if (
    typeof coinGeckoUsd !== "number" ||
    !Number.isFinite(coinGeckoUsd) ||
    coinGeckoUsd <= 0 ||
    coinGeckoUsd > MAX_USD_PRICE ||
    typeof krakenUsd !== "number" ||
    !Number.isFinite(krakenUsd) ||
    krakenUsd <= 0 ||
    krakenUsd > MAX_USD_PRICE
  ) {
    return { ethUsd: null, source: null, agreed: false, diffRatio: null };
  }
  const diffRatio = Math.abs(coinGeckoUsd - krakenUsd) / Math.min(coinGeckoUsd, krakenUsd);
  if (!Number.isFinite(diffRatio) || diffRatio > ETH_CROSS_CHECK_MAX_DIFF) {
    return { ethUsd: null, source: null, agreed: false, diffRatio };
  }
  const midpoint = roundTo((coinGeckoUsd + krakenUsd) / 2, 2);
  return {
    ethUsd: midpoint,
    source: "CoinGecko + Kraken",
    agreed: true,
    diffRatio,
  };
}

function extractNonNegativeInt(obj, keys) {
  if (!isPlainObject(obj)) return null;
  for (const key of keys) {
    const val = obj[key];
    if (typeof val === "number" && Number.isInteger(val) && val >= 0) {
      return val;
    }
  }
  return null;
}

function extractPositiveInt(obj, keys) {
  if (!isPlainObject(obj)) return null;
  for (const key of keys) {
    const val = obj[key];
    if (typeof val === "number" && Number.isInteger(val) && val > 0) {
      return val;
    }
  }
  return null;
}

/**
 * Parses the NoidExplorer miners payload
 * (`https://noidexplorer.org/api/premium/miners?range=4h`):
 * `{range, from, to, blocks, addresses, top: [{address, blocks, last}]}`.
 * Returns the window (`from`/`to` unix seconds), the declared block count, the
 * top address and its share (`top.blocks / blocks * 100`), and `measuredAt`
 * (the window's `to` as UTC ISO). Returns `null` if any field is malformed, if
 * the listed counts exceed the declared total, or if `to` is > 5 min in the
 * future or > 6 h old.
 */
export function parseNoidExplorerMiners(payload, nowMs = Date.now()) {
  const now = typeof nowMs === "number" && Number.isFinite(nowMs) ? Math.floor(nowMs) : Date.now();
  if (!isPlainObject(payload)) return null;

  const from = payload.from;
  const to = payload.to;
  const blocks = payload.blocks;
  if (!Number.isSafeInteger(from) || from <= 0 || !Number.isSafeInteger(to) || to < from) return null;
  if (!Number.isSafeInteger(blocks) || blocks <= 0) return null;
  if (!Array.isArray(payload.top) || payload.top.length === 0) return null;

  const measuredAt = normalizeUtcIso(to);
  if (!measuredAt) return null;
  const measuredMs = to * 1000;
  if (measuredMs > now + MAX_FUTURE_SKEW_MS || now - measuredMs > EXPIRE_AFTER_MS) return null;

  let sumBlocks = 0;
  let topBlocks = 0;
  let topAddress = null;
  const seen = new Set();
  for (const item of payload.top) {
    if (!isPlainObject(item)) return null;
    if (typeof item.address !== "string" || !MINER_ADDRESS_RE.test(item.address)) return null;
    if (seen.has(item.address)) return null;
    seen.add(item.address);
    if (!Number.isSafeInteger(item.blocks) || item.blocks < 0) return null;
    sumBlocks += item.blocks;
    if (item.blocks > topBlocks) {
      topBlocks = item.blocks;
      topAddress = item.address;
    }
  }
  if (topBlocks <= 0 || topAddress === null || sumBlocks > blocks) return null;

  const topPct = (topBlocks / blocks) * 100;
  if (!Number.isFinite(topPct) || topPct <= 0 || topPct > 100) return null;

  return {
    topProducerSharePct: roundTo(topPct, 2),
    windowBlocks: blocks,
    measuredAt,
    from,
    to,
    topAddress,
    topBlocks,
  };
}

/**
 * Strictly parses one page of the Noidium blocks list (an array, newest first).
 * Each entry needs a positive-integer `height` and `ts`, a `miner` matching
 * the address pattern and a boolean `canonical`. Invalid entries are skipped
 * and counted. Returns `null` if the payload is not an array.
 * @returns {{ blocks: Array<{height:number, ts:number, miner:string, canonical:boolean}>, invalid: number, total: number }|null}
 */
export function parseNoidiumBlocksPage(payload) {
  if (!Array.isArray(payload)) return null;
  const blocks = [];
  let invalid = 0;
  for (const item of payload) {
    if (
      !isPlainObject(item) ||
      !Number.isSafeInteger(item.height) ||
      item.height <= 0 ||
      !Number.isSafeInteger(item.ts) ||
      item.ts <= 0 ||
      typeof item.miner !== "string" ||
      !MINER_ADDRESS_RE.test(item.miner) ||
      typeof item.canonical !== "boolean"
    ) {
      invalid += 1;
      continue;
    }
    blocks.push({ height: item.height, ts: item.ts, miner: item.miner, canonical: item.canonical });
  }
  return { blocks, invalid, total: payload.length };
}

/**
 * Reads Noidium's recent blocks (at most `NOIDIUM_MAX_PAGES` pages of up to 500,
 * newest first, older pages via `&before=<lowest height seen>`) until the oldest
 * timestamp is older than the explorer window start, then counts canonical
 * blocks per miner inside `[from, to]`, deduplicated by height. Throws if a
 * page is malformed, if more than 5 % of all entries are invalid, or if the
 * window is not covered within the page limit.
 * @returns {Promise<{windowBlocks:number, topAddress:string, topBlocks:number, topProducerSharePct:number}>}
 */
export async function fetchNoidiumWindow(baseUrl, window, fetchOpts) {
  const byHeight = new Map();
  let invalid = 0;
  let total = 0;
  let covered = false;
  let before = null;

  for (let page = 0; page < NOIDIUM_MAX_PAGES && !covered; page += 1) {
    const url = before === null ? baseUrl : `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}before=${before}`;
    const parsed = parseNoidiumBlocksPage(await fetchJsonStrict(url, fetchOpts));
    if (!parsed) throw new Error("Noidium blocks response is not an array.");
    invalid += parsed.invalid;
    total += parsed.total;
    if (parsed.total === 0) {
      covered = true; // no older blocks exist
      break;
    }
    if (parsed.blocks.length === 0) throw new Error("Noidium blocks page has no valid entries.");

    let lowestHeight = Infinity;
    let oldestTs = Infinity;
    for (const b of parsed.blocks) {
      if (b.height < lowestHeight) lowestHeight = b.height;
      if (b.ts < oldestTs) oldestTs = b.ts;
      if (b.canonical && b.ts >= window.from && b.ts <= window.to && !byHeight.has(b.height)) {
        byHeight.set(b.height, b.miner);
      }
    }
    if (before !== null && lowestHeight >= before) {
      throw new Error("Noidium blocks pagination did not advance.");
    }
    before = lowestHeight;
    if (oldestTs < window.from) covered = true;
  }

  if (total === 0 || invalid / total > NOIDIUM_MAX_INVALID_RATIO) {
    throw new Error("Noidium blocks response has too many invalid entries.");
  }
  if (!covered) throw new Error("Noidium blocks did not cover the explorer window.");

  const counts = new Map();
  for (const miner of byHeight.values()) counts.set(miner, (counts.get(miner) || 0) + 1);
  let topAddress = null;
  let topBlocks = 0;
  for (const [miner, n] of counts) {
    if (n > topBlocks) {
      topBlocks = n;
      topAddress = miner;
    }
  }
  const windowBlocks = byHeight.size;
  if (topAddress === null || windowBlocks <= 0) throw new Error("Noidium window has no canonical blocks.");
  return {
    windowBlocks,
    topAddress,
    topBlocks,
    topProducerSharePct: roundTo((topBlocks / windowBlocks) * 100, 2),
  };
}

/**
 * Cross-checks NoidExplorer's top-producer share against Noidium's block list
 * over the same window. The explorer's share is written only if both windows
 * hold at least 300 blocks, both name the same top address, and the two top
 * shares differ by at most 3 percentage points. Otherwise the share is
 * `null` (window and time of a valid explorer reading are kept). If the
 * explorer reading is unavailable everything is `null`.
 */
export function crossCheckProducerShare(explorerResult, noidiumResult) {
  if (!explorerResult) {
    return { topProducerSharePct: null, windowBlocks: null, measuredAt: null, agreed: false };
  }
  const base = {
    topProducerSharePct: null,
    windowBlocks: explorerResult.windowBlocks,
    measuredAt: explorerResult.measuredAt,
    agreed: false,
  };
  if (!noidiumResult) return base;
  if (
    explorerResult.windowBlocks < MIN_WINDOW_BLOCKS_FOR_SHARE ||
    noidiumResult.windowBlocks < MIN_WINDOW_BLOCKS_FOR_SHARE
  ) {
    return base;
  }
  if (explorerResult.topAddress !== noidiumResult.topAddress) return base;
  const diffPts = Math.abs(explorerResult.topProducerSharePct - noidiumResult.topProducerSharePct);
  if (!Number.isFinite(diffPts) || diffPts > PRODUCER_SHARE_MAX_DIFF_PTS) return base;
  return { ...base, topProducerSharePct: explorerResult.topProducerSharePct, agreed: true };
}

async function jsonRpcCall(rpcUrl, method, params, { fetchImpl, timeoutMs, maxBytes }) {
  const payload = await fetchJsonStrict(rpcUrl, {
    fetchImpl,
    timeoutMs,
    maxBytes,
    allowHttpLocal: true,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!isPlainObject(payload) || (payload.error !== undefined && payload.error !== null)) {
    throw new Error(`JSON-RPC ${method} returned an error.`);
  }
  return payload.result;
}

/**
 * Optionally fetches Ethereum base/gas price via explicit operator ETH RPC
 * (`eth_gasPrice`) and converts wei -> gwei. Returns `null` on failure.
 */
export async function fetchEthGasGwei(
  ethRpcUrl,
  { fetchImpl = globalThis.fetch, timeoutMs = FETCH_TIMEOUT_MS, maxBytes = MAX_RESPONSE_BYTES } = {},
) {
  const hexWei = await jsonRpcCall(ethRpcUrl, "eth_gasPrice", [], { fetchImpl, timeoutMs, maxBytes });
  if (typeof hexWei !== "string" || !/^0x[0-9a-fA-F]+$/.test(hexWei)) {
    return null;
  }
  const wei = BigInt(hexWei);
  if (wei <= 0n) return null;
  const gwei = roundTo(Number(wei) / 1e9, 3);
  if (!Number.isFinite(gwei) || gwei <= 0 || gwei > MAX_GAS_GWEI) {
    return null;
  }
  return gwei;
}

async function isRateLimited(outputPath, nowMs) {
  let raw;
  try {
    raw = await fs.readFile(outputPath, "utf8");
  } catch {
    return false;
  }
  let existing;
  try {
    existing = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!isPlainObject(existing) || typeof existing.generated_at !== "string") {
    return false;
  }
  const parsed = parseUtcIsoStrict(existing.generated_at);
  if (!parsed) {
    return false;
  }
  if (parsed.ms > nowMs + MAX_FUTURE_SKEW_MS) {
    return false;
  }
  return nowMs - parsed.ms < RATE_LIMIT_MS;
}

async function writeFileAtomic(targetPath, content) {
  const resolved = path.resolve(targetPath);
  const dir = path.dirname(resolved);
  const base = path.basename(resolved);
  await fs.mkdir(dir, { recursive: true });

  const tmpName = `.${base}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  const tmpPath = path.join(dir, tmpName);
  let renamed = false;

  try {
    const handle = await fs.open(tmpPath, "wx", 0o644);
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmpPath, resolved);
    renamed = true;
  } finally {
    if (!renamed) {
      await fs.unlink(tmpPath).catch(() => {});
    }
  }
}

/**
 * Executes a single market snapshot update cycle.
 *
 * @param {object} options
 * @param {string} options.outputPath - Target `market.json` path.
 * @param {typeof fetch} [options.fetchImpl=globalThis.fetch] - Injectable fetch implementation.
 * @param {number} [options.nowMs=Date.now()] - Current UTC epoch ms.
 * @param {string|null} [options.ethRpcUrl=null] - Optional Ethereum JSON-RPC URL for `eth_gasPrice`.
 * @param {boolean} [options.rateLimit=true] - Skip the run when the existing file is under 10 minutes old.
 * @param {number} [options.timeoutMs=FETCH_TIMEOUT_MS] - Per-request timeout ms.
 * @param {number} [options.maxBytes=MAX_RESPONSE_BYTES] - Per-response byte cap.
 * @param {object} [options.endpoints=ENDPOINTS] - Endpoint URL map (must be HTTPS).
 */
export async function runUpdate({
  outputPath,
  fetchImpl = globalThis.fetch,
  nowMs = Date.now(),
  ethRpcUrl = null,
  rateLimit = true,
  timeoutMs = FETCH_TIMEOUT_MS,
  maxBytes = MAX_RESPONSE_BYTES,
  endpoints = ENDPOINTS,
} = {}) {
  if (typeof outputPath !== "string" || !outputPath.trim()) {
    return { ok: false, skipped: false, reason: "invalid_output_path", error: "outputPath is required." };
  }

  const now = typeof nowMs === "number" && Number.isFinite(nowMs) ? Math.floor(nowMs) : Date.now();
  const nowIso = toUtcIso(now);

  // 1. Rate-limit guard (at most once every 10 minutes based on existing market.json).
  if (rateLimit && (await isRateLimited(outputPath, now))) {
    return { ok: true, skipped: true, reason: "rate_limited", outputPath };
  }

  const fetchOpts = { fetchImpl, timeoutMs, maxBytes, allowHttpLocal: false };

  // 2. Fetch public sources concurrently; individual failures are isolated and fail closed.
  const [noidiumRes, cgRes, krakenRes, explorerRes] = await Promise.allSettled([
    fetchJsonStrict(endpoints.noidium, fetchOpts),
    fetchJsonStrict(endpoints.coingecko, fetchOpts),
    fetchJsonStrict(endpoints.kraken, fetchOpts),
    fetchJsonStrict(endpoints.noidexplorer, fetchOpts),
  ]);

  let noidResult = noidiumRes.status === "fulfilled" ? parseNoidiumOverview(noidiumRes.value) : null;
  if (noidResult && Date.parse(noidResult.ts) > now + MAX_FUTURE_SKEW_MS) {
    noidResult = null;
  }
  const cgPrice = cgRes.status === "fulfilled" ? parseCoinGeckoEthUsd(cgRes.value) : null;
  const krakenPrice = krakenRes.status === "fulfilled" ? parseKrakenEthUsd(krakenRes.value) : null;
  const ethResult = crossCheckEthUsd(cgPrice, krakenPrice);

  const explorerResult =
    explorerRes.status === "fulfilled" ? parseNoidExplorerMiners(explorerRes.value, now) : null;

  // 3. Parano1d producer-share cross-check against a second public indexer (Noidium).
  let noidiumWindow = null;
  let noidiumError = null;
  if (explorerResult) {
    try {
      noidiumWindow = await fetchNoidiumWindow(endpoints.noidiumBlocks, explorerResult, fetchOpts);
    } catch (err) {
      noidiumWindow = null;
      noidiumError = err && err.message ? err.message : "error";
    }
  }
  const producerResult = crossCheckProducerShare(explorerResult, noidiumWindow);
  // One plain line for the job log: why the share is or is not published (counts only, no URLs).
  const diagText = (v) => String(v).replace(/[^\x20-\x7e]/g, "").slice(0, 120);
  let shareDiag;
  if (explorerRes.status !== "fulfilled") {
    const reason = explorerRes.reason && explorerRes.reason.message ? explorerRes.reason.message : "error";
    shareDiag = `explorer failed: ${diagText(reason)}`;
  } else if (!explorerResult) {
    shareDiag = "explorer response rejected by validation";
  } else if (!noidiumWindow) {
    shareDiag = `noidium failed: ${diagText(noidiumError || "error")}`;
  } else {
    shareDiag =
      `explorer ${explorerResult.topProducerSharePct}% of ${explorerResult.windowBlocks}, ` +
      `noidium ${noidiumWindow.topProducerSharePct}% of ${noidiumWindow.windowBlocks}, ` +
      `same top address ${explorerResult.topAddress === noidiumWindow.topAddress}`;
  }

  // 4. Optional ETH gas price (only when operator explicitly configures --eth-rpc / ETH_RPC_URL).
  let ethGasGwei = null;
  if (typeof ethRpcUrl === "string" && ethRpcUrl.trim().length > 0) {
    try {
      ethGasGwei = await fetchEthGasGwei(ethRpcUrl.trim(), { fetchImpl, timeoutMs, maxBytes });
    } catch {
      ethGasGwei = null;
    }
  }

  // 5. Build candidate market.json object.
  const payload = {
    v: 1,
    generated_at: nowIso,
    sources: {
      eth_usd: ethResult.source,
      noid_usd: noidResult ? noidResult.source : null,
    },
    eth_usd: ethResult.ethUsd,
    noid_usd: noidResult ? noidResult.price : null,
    noid_usd_venue: noidResult ? noidResult.venue : null,
    noid_volume_24h_usd: noidResult ? noidResult.volume24hUsd : null,
    noid_price_ts: noidResult ? noidResult.ts : null,
    noid_price_stale: noidResult ? noidResult.stale : false,
    parano1d: {
      top_producer_share_pct: producerResult.topProducerSharePct,
      window_blocks: producerResult.windowBlocks,
      measured_at: producerResult.measuredAt,
    },
    eth_gas_gwei: ethGasGwei,
  };

  // 6. Total failure check: if all core data failed, leave existing market.json untouched.
  if (
    payload.eth_usd === null &&
    payload.noid_usd === null &&
    payload.parano1d.top_producer_share_pct === null
  ) {
    return {
      ok: false,
      skipped: false,
      reason: "all_sources_failed",
      error: `All market sources failed or were rejected by cross-checks (share: ${shareDiag}).`,
    };
  }

  // 7. Strict output self-check via parseMarketSnapshot() before touching disk.
  const jsonText = `${JSON.stringify(payload, null, 2)}\n`;
  const validated = parseMarketSnapshot(jsonText, now);
  if (!validated || !validated.ok) {
    return {
      ok: false,
      skipped: false,
      reason: "validation_failed",
      error: validated && validated.error ? validated.error : "Snapshot failed parseMarketSnapshot().",
    };
  }

  // 8. Atomic write via same-directory temp file + fs.rename().
  await writeFileAtomic(outputPath, jsonText);

  return {
    ok: true,
    skipped: false,
    outputPath,
    payload,
    snapshot: validated,
    shareDiag,
  };
}

function parseCliArgs(argv) {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const opts = {
    outputPath: path.resolve(__dirname, "..", "data", "market.json"),
    ethRpcUrl: process.env.ETH_RPC_URL || null,
    help: false,
    softFail: false,
    rateLimit: true,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      opts.help = true;
      return opts;
    }
    if (arg === "--out") {
      const val = argv[i + 1];
      if (!val || val.startsWith("--")) {
        throw new Error("Missing value for --out.");
      }
      opts.outputPath = val;
      i += 1;
      continue;
    }
    if (arg === "--soft-fail") {
      opts.softFail = true;
      continue;
    }
    if (arg === "--no-rate-limit") {
      opts.rateLimit = false;
      continue;
    }
    if (arg === "--eth-rpc") {
      const val = argv[i + 1];
      if (!val || val.startsWith("--")) {
        throw new Error("Missing value for --eth-rpc.");
      }
      opts.ethRpcUrl = val;
      i += 1;
      continue;
    }
    throw new Error(`Unknown CLI option: ${arg}`);
  }

  return opts;
}

async function main() {
  let opts;
  try {
    opts = parseCliArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exitCode = 2;
    return;
  }

  if (opts.help) {
    process.stdout.write(
      [
        "Usage: node scripts/update-market.mjs [options]",
        "",
        "Options:",
        "  --out <path>           Output market.json path (default: data/market.json)",
        "  --eth-rpc <url>        Optional Ethereum JSON-RPC URL for eth_gasPrice (or ETH_RPC_URL)",
        "  --soft-fail            Exit 0 when all sources fail (any existing file is kept)",
        "  --no-rate-limit        Do not skip when the existing file is under 10 minutes old",
        "  -h, --help             Show this help message",
        "",
      ].join("\n"),
    );
    return;
  }

  const result = await runUpdate({
    outputPath: opts.outputPath,
    ethRpcUrl: opts.ethRpcUrl,
    rateLimit: opts.rateLimit,
  });

  if (!result.ok) {
    process.stderr.write(`Market snapshot update failed (${result.reason}): ${result.error}\n`);
    process.exitCode = opts.softFail ? 0 : 1;
    return;
  }

  if (result.skipped) {
    process.stdout.write(`${JSON.stringify({ skipped: true, reason: result.reason })}\n`);
    return;
  }

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      generated_at: result.payload.generated_at,
      eth_usd: result.payload.eth_usd,
      noid_usd: result.payload.noid_usd,
      top_producer_share_pct: result.payload.parano1d.top_producer_share_pct,
      share_check: result.shareDiag,
    })}\n`,
  );
}

const isDirectRun =
  typeof process.argv[1] === "string" &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  main().catch((err) => {
    process.stderr.write(`Fatal error: ${err && err.message ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
