/**
 * git-failure.ts — Forge fork. Which of the three git failures a `pi.exec`
 * result is.
 *
 * Lifted out of `worktree-validator.ts` for the reason `turn-tracking.ts`,
 * `record-activity.ts`, `run-answer.ts` and `compaction-anchor.ts` were: that
 * file uses a `.js` specifier for `../utils.ts`, which plain node will not
 * resolve, so nothing in it could be tested. This module imports nothing.
 *
 * ## The defect it exists for
 *
 * `GIT_NOT_FOUND` and `GIT_TIMEOUT` used to be produced by sniffing a
 * REJECTION's message for `ENOENT` / `timed out`, and **`pi.exec` never
 * rejects.** `ExtensionAPI.exec` (`loader.js:287`) is `execCommand` (pi
 * `core/exec.js`), whose body is a `new Promise((resolve) => …)` with no
 * `reject` in it: a timeout kills the child and resolves, a spawn error is
 * caught and resolves `code: 1`, a non-zero exit resolves. Both constants were
 * therefore dead, and all three failures — git absent, git wedged, or a target
 * genuinely outside a repository — were reported as `NOT_IN_GIT_REPO`, which is
 * a claim about the operator's path when two of the three are claims about the
 * host.
 *
 * ## What pi actually returns, measured
 *
 * Against the real `execCommand`, not assumed:
 *
 *   git missing   execCommand("git-not-a-real-thing", …)
 *                   { code: 1,   stdout: "", stderr: "", killed: false }
 *   not a repo    execCommand("git", ["rev-parse","--git-common-dir"], "/")
 *                   { code: 128, stdout: "", stderr: "fatal: not a git repository…" }
 *   timed out     execCommand("bash", ["-lc","sleep 5"], …, {timeout: 400})
 *                   { code: 0,   stdout: "", stderr: "", killed: TRUE }
 *
 * The last row is why `killed` is tested FIRST. A signalled child exits with a
 * signal and no code, and `execCommand` does `code: code ?? 0` — so a wedged git
 * checked code-first reads as a SUCCESS returning an empty string, and the caller
 * resolves a worktree root to nothing or compares a repository against "".
 *
 * A non-zero code with nothing on either stream is a spawn that never produced a
 * process; git itself always says why it failed. Everything else that failed is
 * genuinely "not in a repo".
 *
 * This is AA2 one package over — the loop's goal check had the same assumption
 * about the same function. See `context/design/subagents-loop-verifier-hosts.md`.
 */

/** Specific error messages returned to the LLM for self-correction. */
export const WORKTREE_VALIDATION_ERRORS = {
  PATH_DOES_NOT_EXIST: "worktree_path does not exist: the specified path was not found on disk",
  NOT_A_DIRECTORY: "worktree_path is not a directory: the specified path exists but is not a directory",
  NOT_IN_GIT_REPO: "worktree_path is not inside a git repository",
  GIT_NOT_FOUND: "worktree_path validation failed: git executable not found on this host",
  GIT_TIMEOUT: "worktree_path validation failed: git command timed out",
} as const;

/** The slice of `ExecResult` this needs. `killed` is optional so older stubs still classify. */
export interface GitExecResult {
  code: number;
  stdout: string;
  stderr: string;
  killed?: boolean;
}

/** Which failure this result is, or undefined when the command succeeded. */
export function classifyGitFailure(result: GitExecResult): string | undefined {
  if (result.killed) return WORKTREE_VALIDATION_ERRORS.GIT_TIMEOUT;
  if (result.code === 0) return undefined;
  if (result.stdout.trim() === "" && result.stderr.trim() === "") {
    return WORKTREE_VALIDATION_ERRORS.GIT_NOT_FOUND;
  }
  return WORKTREE_VALIDATION_ERRORS.NOT_IN_GIT_REPO;
}
