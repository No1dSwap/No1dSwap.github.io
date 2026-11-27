/**
 * No1d Swap Public Website — Asset Prices, Small Facts Strip & Local Rate Calculator
 *
 * Mounts into `#market-strip-root` using `document.createElement` and
 * `textContent` exclusively (zero HTML-string sinks, zero inline styles,
 * zero external hosts).
 *
 * Security & honesty invariants:
 * - Same-origin ONLY: loads `./data/market.json` via `loadSameOriginSnapshot()`.
 * - Fails closed to `"Prices unavailable"` on fetch failure, >1 MB, or invalid fields.
 * - Age thresholds: <= 30 min fresh; > 30 min..6 h greyed out with "stale";
 *   > 6 h hides prices ("Prices unavailable").
 * - When `noid_usd === null`, renders no NOID USD price and never invents one.
 * - Display only: prices never enter invitation codes, `no1d-invite:` links,
 *   the Inspector, or any copy text.
 */

import {
  MARKET_SNAPSHOT_URL,
  computeSwapEstimate,
  formatAgeLabel,
  formatQuoteNumber,
  formatUsd,
  formatUsdVolume,
  loadSameOriginSnapshot,
  setCurrentSnapshot,
} from "./market-data.js";
import { PROTOCOL_CONSTANTS } from "./sample-offers.js";

const DISCLAIMER_TEXT =
  "Reference only — No1d Swap does not set a price; agree on terms with your counterparty.";

// ---------------------------------------------------------------------------
// Safe DOM helpers (createElement + textContent only)
// ---------------------------------------------------------------------------

function el(tag, attrs = null, children = null) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "className") {
        node.className = v;
      } else if (k === "text") {
        node.textContent = String(v);
      } else if (k === "hidden") {
        node.hidden = Boolean(v);
      } else if (k === "disabled") {
        node.disabled = Boolean(v);
      } else if (k === "value") {
        node.value = String(v);
      } else if (k === "type") {
        node.type = String(v);
      } else if (k === "on" && typeof v === "object") {
        for (const [ev, handler] of Object.entries(v)) {
          node.addEventListener(ev, handler);
        }
      } else {
        node.setAttribute(k, v === true ? "" : String(v));
      }
    }
  }
  if (children !== null && children !== undefined) {
    const list = Array.isArray(children) ? children : [children];
    for (const child of list) {
      if (child === null || child === undefined || child === false) continue;
      if (typeof child === "string" || typeof child === "number") {
        node.appendChild(document.createTextNode(String(child)));
      } else {
        node.appendChild(child);
      }
    }
  }
  return node;
}

function clearNode(node) {
  while (node.firstChild) {
    node.removeChild(node.firstChild);
  }
}

function formatUtcShort(isoStr) {
  if (!isoStr || typeof isoStr !== "string") return "—";
  const d = new Date(isoStr);
  if (Number.isNaN(d.getTime())) return "—";
  const yyyy = String(d.getUTCFullYear()).padStart(4, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const min = String(d.getUTCMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${min} UTC`;
}

// ---------------------------------------------------------------------------
// Mount Market Strip & Local Rate Calculator
// ---------------------------------------------------------------------------

const STATIC_PRODUCER_WARNING =
  "Measured on 2026-11-23: one producer mined about 75 % of recent Parano1d blocks.";

/**
 * Mounts `#market-strip-root` and loads the same-origin `./data/market.json` snapshot.
 * Optional `options` allows injecting a pre-parsed snapshot or custom `fetchImpl`/`nowMs`
 * for deterministic testing.
 * @param {{ snapshot?: object, fetchImpl?: typeof fetch, nowMs?: number }} [options]
 */
export async function mountMarketStrip(options = {}) {
  const root = document.getElementById("market-strip-root");
  if (!root) return null;

  const state = {
    snapshot: null,
    loading: false,
    userEditedEthUsd: false,
    userEditedNoidUsd: false,
  };

  clearNode(root);

  const strip = el("div", { className: "market-strip" });

  // 1. Header row (status badges, timestamp, refresh button)
  const statusBadgesBox = el("div", { className: "market-status-row" });
  const updatedText = el("span", {
    className: "market-updated num",
    text: "Loading same-origin snapshot…",
  });
  const refreshBtn = el("button", {
    type: "button",
    className: "btn btn-ghost btn-sm",
    text: "Refresh snapshot",
  });
  const head = el("div", { className: "market-head" }, [
    statusBadgesBox,
    el("div", { className: "market-status-row" }, [updatedText, refreshBtn]),
  ]);

  // 2. Asset Cards container (NOID & ETH)
  const assetGrid = el("div", { className: "asset-grid" });

  // 3. Small Facts Bar (Parano1d top producer, ETH gas, swap time, refund deadlines)
  const factsBar = el("div", {
    className: "market-facts-bar",
    role: "region",
    "aria-label": "Network and swap timing facts",
  });

  // 4. Local Rate Calculator (100% local, zero network calls)
  const sideSelect = el(
    "select",
    {
      id: "calc-side",
      className: "form-select",
    },
    [
      el("option", { value: "noid", text: "Enter NOID → estimate ETH" }),
      el("option", { value: "eth", text: "Enter ETH → estimate NOID" }),
    ],
  );
  sideSelect.value = "noid";

  const amountInput = el("input", {
    id: "calc-amount",
    type: "text",
    inputmode: "decimal",
    autocomplete: "off",
    spellcheck: "false",
    className: "form-input mono",
    value: "100",
    placeholder: "100",
  });

  const ethUsdInput = el("input", {
    id: "calc-eth-usd",
    type: "text",
    inputmode: "decimal",
    autocomplete: "off",
    spellcheck: "false",
    className: "form-input mono",
    placeholder: "Reference ETH USD",
  });

  const noidUsdInput = el("input", {
    id: "calc-noid-usd",
    type: "text",
    inputmode: "decimal",
    autocomplete: "off",
    spellcheck: "false",
    className: "form-input mono",
    placeholder: "Reference NOID USD",
  });

  const calcPrimary = el("span", { className: "calc-primary-val num" });
  const calcSecondary = el("span", { className: "calc-secondary-val num" });
  const calcCapNote = el("span", { className: "calc-cap-note" });

  const calcResultRow = el(
    "div",
    { className: "calc-result-row", "aria-live": "polite" },
    [
      el("div", { className: "calc-output" }, [calcPrimary, calcSecondary]),
      calcCapNote,
    ],
  );

  const calcPanel = el("div", { className: "calc-panel" }, [
    el("div", { className: "calc-head" }, [
      el("h3", { className: "calc-title", text: "Local rate calculator" }),
      el("span", {
        className: "badge badge-neutral",
        text: "Local math only · zero network calls",
      }),
    ]),
    el("div", { className: "calc-grid" }, [
      el("div", { className: "calc-field" }, [
        el("label", { className: "form-label", for: "calc-side", text: "Direction" }),
        sideSelect,
      ]),
      el("div", { className: "calc-field" }, [
        el("label", { className: "form-label", for: "calc-amount", text: "Amount" }),
        amountInput,
      ]),
      el("div", { className: "calc-field" }, [
        el("label", {
          className: "form-label",
          for: "calc-eth-usd",
          text: "Local ETH reference (USD)",
        }),
        ethUsdInput,
      ]),
      el("div", { className: "calc-field" }, [
        el("label", {
          className: "form-label",
          for: "calc-noid-usd",
          text: "Local NOID reference (USD)",
        }),
        noidUsdInput,
      ]),
    ]),
    calcResultRow,
  ]);

  // 5. Disclaimer footer
  const disclaimer = el("p", {
    className: "market-disclaimer",
    text: `${DISCLAIMER_TEXT} Display only — prices never enter invitation codes, no1d-invite: links, the Inspector, or copied text.`,
  });

  strip.appendChild(head);
  strip.appendChild(assetGrid);
  strip.appendChild(factsBar);
  strip.appendChild(calcPanel);
  strip.appendChild(disclaimer);
  root.appendChild(strip);

  // -------------------------------------------------------------------------
  // Render helpers
  // -------------------------------------------------------------------------

  function renderCalculator() {
    const est = computeSwapEstimate({
      amount: amountInput.value,
      side: sideSelect.value,
      ethUsd: ethUsdInput.value,
      noidUsd: noidUsdInput.value,
    });

    calcCapNote.className = "calc-cap-note";
    if (!est.ok) {
      calcPrimary.textContent = "—";
      calcSecondary.textContent = est.error;
      calcCapNote.textContent =
        "Caps: 2,500 NOID / 1 ETH mainnet · 20 NOID / 0.01 ETH Sepolia";
      return;
    }

    if (est.side === "noid") {
      calcPrimary.textContent = `${formatQuoteNumber(est.noidAmount, 6)} NOID ≈ ${formatQuoteNumber(est.ethAmount, 6)} ETH`;
    } else {
      calcPrimary.textContent = `${formatQuoteNumber(est.ethAmount, 6)} ETH ≈ ${formatQuoteNumber(est.noidAmount, 6)} NOID`;
    }
    calcSecondary.textContent = `Indicative value ${formatUsd(est.usdValue)} · 1 ETH ≈ ${formatQuoteNumber(est.impliedNoidPerEth, 2)} NOID`;
    calcCapNote.textContent = est.capLabel;
    if (est.capStatus === "exceeds_mainnet") {
      calcCapNote.classList.add("is-over");
    } else if (est.capStatus === "mainnet_only") {
      calcCapNote.classList.add("is-warn");
    }
  }

  function makeFactCell(label, value) {
    return el("div", { className: "asset-fact" }, [
      el("span", { className: "asset-fact-label", text: label }),
      el("span", { className: "asset-fact-val num", text: value }),
    ]);
  }

  function renderSnapshot(snap) {
    state.snapshot = snap;
    setCurrentSnapshot(snap);

    const isStaleDisplay = Boolean(snap && snap.ok && snap.isStale && !snap.isExpired);
    const isHidden = !snap || !snap.ok || snap.isExpired;

    strip.className = isStaleDisplay ? "market-strip is-stale" : "market-strip";

    // Header badges
    clearNode(statusBadgesBox);
    statusBadgesBox.appendChild(
      el("span", { className: "badge badge-neutral", text: "Reference only" }),
    );
    if (snap && snap.ok && snap.isSample) {
      statusBadgesBox.appendChild(
        el("span", { className: "badge badge-due", text: "Sample data" }),
      );
    }
    if (isStaleDisplay) {
      statusBadgesBox.appendChild(
        el("span", { className: "badge badge-due", text: "stale" }),
      );
    }
    if (isHidden) {
      statusBadgesBox.appendChild(
        el("span", {
          className: "badge badge-alarm",
          text: "Prices unavailable",
        }),
      );
    }

    // Header timestamp
    if (!snap || !snap.ok) {
      updatedText.textContent = "Prices unavailable";
    } else if (snap.isExpired) {
      updatedText.textContent = `Prices unavailable — snapshot older than 6 h (${formatUtcShort(snap.generatedAtUtc)})`;
    } else {
      const ageText = formatAgeLabel(snap.ageMs);
      const staleSuffix = isStaleDisplay ? " · stale" : "";
      updatedText.textContent = `Updated ${formatUtcShort(snap.generatedAtUtc)} · ${ageText}${staleSuffix}`;
    }

    // Asset Cards (NOID + ETH)
    clearNode(assetGrid);

    const staleCls = isStaleDisplay ? " is-stale" : "";
    const shareUnconfirmed = Boolean(
      snap &&
        snap.ok &&
        snap.parano1d &&
        (snap.parano1d.topProducerSharePct === null ||
          snap.parano1d.shareUnavailable),
    );
    const shareStale = Boolean(
      snap &&
        snap.ok &&
        snap.parano1d &&
        !shareUnconfirmed &&
        snap.parano1d.shareStale,
    );
    const topProducerFact = shareUnconfirmed
      ? "Unconfirmed"
      : snap && snap.ok && snap.parano1d
        ? `${formatQuoteNumber(snap.parano1d.topProducerSharePct, 1)}% / ${snap.parano1d.windowBlocks} blk${snap.parano1d.shareSingleSource ? " (1 source)" : ""}${shareStale ? " (stale)" : ""}`
        : `${PROTOCOL_CONSTANTS.minerConcentration.recentProducerPct} (${PROTOCOL_CONSTANTS.minerConcentration.recentProducerDateUtc})`;

    // --- NOID Card ---
    const noidMuted = Boolean(
      snap && snap.ok && (isStaleDisplay || snap.noidPriceMuted),
    );
    const noidMutedCls = noidMuted ? " is-stale" : "";

    const noidHeadBadges = [];
    if (snap && snap.ok && snap.hasNoidPrice && snap.noidLowVolume) {
      noidHeadBadges.push(
        el("span", {
          className: "badge badge-due",
          text: "thin 24 h volume (< $10,000)",
        }),
      );
    }
    if (snap && snap.ok && snap.hasNoidPrice && snap.noidPriceStale) {
      noidHeadBadges.push(
        el("span", {
          className: "badge badge-due",
          text: isStaleDisplay ? "stale" : "venue stale",
        }),
      );
    } else if (isStaleDisplay) {
      noidHeadBadges.push(
        el("span", { className: "badge badge-due", text: "stale" }),
      );
    }
    if (noidHeadBadges.length === 0 && snap && snap.ok && snap.isSample) {
      noidHeadBadges.push(
        el("span", { className: "badge badge-neutral", text: "Sample data" }),
      );
    }

    const noidPriceChildren = [];
    if (isHidden) {
      noidPriceChildren.push(
        el("span", { className: "asset-price", text: "Prices unavailable" }),
        el("span", {
          className: "asset-subprice",
          text:
            snap && snap.isExpired
              ? "Snapshot older than 6 h — prices hidden"
              : "Same-origin snapshot unavailable",
        }),
      );
    } else if (!snap.hasNoidPrice) {
      // noid_usd === null or NOID venue quote > 6 h: show NO NOID USD price and NEVER invent one
      noidPriceChildren.push(
        el("span", { className: "asset-price", text: "—" }),
        el("span", {
          className: "asset-subprice",
          text: snap.noidPriceExpired
            ? "NOID venue quote older than 6 h — hidden"
            : "No NOID USD quote in snapshot",
        }),
      );
    } else {
      const noidUsdText = formatUsd(snap.noidUsd);
      const noidSubText =
        snap.impliedNoidPerEth !== null
          ? `1 ETH ≈ ${formatQuoteNumber(snap.impliedNoidPerEth, 2)} NOID`
          : "Implied NOID/ETH unavailable (no ETH quote)";
      const venuePart = snap.noidUsdVenue || snap.sources.noidUsd;
      const volPart = `24 h vol ${formatUsdVolume(snap.noidVolume24hUsd)}`;
      const tsAgePart =
        snap.noidPriceAgeMs !== null
          ? `${formatAgeLabel(snap.noidPriceAgeMs)} (${formatUtcShort(snap.noidPriceTsUtc)})`
          : formatAgeLabel(snap.ageMs);

      noidPriceChildren.push(
        el("span", {
          className: `asset-price${noidMutedCls}`,
          text: noidUsdText,
        }),
        el("span", {
          className: "asset-subprice num",
          text: noidSubText,
        }),
        el("span", {
          className: "asset-source",
          text: `${venuePart} · ${volPart} · ${tsAgePart}`,
        }),
        el("span", {
          className: "asset-source",
          text: "One small exchange; the price can move fast",
        }),
      );
    }

    const noidCard = el(
      "article",
      { className: `asset-card asset-card-noid${noidMutedCls}` },
      [
        el("div", { className: "asset-card-head" }, [
          el("div", { className: "asset-id" }, [
            el("span", { className: "asset-symbol c-noid", text: "NOID" }),
            el("span", { className: "asset-chain", text: "Parano1d" }),
          ]),
          el("div", { className: "offer-badges" }, noidHeadBadges),
        ]),
        el("div", { className: `asset-price-row${noidMutedCls}` }, noidPriceChildren),
        el("div", { className: "asset-facts" }, [
          makeFactCell("Address", "o1… (bech32m)"),
          makeFactCell("Block time", `~${PROTOCOL_CONSTANTS.parano1d.blockNomSeconds} s`),
          makeFactCell("Finality", `${PROTOCOL_CONSTANTS.parano1d.finalityBlocks} blocks`),
          makeFactCell("Mainnet cap", "2,500 NOID"),
          makeFactCell("Top producer", topProducerFact),
          makeFactCell("HTLC", "1-instr Pruv"),
        ]),
      ],
    );

    // --- ETH Card ---
    const ethHeadBadges = [];
    if (isStaleDisplay) {
      ethHeadBadges.push(el("span", { className: "badge badge-due", text: "stale" }));
    } else if (snap && snap.ok && snap.isSample) {
      ethHeadBadges.push(
        el("span", { className: "badge badge-neutral", text: "Sample data" }),
      );
    }

    const ethPriceChildren = [];
    if (isHidden) {
      ethPriceChildren.push(
        el("span", { className: "asset-price", text: "Prices unavailable" }),
        el("span", {
          className: "asset-subprice",
          text:
            snap && snap.isExpired
              ? "Snapshot older than 6 h — prices hidden"
              : "Same-origin snapshot unavailable",
        }),
      );
    } else if (snap.ethUsd === null) {
      ethPriceChildren.push(
        el("span", { className: "asset-price", text: "ETH price unavailable" }),
        el("span", {
          className: "asset-subprice",
          text: "Two-source ETH quote unavailable or disagreed (> 2%)",
        }),
      );
    } else {
      const ethUsdText = formatUsd(snap.ethUsd);
      const ethSubText =
        snap.impliedEthPerNoid !== null
          ? `1 NOID ≈ ${formatQuoteNumber(snap.impliedEthPerNoid, 6)} ETH`
          : "Implied NOID/ETH unavailable (no NOID quote)";
      ethPriceChildren.push(
        el("span", {
          className: `asset-price${staleCls}`,
          text: ethUsdText,
        }),
        el("span", {
          className: "asset-subprice num",
          text: ethSubText,
        }),
        el("span", {
          className: "asset-source",
          text: `ETH ${ethUsdText} · ${snap.sources.ethUsd} · ${formatAgeLabel(snap.ageMs)}${isStaleDisplay ? " · stale" : ""}`,
        }),
      );
    }

    const gasFactText =
      snap && snap.ok && snap.ethGasGwei !== null
        ? `${formatQuoteNumber(snap.ethGasGwei, 2)} gwei`
        : "—";

    const ethCard = el(
      "article",
      { className: `asset-card asset-card-eth${staleCls}` },
      [
        el("div", { className: "asset-card-head" }, [
          el("div", { className: "asset-id" }, [
            el("span", { className: "asset-symbol c-eth", text: "ETH" }),
            el("span", { className: "asset-chain", text: "Ethereum" }),
          ]),
          el("div", { className: "offer-badges" }, ethHeadBadges),
        ]),
        el("div", { className: `asset-price-row${staleCls}` }, ethPriceChildren),
        el("div", { className: "asset-facts" }, [
          makeFactCell("Address", "0x… (EIP-55)"),
          makeFactCell("Slot time", "~12 s"),
          makeFactCell("Finality", "~15–19 min"),
          makeFactCell("Mainnet cap", "1 ETH"),
          makeFactCell("HTLC contract", "0% fee · immutable"),
          makeFactCell("Gas", gasFactText),
        ]),
      ],
    );

    assetGrid.appendChild(noidCard);
    assetGrid.appendChild(ethCard);

    // Small Facts Bar (prominent miner warning, gas, usual swap time, worst-case deadlines)
    clearNode(factsBar);
    const producerDetail = shareUnconfirmed
      ? `Unconfirmed — mainnet Bob cap ${PROTOCOL_CONSTANTS.minerConcentration.bobApprovalCeilingPct}% still applies`
      : snap && snap.ok && snap.parano1d
        ? `${formatQuoteNumber(snap.parano1d.topProducerSharePct, 1)}% over ${snap.parano1d.windowBlocks} blocks · measured ${formatUtcShort(snap.parano1d.measuredAtUtc)}${shareStale ? " · stale" : ""}${snap.parano1d.shareSingleSource ? " · one source (Noidium); the desktop app checks your own node before Bob locks" : ""} · Bob mainnet cap ${PROTOCOL_CONSTANTS.minerConcentration.bobApprovalCeilingPct}%`
        : `${PROTOCOL_CONSTANTS.minerConcentration.recentProducerPct} · measured ${PROTOCOL_CONSTANTS.minerConcentration.recentProducerDateUtc} UTC · Bob mainnet cap ${PROTOCOL_CONSTANTS.minerConcentration.bobApprovalCeilingPct}%`;

    factsBar.appendChild(
      el("div", { className: `market-fact market-fact-warn${shareStale ? " is-stale" : ""}` }, [
        el("span", {
          className: "asset-fact-label",
          text: "Parano1d top producer",
        }),
        el("span", { className: "asset-fact-val num", text: producerDetail }),
        // Static dated warning: shown whether or not the live share is known.
        el("span", { className: "asset-fact-note", text: STATIC_PRODUCER_WARNING }),
      ]),
    );
    factsBar.appendChild(
      el("div", { className: "market-fact" }, [
        el("span", { className: "asset-fact-label", text: "ETH gas" }),
        el("span", { className: "asset-fact-val num", text: gasFactText }),
      ]),
    );
    factsBar.appendChild(
      el("div", { className: "market-fact" }, [
        el("span", { className: "asset-fact-label", text: "Usual swap time" }),
        el("span", {
          className: "asset-fact-val num",
          text: `~${PROTOCOL_CONSTANTS.timings.usualMinutes} min (both sides online)`,
        }),
      ]),
    );
    factsBar.appendChild(
      el("div", { className: "market-fact" }, [
        el("span", {
          className: "asset-fact-label",
          text: "Worst-case refund deadlines",
        }),
        el("span", {
          className: "asset-fact-val num",
          text: `NOID ${PROTOCOL_CONSTANTS.timings.mainnet.aliceRefundBack} after Prepare · ETH ${PROTOCOL_CONSTANTS.timings.mainnet.bobRefundBack} after Bob lock`,
        }),
      ]),
    );

    // Sync calculator reference inputs ONLY if user hasn't manually edited them
    if (!state.userEditedEthUsd) {
      ethUsdInput.value =
        snap && snap.ok && snap.pricesVisible && snap.ethUsd !== null
          ? String(snap.ethUsd)
          : "";
    }
    if (!state.userEditedNoidUsd) {
      noidUsdInput.value =
        snap && snap.ok && snap.pricesVisible && snap.hasNoidPrice && !snap.noidPriceMuted
          ? String(snap.noidUsd)
          : "";
    }

    renderCalculator();
  }

  // Calculator listeners (zero network calls)
  sideSelect.addEventListener("change", renderCalculator);
  amountInput.addEventListener("input", renderCalculator);
  ethUsdInput.addEventListener("input", () => {
    state.userEditedEthUsd = true;
    renderCalculator();
  });
  noidUsdInput.addEventListener("input", () => {
    state.userEditedNoidUsd = true;
    renderCalculator();
  });

  async function fetchAndRender() {
    if (state.loading) return null;
    state.loading = true;
    refreshBtn.disabled = true;
    refreshBtn.textContent = "Refreshing…";
    try {
      const snap = await loadSameOriginSnapshot(
        MARKET_SNAPSHOT_URL,
        options.fetchImpl,
        options.nowMs,
      );
      renderSnapshot(snap);
      return snap;
    } finally {
      state.loading = false;
      refreshBtn.disabled = false;
      refreshBtn.textContent = "Refresh snapshot";
    }
  }

  refreshBtn.addEventListener("click", () => {
    state.userEditedEthUsd = false;
    state.userEditedNoidUsd = false;
    fetchAndRender();
  });

  if (options.snapshot) {
    renderSnapshot(options.snapshot);
    return options.snapshot;
  }
  return fetchAndRender();
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      mountMarketStrip();
    });
  } else {
    mountMarketStrip();
  }
}
