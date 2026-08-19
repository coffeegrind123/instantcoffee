/**
 * worktree-validator.ts — Validate, resolve, and label a worktree path.
 *
 * Pure async functions that validate a `worktree_path` value: the target must
 * exist, be a directory, and sit inside a git repository (any repo on disk —
 * not only worktrees of the parent's repository). Depends on `pi.exec` for
 * git commands.
 *
 * Same-repo detection: compare `git-common-dir` of the parent and target
 * paths. The parent is not required to be in a git repo; when it isn't (or
 * the target lives in a different repo), the result flags `sameRepo: false`
 * so the caller can apply the cross-repo trust gate.
 */

import * as path from "node:path";
import { existsSync, statSync, realpathSync } from "node:fs";
import { GIT_EXEC_TIMEOUT_MS } from "../utils.js";

// The error strings and the failure classifier live in `git-failure.ts`, which
// imports nothing and can therefore be tested — this file cannot be loaded by the
// suite because it uses a `.js` specifier for `../utils.ts`. Re-exported so every
// existing importer keeps the name it had.
import { classifyGitFailure, WORKTREE_VALIDATION_ERRORS } from "./git-failure.js";
export { classifyGitFailure, WORKTREE_VALIDATION_ERRORS } from "./git-failure.js";

export interface WorktreeValidationSuccess {
  ok: true;
  /** Resolved absolute path (symlinks followed, relative resolved). Undefined when path is empty/omitted. */
  resolvedPath?: string;
  /** Worktree root directory. */
  worktreeRoot?: string;
  /** Short display label for the widget. */
  label?: string;
  /**
   * True when the parent and target share the same git repository.
   * False when the parent is not in a git repo or the target is in a
   * different one — the caller then applies the cross-repo trust gate.
   * Absent when the path was omitted (nothing to gate).
   */
  sameRepo?: boolean;
}

export interface WorktreeValidationFailure {
  ok: false;
  /** Human-readable error describing the specific failure reason. */
  error: string;
}

export type WorktreeValidationResult = WorktreeValidationSuccess | WorktreeValidationFailure;

/**
 * Minimal interface for the pi exec function — only what the validator needs.
 */
interface PiExec {
  exec(
    cmd: string,
    args: string[],
    opts?: { cwd?: string; timeout?: number },
  ): Promise<{ code: number; stdout: string; stderr: string; killed?: boolean }>;
}

/**
 * Run `git rev-parse --git-common-dir` and return the trimmed result.
 * Returns a failure result when the command fails or git is unavailable;
 * a non-repo directory yields NOT_IN_GIT_REPO.
 */
async function getGitCommonDir(
  pi: PiExec,
  cwd: string,
  onWarning?: (msg: string) => void,
): Promise<{ ok: true; commonDir: string } | { ok: false; error: string }> {
  try {
    const result = await pi.exec("git", ["rev-parse", "--git-common-dir"], { cwd, timeout: GIT_EXEC_TIMEOUT_MS });
    const failure = classifyGitFailure(result);
    if (failure) {
      if (failure !== WORKTREE_VALIDATION_ERRORS.NOT_IN_GIT_REPO) {
        onWarning?.(`git rev-parse --git-common-dir in ${cwd}: ${failure}`);
      }
      return { ok: false, error: failure };
    }
    const commonDir = result.stdout.trim();
    if (!commonDir) return { ok: false, error: WORKTREE_VALIDATION_ERRORS.NOT_IN_GIT_REPO };
    return { ok: true, commonDir };
  } catch (err: unknown) {
    // pi.exec itself throwing means the extension runtime went stale
    // (`runtime.assertActive()` is the first line of `loader.js:287`); the
    // command never ran at all. See classifyGitFailure for why this is the ONLY
    // thing that reaches here.
    const msg = String(err instanceof Error ? err.message : err);
    onWarning?.(`git rev-parse --git-common-dir could not be started in ${cwd}: ${msg}`);
    return { ok: false, error: `worktree_path validation failed: git could not be run: ${msg}` };
  }
}

/** Resolve a git path and normalize it for reliable cross-platform comparison. */
function normalizeGitPath(gitPath: string, cwd: string): string {
  const isWindowsStyle =
    /^[A-Za-z]:[\\/]/.test(gitPath) || /^[A-Za-z]:[\\/]/.test(cwd) || /^\\\\/.test(gitPath) || /^\\\\/.test(cwd);
  const pathApi = isWindowsStyle ? path.win32 : path;
  const absolutePath = pathApi.isAbsolute(gitPath) ? gitPath : pathApi.resolve(cwd, gitPath);
  const normalizedPath = pathApi.normalize(absolutePath).replace(/\\/g, "/");

  return isWindowsStyle ? normalizedPath.toLowerCase() : normalizedPath;
}

/**
 * Validate a worktree path against the git repository it must live in.
 * Empty/whitespace is treated as omitted (ok with no path). Returns the
 * resolved absolute path, worktree root, display label, and same-repo
 * status against the parent (parent need not be in a repo).
 */
export async function validateWorktreePath(
  pi: PiExec,
  worktreePath: string,
  parentCwd: string,
  onWarning?: (msg: string) => void,
): Promise<WorktreeValidationResult> {
  // Step 1: Empty / whitespace → treat as omitted
  if (!worktreePath || worktreePath.trim() === "") {
    return { ok: true };
  }

  // Step 2: Resolve relative paths against parent cwd
  const resolved = path.isAbsolute(worktreePath) ? worktreePath : path.resolve(parentCwd, worktreePath);

  // Step 3: Check existence
  if (!existsSync(resolved)) {
    return { ok: false, error: WORKTREE_VALIDATION_ERRORS.PATH_DOES_NOT_EXIST };
  }

  // Step 4: Check is directory (resolve symlinks first via stat)
  let realPath: string;
  try {
    const stat = statSync(resolved);
    if (!stat.isDirectory()) {
      return { ok: false, error: WORKTREE_VALIDATION_ERRORS.NOT_A_DIRECTORY };
    }
    realPath = realpathSync(resolved);
  } catch {
    // stat failed — likely a broken symlink or permission issue
    return { ok: false, error: WORKTREE_VALIDATION_ERRORS.PATH_DOES_NOT_EXIST };
  }

  // Step 5: the target must be inside a git repository (any repo on disk)
  const targetResult = await getGitCommonDir(pi, realPath, onWarning);
  if (!targetResult.ok) return targetResult;

  // Step 6: Detect same-repo vs cross-repo against the parent. The parent
  // is not required to be in a git repo (issue: allow-several-repos); a
  // failed parent probe just means the target is cross-repo and the trust
  // gate may apply.
  const parentResult = await getGitCommonDir(pi, parentCwd, onWarning);
  const sameRepo =
    parentResult.ok &&
    normalizeGitPath(parentResult.commonDir, parentCwd) === normalizeGitPath(targetResult.commonDir, realPath);

  // Step 7: Get the worktree root via git rev-parse --show-toplevel
  let worktreeRoot: string;
  try {
    const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], {
      cwd: realPath,
      timeout: GIT_EXEC_TIMEOUT_MS,
    });
    // `code !== 0` is not the test: a killed git reports code 0 with no output
    // (a signalled child exits with no code and execCommand does `code ?? 0`),
    // so a timed-out probe would read as a success returning "". Fall back to
    // the real path on any failure; the root is a display detail, not a gate.
    if (classifyGitFailure(result)) {
      worktreeRoot = realPath;
    } else {
      const raw = result.stdout.trim();
      worktreeRoot = raw ? (path.isAbsolute(raw) ? raw : path.resolve(realPath, raw)) : realPath;
    }
  } catch {
    worktreeRoot = realPath;
  }

  // Step 8: Compute display label (normalizes internally), then normalize
  // the returned paths.
  const label = computeLabel(realPath, worktreeRoot);
  const normalizedRealPath = realPath.replace(/\\/g, "/");
  const normalizedRoot = worktreeRoot.replace(/\\/g, "/");

  return {
    ok: true,
    resolvedPath: normalizedRealPath,
    worktreeRoot: normalizedRoot,
    label,
    sameRepo,
  };
}

/**
 * Compute a short display label for the worktree path.
 *
 * Rules:
 * - Root of worktree → basename (e.g., "/wt/feature" → "feature")
 * - Subdirectory → basename/relative (e.g., "/wt/feature/packages/web" → "feature/packages/web")
 * - Always forward slashes regardless of host OS
 */
export function computeLabel(resolvedPath: string, worktreeRoot: string): string {
  const normalizedResolved = resolvedPath.replace(/\\/g, "/");
  const normalizedRoot = worktreeRoot.replace(/\\/g, "/");

  const rootBasename = normalizedRoot.split("/").filter(Boolean).pop() ?? "";

  if (normalizedResolved === normalizedRoot) {
    return rootBasename;
  }

  const relative = path.posix.relative(normalizedRoot, normalizedResolved);

  return `${rootBasename}/${relative}`;
}
