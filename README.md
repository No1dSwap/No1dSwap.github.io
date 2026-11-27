# No1d Swap — Public Website & Static Bulletin Board

A standalone, zero-dependency static website for **No1d Swap** (`00Para/noid-swap`, target release `0.2.0` — upcoming): documentation front door, Sepolia-only sample offer bulletin board, and browser-side `no1dinv1:` invitation code inspector and Sepolia test formatter.

> Release note: version `0.2.0` is upcoming. Once published, confirm exact installer filenames, SHA-256 digests, and verification commands against the signed `release.json` on the Releases page.

## Trust boundary

> The website is just a bulletin board—it never touches keys, never signs anything, and can vanish mid-swap without affecting your funds. The desktop program handles the swap.

- **What this site is:** plain HTML, CSS, SVG, and vanilla ES modules served statically. It explains how No1d Swap works, publishes the Ed25519 release verification commands, displays an optional same-origin reference price snapshot (`./data/market.json`) with a local rate calculator, previews Sepolia-only sample listings, and inspects/formats `no1dinv1:` invitation codes entirely inside your browser.
- **What this site is not:** not a wallet, not a bridge, not an exchange, not a signer, and not a live market. There are zero external scripts, zero CDNs, zero web fonts, zero trackers, zero cookies, zero wallet connections, and zero third-party network calls (the only browser fetches are same-origin `./data/market.json` and `./data/offers.json`).
- **Informational only — never deposit from a website:** every address and amount shown on this site is strictly informational. The desktop program reads every swap term from the invitation code and both chains itself before you approve anything.
- **Code is the single source of truth:** every bulletin-board card and handoff modal renders amounts, network, implied rate, contract, and Bob's addresses strictly by decoding `no1dinv1:` via `decodeInvite()` and enforcing the pinned HTLC contract. Untrusted listing metadata is ignored, unpinned contracts are refused, and built-in Sepolia samples have copy and desktop handoff disabled.
- **Sepolia-only test builder:** the browser invite formatter is restricted to Sepolia test format only and cannot create mainnet offers. For real swaps, Bob must generate his invitation inside the No1d Swap desktop program using a fresh swap key.
- **`no1d-invite:` links are pre-fill only:** a `no1d-invite://invite?code=no1dinv1:...` link only pre-fills Alice's New Swap form, identical to pasting the code. It never approves a swap, never sends a deposit, never starts a step, and never skips the out-of-band 4×4 check-line match. The desktop program (0.2.0) registers no such link handler yet and its paste box takes only the bare `no1dinv1:` code (or the invitation text), so the page copies only the bare code and shows no link button or launch button: copy the code and paste it into the New Swap form. Clicking "Open in Desktop" opens the warning dialog, which rebuilds the code strictly from the decoded canonical code.

## Listing warnings, miner concentration & copied offers

> A listing is not a check. The program checks the terms; the miner limit still applies to the ETH side.

- **Parano1d miner concentration:** one producer has made about **75 %** of recent Parano1d blocks (measured `2026-11-23 UTC`; 45 %–63 % per day over the earlier 20-day measurement window; 52.7 % on `2026-11-08 UTC`). Above half of the hashrate, a stranger acting as Alice can cheat Bob (the ETH seller). Before Bob locks on Ethereum mainnet, the swap tool refuses above **35 %**, and Bob's explicit approval refuses above **65 %**. Swap only with someone you have a reason to trust.
- **Fake and copied offers:** anyone can post a listing; a listing's age, note, and displayed size are untrusted text. Notes are stripped of Unicode bidirectional/control/zero-width characters and length-capped before display. Duplicate detection checks both the canonical `no1dinv1:` payload and Bob's decoded addresses. Any preview added through the Sepolia test builder is kept strictly in browser memory as **Local preview only** and vanishes on reload. If public listings are later fed from Nostr relays (separate from the desktop program's private test board), the board will display each poster's public key and flag duplicate `no1dinv1:` payloads so copies of someone else's offer can be told apart.

## Preview locally

Because the site uses native ES modules (`<script type="module">`), serve it over local HTTP rather than opening `index.html` via `file://`:

```sh
python3 -m http.server 8080
```

or with Node:

```sh
npx serve .
```

Then open `http://localhost:8080` (or the port printed by `serve`). No build step and no `npm install` are required.

## Required HTTP security headers (before public hosting)

`index.html` includes a strict `<meta http-equiv="Content-Security-Policy">` tag (`connect-src 'self'` is strictly for same-origin `./data/market.json` and `./data/offers.json`; zero external hosts are permitted), but directives such as `frame-ancestors` and `require-trusted-types-for` are only enforced when sent as HTTP response headers. Configure your static host or reverse proxy to serve these headers on every response before hosting publicly:

```http
Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; connect-src 'self'; frame-ancestors 'none'; require-trusted-types-for 'script'
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
```

## Build, deploy and the producer-share cross-check

- **Deploy:** `.github/workflows/pages.yml` builds a `_site` folder on GitHub Pages through Actions every 10 minutes (and on manual dispatch). It copies only `index.html`, `assets/`, `js/`, `styles/` and a `.nojekyll` file, so `scripts/`, `test/`, this README, `.github/` and the repository's sample `data/market.json` and `data/offers.json` are never published. No data is committed. Every action is pinned by full commit SHA. GitHub disables a scheduled workflow after 60 days without repository activity.
- **Market file:** each run first downloads the live site's current `data/market.json` as the last good file, then runs `node scripts/update-market.mjs --out _site/data/market.json --soft-fail --no-rate-limit`. The script exits 0 even when sources fail and keeps the previous file; with no previous file and every source failing, no file is written and the page shows "Prices unavailable".
- **Offers file:** after the market step, each run fetches the live site's current `data/offers.json` (10 s, 1 MB cap) as the last good file, then runs `node scripts/update-offers.mjs --out _site/data/offers.json --force` under a 90 s timeout with soft-fail (`continue-on-error: true` and `|| echo ...`). If all relays fail or the step times out, the previous `offers.json` stays intact, any stray `.offers.json.*.tmp` file is removed, and the market update and deploy still proceed; with no previous file, the page falls back to the built-in Sepolia samples.
- **Two sources for the top-producer share:** NoidExplorer `/api/premium/miners?range=4h` gives the 4-hour window (`from`, `to`, `blocks`, top addresses). Noidium `/api/v1/blocks?limit=500` (up to 3 pages, older ones with `&before=<lowest height>`) is read over the same window: canonical blocks only, one per height, counted per miner. Entries are validated strictly; more than 5 % invalid fails the source.
- **Rule:** `top_producer_share_pct` is the explorer's share only if both windows hold at least 300 blocks, the top address is the same in both, and the two top shares differ by at most 3 percentage points. Otherwise, or if either source fails, it is `null` and prices are still written. `window_blocks` is the explorer's block count and `measured_at` its window end.
- **Static warning:** next to the live share the page always shows a dated line ("Measured on 2026-11-23: one producer mined about 76 % of recent Parano1d blocks.").
- **Frame guard:** GitHub Pages cannot send `frame-ancestors`, so `js/site.js` replaces the page with a link to open it directly when it runs inside another page; the body stays hidden by CSS until that check has passed (`styles/noscript.css` shows it when scripting is off).

## Same-origin market snapshot (`./data/market.json`) & host cron

> Reference only — No1d Swap does not set a price; agree on terms with your counterparty.

To keep visitors' browsers from ever contacting third-party price APIs, the **Assets & local rate calculator** strip reads only a same-origin static JSON file (`./data/market.json`) on `'self'`.

- **Default shipped data:** the repository ships clearly labelled `"Sample data"` in `data/market.json`. No host cron is configured by default.
- **Host updater & governance (`scripts/update-market.mjs`):** an optional, offline-tested, zero-dependency Node.js updater (`scripts/update-market.mjs`) is included for hosts that choose to publish live snapshots out-of-band so visitors' browsers still talk only to `'self'`. It writes only `data/market.json` atomically, rate-limits external requests to **at most once every 10 minutes** (ignoring malformed or `> 5 min` future timestamps), enforces 10 s timeouts, 1 MB response caps, and `redirect: "error"`, cross-checks two ETH/USD sources within 2%, allows only fixed NOID venue names, and leaves `parano1d.top_producer_share_pct` as `null` unless two public indexers agree (see "Build, deploy and the producer-share cross-check" below). **Running this host job requires explicit operator consent and owner sign-off — it is never run from the browser.**
- **Desktop isolation:** **the desktop program never reads `./data/market.json`.**
- **Display only (hard line):** prices and offer-vs-reference diffs (`"6% below reference"`, `"4% above reference"`, `"at reference"`) are computed strictly from decoded `no1dinv1:` fields, are shown **only on mainnet offers** when the snapshot is fresh and unmuted, and are **display only**. They never enter invitation codes, `no1d-invite:` links, the Inspector output, or any copied text, and listings are never ranked or sorted by deal quality.
- **Schema & fail-closed validation (max 1 MB = 1,048,576 bytes; unknown keys ignored; all non-null prices finite and `> 0`; `noid_volume_24h_usd >= 0`):**

```json
{
  "v": 1,
  "sample": true,
  "generated_at": "2026-11-26T13:30:00Z",
  "sources": {
    "eth_usd": "Sample data",
    "noid_usd": "Sample data"
  },
  "eth_usd": 3200,
  "noid_usd": 0.64,
  "noid_usd_venue": "Sample venue (not live)",
  "noid_volume_24h_usd": 12500,
  "noid_price_ts": "2026-11-26T13:30:00Z",
  "noid_price_stale": false,
  "parano1d": {
    "top_producer_share_pct": 75.0,
    "window_blocks": 144,
    "measured_at": "2026-11-26T13:30:00Z"
  },
  "eth_gas_gwei": 0.8
}
```

- **Age, venue, and thin-volume thresholds** (timestamps more than 5 min ahead of `now` or calendar rollovers fail the snapshot closed to `"Prices unavailable"`):
  - `<= 30 min`: normal reference display.
  - `> 30 min` to `6 h`: greyed out and labelled `"stale"` (offer-vs-reference diffs omitted).
  - `> 6 h`: prices, producer share, and offer-vs-reference diffs are hidden (`"Prices unavailable"` / `"Unconfirmed"`).
  - **NOID venue & volume guard:** whenever a NOID price is shown, the card displays its venue (`noid_usd_venue`), 24 h volume (`noid_volume_24h_usd`), exchange timestamp (`noid_price_ts`), and `"One small exchange; the price can move fast"`. If `noid_volume_24h_usd < 10000`, `noid_price_stale` is `true`, or `noid_price_ts` is over 30 min old, the NOID price is greyed out with an explicit warning tag, offer-vs-reference diffs are skipped, the calculator does not pre-fill NOID USD (and NOID price is hidden if `noid_price_ts` is over 6 h old).
- **Nullable fields & cross-check failure:**
  - `noid_usd: null`: no NOID USD price is rendered or invented, and implied NOID/ETH rates and offer-vs-reference diffs are omitted.
  - `eth_usd: null` (e.g. if CoinGecko and Kraken disagree by `> 2%`): ETH card shows `"ETH price unavailable"` and implied rates / offer diffs are omitted.
  - `parano1d.top_producer_share_pct: null` (e.g. one of the two indexers failed or disagreed, or `measured_at` is missing or expired): strip displays a neutral `"Unconfirmed"` warning while keeping the 65% mainnet Bob cap reminder.
- **Strict failure:** if the fetch fails, exceeds 1 MB, is invalid JSON, or fails any required field check, the strip fails closed to `"Prices unavailable"` and never falls back to another host.

## Same-origin live Nostr offers (`./data/offers.json`) & host crawler

To discover public P2P offers over Nostr relays without ever letting visitors' browsers connect to third-party WebSocket hosts, the bulletin board reads only a same-origin static JSON file (`./data/offers.json`) on `'self'`.

- **Default shipped data:** `data/offers.json` ships clearly labelled `"sample": true` with `"offers": []` (empty live-ready default — zero fake mainnet offers, zero 404s during local preview). As with `data/market.json`, `.github/workflows/pages.yml` excludes the repository's sample `data/offers.json` and refreshes `_site/data/offers.json` on every 10-minute run with soft-fail handling.
- **Host updater (`scripts/update-offers.mjs` + `scripts/nostr-crypto.mjs`):** zero-dependency Node.js ESM crawler designed for an out-of-band 10-minute cron/Actions job (never run in the browser). Rate-limited to **at most once every 10 minutes** based on existing `offers.json`'s `generated_at` (ignoring malformed or `> 5 min` future timestamps; `--force` only for tests or explicit CLI runs). Queries configured `wss://` relays with 10 s timeout, 1 MB cumulative byte cap (text and binary frames), 256 KB frame cap, 500-event cap, and clean socket teardown.
- **Default relays (checked `2026-11-26 UTC`):** `wss://nos.lol`, `wss://relay.primal.net`, `wss://relay.snort.social` (all returned `EOSE` on `2026-11-26T21:36Z`; `wss://relay.damus.io` and `wss://relay.nostr.band` were dropped after failing/timing out; `wss://nostr.bitcoiner.social` also responded `EOSE` and can be added via `--relays` / `NOSTR_RELAYS`).
- **Hostile event verification & browser defense-in-depth (`js/offers-data.js`):** verifies NIP-01 canonical SHA-256 `id`, BIP-340 Schnorr signature (pure `BigInt` secp256k1 + `node:crypto` SHA-256), NIP-13 committed proof-of-work (`--min-pow`, default 16 bits), NIP-40 expiration, `<= 5 min` future skew, addressable `(pubkey, d)` replacement (`open` / `taken` / `closed`), NIP-09 `kind: 5` owner deletions, `kind: 32872` signed maker heartbeats, and `decodeInvite()` + pinned HTLC contract + caps. The browser re-validates every entry independently (including `event_id` leading zero bits, liveness buckets, copied/duplicate payloads across pubkeys, and repeated Bob addresses). See `OFFERS_CHANGES.md` for full schema and workflow documentation.

## `no1dinv1:` codec parity with No1d Swap

`js/invite-codec.js` is a pure synchronous ES module (runs identically in modern browsers and Node.js) implementing byte-for-byte parity with the desktop program's `ui/app/lib/invitation.js`:

- **Wire format:** `no1dinv1:<unpadded-base64url(utf8(compactJson) || sha256(utf8(compactJson))[0..4])>`
- **Strict 9-key public schema:** `kind` (`"no1d-swap-invitation"`), `v` (`1`), `network` (`"mainnet"` or `"sepolia"`), `contract`, `contract_version`, `noid_micronoid`, `eth_wei`, `bob_noid`, `bob_eth`. Rejects UTF-8 BOMs, duplicate keys, missing keys, unknown/secret keys, non-canonical base64url, damaged checksums, and oversized payloads (JSON ≤ 4,096 bytes; compact code ≤ 6,144 bytes).
- **Canonical code & pinned contract enforcement:** decoding produces a canonical re-encoded `canonicalCode` (invariant across JSON whitespace or key reordering) and checks `contractPinned`. Listings and Inspector actions refuse any code whose HTLC contract does not match the pinned address for its network:
  - **Ethereum Mainnet:** up to `2,500 NOID` and `0.5 ETH`, contract version `1` only (pinned contract `0x4e364cC86EdBF307CC6F336F3a72e1a24d284D70`, code hash `0xf510d2a368c730339fa7cf5e023bcf2429d5732793f043e03025780bb7043ff3`).
  - **Sepolia Testnet:** up to `20 NOID` and `0.01 ETH` (pinned contract `0x48Ce4D6cf3c175737532017e82B9261b51F8E5eF`; Parano1d has no testnet, so the NOID is real).
- **URI format:** `no1d-invite://invite?code=<encoded>` enforces the same size ceiling, pinned contract, and `no1dinv1:` rules, rejecting extra query parameters, credentials, ports, fragments, and unknown schemes.
- **Public notes:** optional notes are sanitized local display metadata only and are never encoded into `no1dinv1:`.

## Run the tests

Requires Node.js 21 or later (zero dependencies):

```sh
node --test
```

This runs `test/invite-codec.test.js`, `test/market-data.test.js`, `test/offers-data.test.js`, `test/update-market.test.js`, and `test/update-offers.test.js` (100% offline), verifying round-trip encoding/decoding, canonical code invariance, SHA-256 checksum rejection, truncation and oversize limits, strict 9-key rejection of extra/secret fields, pinned contract enforcement, display-text bidi/control/invisible-filler sanitization, mainnet and Sepolia cap enforcement, `no1d-invite:` URI validation, Sepolia sample offers, same-origin market snapshot validation, age/venue/volume thresholds, nullable price/share handling, local rate calculations, and the host updater's rate limiting, cross-checks, and atomic writes.

## File layout

| Path | Purpose |
|---|---|
| `index.html` | Static landing page with strict CSP (`connect-src 'self'`), trust boundary, asset strip, swap walkthrough, limits/risks, download verification (`0.2.0`), and widget mount points |
| `styles/tokens.css`, `styles/main.css` | Dark-first design tokens and responsive stylesheet (system fonts only, neutral decode/diff/stale states, zero external assets) |
| `assets/logo.svg`, `assets/protocol-diagram.svg` | Minimal SVG brand mark and trust-boundary / HTLC architecture diagram |
| `data/market.json` | Same-origin static market snapshot (shipped clearly labelled `"Sample data"`) |
| `data/offers.json` | Same-origin static Nostr offers snapshot (shipped clearly labelled `"sample": true` with empty offers array) |
| `scripts/nostr-crypto.mjs` | Zero-dep BIP-340 Schnorr, NIP-01 canonical id/verification, and NIP-13 PoW |
| `scripts/update-offers.mjs` | Zero-dep host Nostr offer crawler (10 min rate limit unless `--force`, 10 s relay timeout, 1 MB cap, BIP-340 + NIP-13 + `decodeInvite()` + pinned contract, atomic write; run by the Pages workflow with soft-fail, never by the browser) |
| `scripts/update-market.mjs` | Zero-dep updater (10 min rate limit unless `--no-rate-limit`, ETH and producer-share cross-checks, atomic write, `--soft-fail`; run by the Pages workflow, never by the browser) |
| `.github/workflows/pages.yml` | GitHub Pages build and deploy (SHA-pinned actions, 10-minute schedule) |
| `styles/noscript.css` | Shows the page when scripting is off (frame guard fallback) |
| `js/site.js` | Front-door interactions (6-step walkthrough, OS verification tabs, copy-to-clipboard, mobile nav, release constant sync) |
| `js/invite-codec.js` | Browser + Node ESM `no1dinv1:` codec, canonicalization, pinned-contract check, text sanitizer, and `no1d-invite:` URI helper |
| `js/sample-offers.js` | Protocol constants (`0.2.0`) and 3 clearly-marked Sepolia-only sample listings (zero mainnet codes) |
| `js/market-data.js` | Same-origin `./data/market.json` validator, age/venue/volume evaluator, reference-diff formatter, and local rate calculator |
| `js/offers-data.js` | Same-origin `./data/offers.json` defense-in-depth loader, validator, liveness evaluator, and copied-offer/repeated-Bob detector |
| `js/market-ui.js` | XSS-safe Asset Prices, Small Facts Strip, and Local Rate Calculator (`#market-strip-root`) |
| `js/board-ui.js` | XSS-safe Bulletin Board (`#bulletin-board-root`) with decoded-only neutral reference diffs and tabbed Invite Inspector & Sepolia Test Builder (`#invite-tool-root`) |
| `OFFERS_CHANGES.md` | Summary of live P2P Nostr discovery changes, `./data/offers.json` schema, relay check, example workflow snippet, and test run |
| `test/*.test.js` | Offline `node:test` verification suites (`invite-codec.test.js`, `market-data.test.js`, `offers-data.test.js`, `update-market.test.js`, `update-offers.test.js`) |
