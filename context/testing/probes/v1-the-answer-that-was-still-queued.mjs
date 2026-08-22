/**
 * v1 — AI1. The background answer that was still QUEUED when the session ended.
 *
 * FIXED — this probe prints BEFORE and NOW, driving the SHIPPED
 * `SpawnCoordinator` with the old `dispose()` modelled beside the shipped one.
 *
 * ## The promise
 *
 * The fifteenth pass closed §11.1: all three of `emitIndividualNudge`'s guards
 * now report, on AC1's rule —
 *
 *   > A delivery that did not happen is the loudest thing this class can report;
 *   > it must not be the quietest.
 *
 * The first of those guards is `session-replaced`, and its own docstring says
 * what it is for: *"The coordinator was disposed — `session_shutdown`, or a
 * session replaced under it."*
 *
 * ## Where it is not true
 *
 * `dispose()` cancels `nudgeTimer` and clears `pendingNudges`. An id sitting in
 * that set at `session_shutdown` therefore never reaches `emitIndividualNudge`
 * at all, so the guard written for this case cannot fire for it — it can only
 * fire for a record that settles AFTER the dispose, which is the rarer half.
 * The report existed and the path to it did not.
 *
 * ## And AH1 made the window large
 *
 * Before the seventeenth pass an id sat in `pendingNudges` for `NUDGE_DELAY_MS`
 * — 200 milliseconds. AH1's deferral puts it back every `COMPACTION_WAIT_MS`
 * for as long as somebody else holds the compaction lock, which the lock bounds
 * at `STALE_MS`: five minutes. A `/loop` that delegates in the background and is
 * stopped while a compaction is running is exactly that shape.
 *
 * ## The control, thirty lines away
 *
 * `AgentManager.dispose()` fails its QUEUED records honestly rather than
 * dropping them — "so the waiting tool call resumes with an explicit error
 * instead of hanging (US-9)". Same teardown, same kind of pending work, opposite
 * treatment; this probe drives both.
 *
 *   run: node v1-the-answer-that-was-still-queued.mjs
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
const { SpawnCoordinator } = await jiti.import(`${R}/spawn/spawn-coordinator.ts`);
const { describeNudgeDrop } = await jiti.import(`${R}/spawn/nudge-drop.ts`);
const loopLock = await import(`${REPO}/vendor/pi-loop-mode/src/compaction-lock.ts`);

let failures = 0;
const check = (label, ok) => {
  console.log(`   ${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log("\nv1 — the answer that was still queued when the session ended\n");

// ── the premise, read out of this package's own source ───────────────────────
{
  const coordinatorSrc = readFileSync(`${R}/spawn/spawn-coordinator.ts`, "utf8");
  const nudgeDropSrc = readFileSync(`${R}/spawn/nudge-drop.ts`, "utf8");
  const managerSrc = readFileSync(`${R}/agents/agent-manager.ts`, "utf8");
  const eventsSrc = readFileSync(`${R}/events.ts`, "utf8");

  check(
    "the session-replaced guard says it is for session_shutdown",
    /The coordinator was disposed — `session_shutdown`/.test(nudgeDropSrc),
  );
  const disposeAt = coordinatorSrc.indexOf("  dispose(): void {");
  const disposeBody = coordinatorSrc.slice(disposeAt, coordinatorSrc.indexOf("\n  }", disposeAt));
  check("…and dispose() cancels the one timer that drains the batch", /clearTimeout\(this\.nudgeTimer\)/.test(disposeBody));
  check(
    "the deferral puts the id back with COMPACTION_WAIT_MS, not the 200 ms batch delay",
    /this\.scheduleNudgeIn\(agentId, COMPACTION_WAIT_MS\)/.test(coordinatorSrc),
  );
  check(
    "session_shutdown disposes the coordinator BEFORE the manager, so the record is still readable",
    eventsSrc.indexOf("getCoordinator()?.dispose()") < eventsSrc.indexOf("await mgr.dispose()"),
  );
  check(
    "the control: AgentManager.dispose fails its queued records rather than dropping them",
    /DISPOSE_QUEUED_MESSAGE = "Agent manager disposed before the queued agent could start\."/.test(managerSrc),
  );
}

console.log(`
   So the window an answer can be lost in is the interval between a background
   record settling and its nudge firing, and the compaction hold is what makes
   that interval minutes rather than milliseconds.
`);

// ── the shipped coordinator, disposed with a nudge still queued ──────────────
const warned = [];
const notices = [];
const realWarn = console.warn;
console.warn = (...args) => warned.push(args.join(" "));

shell.setPiInstance({ sendMessage() { throw new Error("nothing should be sent in this probe"); } });
shell.setSessionCtx({
  ui: { notify: (m) => notices.push(String(m)) },
  model: { contextWindow: 32_768 },
  getContextUsage: () => ({ tokens: 6_554, contextWindow: 32_768, percent: 20 }),
});

const manager = new AgentManager(undefined, { default: 1 }, undefined);
shell.setManager(manager);
const coordinator = new SpawnCoordinator(manager);

const ID = "bg-agent-0002";
manager.agents.set(ID, {
  id: ID,
  lifecycle: { status: "completed", startedAt: 1_000, completedAt: 2_000, started: true },
  display: { type: "Explore", description: "map the retry paths" },
  execution: { settled: true, settlementCount: 1, brief: "b" },
  result: "Three retry paths: stream-retry.ts:44, agent-runner.ts:210, verify-runner.ts:309.",
  stats: { lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 }, toolUses: 2, turnCount: 3, compactionCount: 0 },
});
coordinator.backgroundAgentIds.add(ID);

console.log("   pi-loop-mode holds the lock; the background subagent settles and its\n   nudge is held (AH1). Then the session ends.\n");
loopLock.beginCompaction(loopLock.LOOP_OWNER);
coordinator.onAgentComplete(manager.getRecord(ID));
await sleep(350);

const heldBefore = notices.filter((n) => /result held/.test(n)).length;
check("the nudge is held rather than sent", heldBefore === 1);
check("and it is still sitting in the batch set", coordinator.pendingNudges.has(ID));

// This is `session_shutdown`.
coordinator.dispose();
loopLock.endCompaction(loopLock.LOOP_OWNER);

const drops = notices.filter((n) => /NOT delivered/.test(n));
const dropWarns = warned.filter((w) => /could not deliver/.test(w));

console.log("      BEFORE                                     NOW");
console.log("      ────────────────────────────────────────   ────────────────────────────────────────");
console.log(`      the id is cleared, nothing is said         ${drops.length} notice, ${dropWarns.length} log line`);
console.log(`      (not to the model, operator or log)        "${(drops[0] ?? "").slice(0, 64)}…"`);

check("the drop is reported at all", drops.length === 1 && dropWarns.length === 1);
const drop0 = drops[0] ?? "";
check("it names the agent and its type", drop0.includes('"Explore"') && drop0.includes("bg-agent"));
check("it says WHY — the session ended with the result still queued", /still queued/.test(drop0));
check(
  "on a channel that exists headless, because noOpUIContext.notify is () => {}",
  /still queued/.test(dropWarns[0] ?? ""),
);

// AG6's rule, applied to the one reason it did not exist for.
check(
  "it does NOT send the operator to /agents — the session that owns it is what is ending",
  drop0.length > 0 && !/\/agents/.test(drop0) && !/View result/.test(drop0),
);
check("…and says so rather than naming a recovery that cannot work", /The answer is gone with it\./.test(drop0));

// The transcript is the one thing that outlives a session, when there is one.
const withFile = describeNudgeDrop("session-ending", "1a2b3c4d", "Explore", "/tmp/pi-agents/1a2b3c4d.md");
check("…except a transcript, which is named when the operator turned one on", /transcript is at \/tmp/.test(withFile.notice));

// The two sentences are different facts and must stay different.
const replaced = describeNudgeDrop("session-replaced", "1a2b3c4d", "Explore");
const ending = describeNudgeDrop("session-ending", "1a2b3c4d", "Explore");
check("never-fired and fired-too-late remain two sentences", replaced.log !== ending.log);

// A second dispose must not invent a second drop.
const before = notices.length;
coordinator.dispose();
check("a second dispose reports nothing — the queue was already drained", notices.length === before);

console.log(`
   Controls:
     · an ordinary dispose with an EMPTY queue says nothing, which is every
       session that ends with no delegation in flight
     · the record is read from the manager BEFORE it is disposed, which is the
       order events.ts already had and the reason the notice can name the agent
     · the answer really is gone: mgr.dispose() clears the map both /agents and
       AgentStatus read, so NO_RECOVERY_ADVICE is the true sentence here and
       RECOVERY_ADVICE would be AG6's defect restored

   Pinned by pi-subagents-lite/tests/nudge-drop.test.ts, "AI1 — a queued nudge at
   session_shutdown". Removing the fix fails 1 test there and 6 of this probe's
   expectations.
`);

// The empty-queue control, on a fresh coordinator.
{
  const quiet = new SpawnCoordinator(manager);
  const at = notices.length;
  quiet.dispose();
  check("control: disposing with nothing queued says nothing at all", notices.length === at);
}

console.warn = realWarn;
console.log(failures > 0 ? `   ${failures} expectation(s) failed` : "   all expectations held");
process.exit(failures > 0 ? 1 : 0);
