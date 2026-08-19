/**
 * I3 probe — U3 (**FIXED**): a goal check that CANNOT RUN used to be recorded,
 * reported and acted on as a goal check that RAN AND FAILED.
 *
 * **Tenth-pass correction (AA2): this probe's `throws` mode drives a shape pi
 * cannot produce.** `pi.exec` is `execCommand` (pi `core/exec.js`), a
 * `new Promise((resolve) => …)` with no `reject` in the body — so the rejection
 * this mode feeds the loop never happened in a real session, and U3's whole
 * branch was unreachable for two passes. It is reachable now because
 * `runGoalCheck` sets `execFailed` from `result.killed` instead. Run
 * `n2-the-check-that-cannot-run-still-reads-as-failing.mjs` for what pi really
 * returns; this probe is still the account of what the loop DOES with the
 * distinction once it has it.
 *
 * `runGoalCheck()` always distinguished the two — it returns `execFailed: true`
 * when the check did not run to completion (a timeout against
 * `checkTimeoutSeconds`, or a stale extension runtime) — and exactly one line
 * used to consume the distinction:
 *
 *     if (outcome.execFailed) ctx.ui.notify(`Loop: goal check could not run: …`)
 *
 * an operator-facing warning. Everything after it treated the outcome as a
 * failure: `applyCheckOutcome()` set `lastCheckPassed = false` and incremented
 * `checkFailStreak`; `--until-done` refused the LOOP_DONE marker; and the
 * `check_failed` directive told the model "Completion is decided by the check,
 * not by your claim. Fix exactly what the check reports" — where "what the check
 * reports" was `state.lastCheckOutput`, which on this path was the exec error.
 * The model was never told the check did not run; it was told the check failed,
 * shown a spawn error as the failure, and asked to fix it.
 *
 * In `--until-done` mode the consequence was that the loop's terminating
 * condition was gone: a broken check silently converted the one mode that can
 * finish into one that cannot.
 *
 * Now an unrunnable check leaves the check state at its last real value and is
 * counted separately (`checkErrorStreak` / `lastCheckError`), the model is told
 * that the CHECK is the work, the loop still refuses to complete on a claim it
 * cannot verify, and three in a row pause it for a human.
 *
 * Run one mode per process:
 *   node --experimental-strip-types i3-check-that-cannot-run.mjs throws   (cannot run)
 *   node --experimental-strip-types i3-check-that-cannot-run.mjs fails    (ran, exit 1)
 *   node --experimental-strip-types i3-check-that-cannot-run.mjs passes   (control)
 */

import { REPO, makeHost, statusLines } from "./_host.mjs";

const ext = (await import(`${REPO}/vendor/pi-loop-mode/extensions/index.ts`)).default;
const MODE = process.argv[2] ?? "throws";

const EXEC = {
  // The shape a `checkTimeoutSeconds` timeout or a spawn failure takes.
  throws: async () => { throw new Error("Command timed out after 120000ms"); },
  fails: async () => ({ code: 1, stdout: "2 tests failed\n", stderr: "" }),
  passes: async () => ({ code: 0, stdout: "ok\n", stderr: "" }),
};

const host = makeHost({ percent: 20, exec: EXEC[MODE] });
ext(host.pi);
await host.run('start make the suite green. Done when: the check passes --until-done --check "./check.sh"');

console.log(`=== I3 · MODE=${MODE} ===`);
console.log("Mode: --until-done, --check ./check.sh. The model reports LOOP_DONE every turn.\n");

// Three genuinely different sentences: near-identical ones would (correctly)
// trip the stuck ladder, and this probe is about the check, not about that.
const DONE_TEXTS = [
  "LOOP_DONE: the parser handles every fixture and the suite is green.",
  "LOOP_DONE: rewrote the tokenizer to stream; nothing else moved.",
  "LOOP_DONE: added a ragged-row fixture and taught the reader to skip them.",
];
for (let i = 0; i < 3; i++) {
  const text = DONE_TEXTS[i];
  const notice = await host.turn({
    messages: [text],
    // A different edit each turn, so the tool-signature rule (a separate finding)
    // cannot account for anything printed here.
    tools: [{ toolName: "edit", content: [{ type: "text", text: `edited src/stage-${i}.ts` }], isError: false }],
  });
  console.log(`  turn ${i + 1}: ${notice}`);
  const injected = host.sent.map((m) => String(m.content)).join("\n");
  const directive = injected.split("\n").find((l) => l.trim());
  const checkOutput = injected.match(/Check output:\s*(.*)/)?.[1];
  if (directive) console.log(`     -> next turn is told : ${directive.slice(0, 104)}…`);
  if (checkOutput) console.log(`     -> "what the check reports" is: ${JSON.stringify(checkOutput.slice(0, 80))}`);
}

console.log("\n" + statusLines(await host.run("status"), /^Active|^Status|Check status|Last notice/));

await host.quit();

console.log(`
NOW

  throws   "could not run (1/3)", then (2/3), then the loop PAUSES. \`/loop status\`
           says LAST KNOWN rather than "failing (streak 3)", and the directive
           tells the model the check itself is the work: "fix or replace
           ./check.sh so it runs and exits 0 when the goal is met". The loop still
           refuses to complete on the marker — "the check decides" cannot mean
           "the model decides when the check is broken" — but it stops asking
           after three, rather than running forever with no terminating condition.
  fails    Unchanged, and that is the control: a check that RAN and failed still
           refuses the marker, still reports \`failing (streak N)\`, and still
           hands the model its real output to fix.
  passes   Unchanged: the check decides completion and the loop stops.

BEFORE

  throws and fails were byte-for-byte the same everywhere it mattered — the same
  streak, the same status line, the same injected directive — and the only
  difference was one \`ctx.ui.notify\` the operator sees and the model does not.
  An unattended run has no operator watching, which is the point of an unattended
  run. "Check output: Error: Command timed out after 120000ms" was handed to the
  model as the thing to fix, and \`Active\` never went false.
`);
