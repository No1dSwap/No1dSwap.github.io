#!/usr/bin/env node
/**
 * Host Nostr offer-discovery updater for the No1d Swap public bulletin board.
 *
 * Pure Node.js ESM with zero external dependencies. Runs strictly out-of-band
 * (e.g. a 10-minute host cron or GitHub Actions job — NEVER in the browser)
 * and atomically writes ONLY `./data/offers.json` so visitors' browsers stay
 * strictly `connect-src 'self'`.
 *
 * Trust model:
 * - Every relay and every event is treated as hostile untrusted input.
 * - Verifies NIP-01 canonical SHA-256 `id`, BIP-340 Schnorr signature over
 *   secp256k1, NIP-13 proof-of-work commitment, NIP-40 expiration, <= 5 min
 *   future clock skew, and `no1dinv1:` invitation decoding via `decodeInvite()`.
 * - Refuses any offer whose HTLC contract is not pinned, exceeds network caps
 *   (0.5 ETH / 2,500 NOID mainnet; 0.01 ETH / 20 NOID Sepolia), or uses a
 *   disallowed contract version.
 * - Tracks signed maker liveness heartbeats (kind 32872) and flags duplicate /
 *   copied `canonicalCode` payloads across pubkeys plus repeated Bob addresses.
 * - Enforces a 10-minute rate limit based on existing `offers.json`'s
 *   `generated_at` (ignoring malformed or >5 min future timestamps; `--force`
 *   only for tests or explicit CLI override).
 * - If all relays fail, exits non-zero and leaves any existing `offers.json`
 *   byte-for-byte untouched.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  CODE_PREFIX,
  NETWORK_SPECS,
  decodeInvite,
  requirePinnedContract,
  sanitizeDisplayText,
} from "../js/invite-codec.js";
import { parseUtcIsoStrict } from "../js/market-data.js";
import {
  MAX_FUTURE_SKEW_MS,
  MAX_OFFERS_BYTES,
  MAX_OFFERS_COUNT,
  MAX_OFFER_RELAYS,
  MAX_RELAYS_REPORTED,
  computeLivenessBucket,
  parseOffersSnapshot,
} from "../js/offers-data.js";
import {
  NOSTR_KINDS,
  checkNip13Pow,
  isHex128,
  isHex64,
  nostrEventShapeProblem,
  oneExactTag,
  tagsNamed,
  verifyNostrEvent,
} from "./nostr-crypto.mjs";

export const PUBLIC_WEB_BOARD_TAG = "no1d-swap-web-v1";
export const OFFER_KIND = NOSTR_KINDS.OFFER; // 32871 (addressable)
export const HEARTBEAT_KIND = NOSTR_KINDS.HEARTBEAT; // 32872 (addressable)
export const DELETION_KIND = NOSTR_KINDS.DELETION; // 5 (NIP-09)

export const OFFER_STATUSES = Object.freeze(["open", "taken", "closed"]);
export const HEARTBEAT_STATUSES = Object.freeze(["online", "paused", "offline"]);
export const ALLOWED_NETWORKS = Object.freeze(["mainnet", "sepolia"]);

export const RATE_LIMIT_MS = 10 * 60 * 1000; // 10 minutes
export const RELAY_TIMEOUT_MS = 10_000; // 10 seconds per relay
export const MAX_RELAY_BYTES = MAX_OFFERS_BYTES; // 1 MB cumulative per relay
export const MAX_FRAME_BYTES = 262_144; // 256 KB per WebSocket frame
export const MAX_EVENT_BYTES = 65_536; // 64 KB per event JSON
export const MAX_EVENTS_PER_RELAY = 500;
export const MAX_FRAMES_PER_RELAY = MAX_EVENTS_PER_RELAY * 4; // 2,000 total frames per relay
export const MAX_VIOLATIONS_PER_RELAY = 5;
export const MAX_OFFER_PAGES = 3; // bounded `until` pagination passes for offers
export const MAX_AUTHORS_PER_QUERY = 200; // chunk size for author-scoped follow-up queries
export const DEFAULT_MIN_POW_BITS = 16;
export const MAX_FUTURE_SKEW_SECONDS = Math.floor(MAX_FUTURE_SKEW_MS / 1000); // 300 s
export const DEFAULT_MAX_EXPIRY_SECONDS = 24 * 60 * 60; // 24 h
export const DEFAULT_MAX_OFFER_AGE_SECONDS = 24 * 60 * 60; // 24 h
export const DEFAULT_MAX_HEARTBEAT_AGE_SECONDS = 6 * 60 * 60; // 6 h

export const DEFAULT_RELAYS = Object.freeze([
  "wss://nos.lol",
  "wss://relay.primal.net",
  "wss://relay.snort.social",
]);

const HEX32_RE = /^[0-9a-f]{32}$/;
const ZERO_ETH_ADDR_RE = /^0x0{40}$/;
const EXPIRY_RE = /^\d{1,12}$/;
const DNS_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const BLOCKED_RELAY_SUFFIXES = Object.freeze([
  "localhost",
  "local",
  "internal",
  "lan",
  "home",
  "corp",
  "intranet",
  "private",
  "test",
  "example",
  "invalid",
  "onion",
  "arpa",
  "localdomain",
  "home.arpa",
]);

const isPlainObject = (v) =>
  v !== null &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  Object.getPrototypeOf(v) === Object.prototype;

const VERIFIED_EVENT_TUPLE = new WeakMap();

/**
 * Returns an injective canonical tuple string for a strictly 7-key plain Nostr event
 * (or null if types/shape do not match). Used only to avoid redundant BIP-340 Schnorr
 * re-verification on identical already-verified events across relays while still
 * rejecting any forged/mutated event sharing the same `ev.id`.
 */
function canonicalVerifiedTuple(ev) {
  if (!isPlainObject(ev)) return null;
  if (Object.keys(ev).length !== 7) return null;
  if (
    typeof ev.id !== "string" ||
    typeof ev.pubkey !== "string" ||
    typeof ev.created_at !== "number" ||
    typeof ev.kind !== "number" ||
    typeof ev.content !== "string" ||
    typeof ev.sig !== "string" ||
    !Array.isArray(ev.tags)
  ) {
    return null;
  }
  for (const tag of ev.tags) {
    if (!Array.isArray(tag)) return null;
    for (const item of tag) {
      if (typeof item !== "string") return null;
    }
  }
  return JSON.stringify([ev.id, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content, ev.sig]);
}

function verifyEventFast(ev, verifiedById = null) {
  const tuple = canonicalVerifiedTuple(ev);
  if (tuple !== null) {
    const cachedSelf = VERIFIED_EVENT_TUPLE.get(ev);
    if (cachedSelf !== undefined && cachedSelf === tuple) {
      if (verifiedById && !verifiedById.has(ev.id)) verifiedById.set(ev.id, tuple);
      return true;
    }
    if (verifiedById && verifiedById.get(ev.id) === tuple) {
      VERIFIED_EVENT_TUPLE.set(ev, tuple);
      return true;
    }
  }
  if (!verifyNostrEvent(ev)) return false;
  if (tuple !== null) {
    VERIFIED_EVENT_TUPLE.set(ev, tuple);
    if (verifiedById) verifiedById.set(ev.id, tuple);
  }
  return true;
}

function toUtcIso(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

// ---------------------------------------------------------------------------
// Relay URL normalization (parity with desktop board/relay.js)
// ---------------------------------------------------------------------------

/**
 * Validates and normalizes a Nostr relay URL.
 * Accepts `wss://` with a public DNS host name only (no IP literals, no credentials,
 * no query/fragment, no local/internal suffixes). `ws://127.0.0.1[:port]` is allowed
 * ONLY when `allowLocalTest: true` is explicitly passed in code/CLI.
 */
export function normalizeRelayUrl(input, { allowLocalTest = false } = {}) {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input.length > 256 ||
    !/^[\x21-\x7e]+$/.test(input)
  ) {
    return { ok: false, reason: "not a plain ASCII URL" };
  }
  let u;
  try {
    u = new URL(input);
  } catch {
    return { ok: false, reason: "malformed URL" };
  }
  if (u.username || u.password) return { ok: false, reason: "credentials in URL" };
  if (u.search || u.hash) return { ok: false, reason: "query or fragment in URL" };
  if (u.port !== "" && !(Number(u.port) >= 1 && Number(u.port) <= 65535)) {
    return { ok: false, reason: "invalid port" };
  }
  if (!/^\/[A-Za-z0-9._~/-]*$/.test(u.pathname)) {
    return { ok: false, reason: "unusual path" };
  }
  const cleanPath = u.pathname === "/" ? "" : u.pathname.replace(/\/+$/, "");
  const host = u.hostname.toLowerCase();

  if (u.protocol === "ws:") {
    if (allowLocalTest && host === "127.0.0.1") {
      return {
        ok: true,
        url: `ws://127.0.0.1${u.port ? ":" + u.port : ""}${cleanPath}`,
      };
    }
    return { ok: false, reason: "only wss:// is accepted" };
  }
  if (u.protocol !== "wss:") return { ok: false, reason: "only wss:// is accepted" };
  if (host.length > 253 || host.startsWith("[") || host.endsWith(".")) {
    return { ok: false, reason: "not a public host name" };
  }
  const labels = host.split(".");
  if (labels.length < 2 || !labels.every((l) => DNS_LABEL_RE.test(l))) {
    return { ok: false, reason: "not a public host name" };
  }
  const tld = labels[labels.length - 1];
  if (!(/^[a-z]{2,63}$/.test(tld) || /^xn--[a-z0-9-]{2,59}$/.test(tld))) {
    return { ok: false, reason: "not a public host name" };
  }
  if (BLOCKED_RELAY_SUFFIXES.some((s) => host === s || host.endsWith("." + s))) {
    return { ok: false, reason: "non-public host suffix" };
  }
  return {
    ok: true,
    url: `wss://${host}${u.port ? ":" + u.port : ""}${cleanPath}`,
  };
}

// ---------------------------------------------------------------------------
// NIP-01 subscription filter matching (defense against off-filter relay spam)
// ---------------------------------------------------------------------------

export function matchesFilter(ev, filter) {
  if (!filter || typeof filter !== "object") return false;
  if (filter.ids && !filter.ids.includes(ev.id)) return false;
  if (filter.authors && !filter.authors.includes(ev.pubkey)) return false;
  if (filter.kinds && !filter.kinds.includes(ev.kind)) return false;
  if (typeof filter.since === "number" && ev.created_at < filter.since) return false;
  if (typeof filter.until === "number" && ev.created_at > filter.until) return false;
  for (const key of Object.keys(filter)) {
    if (key.length === 2 && key[0] === "#") {
      const want = filter[key];
      if (!Array.isArray(want) || !ev.tags.some((t) => t[0] === key[1] && want.includes(t[1]))) {
        return false;
      }
    }
  }
  return true;
}

function matchesAnyFilter(ev, filters) {
  return filters.some((f) => matchesFilter(ev, f));
}

// ---------------------------------------------------------------------------
// Bounded single-relay WebSocket query (injectable WebSocketImpl for tests)
// ---------------------------------------------------------------------------

export function buildOfferFilter({
  nowSec,
  boardTag = PUBLIC_WEB_BOARD_TAG,
  maxOfferAgeSeconds = DEFAULT_MAX_OFFER_AGE_SECONDS,
  maxEventsPerRelay = MAX_EVENTS_PER_RELAY,
  until = undefined,
}) {
  const offerSince = Math.max(0, nowSec - maxOfferAgeSeconds - MAX_FUTURE_SKEW_SECONDS);
  const filter = {
    kinds: [OFFER_KIND],
    "#t": [boardTag],
    since: offerSince,
    limit: maxEventsPerRelay,
  };
  if (typeof until === "number" && Number.isSafeInteger(until) && until >= offerSince) {
    filter.until = until;
  }
  return [filter];
}

export function buildAuthorFollowupFilters({
  nowSec,
  authors,
  boardTag = PUBLIC_WEB_BOARD_TAG,
  maxOfferAgeSeconds = DEFAULT_MAX_OFFER_AGE_SECONDS,
  maxHeartbeatAgeSeconds = DEFAULT_MAX_HEARTBEAT_AGE_SECONDS,
  maxEventsPerRelay = MAX_EVENTS_PER_RELAY,
}) {
  const offerSince = Math.max(0, nowSec - maxOfferAgeSeconds - MAX_FUTURE_SKEW_SECONDS);
  const hbSince = Math.max(0, nowSec - maxHeartbeatAgeSeconds - MAX_FUTURE_SKEW_SECONDS);
  return [
    {
      kinds: [HEARTBEAT_KIND],
      authors,
      "#t": [boardTag],
      since: hbSince,
      limit: maxEventsPerRelay,
    },
    {
      kinds: [DELETION_KIND],
      authors,
      "#k": [String(OFFER_KIND)],
      since: offerSince,
      limit: maxEventsPerRelay,
    },
  ];
}

export function buildBoardFilters({
  nowSec,
  boardTag = PUBLIC_WEB_BOARD_TAG,
  maxOfferAgeSeconds = DEFAULT_MAX_OFFER_AGE_SECONDS,
  maxHeartbeatAgeSeconds = DEFAULT_MAX_HEARTBEAT_AGE_SECONDS,
  maxEventsPerRelay = MAX_EVENTS_PER_RELAY,
}) {
  const offerSince = Math.max(0, nowSec - maxOfferAgeSeconds - MAX_FUTURE_SKEW_SECONDS);
  const hbSince = Math.max(0, nowSec - maxHeartbeatAgeSeconds - MAX_FUTURE_SKEW_SECONDS);
  return [
    { kinds: [OFFER_KIND], "#t": [boardTag], since: offerSince, limit: maxEventsPerRelay },
    { kinds: [HEARTBEAT_KIND], "#t": [boardTag], since: hbSince, limit: maxEventsPerRelay },
    { kinds: [DELETION_KIND], "#k": [String(OFFER_KIND)], since: offerSince, limit: maxEventsPerRelay },
  ];
}

/**
 * Configures Node's built-in undici WebSocket client (when used) to bound frame
 * allocation inside the byte-stream parser (`maxPayloadSize`, `maxFragments`)
 * before large or decompressed frames are assembled in JS memory.
 * Returns `{ init, dispose }` or `{ init: null, dispose: null }` for custom mocks.
 */
function createBoundedWsInit(WebSocketImpl, maxFrameBytes) {
  if (WebSocketImpl !== globalThis.WebSocket) {
    return { init: null, dispose: null };
  }
  let dispatcher = null;
  try {
    const base = globalThis[Symbol.for("undici.globalDispatcher.1")];
    if (base && typeof base.constructor === "function") {
      const candidate = new base.constructor({
        webSocket: {
          maxPayloadSize: maxFrameBytes,
          maxFragments: 64,
        },
      });
      if (
        candidate &&
        candidate.webSocketOptions &&
        candidate.webSocketOptions.maxPayloadSize === maxFrameBytes
      ) {
        dispatcher = candidate;
      } else if (candidate && typeof candidate.close === "function") {
        candidate.close().catch(() => {});
      }
    }
  } catch {
    /* Older Node runtimes without Agent({ webSocket }) still enforce the JS cap */
  }
  if (!dispatcher) return { init: null, dispose: null };
  const dispose = () => {
    try {
      if (typeof dispatcher.close === "function") {
        dispatcher.close().catch(() => {});
      }
    } catch {
      /* ignore dispatcher teardown error */
    }
  };
  return { init: { dispatcher }, dispose };
}

/**
 * Connects to a single normalized Nostr relay URL, sends one `REQ` with bounded
 * filters, verifies every incoming event (NIP-01 id + BIP-340 Schnorr + filter
 * match), enforces independent per-filter event budgets plus byte/frame/timeout
 * caps, and tears down the socket cleanly.
 *
 * Policy vs protocol separation:
 * - Poster-side policy failures (oversize event/text frame, invalid shape,
 *   off-filter event, low PoW) are dropped silently without incrementing
 *   `violations`, so no poster can force healthy relays to fail.
 * - Relay-protocol faults (non-text binary frame, invalid JSON, malformed
 *   message array, invalid NIP-01 id or forged BIP-340 sig) increment
 *   `violations` and terminate with `ok: false`.
 * - Byte, frame, and per-filter event cap hits close cleanly as `ok: true,
 *   truncated: true` so already-verified events remain usable.
 */
export async function queryRelay(
  relayUrl,
  filters,
  {
    WebSocketImpl = globalThis.WebSocket,
    timeoutMs = RELAY_TIMEOUT_MS,
    maxTotalBytes = MAX_RELAY_BYTES,
    maxFrameBytes = MAX_FRAME_BYTES,
    maxEventBytes = MAX_EVENT_BYTES,
    maxEvents = MAX_EVENTS_PER_RELAY,
    maxFrames = Math.max(maxEvents * 4, MAX_FRAMES_PER_RELAY),
    maxViolations = MAX_VIOLATIONS_PER_RELAY,
    minPowBits = 0,
    verifiedById = null,
  } = {},
) {
  if (typeof WebSocketImpl !== "function") {
    return {
      url: relayUrl,
      ok: false,
      reason: "no WebSocket implementation available",
      events: [],
      eventsReceived: 0,
      bytesReceived: 0,
      violations: 0,
      droppedPolicy: 0,
      rawFilterMatches: 0,
      oldestFilterCreatedAt: null,
      truncated: false,
      eose: false,
    };
  }

  const subId = `no1d_${crypto.randomBytes(6).toString("hex")}`;
  const filterList = Array.isArray(filters) ? filters : [];
  const keptByFilter = new Array(filterList.length).fill(0);

  return new Promise((resolve) => {
    let ws = null;
    let disposeDispatcher = null;
    let boundedParser = false;
    let settled = false;
    let opened = false;
    let eose = false;
    let truncated = false;
    let bytesReceived = 0;
    let framesReceived = 0;
    let eventsReceived = 0;
    let violations = 0;
    let droppedPolicy = 0;
    let rawFilterMatches = 0;
    let oldestFilterCreatedAt = null;
    const events = [];
    const seenIds = new Set();

    const cleanup = () => {
      clearTimeout(timer);
      if (ws) {
        const sock = ws;
        ws = null;
        sock.onopen = null;
        sock.onmessage = null;
        sock.onerror = null;
        sock.onclose = null;
        try {
          if (opened && typeof sock.send === "function") {
            try {
              sock.send(JSON.stringify(["CLOSE", subId]));
            } catch {
              /* ignore close frame failure */
            }
          }
          if (typeof sock.close === "function") {
            sock.close();
          }
        } catch {
          /* ignore teardown error */
        }
      }
      if (disposeDispatcher) {
        const fn = disposeDispatcher;
        disposeDispatcher = null;
        fn();
      }
    };

    const finish = (ok, reason = null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        url: relayUrl,
        ok,
        reason,
        events,
        eventsReceived,
        bytesReceived,
        violations,
        droppedPolicy,
        rawFilterMatches,
        oldestFilterCreatedAt,
        truncated,
        eose,
      });
    };

    const timer = setTimeout(() => {
      finish(false, "timeout");
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();

    const noteViolation = (why) => {
      violations += 1;
      if (violations >= maxViolations) {
        finish(false, `too many violations: ${why}`);
      }
    };

    try {
      const { init, dispose } = createBoundedWsInit(WebSocketImpl, maxFrameBytes);
      disposeDispatcher = dispose;
      boundedParser = Boolean(init);
      if (init) {
        try {
          ws = new WebSocketImpl(relayUrl, init);
        } catch {
          ws = new WebSocketImpl(relayUrl);
        }
      } else {
        ws = new WebSocketImpl(relayUrl);
      }
    } catch {
      finish(false, "could not open WebSocket");
      return;
    }

    ws.onopen = () => {
      if (settled || !ws) return;
      opened = true;
      try {
        ws.send(JSON.stringify(["REQ", subId, ...filterList]));
      } catch {
        finish(false, "failed to send REQ");
      }
    };

    ws.onmessage = (msgEvent) => {
      if (settled) return;
      framesReceived += 1;
      if (framesReceived > maxFrames) {
        truncated = true;
        finish(true, "frame count cap reached");
        return;
      }
      const data = msgEvent && typeof msgEvent === "object" && "data" in msgEvent
        ? msgEvent.data
        : msgEvent;

      let frameBytes;
      if (typeof data === "string") {
        frameBytes = Buffer.byteLength(data, "utf8");
      } else if (data instanceof ArrayBuffer) {
        frameBytes = data.byteLength;
      } else if (ArrayBuffer.isView(data)) {
        frameBytes = data.byteLength;
      } else if (typeof Blob !== "undefined" && data instanceof Blob) {
        frameBytes = data.size;
      } else {
        finish(false, "non-text frame");
        return;
      }

      if (typeof data !== "string") {
        if (frameBytes > maxFrameBytes) {
          finish(false, "frame exceeds byte cap");
          return;
        }
        bytesReceived += frameBytes;
        finish(false, "non-text frame");
        return;
      }

      bytesReceived += frameBytes;
      if (bytesReceived > maxTotalBytes) {
        truncated = true;
        finish(true, "relay exceeded 1 MB byte cap");
        return;
      }
      if (frameBytes > maxFrameBytes) {
        // Oversize text frame from a poster: drop without failing the relay
        droppedPolicy += 1;
        return;
      }

      let frame;
      try {
        frame = JSON.parse(data);
      } catch {
        noteViolation("invalid JSON frame");
        return;
      }
      if (!Array.isArray(frame) || typeof frame[0] !== "string") {
        noteViolation("malformed relay message");
        return;
      }

      switch (frame[0]) {
        case "EVENT": {
          const rxSubId = frame[1];
          const ev = frame[2];
          if (rxSubId !== subId) return;
          if (!isPlainObject(ev) || !isHex64(ev.id) || !isHex64(ev.pubkey) || !isHex128(ev.sig)) {
            noteViolation("malformed EVENT payload");
            return;
          }
          if (seenIds.has(ev.id)) return;

          // Poster-side policy checks (oversize, shape, off-filter, low PoW) are dropped
          // without counting as relay violations so no poster can kill healthy relays.
          if (Buffer.byteLength(JSON.stringify(ev), "utf8") > maxEventBytes) {
            seenIds.add(ev.id);
            droppedPolicy += 1;
            return;
          }
          if (
            Object.keys(ev).length !== 7 ||
            nostrEventShapeProblem(ev, { needPubkey: true, strictControlChars: false })
          ) {
            seenIds.add(ev.id);
            droppedPolicy += 1;
            return;
          }

          const matchedFilterIndexes = [];
          for (let i = 0; i < filterList.length; i += 1) {
            if (matchesFilter(ev, filterList[i])) matchedFilterIndexes.push(i);
          }
          if (matchedFilterIndexes.length === 0) {
            seenIds.add(ev.id);
            droppedPolicy += 1;
            return;
          }

          rawFilterMatches += 1;
          if (oldestFilterCreatedAt === null || ev.created_at < oldestFilterCreatedAt) {
            oldestFilterCreatedAt = ev.created_at;
          }

          // Drop low/zero-PoW offer events before Schnorr verify & maxEvents slots
          if (ev.kind === OFFER_KIND && minPowBits > 0 && !checkNip13Pow(ev, minPowBits).ok) {
            seenIds.add(ev.id);
            eventsReceived += 1;
            droppedPolicy += 1;
            return;
          }

          // Cryptographic NIP-01 id + BIP-340 Schnorr check. A poster can publish a
          // badly signed event to any relay, so this is a poster-side drop, not a relay fault.
          if (!verifyEventFast(ev, verifiedById)) {
            droppedPolicy += 1;
            return;
          }

          seenIds.add(ev.id);
          eventsReceived += 1;

          // Independent per-filter event budget: cap hits are truncated-but-usable
          const underCap = matchedFilterIndexes.filter((idx) => keptByFilter[idx] < maxEvents);
          if (underCap.length === 0) {
            truncated = true;
            if (keptByFilter.every((count) => count >= maxEvents)) {
              finish(true, "event cap reached");
            }
            return;
          }
          for (const idx of underCap) keptByFilter[idx] += 1;
          events.push(ev);
          return;
        }
        case "EOSE": {
          if (frame[1] === subId) {
            eose = true;
            finish(true, null);
          }
          return;
        }
        case "CLOSED": {
          if (frame[1] === subId) {
            finish(false, typeof frame[2] === "string" ? frame[2].slice(0, 120) : "subscription closed");
          }
          return;
        }
        case "AUTH": {
          // Read-only anonymous crawler never authenticates with keys
          return;
        }
        case "NOTICE": {
          return;
        }
        default:
          return;
      }
    };

    let errored = false;
    ws.onerror = () => {
      // An error is followed by a close; the close handler decides (timeout covers no close).
      errored = true;
    };

    ws.onclose = (closeEvent) => {
      if (settled) return;
      if (eose) {
        finish(true, null);
      } else if (
        closeEvent &&
        (closeEvent.code === 1009 || (closeEvent.code === 1006 && errored && opened && boundedParser))
      ) {
        // Frame larger than the bound (close 1009; Node 24's parser fails the connection with an
        // error and close 1006 instead): truncated-but-usable, verified events are kept.
        truncated = true;
        finish(true, "frame too large");
      } else {
        finish(false, errored ? "socket error" : "socket closed before EOSE");
      }
    };
  });
}

// ---------------------------------------------------------------------------
// Hostile Event Validation: Offers, Heartbeats, and NIP-09 Deletions
// ---------------------------------------------------------------------------

/**
 * Extracts a `no1dinv1:...` code and optional raw note text from a verified offer event.
 * Rejects missing codes, raw JSON invitations, or conflicting invite codes across tags & content.
 */
function extractInviteAndNote(ev) {
  const inviteTags = tagsNamed(ev, "invite");
  const noteTags = tagsNamed(ev, "note");
  if (inviteTags.length > 1) return { ok: false, reason: "duplicate invite tag" };
  if (noteTags.length > 1) return { ok: false, reason: "duplicate note tag" };

  let codeFromTag = null;
  if (inviteTags.length === 1) {
    if (inviteTags[0].length !== 1) return { ok: false, reason: "malformed invite tag" };
    codeFromTag = inviteTags[0][0].trim();
    if (!codeFromTag.startsWith(CODE_PREFIX)) {
      return { ok: false, reason: "invite tag must be a no1dinv1: code" };
    }
  }

  let noteFromTag = null;
  if (noteTags.length === 1) {
    if (noteTags[0].length !== 1) return { ok: false, reason: "malformed note tag" };
    noteFromTag = noteTags[0][0];
    if (noteFromTag.includes(CODE_PREFIX)) {
      return { ok: false, reason: "invite code not allowed in note tag" };
    }
  }

  const contentTrimmed = ev.content.trim();
  const contentHasInvitePrefix = contentTrimmed.includes(CODE_PREFIX);

  if (codeFromTag !== null) {
    if (contentHasInvitePrefix) {
      // Refuse ambiguous dual-carrier events unless content literally matches the tag
      if (contentTrimmed !== codeFromTag) {
        return { ok: false, reason: "conflicting invite code in tag and content" };
      }
      return { ok: true, code: codeFromTag, rawNote: noteFromTag || "" };
    }
    return {
      ok: true,
      code: codeFromTag,
      rawNote: noteFromTag !== null ? noteFromTag : contentTrimmed,
    };
  }

  // No invite tag: extract strictly from content (first whitespace-delimited token must be `no1dinv1:...`)
  if (!contentTrimmed.startsWith(CODE_PREFIX)) {
    return { ok: false, reason: "missing no1dinv1: invitation code" };
  }
  const firstSpace = contentTrimmed.search(/\s/);
  if (firstSpace === -1) {
    return { ok: true, code: contentTrimmed, rawNote: noteFromTag || "" };
  }
  const extractedCode = contentTrimmed.slice(0, firstSpace);
  const rest = contentTrimmed.slice(firstSpace).trim();
  if (rest.includes(CODE_PREFIX)) {
    return { ok: false, reason: "multiple no1dinv1: codes in content" };
  }
  return {
    ok: true,
    code: extractedCode,
    rawNote: noteFromTag !== null ? noteFromTag : rest,
  };
}

/**
 * Validates an untrusted Nostr offer event (kind 32871) in full.
 */
export function validateOfferEvent(
  ev,
  {
    nowSec,
    boardTag = PUBLIC_WEB_BOARD_TAG,
    minPowBits = DEFAULT_MIN_POW_BITS,
    maxExpirySeconds = DEFAULT_MAX_EXPIRY_SECONDS,
    maxOfferAgeSeconds = DEFAULT_MAX_OFFER_AGE_SECONDS,
    allowedNetworks = ALLOWED_NETWORKS,
    verifiedById = null,
    allowExpired = false,
  },
) {
  const reject = (reason) => ({ ok: false, reason });

  if (!verifyEventFast(ev, verifiedById)) return reject("invalid NIP-01 id or BIP-340 signature");
  if (ev.kind !== OFFER_KIND) return reject("wrong event kind");

  // Topic tag must include boardTag
  const tValues = tagsNamed(ev, "t").map((x) => (x.length === 1 ? x[0] : null));
  if (!tValues.includes(boardTag)) return reject("wrong board topic tag");

  // Replaceable `d` tag: 16-byte hex (32 lowercase hex chars, parity with desktop board)
  const d = oneExactTag(ev, "d");
  if (d === null || !HEX32_RE.test(d)) return reject("invalid or missing d tag");

  // Status tag (optional defaults to "open"; "taken"/"closed" withdraw prior open offer).
  // Validated before expiry so expired replacements within maxOfferAgeSeconds still
  // participate in NIP-33 (pubkey, d) replaceability and prevent older versions from returning.
  const statusTags = tagsNamed(ev, "status");
  if (statusTags.length > 1) return reject("duplicate status tag");
  let status = "open";
  if (statusTags.length === 1) {
    if (statusTags[0].length !== 1 || !OFFER_STATUSES.includes(statusTags[0][0])) {
      return reject("invalid status tag");
    }
    status = statusTags[0][0];
  }

  // Timestamps & NIP-40 expiration
  if (ev.created_at > nowSec + MAX_FUTURE_SKEW_SECONDS) {
    return reject("created_at is more than 5 minutes in the future");
  }
  if (ev.created_at < nowSec - maxOfferAgeSeconds) {
    return reject("offer created_at is too old");
  }
  const expStr = oneExactTag(ev, "expiration");
  if (expStr === null || !EXPIRY_RE.test(expStr)) {
    return reject("missing or malformed NIP-40 expiration tag");
  }
  const expiresAtSec = Number(expStr);
  if (!Number.isSafeInteger(expiresAtSec)) {
    return reject("malformed NIP-40 expiration tag");
  }
  if (expiresAtSec <= ev.created_at) {
    return reject("expiration must be after created_at");
  }
  if (expiresAtSec > ev.created_at + maxExpirySeconds + MAX_FUTURE_SKEW_SECONDS) {
    return reject("expiration exceeds maximum allowed lifetime");
  }
  const isExpired = expiresAtSec <= nowSec;
  if (status === "open" && isExpired && !allowExpired) {
    return reject("offer is expired");
  }

  // NIP-13 proof of work
  const pow = checkNip13Pow(ev, minPowBits);
  if (!pow.ok) return reject(`proof of work: ${pow.reason}`);

  // Withdrawn/closed or expired replacements supersede older (pubkey, d) versions
  // during NIP-33 replaceability and are filtered out before publication.
  if (status !== "open" || isExpired) {
    return {
      ok: true,
      offer: {
        eventId: ev.id,
        d,
        pubkey: ev.pubkey,
        createdAtSec: ev.created_at,
        expiresAtSec,
        powBits: pow.bits,
        status,
        expired: isExpired,
        decoded: null,
        note: "",
      },
    };
  }

  // Extract & decode `no1dinv1:` invitation strictly via decodeInvite() + pinned contract
  const extracted = extractInviteAndNote(ev);
  if (!extracted.ok) return reject(extracted.reason);

  const decoded = decodeInvite(extracted.code);
  if (!decoded.ok) return reject(`invalid invite code (${decoded.code || "DAMAGED"})`);

  const pinnedCheck = requirePinnedContract(decoded);
  if (!pinnedCheck.ok || decoded.contractPinned !== true) {
    return reject("unpinned HTLC contract");
  }

  const f = decoded.fields;
  const bobEthLower = f.bob_eth.toLowerCase();
  if (bobEthLower === f.contract.toLowerCase()) {
    return reject("bob_eth cannot equal the HTLC contract address");
  }
  if (ZERO_ETH_ADDR_RE.test(bobEthLower)) {
    return reject("bob_eth cannot be the zero address");
  }
  if (!allowedNetworks.includes(f.network)) {
    return reject(`network ${f.network} not allowed`);
  }
  const spec = NETWORK_SPECS[f.network];
  if (!spec) return reject("unsupported network");

  const noidMicro = BigInt(f.noid_micronoid);
  const ethWei = BigInt(f.eth_wei);
  if (noidMicro <= 0n || noidMicro > spec.maxNoidMicro) {
    return reject("NOID amount exceeds network cap");
  }
  if (ethWei <= 0n || ethWei > spec.maxEthWei) {
    return reject("ETH amount exceeds network cap");
  }
  if (!spec.allowedContractVersions.includes(Number(f.contract_version))) {
    return reject("disallowed contract_version");
  }

  const note = sanitizeDisplayText(extracted.rawNote, 140);

  return {
    ok: true,
    offer: {
      eventId: ev.id,
      d,
      pubkey: ev.pubkey,
      createdAtSec: ev.created_at,
      expiresAtSec,
      powBits: pow.bits,
      status: "open",
      expired: false,
      decoded,
      note,
    },
  };
}

/**
 * Validates a signed maker liveness heartbeat event (kind 32872).
 */
export function validateHeartbeatEvent(
  ev,
  {
    nowSec,
    boardTag = PUBLIC_WEB_BOARD_TAG,
    maxHeartbeatAgeSeconds = DEFAULT_MAX_HEARTBEAT_AGE_SECONDS,
    verifiedById = null,
  },
) {
  if (!verifyEventFast(ev, verifiedById)) return { ok: false, reason: "invalid signature or id" };
  if (ev.kind !== HEARTBEAT_KIND) return { ok: false, reason: "wrong kind" };
  const tValues = tagsNamed(ev, "t").map((x) => (x.length === 1 ? x[0] : null));
  if (!tValues.includes(boardTag)) return { ok: false, reason: "wrong board topic tag" };
  if (ev.created_at > nowSec + MAX_FUTURE_SKEW_SECONDS) {
    return { ok: false, reason: "heartbeat in the future" };
  }
  if (ev.created_at < nowSec - maxHeartbeatAgeSeconds) {
    return { ok: false, reason: "heartbeat too old" };
  }

  const statusTags = tagsNamed(ev, "status");
  if (statusTags.length > 1) {
    return { ok: false, reason: "duplicate heartbeat status tag" };
  }
  let status = "online";
  if (statusTags.length === 1) {
    if (statusTags[0].length !== 1 || !HEARTBEAT_STATUSES.includes(statusTags[0][0])) {
      return { ok: false, reason: "invalid heartbeat status tag" };
    }
    status = statusTags[0][0];
  }

  const expTags = tagsNamed(ev, "expiration");
  if (expTags.length > 1) {
    return { ok: false, reason: "duplicate expiration tag" };
  }
  if (expTags.length === 1) {
    if (expTags[0].length !== 1 || !EXPIRY_RE.test(expTags[0][0])) {
      return { ok: false, reason: "malformed heartbeat expiration" };
    }
    const expSec = Number(expTags[0][0]);
    if (!Number.isSafeInteger(expSec)) {
      return { ok: false, reason: "malformed heartbeat expiration" };
    }
    // Allow expired "paused"/"offline" tombstones within maxHeartbeatAgeSeconds to
    // participate in NIP-33 (pubkey, d) replaceability and supersede older "online" events.
    if (status === "online" && expSec <= nowSec) {
      return { ok: false, reason: "malformed or expired heartbeat" };
    }
  }

  const dTags = tagsNamed(ev, "d");
  if (dTags.length > 1) {
    return { ok: false, reason: "duplicate heartbeat d tag" };
  }
  let d = "heartbeat";
  if (dTags.length === 1) {
    if (dTags[0].length !== 1 || (dTags[0][0] !== "heartbeat" && !HEX32_RE.test(dTags[0][0]))) {
      return { ok: false, reason: "invalid heartbeat d tag" };
    }
    d = dTags[0][0];
  }

  return {
    ok: true,
    heartbeat: {
      eventId: ev.id,
      pubkey: ev.pubkey,
      d,
      status,
      createdAtSec: ev.created_at,
    },
  };
}

/**
 * Validates a NIP-09 deletion request event (kind 5) targeting offer kind 32871.
 */
export function validateDeletionEvent(ev, { nowSec, verifiedById = null }) {
  if (!verifyEventFast(ev, verifiedById)) return { ok: false, reason: "invalid signature or id" };
  if (ev.kind !== DELETION_KIND) return { ok: false, reason: "wrong kind" };
  if (ev.created_at > nowSec + MAX_FUTURE_SKEW_SECONDS) {
    return { ok: false, reason: "deletion in the future" };
  }
  const eventIds = tagsNamed(ev, "e")
    .filter((x) => x.length >= 1 && isHex64(x[0]))
    .map((x) => x[0]);
  const addresses = tagsNamed(ev, "a")
    .filter((x) => x.length >= 1 && typeof x[0] === "string")
    .map((x) => x[0]);
  if (eventIds.length === 0 && addresses.length === 0) {
    return { ok: false, reason: "deletion has no valid e or a tags" };
  }
  return {
    ok: true,
    deletion: {
      pubkey: ev.pubkey,
      createdAtSec: ev.created_at,
      eventIds,
      addresses,
    },
  };
}

// ---------------------------------------------------------------------------
// Aggregation: Replaceability, Deletions, Liveness, Duplicate/Copy Flagging
// ---------------------------------------------------------------------------

/**
 * Processes verified & unverified events collected across relays into the
 * final sanitized `offers` array for `./data/offers.json`.
 */
export function aggregateNostrEvents(
  relayEvents,
  {
    nowMs,
    boardTag = PUBLIC_WEB_BOARD_TAG,
    minPowBits = DEFAULT_MIN_POW_BITS,
    maxExpirySeconds = DEFAULT_MAX_EXPIRY_SECONDS,
    maxOfferAgeSeconds = DEFAULT_MAX_OFFER_AGE_SECONDS,
    maxHeartbeatAgeSeconds = DEFAULT_MAX_HEARTBEAT_AGE_SECONDS,
    allowedNetworks = ALLOWED_NETWORKS,
    maxOutputOffers = MAX_OFFERS_COUNT,
    verifiedById = null,
  },
) {
  const nowSec = Math.floor(nowMs / 1000);
  const localVerified = verifiedById instanceof Map ? verifiedById : new Map();
  const latestOfferByAddr = new Map(); // `${pubkey}:${d}` -> offer
  const latestHeartbeatByAddr = new Map(); // `${pubkey}:${d}` -> latest heartbeat (online/paused/offline)
  const relaysByEventId = new Map(); // eventId -> Set<relayUrl>
  const deletionsByEvent = new Set(); // `${pubkey}:${eventId}`
  const deletionsByAddr = new Map(); // `${pubkey}:${d}` -> max deletion createdAtSec
  const rejected = [];

  for (const item of relayEvents) {
    const ev = item && item.event ? item.event : item;
    const relayUrl = item && typeof item.relayUrl === "string" ? item.relayUrl : null;
    if (!ev || typeof ev !== "object") {
      rejected.push({ id: "?", reason: "not an object" });
      continue;
    }

    if (ev.kind === HEARTBEAT_KIND) {
      const hb = validateHeartbeatEvent(ev, {
        nowSec,
        boardTag,
        maxHeartbeatAgeSeconds,
        verifiedById: localVerified,
      });
      if (!hb.ok) {
        rejected.push({ id: ev.id || "?", reason: `heartbeat: ${hb.reason}` });
        continue;
      }
      const nextHb = hb.heartbeat;
      const addrKey = `${nextHb.pubkey}:${nextHb.d}`;
      const prev = latestHeartbeatByAddr.get(addrKey);
      if (
        !prev ||
        nextHb.createdAtSec > prev.createdAtSec ||
        (nextHb.createdAtSec === prev.createdAtSec && nextHb.eventId < prev.eventId)
      ) {
        latestHeartbeatByAddr.set(addrKey, nextHb);
      }
      continue;
    }

    if (ev.kind === DELETION_KIND) {
      const del = validateDeletionEvent(ev, { nowSec, verifiedById: localVerified });
      if (!del.ok) {
        rejected.push({ id: ev.id || "?", reason: `deletion: ${del.reason}` });
        continue;
      }
      const { pubkey, createdAtSec, eventIds, addresses } = del.deletion;
      for (const targetId of eventIds) {
        deletionsByEvent.add(`${pubkey}:${targetId}`);
      }
      for (const aTag of addresses) {
        const prefix = `${OFFER_KIND}:${pubkey}:`;
        if (aTag.startsWith(prefix)) {
          const d = aTag.slice(prefix.length);
          if (HEX32_RE.test(d)) {
            const k = `${pubkey}:${d}`;
            const prev = deletionsByAddr.get(k) ?? -1;
            if (createdAtSec > prev) deletionsByAddr.set(k, createdAtSec);
          }
        }
      }
      continue;
    }

    if (ev.kind === OFFER_KIND) {
      const res = validateOfferEvent(ev, {
        nowSec,
        boardTag,
        minPowBits,
        maxExpirySeconds,
        maxOfferAgeSeconds,
        allowedNetworks,
        verifiedById: localVerified,
        allowExpired: true,
      });
      if (!res.ok) {
        rejected.push({ id: typeof ev.id === "string" ? ev.id : "?", reason: res.reason });
        continue;
      }
      const offer = res.offer;
      if (relayUrl) {
        let set = relaysByEventId.get(offer.eventId);
        if (!set) {
          set = new Set();
          relaysByEventId.set(offer.eventId, set);
        }
        if (set.size < MAX_OFFER_RELAYS) set.add(relayUrl);
      }
      const addrKey = `${offer.pubkey}:${offer.d}`;
      const prev = latestOfferByAddr.get(addrKey);
      if (
        !prev ||
        offer.createdAtSec > prev.createdAtSec ||
        (offer.createdAtSec === prev.createdAtSec && offer.eventId < prev.eventId)
      ) {
        latestOfferByAddr.set(addrKey, offer);
      }
      continue;
    }

    rejected.push({ id: typeof ev.id === "string" ? ev.id : "?", reason: "unsupported kind" });
  }

  // Only winning unexpired "online" heartbeats contribute to maker liveness
  const heartbeatsByPubkey = new Map();
  const heartbeatsByAddr = new Map();
  for (const hb of latestHeartbeatByAddr.values()) {
    if (hb.status !== "online") continue;
    if (hb.d === "heartbeat") {
      heartbeatsByPubkey.set(hb.pubkey, hb.createdAtSec);
    } else {
      heartbeatsByAddr.set(`${hb.pubkey}:${hb.d}`, hb.createdAtSec);
    }
  }

  // Keep only non-expired open offers not deleted by their own pubkey
  const activeOffers = [];
  for (const offer of latestOfferByAddr.values()) {
    if (offer.status !== "open" || offer.expired || !offer.decoded) continue;
    if (deletionsByEvent.has(`${offer.pubkey}:${offer.eventId}`)) continue;
    const delByAddr = deletionsByAddr.get(`${offer.pubkey}:${offer.d}`);
    if (delByAddr !== undefined && delByAddr >= offer.createdAtSec) continue;
    activeOffers.push(offer);
  }

  // Neutral duplicate payload detection & repeated Bob address detection
  const byCode = new Map();
  const bobNoidCounts = new Map();
  const bobEthCounts = new Map();
  for (const offer of activeOffers) {
    const code = offer.decoded.canonicalCode;
    let group = byCode.get(code);
    if (!group) {
      group = [];
      byCode.set(code, group);
    }
    group.push(offer);

    const bn = offer.decoded.fields.bob_noid;
    const be = offer.decoded.fields.bob_eth.toLowerCase();
    bobNoidCounts.set(bn, (bobNoidCounts.get(bn) || 0) + 1);
    bobEthCounts.set(be, (bobEthCounts.get(be) || 0) + 1);
  }

  const codeInfoMap = new Map();
  for (const [code, group] of byCode.entries()) {
    const pubkeys = new Set(group.map((g) => g.pubkey));
    codeInfoMap.set(code, {
      count: group.length,
      distinctPubkeys: pubkeys.size,
    });
  }

  // Neutral deterministic sort: newest created_at first, tie-break eventId ascending
  activeOffers.sort((a, b) => {
    if (b.createdAtSec !== a.createdAtSec) return b.createdAtSec - a.createdAtSec;
    return a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0;
  });

  const capped = activeOffers.slice(0, maxOutputOffers);

  const outputOffers = capped.map((offer) => {
    const addrKey = `${offer.pubkey}:${offer.d}`;
    const hbAddr = heartbeatsByAddr.get(addrKey) || 0;
    const hbPub = heartbeatsByPubkey.get(offer.pubkey) || 0;
    const latestHb = Math.max(hbAddr, hbPub);
    const hasHeartbeat = latestHb > 0;
    const lastSeenSec = Math.max(offer.createdAtSec, latestHb);
    const lastSeenMs = Math.min(lastSeenSec * 1000, nowMs);
    let livenessStatus;
    if (hasHeartbeat && computeLivenessBucket(Math.min(latestHb * 1000, nowMs), nowMs) === "online") {
      livenessStatus = "online";
    } else {
      const bucket = computeLivenessBucket(lastSeenMs, nowMs);
      livenessStatus = bucket === "online" ? "recent" : bucket;
    }

    const codeInfo = codeInfoMap.get(offer.decoded.canonicalCode);
    const duplicatePayload = codeInfo.count > 1;
    const bn = offer.decoded.fields.bob_noid;
    const be = offer.decoded.fields.bob_eth.toLowerCase();
    const repeatedBobAddress =
      (bobNoidCounts.get(bn) || 0) > 1 || (bobEthCounts.get(be) || 0) > 1;

    const seenRelays = relaysByEventId.get(offer.eventId);

    return {
      event_id: offer.eventId,
      d: offer.d,
      pubkey: offer.pubkey,
      created_at: toUtcIso(offer.createdAtSec * 1000),
      expires_at: toUtcIso(offer.expiresAtSec * 1000),
      pow_bits: offer.powBits,
      code: offer.decoded.canonicalCode,
      note: offer.note,
      liveness: {
        status: livenessStatus,
        last_seen_at: toUtcIso((hasHeartbeat ? latestHb : offer.createdAtSec) * 1000),
        has_heartbeat: hasHeartbeat,
      },
      flags: {
        duplicate_payload: duplicatePayload,
        duplicate_count: codeInfo.count,
        distinct_pubkeys: codeInfo.distinctPubkeys,
        repeated_bob_address: repeatedBobAddress,
      },
      relays: seenRelays ? [...seenRelays].sort() : [],
    };
  });

  return { offers: outputOffers, rejected };
}

// ---------------------------------------------------------------------------
// Rate-limit check & Atomic write (parity with scripts/update-market.mjs)
// ---------------------------------------------------------------------------

async function isRateLimited(outputPath, nowMs) {
  let st;
  try {
    st = await fs.lstat(outputPath);
  } catch {
    return false;
  }
  if (!st.isFile() || st.isSymbolicLink() || st.size > MAX_OFFERS_BYTES) {
    return false;
  }
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
  if (
    !isPlainObject(existing) ||
    existing.sample === true ||
    typeof existing.generated_at !== "string"
  ) {
    return false;
  }
  const parsed = parseUtcIsoStrict(existing.generated_at);
  if (!parsed) {
    return false;
  }
  // Reject tampered >5 min future timestamps from freezing updates
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
  let created = false;
  let renamed = false;

  try {
    const handle = await fs.open(tmpPath, "wx", 0o644);
    created = true;
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmpPath, resolved);
    renamed = true;
  } finally {
    if (created && !renamed) {
      await fs.unlink(tmpPath).catch(() => {});
    }
  }
}

function recomputeTrimmedOfferFlags(outputOffers) {
  const byCode = new Map();
  const bobNoidCounts = new Map();
  const bobEthCounts = new Map();
  const decodedById = new Map();

  for (const o of outputOffers) {
    let group = byCode.get(o.code);
    if (!group) {
      group = [];
      byCode.set(o.code, group);
    }
    group.push(o);

    const dec = decodeInvite(o.code);
    if (dec.ok) {
      decodedById.set(o.event_id, dec);
      const bn = dec.fields.bob_noid;
      const be = dec.fields.bob_eth.toLowerCase();
      bobNoidCounts.set(bn, (bobNoidCounts.get(bn) || 0) + 1);
      bobEthCounts.set(be, (bobEthCounts.get(be) || 0) + 1);
    }
  }

  const codeInfoMap = new Map();
  for (const [code, group] of byCode.entries()) {
    const pubkeys = new Set(group.map((g) => g.pubkey));
    codeInfoMap.set(code, {
      count: group.length,
      distinctPubkeys: pubkeys.size,
    });
  }

  return outputOffers.map((o) => {
    const info = codeInfoMap.get(o.code);
    const duplicatePayload = info.count > 1;
    const dec = decodedById.get(o.event_id);
    const repeatedBobAddress = dec
      ? (bobNoidCounts.get(dec.fields.bob_noid) || 0) > 1 ||
        (bobEthCounts.get(dec.fields.bob_eth.toLowerCase()) || 0) > 1
      : false;
    return {
      ...o,
      flags: {
        duplicate_payload: duplicatePayload,
        duplicate_count: info.count,
        distinct_pubkeys: info.distinctPubkeys,
        repeated_bob_address: repeatedBobAddress,
      },
    };
  });
}

function buildRelaySummary(relayResults, finalOffers) {
  const acceptedCountByRelay = new Map();
  for (const offer of finalOffers) {
    for (const url of offer.relays) {
      acceptedCountByRelay.set(url, (acceptedCountByRelay.get(url) || 0) + 1);
    }
  }
  return relayResults.map((r) => ({
    url: r.url,
    ok: Boolean(r && r.ok),
    events_received: Number.isInteger(r && r.eventsReceived) ? r.eventsReceived : 0,
    events_accepted: acceptedCountByRelay.get(r.url) || 0,
    truncated: Boolean(r && r.truncated),
  }));
}

// ---------------------------------------------------------------------------
// Main Update Orchestrator
// ---------------------------------------------------------------------------

/**
 * Runs one Nostr offer-discovery snapshot cycle and atomically replaces
 * `outputPath` (`./data/offers.json`).
 */
export async function runUpdateOffers({
  outputPath,
  relays = DEFAULT_RELAYS,
  nowMs = Date.now(),
  force = false,
  allowLocalTest = false,
  boardTag = PUBLIC_WEB_BOARD_TAG,
  minPowBits = DEFAULT_MIN_POW_BITS,
  maxExpirySeconds = DEFAULT_MAX_EXPIRY_SECONDS,
  maxOfferAgeSeconds = DEFAULT_MAX_OFFER_AGE_SECONDS,
  maxHeartbeatAgeSeconds = DEFAULT_MAX_HEARTBEAT_AGE_SECONDS,
  allowedNetworks = ALLOWED_NETWORKS,
  timeoutMs = RELAY_TIMEOUT_MS,
  maxRelayBytes = MAX_RELAY_BYTES,
  maxFrameBytes = MAX_FRAME_BYTES,
  maxEventBytes = MAX_EVENT_BYTES,
  maxEventsPerRelay = MAX_EVENTS_PER_RELAY,
  maxFramesPerRelay = Math.max(maxEventsPerRelay * 4, MAX_FRAMES_PER_RELAY),
  maxOfferPages = MAX_OFFER_PAGES,
  maxOutputOffers = MAX_OFFERS_COUNT,
  WebSocketImpl = globalThis.WebSocket,
  queryRelayImpl = null,
} = {}) {
  if (typeof outputPath !== "string" || !outputPath.trim()) {
    return {
      ok: false,
      skipped: false,
      reason: "invalid_output_path",
      error: "outputPath is required.",
    };
  }

  const now = typeof nowMs === "number" && Number.isFinite(nowMs) ? Math.floor(nowMs) : Date.now();
  const nowSec = Math.floor(now / 1000);
  const nowIso = toUtcIso(now);

  // 1. Enforce 10-minute rate limit unless explicitly overridden via force: true (--force)
  if (!force && (await isRateLimited(outputPath, now))) {
    return { ok: true, skipped: true, reason: "rate_limited", outputPath };
  }

  // 2. Validate, deduplicate, and bound configured relay URLs (<= MAX_RELAYS_REPORTED)
  const normalizedRelays = [];
  const seenRelayUrls = new Set();
  const rejectedRelays = [];
  for (const rawUrl of Array.isArray(relays) ? relays : []) {
    const n = normalizeRelayUrl(rawUrl, { allowLocalTest: allowLocalTest === true });
    if (!n.ok) {
      rejectedRelays.push({ url: String(rawUrl).slice(0, 120), reason: n.reason });
    } else if (!seenRelayUrls.has(n.url)) {
      if (normalizedRelays.length >= MAX_RELAYS_REPORTED) {
        rejectedRelays.push({
          url: n.url,
          reason: `exceeds maximum of ${MAX_RELAYS_REPORTED} configured relays`,
        });
      } else {
        seenRelayUrls.add(n.url);
        normalizedRelays.push(n.url);
      }
    }
  }
  if (normalizedRelays.length === 0) {
    return {
      ok: false,
      skipped: false,
      reason: "no_valid_relays",
      error: "No valid Nostr relay URLs were configured.",
      rejectedRelays,
    };
  }

  // 3. Pass 1: Query offer events (kind 32871) concurrently across relays with
  //    bounded `until` pagination so zero-PoW spam cannot crowd out valid PoW offers.
  const offerSince = Math.max(0, nowSec - maxOfferAgeSeconds - MAX_FUTURE_SKEW_SECONDS);
  const verifiedById = new Map();

  const runSingleQuery = (url, filters, opts) =>
    typeof queryRelayImpl === "function"
      ? queryRelayImpl(url, filters, opts)
      : queryRelay(url, filters, {
          WebSocketImpl,
          ...opts,
          verifiedById,
        });

  const maxPages = Number.isInteger(maxOfferPages) && maxOfferPages > 0 ? maxOfferPages : 1;

  const relayResults = await Promise.all(
    normalizedRelays.map(async (url) => {
      const mergedEvents = [];
      const seenEventIds = new Set();
      let totalEventsReceived = 0;
      let totalBytesReceived = 0;
      let totalViolations = 0;
      let truncated = false;
      let lastEose = false;
      let lastReason = null;
      let anyPageOk = false;
      let until = undefined;

      for (let page = 0; page < maxPages; page += 1) {
        const remainingBytes = Math.max(0, maxRelayBytes - totalBytesReceived);
        if (remainingBytes === 0) {
          truncated = true;
          break;
        }
        const pageFilters = buildOfferFilter({
          nowSec,
          boardTag,
          maxOfferAgeSeconds,
          maxEventsPerRelay,
          until,
        });
        let pageRes;
        try {
          pageRes = await runSingleQuery(url, pageFilters, {
            timeoutMs,
            maxTotalBytes: remainingBytes,
            maxFrameBytes,
            maxEventBytes,
            maxEvents: maxEventsPerRelay,
            maxFrames: maxFramesPerRelay,
            minPowBits,
          });
        } catch (err) {
          pageRes = {
            url,
            ok: false,
            reason: err && err.message ? err.message : "relay query threw",
            events: [],
            eventsReceived: 0,
            bytesReceived: 0,
            violations: 0,
            rawFilterMatches: 0,
            oldestFilterCreatedAt: null,
            truncated: false,
            eose: false,
          };
        }

        if (!pageRes || pageRes.ok !== true) {
          if (!anyPageOk) {
            return {
              url,
              ok: false,
              reason: (pageRes && pageRes.reason) || "relay failed",
              events: [],
              eventsReceived: Number.isInteger(pageRes && pageRes.eventsReceived)
                ? pageRes.eventsReceived
                : 0,
              bytesReceived: Number.isInteger(pageRes && pageRes.bytesReceived)
                ? pageRes.bytesReceived
                : 0,
              violations: Number.isInteger(pageRes && pageRes.violations) ? pageRes.violations : 0,
              truncated: false,
              eose: false,
            };
          }
          truncated = true;
          lastReason = (pageRes && pageRes.reason) || "pagination stopped";
          break;
        }

        anyPageOk = true;
        lastEose = Boolean(pageRes.eose);
        if (pageRes.truncated) truncated = true;
        if (pageRes.reason) lastReason = pageRes.reason;
        totalEventsReceived += Number.isInteger(pageRes.eventsReceived) ? pageRes.eventsReceived : 0;
        totalBytesReceived += Number.isInteger(pageRes.bytesReceived) ? pageRes.bytesReceived : 0;
        totalViolations += Number.isInteger(pageRes.violations) ? pageRes.violations : 0;

        if (Array.isArray(pageRes.events)) {
          for (const ev of pageRes.events) {
            if (ev && typeof ev.id === "string" && !seenEventIds.has(ev.id)) {
              seenEventIds.add(ev.id);
              mergedEvents.push(ev);
            }
          }
        }

        const rawMatches = Number.isInteger(pageRes.rawFilterMatches)
          ? pageRes.rawFilterMatches
          : 0;
        const oldestTs =
          typeof pageRes.oldestFilterCreatedAt === "number" &&
          Number.isSafeInteger(pageRes.oldestFilterCreatedAt)
            ? pageRes.oldestFilterCreatedAt
            : null;

        // Only page backwards when this page actually filled the relay's limit
        // (e.g. zero-PoW spam crowded out real offers) and older events may remain.
        if (
          !pageRes.eose ||
          pageRes.truncated ||
          rawMatches < maxEventsPerRelay ||
          mergedEvents.length >= maxEventsPerRelay ||
          oldestTs === null ||
          oldestTs <= offerSince
        ) {
          break;
        }
        until = oldestTs - 1;
      }

      return {
        url,
        ok: anyPageOk,
        reason: lastReason,
        events: mergedEvents,
        eventsReceived: totalEventsReceived,
        bytesReceived: totalBytesReceived,
        violations: totalViolations,
        truncated,
        eose: lastEose,
      };
    }),
  );

  // Keep every relay that completed cleanly OR hit a resource cap (truncated but usable).
  // Relays with ok: false (socket error, timeout, CLOSED, binary frame, or >=5 protocol faults)
  // are excluded.
  const succeededRelays = relayResults.filter((r) => r && r.ok === true);
  if (succeededRelays.length === 0) {
    return {
      ok: false,
      skipped: false,
      reason: "all_relays_failed",
      error: "All configured Nostr relays failed or timed out; existing offers.json left untouched.",
      relayResults,
    };
  }

  // 4. Collect Pass-1 events strictly from succeeded/usable relays
  const taggedEvents = [];
  const validOfferAuthors = new Set();
  for (const r of succeededRelays) {
    if (!Array.isArray(r.events)) continue;
    for (const ev of r.events) {
      taggedEvents.push({ event: ev, relayUrl: r.url });
      if (ev && ev.kind === OFFER_KIND && isHex64(ev.pubkey)) {
        const check = validateOfferEvent(ev, {
          nowSec,
          boardTag,
          minPowBits,
          maxExpirySeconds,
          maxOfferAgeSeconds,
          allowedNetworks,
          verifiedById,
          allowExpired: true,
        });
        if (check.ok) validOfferAuthors.add(ev.pubkey);
      }
    }
  }

  // 5. Pass 2: Fetch heartbeats (32872) and NIP-09 deletions (kind 5) scoped strictly
  //    to `authors` of valid Pass-1 offers, with independent per-filter event budgets.
  const authorList = [...validOfferAuthors].sort();
  if (authorList.length > 0) {
    const authorChunks = [];
    for (let i = 0; i < authorList.length; i += MAX_AUTHORS_PER_QUERY) {
      authorChunks.push(authorList.slice(i, i + MAX_AUTHORS_PER_QUERY));
    }

    await Promise.all(
      succeededRelays.map(async (r) => {
        for (const authors of authorChunks) {
          const followupFilters = buildAuthorFollowupFilters({
            nowSec,
            authors,
            boardTag,
            maxOfferAgeSeconds,
            maxHeartbeatAgeSeconds,
            maxEventsPerRelay,
          });
          let followRes;
          try {
            followRes = await runSingleQuery(r.url, followupFilters, {
              timeoutMs,
              maxTotalBytes: maxRelayBytes,
              maxFrameBytes,
              maxEventBytes,
              maxEvents: maxEventsPerRelay,
              maxFrames: maxFramesPerRelay,
              minPowBits: 0,
            });
          } catch {
            continue;
          }
          if (!followRes || followRes.ok !== true) continue;
          if (Number.isInteger(followRes.eventsReceived)) {
            r.eventsReceived += followRes.eventsReceived;
          }
          if (Array.isArray(followRes.events)) {
            for (const ev of followRes.events) {
              if (ev && (ev.kind === HEARTBEAT_KIND || ev.kind === DELETION_KIND)) {
                taggedEvents.push({ event: ev, relayUrl: r.url });
              }
            }
          }
        }
      }),
    );
  }

  const { offers, rejected } = aggregateNostrEvents(taggedEvents, {
    nowMs: now,
    boardTag,
    minPowBits,
    maxExpirySeconds,
    maxOfferAgeSeconds,
    maxHeartbeatAgeSeconds,
    allowedNetworks,
    maxOutputOffers,
    verifiedById,
  });

  // 5. Build candidate offers.json payload (trimming offers if JSON would exceed 1 MB cap,
  // then recomputing relay accepted counts and duplicate/Bob flags on the final trimmed set)
  let trimmedOffers = [...offers];
  let payload = {
    v: 1,
    sample: false,
    generated_at: nowIso,
    min_pow_bits: minPowBits,
    relays: buildRelaySummary(relayResults, trimmedOffers),
    offers: trimmedOffers,
  };
  let jsonText = `${JSON.stringify(payload, null, 2)}\n`;
  let didTrim = false;
  while (Buffer.byteLength(jsonText, "utf8") > MAX_OFFERS_BYTES && trimmedOffers.length > 0) {
    trimmedOffers.pop();
    didTrim = true;
    payload = { ...payload, offers: trimmedOffers };
    jsonText = `${JSON.stringify(payload, null, 2)}\n`;
  }
  if (didTrim) {
    trimmedOffers = recomputeTrimmedOfferFlags(trimmedOffers);
    payload = {
      ...payload,
      relays: buildRelaySummary(relayResults, trimmedOffers),
      offers: trimmedOffers,
    };
    jsonText = `${JSON.stringify(payload, null, 2)}\n`;
    while (Buffer.byteLength(jsonText, "utf8") > MAX_OFFERS_BYTES && trimmedOffers.length > 0) {
      trimmedOffers.pop();
      trimmedOffers = recomputeTrimmedOfferFlags(trimmedOffers);
      payload = {
        ...payload,
        relays: buildRelaySummary(relayResults, trimmedOffers),
        offers: trimmedOffers,
      };
      jsonText = `${JSON.stringify(payload, null, 2)}\n`;
    }
  }
  if (Buffer.byteLength(jsonText, "utf8") > MAX_OFFERS_BYTES) {
    return {
      ok: false,
      skipped: false,
      reason: "output_too_large",
      error: `Output offers.json exceeds ${MAX_OFFERS_BYTES}-byte cap.`,
    };
  }

  // 6. Self-validate candidate output through browser validator before touching disk
  const validated = parseOffersSnapshot(jsonText, now);
  if (!validated || !validated.ok) {
    return {
      ok: false,
      skipped: false,
      reason: "validation_failed",
      error:
        validated && validated.error
          ? validated.error
          : "Candidate offers.json failed parseOffersSnapshot().",
    };
  }

  // 7. Atomic write via temp file + fsync + rename
  await writeFileAtomic(outputPath, jsonText);

  return {
    ok: true,
    skipped: false,
    outputPath,
    payload,
    snapshot: validated,
    rejectedCount: rejected.length,
    rejected,
    relayResults,
  };
}

// ---------------------------------------------------------------------------
// CLI entrypoint
// ---------------------------------------------------------------------------

function parseCliArgs(argv) {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const envRelays = process.env.NOSTR_RELAYS
    ? process.env.NOSTR_RELAYS.split(",").map((s) => s.trim()).filter(Boolean)
    : null;
  const opts = {
    outputPath: path.resolve(__dirname, "..", "data", "offers.json"),
    relays: envRelays || [...DEFAULT_RELAYS],
    minPowBits: DEFAULT_MIN_POW_BITS,
    boardTag: PUBLIC_WEB_BOARD_TAG,
    force: false,
    allowLocalTest: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      opts.help = true;
      return opts;
    }
    if (arg === "--force") {
      opts.force = true;
      continue;
    }
    if (arg === "--allow-local-test") {
      opts.allowLocalTest = true;
      continue;
    }
    if (arg === "--out" || arg === "--output") {
      const val = argv[i + 1];
      if (!val || val.startsWith("--")) throw new Error(`Missing value for ${arg}.`);
      opts.outputPath = val;
      i += 1;
      continue;
    }
    if (arg === "--relays") {
      const val = argv[i + 1];
      if (!val || val.startsWith("--")) throw new Error("Missing value for --relays.");
      opts.relays = val.split(",").map((s) => s.trim()).filter(Boolean);
      i += 1;
      continue;
    }
    if (arg === "--min-pow") {
      const val = argv[i + 1];
      if (!val || !/^\d{1,3}$/.test(val)) throw new Error("Invalid value for --min-pow.");
      const n = Number(val);
      if (n < 0 || n > 256) throw new Error("--min-pow must be between 0 and 256.");
      opts.minPowBits = n;
      i += 1;
      continue;
    }
    if (arg === "--board-tag") {
      const val = argv[i + 1];
      if (!val || val.startsWith("--")) throw new Error("Missing value for --board-tag.");
      opts.boardTag = val;
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
        "Usage: node scripts/update-offers.mjs [options]",
        "",
        "Options:",
        "  --out, --output <path> Output offers.json path (default: data/offers.json)",
        "  --relays <csv>         Comma-separated wss:// Nostr relay URLs (or NOSTR_RELAYS)",
        "  --min-pow <bits>       Minimum NIP-13 PoW difficulty bits (default: 16)",
        "  --board-tag <tag>      Nostr #t board topic tag (default: no1d-swap-web-v1)",
        "  --force                Bypass the 10-minute rate limit (tests / manual run only)",
        "  --allow-local-test     Allow ws://127.0.0.1 relays for local testing only",
        "  -h, --help             Show this help message",
        "",
      ].join("\n"),
    );
    return;
  }

  const result = await runUpdateOffers({
    outputPath: opts.outputPath,
    relays: opts.relays,
    minPowBits: opts.minPowBits,
    boardTag: opts.boardTag,
    force: opts.force,
    allowLocalTest: opts.allowLocalTest,
  });

  if (!result.ok) {
    process.stderr.write(`Offers snapshot update failed (${result.reason}): ${result.error}\n`);
    process.exitCode = 1;
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
      offers: result.payload.offers.length,
      relays_ok: result.payload.relays.filter((r) => r.ok).length,
      relays_total: result.payload.relays.length,
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
