/**
 * AL7 — the unregister that was captured and never called.
 *
 * `session_start` subscribes the widget's key handler:
 *
 * ```
 *   let unregisterTerminalInput: (() => void) | undefined;
 *   …
 *   if (ctx.hasUI && !unregisterTerminalInput) {
 *     unregisterTerminalInput = ctx.ui.onTerminalInput(createNavInputHandler(ctx));
 *   }
 * ```
 *
 * and that was the whole of it. Two references in the package: the assignment,
 * and the guard that reads it as "already done". The one thing in this file
 * whose only purpose is to END something had no caller, while the
 * `session_shutdown` handler four lines down disposes the coordinator, the
 * store, the widget and the manager by name.
 *
 * **It has never leaked, and the reason is pi's, not ours** — measured against
 * pi 0.84.2 rather than assumed:
 *
 * ```
 *   AgentSessionRuntime.teardownCurrent      agent-session-runtime.js:111
 *     → beforeSessionInvalidate()
 *       → InteractiveMode.resetExtensionUI   interactive-mode.js:1715
 *         → clearExtensionTerminalInputListeners()          :1726
 *   InteractiveMode.stop()                                  :5425  same call
 * ```
 *
 * `teardownCurrent` runs on `/new`, `/resume`, `/fork` and import. So pi drops
 * the subscription every time, and the extension's factory is re-invoked for the
 * new session with a fresh closure — a fresh `undefined` — so the guard lets it
 * subscribe again. Nothing is wrong today.
 *
 * What makes it worth a line is the failure it would have if that stopped being
 * true: the guard is `!unregisterTerminalInput`, so a stale handle reads as
 * "still subscribed" and the nav keys — the widget's arrows, Enter into the
 * viewer, Escape — would silently stop working, with nothing to report it.
 *
 * See AL7 in `context/design/subagents-loop-verifier-lifetimes.md`.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const SOURCE = readFileSync(new URL("../src/events.ts", import.meta.url), "utf8");

/** `setupEventListeners`'s body, comments stripped: this file quotes the defective form. */
const BODY = SOURCE.slice(SOURCE.indexOf("export function setupEventListeners"))
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

const SHUTDOWN = BODY.slice(BODY.indexOf('pi.on("session_shutdown"'));

describe("AL7 — every subscription this file opens, it closes", () => {
  it("calls the unregister at session_shutdown", () => {
    assert.match(SHUTDOWN, /unregisterTerminalInput\?\.\(\)/);
  });

  it("clears the handle, so the next session_start re-subscribes", () => {
    // The guard is `!unregisterTerminalInput`. A handle left set after the
    // subscription is gone is the shape that loses the keys silently.
    const call = SHUTDOWN.indexOf("unregisterTerminalInput?.()");
    const clear = SHUTDOWN.indexOf("unregisterTerminalInput = undefined");
    assert.ok(call > 0 && clear > call, "cleared, and after the call");
  });

  it("ends it before the objects its handler reads are disposed", () => {
    // `createNavInputHandler` reaches the widget and the coordinator. Ending the
    // subscription first means no key can arrive for a widget that is gone.
    const clear = SHUTDOWN.indexOf("unregisterTerminalInput?.()");
    const dispose = SHUTDOWN.indexOf("getCoordinator()?.dispose()");
    assert.ok(clear > 0 && dispose > clear);
  });

  it("does not let a throwing unregister take the rest of the teardown with it", () => {
    const guarded = SHUTDOWN.slice(SHUTDOWN.indexOf("unregisterTerminalInput?.()") - 80);
    assert.match(guarded.slice(0, 200), /try \{/);
  });

  it("still disposes the four it already named", () => {
    // The control for the assertions above: this handler's existing work is
    // untouched, and a teardown list is only interesting if it is complete.
    for (const call of [
      "getCoordinator()?.dispose()",
      "getStore().dispose()",
      "getWidget()?.dispose()",
      "mgr.dispose()",
    ]) {
      assert.ok(SHUTDOWN.includes(call), `session_shutdown must still ${call}`);
    }
  });
});

describe("AL7 — the host property this rests on is written down", () => {
  it("names where pi clears the subscription itself", () => {
    // The finding is that the extension depended on pi's teardown without
    // saying so. Saying so is half the fix: a future pi that changes it has one
    // place to be checked against.
    const doc = SOURCE.slice(0, SOURCE.indexOf("let unregisterTerminalInput"));
    const note = doc.slice(doc.lastIndexOf("/**"));
    assert.match(note, /clearExtensionTerminalInputListeners/);
    assert.match(note, /interactive-mode\.js/);
  });
});
