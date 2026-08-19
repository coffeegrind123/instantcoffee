/**
 * k1 — W1. One turn, three readings of "what the model said", inside one handler.
 *
 * `agent_end` derives the turn's answer three times and they are not the same
 * string:
 *
 *   committedText                  commitTurnMemory(turnTexts, …)
 *                                  the LAST NON-EMPTY message of the turn
 *   messageToText(lastAssistant)   the LAST message only, text blocks only
 *   messageToRepetitionText(…)     the LAST message only, text OR thinking
 *
 * V2 moved `detectStuck` onto the first. `LOOP_DONE:` / `LOOP_BLOCKED:` and
 * `emptyResponse` still read the second — a distinction without a difference for
 * a one-message turn, which is every turn in the suite.
 *
 * It stops being one when a turn ends on a message that is not its answer, and
 * pi runs another assistant message inside the SAME turn whenever a steer or
 * follow-up arrives mid-turn (`agent-loop.js`, `while (hasMoreToolCalls ||
 * pendingMessages.length > 0)`). A background subagent's result is delivered
 * exactly that way — `SpawnCoordinator.emitIndividualNudge` sends it with
 * `deliverAs: "steer", triggerTurn: true` while the parent is busy — and since
 * `patches/forge_reasoning_passthrough.py` (2026-08-17) that extra message can be
 * reasoning-only, with no text at all.
 *
 * FIXED: `message_end` buffers the turn's answers separately from its repetition
 * feed, and `agent_end` reads `turnAnswerText` — the last message of the turn that
 * produced text, falling back to the old value when the buffer is empty.
 *
 *   run:  node --experimental-strip-types k1-the-turns-answer-read-three-ways.mjs low
 *         node --experimental-strip-types k1-the-turns-answer-read-three-ways.mjs saturated
 *
 * One mode per process: the loop's state is module-global.
 */

import { makeHost } from "./_host.mjs";
import loopMode from "/home/claudeuser/qwen3.8-forge/vendor/pi-loop-mode/extensions/index.ts";
import { messageToText } from "/home/claudeuser/qwen3.8-forge/vendor/pi-loop-mode/src/repetition.ts";

const mode = process.argv[2] === "saturated" ? "saturated" : "low";
const percent = mode === "saturated" ? 90 : 20;

const answered = (t) => ({ role: "assistant", content: [{ type: "text", text: t }], stopReason: "stop", usage: { output: 40 } });
const thought = (t) => ({ role: "assistant", content: [{ type: "thinking", thinking: t }], stopReason: "stop", usage: { output: 126 } });

const host = makeHost({ percent });
loopMode(host.pi);

async function turn(messages) {
  host.notices.length = 0;
  for (const m of messages) await host.fire("message_end", { message: m });
  await host.fire("agent_end", { messages });
  return host.notices.join(" | ") || "(no notice)";
}

async function scenario(label, messages) {
  await host.run("stop");
  await host.run("start ship the feature. Done when: the feature is shipped --until-done");
  const notice = await turn(messages);
  const status = await host.run("status");
  const line = (re) => status.split("\n").find((l) => re.test(l)) ?? "";
  console.log(`  ${label}`);
  console.log(`    notice  : ${notice}`);
  console.log(`    ${line(/^Active:/)}   ${line(/^Status:/)}   ${line(/^Iterations:/)}`);
}

console.log(`\n=== k1 — the turn's answer, read three ways (context ${percent}%) ===\n`);

const DONE = "LOOP_DONE: the feature is shipped and the tests pass.";
const AFTERTHOUGHT =
  "the operator asked whether it is shipped and I have already said so, so there is nothing further to do";

const messages = [answered(DONE), thought(AFTERTHOUGHT)];

console.log("The turn: an answer carrying the completion marker, then — because a background");
console.log("subagent's result was steered in mid-turn — one more assistant message, which was");
console.log("reasoning only.\n");
console.log("  what each reader takes out of that turn:");
console.log(`    committedText  (detectStuck, since V2) : ${JSON.stringify(DONE.slice(0, 34) + "…")}`);
console.log(`    messageToText(last message)            : ${JSON.stringify(messageToText(messages[1]))}   <- BEFORE`);
console.log(`    turnAnswerText (the turn's answer)     : ${JSON.stringify(DONE.slice(0, 34) + "…")}   <- NOW\n`);

console.log("BEFORE — the marker is tested against the last MESSAGE, so an --until-done run");
console.log("         that has finished does not stop:\n");
console.log("    notice  : (no notice)");
console.log("    Active: true   Status: running   Iterations: 1/∞");
if (mode === "saturated") {
  console.log("    …and at >= 80% the same turn is read as starved instead: emptyResponse is");
  console.log("    true because the LAST message has no text and the turn made no tool call, so");
  console.log("    a turn that answered is charged to the context-recovery ladder.");
  console.log("    notice  : Loop: context pressure detected (1/3) — recovering.\n");
} else {
  console.log("");
}

console.log("NOW — driving the shipped module:\n");
await scenario("the answer, then a reasoning-only message in the same turn", messages);
console.log();
await scenario("control — the same marker on a one-message turn", [answered(DONE)]);
console.log();
await scenario("control — a turn that answered NOTHING (V1's case, must stay starved at >= 80%)", [
  thought("I have nothing to add this turn, the work looks complete to me"),
]);

console.log(`
  The last control is why the fix is a buffer rather than a scan of
  \`event.messages\`: the question is what THIS TURN said, and a turn that said
  nothing has to keep reading as empty. Below 80% it is simply a quiet iteration;
  at or above it, the starvation rung still fires and names the shape.
`);

await host.quit();
