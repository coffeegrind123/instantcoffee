/**
 * m3 — Z3. `sanitizeDegenerateText` left the repetition in, and its fixed point
 * was still degenerate.
 *
 * The cut was `Math.max(200, ceil(text.length / repeats * 2))` — "about two
 * copies of the repeated unit, but never less than 200 characters". Whenever the
 * repeated unit is shorter than about fifty characters, which is the ordinary
 * shape of a model that has fallen into a loop, 200 characters is still four to
 * ten copies of it, and `DEGENERATE_REPEATS` is 4. So the output was itself
 * degenerate, and sanitizing the output again returned the same text.
 *
 * `message_end` writes the sanitized message OVER the one pi holds
 * (`agent-session.js:425`, X5's mechanism), so what stayed in the transcript and
 * was re-sent on every turn afterwards was still a run of the repeated sentence
 * — which is the one thing this function exists to prevent.
 *
 * The second half is the other direction: the old formula assumed the repetition
 * was the WHOLE message, so a real answer followed by a short run of junk had
 * the answer cut off with it.
 *
 *   run: node --experimental-strip-types m3-the-sanitizer-leaves-the-repetition-in.mjs
 */

import {
  detectDegenerateRepetition,
  sanitizeDegenerateText,
} from "../../../vendor/pi-loop-mode/src/repetition.ts";

/** The rule as it shipped, so BEFORE is computed rather than remembered. */
function sanitizeBefore(text) {
  const info = detectDegenerateRepetition(text, 4);
  if (!info) return undefined;
  const keepLength = Math.max(200, Math.min(text.length, Math.ceil((text.length / info.repeats) * 2)));
  return (
    `${text.slice(0, keepLength).trimEnd()}\n\n` +
    `[loop: degenerate repetition truncated — the same ${info.kind} "${info.unit.slice(0, 60)}" repeated ${info.repeats}×. Do not continue this pattern.]`
  );
}

const repeats = (text) => {
  const info = detectDegenerateRepetition(text, 4);
  return info ? `${info.repeats}× "${info.unit.slice(0, 28)}"` : "clean";
};

function row(label, text) {
  const before = sanitizeBefore(text);
  const now = sanitizeDegenerateText(text);
  console.log(`  ${label}`);
  console.log(`     the model produced      ${String(text.length).padStart(4)} chars   ${repeats(text)}`);
  console.log(`     BEFORE  what was stored ${String(before.length).padStart(4)} chars   ${repeats(before)}`);
  console.log(`     NOW     what is stored  ${String(now.length).padStart(4)} chars   ${repeats(now)}`);
  console.log();
}

console.log("what `message_end` writes over the message pi holds:\n");

row(
  "20 × a 20-char sentence",
  Array.from({ length: 20 }, () => "Still working on it.").join(" "),
);
row(
  "12 × a 32-char sentence",
  Array.from({ length: 12 }, () => "I will now check the file again.").join(" "),
);
row(
  "control — 9 × a 52-char sentence (the eighth pass's own example, already clean)",
  Array.from({ length: 9 }, () => "The feature has been implemented successfully in the module.").join(" "),
);

const ANSWER =
  "The three callers of tokenize() are src/parser.ts:41, src/lexer.ts:9 and " +
  "tools/lint.ts:88. The first two call it directly; the third goes through " +
  "the compatibility shim in tools/shim.ts, which forwards its arguments " +
  "unchanged and is the only caller that passes a custom dialect. Nothing else " +
  "in the tree references the symbol at all, including the tests.";
const junk = Array.from({ length: 20 }, () => "Let me check again.").join(" ");
console.log("  the other direction — a real answer, then the model falls into a loop");
{
  const text = `${ANSWER} ${junk}`;
  const before = sanitizeBefore(text);
  const now = sanitizeDegenerateText(text);
  const keptAnswer = (s) => (s.includes("only caller that passes a custom dialect") ? "the answer SURVIVES" : "the answer is CUT");
  console.log(`     the model produced      ${String(text.length).padStart(4)} chars   ${repeats(text)}`);
  console.log(`     BEFORE  what was stored ${String(before.length).padStart(4)} chars   ${repeats(before)}   ${keptAnswer(before)}`);
  console.log(`     NOW     what is stored  ${String(now.length).padStart(4)} chars   ${repeats(now)}   ${keptAnswer(now)}`);
}

console.log(`
The fixed point is the finding. BEFORE, sanitizing the sanitized text returned
the SAME length and the SAME repetition — the function could not remove what it
had detected, and said so in a marker claiming it had.`);
