# Live P2P Nostr Discovery (`./data/offers.json`) — Summary of Changes

Rebased cleanly onto `No1dSwap/No1dSwap.github.io` commit `b2185ed`. Adds out-of-band Nostr offer discovery writing same-origin `./data/offers.json` for the No1d Swap public web bulletin board, keeping visitors' browsers strictly `connect-src 'self'` with zero external npm dependencies and zero HTML-string sinks.

## What Changed

### New Files
- `js/offers-data.js`: Same-origin browser loader and defense-in-depth validator for `./data/offers.json` (`isSameOriginPath` on `'self'`, 1 MB cap, `<= 6 h` expiry / `> 30 min` stale badge, `<= 5 min` future skew). Sample snapshots (`sample: true`) never render as live offers. Re-runs `decodeInvite()` and `requirePinnedContract()` on every offer's `code`, rejects `bob_eth === contract` and zero address, verifies `event_id` leading zero bits against `pow_bits`, ignores untrusted numeric/network/address fields, drops expired offers, and independently recomputes heartbeat-only maker liveness buckets (`online` `<= 15 min` only with signed heartbeat, `recent` `<= 2 h`, `stale` `> 2 h`), neutral duplicate payload counts across keys, and repeated Bob address flags.
- `data/offers.json`: Default shipped snapshot clearly labelled `"sample": true` with `"offers": []` (empty live-ready default — zero fake mainnet offers, clean HTTP 200 for local preview).
- `scripts/nostr-crypto.mjs`: Zero-dependency BIP-340 Schnorr (`BigInt` secp256k1 + `node:crypto` SHA-256), NIP-01 canonical serialization/event-id verification, and NIP-13 proof-of-work commitment checking/mining. Verified against official BIP-340 test vectors `0..14`.
- `scripts/update-offers.mjs`: Host-only Nostr relay crawler (never run in the browser). Enforces a 10-minute rate limit (`--force` only for tests/manual runs; ignores `sample: true`, malformed, or `> 5 min` future `generated_at`), strict `wss://` public relay URL rules (`ws://127.0.0.1` only via explicit `--allow-local-test`), 10 s timeout per relay, parser-level `maxPayloadSize` and `maxFragments` bounds on Node's built-in `WebSocket`, 1 MB cumulative byte cap, 256 KB frame cap, independent per-filter 500-event budgets, bounded `until` pagination for offers (Pass 1), author-scoped follow-up queries for heartbeats and NIP-09 deletions (Pass 2), clean socket teardown, and truncated-but-usable cap handling so no unauthenticated poster can force healthy relays to fail. Poster-side policy failures (oversize, shape, off-filter, low PoW) are dropped without counting as relay violations; violations are reserved for relay-protocol faults. Validates every event as hostile input (NIP-01 `id`, BIP-340 Schnorr signature, NIP-13 PoW, NIP-40 expiration, `<= 5 min` future skew, `decodeInvite()`, `requirePinnedContract()`, `bob_eth` safety, mainnet `1 ETH / 2,500 NOID` and Sepolia `0.01 ETH / 20 NOID` caps, allowed `contract_version`, note sanitization rejecting embedded `no1dinv1:` codes, NIP-33 `(pubkey, d)` replacement before expiry, NIP-09 `kind: 5` owner deletions, `kind: 32872` signed maker heartbeats with NIP-33 `online`/`paused`/`offline` replaceability, verified-only relay attribution, neutral duplicate payload counts, and repeated Bob address detection). Self-validates output via `parseOffersSnapshot()` and writes `./data/offers.json` atomically (`tmp` + `fsync` + `rename`, `<= 1 MB`). If all relays fail, exits non-zero and leaves any existing `./data/offers.json` byte-for-byte untouched.
- `test/offers-data.test.js` & `test/update-offers.test.js`: 100% offline `node --test` verification suites covering official BIP-340 test vectors `0..14`, hostile event/relay cases, DoS resilience `(a)/(b)/(c)`, `until` pagination, real loopback WebSocket `queryRelay`, binary frame accounting, heartbeat tag/status replaceability, verified-only relay attribution, browser `event_id` PoW check, rate limiting, atomic writes, fail-closed browser validation, and DOM-free UI checks.

### Updated Files (Offer-Only Surgical Edits)
- `js/board-ui.js`: Loads `./data/offers.json` via `loadSameOriginOffersSnapshot()` (with a same-origin "Refresh offers" button), renders live Nostr offers using `createElement` and `textContent` exclusively with truncated + full-title/copyable poster pubkey, PoW bits, neutral heartbeat-only `Maker online` badge, neutral duplicate payload notice (`Same code from N keys; times are self-declared`), **"Repeated Bob address"** warning, neutral mainnet reference-price diffs (when market snapshot is fresh/unmuted, never ranked by deal quality), and full Nostr metadata inside expandable details.
- `styles/main.css`: Minimal dark-theme styling for `.offer-nostr-meta`, `.offer-pubkey-group`, `.offer-pubkey-val`, and `.offer-copy-warn` (preserving `b2185ed`'s frame guard and `.asset-fact-note`).
- `index.html` & `README.md`: Minimal offer-only updates for same-origin `./data/offers.json` while preserving `connect-src 'self'`, `styles/noscript.css`, frame guard, live market copy, and all dated miner warnings.

### Untouched Files From `b2185ed`
`scripts/update-market.mjs`, `test/update-market.test.js`, `js/market-data.js`, `js/market-ui.js` (already displays the static dated miner warning next to `Unconfirmed`), `data/market.json`, `styles/noscript.css`, `js/site.js`, `js/invite-codec.js`, and `js/sample-offers.js` are all untouched.

## Default Nostr Relays (Live Check `2026-11-26 UTC`)

Live Nostr relay probe conducted `2026-11-26T21:36Z`:

| Relay | Result (`2026-11-26 UTC`) | Included in `DEFAULT_RELAYS` |
|---|---|---|
| `wss://nos.lol` | OK (`EOSE`, 837 ms) | Yes |
| `wss://relay.primal.net` | OK (`EOSE`, 1168 ms) | Yes |
| `wss://relay.snort.social` | OK (`EOSE`, 1434 ms) | Yes |
| `wss://nostr.bitcoiner.social` | OK (`EOSE`, 2025 ms) | Backup (configurable via `--relays`) |
| `wss://relay.damus.io` | Failed (`ws_error`) | Dropped |
| `wss://relay.nostr.band` | Timeout (dead) | Dropped |

## Nostr Public Web Event Conventions

Separate from the desktop program's private/test board (`#t = no1d-swap-v1`), public web offers use:
- **Offer event:** addressable `kind: 32871`, tags `["d", "<32-hex>"]`, `["t", "no1d-swap-web-v1"]`, `["expiration", "<unix-sec>"]` (NIP-40), `["nonce", "<decimal>", "<target>"]` (NIP-13), `["status", "open"|"taken"|"closed"]`, `["invite", "no1dinv1:..."]`, optional `["note", "<short text>"]` (or `no1dinv1:...` as the first token in `content`).
- **Maker heartbeat:** addressable `kind: 32872`, tags `["d", "heartbeat" | "<offer-32-hex-d>"]`, `["t", "no1d-swap-web-v1"]`, optional `["status", "online" | "paused" | "offline"]` (defaults to `"online"`; resolved via NIP-33 `(pubkey, d)` replaceability so newer `"paused"`/`"offline"` replacements supersede older `"online"` heartbeats), optional `["expiration", "<unix-sec>"]`.
- **Withdrawal / deletion:** newer `kind: 32871` with same `(pubkey, d)` and `["status", "closed"]` or `["status", "taken"]` (tombstones remain effective for NIP-33 replaceability within the 24 h offer window even after their own short expiry), or a NIP-09 `kind: 5` deletion signed by the same `pubkey` including `["k", "32871"]` and targeting `["e", "<event-id>"]` or `["a", "32871:<pubkey>:<d>"]`.

## `./data/offers.json` Schema

Maximum file size: `1,048,576` bytes (1 MB). Unknown keys are ignored by the browser loader; all swap terms (amounts, network, contract, Bob addresses) are derived exclusively by decoding `offers[].code` via `decodeInvite()`.

```json
{
  "v": 1,
  "sample": false,
  "generated_at": "2026-11-26T20:30:00Z",
  "min_pow_bits": 16,
  "relays": [
    {
      "url": "wss://nos.lol",
      "ok": true,
      "events_received": 4,
      "events_accepted": 1
    }
  ],
  "offers": [
    {
      "event_id": "<64-char-lowercase-hex>",
      "d": "<32-char-lowercase-hex>",
      "pubkey": "<64-char-lowercase-hex>",
      "created_at": "2026-11-26T20:25:00Z",
      "expires_at": "2026-11-26T22:25:00Z",
      "pow_bits": 18,
      "code": "no1dinv1:...",
      "note": "Optional sanitized short text",
      "liveness": {
        "status": "online",
        "last_seen_at": "2026-11-26T20:28:00Z",
        "has_heartbeat": true
      },
      "flags": {
        "duplicate_payload": false,
        "duplicate_count": 1,
        "distinct_pubkeys": 1,
        "repeated_bob_address": false
      },
      "relays": [
        "wss://nos.lol"
      ]
    }
  ]
}
```

### Snapshot Failure & Freshness Rules
- **All relays failed:** `scripts/update-offers.mjs` exits `1` and leaves any existing `./data/offers.json` byte-for-byte untouched.
- **At least one relay succeeded (including 0 open offers):** writes a fresh validated `./data/offers.json` (`"sample": false`) atomically.
- **Browser freshness thresholds:** `<= 30 min` fresh; `> 30 min` to `6 h` shown with `"stale"` badge; `> 6 h` fails closed (`offersVisible: false`, live offers hidden); `> 5 min` future `generated_at` fails closed.

## GitHub Pages Workflow Step (`.github/workflows/pages.yml`)

Just as `.github/workflows/pages.yml` builds `_site` from `index.html`, `assets/`, `js/`, and `styles/` — excluding the repository's sample `data/market.json` and sample `data/offers.json` so sample data is never deployed — it refreshes `_site/data/offers.json` on the same 10-minute schedule right after the market step, with soft-fail handling so an offers failure never stops the market update or deploy:

```yaml
- name: Fetch the live site's last good offers.json
  timeout-minutes: 1
  continue-on-error: true
  run: |
    mkdir -p _site/data
    curl -fsS --max-time 10 --max-filesize 1048576 --proto '=https' "${{ steps.pages.outputs.base_url }}/data/offers.json" -o _site/data/offers.json || rm -f _site/data/offers.json

- name: Update offers snapshot
  timeout-minutes: 2
  continue-on-error: true
  run: |
    timeout 90 node scripts/update-offers.mjs --out _site/data/offers.json --force \
      || echo "Offers snapshot update failed; keeping last good offers.json if present."
    rm -f _site/data/.offers.json.*.tmp
```

If all relays fail (or the step times out), `update-offers.mjs` leaves the fetched last-good `_site/data/offers.json` untouched and any stray `.offers.json.*.tmp` file is removed before upload; if no previous file existed, the page falls back cleanly to showing the Sepolia-only built-in sample listings.

## Verification

Run all offline tests with Node.js 22+ (zero external dependencies):

```sh
node --test
```

Result: **59 / 59 tests passing** (43 baseline `b2185ed` tests + 16 new offer tests across `test/offers-data.test.js` and `test/update-offers.test.js`).
