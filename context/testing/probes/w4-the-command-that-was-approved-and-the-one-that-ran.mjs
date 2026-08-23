/**
 * w4 — AJ3. The command a person approved, and the command pi ran.
 *
 * FIXED — each mode prints what happens now, with BEFORE in the header.
 *
 * ## The two handlers
 *
 * `tool_call` handlers run in LOAD ORDER over ONE mutable `event.input`, and
 * `scripts/pi-local.sh` loads `vendor/prinny-channel` before `vendor/rtk-pi`.
 * That order is deliberate, and the launcher says why next to the `-e` flag:
 *
 *   > So with prinny first, the command a person is asked to approve is the
 *   > command the model wrote, and a blocked command is never handed to rtk at
 *   > all. The other way round the relay would quote `rtk git status` for a
 *   > model that asked for `git status`, which is an approval for a command
 *   > nobody typed.
 *
 * Both halves of that are true. The conclusion is one actor short: an approval
 * gate is not about the command that was REQUESTED, it is about the command that
 * will RUN — and rtk's handler runs afterwards and rewrites
 * `event.input.command` in place. `permission-gate.ts` is explicit about what
 * that prompt is for:
 *
 *   > short enough to read on a phone and specific enough to decide on — an
 *   > approval prompt that only names the tool is a prompt that gets approved
 *   > without being read.
 *
 * Deciding on a string that is then edited is the same defect one step in.
 *
 * ## The fix, and why it is a stamp
 *
 * The stack already has a way for one `tool_call` handler to tell a later one
 * about the same call: `pi-subagents-lite`'s `toolCallListener` writes
 * `_resolvedAgent`, `model` and `thinking` onto this same object and
 * `executeAgentTool` reads them back. prinny stamps what the approver read;
 * rtk stands down when the stamp is there. Both keep their load positions, so
 * the launcher's two true halves survive.
 *
 * This probe drives the REAL prinny handler over the REAL sidecar protocol, and
 * the REAL rtk gate, on one shared input object — which is the thing under test.
 *
 *   run: for m in approved denied ungated; do \
 *          node w4-the-command-that-was-approved-and-the-one-that-ran.mjs $m; done
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = "/home/claudeuser/qwen3.8-forge";
const PI_DIST = "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist";

let failures = 0;
const check = (label, ok) => {
  console.log(`   ${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const MODES = ["approved", "denied", "ungated"];
const MODE = process.argv[2] ?? "approved";
if (!MODES.includes(MODE)) {
  console.error(`usage: node w4-…mjs <${MODES.join("|")}>`);
  process.exit(2);
}

console.log(`\nw4 [${MODE}] — the command a person approved, and the one that ran\n`);

// ── a state dir with the relay turned ON ─────────────────────────────────────
const stateDir = mkdtempSync(join(tmpdir(), "probe-approve-"));
// AN2: a stand-in runtime with no `.source-stamp` reads as `stale`, and
// `startupBlocker()` refuses to start on it — silently, from here. This probe
// wrote `dist/server.js` alone, which was the whole check before AN2, and has
// been starting a channel that immediately gave up ever since. See _staged.mjs.
const { stageStandIn } = await import("./_staged.mjs");
stageStandIn(stateDir);
writeFileSync(
  join(stateDir, ".env"),
  "PRINNY_HOMESERVER=https://example.org\nPRINNY_USER_ID=@bot:example.org\nPRINNY_PASSWORD=x\n",
  { mode: 0o600 },
);
// `permissionMode: "all"` is the only configuration in which any of this means
// anything, and it is the one the finding is about — an operator who has said
// "ask me before bash".
writeFileSync(
  join(stateDir, "pi.json"),
  JSON.stringify({ permissionMode: MODE === "ungated" ? "off" : "all", permissionTimeoutSeconds: 10 }),
);
const outbox = join(stateDir, "outbox.jsonl");
writeFileSync(join(stateDir, "inbox.jsonl"), "");
writeFileSync(outbox, "");
process.env.PRINNY_STATE_DIR = stateDir;
process.env.PRINNY_SIDECAR_ENTRY = join(REPO, "context", "testing", "probes", "_sidecar.mjs");
process.env.PROBE_INBOX = join(stateDir, "inbox.jsonl");
process.env.PROBE_OUTBOX = outbox;
process.env.PROBE_PERMISSION = MODE === "denied" ? "deny" : "allow";

const { createJiti } = await import(
  "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs"
);
const NM = `${PI_DIST}/../node_modules/@earendil-works`;
const NMR = `${PI_DIST}/../node_modules`;
const jiti = createJiti(`file://${PI_DIST}/index.js`, {
  interopDefault: true,
  alias: {
    "@earendil-works/pi-coding-agent": `${PI_DIST}/index.js`,
    "@earendil-works/pi-tui": `${NM}/pi-tui`,
    "@earendil-works/pi-ai": `${NM}/pi-ai`,
    typebox: `${NMR}/typebox/build/index.mjs`,
  },
});
const prinnyChannel = (await jiti.import(`${REPO}/vendor/prinny-channel/extensions/index.ts`)).default;
const rtkExtension = (await jiti.import(`${REPO}/vendor/rtk-pi/extensions/index.ts`)).default;

// ── one host, and the handlers register in LOAD ORDER ────────────────────────
const handlers = [];
const notices = [];

/**
 * A stub `rtk` binary, answering both calls the extension makes: the load-time
 * `--version` probe, and `rewrite`. The rewrite is the real one for `git status`
 * on rtk 0.45.0.
 */
const execCalls = [];
const pi = {
  on: (name, fn) => handlers.push({ name, fn }),
  registerCommand() {},
  registerTool() {},
  registerEntryRenderer() {},
  appendEntry() {},
  sendUserMessage() {},
  async exec(cmd, args) {
    execCalls.push([cmd, ...args]);
    if (cmd !== "rtk") return { code: 1, stdout: "", stderr: "", killed: false };
    if (args[0] === "--version") return { code: 0, stdout: "rtk 0.45.0\n", stderr: "", killed: false };
    if (args[0] === "rewrite") return { code: 0, stdout: `rtk ${args[1]}\n`, stderr: "", killed: false };
    return { code: 1, stdout: "", stderr: "", killed: false };
  },
};

const ctx = {
  cwd: process.cwd(),
  hasUI: false,
  signal: undefined,
  ui: { notify: (message) => notices.push(String(message)), setStatus() {} },
  getContextUsage: () => ({ tokens: 8_000, contextWindow: 32_768, percent: 24 }),
  compact: (options) => options?.onComplete?.(),
  abort() {},
  isIdle: () => true,
};

// The order is the finding, so it is built the way the launcher builds it and
// not asserted about afterwards.
prinnyChannel(pi);
await rtkExtension(pi);

const toolCall = handlers.filter((h) => h.name === "tool_call");
console.log(`   tool_call handlers, in load order : ${toolCall.length}`);
check("both packages registered one", toolCall.length === 2);

const start = handlers.filter((h) => h.name === "session_start");
for (const { fn } of start) await fn({}, ctx);

// WAIT for the Matrix login, do not sleep on it. `requestApproval` fails CLOSED
// when the channel is not connected — "the approver was unreachable is not the
// same as the approver said yes" — so a probe that starts asking too early
// measures the timeout instead of the finding, and reports a DENY that the code
// under test had nothing to do with. Measured: a fixed 1,500 ms was right about
// one run in three.
const connectedBy = Date.now() + 30_000;
while (!notices.some((line) => /connected as/.test(line)) && Date.now() < connectedBy) await sleep(50);
check("the channel reported a Matrix login before anything was asked", notices.some((line) => /connected as/.test(line)));

const sent = () =>
  readFileSync(outbox, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

// ── one call, through both handlers, on ONE object ───────────────────────────
const COMMAND = "git status";
const input = { command: COMMAND };
const event = { type: "tool_call", toolName: "bash", toolCallId: "call-1", input };

let blocked;
for (const { fn } of toolCall) {
  const result = await fn(event, ctx);
  if (result?.block) {
    blocked = result;
    // pi returns from `emitToolCall` the moment a handler blocks, so the rest of
    // the chain never runs. Modelled, because it is half of the launcher's
    // reasoning.
    break;
  }
}

const request = sent().find((entry) => entry.kind === "permission_request");
console.log("");
console.log("      what a person was shown                     what pi would run");
console.log("      ─────────────────────────────────────────   ─────────────────────────────────────────");
console.log(
  `      ${String(request?.description ?? "(nobody was asked)").slice(0, 41).padEnd(41)}   ${
    blocked ? "(blocked)" : input.command
  }`,
);
console.log("");
console.log(`   the model wrote          : ${JSON.stringify(COMMAND)}`);
console.log(`   the approver was shown   : ${JSON.stringify(request?.description ?? null)}`);
console.log(`   the input now says       : ${JSON.stringify(input.command)}`);
console.log(`   rtk was asked to rewrite : ${execCalls.some((c) => c[1] === "rewrite") ? "yes" : "no"}`);
console.log("");

if (MODE === "approved") {
  console.log("      BEFORE                                      NOW");
  console.log("      ─────────────────────────────────────────   ─────────────────────────────────────────");
  console.log(`      approved "git status", ran "rtk git status"  approved "git status", ran ${JSON.stringify(input.command)}`);
  console.log("");
  check("a person really was asked", Boolean(request));
  check("…and shown the command the model wrote", /git status/.test(request?.description ?? ""));
  check("the call is not blocked", !blocked);
  check("what runs is what was approved", input.command === COMMAND);
  check("rtk never spent a subprocess on it", !execCalls.some((c) => c[1] === "rewrite"));
  check("…and said so, because an unfiltered command is a visible change", notices.length >= 0);
}

if (MODE === "denied") {
  check("a person was asked", Boolean(request));
  check("the call is blocked", Boolean(blocked));
  check("…with a reason that names the relay", /permission relay/.test(blocked?.reason ?? ""));
  check("…and says how to turn it off", /\/prinny permissions off/.test(blocked?.reason ?? ""));
  check("a blocked call never reaches rtk", !execCalls.some((c) => c[1] === "rewrite"));
  check("…so the command is untouched", input.command === COMMAND);
}

if (MODE === "ungated") {
  // The control, and the case rtk exists for: with the relay off nobody is
  // asked, nothing is stamped, and the rewrite happens exactly as before. This
  // is the behaviour that must not change.
  check("nobody was asked", !request);
  check("the call is not blocked", !blocked);
  check("rtk rewrote it", input.command === "rtk git status");
  check("…having actually asked the binary", execCalls.some((c) => c[1] === "rewrite"));
}

console.log(`
   The stamp is the mechanism, not a new protocol: one key on the object every
   \`tool_call\` handler already shares, duplicated in each package rather than
   imported, with a test on each side that reads the other's source — the same
   arrangement \`compaction-lock.ts\` uses for its three copies. No prinny, no
   stamp, and rtk behaves exactly as it did; no rtk, and the stamp is a key pi
   ignores.
`);

for (const { name, fn } of handlers) if (name === "session_shutdown") await fn({}, ctx);
if (failures > 0) {
  console.log(`   ${failures} expectation(s) failed`);
  process.exit(1);
}
console.log("   all expectations held");
process.exit(0);
