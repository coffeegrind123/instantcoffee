/**
 * k5 — W5. Every note the verifier can append, at every round budget it can run.
 *
 * `verificationNote` is the only channel the verifier has to the PARENT MODEL,
 * and that file's own comment says why the wording is not decoration:
 *
 *   > English for a small count, so the note reads like a sentence rather than a
 *   > log line. The parent model reads this text, and "1 attempts" is the kind of
 *   > thing it copies into its own answer.
 *
 * `describeAttempts` does that for the `failed` note. Two others built their own
 * count and got it wrong in opposite directions: `repaired` interpolated
 * `${attempts}th`, correct only from four upwards while MAX_VERIFY_ROUNDS is 3,
 * and `stalled` hardcoded "a third time", correct only at the default budget of
 * one round. Both are reachable with `SUBAGENT_VERIFY_ROUNDS=2` or `3`.
 *
 * FIXED: one `describeOrdinal` helper, used by both; `unparsed` says the first
 * answer failed when a repair preceded it; and the `attempts` parameter now
 * defaults to 0 rather than to asserting a repair that may not have happened.
 *
 *   run:  node --experimental-strip-types k5-verification-notes-the-parent-reads.mjs
 */

import { verificationNote } from "/home/claudeuser/qwen3.8-forge/vendor/pi-subagents-lite/src/agents/verify.ts";
import { DEFAULT_VERIFY_ROUNDS, MAX_VERIFY_ROUNDS, resolveVerifyRounds } from "/home/claudeuser/qwen3.8-forge/vendor/pi-subagents-lite/src/agents/verify-runner.ts";

console.log("\n=== k5 — the notes the parent model reads ===\n");
console.log(`  DEFAULT_VERIFY_ROUNDS ${DEFAULT_VERIFY_ROUNDS}   MAX_VERIFY_ROUNDS ${MAX_VERIFY_ROUNDS}`);
console.log(`  SUBAGENT_VERIFY_ROUNDS="2" resolves to ${resolveVerifyRounds("2")}, "3" to ${resolveVerifyRounds("3")}, "9" to ${resolveVerifyRounds("9")}\n`);

const clean = (s) => s.trim().replace(/\s+/g, " ");

for (const kind of ["repaired", "failed"]) {
  console.log(`  ${kind}:`);
  for (const attempts of [0, 1, 2, 3]) {
    const text = clean(verificationNote(kind, attempts));
    const bad = /\b\d+th\b/.test(text) && !/\b(4|5|6|7|8|9|1[0-9])th\b/.test(text);
    console.log(`    attempts ${attempts}  ${bad ? "<-- " : "    "}${text}`);
  }
  console.log();
}
console.log("  stalled:");
for (const attempts of [1, 2, 3]) {
  console.log(`    attempts ${attempts}      ${clean(verificationNote("stalled", attempts))}`);
}
console.log("\n  unparsed:");
for (const attempts of [0, 1]) {
  console.log(`    attempts ${attempts}      ${clean(verificationNote("unparsed", attempts))}`);
}
console.log(`\n  errored:\n    ${clean(verificationNote("errored"))}\n`);
console.log("  BEFORE, at the budgets that reach these branches:\n");
console.log('    repaired  attempts 2  "…this is the 2th attempt, and it was re-checked."');
console.log('    repaired  attempts 3  "…this is the 3th attempt, and it was re-checked."');
console.log('    stalled   attempts 2  "…so it was not asked a third time."   (four asks had happened)');
console.log('    stalled   attempts 3  "…so it was not asked a third time."   (five)');
console.log('    unparsed  after a repair  "the check could not be read, so this answer went out');
console.log('                               unchecked."  — and the answer it labels IS the repair,');
console.log("                               with no record that the first one failed.\n");
console.log("  `stalled` counts asks, not attempts: the task is the first ask and each repair is");
console.log("  one more, so the ask NOT made is attempts + 2. At the default budget that is the");
console.log("  third, which is why the hardcoded sentence was invisible.\n");
