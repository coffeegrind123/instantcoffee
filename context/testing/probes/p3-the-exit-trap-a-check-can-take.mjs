/**
 * p3 — AC3. The EXIT trap is one slot, and an ordinary check command can take it.
 *
 * AB1's whole mechanism is "did bash reach its own exit", answered by a
 * `trap … EXIT` that prints a marker, because pi's `ExecResult` cannot answer it:
 * `waitForChildProcess` resolves the exit CODE and drops the signal, and
 * `execCommand` does `code: code ?? 0`, so a SIGKILLed check arrives in the exact
 * shape of one that passed.
 *
 * A bash EXIT trap is a SLOT, not a stack. A second `trap … EXIT` replaces the
 * first, and `exec` discards traps altogether. So two things a check command does
 * every day removed the marker from a check that had run perfectly — and the loop
 * reads a missing marker as "the check process died before it finished — killed
 * by a signal rather than by its own exit (an out-of-memory kill looks like
 * this)". Three of those in a row pause an unattended run, and in `--until-done`
 * the terminating condition disappears meanwhile.
 *
 * `trap 'docker compose down' EXIT; docker compose run tests` is not a contrived
 * `--check`; it is the shape of every cleanup one-liner. And `/loop prepare` asks
 * a strong model to WRITE the check script.
 *
 * The repair is a subshell: a trap set inside `( … )` belongs to the subshell and
 * cannot touch ours, `exec` replaces the subshell, and the exit status still
 * propagates — so `result.code`, the `SCORE:` line and multi-line commands are
 * all unchanged. The one observable difference is a line number in a syntax
 * error.
 *
 * Both columns call pi's **real** `execCommand`, and BEFORE is the eleventh
 * pass's wrapper restated rather than remembered.
 *
 *   run: node --experimental-strip-types p3-the-exit-trap-a-check-can-take.mjs
 */

import { CHECK_COMPLETION_MARKER, readCheckCompletion, wrapCheckCommand } from "/home/claudeuser/qwen3.8-forge/vendor/pi-loop-mode/src/goal-check.ts";

const PI = "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist";
const { execCommand } = await import(`${PI}/core/exec.js`);

let failures = 0;
const check = (label, ok) => {
  console.log(`   ${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) failures++;
};

/** The eleventh pass's wrapper, verbatim: the trap, then the command, one shell. */
const wrapBefore = (command) =>
  `trap 'printf "\\n${CHECK_COMPLETION_MARKER}:%d\\n" "$?"' EXIT\n${command}`;

/** What `runGoalCheck` decides, given what pi's execCommand hands back. */
async function verdictOf(script) {
  const result = await execCommand("bash", ["-lc", script], process.cwd(), { timeout: 5_000 });
  const combined = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
  const { completed, text } = readCheckCompletion(combined);
  const verdict = result.killed
    ? "could-not-run"
    : !completed
      ? "COULD-NOT-RUN"
      : result.code === 0
        ? "passed"
        : "failed";
  return { code: result.code, killed: result.killed, completed, text, verdict };
}

const CASES = [
  ["a check that passes", "true", "passed"],
  ["a check that fails", "exit 1", "failed"],
  ["a check with its OWN EXIT trap", "trap 'echo cleaning up' EXIT; true", "passed"],
  ["…and one that fails under its trap", "trap 'rm -f /tmp/nothing' EXIT; exit 2", "failed"],
  ["a check that execs", "exec true", "passed"],
  ["an OOM kill — the case AB1 is FOR", "kill -9 $$", "COULD-NOT-RUN"],
  ["a check that prints a SCORE", "echo 'SCORE: 90'", "passed"],
  ["a multi-line check", "echo one\necho two", "passed"],
  ["a syntax error", "echo 'oops", "failed"],
];

console.log("AC3 — what the loop decides about a check, before and after the subshell\n");
console.log("case                                   BEFORE          NOW             expected");
console.log("-".repeat(84));

for (const [label, command, expected] of CASES) {
  const before = await verdictOf(wrapBefore(command));
  const now = await verdictOf(wrapCheckCommand(command));
  const flag = before.verdict === now.verdict ? " " : "←";
  console.log(
    `${label.padEnd(38)}${before.verdict.padEnd(16)}${now.verdict.padEnd(16)}${expected} ${flag}`,
  );
  if (now.verdict !== expected) failures++;
}

console.log("\nthe three rows that moved, and what each one costs an unattended run");
{
  const trap = await verdictOf(wrapBefore("trap 'echo cleaning up' EXIT; true"));
  check("BEFORE: a passing check under its own cleanup trap read as a DEAD check", trap.verdict === "COULD-NOT-RUN");
  const fixed = await verdictOf(wrapCheckCommand("trap 'echo cleaning up' EXIT; exit 2"));
  check("NOW: it runs, and its exit code is still the check's answer", fixed.completed && fixed.code === 2);
  check("NOW: and the check's own cleanup still happens", /cleaning up/.test(fixed.text));
  const execd = await verdictOf(wrapCheckCommand("exec true"));
  check("NOW: exec replaces the subshell, not the shell holding the marker", execd.completed);
}

console.log("\ncontrols — the case the marker exists for, and everything the loop parses");
{
  const killed = await verdictOf(wrapCheckCommand("kill -9 $$"));
  check("a SIGKILLed check is still unrunnable", killed.completed === false);
  const scored = await verdictOf(wrapCheckCommand("echo 'SCORE: 90'"));
  check("the marker still does not displace the SCORE the loop reads", scored.text === "SCORE: 90");
  const multi = await verdictOf(wrapCheckCommand("echo one\necho two"));
  check("a multi-line check is unchanged", multi.text === "one\ntwo");
  const broken = await verdictOf(wrapCheckCommand("echo 'oops"));
  check("a syntax error is still a failure, not a pass", broken.completed && broken.code !== 0);
  const timeout = await execCommand("bash", ["-lc", wrapCheckCommand("sleep 5")], process.cwd(), { timeout: 300 });
  check("pi's own timeout still sets killed, which is tested first", timeout.killed === true);
}

console.log(`\n${failures === 0 ? "all expectations met" : `${failures} expectation(s) unmet`}`);
process.exit(failures === 0 ? 0 : 1);
