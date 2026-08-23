/**
 * AO8 — the same-repo compare that realpath'd one side of itself.
 *
 * `validateWorktreePath` decides whether a `worktree_path` is a worktree of the
 * PARENT's repository or of a different one, and the caller applies the
 * cross-repo trust gate when it is different. The comparison was
 *
 * ```js
 *   normalizeGitPath(parentResult.commonDir, parentCwd) ===
 *   normalizeGitPath(targetResult.commonDir, realPath)
 * ```
 *
 * with `realPath` realpath'd and `parentCwd` not.
 *
 * The shapes below are MEASURED against real git in this container, not assumed
 * — and the first two are pinned by `git answers in two shapes` so that a change
 * upstream is a failing test rather than a rule resting on a stale observation:
 *
 *   in the MAIN worktree     `git rev-parse --git-common-dir` → ".git"   RELATIVE
 *   in a LINKED worktree                                      → "/abs/…/.git" ABSOLUTE
 *
 * The relative answer is resolved against the cwd it was asked in, so a logical
 * parent cwd yields `<symlink>/.git` against the target's `<real>/.git`, and a
 * worktree of the parent's own repository reads as cross-repo.
 *
 * Latent in production and recorded as such: pi builds `ctx.cwd` from
 * `process.cwd()` (`dist/cli/startup-ui.js:47`) through `resolvePath`, which
 * normalises and absolutises but does not canonicalise — and on Linux
 * `process.cwd()` is already physical. The twenty-fourth pass left it on the
 * grounds that the case was not reachable here. It is: `parentCwd` is a
 * parameter, and these tests pass one.
 *
 * See AO8 in `context/design/subagents-loop-verifier-identity.md` §13.1.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isSameRepo, normalizeGitPath, canonicaliseWithFs } from "../src/spawn/same-repo.ts";

/** `git rev-parse --git-common-dir`, exactly as `getGitCommonDir` asks it. */
function commonDir(cwd: string): string {
  return execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd, encoding: "utf8" }).trim();
}

function makeRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", "."], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@example.org"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  writeFileSync(join(dir, "f"), "x");
  execFileSync("git", ["add", "f"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: dir });
}

/**
 * A real repository, a real symlink to it, a real linked worktree, and a real
 * second repository — built once and torn down once.
 *
 * A fixture rather than a fake because the whole finding is about what git
 * ACTUALLY prints in two situations; a fake would be a test of the fake.
 */
function withFixture<T>(fn: (f: {
  repo: string; link: string; worktree: string; other: string;
}) => T): T {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "same-repo-")));
  try {
    const repo = join(root, "real");
    makeRepo(repo);
    const link = join(root, "link");
    symlinkSync(repo, link);
    const worktree = join(root, "wt");
    execFileSync("git", ["worktree", "add", "-q", worktree, "-b", "feature"], { cwd: repo });
    const other = join(root, "other");
    makeRepo(other);
    return fn({ repo, link, worktree, other });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("AO8 — the same-repo compare", () => {
  it("git answers in two shapes, and this is which", () => {
    withFixture(({ repo, worktree }) => {
      assert.equal(commonDir(repo), ".git", "the MAIN worktree answers relative");
      assert.ok(
        commonDir(worktree).startsWith("/"),
        `a LINKED worktree answers absolute (got ${commonDir(worktree)})`,
      );
    });
  });

  it("a worktree of the parent's own repo is the same repo, through a LOGICAL parent cwd", () => {
    withFixture(({ repo, link, worktree }) => {
      // The finding. `link` is a symlink to `repo`; the target side is
      // realpath'd by the validator before it gets here.
      const parent = { commonDir: commonDir(link), cwd: link };
      const target = { commonDir: commonDir(worktree), cwd: realpathSync(worktree) };

      // What the expression used to be, with the realpath on the target side only.
      const before =
        normalizeGitPath(parent.commonDir, parent.cwd) === normalizeGitPath(target.commonDir, target.cwd);
      assert.equal(before, false, "BEFORE: the parent's own worktree read as cross-repo");

      assert.equal(isSameRepo(parent, target), true, "NOW: it is the same repo");
      void repo;
    });
  });

  it("…and through a PHYSICAL parent cwd, which is the case that always worked", () => {
    withFixture(({ repo, worktree }) => {
      const parent = { commonDir: commonDir(repo), cwd: repo };
      const target = { commonDir: commonDir(worktree), cwd: realpathSync(worktree) };
      const before =
        normalizeGitPath(parent.commonDir, parent.cwd) === normalizeGitPath(target.commonDir, target.cwd);
      assert.equal(before, true, "the control: this is why the defect is latent here");
      assert.equal(isSameRepo(parent, target), true, "and the fix does not change it");
    });
  });

  it("two genuinely different repositories are still different", () => {
    withFixture(({ repo, other }) => {
      const parent = { commonDir: commonDir(repo), cwd: repo };
      const target = { commonDir: commonDir(other), cwd: other };
      assert.equal(isSameRepo(parent, target), false, "the trust gate still gates");
    });
  });

  it("…including through the symlink, so canonicalising did not widen the answer", () => {
    withFixture(({ link, other }) => {
      const parent = { commonDir: commonDir(link), cwd: link };
      const target = { commonDir: commonDir(other), cwd: other };
      assert.equal(isSameRepo(parent, target), false);
    });
  });

  it("a parent that is in no repository at all is not the same repo", () => {
    assert.equal(isSameRepo(undefined, { commonDir: ".git", cwd: "/tmp" }), false);
  });

  it("canonicalise is a parameter, so the dependence is visible", () => {
    // Identity canonicalise = a platform or a caller that hands over a logical
    // path with no way to resolve it. The answer goes back to what it was, which
    // is the honest outcome rather than a hidden one.
    const parent = { commonDir: ".git", cwd: "/w/link" };
    const target = { commonDir: "/w/real/.git", cwd: "/w/real" };
    assert.equal(isSameRepo(parent, target, (p) => p), false, "no resolution, no match");
    assert.equal(
      isSameRepo(parent, target, (p) => (p === "/w/link" ? "/w/real" : p)),
      true,
      "resolution supplied, and they match",
    );
  });

  it("an unresolvable cwd falls back to the string rather than throwing", () => {
    assert.equal(canonicaliseWithFs("/definitely/not/here"), "/definitely/not/here");
    assert.doesNotThrow(() =>
      isSameRepo({ commonDir: ".git", cwd: "/definitely/not/here" }, { commonDir: ".git", cwd: "/also/not" }),
    );
  });

  it("the win32 rule is unchanged: a drive letter on either side folds case", () => {
    assert.equal(normalizeGitPath(".git", "C:\\Work\\Repo"), "c:/work/repo/.git");
    assert.equal(normalizeGitPath("C:\\Work\\Repo\\.git", "/anything"), "c:/work/repo/.git");
    assert.equal(
      normalizeGitPath(".git", "\\\\server\\share\\repo"),
      "//server/share/repo/.git",
      "a UNC prefix selects win32 too",
    );
  });

  it("a posix path is NOT folded, because two spellings there are two directories", () => {
    assert.equal(normalizeGitPath(".git", "/Work/Repo"), "/Work/Repo/.git");
    assert.notEqual(normalizeGitPath(".git", "/Work/Repo"), normalizeGitPath(".git", "/work/repo"));
  });
});
