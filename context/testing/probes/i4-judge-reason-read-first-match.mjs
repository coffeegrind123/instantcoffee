/**
 * I4 probe — U4 (**FIXED**): the judge's reply used to be read in two directions
 * at once. The VERDICT was scanned newest-first; the WHY was the first match
 * anywhere.
 *
 * `parseJudgeVerdict()` used to open with
 *
 *     const why = (text.match(/WHY:\s*(.+)/i)?.[1] ?? "").trim();
 *
 * and only then walk the lines backwards looking for a `VERDICT:` line. So the
 * two halves of the same reply were read by opposite rules, and the WHY half had
 * neither of the two protections the fourth pass added for the verdict: it was
 * not scanned newest-first, and it was not guarded against the prompt's own
 * instruction line.
 *
 * It now takes the first usable `WHY:` line AFTER the line that decided the
 * verdict, falling back to the last usable one when nothing decided, and it will
 * not take the prompt's own instruction — checked against the exported
 * `WHY_INSTRUCTION` constant rather than by pattern, so a reword of the prompt
 * cannot silently reopen it.
 *
 * `buildJudgePrompt()` ends with exactly the two lines a small model is most
 * likely to echo:
 *
 *     VERDICT: ADDRESSED or NOT_ADDRESSED
 *     WHY: one sentence, and if NOT_ADDRESSED say what the task asked for that
 *          the answer does not give.
 *
 * S2 was the first of those being read as a verdict. This is the second being
 * read as a reason — and the reason is not decoration: it is the entire content
 * of `buildRepairPrompt`'s "Reason:" line, so a repair round (the expensive
 * half: one model call in the child's own session, on the slot the parent is
 * blocked on) is spent telling the child that its answer was wrong because
 * "one sentence, and if NOT_ADDRESSED say what the task asked for…". It is also
 * what the operator is shown in the `notify` line.
 *
 *   node --experimental-strip-types i4-judge-reason-read-first-match.mjs
 */

import { REPO } from "./_host.mjs";

const { parseJudgeVerdict, buildRepairPrompt, buildJudgePrompt } = await import(
  `${REPO}/vendor/pi-subagents-lite/src/agents/verify.ts`
);

const BRIEF = "List every caller of parseHeader(), with file and line.";
const ANSWER = "parseHeader is a small function in src/header.ts that reads the first 16 bytes.";

const REPLIES = [
  [
    "control — the two lines it was asked for",
    "VERDICT: NOT_ADDRESSED\nWHY: the answer describes the function instead of listing its callers.",
  ],
  [
    "echoes the instruction block, then answers correctly",
    [
      "Reply with exactly two lines:",
      "VERDICT: ADDRESSED or NOT_ADDRESSED",
      "WHY: one sentence, and if NOT_ADDRESSED say what the task asked for that the answer does not give.",
      "",
      "VERDICT: NOT_ADDRESSED",
      "WHY: the answer describes the function instead of listing its callers.",
    ].join("\n"),
  ],
  [
    "thinks out loud, commits last",
    [
      "Let me work through it. WHY: I first need to check whether call sites appear at all.",
      "They do not.",
      "VERDICT: NOT_ADDRESSED",
      "WHY: no call sites are given, only a description of the function.",
    ].join("\n"),
  ],
];

console.log("=== I4 · what the judge said, what the repair was told ===");
console.log("\nThe last two lines of the judge's own prompt — the text that gets echoed:");
for (const line of buildJudgePrompt(BRIEF, ANSWER).split("\n").slice(-2)) console.log("   " + line);

for (const [label, reply] of REPLIES) {
  const v = parseJudgeVerdict(reply);
  console.log(`\n--- ${label} ---`);
  console.log("  verdict read as :", v.addressed ? "ADDRESSED" : "NOT_ADDRESSED", v.unparsed ? "(unparsed)" : "");
  console.log("  reason read as  :", JSON.stringify(v.why));
  console.log("  the child is then sent:");
  for (const line of buildRepairPrompt(BRIEF, v.why).split("\n").slice(0, 2)) console.log("      " + line);
}

console.log(`
NOW: all three read the same reason, and it is the one the judge gave.

BEFORE: only the first did.

  echoes the instruction block
      reason read as "one sentence, and if NOT_ADDRESSED say what the task asked
      for that the answer does not give." — the prompt's own WHY line, handed
      straight to the child as the reason its answer was wrong.
  thinks out loud
      reason read as "I first need to check whether call sites appear at all." —
      the judge's opening thought, not its conclusion.

The verdict was right in all three even before the fix: that is S2 holding, and
it is this probe's control. What was wrong was the sentence a repair round is
spent acting on — one model call in the child's own session, on the slot the
parent is blocked on, in a window that is already the thing most likely to be
wrong — and the sentence the operator is shown in the notify line.
`);
