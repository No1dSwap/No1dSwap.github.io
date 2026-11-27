/**
 * Same-origin static market snapshot loader, validator, reference-diff helper,
 * and local rate calculator.
 *
 * Pure ES module with zero external dependencies. Never contacts any third-party
 * host: `isSameOriginPath()` strictly permits only relative `./...` or `/...`
 * paths on `'self'`. Every untrusted JSON field is validated, bounded, clamped,
 * and sanitized before reaching the UI, failing closed to `"Prices unavailable"`
 * on any anomaly. Unknown keys are ignored.
 *
 * Display only: prices and reference diffs never enter invitation codes,
 * `no1d-invite:` links, the Inspector output, or any copy text.
 */

import { NETWORK_SPECS, sanitizeDisplayText } from "./invite-codec.js";

export const MARKET_SNAPSHOT_URL = "./data/market.json";
export const MAX_MARKET_BYTES = 1_048_576; // 1 MB
export const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000; // 5 minutes
export const STALE_AFTER_MS = 30 * 60 * 1000; // 30 minutes
export const EXPIRE_AFTER_MS = 6 * 60 * 60 * 1000; // 6 hours
export const LOW_VOLUME_USD_THRESHOLD = 10_000;

export const MIN_POSITIVE_NUM = 1e-12;
export const MAX_USD_PRICE = 1e9;
export const MAX_VOLUME_USD = 1e15;
export const MAX_GAS_GWEI = 1e6;
export const MAX_CALC_AMOUNT = 1e9;

const MAINNET_MAX_NOID = Number(NETWORK_SPECS.mainnet.maxNoid); // 2500
const MAINNET_MAX_ETH = Number(NETWORK_SPECS.mainnet.maxEth); // 0.5
const SEPOLIA_MAX_NOID = Number(NETWORK_SPECS.sepolia.maxNoid); // 20
const SEPOLIA_MAX_ETH = Number(NETWORK_SPECS.sepolia.maxEth); // 0.01

const SAFE_SAME_ORIGIN_RE = /^(?:\.\/|\/(?!\/))[A-Za-z0-9._/-]+$/;
const UTC_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER_FATAL = new TextDecoder("utf-8", { fatal: true });

const isPlainObject = (o) =>
  o !== null &&
  typeof o === "object" &&
  !Array.isArray(o) &&
  Object.getPrototypeOf(o) === Object.prototype;

const utf8ByteLength = (str) => TEXT_ENCODER.encode(str).length;

// Shared in-memory snapshot state so market-ui.js and board-ui.js stay synchronized.
let currentSnapshot = null;
const snapshotListeners = new Set();

export function getCurrentSnapshot() {
  return currentSnapshot;
}

export function setCurrentSnapshot(snapshot) {
  currentSnapshot = snapshot || null;
  for (const fn of snapshotListeners) {
    try {
      fn(currentSnapshot);
    } catch {
      /* listener errors do not break other subscribers */
    }
  }
}

export function onSnapshotChange(listener) {
  if (typeof listener !== "function") return () => {};
  snapshotListeners.add(listener);
  return () => {
    snapshotListeners.delete(listener);
  };
}

/**
 * Strictly validates that `url` is a same-origin relative `./...` or root-relative
 * `/...` path on `'self'`. Rejects all schemes (`http:`, `https:`, `data:`,
 * `javascript:`, etc.), protocol-relative `//`, backslashes, query/fragment,
 * whitespace, control chars, and `..` traversal segments.
 * @param {unknown} url
 * @returns {boolean}
 */
export function isSameOriginPath(url) {
  if (typeof url !== "string") return false;
  if (url.length < 2 || url.length > 256) return false;
  if (!SAFE_SAME_ORIGIN_RE.test(url)) return false;
  if (url.includes("..") || url.includes("//")) return false;
  return true;
}

function isFinitePositive(val, maxVal) {
  return typeof val === "number" && Number.isFinite(val) && val > 0 && val <= maxVal;
}

/**
 * Parses a strict UTC ISO-8601 timestamp (`YYYY-MM-DDTHH:MM:SS(.sss)?Z`) and
 * rejects calendar/clock rollovers (such as `2026-02-31` or `T24:00:00Z`) by
 * requiring `new Date(ms).toISOString()` to match the input.
 * @param {unknown} str
 * @returns {{ ms: number, iso: string } | null}
 */
export function parseUtcIsoStrict(str) {
  if (typeof str !== "string" || !UTC_ISO_RE.test(str)) return null;
  const parsedMs = Date.parse(str);
  if (!Number.isFinite(parsedMs)) return null;
  const canonicalFull = new Date(parsedMs).toISOString();
  const dotIdx = str.indexOf(".");
  let expectedFull;
  if (dotIdx === -1) {
    expectedFull = `${str.slice(0, -1)}.000Z`;
  } else {
    const frac = str.slice(dotIdx + 1, -1).padEnd(3, "0");
    expectedFull = `${str.slice(0, dotIdx)}.${frac}Z`;
  }
  if (canonicalFull !== expectedFull) return null;
  const iso = canonicalFull.replace(/\.\d{3}Z$/, "Z");
  return { ms: parsedMs, iso };
}

function parseUtcWithinSkew(str, nowMs) {
  const parsed = parseUtcIsoStrict(str);
  if (!parsed) return null;
  if (parsed.ms > nowMs + MAX_FUTURE_SKEW_MS) return null;
  return parsed;
}

function failSnapshot(error) {
  return {
    ok: false,
    freshness: "unavailable",
    status: "unavailable",
    statusLabel: "Prices unavailable",
    pricesVisible: false,
    isSample: false,
    isStale: false,
    isExpired: false,
    ethUsd: null,
    noidUsd: null,
    noidUsdVenue: null,
    noidVolume24hUsd: null,
    noidPriceTsUtc: null,
    noidPriceAgeMs: null,
    noidPriceStale: false,
    noidPriceExpired: false,
    noidLowVolume: false,
    noidPriceMuted: false,
    impliedNoidPerEth: null,
    impliedEthPerNoid: null,
    hasEthPrice: false,
    hasNoidPrice: false,
    hasPrices: false,
    parano1d: null,
    ethGasGwei: null,
    sources: null,
    error,
  };
}

/**
 * Validates and normalizes a raw `./data/market.json` string or object.
 * Unknown keys are ignored; all required fields are strictly validated; non-null
 * numbers must be finite and `> 0`; timestamps more than 5 minutes ahead of
 * `nowMs` fail the entire snapshot closed to `"Prices unavailable"`.
 *
 * Age thresholds (`ageMs = max(0, nowMs - tsMs)`):
 * - `<= 30 min`: `freshness = "fresh"`, `pricesVisible = true`
 * - `> 30 min` and `<= 6 h`: `freshness = "stale"`, `isStale = true`, `pricesVisible = true`
 * - `> 6 h`: `freshness = "expired"`, `isExpired = true`, `pricesVisible = false` (prices hidden)
 *
 * @param {string|object} raw
 * @param {number} [nowMs=Date.now()]
 */
export function parseMarketSnapshot(raw, nowMs = Date.now()) {
  const now = typeof nowMs === "number" && Number.isFinite(nowMs) ? Math.floor(nowMs) : Date.now();
  let obj = raw;
  if (typeof raw === "string") {
    if (utf8ByteLength(raw) > MAX_MARKET_BYTES) {
      return failSnapshot(`Snapshot exceeds the ${MAX_MARKET_BYTES}-byte limit.`);
    }
    if (raw.charCodeAt(0) === 0xfeff) {
      return failSnapshot("Snapshot must not start with a byte order mark.");
    }
    try {
      obj = JSON.parse(raw);
    } catch {
      return failSnapshot("Snapshot is not valid JSON.");
    }
  }
  if (!isPlainObject(obj)) {
    return failSnapshot("Snapshot must be a JSON object.");
  }
  if (obj.v !== 1) {
    return failSnapshot("Unsupported snapshot schema version.");
  }

  // generated_at (strict UTC ISO-8601, <= now + 5 min)
  const gen = parseUtcWithinSkew(obj.generated_at, now);
  if (!gen) {
    return failSnapshot("Snapshot generated_at must be a valid UTC ISO-8601 timestamp not more than 5 min ahead.");
  }

  // sources: { eth_usd: non-empty string | null, noid_usd: non-empty string | null }
  if (!isPlainObject(obj.sources)) {
    return failSnapshot("Snapshot sources must be an object.");
  }
  let ethSource = null;
  if (obj.sources.eth_usd !== null) {
    if (typeof obj.sources.eth_usd !== "string") {
      return failSnapshot("Snapshot sources.eth_usd must be a non-empty string or null.");
    }
    ethSource = sanitizeDisplayText(obj.sources.eth_usd, 120);
    if (!ethSource) {
      return failSnapshot("Snapshot sources.eth_usd must be a non-empty string or null.");
    }
  }
  let noidSource = null;
  if (obj.sources.noid_usd !== null) {
    if (typeof obj.sources.noid_usd !== "string") {
      return failSnapshot("Snapshot sources.noid_usd must be a non-empty string or null.");
    }
    noidSource = sanitizeDisplayText(obj.sources.noid_usd, 120);
    if (!noidSource) {
      return failSnapshot("Snapshot sources.noid_usd must be a non-empty string or null.");
    }
  }

  // eth_usd: finite > 0 or null (null when ETH sources disagree by > 2% or fail)
  if (obj.eth_usd !== null && !isFinitePositive(obj.eth_usd, MAX_USD_PRICE)) {
    return failSnapshot("Snapshot eth_usd must be a finite number greater than 0 or null.");
  }
  const rawEthUsd = obj.eth_usd;
  if (rawEthUsd !== null && ethSource === null) {
    return failSnapshot("Snapshot sources.eth_usd is required when eth_usd is present.");
  }

  // noid_usd: finite > 0 or null (never invent a NOID price if null)
  if (obj.noid_usd !== null && !isFinitePositive(obj.noid_usd, MAX_USD_PRICE)) {
    return failSnapshot("Snapshot noid_usd must be a finite number greater than 0 or null.");
  }
  const rawNoidUsd = obj.noid_usd;
  if (rawNoidUsd !== null && noidSource === null) {
    return failSnapshot("Snapshot sources.noid_usd is required when noid_usd is present.");
  }

  // noid_usd_venue: non-empty string when noid_usd !== null (or null when noid_usd === null)
  let noidUsdVenue = null;
  if (obj.noid_usd_venue === null) {
    if (rawNoidUsd !== null) {
      return failSnapshot("Snapshot noid_usd_venue is required when noid_usd is present.");
    }
  } else if (typeof obj.noid_usd_venue === "string") {
    noidUsdVenue = sanitizeDisplayText(obj.noid_usd_venue, 120);
    if (!noidUsdVenue) {
      return failSnapshot("Snapshot noid_usd_venue must be a non-empty string.");
    }
  } else {
    return failSnapshot("Snapshot noid_usd_venue must be a non-empty string or null.");
  }

  // noid_volume_24h_usd: finite >= 0 when noid_usd !== null (or null when noid_usd === null)
  let noidVolume24hUsd = null;
  if (obj.noid_volume_24h_usd === null) {
    if (rawNoidUsd !== null) {
      return failSnapshot("Snapshot noid_volume_24h_usd is required when noid_usd is present.");
    }
  } else if (
    typeof obj.noid_volume_24h_usd === "number" &&
    Number.isFinite(obj.noid_volume_24h_usd) &&
    obj.noid_volume_24h_usd >= 0 &&
    obj.noid_volume_24h_usd <= MAX_VOLUME_USD
  ) {
    noidVolume24hUsd = obj.noid_volume_24h_usd;
  } else {
    return failSnapshot("Snapshot noid_volume_24h_usd must be a finite number >= 0 or null.");
  }

  // noid_price_ts: strict UTC ISO-8601 (<= now + 5 min) when noid_usd !== null (or null when noid_usd === null)
  let noidPriceTs = null;
  if (obj.noid_price_ts === null) {
    if (rawNoidUsd !== null) {
      return failSnapshot("Snapshot noid_price_ts is required when noid_usd is present.");
    }
  } else {
    noidPriceTs = parseUtcWithinSkew(obj.noid_price_ts, now);
    if (!noidPriceTs) {
      return failSnapshot("Snapshot noid_price_ts must be a valid UTC ISO-8601 timestamp not more than 5 min ahead, or null.");
    }
  }

  // noid_price_stale: required boolean when noid_usd !== null; optional boolean when noid_usd === null
  if (rawNoidUsd !== null) {
    if (typeof obj.noid_price_stale !== "boolean") {
      return failSnapshot("Snapshot noid_price_stale must be a boolean when noid_usd is present.");
    }
  } else if (obj.noid_price_stale !== undefined && typeof obj.noid_price_stale !== "boolean") {
    return failSnapshot("Snapshot noid_price_stale must be a boolean when provided.");
  }
  const rawNoidPriceStale = obj.noid_price_stale === true;

  // parano1d: { top_producer_share_pct: (0..100] | null, window_blocks: int > 0 | null, measured_at: UTC ISO | null }
  if (!isPlainObject(obj.parano1d)) {
    return failSnapshot("Snapshot parano1d block is required.");
  }
  const share = obj.parano1d.top_producer_share_pct;
  const rawShareUnavailable = share === null;
  if (!rawShareUnavailable && (typeof share !== "number" || !Number.isFinite(share) || share <= 0 || share > 100)) {
    return failSnapshot("Snapshot parano1d.top_producer_share_pct must be finite in (0, 100] or null.");
  }
  const windowBlocks = obj.parano1d.window_blocks;
  if (windowBlocks === null) {
    if (!rawShareUnavailable) {
      return failSnapshot("Snapshot parano1d.window_blocks is required when top_producer_share_pct is present.");
    }
  } else if (typeof windowBlocks !== "number" || !Number.isInteger(windowBlocks) || windowBlocks <= 0) {
    return failSnapshot("Snapshot parano1d.window_blocks must be a positive integer or null.");
  }
  let measured = null;
  if (obj.parano1d.measured_at === null) {
    if (!rawShareUnavailable) {
      return failSnapshot("Snapshot parano1d.measured_at is required when top_producer_share_pct is present.");
    }
  } else {
    measured = parseUtcWithinSkew(obj.parano1d.measured_at, now);
    if (!measured) {
      return failSnapshot("Snapshot parano1d.measured_at must be a valid UTC ISO-8601 timestamp not more than 5 min ahead, or null.");
    }
  }

  // eth_gas_gwei: finite > 0 or null
  if (obj.eth_gas_gwei !== null && !isFinitePositive(obj.eth_gas_gwei, MAX_GAS_GWEI)) {
    return failSnapshot("Snapshot eth_gas_gwei must be a finite number greater than 0 or null.");
  }
  const ethGasGwei = obj.eth_gas_gwei;

  // Sample detection
  const isSample =
    obj.sample === true ||
    (ethSource !== null && /^sample\b/i.test(ethSource)) ||
    (noidSource !== null && /^sample\b/i.test(noidSource)) ||
    (noidUsdVenue !== null && /^sample\b/i.test(noidUsdVenue));

  // Age thresholds: <= 30m fresh, > 30m..6h stale, > 6h expired (prices hidden)
  const ageMs = Math.max(0, now - gen.ms);
  const isExpired = ageMs > EXPIRE_AFTER_MS;
  const isStale = ageMs > STALE_AFTER_MS;
  const pricesVisible = !isExpired;

  const noidPriceAgeMs = noidPriceTs ? Math.max(0, now - noidPriceTs.ms) : null;
  const noidPriceExpired = noidPriceAgeMs !== null && noidPriceAgeMs > EXPIRE_AFTER_MS;
  const noidPriceStale = Boolean(
    isStale || rawNoidPriceStale || (noidPriceAgeMs !== null && noidPriceAgeMs > STALE_AFTER_MS),
  );
  const noidLowVolume = noidVolume24hUsd !== null && noidVolume24hUsd < LOW_VOLUME_USD_THRESHOLD;
  const noidPriceMuted = Boolean(noidPriceStale || noidLowVolume);

  // Parano1d producer share age thresholds: <= 30m fresh, > 30m..6h stale, > 6h hidden
  const measuredAtAgeMs = measured ? Math.max(0, now - measured.ms) : null;
  const shareExpired = Boolean(isExpired || (measuredAtAgeMs !== null && measuredAtAgeMs > EXPIRE_AFTER_MS));
  const shareStale = Boolean(isStale || (measuredAtAgeMs !== null && measuredAtAgeMs > STALE_AFTER_MS));
  const topProducerSharePct = !rawShareUnavailable && !shareExpired ? share : null;
  // Optional share_source: "noidexplorer+noidium" (two sources agree) or "noidium" (one source).
  // Missing means an older file written only from two sources; any other value fails closed.
  const rawShareSource = obj.parano1d.share_source;
  let shareSource = "noidexplorer+noidium";
  if (rawShareSource !== undefined && rawShareSource !== null) {
    if (rawShareSource !== "noidexplorer+noidium" && rawShareSource !== "noidium") {
      return failSnapshot("Snapshot parano1d.share_source must be \"noidexplorer+noidium\", \"noidium\" or null.");
    }
    shareSource = rawShareSource;
  }
  const shareSingleSource = topProducerSharePct !== null && shareSource === "noidium";
  const shareUnavailable = topProducerSharePct === null;

  const freshness = isExpired ? "expired" : isStale ? "stale" : "fresh";
  const hasEthPrice = pricesVisible && rawEthUsd !== null;
  const ethUsd = hasEthPrice ? rawEthUsd : null;
  const hasNoidPrice = pricesVisible && rawNoidUsd !== null && !noidPriceExpired;
  const noidUsd = hasNoidPrice ? rawNoidUsd : null;
  const hasPrices = hasEthPrice && hasNoidPrice;
  const impliedNoidPerEth = hasPrices ? ethUsd / noidUsd : null;
  const impliedEthPerNoid = hasPrices ? noidUsd / ethUsd : null;

  let status = freshness;
  let statusLabel = "Reference only";
  if (isExpired) {
    status = "expired";
    statusLabel = "Prices unavailable";
  } else if (isStale) {
    status = "stale";
    statusLabel = "Stale";
  } else if (isSample) {
    status = "sample";
    statusLabel = "Sample data";
  }

  return {
    ok: true,
    v: 1,
    isSample,
    freshness,
    status,
    statusLabel,
    isStale,
    isExpired,
    pricesVisible,
    generatedAtUtc: gen.iso,
    generatedAtMs: gen.ms,
    ageMs,
    sources: Object.freeze({
      ethUsd: ethSource,
      noidUsd: noidSource,
    }),
    ethUsd,
    noidUsd,
    noidUsdVenue,
    noidVolume24hUsd,
    noidPriceTsUtc: noidPriceTs ? noidPriceTs.iso : null,
    noidPriceAgeMs,
    noidPriceStale,
    noidPriceExpired,
    noidLowVolume,
    noidPriceMuted,
    hasEthPrice,
    hasNoidPrice,
    hasPrices,
    impliedNoidPerEth,
    impliedEthPerNoid,
    parano1d: Object.freeze({
      topProducerSharePct,
      shareUnavailable,
      shareStale,
      shareExpired,
      shareSingleSource,
      windowBlocks,
      measuredAtUtc: measured ? measured.iso : null,
      measuredAtMs: measured ? measured.ms : null,
      measuredAtAgeMs,
    }),
    ethGasGwei,
  };
}

async function readResponseTextBounded(response, maxBytes) {
  if (response.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
        total += bytes.byteLength;
        if (total > maxBytes) {
          try {
            await reader.cancel();
          } catch {
            /* ignore cancel error */
          }
          return { ok: false, error: `Snapshot exceeds the ${maxBytes}-byte limit.` };
        }
        chunks.push(bytes);
      }
    } catch {
      return { ok: false, error: "Could not read snapshot stream." };
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return { ok: true, text: TEXT_DECODER_FATAL.decode(merged) };
    } catch {
      return { ok: false, error: "Snapshot is not valid UTF-8 text." };
    }
  }
  try {
    const text = await response.text();
    if (utf8ByteLength(text) > maxBytes) {
      return { ok: false, error: `Snapshot exceeds the ${maxBytes}-byte limit.` };
    }
    return { ok: true, text };
  } catch {
    return { ok: false, error: "Could not read snapshot text." };
  }
}

/**
 * Fetches and validates the same-origin static market snapshot (`./data/market.json`).
 * Refuses any non-same-origin URL before touching `fetchImpl`, enforces the 1 MB
 * size cap, and fails closed cleanly to `"Prices unavailable"` on any error.
 * @param {string} [url="./data/market.json"]
 * @param {typeof fetch} [fetchImpl]
 * @param {number} [nowMs]
 */
export async function loadSameOriginSnapshot(
  url = MARKET_SNAPSHOT_URL,
  fetchImpl = globalThis.fetch,
  nowMs = Date.now(),
) {
  if (!isSameOriginPath(url)) {
    return failSnapshot("Refused non-same-origin snapshot URL.");
  }
  if (typeof fetchImpl !== "function") {
    return failSnapshot("Fetch API is unavailable in this environment.");
  }
  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
  } catch {
    return failSnapshot("Could not fetch same-origin market snapshot.");
  }
  if (!response || !response.ok) {
    return failSnapshot("Same-origin market snapshot returned an error status.");
  }
  const declaredLen =
    response.headers && typeof response.headers.get === "function"
      ? Number(response.headers.get("content-length"))
      : NaN;
  if (Number.isFinite(declaredLen) && declaredLen > MAX_MARKET_BYTES) {
    return failSnapshot(`Snapshot exceeds the ${MAX_MARKET_BYTES}-byte limit.`);
  }
  const read = await readResponseTextBounded(response, MAX_MARKET_BYTES);
  if (!read.ok) return failSnapshot(read.error);
  return parseMarketSnapshot(read.text, nowMs);
}

/**
 * Returns `true` ONLY when an offer-vs-reference diff may be displayed:
 * mainnet offers only (never Sepolia, where Bob gives test ETH), with a fresh,
 * non-expired, unmuted snapshot containing both ETH and NOID reference quotes.
 * @param {object|null} snap
 * @param {string} network
 * @returns {boolean}
 */
export function canShowOfferReferenceDiff(snap, network) {
  return Boolean(
    network === "mainnet" &&
      snap &&
      snap.ok &&
      snap.pricesVisible &&
      !snap.isStale &&
      !snap.isExpired &&
      !snap.noidPriceMuted &&
      snap.hasPrices &&
      typeof snap.impliedNoidPerEth === "number",
  );
}

/**
 * Formats a plain neutral comparison between a decoded offer's NOID-per-ETH rate
 * and the non-expired reference NOID-per-ETH rate:
 * e.g. `"6% below reference"`, `"4% above reference"`, or `"at reference"`.
 * Returns `null` if either input is missing/non-finite/non-positive.
 * @param {number|null} decodedOfferNoidPerEth
 * @param {number|null} refNoidPerEth
 * @returns {string|null}
 */
export function formatReferenceDiff(decodedOfferNoidPerEth, refNoidPerEth) {
  if (
    typeof decodedOfferNoidPerEth !== "number" ||
    !Number.isFinite(decodedOfferNoidPerEth) ||
    decodedOfferNoidPerEth <= 0 ||
    typeof refNoidPerEth !== "number" ||
    !Number.isFinite(refNoidPerEth) ||
    refNoidPerEth <= 0
  ) {
    return null;
  }
  const pct = ((decodedOfferNoidPerEth - refNoidPerEth) / refNoidPerEth) * 100;
  if (!Number.isFinite(pct)) return null;
  const rounded = Math.round(Math.abs(pct));
  if (rounded === 0) return "at reference";
  return pct < 0 ? `${rounded}% below reference` : `${rounded}% above reference`;
}

/**
 * Formats an age duration in ms as plain relative text ("just now", "10 min ago", "2 h ago").
 * @param {number} ageMs
 * @returns {string}
 */
export function formatAgeLabel(ageMs) {
  if (typeof ageMs !== "number" || !Number.isFinite(ageMs) || ageMs < 0) return "—";
  const mins = Math.floor(ageMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours < 24) return remMins > 0 ? `${hours} h ${remMins} min ago` : `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `${days} d ago`;
}

function parsePositiveNumber(val, minVal, maxVal) {
  if (typeof val === "number") {
    return Number.isFinite(val) && val >= minVal && val <= maxVal ? val : null;
  }
  if (typeof val === "string") {
    const trimmed = val.trim();
    if (!trimmed || !/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(trimmed)) return null;
    const n = Number(trimmed);
    return Number.isFinite(n) && n >= minVal && n <= maxVal ? n : null;
  }
  return null;
}

/**
 * Pure local swap estimator from user-entered amount and reference USD quotes.
 * Returns paired NOID/ETH amounts, indicative USD value, implied rates, and
 * compliance booleans against No1d Swap's mainnet (2,500 NOID / 0.5 ETH) and
 * Sepolia (20 NOID / 0.01 ETH) per-swap caps.
 * @param {{amount:number|string, side:"noid"|"eth", ethUsd:number|string, noidUsd:number|string}} params
 */
export function computeSwapEstimate({ amount, side, ethUsd, noidUsd } = {}) {
  const normSide = typeof side === "string" ? side.trim().toLowerCase() : "";
  if (normSide !== "noid" && normSide !== "eth") {
    return { ok: false, error: "Side must be \"noid\" or \"eth\"." };
  }
  const parsedEthUsd = parsePositiveNumber(ethUsd, MIN_POSITIVE_NUM, MAX_USD_PRICE);
  const parsedNoidUsd = parsePositiveNumber(noidUsd, MIN_POSITIVE_NUM, MAX_USD_PRICE);
  if (parsedEthUsd === null || parsedNoidUsd === null) {
    return { ok: false, error: "Enter positive reference USD prices for both ETH and NOID." };
  }
  const parsedAmount = parsePositiveNumber(amount, MIN_POSITIVE_NUM, MAX_CALC_AMOUNT);
  if (parsedAmount === null) {
    return { ok: false, error: "Enter a positive swap amount." };
  }

  const impliedNoidPerEth = parsedEthUsd / parsedNoidUsd;
  const impliedEthPerNoid = parsedNoidUsd / parsedEthUsd;

  const noidAmount = normSide === "noid" ? parsedAmount : (parsedAmount * parsedEthUsd) / parsedNoidUsd;
  const ethAmount = normSide === "eth" ? parsedAmount : (parsedAmount * parsedNoidUsd) / parsedEthUsd;
  const usdValue = normSide === "noid" ? parsedAmount * parsedNoidUsd : parsedAmount * parsedEthUsd;

  if (!Number.isFinite(noidAmount) || !Number.isFinite(ethAmount) || !Number.isFinite(usdValue)) {
    return { ok: false, error: "Calculated values are out of range." };
  }

  const withinMainnetNoidCap = noidAmount <= MAINNET_MAX_NOID;
  const withinMainnetEthCap = ethAmount <= MAINNET_MAX_ETH;
  const withinMainnetCaps = withinMainnetNoidCap && withinMainnetEthCap;

  const withinSepoliaNoidCap = noidAmount <= SEPOLIA_MAX_NOID;
  const withinSepoliaEthCap = ethAmount <= SEPOLIA_MAX_ETH;
  const withinSepoliaCaps = withinSepoliaNoidCap && withinSepoliaEthCap;

  let capStatus = "exceeds_mainnet";
  let capLabel = "Exceeds mainnet per-swap cap (2,500 NOID / 0.5 ETH)";
  if (withinSepoliaCaps) {
    capStatus = "sepolia_and_mainnet";
    capLabel = "Within Sepolia (20 NOID / 0.01 ETH) and mainnet (2,500 NOID / 0.5 ETH) caps";
  } else if (withinMainnetCaps) {
    capStatus = "mainnet_only";
    capLabel = "Within mainnet cap (2,500 NOID / 0.5 ETH); above Sepolia cap";
  }

  return {
    ok: true,
    side: normSide,
    noidAmount,
    ethAmount,
    usdValue,
    impliedNoidPerEth,
    impliedEthPerNoid,
    withinMainnetNoidCap,
    withinMainnetEthCap,
    withinMainnetCaps,
    withinSepoliaNoidCap,
    withinSepoliaEthCap,
    withinSepoliaCaps,
    capStatus,
    capLabel,
  };
}

/**
 * Formats a positive USD quote cleanly ("$3,200.00", "$0.64", "$0.00042"), or "—" if unavailable.
 * @param {number|null} value
 * @returns {string}
 */
export function formatUsd(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "—";
  if (value >= 100) {
    return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  if (value >= 0.01) {
    return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
  }
  return `$${value.toPrecision(4)}`;
}

/**
 * Formats a non-negative USD 24 h volume cleanly ("$0", "$4,200", "$12,500"), or "—" if unavailable.
 * @param {number|null} value
 * @returns {string}
 */
export function formatUsdVolume(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "—";
  if (value === 0) return "$0";
  if (value >= 100) {
    return `$${Math.round(value).toLocaleString("en-US")}`;
  }
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

/**
 * Formats a positive numeric quote/amount with grouped integer digits and trimmed decimals, or "—".
 * @param {number|null} value
 * @param {number} [maxDecimals=6]
 * @returns {string}
 */
export function formatQuoteNumber(value, maxDecimals = 6) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "—";
  const decimals = Number.isInteger(maxDecimals) && maxDecimals >= 0 ? Math.min(maxDecimals, 10) : 6;
  return value.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: decimals });
}
