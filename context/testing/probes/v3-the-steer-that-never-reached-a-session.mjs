/**
 * v3 — AI3. The steer that was accepted for a session that never opened.
 *
 * FIXED — this probe prints BEFORE and NOW, driving the SHIPPED `AgentManager`:
 * the real `steer()`, the real `growBrief`, and the real settlement chain.
 *
 * ## The promise
 *
 * `AgentManager.steer()` has a branch for a record that is `running` and has no
 * session yet:
 *
 * ```ts
 *   if (!record.execution.session) {
 *     record.execution.pendingSteers.push(message);
 *     // Queued, so it WILL reach the model — onSessionCreated flushes it.
 *     this.growBrief(record, message);
 *     return true;
 *   }
 * ```
 *
 * `true` is what `steerReport` turns into *"Steer sent to X…"* for the operator,
 * and the comment is the promise it rests on.
 *
 * ## Where it is not true
 *
 * `onSessionCreated` fires from `createAndConfigureSession`, and everything
 * `runAgentImpl` does before that is a window in which the record is already
 * `running` and there is no session: a `SettingsManager`, the system-prompt
 * sources, `detectEnv` (two git subprocesses on a 9p mount), and
 * `reloadAndMap()`, which calls EVERY extension factory again for the child —
 * including rtk's shell-out to `rtk --version`. A run that dies anywhere in it
 * never flushes.
 *
 * Two things were untrue at once, and the second is worse: the operator had been
 * told the steer was sent, and `growBrief` had already recorded it — so the
 * accumulated brief, which the anchor restates and which the JUDGE checks the
 * answer against, contained an instruction the child was never given.
 *
 * ## The window, measured
 *
 * Block 1 spawns a real subagent and samples the record one second in. On this
 * box that same spawn reached settlement at ~16.5 s, essentially all of it
 * before the session exists.
 *
 *   run: node v3-the-steer-that-never-reached-a-session.mjs
 */

import { readFileSync } from "node:fs";
import { createJiti } from "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";

const PI_DIST = "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist";
const NM = `${PI_DIST}/../node_modules/@earendil-works`;
const jiti = createJiti(`file://${PI_DIST}/index.js`, {
  interopDefault: true,
  alias: { "@earendil-works/pi-coding-agent": `${PI_DIST}/index.js`, "@earendil-works/pi-tui": `${NM}/pi-tui` },
});
const REPO = "/home/claudeuser/qwen3.8-forge";
const R = `${REPO}/vendor/pi-subagents-lite/src`;

const shell = await jiti.import(`${R}/shell.ts`);
const { AgentManager } = await jiti.import(`${R}/agents/agent-manager.ts`);
const { steerReport } = await jiti.import(`${R}/ui/action-report.ts`);

let failures = 0;
const check = (label, ok) => {
  console.log(`   ${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log("\nv3 — the steer that never reached a session\n");

// ── the promise, read out of the module that makes it ────────────────────────
{
  const src = readFileSync(`${R}/agents/agent-manager.ts`, "utf8");
  check(
    "steer() returns true for a queued one, on the promise in its own comment",
    /Queued, so it WILL reach the model — onSessionCreated flushes it\./.test(src),
  );
  check("…and grows the brief on the way past", /pendingSteers\.push\(message\);\s*\n\s*\/\/[\s\S]{0,120}?this\.growBrief\(record, message\)/.test(src));
  check("the operator's sentence for a true is 'Steer sent to'", /Steer sent to \$\{shortId\}…/.test(readFileSync(`${R}/ui/action-report.ts`, "utf8")));
  check("…which is what the menu shows", steerReport(true, "1a2b3c4d").text.startsWith("Steer sent to 1a2b3c4d"));
}

const notices = [];
const warned = [];
const realWarn = console.warn;
console.warn = (...args) => warned.push(args.join(" "));

shell.setPiInstance({ sendMessage() {} });
const ctx = {
  cwd: process.cwd(),
  ui: { notify: (message) => notices.push(String(message)) },
  model: { contextWindow: 32_768 },
  getContextUsage: () => ({ tokens: 0, contextWindow: 32_768, percent: 0 }),
};
shell.setSessionCtx(ctx);
const manager = new AgentManager(undefined, { default: 1 }, undefined);
shell.setManager(manager);

// ── 1. the window, on a REAL spawn ───────────────────────────────────────────
{
  const id = manager.spawn(shell.getPiInstance(), ctx, "general-purpose", "map the retry paths", {
    modelKey: "probe/model",
    graceTurns: 2,
    maxTurns: 4,
  });
  const record = manager.getRecord(id);
  await sleep(1_000);
  console.warn = realWarn;
  console.log("\n   one second after spawn, on a real subagent:\n");
  console.log(`      lifecycle.status            : ${record.lifecycle.status}`);
  console.log(`      execution.session           : ${record.execution.session ? "present" : "absent"}`);
  check("the record is already running", record.lifecycle.status === "running");
  check("…and has no session yet, which is the whole window", !record.execution.session);
  console.warn = (...args) => warned.push(args.join(" "));
  // The run is left to float; the probe exits explicitly below. Measured
  // separately, this same spawn settled at ~16.5 s — essentially all of it
  // spent before the session exists.
  manager.agents.delete(id);
}

// ── 2. a steer into that window, and a run that dies in it ───────────────────
const ID = "steer-window-01";
const record = {
  id: ID,
  lifecycle: { status: "running", startedAt: Date.now(), started: true },
  display: { type: "Explore", description: "map the retry paths" },
  execution: { settled: false, settlementCount: 0, brief: "Map every retry path in the streaming layer.", spawnCtx: ctx },
  stats: { lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 }, toolUses: 0, turnCount: 0, compactionCount: 0 },
};
manager.agents.set(ID, record);

const accepted = await manager.steer(ID, "also list the callers of decodeFrame()");
console.log("\n   the operator steers it while it is still being built:\n");
console.log(`      steer() answered            : ${accepted}   → "${steerReport(accepted, ID.slice(0, 8)).text}"`);
console.log(`      pendingSteers               : ${JSON.stringify(record.execution.pendingSteers)}`);
console.log(`      brief now ends with         : ${JSON.stringify(record.execution.brief.slice(-46))}`);

check("the steer is accepted", accepted === true);
check("…and queued", record.execution.pendingSteers?.length === 1);
check(
  "…and already in the brief the JUDGE checks the answer against",
  /also list the callers of decodeFrame\(\)/.test(record.execution.brief),
);

// The run dies before `onSessionCreated` — an extension factory throwing inside
// `reloadAndMap()`, a settings directory that cannot be read, a worktree that
// went away. The SHIPPED settlement chain is what runs next.
const before = { notices: notices.length, warned: warned.length };
manager.attachSettlementChain(record, Promise.reject(new Error("extension factory threw during reloadAndMap()")));
await sleep(120);
console.warn = realWarn;

const said = warned.slice(before.warned).filter((line) => /never opened a session/.test(line));
const told = notices.slice(before.notices).filter((line) => /never opened a session/.test(line));

console.log("\n      BEFORE                                     NOW");
console.log("      ────────────────────────────────────────   ────────────────────────────────────────");
console.log(`      pendingSteers: ["also list the …"]         pendingSteers: ${JSON.stringify(record.execution.pendingSteers)}`);
console.log(`      nothing said, anywhere                     ${told.length} notice, ${said.length} log line`);
console.log(`      "Steer sent to steer-wi…" stands           "${(told[0] ?? "").slice(0, 58)}…"`);
console.log("");

check("the record settled as an error, which is what a setup failure is", record.lifecycle.status === "error");
check("the undelivered steer is reported", told.length === 1 && said.length === 1);
check("…on a channel that exists headless", said.length === 1);
check("…and names the agent", (told[0] ?? "").includes("steer-wi"));
check("…and says the answer was not written with it", /answer was not written with them/.test(told[0] ?? ""));
check("…and what to do instead", /Re-send/.test(told[0] ?? ""));
check("the queue is cleared, so a continuation cannot report it twice", record.execution.pendingSteers === undefined);

// The count, because a queue is a queue.
{
  const ID2 = "steer-window-02";
  const two = {
    id: ID2,
    lifecycle: { status: "running", startedAt: Date.now(), started: true },
    display: { type: "Explore", description: "x" },
    execution: { settled: false, settlementCount: 0, brief: "b", spawnCtx: ctx },
    stats: { lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 }, toolUses: 0, turnCount: 0, compactionCount: 0 },
  };
  manager.agents.set(ID2, two);
  await manager.steer(ID2, "one");
  await manager.steer(ID2, "two");
  const at = notices.length;
  console.warn = (...args) => warned.push(args.join(" "));
  manager.attachSettlementChain(two, Promise.reject(new Error("same failure, two steers")));
  await sleep(120);
  console.warn = realWarn;
  const line = notices.slice(at).find((l) => /never opened a session/.test(l)) ?? "";
  console.log(`   two queued steers say so    : ${JSON.stringify(line.slice(0, 72))}`);
  check("the count is stated and pluralised", /the 2 steers queued for it were/.test(line));
}

// The control: a record whose session DID open has nothing to report.
{
  const ID3 = "steer-window-03";
  const three = {
    id: ID3,
    lifecycle: { status: "running", startedAt: Date.now(), started: true },
    display: { type: "Explore", description: "x" },
    execution: { settled: false, settlementCount: 0, brief: "b", spawnCtx: ctx },
    stats: { lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 }, toolUses: 0, turnCount: 0, compactionCount: 0 },
  };
  manager.agents.set(ID3, three);
  await manager.steer(ID3, "queued while building");
  // This is what `onSessionCreated` does.
  three.execution.pendingSteers = undefined;
  const at = notices.length;
  console.warn = (...args) => warned.push(args.join(" "));
  manager.attachSettlementChain(three, Promise.resolve({ responseText: "done", aborted: false, turnLimited: false }));
  await sleep(120);
  console.warn = realWarn;
  check(
    "control: a flushed queue reports nothing — every ordinary spawn takes this path",
    !notices.slice(at).some((l) => /never opened a session/.test(l)),
  );
}

console.log(`
   The brief is deliberately left alone. \`growBrief\` recorded the steer when it
   was accepted, and un-growing it would silently change what the verifier checks
   against on a record whose run is already over. The sentence says the answer
   was not written with them, which is the fact the parent acts on.

   Pinned by pi-subagents-lite/tests/action-report.test.ts, "AI3 — a queued steer
   that never reached a session". Removing the fix fails 1 test there and 7 of
   this probe's expectations.
`);

manager.dispose();
console.log(failures > 0 ? `   ${failures} expectation(s) failed` : "   all expectations held");
process.exit(failures > 0 ? 1 : 0);
