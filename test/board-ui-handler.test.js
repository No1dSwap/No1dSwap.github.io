import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../js/board-ui.js", import.meta.url), "utf8");

// The desktop program registers no no1d-invite: handler (audit of 0.2.0, L-5): the launch button must stay out of the dialog until a release does.
test("L-5: the handoff dialog shows no launch link while no OS handler is registered", () => {
  assert.match(src, /const OS_INVITE_HANDLER_REGISTERED = false;/);
  assert.match(src, /\.\.\.\(OS_INVITE_HANDLER_REGISTERED \? \[launchLink\] : \[\]\)/);
  assert.doesNotMatch(src, /\n\s*launchLink,\s*\n/, "launchLink is never placed unconditionally");
  assert.doesNotMatch(src, /The OS handler lives inside the desktop program/);
  assert.doesNotMatch(src, /Click "Launch no1d-invite: Link"/);
});

// The 0.2.0 paste box takes only the bare no1dinv1: code or the invitation text and refuses a link as damaged: no button of the page may copy a link.
test("carry-over: no button copies a no1d-invite: string while the handler flag is false", () => {
  assert.match(src, /const OS_INVITE_HANDLER_REGISTERED = false;/);
  assert.doesNotMatch(src, /Copy no1d-invite:/);
  assert.doesNotMatch(src, /Open via no1d-invite:/);
  assert.doesNotMatch(src, /Open in Desktop \(no1d-invite:\)/);
  assert.doesNotMatch(src, /Pre-fill desktop URI/);
  // handleCopyAction is only ever given the canonical code (or a plain label), never a URI
  for (const m of src.matchAll(/handleCopyAction\(\s*([A-Za-z.]+)\s*,/g)) {
    assert.doesNotMatch(m[1], /uri/i, `a copy action is given ${m[1]}`);
  }
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  assert.doesNotMatch(html, /copied code or no1d-invite URI/);
});
