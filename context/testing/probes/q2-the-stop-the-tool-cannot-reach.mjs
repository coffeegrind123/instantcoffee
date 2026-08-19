/**
 * q2 — AD2. T5's stop, applied to `stopAgent()` and not to the tool that calls
 * it.  FIXED — this probe shows both columns.
 *
 * The eleventh pass closed T5: a record whose VERIFIER is still running is
 * stoppable, because `AgentManager.stopAgent()` now tests `isVerifyingRecord`
 * BEFORE it tests `lifecycle.status === "running"`. The comment above that
 * branch says the fix is for "the operator's Esc, for `StopAgent`, and for
 * anything else that asked".
 *
 * It is not for `StopAgent`. `executeStopAgentTool` has its own precondition:
 *
 *     if (record.lifecycle.status !== "running" && record.lifecycle.status !== "queued") {
 *       return successResult(`Agent ${agentId} is already ${record.lifecycle.status}. …`);
 *     }
 *     if (getManager().abort(agentId, "agent")) { … }
 *
 * and `attachSettlementChain` sets the status from `classifyRun` BEFORE it
 * awaits `runVerification`, so throughout a judge and up to three repairs the
 * status reads `completed`. The tool returns on its first line and the manager
 * is never asked.
 *
 * What the model is told is the second half of it: "Agent … is already
 * completed", while a judge holds the one llama slot the model's own next call
 * is queued behind, and the answer it will eventually receive has not been
 * decided yet. `formatRunningAgents()` has the same filter, so the "Running
 * agents:" hint beside that sentence omits the agent that is running.
 *
 * The menu path (`menu-running-agents.ts`) was fixed in the same pass and calls
 * `manager.abort()` directly — it is the control below.
 *
 *   run: node q2-the-stop-the-tool-cannot-reach.mjs
 */

import { createJiti } from "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";

const PI = "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
const jiti = createJiti(`file://${PI}`, { interopDefault: true, alias: { "@earendil-works/pi-coding-agent": PI } });
const R = "/home/claudeuser/qwen3.8-forge/vendor/pi-subagents-lite/src";

const shell = await jiti.import(`${R}/shell.ts`);
const { executeStopAgentTool } = await jiti.import(`${R}/agents/tool-execution.ts`);
const { AgentManager } = await jiti.import(`${R}/agents/agent-manager.ts`);
const { isVerifyingRecord } = await jiti.import(`${R}/agents/record-activity.ts`);

let failures = 0;
const check = (label, ok) => {
  console.log(`   ${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) failures++;
};

/**
 * A record in exactly the state `attachSettlementChain` leaves it in while the
 * verifier works: the child's own run has settled and been CLASSIFIED, so the
 * status is terminal — and `verifyPhase` is set, which is the only field that
 * says a model call is still in flight.
 */
function verifyingRecord() {
  const verifyAbort = new AbortController();
  return {
    id: "agent-0123456789ab",
    result: "the parser exports parse() and tokenize().",
    verifyPhase: "judging",
    lifecycle: { status: "completed", startedAt: Date.now() - 9000, started: true },
    display: { type: "Explore", description: "map the parser" },
    execution: { abortController: new AbortController(), verifyAbort, settled: false, settlementCount: 0 },
    stats: { lifetimeUsage: { input: 1, output: 1, cacheWrite: 0, cost: 0 }, toolUses: 0, turnCount: 2 },
  };
}

/** A manager with one record in it, reached the way both callers reach it. */
function harness(record) {
  const manager = new AgentManager();
  // `agents` is private; the manager's own map is what both paths read, and the
  // public surface that fills it (spawn) would start a real run. Reaching in is
  // the smallest faithful thing — every read below goes through getRecord/abort.
  const agents = Object.getOwnPropertyNames(manager).includes("agents")
    ? manager.agents
    : Object.values(manager).find((v) => v instanceof Map);
  agents.set(record.id, record);
  shell.setManager(manager);
  return manager;
}

console.log("\nq2 — stopping a subagent whose answer is still being checked\n");

// ── 1. The state the two callers disagree about ──────────────────────────────
{
  const record = verifyingRecord();
  console.log(`   record.lifecycle.status                    : ${record.lifecycle.status}`);
  console.log(`   record.verifyPhase                         : ${record.verifyPhase}`);
  console.log(`   isVerifyingRecord(record)                  : ${isVerifyingRecord(record)}`);
  check("a verifying record's status is terminal", record.lifecycle.status === "completed");
  check("and verifyPhase is the only field that says otherwise", isVerifyingRecord(record) === true);
}

// ── 2. The control: the menu path, which calls manager.abort() directly ──────
{
  const record = verifyingRecord();
  const manager = harness(record);
  const stopped = manager.abort(record.id, "user");
  console.log("");
  console.log(`   /agents  → manager.abort()                 : ${stopped}`);
  console.log(`   verifyAbort.signal.aborted                 : ${record.execution.verifyAbort.signal.aborted}`);
  check("control: the menu really does stop the check", stopped === true);
  check("control: and the verifier's signal is the thing aborted", record.execution.verifyAbort.signal.aborted === true);
  manager.dispose();
}

// ── 3. The tool, on the same record — BEFORE and NOW ─────────────────────────
//
// BEFORE is the guard the twelfth pass shipped, restated as the predicate it
// was, and evaluated against the same record the tool is about to be given. It
// is a predicate rather than a second copy of the function because the guard IS
// one line: `status !== "running" && status !== "queued"` → return early.
{
  const record = verifyingRecord();
  const manager = harness(record);

  const oldGuardWouldReturnEarly =
    record.lifecycle.status !== "running" && record.lifecycle.status !== "queued";
  console.log("");
  console.log(`   BEFORE — the old status guard returns early: ${oldGuardWouldReturnEarly}`);
  console.log("            the model is told                 : Agent … is already completed. Running agents: none");
  check("BEFORE: the tool returned before the manager was asked", oldGuardWouldReturnEarly === true);

  const result = await executeStopAgentTool("call-1", { agent_id: record.id }, undefined, undefined, {});
  const text = result?.content?.[0]?.text ?? "";
  console.log("");
  console.log(`   NOW    — the model is told                 : ${text}`);
  console.log(`            verifyAbort.signal.aborted        : ${record.execution.verifyAbort.signal.aborted}`);
  console.log(`            isError                           : ${Boolean(result?.isError)}`);
  console.log("");
  check("NOW: the tool reaches the manager and the check is aborted", record.execution.verifyAbort.signal.aborted === true);
  check("NOW: and the sentence names which run was stopped", /answer check/.test(text));
  check("NOW: not the child's own run, which really had finished", /already finished/.test(text));
  manager.dispose();
}

// ── 3b. And the hint beside every one of those sentences ─────────────────────
{
  const record = verifyingRecord();
  const manager = harness(record);
  const other = verifyingRecord();
  other.id = "agent-ffffffffffff";
  other.lifecycle.status = "error";
  other.verifyPhase = undefined;
  const agents = Object.values(manager).find((v) => v instanceof Map);
  agents.set(other.id, other);
  const result = await executeStopAgentTool("call-2", { agent_id: other.id }, undefined, undefined, {});
  const text = result?.content?.[0]?.text ?? "";
  console.log(`   asking about a finished agent instead      : ${text}`);
  check(
    "NOW: the busy list includes the agent that is holding the slot",
    /Running agents: agent-01 \(Explore\)/.test(text),
  );
  manager.dispose();
}

// ── 4. The control the tool DOES get right ───────────────────────────────────
{
  const record = verifyingRecord();
  record.verifyPhase = undefined;
  record.lifecycle.status = "running";
  const manager = harness(record);
  const result = await executeStopAgentTool("call-2", { agent_id: record.id }, undefined, undefined, {});
  const text = result?.content?.[0]?.text ?? "";
  console.log(`   control — a genuinely running agent        : ${text}`);
  check("control: an ordinary running agent still stops", /^Stopped agent/.test(text));
  check("control: and its own run is what was aborted", record.execution.abortController.signal.aborted === true);
  manager.dispose();
}

console.log(`\n${failures === 0 ? "q2: every expectation held" : `q2: ${failures} FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
