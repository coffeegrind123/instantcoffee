/**
 * j2 — V2. The repetition windows are filled from `text OR thinking`; four of
 *      detectStuck's seven rules are gated by a length test on `text` alone.
 *
 *   message_end   turnAssistantTexts.push( messageToText(m) || messageToRepetitionText(m) )
 *   agent_end     detectStuck( messageToText(lastAssistant), messageToRepetitionText(lastAssistant) )
 *
 * So a thinking-only turn IS committed to the fingerprint / snippet / text
 * windows, and then compared under guards that measure the empty string:
 *
 *   identical response (x2)   normalizeText(lastAssistantText).length > 80
 *   identical response (x3)   normalizeText(lastAssistantText).length > 0
 *   near-duplicate            normalizeText(lastAssistantText).length > 60
 *   same question repeated    /\?\s*$/.test(lastAssistantText.trim())
 *
 * FIXED. `detectStuck` is now given the string `commitTurnMemory` actually
 * committed, so the window and the rules that read it are about the same thing.
 * A turn that committed nothing compares nothing (every gated rule is skipped by
 * its own length test); a turn whose only output was reasoning is compared on the
 * reasoning, which is what is in the window and what the model is repeating.
 *
 * Same reasoning-only turn shape as j1 (commit e81a7e5). Run both modes:
 *   node --experimental-strip-types j2-stuck-rules-read-text-only.mjs text
 *   node --experimental-strip-types j2-stuck-rules-read-text-only.mjs thinking
 */
import { makeHost, statusLines } from "./_host.mjs";
import loopExtension from "../../../vendor/pi-loop-mode/extensions/index.ts";

const mode = process.argv[2] ?? "text";
const host = makeHost();
loopExtension(host.pi);

// Consecutive pairs sit at textSimilarity 0.80 — exactly SIMILARITY_THRESHOLD.
const A = "The documentation still matches the code as far as I can tell, so there is nothing concrete to change in this batch; I will look again next time round and report if that changes.";
const B = A.replace("next time round", "next iteration");
const C = A.replace("next time round", "next cycle");

const msg = (text) =>
  mode === "thinking"
    ? { role: "assistant", content: [{ type: "thinking", thinking: text }], stopReason: "stop", usage: { output: 40 } }
    : { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", usage: { output: 40 } };

let seq = 0;
async function turn(text) {
  host.notices.length = 0;
  const m = msg(text);
  await host.fire("message_end", { message: m });
  // A distinct tool result each turn, so the tool-signature rule cannot be the
  // thing that fires — this probe is about the text rules only.
  await host.fire("tool_result", { toolName: "read", content: [{ type: "text", text: `file ${seq++}` }] });
  await host.fire("agent_end", { messages: [m] });
  return host.notices.join(" | ") || "(no notice)";
}

console.log(`=== a model REPHRASING itself, delivered as ${mode.toUpperCase()} ===`);
console.log("    consecutive answers are 80% similar — exactly the threshold\n");
await host.run("start keep the docs in step with the code");
for (const [i, text] of [A, B, C, B].entries()) console.log(`  turn ${i + 1}: ${await turn(text)}`);
console.log();
console.log(statusLines(await host.run("status"), /^(Interventions|Last notice)/));
console.log(`
BEFORE the fix

  text       caught on turn 2, and every turn after it
  thinking   nothing, ever

  detectStuck's rules, and which string each one measured:
    identical response (x2)   lastAssistantText.length > 80    TEXT ONLY
    identical response (x3)   lastAssistantText.length > 0     TEXT ONLY
    near-duplicate            lastAssistantText.length > 60    TEXT ONLY
    same question repeated    lastAssistantText ends in "?"    TEXT ONLY
    degenerate repetition     repetitionText                   text OR thinking
    3+ in the recent window   the fingerprint window           text OR thinking
    same tool signature x3    the tool window                  neither

  The window was filled from \`messageToText(m) || messageToRepetitionText(m)\` and
  the four gated rules measured \`messageToText(lastAssistant)\` — so for a
  thinking-only message the window held a value the guards could not see. With
  byte-identical repeats the effect was quieter and still wrong: caught a turn
  late, by the one ungated rule, under the wrong rule's name.

NOW

  Identical columns. \`detectStuck\` is handed \`committedText\`, the string
  \`commitTurnMemory\` returned, so both units are the turn's committed answer —
  or its reasoning, when that is all there was. \`text\` is the control: it was
  right before and is unchanged.`);
await host.quit();
process.exit(0);
