/**
 * y7 — AL7. The terminal-input unregister was captured, guarded on, and never
 * called — and the reason nothing broke belongs to pi, not to us.
 *
 * FIXED, and this probe is mostly a MEASUREMENT rather than a reproduction: it
 * walks pi's own dist to establish who ends this subscription and when, then
 * shows the extension's own end of it.
 *
 * ## The finding
 *
 * `setupEventListeners` subscribes the widget's key handler:
 *
 *     let unregisterTerminalInput: (() => void) | undefined;
 *     …
 *     if (ctx.hasUI && !unregisterTerminalInput) {
 *       unregisterTerminalInput = ctx.ui.onTerminalInput(createNavInputHandler(ctx));
 *     }
 *
 * Two references in the whole package: the assignment, and the guard that reads
 * it as "already done". The one value in the file whose only purpose is to END
 * something had no caller, four lines above a `session_shutdown` handler that
 * disposes the coordinator, the store, the widget and the manager by name.
 *
 * **The question that decides how bad it is is not answerable from this
 * repository**, which is the point: does pi drop the subscription itself? This
 * probe reads pi's dist and answers it. It does — on every session replacement
 * and on the way out — and the extension's factory is re-invoked for the new
 * session, so the guard sees a fresh `undefined` and re-subscribes. Nothing was
 * ever wrong for a user.
 *
 * What makes it worth closing is the failure it WOULD have. The guard is
 * `!unregisterTerminalInput`. A stale handle reads as "still subscribed", so if
 * pi stopped clearing, the widget's arrows, Enter into the viewer and Escape
 * would go dead after the first `/new` — with nothing anywhere to report it.
 *
 *   run: node --experimental-strip-types y7-the-unregister-that-was-never-called.mjs
 */

import { readFileSync } from "node:fs";

const REPO = "/home/claudeuser/qwen3.8-forge";
const PI = "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist";

let failures = 0;
const check = (label, ok) => {
  console.log(`   ${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) failures++;
};

console.log("\ny7 — the unregister that was never called (AL7)\n");

// ── 1. what pi does with the subscription ────────────────────────────────────
const interactive = readFileSync(`${PI}/modes/interactive/interactive-mode.js`, "utf8");
const runtime = readFileSync(`${PI}/core/agent-session-runtime.js`, "utf8");

const lineOf = (haystack, needle) => {
  const at = haystack.indexOf(needle);
  return at < 0 ? undefined : haystack.slice(0, at).split("\n").length;
};

const addLine = lineOf(interactive, "addExtensionTerminalInputListener(handler) {");
const clearLine = lineOf(interactive, "clearExtensionTerminalInputListeners() {");
const resetLine = lineOf(interactive, "resetExtensionUI() {");
const stopClear = interactive.slice(interactive.indexOf("stop(fullscreenExitOutput")).includes(
  "clearExtensionTerminalInputListeners()",
);
const resetBody = interactive.slice(interactive.indexOf("resetExtensionUI() {"));
const resetClears = resetBody.slice(0, resetBody.indexOf("\n    setExtensionFooter") + 200).includes(
  "clearExtensionTerminalInputListeners()",
);
const teardownCalls = runtime
  .slice(runtime.indexOf("async teardownCurrent("))
  .slice(0, 700)
  .includes("beforeSessionInvalidate?.()");
const disposeCalls = runtime
  .slice(runtime.indexOf("async dispose() {"))
  .slice(0, 400)
  .includes("beforeSessionInvalidate?.()");

console.log("   pi 0.84.2, measured:\n");
console.log(`     onTerminalInput → addExtensionTerminalInputListener   interactive-mode.js:${addLine}`);
console.log(`     clearExtensionTerminalInputListeners                  interactive-mode.js:${clearLine}`);
console.log(`     …called by resetExtensionUI                           interactive-mode.js:${resetLine}  ${resetClears}`);
console.log(`     …and by stop()                                                              ${stopClear}`);
console.log(`     resetExtensionUI is the beforeSessionInvalidate hook  interactive-mode.js:${lineOf(interactive, "this.runtimeHost.setBeforeSessionInvalidate")}`);
console.log(`     teardownCurrent (/new, /resume, /fork, import) runs it                      ${teardownCalls}`);
console.log(`     dispose (quit) runs it                                                      ${disposeCalls}\n`);

check("pi drops extension terminal-input subscriptions on session teardown", resetClears && teardownCalls);
check("…and on the way out", stopClear && disposeCalls);

console.log("   so the leak never happened — and every line above is a property of");
console.log("   pi, which is precisely why it was worth writing down.\n");

// ── 2. what the extension does with it ───────────────────────────────────────
const events = readFileSync(`${REPO}/vendor/pi-subagents-lite/src/events.ts`, "utf8");
const setup = events
  .slice(events.indexOf("export function setupEventListeners"))
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");
const shutdown = setup.slice(setup.indexOf('pi.on("session_shutdown"'));

const uses = [...setup.matchAll(/unregisterTerminalInput/g)].length;
console.log(`   references to \`unregisterTerminalInput\` in setupEventListeners: ${uses}`);
console.log(`     BEFORE : 3 — a declaration, an assignment, and a guard that reads it`);
console.log(`     NOW    : ${uses} — the same, plus the call and the clear\n`);

console.log("   session_shutdown now ends, in order:");
for (const [label, needle] of [
  ["the terminal-input subscription", "unregisterTerminalInput?.()"],
  ["the coordinator", "getCoordinator()?.dispose()"],
  ["the store", "getStore().dispose()"],
  ["the widget", "getWidget()?.dispose()"],
  ["the manager", "mgr.dispose()"],
]) {
  const at = shutdown.indexOf(needle);
  console.log(`     ${at >= 0 ? "·" : "✘"} ${label}`);
  if (at < 0) failures++;
}
console.log();

check("the unregister is called", shutdown.includes("unregisterTerminalInput?.()"));
check(
  "before the objects its handler reads are disposed",
  shutdown.indexOf("unregisterTerminalInput?.()") < shutdown.indexOf("getCoordinator()?.dispose()"),
);
check(
  "and the handle is cleared, so the guard lets the next session subscribe",
  shutdown.includes("unregisterTerminalInput = undefined"),
);

console.log(failures === 0 ? "   all expectations held\n" : `   ${failures} expectation(s) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
