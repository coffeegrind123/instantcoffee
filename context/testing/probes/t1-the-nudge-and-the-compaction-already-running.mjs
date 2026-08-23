/**
 * t1 — the continuation nudge sent into the compaction the loop just started.
 * FIXED — this probe prints BEFORE and NOW.
 *
 * Same one-process, two-extension harness as s5, and the same agent_settled —
 * but the object in flight is not a second compaction, it is prinny's empty-turn
 * CONTINUATION, and nothing stands it aside.
 *
 *     agent_settled
 *       ├─ pi-loop-mode   runs FIRST  → requestEmergencyCompaction → ctx.compact()
 *       │                                pi: `await this.abort()`, then
 *       │                                `_compactionAbortController = new …`
 *       └─ prinny-channel runs SECOND → forwardResult() → the run ended empty →
 *                                        api.sendUserMessage(nudge)
 *                                        → prompt() throws
 *                                          "Cannot submit a prompt while
 *                                           compaction is in progress"
 *                                        → pi .catch → emitError → nobody
 *
 * NOW `forwardResult` reads `compactionInFlight()` — the flag `startCompaction`
 * twelve lines away has read since the fifteenth pass — before it considers the
 * continuation at all. No nudge is sent, no retry is charged for a send that
 * could not happen, and the sender is told the true reason NOW rather than being
 * told by the delivery sweep a minute later that it "may have been compacting".
 *
 *   run: node t1-nudge-into-a-compaction.mjs
 */

import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = "/home/claudeuser/qwen3.8-forge";
const PI_DIST = "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist";

let failures = 0;
const check = (label, ok) => {
  console.log(`   ${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log("\nt1 — the continuation nudge and the compaction that was already running\n");

// pi's own two facts, pinned rather than remembered.
{
  const src = readFileSync(`${PI_DIST}/core/agent-session.js`, "utf8");
  const at = src.indexOf("async compact(customInstructions)");
  check("compact() begins by aborting, then takes _compactionAbortController",
    /await this\.abort\(\);\s*\n\s*this\._compactionAbortController = new AbortController\(\)/.test(src.slice(at, at + 220)));
  check("prompt() refuses while that controller is set",
    /if \(this\._compactionAbortController !== undefined\) \{\s*\n\s*throw new Error\("Cannot submit a prompt while compaction is in progress/.test(src));
  check("…and pi swallows the rejection into emitError",
    /sendUserMessage: \(content, options\) => \{[\s\S]{0,200}?\.catch\(\(err\) => \{[\s\S]{0,120}?emitError/.test(src));
}

const stateDir = mkdtempSync(join(tmpdir(), "probe-prinny-"));
// AN2: a stand-in runtime with no `.source-stamp` reads as `stale`, and
// `startupBlocker()` refuses to start on it — silently, from here. This probe
// wrote `dist/server.js` alone, which was the whole check before AN2, and has
// been starting a channel that immediately gave up ever since. See _staged.mjs.
const { stageStandIn } = await import("./_staged.mjs");
stageStandIn(stateDir);
writeFileSync(join(stateDir, ".env"),
  "PRINNY_HOMESERVER=https://example.org\nPRINNY_USER_ID=@bot:example.org\nPRINNY_PASSWORD=x\n", { mode: 0o600 });
const inbox = join(stateDir, "inbox.jsonl");
const outbox = join(stateDir, "outbox.jsonl");
writeFileSync(inbox, ""); writeFileSync(outbox, "");
process.env.PRINNY_STATE_DIR = stateDir;
process.env.PRINNY_SIDECAR_ENTRY = join(REPO, "context", "testing", "probes", "_sidecar.mjs");
process.env.PROBE_INBOX = inbox;
process.env.PROBE_OUTBOX = outbox;

const { createJiti } = await import(`${PI_DIST}/../node_modules/jiti/lib/jiti.mjs`);
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

const loopMode = (await jiti.import(`${REPO}/vendor/pi-loop-mode/extensions/index.ts`)).default;
const prinnyChannel = (await jiti.import(`${REPO}/vendor/prinny-channel/extensions/index.ts`)).default;
const loopLock = await jiti.import(`${REPO}/vendor/pi-loop-mode/src/compaction-lock.ts`);

const loopHandlers = new Map();
const prinnyHandlers = new Map();
let registering = loopHandlers;

const compactCalls = [];
const notices = [];
/** Every sendUserMessage, and whether pi would have taken it. THIS IS THE FINDING. */
const userMessages = [];
let loopCommand;

/** pi's `_compactionAbortController !== undefined`, modelled. */
let compactionRunning = false;

const pi = {
  on: (name, fn) => registering.set(name, [...(registering.get(name) ?? []), fn]),
  registerCommand: (name, config) => { if (name === "loop") loopCommand = config.handler; },
  registerTool() {}, registerEntryRenderer() {}, appendEntry() {}, sendMessage() {},
  // pi's real binding: prompt() throws while a compaction holds the controller,
  // and the rejection goes to emitError, whose listener set is empty headless.
  // Returning void either way is what makes the failure invisible to the caller.
  sendUserMessage: (text) => {
    userMessages.push({ text, taken: !compactionRunning });
  },
  exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
  setModel: async () => true,
};

let contextPercent = 95;
const ctx = {
  cwd: process.cwd(), mode: "tui", hasUI: true,
  ui: { notify: (m) => notices.push(String(m)), setStatus() {} },
  sessionManager: { getBranch: () => [{ type: "message" }], getEntries: () => [] },
  modelRegistry: { find: () => undefined, getAll: () => [] },
  model: { api: "openai-completions", contextWindow: 32_768 },
  isIdle: () => true,
  hasPendingMessages: () => false,
  getContextUsage: () => ({
    tokens: Math.round((32_768 * contextPercent) / 100),
    contextWindow: 32_768, percent: contextPercent,
  }),
  compact: (options) => {
    compactCalls.push(options);
    compactionRunning = true;   // pi holds _compactionAbortController from here
  },
  abort() {}, async waitForIdle() {},
};

registering = loopHandlers; loopMode(pi);
registering = prinnyHandlers; prinnyChannel(pi);

const fire = async (name, event = {}) => {
  for (const fn of loopHandlers.get(name) ?? []) await fn(event, ctx);
  for (const fn of prinnyHandlers.get(name) ?? []) await fn(event, ctx);
};
const post = (m) => appendFileSync(inbox, `${JSON.stringify(m)}\n`);
const replies = () => readFileSync(outbox, "utf8").split("\n").filter(Boolean)
  .map((l) => JSON.parse(l)).filter((e) => e.name === "reply").map((e) => String(e.arguments?.text ?? ""));

/**
 * How many of the message's two rescue attempts were spent.
 *
 * `emptyRetries` lives in the extension's module-private `awaitingReply` map, so
 * it is read the way everything else here is read: through what the extension
 * DOES with it. A charged retry produces a nudge; an uncharged one does not, and
 * the give-up message ("I tried again and still could not") is what a spent
 * budget looks like from the room.
 */
const retriesCharged = () =>
  userMessages.filter((m) => /Answer the outstanding question/.test(m.text)).length;

await fire("session_start", {});
await sleep(1200);

loopLock.resetCompactionLock();
await loopCommand("start keep the docs in step with the code", ctx);
notices.length = 0; userMessages.length = 0;

// ── Alice asks an ordinary question while the session is busy ────────────────
await fire("agent_start", {});
post({
  content: "What is the status of the decoder work?",
  meta: {
    room_id: "!alice:example.org", chat_id: "!alice:example.org", message_id: "$q1",
    user: "Alice", user_id: "@alice:example.org", ts: "2026-08-19T00:00:00.000Z", is_direct: "true",
  },
});
await sleep(400);
const injected = userMessages.at(-1)?.text;
console.log(`\n     injected into the session : ${JSON.stringify(injected)}`);
check("prinny handed the question to pi", typeof injected === "string" && injected.startsWith("[matrix]"));

// pi echoes it back as a user message; that is what makes the room live.
await fire("message_end", { message: { role: "user", content: injected } });

// ── the run ends empty at 95% of the window ─────────────────────────────────
const emptyTurn = { messages: [{ role: "assistant", content: [], stopReason: "stop", usage: { output: 0 } }] };
await fire("agent_end", emptyTurn);
check("the loop routed the empty turn to context recovery",
  notices.some((l) => /context pressure detected/.test(l)));

// ── the moment ──────────────────────────────────────────────────────────────
compactCalls.length = 0;
userMessages.length = 0;
const before = replies().length;
await fire("agent_settled", {});
await sleep(400);
const after = replies().slice(before);

const nudges = userMessages.filter((m) => /Answer the outstanding question/.test(m.text));
console.log(`
     on this one agent_settled:                 BEFORE            NOW
       ctx.compact() calls                    : 1                 ${compactCalls.length}
       continuation nudges sent               : 1                 ${nudges.length}
       …that pi would have TAKEN              : 0                 ${nudges.filter((n) => n.taken).length}
       retries charged to the sender's message: 1                 ${retriesCharged()}
       what the sender was told, and when     : nothing;          ${after.length ? "immediately" : "nothing"}
                                                the sweep, 60s
                                                later, guessing
`);
for (const n of nudges) console.log(`     nudge  taken=${n.taken}  ${JSON.stringify(n.text.slice(0, 64))}…`);
for (const line of after) console.log(`     the room was told : ${JSON.stringify(line.slice(0, 96))}`);
console.log("");

check("the loop started its emergency compaction", compactCalls.length === 1);
check("prinny sent NO continuation into it", nudges.length === 0);
check("…and charged the message no retry for a send that could not happen", retriesCharged() === 0);
check("the sender is told, on this settlement rather than by the sweep a minute later",
  after.some((t) => /already compacting/.test(t)));
check("…and told the true reason rather than the sweep's hedge",
  after.some((t) => /already compacting/.test(t) && !/may have been/.test(t)));
check("the flag it read is the one the fifteenth pass built",
  loopLock.compactionInFlight()?.owner === "pi-loop-mode");
console.log(`     compactionInFlight() at the moment of the decision : ${JSON.stringify(loopLock.compactionInFlight()?.owner)}`);

await fire("session_shutdown", {});
console.log("");
console.log(failures > 0 ? `   ${failures} expectation(s) failed` : "   all expectations held");
process.exit(failures > 0 ? 1 : 0);
