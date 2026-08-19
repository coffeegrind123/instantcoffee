/**
 * u5 — AH1. A finished background subagent's answer, delivered into a compaction.
 *
 * FIXED — this probe prints BEFORE and NOW, driving the SHIPPED
 * `SpawnCoordinator` and the SHIPPED lock, with pi's own facts pinned out of its
 * source first.
 *
 * The sixteenth pass closed two of the three senders that reach
 * `sendCustomMessage`'s `triggerTurn` branch, and left this residue in its own
 * handoff:
 *
 *   > `compactionInFlight()` now has four readers, and there is no test that a
 *   > fifth would be noticed. … "who else should be asking this" is exactly the
 *   > question that produced AG2 and AG3, and it will produce another one the
 *   > next time a sender is added.
 *
 * There was no next time. The third sender already existed, and it is the one
 * with the least to fall back on:
 *
 *     pi-loop-mode   sendLoopTurn          AG2   reschedules — the same iteration
 *                                                goes five seconds later
 *     prinny-channel forwardResult         AG3   holds, charges no retry, and
 *                                                tells the sender to ask again
 *     pi-subagents   emitIndividualNudge   AH1   runs ONCE per record, on a record
 *                                                that has already settled, its slot
 *                                                released and its gate open. There
 *                                                is no second attempt.
 *
 * `result-cap.ts`'s own header — in this package, about this delivery — even
 * quotes the mechanism:
 *
 *   > `spawn-coordinator.ts` delivers it with `pi.sendMessage({ customType:
 *   > "subagent-result", ... }, { triggerTurn: true })`, and pi's
 *   > `sendCustomMessage` … hands it straight to `agent.steer()` /
 *   > `agent.followUp()` / `_runAgentPrompt()`.
 *
 * `_runAgentPrompt` is named there, and it is the function AG2 is about.
 *
 *   run: node u5-the-answer-delivered-into-a-compaction.mjs
 */

import { readFileSync } from "node:fs";
import { createJiti } from "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";

const PI_DIST = "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist";
const NM = `${PI_DIST}/../node_modules/@earendil-works`;
const jiti = createJiti(`file://${PI_DIST}/index.js`, {
  interopDefault: true,
  alias: { "@earendil-works/pi-coding-agent": `${PI_DIST}/index.js`, "@earendil-works/pi-tui": `${NM}/pi-tui` },
});
const R = "/home/claudeuser/qwen3.8-forge/vendor/pi-subagents-lite/src";

const shell = await jiti.import(`${R}/shell.ts`);
const { AgentManager } = await jiti.import(`${R}/agents/agent-manager.ts`);
const { SpawnCoordinator } = await jiti.import(`${R}/spawn/spawn-coordinator.ts`);
const { compactionInFlight } = await jiti.import(`${R}/spawn/compaction-lock.ts`);
const loopLock = await import("/home/claudeuser/qwen3.8-forge/vendor/pi-loop-mode/src/compaction-lock.ts");

let failures = 0;
const check = (label, ok) => {
  console.log(`   ${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log("\nu5 — the answer that was delivered into a compaction\n");

// ── pi's own facts, pinned rather than remembered ────────────────────────────
{
  const session = readFileSync(`${PI_DIST}/core/agent-session.js`, "utf8");
  check(
    "prompt() refuses while _compactionAbortController is set",
    /if \(this\._compactionAbortController !== undefined\) \{\s*\n\s*throw new Error\("Cannot submit a prompt while compaction is in progress/.test(session),
  );
  const scm = session.slice(session.indexOf("async sendCustomMessage(message, options)"));
  const body = scm.slice(0, scm.indexOf("\n    }\n"));
  check("…and sendCustomMessage's triggerTurn branch calls _runAgentPrompt", /else if \(options\?\.triggerTurn\) \{\s*\n\s*await this\._runAgentPrompt\(appMessage\);/.test(body));
  check("…with no compaction check anywhere in it", !/_compactionAbortController/.test(body));
  const rap = session.slice(session.indexOf("async _runAgentPrompt(messages)"));
  check("…and _runAgentPrompt checks nothing either", !/_compactionAbortController/.test(rap.slice(0, rap.indexOf("\n    }\n"))));
  check(
    "compact() begins by awaiting an abort, so the session is IDLE throughout",
    /await this\.abort\(\);\s*\n\s*this\._compactionAbortController = new AbortController\(\)/.test(session),
  );
  check(
    "…and ends by REPLACING the array a run would be streaming into",
    /this\.agent\.state\.messages = sessionContext\.messages/.test(session),
  );

  const agent = readFileSync(`${PI_DIST}/../node_modules/@earendil-works/pi-agent-core/dist/agent.js`, "utf8");
  check(
    "Agent.prompt() snapshots the message array at the run's first instant",
    /createContextSnapshot\(\) \{[\s\S]{0,200}?messages: this\._state\.messages\.slice\(\)/.test(agent),
  );
}

console.log(`
   So a nudge sent during a compaction:
     · takes the _runAgentPrompt branch — and it is the ONLY branch available,
       because compact() awaited waitForIdle() and isStreaming is false
     · builds its whole run from a COPY of the PRE-compaction messages, i.e. the
       oversized context the compaction exists to shrink, and the compaction
       finishing does not change it
     · queues a second model call at a one-slot llama server, behind the summariser
     · emits a whole agent_start … agent_end … agent_settled cycle INSIDE the
       compaction window, re-entering every handler in the stack
`);

// ── the shipped coordinator, with the lock held by the other package ─────────
const sent = [];
const notices = [];
shell.setPiInstance({
  sendMessage(message, options) {
    sent.push({ customType: message.customType, options, duringCompaction: Boolean(compactionInFlight()) });
  },
});
shell.setSessionCtx({
  ui: { notify: (m) => notices.push(String(m)) },
  model: { contextWindow: 32_768 },
  getContextUsage: () => ({ tokens: 6_554, contextWindow: 32_768, percent: 20 }),
});

const manager = new AgentManager(undefined, { default: 1 }, undefined);
shell.setManager(manager);
const coordinator = new SpawnCoordinator(manager);

const ID = "bg-agent-0001";
manager.agents.set(ID, {
  id: ID,
  lifecycle: { status: "completed", startedAt: 1_000, completedAt: 2_000, started: true },
  display: { type: "Explore", description: "find every caller of decodeFrame()" },
  execution: { settled: true, settlementCount: 1, brief: "b" },
  result: "decodeFrame() has four callers: src/a.ts:12, src/b.ts:88, src/c.ts:4, src/d.ts:301.",
  stats: { lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 }, toolUses: 3, turnCount: 4, compactionCount: 0 },
});
// The one-shot background gate: this is what a real background delegation does.
coordinator.backgroundAgentIds.add(ID);

console.log("   pi-loop-mode takes the lock (an emergency context recovery), then the\n   background subagent settles:\n");
loopLock.beginCompaction(loopLock.LOOP_OWNER);
coordinator.onAgentComplete(manager.getRecord(ID));
await sleep(350);

console.log("      BEFORE                                    NOW");
console.log("      ───────────────────────────────────────   ───────────────────────────────────────");
console.log(
  `      1 subagent-result, duringCompaction=true   ${sent.length} sent, and the answer is held`,
);
check("nothing is delivered into the compaction", sent.length === 0);
check(
  "the operator is told, once, and told WHO is compacting",
  notices.some((n) => /result held/.test(n) && /pi-loop-mode/.test(n)),
);
check(
  "…and it does not read as a DROP — the answer is intact",
  notices.every((n) => !/NOT delivered/.test(n)),
);

const heldNotices = notices.filter((n) => /result held/.test(n)).length;
await sleep(5_400);
check("still held while the lock is held", sent.length === 0);
check("and not repeated every five seconds", notices.filter((n) => /result held/.test(n)).length === heldNotices);

console.log("\n   the compaction finishes:\n");
loopLock.endCompaction(loopLock.LOOP_OWNER);
await sleep(5_600);

check("the answer is delivered — deferred, never dropped", sent.length === 1);
check("as the subagent-result it always was", sent[0]?.customType === "subagent-result");
check("with the delivery mode AA4 settled on", sent[0]?.options?.deliverAs === "followUp" && sent[0]?.options?.triggerTurn === true);
check("and NOT during a compaction", sent[0]?.duringCompaction === false);

console.log(`
   The record is settled, its slot is released and its completion gate is open, so
   there is nothing else to ask and nobody left to notice. That is why this sender
   defers rather than reporting: \`emitIndividualNudge\` is the ONLY route a
   background delegation's answer has to the parent model, and it runs once.

   Pinned by pi-subagents-lite/tests/compaction-lock.test.ts — the three-way
   protocol agreement, and the wiring assertions that the read comes before the
   send AND before the cap (capBackgroundResult sizes the result against
   ctx.getContextUsage(), which during a compaction still reports the
   pre-compaction window). 3 fail when the fix is removed.

   The bound is the lock's own: a holder older than STALE_MS (five minutes) reads
   as absent, so the worst case is one five-minute pause and then the answer goes.
   And what no lock can cover is unchanged and still recorded: pi's OWN threshold
   and overflow compactions mark nothing, so no extension can stand aside for
   them.
`);

coordinator.dispose();
console.log(failures > 0 ? `   ${failures} expectation(s) failed` : "   all expectations held");
process.exit(failures > 0 ? 1 : 0);
