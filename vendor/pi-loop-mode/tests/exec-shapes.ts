/**
 * What pi's `execCommand` really resolves for a goal check, in one place.
 *
 * Every suite in this directory that drives the loop past `runGoalCheck` needs
 * an `exec` stub, and until the eleventh pass each one wrote its own
 * `{ code: 0, stdout: "", stderr: "" }`. That shape is not a lie about pi — it
 * is exactly what `execCommand` resolves for a check that passed silently — but
 * it is also exactly what `execCommand` resolves for a check the OOM killer
 * reaped, because `waitForChildProcess` resolves the exit CODE and drops the
 * signal and `execCommand` does `code: code ?? 0`. A stub that cannot tell the
 * two apart cannot fail when the module under test cannot either, which is AB1
 * and is the same shape as X1–X5: the harness models the host, and omits the one
 * thing under test.
 *
 * `runGoalCheck` now runs the check under a bash `EXIT` trap
 * (`wrapCheckCommand`), so the marker's PRESENCE is the evidence that bash
 * reached its own exit. These builders put it where bash would.
 *
 * Measured against pi 0.84.2's real `execCommand`, wrapped exactly as the module
 * wraps it (`context/testing/probes/o1-…`):
 *
 * ```
 *   bash -lc wrap('exit 0')       → code 0    killed false   marker present
 *   bash -lc wrap('exit 3')       → code 3    killed false   marker present
 *   bash -lc wrap('./missing')    → code 127  killed false   marker present
 *   bash -lc wrap('kill -9 $$')   → code 0    killed false   marker ABSENT
 *   bash -lc wrap('sleep 5') t=.3 → code 0    killed TRUE    marker present
 * ```
 */

import { CHECK_COMPLETION_MARKER } from "../src/goal-check.ts";

export type ExecResult = { code: number; stdout: string; stderr: string; killed: boolean };

/**
 * A check whose bash reached its own exit — the marker is on stdout, after
 * whatever the check itself printed, which is where the trap puts it.
 */
export function completedCheck(code: number, stdout = "", stderr = ""): ExecResult {
  return {
    code,
    stdout: `${stdout}\n${CHECK_COMPLETION_MARKER}:${code}\n`,
    stderr,
    killed: false,
  };
}

/**
 * A check whose process died without running its EXIT trap: SIGKILL, which is
 * what the OOM killer sends. pi reports success, and only the missing marker
 * says otherwise.
 */
export function signalledCheck(stdout = "", stderr = ""): ExecResult {
  return { code: 0, stdout, stderr, killed: false };
}

/** pi's own timeout: SIGTERM, so bash DOES print the marker, and `killed` is true. */
export function timedOutCheck(stdout = "", stderr = ""): ExecResult {
  return {
    code: 0,
    stdout: `${stdout}\n${CHECK_COMPLETION_MARKER}:0\n`,
    stderr,
    killed: true,
  };
}
