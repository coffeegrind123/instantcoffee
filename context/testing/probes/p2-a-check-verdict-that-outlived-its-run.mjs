/**
 * p2 — AC2. A goal-check verdict, and a goal-check error streak, that outlive the
 * run that earned them.
 *
 * V3 gave `/loop run` a `resetCheckState()` and deliberately left `/loop resume`
 * alone, on a reason that is correct as far as it goes: **a resumed run IS the
 * same run**, so its verdict, its score and its best-so-far belong to it.
 *
 * Two of those fields are not "state of this run" though, and both were carried:
 *
 *   lastCheckPassed   In `--until-done`, `true` can exist for exactly as long as
 *                     it takes `agent_end` to reach the next line — the branch
 *                     above completes the run on the same condition. So the only
 *                     way to observe one is to resume a run that already
 *                     finished, and then the FIRST `LOOP_DONE:` completes the new
 *                     run on a verdict the check has not given since. That is the
 *                     precise thing the `lastCheckPassed !== true` guard was
 *                     added for: "the check decides" must not degrade into "the
 *                     model decides when the check is broken".
 *
 *   checkErrorStreak  `pauseForCheckFailure` stops the run at MAX_CHECK_ERRORS
 *                     and says "Fix or change the check, then /loop resume". The
 *                     count that stopped the operator was handed straight back,
 *                     so the next unrunnable check was the FOURTH in a row and
 *                     re-paused the run at once — printing "could not run (4/3)",
 *                     a counter past its own maximum. `providerErrorStreak` is
 *                     cleared on resume for exactly this reason, with the reason
 *                     written beside it; this one was left out of it.
 *
 * Both modes drive the SHIPPED loop extension through `_host.mjs`. One mode per
 * process, because the loop's state is module-global.
 *
 *   node --experimental-strip-types p2-a-check-verdict-that-outlived-its-run.mjs verdict
 *   node --experimental-strip-types p2-a-check-verdict-that-outlived-its-run.mjs streak
 *   node --experimental-strip-types p2-a-check-verdict-that-outlived-its-run.mjs control
 */

import { REPO, makeHost, execResult, statusLines } from "./_host.mjs";

const ext = (await import(`${REPO}/vendor/pi-loop-mode/extensions/index.ts`)).default;
const MODE = process.argv[2] ?? "verdict";

let failures = 0;
const check = (label, ok) => {
  console.log(`   ${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) failures++;
};

/** A check that can break between runs, which is the whole scenario. */
let checkState = "passes";
const exec = async () =>
  checkState === "passes"
    ? execResult({ code: 0, stdout: "all green" })
    : // An OOM kill: a signalled child, so no marker, and pi calls it exit code 0.
      execResult({ code: 0, stdout: "", completed: false });

const host = makeHost({ exec });
ext(host.pi);

const status = async () => statusLines(await host.run("status"), /Active|^Status|Check status/);

if (MODE === "verdict" || MODE === "control") {
  const restart = MODE === "verdict" ? "resume" : "run";
  console.log(`AC2 — a passing verdict from a run that ended, then /loop ${restart}\n`);

  await host.run('start ship it --check "cargo test" --until-done');
  await host.turn({ messages: ["did a batch"] });
  console.log("run 1 — the check passes and the run completes:");
  console.log(await status());
  check("premise: run 1 completed on the check", /Status: completed/.test(await host.run("status")));

  // The check now dies the way a check dies on this box.
  checkState = "killed";
  console.log(`\nrun 2 — /loop ${restart}, and the check is now reaped by the OOM killer:`);
  console.log(`   ${await host.run(restart)}`);
  const notice = await host.turn({ messages: ["LOOP_DONE: shipped it"] });
  console.log(`   turn: ${notice.split(" | ").map((n) => n.slice(0, 96)).join("\n         ")}`);
  console.log(await status());

  const finalStatus = await host.run("status");
  if (MODE === "verdict") {
    check("the run is still active — a verdict from run 1 cannot end run 2", /Active: true/.test(finalStatus));
    check("and it is not reported as completed", !/Status: completed/.test(finalStatus));
    check("the model is told the CHECK is the work", /could not be run/i.test(notice));
  } else {
    // The control: `/loop run` resets the whole check state (V3), so this path
    // was always right and must stay right.
    check("control — /loop run drops the verdict outright", /Active: true/.test(finalStatus));
    check("control — and nothing claims it is passing", !/passing/.test(finalStatus));
  }
  await host.quit();
} else if (MODE === "streak") {
  console.log("AC2 — the error streak that survived the pause it caused\n");
  checkState = "killed";
  await host.run('start ship it --check "cargo test" --until-done');
  for (let i = 1; i <= 3; i++) {
    const notice = await host.turn({ messages: [`batch ${i}`] });
    console.log(`   turn ${i}: ${notice.split(" | ")[0].slice(0, 90)}`);
  }
  console.log(await status());
  check("premise: MAX_CHECK_ERRORS stopped the run", /Status: paused/.test(await host.run("status")));

  console.log("\nthe operator fixes the check and resumes — then one more hiccup:");
  console.log(`   ${await host.run("resume")}`);
  const notice = await host.turn({ messages: ["batch 4"] });
  console.log(`   turn 4: ${notice.split(" | ")[0].slice(0, 90)}`);
  console.log(await status());

  check("the streak restarts at 1/3, not 4/3", /\(1\/3\)/.test(notice) && !/\(4\/3\)/.test(notice));
  check("one hiccup after a resume does not re-pause the run", !/Status: paused/.test(await host.run("status")));
  await host.quit();
} else {
  console.log(`unknown mode ${MODE}`);
  process.exit(2);
}

console.log(`\n${failures === 0 ? "all expectations met" : `${failures} expectation(s) unmet`}`);
process.exit(failures === 0 ? 0 : 1);
