/**
 * k6 — W6. V7's fix does not cover the exit its own comment names.
 *
 * V7 moved the judge's session capture off the RESULT and into `onSessionCreated`,
 * and both the code comment and the write-up say what that buys:
 *
 *   agent-manager.ts:
 *     > every rejection after `createAgentSession()` had returned (bindExtensions
 *     > throwing, session.prompt() rejecting on a provider fault) dropped the only
 *     > reference to a live session … That is exactly the leak the paragraph above
 *     > is about, on the one exit it did not cover.
 *
 *   shapes.md §V7:
 *     > `onSessionCreated` fires inside `createAndConfigureSession`, before
 *     > `bindExtensions` returns, so it covers every failure the old form missed.
 *
 * It did not fire before `bindExtensions` returns. It fired after it, and after
 * the tool filtering that follows it. The `session.prompt()` half of the claim
 * was real and is the common case; the `bindExtensions` half was not.
 *
 * FIXED: the hand-over is the line after `initSession`, so the claim is now true.
 * Nothing downstream of the callback reads the session's tools or name, and
 * attaching the output log earlier only means it captures more.
 *
 * It is not only the judge. On the spawn path the same callback is what assigns
 * `record.execution.session`, so a throw in that window leaves the record without
 * a session too — and `dispose()` / `removeRecord()` dispose `record.execution.session`,
 * which is still undefined.
 *
 *   run:  node k6-onsessioncreated-fires-after-bindextensions.mjs
 */

import { readFileSync } from "node:fs";

const RUNNER = "/home/claudeuser/qwen3.8-forge/vendor/pi-subagents-lite/src/agents/agent-runner.ts";
const MANAGER = "/home/claudeuser/qwen3.8-forge/vendor/pi-subagents-lite/src/agents/agent-manager.ts";

const runner = readFileSync(RUNNER, "utf8");
const manager = readFileSync(MANAGER, "utf8");

console.log("\n=== k6 — where onSessionCreated actually fires ===\n");

const fn = runner.slice(
  runner.indexOf("async function createAndConfigureSession"),
  runner.indexOf("async function runTurnLoop"),
);
const body = fn.slice(fn.indexOf("): Promise<AgentSession> {"));
console.log("createAndConfigureSession(), out of agent-runner.ts:\n");
console.log(body.split("\n").filter((l) => l.trim() && !/^\s*(\/\/|\*|\/\*)/.test(l)).map((l) => "  " + l).join("\n"));

const lines = runner.split("\n");
const at = (needle) => lines.findIndex((l) => l.includes(needle)) + 1;
const order = [
  ["initSession(...)  — the session now EXISTS", at("const session = await initSession(")],
  ["session.setSessionName(...)", at("session.setSessionName(")],
  ["await session.bindExtensions({", at("await session.bindExtensions({")],
  ["resolveVisibleTools(...)", at("const filteredTools = resolveVisibleTools({")],
  ["session.setActiveToolsByName(...)", at("if (filteredTools) session.setActiveToolsByName(")],
  ["options.onSessionCreated?.(session)   <-- the capture", at("options.onSessionCreated?.(session)")],
];
console.log("\n  order in the shipped file:\n");
for (const [what, line] of order) console.log(`    agent-runner.ts:${String(line).padStart(4)}  ${what}`);

const captureLine = at("options.onSessionCreated?.(session)");
const bindLine = at("await session.bindExtensions({");
console.log(`\n  the claim : the capture fires BEFORE bindExtensions returns`);
console.log(`  BEFORE    : capture below the bind and below the tool filtering — the exit the`);
console.log(`              comment names by hand was the one still uncovered`);
console.log(`  NOW       : capture at line ${captureLine}, bindExtensions at line ${bindLine} — ${captureLine < bindLine ? "the claim holds" : "STILL AFTER"}\n`);

// ── replay: the three ways a spawn can end, against the shipped teardown shape ─
const shape = (label, fail) => {
  let disposed = 0;
  let judgeSession;
  const create = () => {
    const session = { dispose: () => disposed++ };
    if (fail === "bind") throw new Error("bindExtensions rejected");        // capture never runs
    judgeSession = session;                                                  // onSessionCreated
    if (fail === "prompt") throw new Error("provider dropped the call");
    return session;
  };
  try { create(); } catch { /* the finally below is what matters */ }
  finally { try { judgeSession?.dispose(); } catch {} }
  console.log(`    ${label.padEnd(46)} sessions disposed = ${disposed} ${disposed ? "" : "   <-- LEAKED"}`);
};

/** The same replay with the capture where it is now: above the bind. */
const shapeFixed = (label, fail) => {
  let disposed = 0;
  let judgeSession;
  const create = () => {
    const session = { dispose: () => disposed++ };
    judgeSession = session;                                                  // onSessionCreated
    if (fail === "bind") throw new Error("bindExtensions rejected");
    if (fail === "prompt") throw new Error("provider dropped the call");
    return session;
  };
  try { create(); } catch { /* the finally below is what matters */ }
  finally { try { judgeSession?.dispose(); } catch {} }
  console.log(`    ${label.padEnd(46)} sessions disposed = ${disposed} ${disposed ? "" : "   <-- LEAKED"}`);
};

console.log("  what the teardown does with each exit:\n");
console.log("  BEFORE — the capture sat below the bind:\n");
shape("judge answered", undefined);
shape("session.prompt() rejected  (V7's case)", "prompt");
shape("bindExtensions rejected    (the claim)", "bind");
console.log("\n  NOW — the capture sits above it, so all three exits have an owner:\n");
shapeFixed("judge answered", undefined);
shapeFixed("session.prompt() rejected", "prompt");
shapeFixed("bindExtensions rejected", "bind");

console.log(`
  bindExtensions is well guarded — pi's ExtensionRunner.emit() swallows a handler
  throw (runner.js:596) — so the reachable rejections are narrower than the comment
  implies: extendResourcesFromExtensions, _applyExtensionBindings, and the
  _rebuildSystemPrompt inside setActiveToolsByName — the last of which was also
  below the old capture, and is now above it too.
  The residual leak was small. The claim that there was none is the finding, because
  V7's regression test is a source pin that asserts the capture is PRESENT and cannot
  see where it sits. The new pin in tests/turn-tracking.test.ts asserts the ORDER, in
  the other file — it is the assertion that would have caught this.
`);
