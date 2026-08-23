/**
 * same-repo.ts — Forge fork, twenty-fourth pass (AO8). Whether two paths are in
 * the same git repository.
 *
 * Lifted out of `worktree-validator.ts` for the reason `git-failure.ts`,
 * `turn-tracking.ts`, `record-activity.ts`, `run-answer.ts` and
 * `compaction-anchor.ts` were: that file uses a `.js` specifier for
 * `../utils.ts`, which plain node will not resolve, so nothing in it could be
 * tested. This module imports one node builtin and takes its filesystem call as
 * a parameter, so the suite can drive every case including the ones this
 * platform cannot produce.
 *
 * ## The defect it exists for
 *
 * `sameRepo` was
 *
 * ```js
 *   normalizeGitPath(parentResult.commonDir, parentCwd) ===
 *   normalizeGitPath(targetResult.commonDir, realPath)
 * ```
 *
 * — and the two sides are not the same kind of path. `realPath` has been
 * through `realpathSync`; `parentCwd` is whatever the caller was handed. So the
 * comparison asks "are these the same repository?" and answers "are these the
 * same STRING?", which is a different question the moment one side has been
 * canonicalised and the other has not.
 *
 * ## Why the asymmetry bites, measured with real git
 *
 * `git rev-parse --git-common-dir` does not answer in one shape:
 *
 * ```
 *   in the MAIN worktree     .git                          ← RELATIVE
 *   in a LINKED worktree     /abs/path/to/main/.git        ← ABSOLUTE
 * ```
 *
 * The relative answer is resolved against the cwd it was asked in — so a
 * logical parent cwd produces `<symlink>/.git` while the target, asked in a
 * realpath'd directory, produces `<real>/.git`. Reproduced in this container:
 *
 * ```
 *   parentCwd (a symlink to the repo)   …/gitprobe/link
 *   parent  --git-common-dir            ".git"
 *   target  --git-common-dir            "…/gitprobe/real/.git"
 *
 *   parent side BEFORE  …/gitprobe/link/.git
 *   target side         …/gitprobe/real/.git      →  sameRepo false
 *   parent side NOW     …/gitprobe/real/.git      →  sameRepo true
 * ```
 *
 * A worktree of the parent's OWN repository then reads as cross-repo, and
 * `resolveSubagentTrust` applies the cross-repo trust gate to it — a prompt for
 * something the operator already trusts, or a refusal, depending on the answer.
 *
 * ## Why it is latent here, and recorded anyway
 *
 * `parentCwd` is `getSessionCtx()?.cwd ?? ctx.cwd`, and pi builds that from
 * `process.cwd()` (`dist/cli/startup-ui.js:47`) through `resolvePath`, which
 * normalises and absolutises but does **not** canonicalise (`dist/utils/paths.js:82`).
 * On Linux `process.cwd()` is already physical, so the two sides agree today —
 * checked, not assumed. What that means is that the defect is one `--cwd`-style
 * option, one platform, or one caller passing a path a person typed away from
 * being live, with nothing in between to catch it.
 *
 * The twenty-fourth pass recorded this as latent and did not fix it, on the
 * grounds that "the case that would prove it is not reachable on this box".
 * That was wrong: `parentCwd` is a parameter, so the case is reachable by
 * passing one — which is what the test does, with a real repository, a real
 * symlink and a real linked worktree.
 *
 * ## The rule
 *
 * **Both sides are canonicalised before they are compared, here, once.** The
 * caller cannot get it half-right again, because it no longer does the
 * comparison. Canonicalising a path that is already canonical returns it
 * unchanged, so the target side — which the validator has already realpath'd —
 * is unaffected.
 */

import * as path from "node:path";
import { realpathSync } from "node:fs";

/** What `canonicalise` must do: resolve symlinks, or return the input unchanged. */
export type Canonicalise = (p: string) => string;

/**
 * `realpathSync`, with the input returned unchanged when it cannot be resolved.
 *
 * A cwd that has been deleted under a running session is the case: the compare
 * then falls back to the string it was given, which is exactly what this
 * comparison did before the fix and is never worse than it.
 */
export function canonicaliseWithFs(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Resolve a git path against the directory it was asked in, and normalise it for
 * comparison.
 *
 * Moved from `worktree-validator.ts` unchanged. The win32 handling is deliberate
 * and stays: a drive letter or a UNC prefix on EITHER value selects
 * `path.win32`, and the result is lower-cased, because that platform's paths are
 * case-insensitive and two spellings of one directory are one directory there.
 */
export function normalizeGitPath(gitPath: string, cwd: string): string {
  const isWindowsStyle =
    /^[A-Za-z]:[\\/]/.test(gitPath) || /^[A-Za-z]:[\\/]/.test(cwd) || /^\\\\/.test(gitPath) || /^\\\\/.test(cwd);
  const pathApi = isWindowsStyle ? path.win32 : path;
  const absolutePath = pathApi.isAbsolute(gitPath) ? gitPath : pathApi.resolve(cwd, gitPath);
  const normalizedPath = pathApi.normalize(absolutePath).replace(/\\/g, "/");

  return isWindowsStyle ? normalizedPath.toLowerCase() : normalizedPath;
}

/** One side of the comparison: what git said, and the directory it was asked in. */
export interface RepoSide {
  /** `git rev-parse --git-common-dir` — relative in a main worktree, absolute in a linked one. */
  commonDir: string;
  /** The directory that command was run in. */
  cwd: string;
}

/**
 * Are these two paths in the same git repository?
 *
 * `parent` is `undefined` when the parent is not in a repository at all, which
 * is not an error — the caller then applies the cross-repo trust gate, and this
 * returns false so it does.
 *
 * Both cwds are canonicalised before the relative-path resolution, because that
 * resolution is what carries a symlink into the answer. `canonicalise` is a
 * parameter so a test can drive a platform whose `process.cwd()` is logical
 * without needing to be running on one.
 */
export function isSameRepo(
  parent: RepoSide | undefined,
  target: RepoSide,
  canonicalise: Canonicalise = canonicaliseWithFs,
): boolean {
  if (!parent) return false;
  const parentPath = normalizeGitPath(parent.commonDir, canonicalise(parent.cwd));
  const targetPath = normalizeGitPath(target.commonDir, canonicalise(target.cwd));
  return parentPath === targetPath;
}
