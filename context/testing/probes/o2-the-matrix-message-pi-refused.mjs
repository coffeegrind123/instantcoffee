/**
 * o2 — AB2. `pi.sendUserMessage` cannot tell an extension that it failed, and
 * a Matrix message pi refused was dropped without anybody being told.
 *
 * This probe reads pi's shipped `dist/` rather than a model of it, because the
 * finding is entirely about pi's own routing: how the rejection is disposed of,
 * and who is left to hear about it.
 *
 *   node --experimental-strip-types o2-the-matrix-message-pi-refused.mjs
 */

import { readFileSync } from "node:fs";

const PI = "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist";
const session = readFileSync(`${PI}/core/agent-session.js`, "utf8");
const runner = readFileSync(`${PI}/core/extensions/runner.js`, "utf8");
const types = readFileSync(`${PI}/core/extensions/types.d.ts`, "utf8");

const { DELIVERY_GRACE_MS, undeliveredRooms } = await import(
  "../../../vendor/prinny-channel/src/delivery.ts"
);

let failures = 0;
const expect = (ok, what) => {
  if (!ok) {
    failures++;
    console.log(`  !! ${what}`);
  }
};

const lineOf = (text, needle) => {
  const at = text.indexOf(needle);
  return at < 0 ? undefined : text.slice(0, at).split("\n").length;
};

console.log("=".repeat(88));
console.log("1. where a failed sendUserMessage goes");
console.log("=".repeat(88));

const bindLine = lineOf(session, "sendUserMessage: (content, options) => {");
const bindBody = session.slice(session.indexOf("sendUserMessage: (content, options) => {"));
const catchesItself = /\.catch\(\(err\) => \{\s*runner\.emitError\(/.test(bindBody.slice(0, 400));
const returnsPromise = /sendUserMessage\(content, options\);\s*\n\s*\},/.test(
  runner.slice(runner.indexOf("sendUserMessage"), runner.indexOf("sendUserMessage") + 400),
);

console.log(`
  agent-session.js:${bindLine}   sendUserMessage: (content, options) => {
                       this.sendUserMessage(content, options).catch((err) => {
                         runner.emitError({ extensionPath: "<runtime>", … });
                       });
                     },

  the promise is caught by pi:            ${catchesItself ? "YES" : "no"}
  the ExtensionAPI method returns:        void      (types.d.ts, ExtensionAPI)
`);
expect(catchesItself, "pi no longer catches the rejection — re-read this finding");

const apiDecl = types.slice(types.lastIndexOf("sendUserMessage(content: string"));
expect(/\): void;/.test(apiDecl.slice(0, 300)), "ExtensionAPI.sendUserMessage no longer returns void");

console.log("=".repeat(88));
console.log("2. who hears emitError");
console.log("=".repeat(88));

// Every registration of an error listener in the whole of pi.
const listenerSites = [...session.matchAll(/\.onError\(/g)].length;
const conditional = /this\._extensionErrorListener\s*\n?\s*\?\s*runner\.onError\(/.test(session);
const errorEvent = /"error"|ErrorEvent/.test(
  types.slice(types.indexOf("export type ExtensionEvent ="), types.indexOf("export type ExtensionEvent =") + 1200),
);

console.log(`
  runner.onError registrations in agent-session.js:   ${listenerSites}
  ...and that one is conditional on a UI having bound
  a listener (agent-session.js:_applyExtensionBindings): ${conditional ? "YES" : "no"}

  an "error" member of ExtensionEvent an extension
  could subscribe to instead:                          ${errorEvent ? "yes" : "NONE"}

  So outside a TUI the set is empty and the error is gone. This is ctx.ui.notify's
  problem (§9.2 of the tenth pass) one layer down: not a message the operator
  cannot see, but a failure the EXTENSION cannot see.
`);
expect(conditional, "the single error listener is no longer conditional — re-read this finding");
expect(!errorEvent, "pi now has an error event; prinny should subscribe to it instead of sweeping");

console.log("=".repeat(88));
console.log("3. what can make prompt() throw, on this stack");
console.log("=".repeat(88));

const throws = [
  ["a compaction is in progress", "Cannot submit a prompt while compaction is in progress"],
  ["no model is selected", "formatNoModelSelectedMessage()"],
  ["the provider has no usable auth", "throw new Error(formatNoApiKeyFoundMessage(this.model.provider))"],
  ["streaming with no delivery mode", "Specify streamingBehavior"],
];
for (const [label, needle] of throws) {
  const line = lineOf(session, needle);
  console.log(`  ${label.padEnd(34)} agent-session.js:${line ?? "—"}`);
  expect(line !== undefined, `pi no longer throws for: ${label}`);
}
console.log(`
  The first is not hypothetical here: \`ctx.compact()\` reaches
  \`AgentSession.compact()\`, which sets \`_compactionAbortController\` for its whole
  duration, and \`vendor/pi-loop-mode\` calls it from the stuck ladder and from
  context recovery. The third is "the llama-server is down".
`);

console.log("=".repeat(88));
console.log("4. the evidence prinny uses instead");
console.log("=".repeat(88));

const now = 1_800_000_000_000;
const old = now - DELIVERY_GRACE_MS - 1;
const rows = [
  ["pi took it (markLive fired)", { at: old, live: true }, false],
  ["queued behind a running turn", { at: old, live: false }, true],
  ["still inside the grace", { at: now - 1_000, live: false }, false],
  ["idle, past the grace, never consumed", { at: old, live: false }, false],
  ["…and once reported, not again", { at: old, live: false, undeliveredReported: true }, false],
];

console.log(`  ${"state".padEnd(40)} agentRunning   reported?`);
console.log("  " + "-".repeat(70));
for (const [label, entry, running] of rows) {
  const verdict = undeliveredRooms([["!r:example.org", entry]], now, running);
  console.log(`  ${label.padEnd(40)} ${String(running).padEnd(14)} ${verdict.length ? "YES" : "no"}`);
}

const reported = undeliveredRooms([["!r:example.org", { at: old, live: false }]], now, false);
expect(reported.length === 1, "the one case that must be reported is not");
const busy = undeliveredRooms([["!r:example.org", { at: old, live: false }]], now, true);
expect(busy.length === 0, "a message queued behind a running turn is being reported as undelivered");

console.log(`
  BEFORE   the room sat in \`awaitingReply\` un-live for the life of the session:
           never marked live, so never answered, never retired, never reported.
           From Matrix that is indistinguishable from being ignored.
  NOW      the sender is told once, and the entry is LEFT IN PLACE — so a late
           delivery still reaches markLive and the answer still goes out. The
           worst case of a wrong verdict is one extra sentence, never a lost
           answer.
`);

if (failures) {
  console.log(`FAILED: ${failures} expectation(s).`);
  process.exit(1);
}
console.log("ok — every expectation held.");
