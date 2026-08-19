/**
 * t4 — AG5 and AG6. Two operator-facing sentences that named something and were
 * never checked against it.
 * FIXED — this probe prints BEFORE and NOW side by side.
 *
 * **AG5 — `bulkReport`'s partial line says the opposite of what happened, for
 * one of its two verbs.** `AgentManager.stopAgent()` returns `false` from
 * exactly one place — `else if (record.lifecycle.status !== "running") return
 * false;`, reached only when the record is not queued, not running and not
 * verifying, i.e. when it has FINISHED. "Still busy" is the one thing a refused
 * stop cannot mean. The module's own single-agent sentence gets it right
 * (`stopReport(false, …)` → "was already finished — nothing to stop"), and the
 * bulk path shares one clear-flavoured sentence for both verbs.
 * `tests/action-report.test.ts` exercises the partial case for `Cleared` only.
 *
 * **AG6 — the recovery every dropped-result notice names cannot perform it.**
 * All four say "Read it with AgentStatus", and `executeAgentStatusTool` prints
 * `id (type) status` and nothing else. The surface that CAN show it is
 * `/agents` → the agent → "View result". `nudge-drop.ts`'s own header already
 * says "`AgentStatus` (or `/agents`) will show it"; the sentence it ships does
 * not carry the half that works.
 *
 *   run: node --experimental-strip-types t4-the-two-sentences-and-what-they-name.mjs
 */

import { readFileSync } from "node:fs";

import {
  bulkReport,
  clearReport,
  steerReport,
  stopReport,
} from "/home/claudeuser/qwen3.8-forge/vendor/pi-subagents-lite/src/ui/action-report.ts";
import { describeNudgeDrop } from "/home/claudeuser/qwen3.8-forge/vendor/pi-subagents-lite/src/spawn/nudge-drop.ts";

const SRC = "/home/claudeuser/qwen3.8-forge/vendor/pi-subagents-lite/src";
let failures = 0;
const check = (label, ok) => {
  console.log(`   ${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) failures++;
};

console.log("\nt4 — two sentences, and the thing each of them names\n");

// ── AG5 ──────────────────────────────────────────────────────────────────────
console.log("A. bulkReport's partial line, for both verbs\n");
console.log(`     BEFORE, both verbs shared one sentence:`);
console.log(`       Stopped 2/3 : "Stopped 2 of 3 agent(s); 1 were still busy and were left alone."`);
console.log(`       Cleared 6/7 : "Cleared 6 of 7 agent(s); 1 were still busy and were left alone."`);
console.log(`     NOW:`);
console.log(`       Stopped 2/3 : ${JSON.stringify(bulkReport("Stopped", 2, 3).text)}`);
console.log(`       Cleared 6/7 : ${JSON.stringify(bulkReport("Cleared", 6, 7).text)}`);
console.log(`       Cleared 5/7 : ${JSON.stringify(bulkReport("Cleared", 5, 7).text)}`);
console.log(`
     …and the same module's sentence for the SAME refusal, one agent at a time:
       stop  : ${JSON.stringify(stopReport(false, "1a2b3c4d").text)}
       clear : ${JSON.stringify(clearReport(false, "1a2b3c4d").text)}
`);

const manager = readFileSync(`${SRC}/agents/agent-manager.ts`, "utf8");
const stopBody = manager.slice(manager.indexOf("private stopAgent("), manager.indexOf("private removeRecord("));
check("stopAgent's only `return false` is the not-running one",
  (stopBody.match(/return false;/g) ?? []).length === 1 &&
  /else if \(record\.lifecycle\.status !== "running"\) \{\s*\n\s*return false;/.test(stopBody));
check("…so a refused STOP always means the record had already finished",
  /isVerifyingRecord\(record\) && record\.execution\.verifyAbort/.test(stopBody));
check("a partial STOP now says they had already finished",
  bulkReport("Stopped", 2, 3).text.includes("already finished") &&
  !bulkReport("Stopped", 2, 3).text.includes("still busy"));
check("…which is what the single-agent line for the identical refusal says",
  stopReport(false, "x").text.includes("already finished"));
check("a partial CLEAR still says they were busy — that one was always right",
  bulkReport("Cleared", 6, 7).text.includes("still busy"));
check("and the count reads as a sentence at one as well as at many",
  bulkReport("Cleared", 6, 7).text.includes("1 was still busy") &&
  bulkReport("Cleared", 5, 7).text.includes("2 were still busy"));

const tests = readFileSync(`${SRC}/../tests/action-report.test.ts`, "utf8");
check("and the partial case is now asserted for BOTH verbs",
  /bulkReport\("Cleared", 6, 7\)/.test(tests) && /bulkReport\("Stopped", 2, 3\)/.test(tests));

// ── AG6 ──────────────────────────────────────────────────────────────────────
console.log(`\nB. what a dropped background result tells the operator to do

     BEFORE, all four ended: "Read it with AgentStatus."
     NOW:`);
for (const reason of ["session-replaced", "no-runtime", "record-gone"]) {
  console.log(`     ${reason.padEnd(17)} ${JSON.stringify(describeNudgeDrop(reason, "1a2b3c4d", "Explore").notice)}`);
}

const status = readFileSync(`${SRC}/agents/agent-status.ts`, "utf8");
const perAgent = status.match(/return `\$\{shortId\}[^`]*`/)?.[0];
console.log(`
     what AgentStatus prints per agent:
       ${perAgent}
     — the id, the type, the status. Not the result, not the error, not the
       output file.
`);
check("the premise, unchanged: AgentStatus's per-agent line carries no result",
  perAgent !== undefined && !/record\.result/.test(perAgent));
check("…and the whole tool never touches record.result", !/record\.result/.test(status));
check("no drop notice sends the operator to AgentStatus any more",
  ["session-replaced", "no-runtime", "record-gone"].every((r) =>
    !describeNudgeDrop(r, "x", "y").notice.includes("AgentStatus")));
check("the two recoverable reasons name /agents and its action",
  ["session-replaced", "no-runtime"].every((r) => {
    const n = describeNudgeDrop(r, "x", "y").notice;
    return n.includes("/agents") && n.includes("View result");
  }));
check("record-gone says there is nothing left to read, because both surfaces read the same map",
  describeNudgeDrop("record-gone", "x", "y").notice.includes("gone with it") &&
  !describeNudgeDrop("record-gone", "x", "y").notice.includes("View result"));

const menu = readFileSync(`${SRC}/ui/menu/menu-running-agents.ts`, "utf8");
check("the surface that CAN show it is /agents → View result",
  /value: "view-result", label: "View result"/.test(menu) &&
  /showTextViewer\(ctx, record, "result", record\.result!\)/.test(menu));

const drop = readFileSync(`${SRC}/spawn/nudge-drop.ts`, "utf8");
check("nudge-drop.ts's header records what the sentence used to name, and why it did not work",
  /AgentStatus. prints/.test(drop) && /View result/.test(drop));

const coordinator = readFileSync(`${SRC}/spawn/spawn-coordinator.ts`, "utf8");
check("and the AC1 catch — the reachable one — uses the same sentence rather than a fourth copy",
  /RECOVERY_ADVICE/.test(coordinator) && !/read it with AgentStatus/i.test(coordinator));

console.log(`
     "record-gone" used to be self-refuting: the record was removed from the
     manager, AgentStatus lists exactly that map, and the notice recommended it
     anyway. It now says the answer is gone, which is the honest sentence and
     the only one that does not send somebody looking.

     Both fixes are pinned: tests/action-report.test.ts's AG5 block (2 fail when
     it is removed) and tests/nudge-drop.test.ts's AG6 block (6 fail).
`);

console.log(failures > 0 ? `   ${failures} expectation(s) failed` : "   all expectations held");
process.exit(failures > 0 ? 1 : 0);
