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
