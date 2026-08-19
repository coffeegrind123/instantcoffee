/**
 * t2 — the loop turn that starts a run while a compaction is running.
 * FIXED — this probe prints BEFORE and NOW.
 *
 * pi has two entry points and only one of them refuses:
 *
 *   AgentSession.prompt()          if (this._compactionAbortController !== undefined)
 *                                      throw "Cannot submit a prompt while compaction
 *                                             is in progress…"            :807
 *   AgentSession.sendCustomMessage else if (options?.triggerTurn)
 *                                      await this._runAgentPrompt(appMessage)  :1089
 *
 * `_runAgentPrompt` has no such check — `_isAgentRunActive = true; await
 * this.agent.prompt(messages)`. And `pi.sendMessage(...)` IS `sendCustomMessage`,
 * which is how vendor/pi-loop-mode delivers EVERY turn it drives.
 *
 * So a loop turn on a timer started an agent run inside somebody else's
 * compaction — and pi's compact() ends with
 * `this.agent.state.messages = sessionContext.messages`, which REPLACES the
 * array that run is streaming into.
 *
 * NOW `sendLoopTurn` reads `compactionInFlight()` — the flag this package
 * already reads in `requestEmergencyCompaction` and in `interveneStuck`'s
 * compaction rung — and RESCHEDULES rather than sends. The iteration is delayed
 * by COMPACTION_WAIT_MS, never lost, and the operator is told once.
 *
 *   run: node t2-turn-into-a-compaction.mjs
 */

import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = "/home/claudeuser/qwen3.8-forge";
const PI_DIST = "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist";

let failures = 0;
const check = (l, ok) => { console.log(`   ${ok ? "ok  " : "FAIL"}  ${l}`); if (!ok) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log("\nt2 — a loop turn delivered into a compaction that is already running\n");

// pi's two entry points, pinned.
{
  const src = readFileSync(`${PI_DIST}/core/agent-session.js`, "utf8");
  check("prompt() refuses while a compaction holds the controller",
    /if \(this\._compactionAbortController !== undefined\) \{\s*\n\s*throw new Error\("Cannot submit a prompt while compaction is in progress/.test(src));
  const scm = src.slice(src.indexOf("async sendCustomMessage(message, options)"), src.indexOf("async sendCustomMessage(message, options)") + 1200);
  check("sendCustomMessage's triggerTurn branch calls _runAgentPrompt directly",
    /else if \(options\?\.triggerTurn\) \{\s*\n\s*await this\._runAgentPrompt\(appMessage\)/.test(scm));
  check("…and it makes no compaction check of its own", !/_compactionAbortController/.test(scm));
  const rap = src.slice(src.indexOf("async _runAgentPrompt(messages)"), src.indexOf("async _handlePostAgentRun()"));
  check("_runAgentPrompt makes none either", !/_compactionAbortController/.test(rap));
  check("compact() ends by REPLACING the message array",
    /this\.agent\.state\.messages = sessionContext\.messages/.test(src));
}

const stateDir = mkdtempSync(join(tmpdir(), "probe-prinny-"));
mkdirSync(join(stateDir, "runtime", "dist"), { recursive: true });
writeFileSync(join(stateDir, "runtime", "dist", "server.js"), "// stand-in\n");
writeFileSync(join(stateDir, ".env"),
  "PRINNY_HOMESERVER=https://example.org\nPRINNY_USER_ID=@bot:example.org\nPRINNY_PASSWORD=x\n", { mode: 0o600 });
const inbox = join(stateDir, "inbox.jsonl"), outbox = join(stateDir, "outbox.jsonl");
writeFileSync(inbox, ""); writeFileSync(outbox, "");
process.env.PRINNY_STATE_DIR = stateDir;
process.env.PRINNY_SIDECAR_ENTRY = join(REPO, "context", "testing", "probes", "_sidecar.mjs");
process.env.PROBE_INBOX = inbox; process.env.PROBE_OUTBOX = outbox;

const { createJiti } = await import(`${PI_DIST}/../node_modules/jiti/lib/jiti.mjs`);
const NM = `${PI_DIST}/../node_modules/@earendil-works`, NMR = `${PI_DIST}/../node_modules`;
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

const loopHandlers = new Map(), prinnyHandlers = new Map();
let registering = loopHandlers;
const compactCalls = [], notices = [], sent = [];
let loopCommand;
let compactionRunning = false;

const pi = {
  on: (n, f) => registering.set(n, [...(registering.get(n) ?? []), f]),
  registerCommand: (n, c) => { if (n === "loop") loopCommand = c.handler; },
  registerTool() {}, registerEntryRenderer() {}, appendEntry() {},
  // pi.sendMessage IS AgentSession.sendCustomMessage. Modelled exactly: on an
  // idle session with triggerTurn it reaches _runAgentPrompt, which starts a run
  // whatever else is happening.
  sendMessage: (message, options) => {
    const route = options?.deliverAs === "nextTurn" ? "queued (nextTurn)"
      : options?.triggerTurn ? "_runAgentPrompt — A RUN STARTS"
      : "appended, no turn";
    sent.push({ kind: message?.details?.kind, route, duringCompaction: compactionRunning });
  },
  sendUserMessage() {},
  exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }),
  setModel: async () => true,
};

const ctx = {
  cwd: process.cwd(), mode: "tui", hasUI: true,
  ui: { notify: (m) => notices.push(String(m)), setStatus() {} },
  sessionManager: { getBranch: () => [{ type: "message" }], getEntries: () => [] },
  modelRegistry: { find: () => undefined, getAll: () => [] },
  model: { api: "openai-completions", contextWindow: 32_768 },
  isIdle: () => !compactionRunning,
  hasPendingMessages: () => false,
  getContextUsage: () => ({ tokens: 8_000, contextWindow: 32_768, percent: 24 }),
  compact: (o) => { compactCalls.push(o); compactionRunning = true; },
  abort() {}, async waitForIdle() {},
};

registering = loopHandlers; loopMode(pi);
registering = prinnyHandlers; prinnyChannel(pi);
const fire = async (n, e = {}) => {
  for (const f of loopHandlers.get(n) ?? []) await f(e, ctx);
  for (const f of prinnyHandlers.get(n) ?? []) await f(e, ctx);
};
const post = (m) => appendFileSync(inbox, `${JSON.stringify(m)}\n`);
const replies = () => readFileSync(outbox, "utf8").split("\n").filter(Boolean)
  .map((l) => JSON.parse(l)).filter((e) => e.name === "reply").map((e) => String(e.arguments?.text ?? ""));

await fire("session_start", {});
await sleep(1200);

loopLock.resetCompactionLock();
await loopCommand("start keep the docs in step with the code --delay 1", ctx);
sent.length = 0; notices.length = 0;

// One ordinary, productive loop turn: it schedules the next iteration one second out.
await fire("agent_start", {});
await fire("agent_end", {
  messages: [{ role: "assistant", content: [{ type: "text", text: "Updated README.md with the new flag." }], stopReason: "stop", usage: { output: 40 } }],
});
await fire("agent_settled", {});
check("the loop scheduled its next iteration on the delay timer", sent.length === 0);

// The session is now idle between iterations. A Matrix /compact arrives.
post({
  content: "/compact",
  meta: { room_id: "!alice:example.org", chat_id: "!alice:example.org", message_id: "$c1",
          user: "Alice", user_id: "@alice:example.org", ts: "2026-08-19T00:00:00.000Z", is_direct: "true" },
});
await sleep(400);
check("prinny compacted right away — the session was idle, so nothing to defer to",
  compactCalls.length === 1 && compactionRunning);
check("…and it holds the lock", loopLock.compactionInFlight()?.owner === "prinny-channel");

// …and the loop's delay timer fires into it.
await sleep(1200);
const during = sent.filter((s) => s.duringCompaction);
const held = notices.filter((n) => /is compacting/.test(n));
console.log(`
                                                          BEFORE   NOW
     loop turns delivered into the running compaction  :   1        ${during.length}
     …on the entry point that does not refuse          :   yes      ${during.length ? "yes" : "n/a"}
     what the operator was told                        :   nothing  ${held.length ? "once" : "nothing"}
`);
for (const s of sent) console.log(`     kind=${String(s.kind).padEnd(9)} route=${s.route.padEnd(28)} duringCompaction=${s.duringCompaction}`);
for (const n of held) console.log(`     notice : ${JSON.stringify(n)}`);
console.log("");

check("no loop turn is delivered into the running compaction", during.length === 0);
check("…and the flag it read is the one this package already reads twice",
  loopLock.compactionInFlight()?.owner === "prinny-channel");
check("the operator is told once, naming who is compacting",
  held.length === 1 && /prinny-channel/.test(held[0]));

// ── and the iteration is DEFERRED, not lost ─────────────────────────────────
compactionRunning = false;
loopLock.resetCompactionLock();
await sleep(6000);
const after = sent.filter((s) => !s.duringCompaction);
console.log(`
     once the compaction released the lock:
       loop turns delivered : ${after.length}   ← deferred, never dropped
`);
for (const s of after) console.log(`     kind=${String(s.kind).padEnd(9)} route=${s.route}`);
check("the iteration goes as soon as the lock is free", after.length === 1);
check("…and it is the same one that was held", after[0]?.kind === "continue");
check("…and it is not repeated once per wait", held.length === 1);

await fire("session_shutdown", {});
console.log("");
console.log(failures > 0 ? `   ${failures} expectation(s) failed` : "   all expectations held");
process.exit(failures > 0 ? 1 : 0);
