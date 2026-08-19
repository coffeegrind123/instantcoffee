/**
 * o1 — AB1. `result.killed` is pi's OWN kill, and a check killed by anything
 * else still reads as a check that PASSED.
 *
 * AA2 (tenth pass) replaced an unreachable `catch` with `result.killed`, which is
 * the right field to read and is not the whole question. `execCommand` sets
 * `killed` inside `killProcess()`, and `killProcess` has exactly two callers:
 *
 *   core/exec.js   options.signal → addEventListener("abort", killProcess)
 *   core/exec.js   options.timeout → setTimeout(killProcess, timeout)
 *
 * so it answers "did pi stop this", not "did this finish". Every other way a
 * check can die arrives at the caller looking like success, because Node reports
 * a signalled exit as `code === null`, `waitForChildProcess` resolves `null`, and
 * `execCommand` does `code: code ?? 0`:
 *
 *   runGoalCheck reads `passed: result.code === 0`.
 *
 * On this box that is not a curiosity. One llama slot, a 27B model, and a kernel
 * that OOM-kills under load: a `--check "cargo test"` reaped by the OOM killer
 * comes back `{ code: 0, killed: false }` and sets `lastCheckPassed = true`,
 * which is the single terminating condition an `--until-done` run has.
 *
 * pi has no field that can answer it — the signal is discarded before the caller
 * sees anything — so the fix takes the evidence from inside the child: the check
 * runs under a bash `EXIT` trap, and the marker's ABSENCE is the finding.
 *
 *   node --experimental-strip-types o1-the-check-that-was-killed-by-something-else.mjs
 */

const PI = "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist";
const { execCommand } = await import(`${PI}/core/exec.js`);
const { makeHost } = await import("./_host.mjs");
const loopExtension = (await import("../../../vendor/pi-loop-mode/extensions/index.ts")).default;
const { CHECK_COMPLETION_MARKER, readCheckCompletion, wrapCheckCommand } = await import(
  "../../../vendor/pi-loop-mode/src/goal-check.ts"
);

let failures = 0;
const expect = (ok, what) => {
  if (!ok) {
    failures++;
    console.log(`  !! ${what}`);
  }
};

// ── part 1: pi's real exec, on every way a check can die ────────────────────

const CASES = [
  ["self-SIGKILL — an OOM kill looks like this", "kill -9 $$", {}],
  ["self-SIGTERM — an external stop",            "kill -TERM $$", {}],
  ["output, then SIGKILL",                       "echo 'running 412 tests'; kill -9 $$", {}],
  ["control — a real failure",                   "exit 1", {}],
  ["control — a real pass",                      "echo 'SCORE: 90'", {}],
  ["control — pi's own timeout",                 "sleep 5", { timeout: 400 }],
];

console.log("=".repeat(88));
console.log("pi 0.84.2 — what execCommand reports for a check that DIED vs one that finished");
console.log("=".repeat(88));
console.log(`  ${"case".padEnd(42)} code  killed  marker   verdict BEFORE  verdict NOW`);
console.log("  " + "-".repeat(84));

for (const [label, command, options] of CASES) {
  const bare = await execCommand("bash", ["-lc", command], process.cwd(), options);
  const wrapped = await execCommand("bash", ["-lc", wrapCheckCommand(command)], process.cwd(), options);
  const { completed } = readCheckCompletion(`${wrapped.stdout}\n${wrapped.stderr}`);

  // BEFORE: killed → could-not-run, else code === 0 → passed.
  const before = bare.killed ? "could-not-run" : bare.code === 0 ? "PASSED" : "failed";
  // NOW: killed first, then the marker, then the code.
  const now = wrapped.killed ? "could-not-run" : !completed ? "could-not-run" : wrapped.code === 0 ? "PASSED" : "failed";

  console.log(
    `  ${label.padEnd(42)} ${String(bare.code).padEnd(5)} ${String(bare.killed).padEnd(7)}` +
      ` ${(completed ? "yes" : "ABSENT").padEnd(8)} ${before.padEnd(15)} ${now}`,
  );
}

console.log(`
  Rows 1–3 are the finding: pi calls all three exit code 0, which is
  indistinguishable from row 5. \`killed\` is false on every one of them, because
  pi did not do the killing. Only the missing marker separates them.

  Row 2 is worth reading twice. bash DOES run an EXIT trap when it is SIGTERMed,
  so the marker is present and this row is not caught by the marker — it is
  caught by nothing, and it is stated rather than guarded: the marker is proof of
  completion, and "the exit status after a signal" is not proof of anything. Row 6 shows why
  the order in runGoalCheck matters — a timeout is SIGTERM too, and \`killed\`
  catches it first with a better sentence.
`);

// ── part 2: the loop, end to end, against pi's real exec ────────────────────

const host = makeHost({
  percent: 20,
  exec: (cmd, args, options) => execCommand(cmd, args, process.cwd(), options),
});
loopExtension(host.pi, host.ctx);

// A check that is killed the way the OOM killer kills things.
await host.run('start ship it --check "kill -9 $$" --until-done');
await host.turn({ messages: [{ text: "LOOP_DONE: the feature is shipped." }], tools: [] });
const status = await host.run("status");
await host.quit();

console.log("=".repeat(88));
console.log("the shipped loop, --check \"kill -9 $$\" --until-done, one LOOP_DONE");
console.log("=".repeat(88));
console.log(status.split("\n").map((line) => `  ${line}`).join("\n"));

const active = /Active:\s*true/.test(status);
const completed = /Status:\s*completed/.test(status);
expect(active && !completed, "an --until-done run completed on a check that was killed");

console.log(`
  BEFORE   Active: false · Status: completed · Check status: passing
  NOW      Active: true  · the check reads as unrunnable, and three in a row
           pause the run

  The marker never reaches the operator or the model: \`readCheckCompletion\`
  strips every occurrence before the output is snippeted. Grep the status above
  for ${CHECK_COMPLETION_MARKER} — it is not there.
`);
expect(!status.includes(CHECK_COMPLETION_MARKER), "the completion marker leaked into the operator's status");

if (failures) {
  console.log(`FAILED: ${failures} expectation(s) — the fix is not in place.`);
  process.exit(1);
}
console.log("ok — every expectation held.");
