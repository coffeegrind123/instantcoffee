import type { LoopState } from "./loop-state.ts";

export interface CheckOutcome {
  passed: boolean;
  score?: number;
  output: string;
  execFailed: boolean;
}

/**
 * How many consecutive checks may fail to RUN before the loop stops rather than
 * carrying on with an unmeasurable completion condition.
 *
 * Three, matching `CONTEXT_RECOVERY_ATTEMPTS`: the same shape of question (this
 * mechanism is not converging) gets the same shape of answer.
 */
export const MAX_CHECK_ERRORS = 3;

/**
 * Every field of `LoopState` that belongs to the goal check, back to the values
 * `defaultState()` gives them.
 *
 * Forge fork: it exists because `runLoop()` did not do this. That function is
 * what `/loop run` calls — "start it again" — and it enumerated twenty-five
 * fields to reset while six of the check's own were not among them:
 * `lastCheckPassed`, `checkFailStreak`, `lastCheckOutput`, `lastCheckScore`,
 * `bestCheckScore`, `bestScoreIteration`. (`/loop start` was never affected: it
 * goes through `applyGoalConfig`, which spreads `defaultState()`. `/loop resume`
 * is deliberately unaffected — a resumed run IS the same run.)
 *
 * Two things went wrong, both measured against the shipped module:
 *
 *   - **A regression that never happened.** Run 1 scored 90; run 2's first check
 *     scored 70 and was reported as a regression against a different run's best,
 *     with a directive naming an iteration number from that run: "the score
 *     dropped to 70 (best so far 90 at iteration 1) … find and fix the regression
 *     before doing anything else."
 *   - **A completion the check never authorised.** Run 1 passed and completed,
 *     leaving `lastCheckPassed = true`. With the check script then broken, run 2's
 *     first LOOP_DONE satisfied the `lastCheckPassed !== true` guard — the guard
 *     added precisely so "the check decides" cannot mean "the model decides when
 *     the check is broken" — and the loop completed on the model's word while its
 *     own status line read "passing — LAST KNOWN; the check has not run".
 *
 * One function so the next field added to the check cannot be missed, and so a
 * test can assert it against `defaultState()` rather than against a list.
 * See V3 in `context/design/subagents-loop-verifier-shapes.md`.
 */
export function resetCheckState(state: LoopState): void {
  state.lastCheckPassed = undefined;
  state.lastCheckScore = undefined;
  state.bestCheckScore = undefined;
  state.bestScoreIteration = 0;
  state.checkFailStreak = 0;
  state.lastCheckOutput = "";
  state.checkErrorStreak = 0;
  state.lastCheckError = "";
}

/**
 * The keys `resetCheckState` owns. Exported so a test can compare them against
 * `defaultState()` without restating the list a third time.
 */
export const CHECK_STATE_KEYS = [
  "lastCheckPassed",
  "lastCheckScore",
  "bestCheckScore",
  "bestScoreIteration",
  "checkFailStreak",
  "lastCheckOutput",
  "checkErrorStreak",
  "lastCheckError",
] as const satisfies readonly (keyof LoopState)[];

/**
 * Updates check state; returns true when the score regressed vs. the previous run.
 *
 * Forge fork: a check that **could not run** no longer counts as a check that
 * **ran and failed**.
 *
 * `runGoalCheck()` distinguishes the two — `execFailed` is true when the check
 * did not run to completion — and exactly one line used to consume the
 * distinction: an operator-facing `notify` the model never sees. Everything
 * after it treated the outcome as a failure, so:
 *
 *   - `/loop status` reported `failing (streak N)`, which is a claim about the
 *     project, when it was a claim about the check harness;
 *   - the `check_failed` directive told the model "Completion is decided by the
 *     check, not by your claim. Fix exactly what the check reports", with a
 *     spawn error in place of what the check reports;
 *   - and in `--until-done` mode the loop's ONLY terminating condition quietly
 *     stopped existing, on a loop designed never to stop on its own.
 *
 * An unrunnable check now leaves `lastCheckPassed`, `checkFailStreak`,
 * `lastCheckScore` and `lastCheckOutput` exactly as the last real run left them —
 * "last known", which is the honest reading — and records the failure separately
 * in `checkErrorStreak` / `lastCheckError`. The caller escalates on that streak;
 * see MAX_CHECK_ERRORS.
 *
 * **AA2 correction (tenth pass).** This paragraph used to say `execFailed` is
 * true "when `pi.exec` rejects". It never rejects — `execCommand` (pi
 * `core/exec.js`) is a `new Promise((resolve) => …)` with no `reject` in the
 * body — so for two passes this whole branch was unreachable, and a check killed
 * on its timeout came back `code: 0` (a signalled child exits with no code and
 * `execCommand` does `code: code ?? 0`), i.e. as a check that PASSED. The
 * trigger is now `result.killed`, which is what pi actually reports. See AA2 in
 * `context/design/subagents-loop-verifier-hosts.md`.
 */
export function applyCheckOutcome(state: LoopState, outcome: CheckOutcome): boolean {
  if (outcome.execFailed) {
    state.checkErrorStreak++;
    state.lastCheckError = outcome.output;
    return false;
  }

  state.checkErrorStreak = 0;
  state.lastCheckError = "";
  const previousScore = state.lastCheckScore;
  state.lastCheckPassed = outcome.passed;
  state.lastCheckOutput = outcome.output;
  state.checkFailStreak = outcome.passed ? 0 : state.checkFailStreak + 1;
  if (outcome.score !== undefined) {
    state.lastCheckScore = outcome.score;
    if (state.bestCheckScore === undefined || outcome.score > state.bestCheckScore) {
      state.bestCheckScore = outcome.score;
      state.bestScoreIteration = state.iterationCount;
      state.lastStateChangeIteration = state.iterationCount;
    }
  }
  return outcome.score !== undefined && previousScore !== undefined && outcome.score < previousScore;
}

/**
 * The marker a completed check prints on its way out, and the whole of how the
 * loop can tell a check that FINISHED from one that was killed.
 *
 * Forge fork, eleventh pass (AB1). AA2 replaced an unreachable `catch` with
 * `result.killed`, which is the right field — and it is only ever true when *pi*
 * did the killing, i.e. `checkTimeoutSeconds` elapsed or the caller's
 * `AbortSignal` fired (`core/exec.js`: `killProcess` has exactly those two
 * callers, and it is what sets `killed`). Every other way a check can die comes
 * back indistinguishable from success, because a signalled child exits with a
 * signal and **no code** and `execCommand` does `code: code ?? 0`:
 *
 * ```
 *   measured against pi 0.84.2's real execCommand
 *   bash -lc 'kill -9 $$'      → { code: 0, killed: false }   an OOM kill
 *   bash -lc 'kill -TERM $$'   → { code: 0, killed: false }   an external stop
 *   bash -lc 'kill -SEGV $$'   → { code: 0, killed: false }
 *   bash -lc 'exit 1'          → { code: 1, killed: false }   a real failure
 *   bash -lc 'sleep 5' (t=0.3) → { code: 0, killed: TRUE  }   pi's own timeout
 * ```
 *
 * `code === 0` is `passed`, so on this box — a 27B model, one llama slot, and a
 * kernel that OOM-kills under load — a `--check "cargo test"` reaped by the OOM
 * killer reads as a check that PASSED, which is the single terminating condition
 * an `--until-done` run has. That is AA2's damage restored by the layer under
 * AA2's fix.
 *
 * pi's `ExecResult` cannot answer this: `waitForChildProcess` resolves the exit
 * CODE and drops the signal, so there is no field to read. The answer has to
 * come from inside the child, so the check runs under a bash `EXIT` trap that
 * prints this marker. bash runs an `EXIT` trap on a normal exit, on `exit N`
 * from anywhere in the script, and on a SIGTERM it was given — and cannot run
 * one at all when it is SIGKILLed. So:
 *
 *     marker present  → bash reached its own exit, and `result.code` is the
 *                       check's real answer (127 included — see the note in
 *                       `runGoalCheck`, that decision is unchanged)
 *     marker absent   → the check process died without finishing. Not a failing
 *                       check; an absent one.
 *
 * The marker's VALUE is deliberately not used. `result.code` already agrees with
 * it on every case measured, and reading the exit code out of the child's own
 * stdout would make a check that prints attacker-controlled text able to choose
 * its own verdict. Presence is the only signal taken.
 *
 * A check whose own output contains this string can make a killed run look
 * complete. That is the residue, it is stated rather than guarded, and the token
 * is long and namespaced so it cannot be produced by accident.
 */
export const CHECK_COMPLETION_MARKER = "__PI_LOOP_CHECK_COMPLETED__";

/**
 * Matches the marker line the trap prints, anywhere in stdout or stderr.
 *
 * Built per call rather than held in a module constant: a `g` regex carries
 * `lastIndex` between `.test()` calls, and a shared one would answer `false`
 * every other time it was asked.
 */
function completionMarkerRe(): RegExp {
  return new RegExp(`\\n?${CHECK_COMPLETION_MARKER}:-?\\d+\\n?`, "g");
}

/**
 * Wrap a check command so a completed run says so.
 *
 * The trap is prepended on its OWN line, so a command with an unterminated quote
 * or a trailing backslash breaks exactly the way it broke before — the wrapper
 * cannot turn a syntax error into a different syntax error. `$?` is read inside
 * the trap so the marker carries the real status for a human reading the log,
 * even though the loop does not branch on it.
 *
 * ## The command runs in a SUBSHELL, and that is the whole of AC3's repair
 *
 * Twelfth pass. A bash `EXIT` trap is one slot, not a stack: a second
 * `trap … EXIT` REPLACES the first, and `exec` discards traps altogether. So the
 * eleventh pass's wrapper was defeated by two ordinary things a check command
 * does, and defeated in the worst direction — the marker went missing on a check
 * that had run perfectly, which reads as a check that DIED:
 *
 * ```
 *   measured against pi 0.84.2's real execCommand
 *                                     BARE                    IN A SUBSHELL
 *   trap 'echo cleaning up' EXIT; true   marker ABSENT  ✘     marker, code 0  ✔
 *   trap 'rm -f /tmp/x' EXIT; exit 2     marker ABSENT  ✘     marker, code 2  ✔
 *   exec ./run-tests.sh                  marker ABSENT  ✘     marker, code 0  ✔
 *   kill -9 $$   (the case AB1 is FOR)   marker ABSENT  ✔     marker ABSENT   ✔
 * ```
 *
 * `trap 'docker compose down' EXIT; docker compose run tests` is not an exotic
 * `--check`; it is the shape of every cleanup one-liner, and `/loop prepare`
 * asks a model to WRITE the check. Three of those in a row pause an unattended
 * run with "the check process died before it finished — killed by a signal (an
 * out-of-memory kill looks like this)", which is a confident sentence about a
 * thing that did not happen.
 *
 * The subshell fixes both: a trap set inside `( … )` belongs to the subshell and
 * cannot touch ours, `exec` replaces the subshell rather than the shell holding
 * the marker, and the exit status still propagates, so `result.code`, the
 * `SCORE:` line and multi-line commands are all unchanged. The one observable
 * difference is the line number in a syntax error (2 → 3); the message is the
 * same, and a broken check is still a broken check.
 */
export function wrapCheckCommand(command: string): string {
  return `trap 'printf "\\n${CHECK_COMPLETION_MARKER}:%d\\n" "$?"' EXIT\n(\n${command}\n)`;
}

/**
 * Split a wrapped check's combined output into "did bash finish" and the text a
 * human (or the model, through the `check_failed` directive) should see.
 *
 * Every occurrence is removed, not just the last: a check that spawns subshells
 * with their own `EXIT` traps inherits none of them — traps are not inherited —
 * but a check that re-`bash`es the wrapper would print two, and neither belongs
 * in the output.
 */
export function readCheckCompletion(output: string): { completed: boolean; text: string } {
  const stripped = output.replace(completionMarkerRe(), "\n");
  return { completed: stripped.length !== output.length, text: stripped.trim() };
}
