/**
 * spill.ts — where a capped output's full text is kept, and the bound on it.
 *
 * Forge fork, seventeenth pass (AH3/AH4). One implementation, two callers.
 *
 * ## What a spill is
 *
 * Both output caps in this stack keep what they cut. The model is handed a head,
 * a tail and a marker naming a file; the file holds the whole thing, so a
 * truncation is a redirection rather than a loss. Every file written here is by
 * construction a payload that did not fit a context window — at least
 * `MIN_ALLOWANCE_CHARS`, and often tens of kilobytes.
 *
 * ## Why the bound is a COUNT and not a teardown sweep
 *
 * `spillDir` is module-global, and a CHILD inherits `compaction-guard` by
 * discovery (`.pi/extensions/**` is on the child's discovery route), so parent
 * and child share one directory. A `session_shutdown` sweep on either side would
 * delete files the other's markers still name. Pruning the oldest has no such
 * coupling: a marker that old left the context several compactions ago.
 *
 * Fifty is about two full windows' worth of capped results, and a few megabytes.
 *
 * ## Why it is a module rather than a paragraph in two files
 *
 * `vendor/pi-subagents-lite/src/spawn/result-cap.ts` is the second cap. It bounds
 * a BACKGROUND subagent's result, which never passes through the `tool_result`
 * hook — `sendCustomMessage` emits no such event — so it cannot reuse the guard's
 * handler and has to do the capping itself. It already imports
 * `allowanceChars`/`planOutputCap` from here rather than restating the numbers,
 * under its own heading *"Why it imports the guard rather than carrying its own
 * numbers"*:
 *
 * > A second copy of those constants here would drift away from the test that
 * > justifies them, so this imports them instead.
 *
 * It then copied the *writer* — mkdtemp, sanitise, write — and not the prune, so
 * of the two spill directories in one process the one whose docstring names the
 * unattended `/loop` was bounded and the one fed by an unattended run's
 * background delegations was not. The argument for importing the constants is
 * the argument for importing this: the bound and the reason for it are one
 * thing.
 *
 * ## The second dimension, and the one that was not bounded (AL9)
 *
 * Forge fork, twenty-first pass. Everything above bounds the FILES IN a
 * directory. The directory is created by `mkdtempSync` on first use and nothing
 * has ever removed one — so the bound is fifty files *per process*, and the
 * number of processes is not bounded by anything.
 *
 * Measured on this box before the fix, rather than reasoned about: **247
 * directories, 230 MB**, over four days of use, from two prefixes —
 * `pi-tool-output-` (116) and `pi-subagent-result-` (131). Every `npm test` of
 * this package leaves one too, because the suite drives the shipped handler on
 * purpose. `/tmp` here is the container's writable layer.
 *
 * The header's argument against a teardown sweep is about the FILES and it
 * still holds: a parent and its child share one directory, so either one
 * deleting the contents at `session_shutdown` would break the other's markers.
 * It says nothing about a directory whose OWNING PROCESS IS GONE. Nothing can
 * read a marker from a dead session: the context that held it died with it.
 *
 * So the directory now carries the pid of the process that made it, and the
 * writer sweeps dead owners' directories once, when it creates its own. Pid
 * rather than age, because age cannot tell a finished session from a `/loop`
 * that has been running for a week and last spilled on Monday — and the
 * precedent is in this tree twice already: `prinny-channel`'s bootstrap lock
 * (`lockOwnerAlive()`) and its `bot.pid`.
 *
 * A pid that has been recycled by an unrelated process reads as alive and its
 * directory is kept. That is the safe direction, and one stale directory is not
 * what this is about.
 */

import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * How many spilled outputs to keep.
 *
 * See the header: every file here is one that did not fit a context, nothing
 * else ever removes one, and an unattended run is exactly the shape that fills a
 * disk with them.
 */
export const MAX_SPILL_FILES = 50;

/** Drop the oldest spills once there are more than the bound allows. */
export function pruneSpills(dir: string, max: number = MAX_SPILL_FILES): void {
  try {
    const files = readdirSync(dir)
      .map((name) => join(dir, name))
      .map((path) => ({ path, at: statSync(path).mtimeMs }))
      .sort((a, b) => a.at - b.at);
    for (const file of files.slice(0, Math.max(0, files.length - max))) {
      rmSync(file.path, { force: true });
    }
  } catch {
    // Housekeeping. A directory that cannot be read is not a reason to skip the
    // cap the caller is here for.
  }
}

/**
 * The pid a spill directory's name carries, or undefined for one that carries
 * none.
 *
 * The layout is `<prefix><pid>-<mkdtemp suffix>`. A directory from a build
 * before AL9 has no `<pid>-` and returns undefined, which is read as "do not
 * touch it": there is no evidence either way, and deleting on no evidence is
 * how a sweep eats a live session's spills.
 */
function ownerPid(name: string, prefix: string): number | undefined {
  if (!name.startsWith(prefix)) return undefined;
  const rest = name.slice(prefix.length);
  const dash = rest.indexOf("-");
  if (dash <= 0) return undefined;
  const pid = Number(rest.slice(0, dash));
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

/**
 * Is that process still running?
 *
 * `kill(pid, 0)` sends no signal and only asks. `EPERM` means it exists and is
 * somebody else's, which for this question is a yes — the conservative answer,
 * and the one that keeps a sweep from ever being the reason a spill is missing.
 */
function ownerAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/**
 * Remove spill directories for this prefix whose owning process is gone (AL9).
 *
 * Exported for the suite. Runs once per process, from `createSpillWriter`'s
 * first write, which is the only moment at which this is on a path anybody
 * takes and the only moment at which it is worth the `readdir`.
 */
export function pruneDeadSpillDirs(root: string, prefix: string, self: number = process.pid): number {
  let removed = 0;
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return 0;
  }
  for (const name of names) {
    const pid = ownerPid(name, prefix);
    // undefined → not ours, or a pre-AL9 directory: leave it alone.
    if (pid === undefined || pid === self || ownerAlive(pid)) continue;
    try {
      rmSync(join(root, name), { recursive: true, force: true });
      removed += 1;
    } catch {
      // Somebody else's directory, a race with its own teardown, a read-only
      // mount. Housekeeping is never a reason to fail the cap.
    }
  }
  return removed;
}

/**
 * A bounded spill directory, created on first use.
 *
 * `prefix` is the `mkdtemp` template, so each caller keeps its own directory and
 * its own count — which is what the two have today, and what keeps the guard's
 * parent/child sharing argument intact. The pid goes in the name so a LATER
 * process can tell a finished session's directory from a live one's; a child
 * session is in this same process, so it still shares this directory, which is
 * the property the argument above depends on.
 *
 * The returned function never throws: a cap that cannot save the overflow still
 * caps, and the marker says the file is absent.
 */
export function createSpillWriter(
  prefix: string,
  max: number = MAX_SPILL_FILES,
): (label: string, id: string, text: string) => string | undefined {
  let dir: string | undefined;
  return (label, id, text) => {
    try {
      if (dir === undefined) {
        const root = tmpdir();
        dir = mkdtempSync(join(root, `${prefix}${process.pid}-`));
        // After our own directory exists, so a sweep can never be looking at a
        // half-created one, and before the first write, so the disk is at its
        // emptiest when the payload that did not fit a context arrives.
        pruneDeadSpillDirs(root, prefix);
      }
      // The id makes it unique; the label makes the path readable in the marker,
      // which is the only place the model ever sees it.
      const safeLabel = String(label).replace(/[^\w.-]+/g, "_").slice(0, 24) || "output";
      const safeId = String(id).replace(/[^\w.-]+/g, "_").slice(0, 32);
      const file = join(dir, `${safeLabel}-${safeId}.txt`);
      writeFileSync(file, text, "utf8");
      // After the write, so the file just named is always the newest and can
      // never be the one pruned.
      pruneSpills(dir, max);
      return file;
    } catch {
      return undefined;
    }
  };
}
