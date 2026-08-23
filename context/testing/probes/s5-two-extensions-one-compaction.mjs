/**
 * s5 — §11.12, closed. Two extensions, one session, one `agent_settled`, and two
 * `ctx.compact()` calls.
 * FIXED — this probe prints BEFORE and NOW side by side.
 *
 * Recorded by the fourteenth pass (§11.7 of `…-claims.md`) and by the fifteenth
 * (§11.12 of `…-omissions.md`), closed by neither, because the fix is a flag that
 * neither package can own.
 *
 * The collision:
 *
 *     agent_settled
 *       ├─ pi-loop-mode   runs FIRST  → requestEmergencyCompaction → ctx.compact()
 *       └─ prinny-channel runs SECOND → drainPendingCompaction     → ctx.compact()
 *
 * and pi's `compact()` does not refuse a second call:
 *
 *     async compact(customInstructions) {
 *         await this.abort();                     dist/core/agent-session.js:1367
 *
 * — it aborts, overwrites `_compactionAbortController`, and proceeds. So the
 * second call cancels the first one's work, and `AgentSession.prompt()` throws
 * "Cannot submit a prompt while a compaction is in progress" for anything that
 * arrives in between, into a rejection pi swallows into `emitError` (no listeners
 * headless).
 *
 * The two conditions are correlated rather than independent, which is what makes
 * this reachable: a Matrix sender asks for a compaction BECAUSE the bot has gone
 * quiet, and an empty turn at 87%+ of the window is exactly what the loop's own
 * context ladder is for. One saturated session produces both.
 *
 * **This is the first probe in the series that drives TWO extensions against each
 * other**, and it has to be: the collision is a one-process phenomenon — node's
 * module cache is why both extensions share a session at all — so a probe that
 * ran them separately could not see it. Both are the shipped modules, loaded
 * through pi's own jiti, registered in `scripts/pi-local.sh`'s order, and fired
 * in that order the way pi's `ExtensionRunner` fires them.
 *
 *   run: node s5-two-extensions-one-compaction.mjs
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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

console.log("\ns5 — one agent_settled, two extensions, and the compaction each wanted\n");

// ── pi's own compact(), pinned ───────────────────────────────────────────────
{
  const session = readFileSync(`${PI_DIST}/core/agent-session.js`, "utf8");
  const at = session.indexOf("async compact(customInstructions)");
  const body = session.slice(at, at + 160).split("\n").slice(0, 3);
  console.log(body.map((line) => "   " + line.trim()).join("\n"));
  check("pi's compact() still begins by aborting the session", /await this\.abort\(\)/.test(body.join(" ")));
}

// ── a state dir prinny will accept ───────────────────────────────────────────
const stateDir = mkdtempSync(join(tmpdir(), "probe-prinny-"));
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
const inbox = join(stateDir, "inbox.jsonl");
const outbox = join(stateDir, "outbox.jsonl");
writeFileSync(inbox, "");
writeFileSync(outbox, "");
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

// The two shipped extensions, in one process, exactly as node's module cache puts
// them there in a real session.
const loopMode = (await jiti.import(`${REPO}/vendor/pi-loop-mode/extensions/index.ts`)).default;
const prinnyChannel = (await jiti.import(`${REPO}/vendor/prinny-channel/extensions/index.ts`)).default;

// Their two copies of the lock protocol — separate modules, one global key.
const loopLock = await jiti.import(`${REPO}/vendor/pi-loop-mode/src/compaction-lock.ts`);
const prinnyLock = await jiti.import(`${REPO}/vendor/prinny-channel/src/compaction-lock.ts`);

console.log("");
check("the two packages agree on the global key", loopLock.COMPACTION_LOCK_KEY === prinnyLock.COMPACTION_LOCK_KEY);
check("…and on the staleness bound", loopLock.STALE_MS === prinnyLock.STALE_MS);
check("…and they are genuinely separate modules", loopLock !== prinnyLock);
{
  // The interlock, at the module level, before any extension is involved: one
  // package takes it, the other is refused, and only the owner can release it.
  loopLock.resetCompactionLock();
  const taken = loopLock.beginCompaction(loopLock.LOOP_OWNER);
  const refused = prinnyLock.beginCompaction(prinnyLock.PRINNY_OWNER) === false;
  prinnyLock.endCompaction(prinnyLock.PRINNY_OWNER);
  const stillHeld = prinnyLock.compactionInFlight()?.owner === loopLock.LOOP_OWNER;
  loopLock.endCompaction(loopLock.LOOP_OWNER);
  const released = prinnyLock.compactionInFlight() === undefined;
  check("one takes it, the other is refused", taken && refused);
  check("a non-owner's release does nothing", stillHeld);
  check("the owner's release frees it for the other", released);
}

// ── the host, shared by both extensions, as pi shares one ────────────────────
const loopHandlers = new Map();
const prinnyHandlers = new Map();
let registering = loopHandlers;

/** Every ctx.compact() that reached "pi", in order. THIS LIST IS THE FINDING. */
const compactCalls = [];
const notices = [];
let loopCommand;

const pi = {
  on: (name, fn) => registering.set(name, [...(registering.get(name) ?? []), fn]),
  registerCommand: (name, config) => {
    if (name === "loop") loopCommand = config.handler;
  },
  registerTool() {},
  registerEntryRenderer() {},
  appendEntry() {},
  sendMessage() {},
  sendUserMessage() {},
  exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
  setModel: async () => true,
};

let contextPercent = 95;
const ctx = {
  cwd: process.cwd(),
  mode: "tui",
  hasUI: true,
  ui: { notify: (message) => notices.push(String(message)), setStatus() {} },
  sessionManager: { getBranch: () => [{ type: "message" }], getEntries: () => [] },
  modelRegistry: { find: () => undefined, getAll: () => [] },
  model: { api: "openai-completions", contextWindow: 32_768 },
  isIdle: () => true,
  hasPendingMessages: () => false,
  getContextUsage: () => ({
    tokens: Math.round((32_768 * contextPercent) / 100),
    contextWindow: 32_768,
    percent: contextPercent,
  }),
  // The whole of what pi's ctx.compact does that matters here, in the order it
  // does it — and DELIBERATELY without calling back, because a compaction that
  // is still running is the state the collision happens in.
  compact: (options) => {
    compactCalls.push({ at: compactCalls.length + 1, options });
  },
  abort() {},
  async waitForIdle() {},
};

// Load order is `scripts/pi-local.sh`'s: pi-loop-mode, then prinny-channel.
registering = loopHandlers;
loopMode(pi);
registering = prinnyHandlers;
prinnyChannel(pi);

/** Fire one event through both extensions, in registration order, as pi does. */
const fire = async (name, event = {}) => {
  for (const fn of loopHandlers.get(name) ?? []) await fn(event, ctx);
  for (const fn of prinnyHandlers.get(name) ?? []) await fn(event, ctx);
};
const post = (message) => appendFileSync(inbox, `${JSON.stringify(message)}\n`);
const replies = () =>
  readFileSync(outbox, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.name === "reply")
    .map((entry) => String(entry.arguments?.text ?? ""));

await fire("session_start", {});
await sleep(1200);

// ── the setup: a loop on a saturated context, and a Matrix /compact mid-turn ──
loopLock.resetCompactionLock();
await loopCommand("start keep the docs in step with the code", ctx);
notices.length = 0;

// prinny: a sender asks for a compaction while the session is mid-turn, so it is
// deferred to agent_settled (AD3).
await fire("agent_start", {});
post({
  content: "/compact",
  meta: {
    room_id: "!alice:example.org",
    chat_id: "!alice:example.org",
    message_id: "$c1",
    user: "Alice",
    user_id: "@alice:example.org",
    ts: "2026-08-19T00:00:00.000Z",
    is_direct: "true",
  },
});
await sleep(300);
check(
  "AD3 holds: the Matrix /compact is deferred rather than run mid-turn",
  replies().some((text) => /mid-turn/.test(text)),
);

// the loop: an empty turn at 95% of the window is context pressure, which the
// loop defers to agent_settled as well (its own emergency compaction).
await fire("agent_end", {
  messages: [{ role: "assistant", content: [], stopReason: "stop", usage: { output: 0 } }],
});
check(
  "the loop routed the empty turn to context recovery",
  notices.some((line) => /context pressure detected/.test(line)),
);

// ── the moment ───────────────────────────────────────────────────────────────
compactCalls.length = 0;
const before = replies().length;
await fire("agent_settled", {});
await sleep(400);
const after = replies().slice(before);

console.log(`
     ctx.compact() calls on this one agent_settled:

       BEFORE   2   ← pi-loop-mode's emergency compaction, then
                      prinny-channel's deferred /compact, which begins
                      \`await this.abort()\` and cancels the first
       NOW      ${compactCalls.length}
`);
for (const line of after) console.log(`     the room was told : ${JSON.stringify(line.slice(0, 72))}`);
console.log("");

check("exactly one compaction reaches pi", compactCalls.length === 1);
check(
  "the loop's is the one that runs — it asked first, and it holds the lock",
  loopLock.compactionInFlight()?.owner === loopLock.LOOP_OWNER,
);
check(
  "and prinny tells the sender their compaction is happening, not that it failed",
  after.some((text) => /already running/.test(text)),
);
check(
  "…without claiming it finished, which it has not",
  !after.some((text) => /^Compacted the conversation context\./.test(text)),
);

// ── the other order, which is the one the loop can lose ──────────────────────
//
// Same collision, prinny first: if the loop's own compaction arrives while
// prinny's is in flight, the loop must ADOPT it rather than abort it — the same
// answer it already gives when pi has compacted the branch itself.
loopLock.resetCompactionLock();
prinnyLock.beginCompaction(prinnyLock.PRINNY_OWNER);
compactCalls.length = 0;
notices.length = 0;
contextPercent = 95;
await fire("agent_end", {
  messages: [{ role: "assistant", content: [], stopReason: "stop", usage: { output: 0 } }],
});
await fire("agent_settled", {});
await sleep(200);

console.log(`     with prinny holding the lock, the loop asked for ${compactCalls.length} compaction(s)\n`);
check("the loop does not abort prinny's compaction", compactCalls.length === 0);
check(
  "it adopts it, and says whose it was",
  notices.some((line) => /context recovered/i.test(line)),
);
check(
  "…and names the other extension in the log line",
  notices.some((line) => /prinny-channel was already compacting/.test(line)),
);
loopLock.resetCompactionLock();

// ── the control: no collision, and nothing changes ───────────────────────────
//
// A fresh run first, and not for tidiness: this is the THIRD consecutive context
// failure in this process, and `CONTEXT_RECOVERY_ATTEMPTS` is 3 — so without a
// restart the loop would enter a cooldown instead of asking for a compaction, and
// the control would be measuring the recovery ladder rather than the lock.
await loopCommand("start keep the docs in step with the code", ctx);
compactCalls.length = 0;
notices.length = 0;
await fire("agent_end", {
  messages: [{ role: "assistant", content: [], stopReason: "stop", usage: { output: 0 } }],
});
await fire("agent_settled", {});
await sleep(200);
check("control — with the lock free, the loop's compaction runs as before", compactCalls.length === 1);
loopLock.resetCompactionLock();

await fire("session_shutdown", {});
console.log("");
if (failures > 0) {
  console.log(`   ${failures} expectation(s) failed`);
  process.exit(1);
}
console.log("   all expectations held");
process.exit(0);
