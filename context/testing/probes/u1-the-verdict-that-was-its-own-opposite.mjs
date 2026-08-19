/**
 * u1 — AH2 (and AH5). Two things the PARENT MODEL reads, in `verify.ts`.
 *
 * FIXED — this probe prints BEFORE and NOW side by side, so it is its own
 * control: the left column is the defect, the right column is the tree as it
 * stands.
 *
 * The judge is asked for one of two tokens. `UNADDRESSED` is neither of them, and
 * it is the ordinary English word for the thing being reported — the single most
 * likely lexical slip a 27B makes on this prompt. `readVerdictValue` tested
 * `/NOT[_\s-]?ADDRESSED/` and then `/ADDRESSED/`, neither anchored: the first
 * misses `UNADDRESSED` because it has no "NOT", and the second matches it as a
 * SUBSTRING. So the verdict came back as its own opposite.
 *
 * What makes this different from every other unreadable reply is the second
 * column below. A verdict nobody can read fails OPEN *and says so*:
 * `unparsed: true` reaches `verificationNote("unparsed")`, and the parent model
 * is told "the check could not be read, so this answer went out unchecked". This
 * one is not unreadable. It is read, confidently, with `unparsed: false`, so the
 * record is `passed` and the answer goes back with NO NOTE AT ALL.
 *
 * The module's own comment is the sentence this violates:
 *
 *   > NOT_ADDRESSED first: "NOT_ADDRESSED" contains "ADDRESSED", and the wrong
 *   > order turns every failure into a silent pass, forever.
 *
 * Recorded in the twelfth, thirteenth and fourteenth passes and left alone each
 * time, on this reasoning (§11.5 of `…-controls.md`):
 *
 *   > Left alone: the prompt asks for one of two exact tokens, adding a `\b`
 *   > risks the tolerant forms the parser was widened to accept (S2, U4), and
 *   > the fail-open policy already makes an unreadable verdict a pass.
 *
 * The middle clause is RIGHT, and the last block below is its control: a `\b`
 * really would break `VERDICT: _ADDRESSED_`, because `_` is a word character.
 * The decision weighed the one fix it named and declined it correctly. It never
 * asked whether that was the only fix — widening the NEGATIVE alternation costs
 * nothing on the positive side, because no verdict meaning "yes" contains the
 * substring `UNADDRESSED`. And the last clause names a policy that does not
 * reach this case at all.
 *
 *   run: node --experimental-strip-types u1-the-verdict-that-was-its-own-opposite.mjs
 */

import { parseJudgeVerdict, verificationNote } from "/home/claudeuser/qwen3.8-forge/vendor/pi-subagents-lite/src/agents/verify.ts";

let failures = 0;
const check = (label, ok) => {
  console.log(`   ${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) failures++;
};

/** `readVerdictValue` as it stood before AH2. Modelled, not imported — it is gone. */
const MENU = /\b(?:NOT[_\s-]?)?ADDRESSED\b\s*(?:or|\/|\|)\s*(?:NOT[_\s-]?)?ADDRESSED\b/i;
const VERDICT_LINE = /^[\s>*_#-]*verdict[\s*_]*:\s*(.*)$/i;
function beforeParse(reply) {
  const lines = String(reply ?? "").split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(VERDICT_LINE);
    if (!m) continue;
    if (MENU.test(m[1])) continue;
    if (/NOT[_\s-]?ADDRESSED/i.test(m[1])) return { addressed: false, unparsed: false };
    if (/ADDRESSED/i.test(m[1])) return { addressed: true, unparsed: false };
  }
  const prose = String(reply ?? "").replace(new RegExp(MENU.source, "gi"), " ");
  if (/\bNOT[_\s-]ADDRESSED\b/i.test(prose)) return { addressed: false, unparsed: false };
  if (/\bADDRESSED\b/i.test(prose)) return { addressed: true, unparsed: false };
  return { addressed: true, unparsed: true };
}

const say = (v) => (v.addressed ? "PASS" : "fail") + (v.unparsed ? " (unread)" : "        ");

console.log("\nu1 — the verdict that was read as its own opposite\n");

console.log("   A judge that means NO, in the words a 27B actually writes:\n");
console.log("      reply                              BEFORE            NOW");
console.log("      ─────────────────────────────────  ───────────────   ───────────────");

const NEGATIVES = [
  "VERDICT: UNADDRESSED",
  "VERDICT: Unaddressed",
  "**VERDICT:** UNADDRESSED",
  "> verdict : unaddressed",
  "UNADDRESSED — it answered a different question.",
];
for (const reply of NEGATIVES) {
  const b = beforeParse(reply);
  const n = parseJudgeVerdict(reply);
  console.log(`      ${JSON.stringify(reply).slice(0, 33).padEnd(33)}  ${say(b)}   ${say(n)}`);
}
console.log("");
for (const reply of NEGATIVES) {
  check(`${JSON.stringify(reply).slice(0, 40)} reads as a fail`, parseJudgeVerdict(reply).addressed === false);
}

console.log(`
   The second column is the whole finding. "unread" is the fail-open path and it
   is REPORTED — verificationNote("unparsed") tells the parent the answer went
   out unchecked. None of the rows above took it. They were parsed, with
   unparsed:false, as a PASS, so record.verification is "passed" and the answer
   reaches the parent model with no annotation of any kind.
`);

console.log("   The controls — a fix must not buy the rows above with these:\n");
console.log("      reply                                       BEFORE   NOW");
console.log("      ──────────────────────────────────────────  ──────   ──────");
const CONTROLS = [
  ["VERDICT: ADDRESSED", true],
  ["VERDICT:ADDRESSED", true],
  ["**VERDICT:** ADDRESSED", true],
  ["> verdict : addressed", true],
  ["VERDICT: _ADDRESSED_", true],
  ["VERDICT: ADDRESSED\nWHY: nothing was left unaddressed.", true],
  ["VERDICT: NOT_ADDRESSED", false],
  ["verdict: not addressed", false],
  ["NOT-ADDRESSED — a different question", false],
];
for (const [reply, want] of CONTROLS) {
  const b = beforeParse(reply);
  const n = parseJudgeVerdict(reply);
  const label = JSON.stringify(reply).replace(/\\n.*$/, '…"').padEnd(42);
  console.log(`      ${label}  ${b.addressed ? "PASS" : "fail"}     ${n.addressed ? "PASS" : "fail"}`);
}
console.log("");
for (const [reply, want] of CONTROLS) {
  check(
    `control ${JSON.stringify(reply).replace(/\\n.*$/, '…"')} is unchanged`,
    parseJudgeVerdict(reply).addressed === want && beforeParse(reply).addressed === want,
  );
}

console.log(`
   Row 5 is the one the thirteenth pass was protecting. \`VERDICT: _ADDRESSED_\`
   is an italicised verdict; the VERDICT-line value arrives with its markdown
   still attached, and \`_\` is a WORD CHARACTER, so \\bADDRESSED\\b does not match
   inside it. Adding \\b — the fix that decision named and declined — really would
   have broken it. Widening the negative alternation to (?:NOT[_\\s-]?|UN) does
   not touch the positive test at all.

   Pinned by tests/verify.test.ts's AH2 block, whose control assertion is that
   same row.
`);

// ── AH5 — the same file, the same reader ────────────────────────────────────
console.log("   AH5 — the note the parent is handed when the check failed:\n");
console.log("      SUBAGENT_VERIFY_ROUNDS   the sentence, BEFORE and NOW");
console.log("      ──────────────────────   ───────────────────────────────────────────────");
for (const n of [0, 1, 2]) {
  const now = verificationNote("failed", n).replace(/^\n+|\]$/g, "").replace(/^\[verification: /, "");
  console.log(`      ${String(n).padEnd(22)}   ${now}`);
}
check(
  "at 0 rounds it no longer claims corrections that were never attempted",
  /no attempt was made/.test(verificationNote("failed", 0)) && !/corrections were no better/.test(verificationNote("failed", 0)),
);
check("at 1 round it still says why the original was kept", /corrections were no better/.test(verificationNote("failed", 1)));
check("and at 2", /corrections were no better/.test(verificationNote("failed", 2)));

console.log(`
   BEFORE, the 0 row read "…and no attempt was made to correct it. This is the
   agent's original answer, kept because the corrections were no better." —
   \`describeAttempts\` was made count-aware in the seventh pass (W5) and the clause
   after it was not. \`SUBAGENT_VERIFY_ROUNDS=0\` is a value \`clampRounds\` accepts
   and \`resolveVerifyRounds\` documents, and it means "judge, do not repair" — a
   defensible setting on a one-slot server.

   These sentences are the verifier's ONLY channel to the parent model, which is
   the reason \`describeAttempts\` spells small counts out in words at all.
`);

console.log(failures > 0 ? `   ${failures} expectation(s) failed` : "   all expectations held");
process.exit(failures > 0 ? 1 : 0);
