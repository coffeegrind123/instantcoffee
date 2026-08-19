/**
 * n2 — AA2. `pi.exec` never rejects, so the branch that tells "the check could
 * not RUN" from "the check ran and FAILED" is unreachable — and a check that
 * TIMED OUT comes back as exit code 0, which the loop reads as a pass.
 *
 * U3 is the fifth pass's finding: a check that could not run was recorded as one
 * that failed, and the repair was `CheckOutcome.execFailed`, set here:
 *
 *   runGoalCheck()                       extensions/index.ts:857
 *     try   { const result = await pi.exec("bash", …); … execFailed: false }
 *     catch { … execFailed: true }
 *
 * with `goal-check.ts` documenting the trigger as *"`execFailed` is true when
 * `pi.exec` rejects, i.e. a timeout against `checkTimeoutSeconds`, a missing
 * interpreter, a spawn failure"*.
 *
 * pi's `exec` does none of those things. `ExtensionAPI.exec` (loader.js:287) is
 * `execCommand` (core/exec.js), and `execCommand` is a `new Promise((resolve) =>
 * …)` with **no reject in the body at all**:
 *
 *   timeout        → killProcess() → SIGTERM → exit(code=null, signal) →
 *                    resolve({…, code: null ?? 0, killed: true})   ← code ZERO
 *   spawn error    → waitForChildProcess rejects → .catch → resolve({…, code: 1})
 *   non-zero exit  → resolve({…, code: n})
 *
 * So every failure mode the docstring names arrives as a RESOLVED result,
 * `execFailed` stays false, and `checkErrorStreak` never advances, so
 * `MAX_CHECK_ERRORS` never fires. Worse than that: `runGoalCheck` reads
 * `passed: result.code === 0`, so a check that hung and was killed is a check
 * that PASSED — and in `--until-done` mode that is the run's only terminating
 * condition.
 *
 * The one signal pi does hand back — `killed` — is not read by anything in the
 * tree, and `_host.mjs`'s own `exec` stub does not even have the field.
 *
 *   node --experimental-strip-types n2-the-check-that-cannot-run-still-reads-as-failing.mjs
 */

const PI = "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist";
const { execCommand } = await import(`${PI}/core/exec.js`);
const { makeHost } = await import("./_host.mjs");
const loopExtension = (await import("../../../vendor/pi-loop-mode/extensions/index.ts")).default;
const { applyCheckOutcome } = await import("../../../vendor/pi-loop-mode/src/goal-check.ts");

// ── part 1: pi's real exec, on the three failures the docstring names ────────

async function probe(label, run) {
  try {
    const result = await run();
    return { label, settled: "RESOLVED", result };
  } catch (error) {
    return { label, settled: "REJECTED", result: String(error) };
  }
}

const cases = [
  await probe("a binary that does not exist", () =>
    execCommand("definitely-not-a-real-binary-9x8", [], process.cwd(), { timeout: 5_000 })),
  await probe("a command that outlives its timeout", () =>
    execCommand("bash", ["-lc", "sleep 5"], process.cwd(), { timeout: 400 })),
  await probe("a check script that is missing", () =>
    execCommand("bash", ["-lc", "./no-such-check.sh"], process.cwd(), { timeout: 5_000 })),
  await probe("control — a check that genuinely fails", () =>
    execCommand("bash", ["-lc", "echo 'tests: 3 failed' >&2; exit 1"], process.cwd(), { timeout: 5_000 })),
  await probe("control — a check that passes", () =>
    execCommand("bash", ["-lc", "echo 'SCORE: 90'"], process.cwd(), { timeout: 5_000 })),
];

console.log("=".repeat(84));
console.log("pi 0.84.2 — what `pi.exec` does with each failure `goal-check.ts` names");
console.log("=".repeat(84));
console.log(`  ${"case".padEnd(38)} ${"settled".padEnd(9)} code  killed  → execFailed?`);
console.log("  " + "-".repeat(80));
for (const c of cases) {
  const r = c.result;
  const code = typeof r === "object" ? String(r.code) : "-";
  const killed = typeof r === "object" ? String(r.killed) : "-";
  // runGoalCheck's catch is the ONLY writer of execFailed.
  const execFailed = c.settled === "REJECTED" ? "true" : "false";
  console.log(`  ${c.label.padEnd(38)} ${c.settled.padEnd(9)} ${code.padEnd(5)} ${killed.padEnd(7)} ${execFailed}`);
}
console.log(`
  Nothing rejects, so \`execFailed\` is false on every row and U3's whole branch is
  unreachable. Read the timeout row again: a process killed by SIGTERM exits with
  a SIGNAL and no code, \`waitForChildProcess\` resolves \`null\`, and execCommand
  does \`code: code ?? 0\`. **A check that timed out comes back as code 0.**
  \`killed: true\` is the only field that says otherwise, and nothing in the tree
  reads it — \`_host.mjs\`'s own exec stub does not even have the field.
`);

// ── part 2: what the loop then tells the model ──────────────────────────────

/** The state a run reaches after N consecutive checks, given how each one resolved. */
function afterChecks(outcomes) {
  const state = {
    iterationCount: 0,
    lastCheckPassed: undefined,
    lastCheckScore: undefined,
    bestCheckScore: undefined,
    bestScoreIteration: 0,
    checkFailStreak: 0,
    lastCheckOutput: "",
    checkErrorStreak: 0,
    lastCheckError: "",
    lastStateChangeIteration: 0,
  };
  for (const outcome of outcomes) {
    state.iterationCount++;
    applyCheckOutcome(state, outcome);
  }
  return state;
}

// A timeout resolves {code: 0, killed: true}, and runGoalCheck reads
// `passed: result.code === 0`.
const timedOutNow = { passed: true, score: undefined, output: "", execFailed: false };
// What the same event would be if `killed` were read.
const timedOutHonest = { passed: false, score: undefined, output: "killed after 1s", execFailed: true };
// A missing check script (code 127) — the other half of "could not run".
const missingNow = { passed: false, score: undefined, output: "no-such-check.sh: command not found", execFailed: false };

console.log("=".repeat(84));
console.log("three checks in a row that TIMED OUT — what the loop's state says");
console.log("=".repeat(84));
const row = (label, s) =>
  console.log(
    `  ${label.padEnd(40)} lastCheckPassed=${String(s.lastCheckPassed).padEnd(9)}` +
      ` failStreak=${String(s.checkFailStreak).padEnd(3)} errorStreak=${s.checkErrorStreak}`,
  );
row("NOW  (code 0, killed ignored)", afterChecks([timedOutNow, timedOutNow, timedOutNow]));
row("IF   (killed read as could-not-run)", afterChecks([timedOutHonest, timedOutHonest, timedOutHonest]));
row("control — a check script that is missing", afterChecks([missingNow, missingNow, missingNow]));

console.log(`
  The first row is not "reported as failing" — it is reported as **PASSING**.
  \`lastCheckPassed = true\` is the one thing \`--until-done\` waits for, so the very
  first LOOP_DONE after it completes the run, and the guard added precisely so
  "the check decides" cannot mean "the model decides when the check is broken"
  has nothing left to hold.

  The second row is what U3's machinery was built to do: MAX_CHECK_ERRORS is 3
  and it is charged against errorStreak, so it pauses and tells the operator the
  CHECK is what needs fixing.

  The third row is the other half — a check that cannot run because its script is
  gone reads as a project that is failing, with the shell's "command not found"
  handed to the model as "fix exactly what the check reports".
`);

// ── part 3: the loop, driven end to end with pi's real exec ─────────────────

const host = makeHost({ percent: 20, exec: (cmd, args, options) => execCommand(cmd, args, process.cwd(), options) });
loopExtension(host.pi, host.ctx);

await host.run('start ship it --check "sleep 5" --check-timeout 1 --until-done');
for (let i = 0; i < 3; i++) {
  await host.turn({ messages: [{ text: `progress batch ${i + 1}` }], tools: [{ toolName: "edit", content: [{ type: "text", text: "written" }] }] });
}
const status = await host.run("status");
await host.quit();

console.log("=".repeat(84));
console.log("the shipped loop, three iterations, real pi.exec, `--check \"sleep 5\" --check-timeout 1`");
console.log("=".repeat(84));
for (const line of status.split("\n")) console.log(`  ${line}`);
console.log(`
  The check never once ran to completion. \`--until-done\` completed on iteration 1
  on the strength of it, and the status line calls the project passing.
`);

process.exit(0);
