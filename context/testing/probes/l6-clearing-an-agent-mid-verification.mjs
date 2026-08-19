/**
 * l6 — Y1. Clearing a subagent whose verifier is still running.
 *
 * `attachSettlementChain` sets the record's status from `classifyRun` and THEN
 * awaits `runVerification`, so for the whole of a judge and up to three repairs
 * the record reads `completed`, `completedAt` is not stamped, and `verifyPhase`
 * is the only field that says a model call is in flight.
 *
 * `AgentManager.clear()` gates on `isTerminalStatus`, which cannot see a phase,
 * and `/agents` had its own `isActive()` — status only — so the same record was
 * drawn as RUNNING by the widget (`categorizeAgents` has had a comment about
 * this since the phase field existed) and listed as FINISHED with a ✓ in the
 * menu, where Clear was the only action offered for it and both bulk clears
 * reached it.
 *
 * This drives the real manager: a real record, the real completion gate, the
 * real `removeRecord`.
 *
 *   run: node l6-clearing-an-agent-mid-verification.mjs
 */

import { createJiti } from "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";
const PI = "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
const jiti = createJiti(`file://${PI}`, { interopDefault: true, alias: { "@earendil-works/pi-coding-agent": PI } });
const R = "/home/claudeuser/qwen3.8-forge/vendor/pi-subagents-lite/src";

const { AgentManager } = await jiti.import(`${R}/agents/agent-manager.ts`);
const activity = await jiti.import(`${R}/agents/record-activity.ts`);

/** A record in exactly the state the settlement chain leaves one in while the judge runs. */
function verifyingRecord(id, disposed) {
  return {
    id,
    // The child's real answer, which the verifier is about to check and rewrite.
    result: "src/parser.ts:41, src/lexer.ts:9 — both call tokenize() directly.",
    verifyPhase: "judging",
    lifecycle: { status: "completed", startedAt: Date.now(), started: true },
    display: { type: "Explore", description: "find the callers" },
    execution: {
      modelKey: "forge/qwen3.8-27b",
      settled: false,
      settlementCount: 1,
      brief: "List every caller of tokenize().",
      // The session a REPAIR would run in.
      session: { dispose: () => disposed.push(id) },
    },
    stats: { lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 }, toolUses: 0, turnCount: 3, compactionCount: 0 },
  };
}

function seed(mgr, id, disposed) {
  const record = verifyingRecord(id, disposed);
  mgr.agents.set(id, record);
  record.execution.promise = mgr.createCompletionGate(id);
  return record;
}

const settled = (promise) =>
  Promise.race([promise.then((value) => ({ opened: true, value })), Promise.resolve().then(() => ({ opened: false }))]);

console.log(`
=== l6 — Clear, on an agent the verifier is still holding ===

  How the three readers saw the same record:

                          BEFORE                       NOW
    widget                running, "checking the       unchanged
                          answer against the task…"
    /agents list          ✓ completed, Clear offered   ▶ completed · checking,
                                                       no action but viewing
    manager.clear()       accepted                     refused
`);

const before = new AgentManager();
const beforeDisposed = [];
const beforeRecord = seed(before, "aaa", beforeDisposed);
// Exactly what clear() used to do: isTerminalStatus("completed") is true.
before.removeRecord("aaa", beforeRecord);
const beforeGate = await settled(beforeRecord.execution.promise);

const now = new AgentManager();
const nowDisposed = [];
const nowRecord = seed(now, "bbb", nowDisposed);
const nowAccepted = now.clear("bbb");
const nowGate = await settled(nowRecord.execution.promise);

const show = (label, accepted, disposed, gate, present) =>
  console.log(`  ${label}
    clear accepted                 ${accepted}
    repair's session disposed      ${disposed.length > 0}
    completion gate opened         ${gate.opened}${gate.opened ? `, with ${JSON.stringify(gate.value)}` : ""}
    record still tracked           ${present}
`);

console.log("");
show("BEFORE — clear() reached removeRecord", true, beforeDisposed, beforeGate, before.agents.has("aaa"));
show("NOW — clear() refuses", nowAccepted, nowDisposed, nowGate, now.agents.has("bbb"));

// The control: the same record with the phase cleared, which is the state
// runVerification's `finally` leaves on every path it owns.
const control = new AgentManager();
const controlDisposed = [];
const controlRecord = seed(control, "ccc", controlDisposed);
controlRecord.verifyPhase = undefined;
const controlAccepted = control.clear("ccc");
const controlGate = await settled(controlRecord.execution.promise);
show("control — the check has finished, so Clear works exactly as before", controlAccepted, controlDisposed, controlGate, control.agents.has("ccc"));

console.log(`  predicates (record-activity.ts, which all three readers now import):
    verifying   isActiveRecord ${activity.isActiveRecord(nowRecord)}   isVerifyingRecord ${activity.isVerifyingRecord(nowRecord)}   isBusyRecord ${activity.isBusyRecord(nowRecord)}
    settled     isActiveRecord ${activity.isActiveRecord(controlRecord)}   isVerifyingRecord ${activity.isVerifyingRecord(controlRecord)}   isBusyRecord ${activity.isBusyRecord(controlRecord)}

  The gate is the part that reaches the parent model. A foreground delegation is
  blocked on \`record.execution.promise\`; opening it with "" hands the parent an
  empty answer while the real one is still being judged — and the verifier then
  writes its verdict onto a record nobody is holding.
`);
