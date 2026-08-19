/**
 * k2 — W2. The near-duplicate rule compared two different units.
 *
 * `commitTurnMemory` stores `finalText.slice(0, 1_500)` in `state.lastAssistantTexts`.
 * `detectStuck`'s rule 5 compares the CURRENT turn's answer, in full, against that
 * stored — truncated — previous one:
 *
 *     const previousText = texts[texts.length - 2];
 *     textSimilarity(lastAssistantText, previousText) >= 0.8
 *
 * `textSimilarity` is Jaccard over word trigrams, so a stored string that is a
 * PREFIX of the current one scores |shingles(prefix)| / |shingles(full)| — about
 * 1500/L. Above roughly 1,875 characters the rule cannot reach 0.80 even when the
 * two answers are byte-identical.
 *
 * Rule 3 (equal fingerprints) still catches a byte-identical repeat, so what was
 * actually lost is the case rule 5 is the ONLY rule for: a model that keeps
 * saying almost the same long thing — which is also the model ignoring the
 * 1,200-character output budget the loop asks for. The 1,500 was also the one
 * window bound in `commitTurnMemory` that did NOT come from `PERSISTED_WINDOW`,
 * whose comment says the bounds live there so the two cannot drift.
 *
 * FIXED: the bound is `PERSISTED_WINDOW.textChars`, and rule 5 cuts the current
 * answer to it before comparing — both sides the same unit.
 *
 *   run:  node --experimental-strip-types k2-near-duplicate-rule-vs-stored-window.mjs short
 *         node --experimental-strip-types k2-near-duplicate-rule-vs-stored-window.mjs long
 */

import { makeHost, toolResult } from "./_host.mjs";
import loopMode from "/home/claudeuser/qwen3.8-forge/vendor/pi-loop-mode/extensions/index.ts";
import { textSimilarity } from "/home/claudeuser/qwen3.8-forge/vendor/pi-loop-mode/src/repetition.ts";

const mode = process.argv[2] === "long" ? "long" : "short";
const STORED = 1_500;

// Distinct word trigrams, so the shingle set grows with the text rather than
// saturating — which is what a real answer about different files looks like.
const pool = [];
for (let i = 0; i < 4_000; i++) pool.push("w" + i.toString(36) + "x");
let seed = 12_345;
const rnd = () => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648);
const base = [];
for (let i = 0; i < 1_000; i++) base.push(pool[rnd() % pool.length]);

const words = mode === "long" ? 500 : 200;          // ~2.8k chars vs ~1.1k chars
/** turn N's answer: the same paragraph with one word in forty swapped. */
const rephrase = (n) =>
  base.slice(0, words).map((w, i) => (i % 40 === n % 40 ? pool[(i * 7_919 + n) % pool.length] : w)).join(" ");

const host = makeHost({ percent: 20 });
loopMode(host.pi);

console.log(`\n=== k2 — the near-duplicate rule and the 1,500-char window (${mode} answers) ===\n`);
await host.run("start refactor the parser");

const a = rephrase(0);
const b = rephrase(1);
console.log(`  answer length                           ${a.length} chars  (PERSISTED_WINDOW.textChars = ${STORED})`);
console.log(`  similarity, both full                   ${textSimilarity(b, a).toFixed(3)}`);
console.log(`  BEFORE  full current vs stored previous  ${textSimilarity(b, a.slice(0, STORED)).toFixed(3)}`);
console.log(`  NOW     both cut to textChars            ${textSimilarity(b.slice(0, STORED), a.slice(0, STORED)).toFixed(3)}`);
console.log(`  SIMILARITY_THRESHOLD                    0.800\n`);

for (let turn = 0; turn < 4; turn++) {
  host.notices.length = 0;
  const message = { role: "assistant", content: [{ type: "text", text: rephrase(turn) }], stopReason: "stop", usage: { output: 400 } };
  await host.fire("message_end", { message });
  // A distinct tool result each turn, so the repeated-tool-signature rule
  // cannot be what fires.
  await host.fire("tool_result", toolResult("read", `file-${turn}.ts contents ${turn}`));
  await host.fire("agent_end", { messages: [message] });
  console.log(`  turn ${turn + 1}  ${host.notices.join(" | ") || "(no notice)"}`);
}

const status = await host.run("status");
console.log("\n " + status.split("\n").filter((l) => /^Interventions/.test(l)).join("\n "));
console.log(mode === "long"
  ? "\n  BEFORE: four turns, no notice at all, Interventions 0. The stored previous\n" +
    "  answer is a 1,500-char prefix of a 2.8k-char one, so the Jaccard score could not\n" +
    "  reach the threshold however identical the two turns were. NOW: caught on turn 2,\n" +
    "  like the short case. `short` is the control — it was never affected.\n"
  : "\n  Control: under the bound the two units already coincided and the rule fired.\n" +
    "  Unchanged by the fix. Re-run with `long` for the same rephrasing above it.\n");

await host.quit();
