/**
 * l2 — X2. `detectStuck`'s first rule is about ONE response, and it was handed
 * the turn's LAST message.
 *
 * The rule detects a sentence, word or short phrase repeated many times inside a
 * single response. It was called with `messageToRepetitionText(lastAssistant)`,
 * so a turn that answered and then produced one more assistant message — the
 * mid-turn steer W1 is about — had its ANSWER scanned by nobody.
 *
 * FIXED: `message_end` buffers each message's repetition text and `agent_end`
 * hands the whole turn to `detectStuck`, which scans each. A one-message turn is
 * byte-for-byte the old behaviour; a caller passing one string still gets it.
 *
 *   run: node --experimental-strip-types l2-degenerate-rule-reads-one-message.mjs
 */

import { makeHost } from "./_host.mjs";
import loopMode from "/home/claudeuser/qwen3.8-forge/vendor/pi-loop-mode/extensions/index.ts";
import {
  detectDegenerateRepetition,
  messageToRepetitionText,
} from "/home/claudeuser/qwen3.8-forge/vendor/pi-loop-mode/src/repetition.ts";

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

const DEGENERATE = Array.from({ length: 9 }, () => "I will now verify the parser handles nested quotes.").join(" ");
const AFTERTHOUGHT =
  "the background helper just finished and its report is about the templating layer, which has nothing to do with this";
const read = [{ toolName: "read", content: "out", isError: false }];

console.log(`
=== l2 — the degenerate rule read one message, and it was the wrong one ===

  the answer repeats one sentence 9× (${DEGENERATE.length} chars); DEGENERATE_REPEATS is 4

  BEFORE — the rule's input was the LAST message of the turn:
    one-message turn   detectDegenerateRepetition(answer)  -> ${JSON.stringify(detectDegenerateRepetition(messageToRepetitionText(answered(DEGENERATE)), 4)?.kind ?? null)}
    two-message turn   detectDegenerateRepetition(thought) -> ${JSON.stringify(detectDegenerateRepetition(messageToRepetitionText(thought(AFTERTHOUGHT)), 4)?.kind ?? null)}
`);

await host.run("start audit the parser");
console.log(`  NOW, control — the degenerate answer alone   : ${await turn([answered(DEGENERATE)], read)}`);
await host.run("stop");
await host.run("start audit the parser, again");
console.log(`  NOW — the same answer + a trailing thought   : ${await turn([answered(DEGENERATE), thought(AFTERTHOUGHT)], read)}`);
await host.run("stop");
await host.run("start audit the parser, once more");
console.log(`  NOW, control — a clean answer + a thought    : ${await turn([answered("I read src/parser.ts and the nested-quote case is already covered by a test."), thought(AFTERTHOUGHT)], read)}`);
await host.quit();

console.log(`
  The rule is the loop's only after-the-fact degeneracy check. The mid-stream
  kill switch is a different threshold (DEGENERATE_STREAM_REPEATS = 6) and only
  fires while the tokens are still arriving, so the 4-and-5 repeat band is
  entirely this rule's job — and it was doing it for whichever message happened
  to be last.
`);
