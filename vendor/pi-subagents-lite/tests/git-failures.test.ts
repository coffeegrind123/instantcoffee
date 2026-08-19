/**
 * AA2's sibling — telling "git is missing" and "git wedged" from "not a repo".
 *
 * `WORKTREE_VALIDATION_ERRORS.GIT_NOT_FOUND` and `.GIT_TIMEOUT` used to be
 * produced by sniffing a REJECTION's message, and `pi.exec` never rejects: it is
 * `execCommand` (pi `core/exec.js`), a `new Promise((resolve) => …)` with no
 * `reject` in the body. So both constants were dead, and every failure — git
 * absent, git wedged, or a target genuinely outside a repo — was reported to the
 * operator as `worktree_path is not inside a git repository`.
 *
 * The shapes below were MEASURED against the real `execCommand` on this box, not
 * assumed:
 *
 *   execCommand("git-not-a-real-thing", …)        → {code: 1,   stdout:"", stderr:"",  killed:false}
 *   execCommand("git", ["rev-parse", …], "/")     → {code: 128, stdout:"", stderr:"fatal: not a git repository…"}
 *   execCommand("bash", ["-lc","sleep 5"], t:400) → {code: 0,   stdout:"", stderr:"",  killed:TRUE}
 *
 * The last one is why `killed` is checked before the code: a signalled child
 * exits with no code and `execCommand` does `code: code ?? 0`, so a timeout that
 * was checked code-first would read as a SUCCESS returning an empty string.
 *
 * `classifyGitFailure` and the error strings live in `src/spawn/git-failure.ts`
 * rather than in `worktree-validator.ts` because that file uses a `.js` specifier
 * for `../utils.ts` and plain node will not resolve it — the same move
 * `turn-tracking.ts`, `record-activity.ts`, `run-answer.ts` and
 * `compaction-anchor.ts` each made, for the same reason.
 *
 * See AA2 in `context/design/subagents-loop-verifier-hosts.md`.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { classifyGitFailure, WORKTREE_VALIDATION_ERRORS } from "../src/spawn/git-failure.ts";

const MEASURED = {
  gitMissing: { code: 1, stdout: "", stderr: "", killed: false },
  notARepo: {
    code: 128,
    stdout: "",
    stderr: "fatal: not a git repository (or any of the parent directories): .git\n",
    killed: false,
  },
  timedOut: { code: 0, stdout: "", stderr: "", killed: true },
  success: { code: 0, stdout: "/home/user/repo/.git\n", stderr: "", killed: false },
};

describe("classifyGitFailure — the three failures pi.exec resolves with", () => {
  it("a timed-out git is a timeout, not a missing repository", () => {
    assert.equal(classifyGitFailure(MEASURED.timedOut), WORKTREE_VALIDATION_ERRORS.GIT_TIMEOUT);
  });

  it("a git that never started is a missing executable, not a missing repository", () => {
    assert.equal(classifyGitFailure(MEASURED.gitMissing), WORKTREE_VALIDATION_ERRORS.GIT_NOT_FOUND);
  });

  it("control — git saying so is a missing repository", () => {
    assert.equal(classifyGitFailure(MEASURED.notARepo), WORKTREE_VALIDATION_ERRORS.NOT_IN_GIT_REPO);
  });

  it("control — a success is not a failure", () => {
    assert.equal(classifyGitFailure(MEASURED.success), undefined);
  });

  it("killed is checked BEFORE the exit code, because a killed git reports 0", () => {
    // The whole point. If the code were checked first this row would be a
    // success carrying an empty stdout, and the caller would resolve the
    // worktree root to "" or fall through to a same-repo comparison against
    // nothing.
    assert.notEqual(MEASURED.timedOut.code, 1, "pi resolves a SIGTERM'd child with code 0");
    assert.equal(classifyGitFailure({ ...MEASURED.timedOut, code: 0 }), WORKTREE_VALIDATION_ERRORS.GIT_TIMEOUT);
  });

  it("control — a non-zero code that git explained is still a repo problem", () => {
    // Only a completely silent failure is read as a spawn that never happened;
    // git always says why it failed.
    assert.equal(
      classifyGitFailure({ code: 128, stdout: "", stderr: "fatal: detected dubious ownership", killed: false }),
      WORKTREE_VALIDATION_ERRORS.NOT_IN_GIT_REPO,
    );
  });

  it("a caller that reports no `killed` field still classifies", () => {
    // Older stubs, and the menu wizard's own exec shim.
    assert.equal(classifyGitFailure({ code: 1, stdout: "", stderr: "" }), WORKTREE_VALIDATION_ERRORS.GIT_NOT_FOUND);
    assert.equal(classifyGitFailure({ code: 0, stdout: "x", stderr: "" }), undefined);
  });
});
