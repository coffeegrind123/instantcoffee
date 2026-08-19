/**
 * l1 — X1. What a two-message turn puts in the repetition window.
 *
 * `message_end` buffers `messageToText(m) || messageToRepetitionText(m)` per
 * message. `commitTurnMemory` took the LAST NON-EMPTY of that buffer and called
 * it "the turn's final answer" — so a turn that answered and then produced one
 * reasoning-only message committed the trailing THOUGHT, and every rule in
 * `detectStuck` compared thoughts with thoughts from then on.
 *
 * That is W1's shape one line over, and the seventh pass's own §2.2 table says
 * this reader took the answer. It did not.
 *
 * FIXED: `commitTurnMemory` takes the turn's ANSWERS as well and prefers the last
 * non-empty of those; the tracked buffer is the fallback, so V1/V2's case — a
 * turn whose only output was reasoning — still commits and compares the
 * reasoning.
 *
 *   run: node --experimental-strip-types l1-window-commits-the-trailing-thought.mjs
 */

import { makeHost } from "./_host.mjs";
import loopMode from "/home/claudeuser/qwen3.8-forge/vendor/pi-loop-mode/extensions/index.ts";
import { fingerprint, messageToText, messageToRepetitionText } from "/home/claudeuser/qwen3.8-forge/vendor/pi-loop-mode/src/repetition.ts";

const answered = (t) => ({ role: "assistant", content: [{ type: "text", text: t }], stopReason: "stop", usage: { output: 40 } });
const thought = (t) => ({ role: "assistant", content: [{ type: "thinking", thinking: t }], stopReason: "stop", usage: { output: 126 } });

const host = makeHost({ percent: 20 });
loopMode(host.pi);

async function turn(messages, tools = []) {
  host.notices.length = 0;
  for (const m of messages) await host.fire("message_end", { message: m });
  for (const t of tools) await host.fire("tool_result", t);
  await host.fire("agent_end", { messages });
  return host.notices.join(" | ") || "(no notice)";
}

const ANSWER =
  "I re-read src/parser.ts and confirmed the tokenizer handles nested quotes; nothing else " +
  "to change here, so the work stands exactly as it is and I will move on.";
const THOUGHTS = [
  "the delegated search came back with a list of call sites in the templating layer, which does not touch this",
  "a background helper finished summarising release notes, none of which mention parsing or anything adjacent",
  "another agent reports that the migration script is unrelated, so I will simply carry on with what I planned",
];
const read = (n) => [{ toolName: "read", content: `contents ${n}`, isError: false }];

console.log(`
=== l1 — the window commits the turn's answer, not its last message ===

The turn: an answer, then one more assistant message that is reasoning only —
which is what pi produces when a background subagent's result is steered in
mid-turn (SpawnCoordinator.emitIndividualNudge, deliverAs "steer",
triggerTurn true) and the model thinks rather than speaks.

  what the OLD reader committed  (last non-empty of text||thinking, per message)
    ${JSON.stringify((messageToText(thought(THOUGHTS[0])) || messageToRepetitionText(thought(THOUGHTS[0]))).slice(0, 62) + "…")}
  what the NEW reader commits    (the turn's last ANSWER)
    ${JSON.stringify(ANSWER.slice(0, 62) + "…")}

  fingerprints, which is what rules 3, 4 and 6 compare:
    answer          ${fingerprint(ANSWER)}
    thought 1       ${fingerprint(THOUGHTS[0])}
    thought 2       ${fingerprint(THOUGHTS[1])}   <- the old subject changed every turn
`);

console.log("A — four BYTE-IDENTICAL answers, each followed by a different thought.");
console.log("    BEFORE: no notice, ever. The committed string was the thought, and it differed.\n");
await host.run("start audit the parser");
for (let i = 0; i < 4; i++) {
  console.log(`    turn ${i + 1}: ${await turn([answered(ANSWER), thought(THOUGHTS[i % 3] + " ".repeat(i + 1))], read(i))}`);
}

console.log("\n    control — the same four turns as ONE message each (unaffected throughout):\n");
await host.run("stop");
await host.run("start audit the parser, again");
for (let i = 0; i < 4; i++) console.log(`    turn ${i + 1}: ${await turn([answered(ANSWER)], read(i))}`);

console.log("\nB — four GENUINELY DIFFERENT answers, each followed by the SAME thought.");
console.log("    BEFORE: \"assistant repeated the same response\" from turn 2 — a model editing a");
console.log("    different file every turn, charged sampling penalties and, at streak 3, a");
console.log("    rescue-model switch.\n");
await host.run("stop");
await host.run("start audit the parser, once more");
for (let i = 0; i < 4; i++) {
  const answer =
    `Turn ${i}: I edited src/file${i}.ts, added a regression test for the ` +
    `${["quoting", "escaping", "nesting", "unicode"][i]} case, and confirmed the suite is green.`;
  console.log(`    turn ${i + 1}: ${await turn([answered(answer), thought(THOUGHTS[0])], [{ toolName: "edit", content: `edited ${i}`, isError: false }])}`);
}

console.log("\n    control — a turn whose ONLY output is reasoning still commits the reasoning");
console.log("    (V1/V2's case, which the fallback preserves):\n");
await host.run("stop");
await host.run("start audit the parser, last time");
for (let i = 0; i < 3; i++) console.log(`    turn ${i + 1}: ${await turn([thought(ANSWER)], read(i))}`);

await host.quit();
console.log(`
  Both directions matter and they fail differently. A is the detector going
  blind; B is the detector firing on a productive run. The two share one cause:
  the window and the answer were different strings again, which is the thing V2
  fixed for detectStuck's ARGUMENT and W1 fixed for the completion markers.
`);
