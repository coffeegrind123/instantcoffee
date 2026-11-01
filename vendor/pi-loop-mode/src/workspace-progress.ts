/**
 * A fingerprint of the loop's workspace, taken once per iteration, so the audit
 * rung can see progress that no tool result names.
 *
 * `hasStateChange` reads tool-result wording, and a bash-only model defeats it:
 * a file written through a heredoc prints nothing, `git commit -q` prints
 * nothing, and rtk rewrites what is left to `ok`. Measured 2026-11-01 on a
 * 50-iteration run that committed every turn: the rung fired twice. The
 * workspace itself does not depend on how the model spelled its commands.
 *
 * What the fingerprint covers, in a git work tree:
 *
 *   `git status --porcelain=v2 --branch`   HEAD (`# branch.oid`), staged and
 *                                          unstaged paths, untracked NAMES
 *   `git diff --binary HEAD`               the content of every tracked change
 *
 * Both are hashed inside the script with `git hash-object --stdin`, so a tree
 * with thousands of untracked files still returns two short lines.
 *
 * Still invisible, and covered by the wording heuristic or not at all: content
 * changes to an untracked file that already existed, and anything outside a git
 * work tree (the probe exits non-zero and the caller keeps the old behaviour).
 *
 * The loop's own log is excluded. It is appended to every iteration, and a
 * model that runs `git add -A` commits it (the 2026-11-01 run did), after which
 * every iteration would read as progress and the rung could never fire.
 *
 * `GIT_OPTIONAL_LOCKS=0` keeps `git status` from taking the index lock, so the
 * probe cannot make a concurrent git command in the workspace fail.
 */

import { relative, resolve, sep } from "node:path";

import { LOG_FILE } from "./loop-log.ts";

export const WORKSPACE_PROBE_TIMEOUT_MS = 10_000;

/** Exit code the script uses for "not a git work tree"; anything non-zero means "no fingerprint". */
export const NOT_A_WORK_TREE = 3;

const PROBE_SCRIPT = [
  "set -o pipefail",
  "export GIT_OPTIONAL_LOCKS=0",
  `git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit ${NOT_A_WORK_TREE}`,
  'git status --porcelain=v2 --branch --untracked-files=normal -- "$@" | git hash-object --stdin || exit 4',
  "if git rev-parse -q --verify HEAD >/dev/null; then",
  '  git diff --no-ext-diff --no-color --binary HEAD -- "$@" | git hash-object --stdin || exit 4',
  "fi",
].join("\n");

type Exec = (
  command: string,
  args: string[],
  options?: { cwd?: string; timeout?: number },
) => Promise<{ code: number; stdout: string; stderr: string; killed: boolean }>;

/**
 * Pathspecs that drop the loop's own files. `LOG_FILE` resolves against the
 * PROCESS cwd, which need not be `cwd`; a path outside `cwd` is left out, since
 * git rejects a pathspec outside the repository and the file cannot be in this
 * tree's status anyway.
 */
export function loopOwnedExcludes(cwd: string): string[] {
  const log = relative(cwd, resolve(LOG_FILE));
  if (log === "" || log === ".." || log.startsWith(`..${sep}`)) return [];
  return [log, `${log}.1`].map((path) => `:(exclude,literal)${path}`);
}

/** The workspace fingerprint, or `undefined` when there is none to take. Never throws. */
export async function workspaceFingerprint(exec: Exec, cwd: string): Promise<string | undefined> {
  try {
    const result = await exec("bash", ["-c", PROBE_SCRIPT, "workspace-probe", ...loopOwnedExcludes(cwd)], {
      cwd,
      timeout: WORKSPACE_PROBE_TIMEOUT_MS,
    });
    if (result.killed || result.code !== 0) return undefined;
    const fingerprint = (result.stdout ?? "").trim();
    return fingerprint || undefined;
  } catch {
    return undefined;
  }
}
