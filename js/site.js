/* No1d Swap Public Website — Front-door interactions
 * Handles:
 *  - Accessible 6-step swap timeline walkthrough
 *  - OS download & signature verification tab switcher
 *  - Copy-to-clipboard buttons with visual confirmation and read-back toast
 *  - Mobile navigation menu toggle
 *
 * Security notes:
 *  - Uses textContent and explicit DOM nodes only (no HTML-string sinks or dynamic code evaluation).
 *  - Zero external network requests, zero cookies, zero wallet probes.
 */

import { PROTOCOL_CONSTANTS } from "./sample-offers.js";

/* Frame guard. GitHub Pages cannot send frame-ancestors, so the page refuses to
 * run inside another page: the CSS keeps the body hidden until this check has
 * set data-frame-check on <html>. A cross-origin access error counts as framed. */
function isFramed() {
  try {
    return window.top !== window.self;
  } catch {
    return true;
  }
}

const FRAMED = isFramed();
if (FRAMED) {
  const body = document.body;
  while (body.firstChild) body.removeChild(body.firstChild);
  const note = document.createElement("p");
  note.className = "frame-guard-note";
  note.textContent = "This page cannot be shown inside another page. ";
  const link = document.createElement("a");
  link.href = window.location.href;
  link.target = "_top";
  link.rel = "noopener noreferrer";
  link.textContent = "Open it directly";
  note.appendChild(link);
  body.appendChild(note);
  document.documentElement.setAttribute("data-frame-check", "framed");
} else {
  document.documentElement.setAttribute("data-frame-check", "ok");
}

const SWAP_STEPS = Object.freeze([
  Object.freeze({
    title: "1. Bob saves or copies an invitation",
    actor: "Bob · Desktop app",
    body: "Bob saves an invitation file or copies a one-line no1dinv1: code containing only public fields: network, amounts, pinned contract, and Bob's NOID and ETH addresses. No secret ever appears in an invitation. Alice opens or pastes it into her desktop app to pre-fill her form, and checks every value locally.",
    meta: [
      { text: "Public fields only — zero secrets", tone: "safe" },
      { text: "Pre-fill only — never starts a swap", tone: "neutral" },
    ],
  }),
  Object.freeze({
    title: "2. Alice prepares with fresh throwaway keys",
    actor: "Alice · Desktop app",
    body: "Alice presses Prepare. Her desktop program creates fresh per-swap wallets (one NOID wallet and one Ethereum key, so main wallets are untouched) and a fresh 32-byte secret from the OS random generator, then writes the swap file. Prepare starts the clock, so both people should be at their screens.",
    meta: [
      { text: "One throwaway wallet pair per swap", tone: "safe" },
      { text: "Starts the Parano1d deadline clock", tone: "due" },
    ],
  }),
  Object.freeze({
    title: "3. Match the 4×4 check line out-of-band",
    actor: "Alice & Bob · Separate channel",
    body: "Alice saves a copy of the swap file for Bob. Bob loads it and his desktop app verifies every term locally. Both screens display a check line—four groups of four digits. Alice and Bob compare the two lines over a separate channel (call, chat, or in person) and each confirms that they match.",
    meta: [
      { text: "Four groups of four digits", tone: "safe" },
      { text: "Catches tampered files or addresses", tone: "due" },
    ],
  }),
  Object.freeze({
    title: "4. One explicit approval each",
    actor: "Alice & Bob · Desktop app",
    body: "Each side approves once, confirming exactly what they give and what they get. Bob's approval also records the live Parano1d mining share (the swap tool refuses above 35%, and Bob's approval refuses above 65% on mainnet) and states that he swaps only with someone he has a reason to trust.",
    meta: [
      { text: "Mainnet cap: 20,000 NOID / 1 ETH", tone: "safe" },
      { text: "Bob's miner screen: 35% default / 65% hard ceiling", tone: "due" },
    ],
  }),
  Object.freeze({
    title: "5. Both fund their throwaway swap addresses in the app",
    actor: "Alice & Bob · Desktop app",
    body: "Inside their own desktop apps (never through this website), Alice deposits NOID and Bob deposits ETH to the throwaway swap addresses their apps generated, with a live countdown for Alice. Any short deposit is flagged automatically with the missing amount and full deposit address.",
    meta: [
      { text: "Deposits happen in the desktop app only", tone: "safe" },
      { text: "Short deposits flagged automatically", tone: "due" },
    ],
  }),
  Object.freeze({
    title: "6. Autopilot settles (~50 min) or deadlines refund",
    actor: "Both desktop apps",
    body: "Behind dry-runs and safety gates, Alice's app funds the Parano1d contract first, Bob's app locks ETH second, Alice reveals the secret on Ethereum to take the ETH, Bob reads that secret to claim the NOID, and both apps sweep leftovers to your payout addresses. If the swap stops, Bob's ETH refunds after ~2 h 20 m and Alice's NOID after ~6 h 45 m.",
    meta: [
      { text: "Usual settlement: ~50 min (finality included)", tone: "safe" },
      { text: "Keep both machines on until done (~75 min claim window)", tone: "due" },
    ],
  }),
]);

/**
 * Display a brief accessible toast message with copy read-back.
 * @param {string} message
 */
function showToast(message) {
  const region = document.getElementById("toast-region");
  if (!region) return;

  // Keep toast stack lean (at most 2 visible)
  while (region.children.length >= 2) {
    region.removeChild(region.firstElementChild);
  }

  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = message;
  region.appendChild(toast);

  window.setTimeout(() => {
    if (toast.parentNode === region) {
      region.removeChild(toast);
    }
  }, 3600);
}

/**
 * Format a compact read-back preview for clipboard confirmation.
 * Keeps short values whole and shows unambiguous prefix + suffix for long strings.
 * @param {string} value
 * @returns {string}
 */
function formatReadback(value) {
  const clean = value.replace(/\s+/g, " ").trim();
  if (clean.length <= 48) return clean;
  return `${clean.slice(0, 20)}…${clean.slice(-14)}`;
}

/**
 * Copy text to clipboard using Clipboard API with a read-only textarea fallback.
 * @param {string} text
 * @returns {Promise<boolean>}
 */
async function copyText(text) {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to selection fallback below.
    }
  }

  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.className = "sr-only";
    document.body.appendChild(area);
    area.select();
    area.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

/**
 * Wire up the mobile navigation toggle.
 */
function initMobileNav() {
  const toggle = document.getElementById("nav-toggle");
  const nav = document.getElementById("site-nav");
  if (!toggle || !nav) return;

  const setOpen = (open) => {
    nav.classList.toggle("is-open", open);
    toggle.setAttribute("aria-expanded", String(open));
    toggle.textContent = open ? "Close" : "Menu";
  };

  toggle.addEventListener("click", () => {
    const isOpen = toggle.getAttribute("aria-expanded") === "true";
    setOpen(!isOpen);
  });

  nav.addEventListener("click", (event) => {
    const target = event.target;
    if (target instanceof HTMLElement && target.closest("a.nav-link")) {
      setOpen(false);
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && toggle.getAttribute("aria-expanded") === "true") {
      setOpen(false);
      toggle.focus();
    }
  });
}

/**
 * Wire up the interactive 6-step swap timeline.
 */
function initTimeline() {
  const root = document.getElementById("swap-timeline");
  if (!root) return;

  const tabs = Array.from(root.querySelectorAll(".timeline-step[data-step]"));
  const detail = document.getElementById("timeline-detail");
  const titleEl = document.getElementById("timeline-detail-title");
  const actorEl = document.getElementById("timeline-detail-actor");
  const bodyEl = document.getElementById("timeline-detail-body");
  const metaEl = document.getElementById("timeline-detail-meta");
  const prevBtn = document.getElementById("timeline-prev");
  const nextBtn = document.getElementById("timeline-next");
  const counterEl = document.getElementById("timeline-counter");

  if (!tabs.length || !detail || !titleEl || !actorEl || !bodyEl || !metaEl) return;

  let activeIndex = 0;

  const renderStep = (index, moveFocus = false) => {
    const clamped = Math.max(0, Math.min(SWAP_STEPS.length - 1, index));
    activeIndex = clamped;
    const step = SWAP_STEPS[clamped];

    tabs.forEach((btn, idx) => {
      const selected = idx === clamped;
      btn.setAttribute("aria-selected", String(selected));
      btn.classList.toggle("is-active", selected);
      btn.classList.toggle("is-done", idx < clamped);
      btn.tabIndex = selected ? 0 : -1;
    });

    detail.setAttribute("aria-labelledby", tabs[clamped].id);
    titleEl.textContent = step.title;
    actorEl.textContent = step.actor;
    bodyEl.textContent = step.body;

    // Rebuild metadata chips using explicit DOM nodes.
    while (metaEl.firstChild) {
      metaEl.removeChild(metaEl.firstChild);
    }
    for (const item of step.meta) {
      const chip = document.createElement("span");
      chip.className = item.tone === "safe"
        ? "chip chip-safe"
        : item.tone === "due"
          ? "chip chip-due"
          : "chip";
      chip.textContent = item.text;
      metaEl.appendChild(chip);
    }

    if (counterEl) {
      counterEl.textContent = `${clamped + 1} / ${SWAP_STEPS.length}`;
    }
    if (prevBtn) {
      prevBtn.disabled = clamped === 0;
    }
    if (nextBtn) {
      nextBtn.disabled = clamped === SWAP_STEPS.length - 1;
    }

    if (moveFocus) {
      tabs[clamped].focus();
    }
  };

  tabs.forEach((btn, idx) => {
    btn.addEventListener("click", () => renderStep(idx));
    btn.addEventListener("keydown", (event) => {
      if (event.key === "ArrowRight" || event.key === "ArrowDown") {
        event.preventDefault();
        renderStep((idx + 1) % SWAP_STEPS.length, true);
      } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
        event.preventDefault();
        renderStep((idx - 1 + SWAP_STEPS.length) % SWAP_STEPS.length, true);
      } else if (event.key === "Home") {
        event.preventDefault();
        renderStep(0, true);
      } else if (event.key === "End") {
        event.preventDefault();
        renderStep(SWAP_STEPS.length - 1, true);
      }
    });
  });

  if (prevBtn) {
    prevBtn.addEventListener("click", () => renderStep(activeIndex - 1));
  }
  if (nextBtn) {
    nextBtn.addEventListener("click", () => renderStep(activeIndex + 1));
  }

  renderStep(0);
}

/**
 * Wire up the macOS / Windows download & verification tabs.
 */
function initDownloadTabs() {
  const container = document.getElementById("download-tabs");
  if (!container) return;

  const tabs = Array.from(container.querySelectorAll("[data-os-tab]"));
  if (!tabs.length) return;

  const selectOs = (osName, moveFocus = false) => {
    tabs.forEach((tab) => {
      const isSelected = tab.dataset.osTab === osName;
      tab.setAttribute("aria-selected", String(isSelected));
      tab.tabIndex = isSelected ? 0 : -1;
      const panelId = tab.getAttribute("aria-controls");
      const panel = panelId ? document.getElementById(panelId) : null;
      if (panel) {
        panel.hidden = !isSelected;
      }
      if (isSelected && moveFocus) {
        tab.focus();
      }
    });
  };

  tabs.forEach((tab, idx) => {
    tab.addEventListener("click", () => {
      if (tab.dataset.osTab) selectOs(tab.dataset.osTab);
    });
    tab.addEventListener("keydown", (event) => {
      if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
        event.preventDefault();
        const nextIdx = event.key === "ArrowRight"
          ? (idx + 1) % tabs.length
          : (idx - 1 + tabs.length) % tabs.length;
        const nextOs = tabs[nextIdx].dataset.osTab;
        if (nextOs) selectOs(nextOs, true);
      } else if (event.key === "Home") {
        event.preventDefault();
        const firstOs = tabs[0].dataset.osTab;
        if (firstOs) selectOs(firstOs, true);
      } else if (event.key === "End") {
        event.preventDefault();
        const lastOs = tabs[tabs.length - 1].dataset.osTab;
        if (lastOs) selectOs(lastOs, true);
      }
    });
  });

  // Polite local default based on OS user-agent string (no network or tracking).
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  const defaultOs = /Windows/i.test(ua) ? "windows" : "macos";
  selectOs(defaultOs);
}

/**
 * Wire up all declarative copy buttons ([data-copy-text]).
 */
function initCopyButtons() {
  const timers = new WeakMap();

  document.addEventListener("click", async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const btn = target.closest("button[data-copy-text]");
    if (!(btn instanceof HTMLButtonElement)) return;

    const text = btn.dataset.copyText;
    if (!text) return;

    const label = btn.dataset.copyLabel || "Value";
    if (!btn.dataset.origLabel) {
      btn.dataset.origLabel = btn.textContent ? btn.textContent.trim() : "Copy";
    }

    const ok = await copyText(text);
    const prevTimer = timers.get(btn);
    if (prevTimer) window.clearTimeout(prevTimer);

    if (ok) {
      btn.classList.add("is-copied");
      btn.textContent = "Copied";
      showToast(`${label} copied: ${formatReadback(text)}`);
    } else {
      btn.textContent = "Copy failed";
      showToast(`Clipboard blocked — select and copy ${label} manually.`);
    }

    const resetTimer = window.setTimeout(() => {
      btn.classList.remove("is-copied");
      btn.textContent = btn.dataset.origLabel || "Copy";
    }, 2200);
    timers.set(btn, resetTimer);
  });
}

/**
 * Keep version labels, installer filenames, and verification commands synced
 * from PROTOCOL_CONSTANTS (single source of truth).
 */
function syncReleaseConstants() {
  const versionLabel = `v${PROTOCOL_CONSTANTS.version}`;
  const macFile = PROTOCOL_CONSTANTS.installers.macosArm64;
  const winFile = PROTOCOL_CONSTANTS.installers.windows;
  const commands = {
    notice: PROTOCOL_CONSTANTS.verifyCommands.notice,
    macSha256: PROTOCOL_CONSTANTS.verifyCommands.macSha256,
    winSha256: PROTOCOL_CONSTANTS.verifyCommands.winSha256,
    macAttestation: `gh attestation verify ${macFile} --repo ${PROTOCOL_CONSTANTS.repo}`,
    winAttestation: `gh attestation verify ${winFile} --repo ${PROTOCOL_CONSTANTS.repo}`,
  };

  document.querySelectorAll("[data-release-version]").forEach((el) => {
    el.textContent = versionLabel;
  });
  document.querySelectorAll("[data-installer-mac]").forEach((el) => {
    el.textContent = macFile;
  });
  document.querySelectorAll("[data-installer-win]").forEach((el) => {
    el.textContent = winFile;
  });
  document.querySelectorAll("[data-cmd-text]").forEach((el) => {
    const key = el.dataset.cmdText;
    if (key && Object.prototype.hasOwnProperty.call(commands, key)) {
      el.textContent = commands[key];
    }
  });
  document.querySelectorAll("button[data-copy-cmd]").forEach((btn) => {
    const key = btn.dataset.copyCmd;
    if (key && Object.prototype.hasOwnProperty.call(commands, key)) {
      btn.dataset.copyText = commands[key];
    }
  });
}

function initSite() {
  syncReleaseConstants();
  initMobileNav();
  initTimeline();
  initDownloadTabs();
  initCopyButtons();
}

if (!FRAMED) {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initSite);
  } else {
    initSite();
  }
}
