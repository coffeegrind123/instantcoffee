/**
 * u4 — AH6. AG2's deferral deleted the directive it was supposed to delay.
 *
 * FIXED — this probe prints BEFORE and NOW, driving the SHIPPED loop extension
 * with real timers, so the five-second wait is the real one.
 *
 * `deliverLoopTurn` and `interveneStuck` send with `queueOnly` in exactly one
 * situation: `ctx.hasPendingMessages()` is true, i.e. a human typed while the
 * agent was streaming and a turn is therefore already coming. That is V4's
 * finding and AF3's fix — six exits of `agent_end` carry a DIRECTIVE, everything
 * above them has already been charged, and the text has to arrive:
 *
 *   > The guard is right for every OTHER exit of agent_end, where the loop only
 *   > needs *a* turn to happen and a pending message will cause one; here the
 *   > loop needs THIS TEXT to reach the model.
 *
 * AG2 (sixteenth pass) then made every send read the compaction lock and, when it
 * is held, reschedule through `scheduleLoopTurn` — which writes the loop's ONE
 * `pendingTimer` slot. And `agent_end` clears that slot at its first line.
 *
 * The two conditions are not independent. `queueOnly` MEANS a turn is already
 * coming, so `_handlePostAgentRun()` will run `agent.continue()` and emit another
 * `agent_end` within milliseconds — well inside `COMPACTION_WAIT_MS`. The
 * deferral therefore did not delay the directive on that path. It deleted it, and
 * left the counters, the notice and the operator's belief behind.
 *
 *   run: node --experimental-strip-types u4-the-directive-that-was-charged-and-dropped.mjs
 */

import { REPO, makeHost } from "./_host.mjs";

const ext = (await import(`${REPO}/vendor/pi-loop-mode/extensions/index.ts`)).default;
const lock = await import(`${REPO}/vendor/pi-loop-mode/src/compaction-lock.ts`);

let failures = 0;
const check = (label, ok) => {
  console.log(`   ${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log("\nu4 — the directive that was charged, announced, and then dropped\n");

const host = makeHost({ idle: false });
ext(host.pi);
await host.run("start keep the docs in step with the code --endless");

// A human typed mid-turn. AA3: this is the ONLY thing that makes
// hasPendingMessages() true, and it is the whole premise of the queueOnly path.
host.ctx.hasPendingMessages = () => true;

lock.beginCompaction("prinny-channel");
host.sent.length = 0;
const notice = await host.turn({ messages: ["LOOP_BLOCKED: no credentials for the staging registry."] });

console.log("   iteration N — the model reports it is blocked, and a compaction is running:\n");
console.log(`      ladder said : ${notice.split(" | ")[0]}`);
console.log(`      deferral    : ${notice.split(" | ")[1] ?? "(none)"}`);
console.log(`      sent        : ${host.sent.length} turn(s)`);
check("nothing is sent into the compaction (AG2 holds)", host.sent.length === 0);
check("the ladder was charged and the operator was told", /continuing with assumptions/.test(notice));

// The turn that was already coming ends. Its agent_end runs clearPendingTimer()
// at its first line — the deferred `unblock` had nowhere else to live.
host.ctx.hasPendingMessages = () => false;
await host.turn({ messages: ["Right, carrying on."] });
console.log("\n   the turn that was already coming ends — agent_end clears the loop's one timer\n");

lock.endCompaction("prinny-channel");
await sleep(5_400);

const kinds = host.sent.map((m) => m.details?.kind);
console.log("      what the model was eventually sent:\n");
console.log("         BEFORE      NOW");
console.log("         ─────────   ─────────");
console.log(`         continue    ${(kinds[0] ?? "(nothing)").padEnd(9)}`);
check("exactly one turn is still sent", kinds.length === 1);
check("and it carries the directive the ladder was charged for", kinds[0] === "unblock");

console.log(`
   BEFORE, the operator was told "blocked reported — continuing with assumptions",
   \`blockedSignalCount\` was incremented, and the model was sent the generic
   "continue" — never the unblock directive, which is the entire response this
   loop has to a LOOP_BLOCKED and the only thing that tells the model to document
   an assumption and carry on rather than waiting for a human. In an unattended
   run there is nobody to wait for.

   The fix remembers the TEXT rather than re-timing it: DIRECTIVE_KINDS names the
   six kinds the ladder charges for, a deferral records the kind, and the next
   turn the loop sends carries it. Exactly one turn is still sent, and a newer
   directive supersedes a remembered one because that is a fresher reading of the
   same run. A plain \`continue\` is deliberately still droppable — AF3's own
   asymmetry, unchanged.

   Pinned by pi-loop-mode/tests/turn-into-a-compaction.test.ts's AH6 block (4
   assertions; 1 fails when the fix is removed) — and note that the test HARNESS
   had to learn to model \`clearTimeout\` first, because a fake whose handles
   cannot be cancelled cannot fail where the module does. That is X1 pointed at
   the scaffolding.
`);

await host.quit();
console.log(failures > 0 ? `   ${failures} expectation(s) failed` : "   all expectations held");
process.exit(failures > 0 ? 1 : 0);
