/**
 * p4 — AC4 and AC5. What happens to a Matrix message that begins with a slash.
 *
 * Two findings, one path, and they compound: the second creates the state the
 * first then misreports.
 *
 * **AC5 — `/compact` was allow-listed, advertised, and undispatchable.**
 * `sendUserMessage` reaches `AgentSession.prompt()`, whose command branch is
 * `_tryExecuteExtensionCommand` → `this._extensionRunner.getCommand(name)`:
 * **extension** commands only. This stack registers four (`/stack`, `/loop`,
 * `/agents`, `/prinny`). `/compact` is one of pi's BUILT-IN slash commands
 * (`core/slash-commands.js`) and the only thing that executes one is the TUI's
 * own input handler (`modes/interactive/interactive-mode.js`). So a Matrix
 * `/compact` fell through `prompt()` and was delivered to the model as the
 * literal text "/compact" — a whole model call on the one llama slot — while the
 * sender was told "Ran `/compact`. Its output stays in the terminal."
 *
 * **AC4 — the undelivered sweep reported messages prinny had answered itself.**
 * AB2 reads the absence of `markLive` as "pi never took it", which is sound for a
 * message that was handed to pi. A refused command is deliberately never handed
 * over; an allowed one is dispatched by pi and returns before any turn, so there
 * is no user message to echo and `markLive` can never fire. Both left an entry
 * that was not live, past the grace, on an idle session — and a minute later the
 * sender got "I could not hand that to the session … please send it again" about
 * a message that had been answered. §O of the hand-testing script calls a false
 * positive here worse than the bug it fixes, and it is: silence is ambiguous, a
 * wrong apology is a claim.
 *
 * Source-pinned where the fact is pi's own routing, executed where the fact is
 * this stack's rule.
 *
 *   run: node --experimental-strip-types p4-the-message-prinny-answered-itself.mjs
 */

import { readFileSync } from "node:fs";

const REPO = "/home/claudeuser/qwen3.8-forge";
const PI = "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist";

const { MATRIX_ALLOWED, MATRIX_LOCAL, advertisedCommands, classifyMatrixCommand } = await import(
  `${REPO}/vendor/prinny-channel/src/command-routing.ts`
);
const { DELIVERY_GRACE_MS, undeliveredRooms } = await import(`${REPO}/vendor/prinny-channel/src/delivery.ts`);

let failures = 0;
const check = (label, ok) => {
  console.log(`   ${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) failures++;
};

// ── 1. what pi can actually dispatch ──────────────────────────────────────────
console.log("AC5 — which slash commands `AgentSession.prompt()` can execute\n");

const session = readFileSync(`${PI}/core/agent-session.js`, "utf8");
const at = session.indexOf("expandPromptTemplates && text.startsWith");
console.log(
  session
    .slice(at - 8, at + 240)
    .split("\n")
    .slice(0, 7)
    .map((l) => "   " + l.trim())
    .join("\n"),
);
const dispatch = session.slice(session.indexOf("async _tryExecuteExtensionCommand(text)"));
console.log(`   …and getCommand is the extension registry: ${/getCommand\(commandName\)/.test(dispatch.slice(0, 400))}`);

const REGISTERED = [
  ".pi/extensions/stack.ts",
  "vendor/pi-loop-mode/extensions/index.ts",
  "vendor/pi-subagents-lite/src/registration.ts",
  "vendor/prinny-channel/extensions/index.ts",
]
  .flatMap((f) => [...readFileSync(`${REPO}/${f}`, "utf8").matchAll(/registerCommand\(\s*["']([a-z]+)["']/g)].map((m) => m[1]))
  .filter((v, i, a) => a.indexOf(v) === i);

const builtins = readFileSync(`${PI}/core/slash-commands.js`, "utf8");
const interactive = readFileSync(`${PI}/modes/interactive/interactive-mode.js`, "utf8");

console.log(`\n   extension commands this stack registers : /${REGISTERED.join(" /")}`);
console.log(`   "compact" is a pi BUILT-IN              : ${/name: "compact"/.test(builtins)}`);
console.log(`   executed only by the TUI input handler  : ${/text === "\/compact"/.test(interactive)}`);
console.log(`   MATRIX_ALLOWED (pi dispatches these)    : /${Object.keys(MATRIX_ALLOWED).join(" /")}`);
console.log(`   MATRIX_LOCAL (prinny performs these)    : /${Object.keys(MATRIX_LOCAL).join(" /")}`);
console.log(`   advertised in the Matrix client menu    : /${advertisedCommands().map((c) => c.command).join(" /")}`);

check(
  "every allow-listed command is one pi can dispatch",
  Object.keys(MATRIX_ALLOWED).every((name) => REGISTERED.includes(name)),
);
check(
  "and every local one is a command pi cannot",
  Object.keys(MATRIX_LOCAL).every((name) => !REGISTERED.includes(name)),
);

console.log("\n   how a leading slash is classified now:");
for (const body of ["/compact", "/loop status", "/stack", "/model gpt", "/prinny allow x", "hello /compact"]) {
  const c = classifyMatrixCommand(body);
  console.log(`      ${JSON.stringify(body).padEnd(18)} -> ${c.kind}${c.kind === "text" ? "" : ` (${c.name})`}`);
}
check("/compact is performed here, not sent to the model as text", classifyMatrixCommand("/compact").kind === "local");
check("/loop status is still handed to pi", classifyMatrixCommand("/loop status").kind === "run");
check("/model is still refused", classifyMatrixCommand("/model gpt").kind === "refuse");

// ── 2. what the sweep says about each of them ─────────────────────────────────
console.log("\n\nAC4 — what the undelivered sweep says about each entry\n");

const NOW = 1_800_000_000_000;
const OLD = NOW - DELIVERY_GRACE_MS - 1;
const ROWS = [
  ["a refused command (/model)", { at: OLD, live: false, answered: true }, false],
  ["an allowed command (/loop status)", { at: OLD, live: false, answered: true }, false],
  ["a local command (/compact)", { at: OLD, live: false, answered: true }, false],
  ["a plain message pi never took", { at: OLD, live: false }, true],
  ["control — still inside the grace", { at: NOW - 1_000, live: false }, false],
  ["control — pi took it", { at: OLD, live: true }, false],
  ["control — already reported once", { at: OLD, live: false, undeliveredReported: true }, false],
];

console.log("   entry                                BEFORE     NOW        ");
console.log("   " + "-".repeat(58));
for (const [label, entry, expected] of ROWS) {
  // BEFORE is the eleventh pass's rule restated: `answered` was not one of the
  // questions it asked.
  const before =
    !entry.live && !entry.undeliveredReported && NOW - entry.at >= DELIVERY_GRACE_MS ? "REPORTED" : "quiet";
  const now = undeliveredRooms([["!room", entry]], NOW, false).length > 0 ? "REPORTED" : "quiet";
  console.log(`   ${label.padEnd(36)}${before.padEnd(11)}${now.padEnd(11)}${before === now ? "" : "←"}`);
  if ((now === "REPORTED") !== expected) failures++;
}

console.log("\n   and the one row that must never move:");
check(
  "a message pi genuinely refused is still reported",
  undeliveredRooms([["!lost", { at: OLD, live: false }]], NOW, false).length === 1,
);
check(
  "…and nothing is reported while the session is still working",
  undeliveredRooms([["!lost", { at: OLD, live: false }]], NOW, true).length === 0,
);

console.log(`\n${failures === 0 ? "all expectations met" : `${failures} expectation(s) unmet`}`);
process.exit(failures === 0 ? 0 : 1);
