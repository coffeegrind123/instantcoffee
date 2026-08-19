/**
 * l4 — X3. `GOAL_READY:` is the fourth reader of "what did this turn say", and
 * the one W1 could not move.
 *
 * `/loop prepare` spends a turn — usually on the strongest model available —
 * writing the specification an unattended run is then steered by. `agent_end`
 * watches for the marker on the way back, and read it off
 * `messageToText(lastAssistant)`: the last MESSAGE. W1 fixed the same question
 * for the loop's own markers with a per-turn buffer, and could not fix this one,
 * because `message_end` was gated on `state.active` and preparation runs with it
 * false — so there was no buffer to read.
 *
 * What a missed marker costs is V8's failure by another route: `preparedAt` stays
 * 0, so `kindDirective("start")` never says "First read <goalFile> to load the
 * full specification", `loopInstructions` never adds the "Specification: …" line,
 * `/loop status` reads "not prepared" for the rest of the session, and the spec
 * that was just written is never mentioned to the model that has to follow it.
 *
 * FIXED: `message_end` buffers during preparation too, and the branch reads the
 * turn's last ANSWER with the old value as the fallback. It also drops the
 * buffers on the way out — that branch returns above the drain.
 *
 *   run: node --experimental-strip-types l4-goal-ready-read-off-the-last-message.mjs
 */

import { makeHost } from "./_host.mjs";
import loopMode from "/home/claudeuser/qwen3.8-forge/vendor/pi-loop-mode/extensions/index.ts";
import { messageToText } from "/home/claudeuser/qwen3.8-forge/vendor/pi-loop-mode/src/repetition.ts";

const answered = (t) => ({ role: "assistant", content: [{ type: "text", text: t }], stopReason: "stop", usage: { output: 40 } });
const thought = (t) => ({ role: "assistant", content: [{ type: "thinking", thinking: t }], stopReason: "stop", usage: { output: 126 } });

const host = makeHost({ percent: 20 });
loopMode(host.pi);

const READY = "GOAL_READY: the specification is in GOAL.md, with milestones and a check script.";
const AFTER = "the background helper reported its findings just now, and none of them change the spec I wrote";

async function scenario(label, goal, messages) {
  await host.run("end");
  await host.run(`goal ${goal}`);
  await host.run("prepare");
  host.notices.length = 0;
  for (const m of messages) await host.fire("message_end", { message: m });
  await host.fire("agent_end", { messages });
  const notice = host.notices.join(" | ") || "(no notice)";
  const status = await host.run("status");
  const line = (re) => (status.split("\n").find((l) => re.test(l)) ?? "").trim();
  console.log(`  ${label}`);
  console.log(`    the last message's text : ${JSON.stringify(messageToText(messages[messages.length - 1]).slice(0, 40))}`);
  console.log(`    notice                  : ${notice}`);
  console.log(`    ${line(/^Status:/)}   ${line(/^Goal file:/)}`);
  console.log();
}

console.log(`
=== l4 — GOAL_READY is the prepare turn's answer, not its last message ===

BEFORE — a prepare turn whose marker was followed by a reasoning-only message:
    notice     : (no notice)
    Status: preparing        Goal file: GOAL.md (not prepared)
  …and it never recovers: nothing else sets preparedAt, and the next /loop run
  starts an unattended loop that has never been told the specification exists.

NOW — driving the shipped module:
`);

await scenario("control — the marker on a one-message prepare turn", "write the spec. Done when: GOAL.md exists", [answered(READY)]);
await scenario("the marker, then a reasoning-only message in the same turn", "write the spec, take two. Done when: GOAL.md exists", [
  answered(READY),
  thought(AFTER),
]);
await scenario("control — a prepare turn that did NOT finish must stay unprepared", "write a third spec. Done when: GOAL.md exists", [
  answered("I have started on the specification but it is not finished yet."),
  thought(AFTER),
]);

await host.quit();
console.log(`  The third case is the control that matters: the fix must not make the marker
  easier to satisfy, only findable when the turn really did produce it.
`);
