/**
 * s2 — AF4 and AF2. What the agent list prints, and what an action that was
 * refused says.
 * FIXED — this probe prints BEFORE and NOW side by side.
 *
 * ## AF4 — the bound that kept the wrong end
 *
 * `AgentStatus` is bounded: everything unfinished, plus the most recent few that
 * are finished, with the rest counted as `(+N older, see /agents)`. The rule was
 *
 *     const keptSettled = limit > 0 ? settled.slice(-limit) : [];
 *
 * under a comment saying *"order within each group is the manager's own (spawn
 * order), so the newest settled agents come last"*. The manager's own order is
 *
 *     listAgents() {
 *       return [...this.agents.values()].sort((a, b) => b.lifecycle.startedAt - a.lifecycle.startedAt);
 *     }
 *
 * — newest FIRST. So `slice(-6)` kept the six OLDEST agents of the session and
 * elided the batch the model had just launched, while calling them "older".
 *
 * The unit test could not see it: it built its array oldest-first, which is the
 * one order the caller never uses. This probe drives the real `AgentManager` and
 * the real tool, through pi's own jiti, so the ordering under test is the
 * shipped one.
 *
 * ## AF2 — the refusals the caller did not read
 *
 * `AgentManager.clear()` returns false for a record whose answer is still being
 * checked (Y1: `removeRecord` disposes the session a repair is running IN), and
 * `abort()` returns false for a record that finished while the menu was open.
 * The `/agents` menu discarded both booleans and reported the action as done —
 * "Cleared 1a2b3c4d" about a record that is still there. The second block below
 * drives the real manager to the state where each refusal happens and prints the
 * sentence the operator now gets.
 *
 *   run: node s2-the-six-oldest-agents.mjs
 */

import { createJiti } from "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";

const PI = "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
const NM = "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works";
const jiti = createJiti(`file://${PI}`, {
  interopDefault: true,
  alias: { "@earendil-works/pi-coding-agent": PI, "@earendil-works/pi-tui": `${NM}/pi-tui` },
});
const R = "/home/claudeuser/qwen3.8-forge/vendor/pi-subagents-lite/src";

const shell = await jiti.import(`${R}/shell.ts`);
const { AgentManager } = await jiti.import(`${R}/agents/agent-manager.ts`);
const { executeAgentStatusTool } = await jiti.import(`${R}/agents/agent-status.ts`);
const { selectAgentsToList, MAX_SETTLED_LISTED } = await jiti.import(`${R}/agents/status-listing.ts`);
const { stopReport, clearReport } = await jiti.import(`${R}/ui/action-report.ts`);
const { isVerifyingRecord } = await jiti.import(`${R}/agents/record-activity.ts`);

let failures = 0;
const check = (label, ok) => {
  console.log(`   ${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) failures++;
};

console.log("\ns2 — the agent list's bound, and the actions the manager refuses\n");

// ── AF4 ──────────────────────────────────────────────────────────────────────
console.log("   AF4 — ten settled agents, a0 the oldest and a9 the newest\n");

const manager = new AgentManager(undefined, { default: 1 }, undefined);
shell.setManager(manager);

const settled = (id, at) => ({
  id,
  lifecycle: { status: "completed", startedAt: at, completedAt: at, started: true },
  display: { type: `T${id.slice(1)}`, description: "d" },
  execution: { settled: true, settlementCount: 1 },
  stats: { lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 }, toolUses: 0, turnCount: 0, compactionCount: 0 },
});

// The private field is a plain property at runtime; writing records straight in
// is what lets the REAL `listAgents()` ordering be the thing under test.
for (let i = 0; i < 10; i++) manager.agents.set(`a${i}`, settled(`a${i}`, 1_000 + i));

const order = manager.listAgents().map((r) => r.id);
console.log(`   listAgents() hands them over : ${order.join(" ")}`);
check("newest first — which is the order the bound has to cope with", order[0] === "a9");

const out = await executeAgentStatusTool("probe", {}, undefined, undefined, {});
const line = out.content[0].text.split("\n")[0];
console.log(`
     BEFORE  a5 (T5) completed, a4 (T4) completed, a3 (T3) completed,
             a2 (T2) completed, a1 (T1) completed, a0 (T0) completed
             (+4 older, see /agents)
     NOW     ${line}
`);

const listedIds = [...line.matchAll(/\b(a\d)\b/g)].map((m) => m[1]);
check("the six NEWEST are listed", listedIds.join(" ") === "a4 a5 a6 a7 a8 a9");
check("the newest sits last, next to the nudge", listedIds[listedIds.length - 1] === "a9");
check('and "(+4 older)" is now true of the ones it left out', /\(\+4 older/.test(line));
check("the bound itself is unchanged", listedIds.length === MAX_SETTLED_LISTED);

// The control: the same records handed over oldest-first must produce the same
// answer. A bound that depends on the caller's order is the defect.
const oldestFirst = [...manager.listAgents()].reverse();
const bothWays = selectAgentsToList(oldestFirst).listed.map((r) => r.id).join(" ");
check("…whichever order the caller hands them over in", bothWays === "a4 a5 a6 a7 a8 a9");

// ── AF2 ──────────────────────────────────────────────────────────────────────
console.log("\n   AF2 — the two refusals the /agents menu used to announce as successes\n");

// A record in the state Y1 is about: the child's own run is classified and
// terminal, and the verifier is still working on the answer.
const verifying = settled("v1", 2_000);
verifying.verifyPhase = "repairing";
manager.agents.set("v1", verifying);
check("the record reads as verifying", isVerifyingRecord(verifying));

const cleared = manager.clear("v1");
const clearLine = clearReport(cleared, "v1", isVerifyingRecord(verifying));
console.log(`     clear()  returned ${cleared}`);
console.log(`     BEFORE   "Cleared v1"        ← and the record is still there`);
console.log(`     NOW      "${clearLine.text}"`);
check("clear() refuses — the repair's session must not be disposed", cleared === false);
check("the record survived the refusal", manager.getRecord("v1") !== undefined);
check("and the operator is told the truth", !/^Cleared/.test(clearLine.text));

// A record that finished while the menu was open: `abort()` has nothing to do.
const finished = manager.getRecord("a3");
const stopped = manager.abort("a3", "user");
const stopLine = stopReport(stopped, "a3", isVerifyingRecord(finished));
console.log(`\n     abort()  returned ${stopped}`);
console.log(`     BEFORE   "Stopped a3"`);
console.log(`     NOW      "${stopLine.text}"`);
check("abort() refuses a settled record", stopped === false);
check("and the operator is not told it stopped", !/^Stopped/.test(stopLine.text));

// The control: the same two calls on records that DO accept them.
const running = settled("r1", 3_000);
running.lifecycle.status = "running";
running.execution.abortController = new AbortController();
manager.agents.set("r1", running);
check("control — abort() on a running record is accepted", manager.abort("r1", "user") === true);
check("control — clear() on a plain settled record is accepted", manager.clear("a0") === true);
check("…and it really is gone", manager.getRecord("a0") === undefined);

manager.dispose();
console.log("");
if (failures > 0) {
  console.log(`   ${failures} expectation(s) failed`);
  process.exit(1);
}
console.log("   all expectations held");
process.exit(0);
