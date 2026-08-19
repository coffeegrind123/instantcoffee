/**
 * j3 — V3. `runLoop()` resets twenty-five fields of LoopState and skips seven
 *      pieces of per-run state, so `/loop run` starts a new run holding the
 *      previous run's verdict, streak, best score and cooldown count.
 *
 * Not reset:  lastCheckPassed · checkFailStreak · lastCheckOutput
 *             lastCheckScore  · bestCheckScore  · bestScoreIteration
 *             contextCooldownCount · contextCompressionLevel
 *             contextRecoveryCount
 * Reset:      checkErrorStreak · lastCheckError      (added by U3)
 *
 * `/loop start` is unaffected — it goes through applyGoalConfig, which spreads
 * defaultState(). `/loop resume` is deliberately unaffected — a resumed run IS
 * the same run. `/loop run` is the path that means "start it again" and does not.
 *
 * FIXED. `resetCheckState()` in src/goal-check.ts is called from `runLoop()`, with
 * the three context-ladder counters reset alongside it. One function, so the next
 * field added to the check cannot be missed, and a test compares it against
 * `defaultState()` rather than against a list.
 *
 *   node --experimental-strip-types j3-loop-run-keeps-the-old-check-state.mjs score
 *   node --experimental-strip-types j3-loop-run-keeps-the-old-check-state.mjs done
 */
import { makeHost, statusLines } from "./_host.mjs";
import loopExtension from "../../../vendor/pi-loop-mode/extensions/index.ts";

const mode = process.argv[2] ?? "score";

let script = [];
let call = 0;
const exec = async () => {
  const step = script[Math.min(call++, script.length - 1)];
  if (step.throws) throw new Error(step.throws);
  return { code: step.code, stdout: step.stdout ?? "", stderr: "" };
};

const host = makeHost({ exec });
loopExtension(host.pi);

const show = async (label) => {
  console.log(`  ${label}`);
  console.log(statusLines(await host.run("status"), /^(Active|Status|Iterations|Check status|Last notice)/));
};
const turn = (text) =>
  host.turn({ messages: [text], tools: [{ toolName: "read", content: [{ type: "text", text: "ok" }] }] });

if (mode === "score") {
  console.log("=== /loop run twice: run 1's score decides run 2's first iteration ===\n");
  script = [{ code: 1, stdout: "SCORE: 90" }];
  await host.run("goal improve the parser. Done when: score 100 --check ./check.sh");
  await host.run("run");
  await turn("Raised coverage on the tokenizer.");
  await show("run 1, iteration 1 — score 90, a new best");

  await host.run("stop");
  console.log("\n  --- the operator stops, then /loop run again on the same goal ---\n");

  script = [{ code: 1, stdout: "SCORE: 70" }];
  call = 0;
  await host.run("run");
  console.log("  run 2, iteration 1 notice:");
  console.log("    " + (await turn("Starting on the error recovery path.")));
  await show("run 2, iteration 1");
  console.log(`
BEFORE the fix

  run 2, iteration 1   Loop: goal check score regressed to 70 — requesting fix.
                       Check status: failing (streak 2), score 70 (best 90 @ iter 1)

  Nothing had regressed. The score was lower than a DIFFERENT run's last score,
  the streak counted one failure from each run, and the directive named an
  iteration number from the previous one: "the score dropped to 70 (best so far 90
  at iteration 1). A recent change made things worse. Inspect recent changes (git
  diff / git log), find and fix the regression before doing anything else."

NOW

  No notice, streak 1, best 70 @ iter 1. Run 2 starts with the check's state at
  its defaults. Run 1 above is the control — it was correct throughout, and
  \`/loop resume\` still keeps everything, because a resumed run IS the same run.`);
  await host.quit();
}

if (mode === "done") {
  console.log("=== /loop run twice in --until-done: a stale PASSING check completes run 2 ===\n");
  script = [{ code: 0, stdout: "all green" }];
  await host.run("goal ship the feature. Done when: tests pass --until-done --check ./check.sh");
  await host.run("run");
  await turn("Implemented it.");
  await show("run 1 finished — the check passed, so lastCheckPassed = true");

  console.log("\n  --- started again for more work; the check script is now broken ---\n");
  script = [{ throws: "Command timed out after 120000ms" }];
  call = 0;
  await host.run("run");
  console.log("  run 2, iteration 1 notices:");
  for (const line of (await turn("LOOP_DONE: nothing left to do.")).split(" | ")) console.log("    " + line);
  await show("run 2, iteration 1");
  console.log(`
BEFORE the fix

  run 2, iteration 1   Loop: goal check could not run (1/3): Error: Command timed out…
                       Loop completed: ship the feature
                       Active: false · Status: completed
                       Check status: passing — LAST KNOWN; the check has not run for 1/3 turns

  U3 made the LOOP_DONE guard \`lastCheckPassed !== true\` rather than \`=== false\`
  precisely so "the check decides" cannot become "the model decides when the check
  is broken". It held inside a run. Across /loop run it was satisfied by a verdict
  from a run that had already ended — and the status line said so, in the same
  breath.

NOW

  The loop keeps going and asks for the check to be fixed. \`Check status: -\` —
  no verdict, because none has been reached in this run. Run 1 above is the
  control: a check that runs and passes still completes the run it ran in.`);
  await host.quit();
}
process.exit(0);
