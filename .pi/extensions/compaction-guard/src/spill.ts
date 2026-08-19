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
 * A bounded spill directory, created on first use.
 *
 * `prefix` is the `mkdtemp` template, so each caller keeps its own directory and
 * its own count — which is what the two have today, and what keeps the guard's
 * parent/child sharing argument intact.
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
      dir ??= mkdtempSync(join(tmpdir(), prefix));
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
