/**
 * Same-origin static live-offers snapshot loader and defense-in-depth validator
 * for `./data/offers.json`.
 *
 * Pure ES module with zero external dependencies. Runs identically in modern
 * browsers and Node.js.
 *
 * Security invariants:
 * - Strictly same-origin (`isSameOriginPath` on `'self'`); zero third-party requests.
 * - Fails closed on >1 MB payload, UTF-8 BOM, invalid JSON, wrong schema version,
 *   malformed or >5 min future `generated_at`, or >6 h expired `generated_at`.
 * - Re-validates EVERY offer entry independently via `decodeInvite()` and
 *   `requirePinnedContract()` (ignoring any untrusted numeric, network, contract,
 *   URI, or Bob-address metadata in `offers.json`).
 * - Independently drops expired offers, recomputes maker liveness buckets against
 *   local `nowMs`, and recomputes duplicate/copied payload and repeated Bob address
 *   warnings across all valid entries.
 */

import {
  CODE_PREFIX,
  NETWORK_SPECS,
  decodeInvite,
  requirePinnedContract,
  sanitizeDisplayText,
} from "./invite-codec.js";
import { isSameOriginPath, parseUtcIsoStrict } from "./market-data.js";

export const OFFERS_SNAPSHOT_URL = "./data/offers.json";
export const MAX_OFFERS_BYTES = 1_048_576; // 1 MB
export const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000; // 5 minutes
export const STALE_AFTER_MS = 30 * 60 * 1000; // 30 minutes
export const EXPIRE_AFTER_MS = 6 * 60 * 60 * 1000; // 6 hours
export const LIVENESS_ONLINE_MS = 15 * 60 * 1000; // 15 minutes
export const LIVENESS_RECENT_MS = 2 * 60 * 60 * 1000; // 2 hours
export const MAX_OFFERS_COUNT = 200;
export const MAX_RELAYS_REPORTED = 32;
export const MAX_OFFER_RELAYS = 8;

const HEX32_RE = /^[0-9a-f]{32}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const ZERO_ETH_ADDR_RE = /^0x0{40}$/;
const SAFE_RELAY_DISPLAY_RE = /^wss?:\/\/[A-Za-z0-9.:/_-]+$/;
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER_FATAL = new TextDecoder("utf-8", { fatal: true });

const isPlainObject = (v) =>
  v !== null &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  Object.getPrototypeOf(v) === Object.prototype;

const utf8ByteLength = (str) => TEXT_ENCODER.encode(str).length;

// Shared in-memory offers snapshot store
let currentOffersSnapshot = null;
const offersSnapshotListeners = new Set();

export function getCurrentOffersSnapshot() {
  return currentOffersSnapshot;
}

export function setCurrentOffersSnapshot(snapshot) {
  currentOffersSnapshot = snapshot || null;
  for (const fn of offersSnapshotListeners) {
    try {
      fn(currentOffersSnapshot);
    } catch {
      /* listener errors do not break other subscribers */
    }
  }
}

export function onOffersSnapshotChange(listener) {
  if (typeof listener !== "function") return () => {};
  offersSnapshotListeners.add(listener);
  return () => {
    offersSnapshotListeners.delete(listener);
  };
}

/**
 * Formats a 64-hex Nostr x-only public key cleanly as `abcd1234…ef567890`.
 * @param {string} pubkey
 * @returns {string}
 */
export function formatPubkeyShort(pubkey) {
  if (typeof pubkey !== "string" || !HEX64_RE.test(pubkey)) return "—";
  return `${pubkey.slice(0, 8)}…${pubkey.slice(-8)}`;
}

/**
 * Computes the maker liveness bucket from `lastSeenMs` against `nowMs`:
 * - `online`: `<= 15 min`
 * - `recent`: `> 15 min` and `<= 2 h`
 * - `stale`: `> 2 h`
 * @param {number} lastSeenMs
 * @param {number} nowMs
 * @returns {"online"|"recent"|"stale"}
 */
export function computeLivenessBucket(lastSeenMs, nowMs) {
  if (
    typeof lastSeenMs !== "number" ||
    !Number.isFinite(lastSeenMs) ||
    typeof nowMs !== "number" ||
    !Number.isFinite(nowMs)
  ) {
    return "stale";
  }
  const ageMs = Math.max(0, nowMs - lastSeenMs);
  if (ageMs <= LIVENESS_ONLINE_MS) return "online";
  if (ageMs <= LIVENESS_RECENT_MS) return "recent";
  return "stale";
}

function parseUtcWithinSkew(str, nowMs) {
  const parsed = parseUtcIsoStrict(str);
  if (!parsed) return null;
  if (parsed.ms > nowMs + MAX_FUTURE_SKEW_MS) return null;
  return parsed;
}

function sanitizeRelayList(rawList, maxItems) {
  if (!Array.isArray(rawList)) return [];
  const out = [];
  const seen = new Set();
  for (const item of rawList) {
    if (out.length >= maxItems) break;
    if (typeof item !== "string" || item.length === 0 || item.length > 256) continue;
    const clean = item.trim();
    if (!SAFE_RELAY_DISPLAY_RE.test(clean)) continue;
    if (!seen.has(clean)) {
      seen.add(clean);
      out.push(clean);
    }
  }
  return out;
}

function failOffersSnapshot(error) {
  return {
    ok: false,
    v: 1,
    isSample: false,
    freshness: "unavailable",
    status: "unavailable",
    statusLabel: "Live offers unavailable",
    offersVisible: false,
    isStale: false,
    isExpired: false,
    generatedAtUtc: null,
    generatedAtMs: null,
    ageMs: null,
    minPowBits: 0,
    relays: Object.freeze([]),
    offers: Object.freeze([]),
    droppedCount: 0,
    error,
  };
}

function countLeadingZeroBitsHex(hex) {
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

/**
 * Validates and decodes a single raw entry from `offers.json` strictly from
 * `entry.code` via `decodeInvite()` + `requirePinnedContract()`.
 * Ignores any untrusted swap term metadata (amounts, network, addresses, URIs).
 */
function validateOfferEntry(entry, nowMs, minPowBits) {
  if (!isPlainObject(entry)) return null;

  if (typeof entry.event_id !== "string" || !HEX64_RE.test(entry.event_id)) return null;
  if (typeof entry.d !== "string" || !HEX32_RE.test(entry.d)) return null;
  if (typeof entry.pubkey !== "string" || !HEX64_RE.test(entry.pubkey)) return null;

  const created = parseUtcWithinSkew(entry.created_at, nowMs);
  if (!created) return null;

  const expires = parseUtcIsoStrict(entry.expires_at);
  if (!expires) return null;
  if (expires.ms <= nowMs || expires.ms <= created.ms) return null;

  if (
    typeof entry.pow_bits !== "number" ||
    !Number.isInteger(entry.pow_bits) ||
    entry.pow_bits < 0 ||
    entry.pow_bits > 256 ||
    entry.pow_bits < minPowBits
  ) {
    return null;
  }
  if (countLeadingZeroBitsHex(entry.event_id) < entry.pow_bits) {
    return null;
  }

  // Strictly require compact `no1dinv1:` wire code (never raw JSON)
  if (typeof entry.code !== "string") return null;
  const trimmedCode = entry.code.trim();
  if (!trimmedCode.startsWith(CODE_PREFIX)) return null;

  const decoded = decodeInvite(trimmedCode);
  if (!decoded.ok) return null;
  const pinnedCheck = requirePinnedContract(decoded);
  if (!pinnedCheck.ok || decoded.contractPinned !== true) return null;

  const bobEthLower = decoded.fields.bob_eth.toLowerCase();
  if (bobEthLower === decoded.fields.contract.toLowerCase() || ZERO_ETH_ADDR_RE.test(bobEthLower)) {
    return null;
  }

  // Explicit defense-in-depth cap & contract version verification
  const spec = NETWORK_SPECS[decoded.fields.network];
  if (!spec) return null;
  const noidMicro = BigInt(decoded.fields.noid_micronoid);
  const ethWei = BigInt(decoded.fields.eth_wei);
  if (noidMicro <= 0n || noidMicro > spec.maxNoidMicro) return null;
  if (ethWei <= 0n || ethWei > spec.maxEthWei) return null;
  const contractVer = Number(decoded.fields.contract_version);
  if (!spec.allowedContractVersions.includes(contractVer)) return null;

  const note = typeof entry.note === "string" ? sanitizeDisplayText(entry.note, 140) : "";

  // Recompute maker liveness independently against `nowMs`.
  // "online" is granted ONLY when a signed heartbeat (`has_heartbeat === true`)
  // is within 15 min — never purely from an offer's self-declared `created_at`.
  let lastSeenMs = created.ms;
  let lastSeenUtc = created.iso;
  let hasHeartbeat = false;
  let heartbeatMs = null;
  if (isPlainObject(entry.liveness)) {
    const parsedLast = parseUtcWithinSkew(entry.liveness.last_seen_at, nowMs);
    if (entry.liveness.has_heartbeat === true && parsedLast) {
      hasHeartbeat = true;
      heartbeatMs = Math.min(parsedLast.ms, nowMs);
      if (parsedLast.ms >= created.ms) {
        lastSeenMs = parsedLast.ms;
        lastSeenUtc = parsedLast.iso;
      }
    } else if (parsedLast && parsedLast.ms >= created.ms) {
      lastSeenMs = parsedLast.ms;
      lastSeenUtc = parsedLast.iso;
    }
  }
  const clampedLastSeenMs = Math.min(lastSeenMs, nowMs);
  let livenessStatus;
  if (hasHeartbeat && heartbeatMs !== null && computeLivenessBucket(heartbeatMs, nowMs) === "online") {
    livenessStatus = "online";
  } else {
    const bucket = computeLivenessBucket(clampedLastSeenMs, nowMs);
    livenessStatus = bucket === "online" ? "recent" : bucket;
  }

  const relays = sanitizeRelayList(entry.relays, MAX_OFFER_RELAYS);

  return {
    eventId: entry.event_id,
    d: entry.d,
    pubkey: entry.pubkey,
    pubkeyShort: formatPubkeyShort(entry.pubkey),
    createdAtUtc: created.iso,
    createdAtMs: created.ms,
    expiresAtUtc: expires.iso,
    expiresAtMs: expires.ms,
    powBits: entry.pow_bits,
    code: decoded.canonicalCode,
    note,
    liveness: Object.freeze({
      status: livenessStatus,
      lastSeenAtUtc: lastSeenUtc,
      lastSeenAtMs: clampedLastSeenMs,
      hasHeartbeat,
    }),
    relays: Object.freeze(relays),
    decoded,
  };
}

/**
 * Parses and independently validates a raw `./data/offers.json` string or object.
 * Fails closed on >1 MB, invalid JSON, BOM, bad schema version, future >5 min
 * `generated_at`, or expired >6 h `generated_at`.
 *
 * @param {string|object} raw
 * @param {number} [nowMs=Date.now()]
 */
export function parseOffersSnapshot(raw, nowMs = Date.now()) {
  const now = typeof nowMs === "number" && Number.isFinite(nowMs) ? Math.floor(nowMs) : Date.now();
  let obj = raw;
  if (typeof raw === "string") {
    if (utf8ByteLength(raw) > MAX_OFFERS_BYTES) {
      return failOffersSnapshot(`Offers snapshot exceeds the ${MAX_OFFERS_BYTES}-byte limit.`);
    }
    if (raw.charCodeAt(0) === 0xfeff) {
      return failOffersSnapshot("Offers snapshot must not start with a byte order mark.");
    }
    try {
      obj = JSON.parse(raw);
    } catch {
      return failOffersSnapshot("Offers snapshot is not valid JSON.");
    }
  }
  if (!isPlainObject(obj)) {
    return failOffersSnapshot("Offers snapshot must be a JSON object.");
  }
  if (obj.v !== 1) {
    return failOffersSnapshot("Unsupported offers snapshot schema version.");
  }

  const gen = parseUtcWithinSkew(obj.generated_at, now);
  if (!gen) {
    return failOffersSnapshot(
      "Offers snapshot generated_at must be a valid UTC ISO-8601 timestamp not more than 5 min ahead.",
    );
  }

  if (!Array.isArray(obj.offers)) {
    return failOffersSnapshot("Offers snapshot offers field must be an array.");
  }

  let minPowBits = 0;
  if (obj.min_pow_bits !== undefined) {
    if (
      typeof obj.min_pow_bits !== "number" ||
      !Number.isInteger(obj.min_pow_bits) ||
      obj.min_pow_bits < 0 ||
      obj.min_pow_bits > 256
    ) {
      return failOffersSnapshot("Offers snapshot min_pow_bits must be an integer in 0..256.");
    }
    minPowBits = obj.min_pow_bits;
  }

  if (obj.sample !== undefined && typeof obj.sample !== "boolean") {
    return failOffersSnapshot("Offers snapshot sample field must be a boolean when provided.");
  }
  const isSample = obj.sample === true;

  // Parse optional relay health summary (strictly bounded & sanitized)
  const relays = [];
  if (obj.relays !== undefined) {
    if (!Array.isArray(obj.relays)) {
      return failOffersSnapshot("Offers snapshot relays field must be an array when provided.");
    }
    for (const r of obj.relays.slice(0, MAX_RELAYS_REPORTED)) {
      if (!isPlainObject(r)) continue;
      if (typeof r.url !== "string" || r.url.length === 0 || r.url.length > 256) continue;
      const cleanUrl = r.url.trim();
      if (!SAFE_RELAY_DISPLAY_RE.test(cleanUrl)) continue;
      if (r.truncated !== undefined && typeof r.truncated !== "boolean") continue;
      relays.push(
        Object.freeze({
          url: cleanUrl,
          ok: r.ok === true,
          eventsReceived:
            Number.isInteger(r.events_received) && r.events_received >= 0 ? r.events_received : 0,
          eventsAccepted:
            Number.isInteger(r.events_accepted) && r.events_accepted >= 0 ? r.events_accepted : 0,
          truncated: r.truncated === true,
        }),
      );
    }
  }

  const ageMs = Math.max(0, now - gen.ms);
  const isExpired = ageMs > EXPIRE_AFTER_MS;
  const isStale = ageMs > STALE_AFTER_MS;

  if (isSample) {
    return {
      ok: true,
      v: 1,
      isSample: true,
      freshness: isExpired ? "expired" : isStale ? "stale" : "fresh",
      status: "sample",
      statusLabel: "Sample / empty default",
      offersVisible: false,
      isStale,
      isExpired,
      generatedAtUtc: gen.iso,
      generatedAtMs: gen.ms,
      ageMs,
      minPowBits,
      relays: Object.freeze(relays),
      offers: Object.freeze([]),
      droppedCount: obj.offers.length,
    };
  }

  if (isExpired) {
    return {
      ok: true,
      v: 1,
      isSample,
      freshness: "expired",
      status: "expired",
      statusLabel: "Offers unavailable (older than 6 h)",
      offersVisible: false,
      isStale: true,
      isExpired: true,
      generatedAtUtc: gen.iso,
      generatedAtMs: gen.ms,
      ageMs,
      minPowBits,
      relays: Object.freeze(relays),
      offers: Object.freeze([]),
      droppedCount: obj.offers.length,
    };
  }

  // Defense-in-depth: validate every offer entry, deduplicate by (pubkey, d) and event_id
  const latestByAddr = new Map();
  const seenEventIds = new Set();
  let droppedCount = 0;

  const limit = Math.min(obj.offers.length, MAX_OFFERS_COUNT);
  if (obj.offers.length > MAX_OFFERS_COUNT) {
    droppedCount += obj.offers.length - MAX_OFFERS_COUNT;
  }

  for (let i = 0; i < limit; i++) {
    const validated = validateOfferEntry(obj.offers[i], now, minPowBits);
    if (!validated) {
      droppedCount++;
      continue;
    }
    if (seenEventIds.has(validated.eventId)) {
      droppedCount++;
      continue;
    }
    seenEventIds.add(validated.eventId);

    const addrKey = `${validated.pubkey}:${validated.d}`;
    const prev = latestByAddr.get(addrKey);
    if (
      !prev ||
      validated.createdAtMs > prev.createdAtMs ||
      (validated.createdAtMs === prev.createdAtMs && validated.eventId < prev.eventId)
    ) {
      if (prev) droppedCount++;
      latestByAddr.set(addrKey, validated);
    } else {
      droppedCount++;
    }
  }

  const validOffers = [...latestByAddr.values()];

  // Independently compute duplicate/copied payload & repeated Bob address flags
  const byCode = new Map();
  const bobNoidCounts = new Map();
  const bobEthCounts = new Map();

  for (const offer of validOffers) {
    const c = offer.decoded.canonicalCode;
    let group = byCode.get(c);
    if (!group) {
      group = [];
      byCode.set(c, group);
    }
    group.push(offer);

    const bn = offer.decoded.fields.bob_noid;
    const be = offer.decoded.fields.bob_eth.toLowerCase();
    bobNoidCounts.set(bn, (bobNoidCounts.get(bn) || 0) + 1);
    bobEthCounts.set(be, (bobEthCounts.get(be) || 0) + 1);
  }

  const codeMeta = new Map();
  for (const [code, group] of byCode.entries()) {
    const pubkeys = new Set(group.map((g) => g.pubkey));
    codeMeta.set(code, {
      count: group.length,
      distinctPubkeys: pubkeys.size,
      duplicateAcrossPubkeys: pubkeys.size > 1,
    });
  }

  const enriched = validOffers.map((offer) => {
    const meta = codeMeta.get(offer.decoded.canonicalCode);
    const duplicatePayload = meta.count > 1;
    const bn = offer.decoded.fields.bob_noid;
    const be = offer.decoded.fields.bob_eth.toLowerCase();
    const repeatedBobAddress =
      (bobNoidCounts.get(bn) || 0) > 1 || (bobEthCounts.get(be) || 0) > 1;

    return Object.freeze({
      ...offer,
      flags: Object.freeze({
        duplicatePayload,
        duplicateCount: meta.count,
        distinctPubkeys: meta.distinctPubkeys,
        duplicateAcrossPubkeys: meta.duplicateAcrossPubkeys,
        repeatedBobAddress,
      }),
    });
  });

  // Neutral ordering: newest created_at first, tie-break by eventId ascending (never ranked by price)
  enriched.sort((a, b) => {
    if (b.createdAtMs !== a.createdAtMs) return b.createdAtMs - a.createdAtMs;
    return a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0;
  });

  const freshness = isStale ? "stale" : "fresh";
  let status = freshness;
  let statusLabel = "Live Nostr snapshot";
  if (isSample) {
    status = "sample";
    statusLabel = "Sample / empty default";
  } else if (isStale) {
    status = "stale";
    statusLabel = "Stale snapshot";
  }

  return {
    ok: true,
    v: 1,
    isSample,
    freshness,
    status,
    statusLabel,
    offersVisible: true,
    isStale,
    isExpired: false,
    generatedAtUtc: gen.iso,
    generatedAtMs: gen.ms,
    ageMs,
    minPowBits,
    relays: Object.freeze(relays),
    offers: Object.freeze(enriched),
    droppedCount,
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
          return { ok: false, error: `Offers snapshot exceeds the ${maxBytes}-byte limit.` };
        }
        chunks.push(bytes);
      }
    } catch {
      return { ok: false, error: "Could not read offers snapshot stream." };
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
      return { ok: false, error: "Offers snapshot is not valid UTF-8 text." };
    }
  }
  try {
    const text = await response.text();
    if (utf8ByteLength(text) > maxBytes) {
      return { ok: false, error: `Offers snapshot exceeds the ${maxBytes}-byte limit.` };
    }
    return { ok: true, text };
  } catch {
    return { ok: false, error: "Could not read offers snapshot text." };
  }
}

/**
 * Fetches and validates the same-origin static offers snapshot (`./data/offers.json`).
 * Refuses any non-same-origin URL before calling `fetchImpl`, enforces the 1 MB cap,
 * and fails closed cleanly on any error.
 *
 * @param {string} [url="./data/offers.json"]
 * @param {typeof fetch} [fetchImpl]
 * @param {number} [nowMs]
 */
export async function loadSameOriginOffersSnapshot(
  url = OFFERS_SNAPSHOT_URL,
  fetchImpl = globalThis.fetch,
  nowMs = Date.now(),
) {
  if (!isSameOriginPath(url)) {
    return failOffersSnapshot("Refused non-same-origin offers snapshot URL.");
  }
  if (typeof fetchImpl !== "function") {
    return failOffersSnapshot("Fetch API is unavailable in this environment.");
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
    return failOffersSnapshot("Could not fetch same-origin offers snapshot.");
  }
  if (!response || !response.ok) {
    return failOffersSnapshot("Same-origin offers snapshot returned an error status.");
  }
  const declaredLen =
    response.headers && typeof response.headers.get === "function"
      ? Number(response.headers.get("content-length"))
      : NaN;
  if (Number.isFinite(declaredLen) && declaredLen > MAX_OFFERS_BYTES) {
    return failOffersSnapshot(`Offers snapshot exceeds the ${MAX_OFFERS_BYTES}-byte limit.`);
  }
  const read = await readResponseTextBounded(response, MAX_OFFERS_BYTES);
  if (!read.ok) return failOffersSnapshot(read.error);
  return parseOffersSnapshot(read.text, nowMs);
}
