/**
 * m2 — Z2. The task anchor is steered into a run that has already ended, which
 * manufactures a turn whose answer replaces the child's.
 *
 * `AgentManager.runTrackingCallbacks.onCompaction` calls
 * `session.steer(buildAnchorMessage(brief))` on every compaction. `steer()` is
 * not a way to put text in a context — it is a way to put text in a context and
 * get an answer to it:
 *
 *   AgentSession._handlePostAgentRun   agent-session.js:776
 *     return this.agent.hasQueuedMessages();      ← our anchor is the queue
 *   AgentSession._runAgentPrompt       :744
 *     while (await this._handlePostAgentRun()) await this.agent.continue();
 *   Agent.continue                     agent.js:236
 *     last message is assistant → drain the steering queue → runPromptMessages
 *
 * and pi's only two auto-compaction call sites are BOTH outside the agent loop:
 * `_handlePostAgentRun()` (after the run) and `prompt()` (before the next one).
 * So a child that finishes above pi's compaction threshold is compacted, asked
 * the anchor, and answers it — one extra model call on the one llama slot, and
 * an answer that replaces the one the parent asked for (see m1).
 *
 * This drives the REAL `AgentManager.runTrackingCallbacks` through the REAL
 * `subscribeToSessionEvents`, with the event sequence pi emits.
 *
 *   run: node m2-the-anchor-manufactures-a-turn.mjs
 */

import { createJiti } from "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";
const PI = "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
const jiti = createJiti(`file://${PI}`, { interopDefault: true, alias: { "@earendil-works/pi-coding-agent": PI } });
const R = "/home/claudeuser/qwen3.8-forge/vendor/pi-subagents-lite/src";

const { AgentManager } = await jiti.import(`${R}/agents/agent-manager.ts`);
const { subscribeToSessionEvents } = await jiti.import(`${R}/agents/agent-runner.ts`);

const BRIEF = "List every caller of tokenize().";

function scenario(label, emitSequence) {
  const steers = [];
  const session = { steer: async (text) => steers.push(text) };
  const record = {
    id: "a1",
    execution: { brief: BRIEF, session },
    stats: { compactionCount: 0, toolUses: 0, lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 } },
  };

  const mgr = new AgentManager();
  const callbacks = mgr.runTrackingCallbacks(record, undefined, () => {});

  const subs = new Set();
  const fakeSession = { subscribe: (fn) => { subs.add(fn); return () => subs.delete(fn); } };
  subscribeToSessionEvents(fakeSession, callbacks);
  emitSequence((event) => { for (const fn of [...subs]) fn(event); });
  mgr.dispose?.();

  console.log(
    `  ${label.padEnd(56)} compactions ${record.stats.compactionCount}   anchor steered: ${steers.length > 0 ? "YES" : "no"}`,
  );
  return steers.length;
}

const compaction = (willRetry = false) => ({
  type: "compaction_end",
  reason: "threshold",
  aborted: false,
  willRetry,
  result: { tokensBefore: 21_000 },
});

console.log("does the anchor reach a turn that was going to happen anyway?\n");

console.log("Z2 — pi compacts AFTER the run (_handlePostAgentRun); a steer restarts the loop");
scenario("the child answered, then pi compacted", (emit) => {
  emit({ type: "agent_start" });
  emit({ type: "agent_end" });
  emit(compaction());
});

console.log("\ncontrol — pi compacts BEFORE the next prompt (prompt(); the steer rides on it)");
scenario("a continuation, compacted on the way in", (emit) => {
  emit(compaction());
  emit({ type: "agent_start" });
});

console.log("\ncontrol — pi is going to re-run the interrupted turn itself");
scenario("overflow compaction with willRetry", (emit) => {
  emit({ type: "agent_start" });
  emit({ type: "agent_end" });
  emit(compaction(true));
});

console.log("\ncontrol — a second agent loop started, so the run is live again");
scenario("agent_end, then agent_start, then a compaction", (emit) => {
  emit({ type: "agent_start" });
  emit({ type: "agent_end" });
  emit({ type: "agent_start" });
  emit(compaction());
});

console.log(`
BEFORE the fix   every row above steered the anchor, including the first — and
                 the first is every child that finishes above pi's compaction
                 threshold. It bought one extra model call on the single llama
                 slot and its reply became the child's answer (m1).

NOW              the anchor is steered only into a turn that was already coming.
                 The compaction is still counted on the record either way.`);
