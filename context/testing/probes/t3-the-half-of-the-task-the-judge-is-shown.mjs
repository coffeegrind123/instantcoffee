/**
 * t3 — AG1. `briefForCheck` reserves half the budget for the follow-ups and then
 * never spends the other half on them.
 *
 * FIXED — this probe prints BEFORE and NOW side by side.
 *
 * AF5 (fifteenth pass) moved the two model-facing readers of `record.execution.brief`
 * off `truncate(brief, 1_500)` — a HEAD cut over a string that grows at the TAIL —
 * and onto `briefForCheck`, whose docstring says:
 *
 *   > The split is the one `appendFollowUp` already owns, so the two cannot drift.
 *
 * They have drifted. `appendFollowUp` gives the follow-ups **everything the
 * original does not use** (`MAX_BRIEF_CHARS - original.length`); `briefForCheck`
 * gives them a flat `floor(max * FOLLOW_UP_CHECK_SHARE)` and returns the
 * remainder unspent. On a SHORT original — the ordinary shape, since a brief is
 * usually one sentence and the steers are what accumulate — that throws away
 * follow-ups that fit inside the budget with room to spare.
 *
 * Every AF5 test uses a >1,500-character original, which is the one shape where
 * the reserve and the remainder happen to agree.
 *
 *   run: node --experimental-strip-types t3-the-half-of-the-task-the-judge-is-shown.mjs
 */

import {
  JUDGE_BRIEF_CHARS,
  MAX_BRIEF_CHARS,
  FOLLOW_UP_CHECK_SHARE,
  appendFollowUp,
  briefForCheck,
  buildJudgePrompt,
} from "/home/claudeuser/qwen3.8-forge/vendor/pi-subagents-lite/src/agents/verify.ts";

let failures = 0;
const check = (label, ok) => {
  console.log(`   ${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) failures++;
};

const MARKER = "\n\nFollow-up: ";

/** The share as a CEILING — what `briefForCheck` did before the sixteenth pass. */
function before(brief, max) {
  const parts = brief.split(MARKER);
  const ups = parts.slice(1);
  const budget = Math.max(0, Math.floor(max * FOLLOW_UP_CHECK_SHARE));
  let spent = 0;
  let kept = 0;
  for (let i = ups.length - 1; i >= 0; i--) {
    const cost = ups[i].length + MARKER.length;
    if (spent + cost > budget) break;
    spent += cost;
    kept++;
  }
  return { kept, chars: Math.min(max, parts[0].length + spent), budget };
}

/**
 * What the follow-ups get now that the share is a floor rather than a ceiling —
 * i.e. `appendFollowUp`'s own rule, which is the one this function's docstring
 * says it applies: the follow-ups get whatever the original does not use, and
 * never less than the reserved share.
 */
function ideal(brief, max) {
  const parts = brief.split(MARKER);
  const original = parts[0];
  const ups = parts.slice(1);
  const budget = Math.max(Math.floor(max * FOLLOW_UP_CHECK_SHARE), max - original.length);
  let spent = 0;
  let kept = 0;
  for (let i = ups.length - 1; i >= 0; i--) {
    const cost = ups[i].length + MARKER.length;
    if (spent + cost > budget) break;
    spent += cost;
    kept++;
  }
  return { kept, budget };
}

const report = (label, brief) => {
  const out = briefForCheck(brief, JUDGE_BRIEF_CHARS);
  const had = brief.split(MARKER).length - 1;
  const kept = out.split(MARKER).length - 1;
  const was = before(brief, JUDGE_BRIEF_CHARS);
  console.log(`
   ${label}
     brief                       ${brief.length} chars — original ${brief.split(MARKER)[0].length}, ${had} follow-up(s)
                                 BEFORE            NOW
     chars of a ${JUDGE_BRIEF_CHARS} budget    ${String(was.chars).padEnd(18)}${out.length}
     follow-ups the judge sees   ${String(`${was.kept} of ${had}`).padEnd(18)}${kept} of ${had}
     follow-up budget            ${String(was.budget).padEnd(18)}${ideal(brief, JUDGE_BRIEF_CHARS).budget}`);
  return { out, had, kept, was, would: ideal(brief, JUDGE_BRIEF_CHARS) };
};

console.log("\nt3 — how much of an accumulated task the judge is actually shown\n");
console.log(`   appendFollowUp gives the follow-ups   MAX_BRIEF_CHARS - original.length`);
console.log(`   briefForCheck BEFORE                  floor(max * ${FOLLOW_UP_CHECK_SHARE}) = ${Math.floor(JUDGE_BRIEF_CHARS * FOLLOW_UP_CHECK_SHARE)} of ${JUDGE_BRIEF_CHARS}, remainder unspent`);
console.log(`   briefForCheck NOW                     max(that, max - original.length) — a FLOOR`);

// ── the ordinary shape: a one-line brief, steered four times ─────────────────
let short = "Find every caller of parseConfig and say which of them can pass a null.";
for (const n of [1, 2, 3, 4]) short = appendFollowUp(short, `steer ${n}: ` + "x".repeat(388));
const A = report("a one-line brief, steered four times", short);

check("no follow-up is dropped that the budget had room for", A.kept === A.would.kept);
check("…and the budget is actually spent — BEFORE it stopped at half",
  A.out.length > JUDGE_BRIEF_CHARS * 0.8 && A.was.chars < JUDGE_BRIEF_CHARS * 0.5);
check("the newest instruction still survives — AF5's own guarantee holds",
  A.out.includes("steer 4:"));
check("the judge is now asked about the accumulated task",
  buildJudgePrompt(short, "an answer").includes("steer 2:"));
check("BEFORE, it saw one steer of four", A.was.kept === 1);

// ── the shape AF5 was written for, and every AF5 test uses ───────────────────
let long = "T".repeat(1_400);
for (const n of [1, 2, 3]) long = appendFollowUp(long, `steer ${n}: ` + "y".repeat(188));
const B = report("the AF5 shape — an original that alone fills the budget", long);
check("control — with a long original nothing changed at all", B.kept === B.would.kept && B.was.kept === B.kept);

// ── the boundary: where the reserve stops being the binding constraint ───────
console.log("\n   the boundary, as the original grows (four ~400-char steers):\n");
console.log("     original   BEFORE   NOW");
for (const originalChars of [50, 200, 400, 700, 750, 900, 1_100, 1_400]) {
  let brief = "O".repeat(originalChars);
  for (const n of [1, 2, 3, 4]) brief = appendFollowUp(brief, `steer ${n}: ` + "z".repeat(388));
  const out = briefForCheck(brief, JUDGE_BRIEF_CHARS);
  const kept = out.split(MARKER).length - 1;
  const was = before(brief, JUDGE_BRIEF_CHARS);
  const flag = kept > was.kept ? "   ←" : "";
  console.log(`     ${String(originalChars).padStart(8)}   ${String(was.kept).padStart(6)}   ${String(kept).padStart(3)}${flag}`);
}

console.log(`
   The two readers of this function are buildJudgePrompt (what the answer is
   checked against) and buildAnchorMessage (what is restated into a context that
   was just compacted). A judge shown a quarter of the task says NOT_ADDRESSED,
   correctly, about the question it was given — which spends a repair round, and
   buildRepairPrompt then restates the brief in FULL, so the child answers the
   same thing again and verifyAnswer ends at "stalled": the parent is handed the
   answer it already had, labelled "Treat it as unreliable". That chain is AF5's
   own docstring, for the shape AF5 did not cover — and the fix is one Math.max,
   pinned by tests/verify.test.ts's AG1 block (4 fail when it is removed).
`);

console.log(failures > 0 ? `   ${failures} expectation(s) failed` : "   all expectations held");
process.exit(failures > 0 ? 1 : 0);
