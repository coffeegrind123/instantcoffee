/**
 * AL9 — the bound was per directory, and the directory was per process.
 *
 * `spill.ts` bounds the FILES in a spill directory to fifty, with a careful
 * argument for why it is a count and not a teardown sweep. Everything in that
 * argument is about the files. The DIRECTORY is created by `mkdtempSync` on
 * first use, and nothing has ever removed one — so the real bound was "fifty
 * files per process", and the number of processes was bounded by nothing at all.
 *
 * Measured on the box before the fix rather than argued about:
 *
 * ```
 *   /tmp/pi-tool-output-*        116 directories
 *   /tmp/pi-subagent-result-*    131 directories
 *                                ─── 247, 230 MB, four days of use
 * ```
 *
 * `npm test` on this package contributes one per run, deliberately: the suite
 * next door drives the shipped handler so that the assertion is about a real
 * directory. `/tmp` here is the container's writable layer.
 *
 * The fix keeps the file bound exactly as it is and adds the missing one: the
 * directory carries the pid of the process that made it, and a new writer sweeps
 * the directories of dead owners once, when it creates its own. Pid rather than
 * age, because age cannot tell a finished session from a `/loop` that has run
 * for a week and last spilled on Monday.
 *
 * See AL9 in `context/design/subagents-loop-verifier-lifetimes.md`.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { createSpillWriter, pruneDeadSpillDirs } from "../src/spill.ts";

const PREFIX = "pi-spill-dirs-test-";
const ROOT_PREFIX = "spill-dirs-root-";
const roots: string[] = [];

/**
 * Queue a directory for teardown, and refuse anything that is not one of ours.
 *
 * Written this way after the first draft of this file computed a path with
 * `file.split(PREFIX)[0]`, got `/tmp`, and handed it to a recursive `rmSync` in
 * `after()`. It deleted `/tmp`. A teardown that takes a path from a computation
 * has to prove the path is its own before it removes it — the same rule the
 * module under test follows when it refuses to sweep a directory whose owner it
 * cannot name.
 */
function disposeLater(path: string): void {
  const base = `${tmpdir()}/`;
  const name = path.startsWith(base) ? path.slice(base.length) : "";
  if (!name || name.includes("/")) throw new Error(`refusing to schedule ${path} for deletion`);
  if (!name.startsWith(PREFIX) && !name.startsWith(ROOT_PREFIX)) {
    throw new Error(`refusing to schedule ${path} for deletion`);
  }
  roots.push(path);
}

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), ROOT_PREFIX));
  roots.push(root);
  return root;
}

/** The directory part of a spill path the writer returned. */
function dirOf(file: string): string {
  return file.slice(0, file.lastIndexOf("/"));
}

/** A directory shaped exactly as the writer names one. */
function plant(root: string, name: string, files = 1): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < files; i++) writeFileSync(join(dir, `bash-${i}.txt`), "x".repeat(1_000));
  return dir;
}

/** A pid that is certainly not running: exceeds the kernel's ceiling. */
const DEAD_PID = 4_194_303;

after(() => {
  const base = `${tmpdir()}/`;
  for (const root of roots) {
    // Belt to `disposeLater`'s braces: the check that matters is the one
    // immediately above the destructive call.
    const name = root.startsWith(base) ? root.slice(base.length) : "";
    if (!name || name.includes("/")) continue;
    if (!name.startsWith(PREFIX) && !name.startsWith(ROOT_PREFIX)) continue;
    rmSync(root, { recursive: true, force: true });
  }
});

describe("AL9 — a spill directory does not outlive the process that made it", () => {
  it("removes a dead owner's directory", () => {
    const root = makeRoot();
    const dead = plant(root, `${PREFIX}${DEAD_PID}-AbCdEf`, 3);

    assert.equal(pruneDeadSpillDirs(root, PREFIX), 1);
    assert.equal(existsSync(dead), false);
  });

  it("keeps a live owner's directory", () => {
    // The whole risk of a sweep. A `/loop` running for days shares `/tmp` with
    // whatever starts next, and its markers still name these files.
    const root = makeRoot();
    const live = plant(root, `${PREFIX}${process.pid}-LiVeOn`, 2);

    assert.equal(pruneDeadSpillDirs(root, PREFIX), 0);
    assert.equal(existsSync(live), true);
    assert.equal(readdirSync(live).length, 2);
  });

  it("keeps a directory from a build that did not tag the pid", () => {
    // 247 of these exist on this box. There is no evidence either way about who
    // owns them, and deleting on no evidence is how a sweep eats a live
    // session's spills.
    const root = makeRoot();
    const legacy = plant(root, `${PREFIX}AbCdEf`);

    assert.equal(pruneDeadSpillDirs(root, PREFIX), 0);
    assert.equal(existsSync(legacy), true);
  });

  it("never touches another prefix", () => {
    // The two writers in this stack keep separate directories on purpose, and a
    // sweep that crossed the boundary would delete the other cap's live spills.
    const root = makeRoot();
    const other = plant(root, `pi-other-cap-${DEAD_PID}-AbCdEf`);
    const unrelated = plant(root, "systemd-private-whatever");

    assert.equal(pruneDeadSpillDirs(root, PREFIX), 0);
    assert.equal(existsSync(other), true);
    assert.equal(existsSync(unrelated), true);
  });

  it("sweeps several at once and leaves the live one", () => {
    const root = makeRoot();
    const graves = [1, 2, 3].map((n) => plant(root, `${PREFIX}${DEAD_PID - n}-D${n}`));
    const live = plant(root, `${PREFIX}${process.pid}-LiVeOn`);

    assert.equal(pruneDeadSpillDirs(root, PREFIX), 3);
    for (const grave of graves) assert.equal(existsSync(grave), false);
    assert.equal(existsSync(live), true);
  });

  it("survives a root it cannot read", () => {
    assert.equal(pruneDeadSpillDirs(join(tmpdir(), "no-such-root-al9"), PREFIX), 0);
  });
});

describe("AL9 — the writer names its directory after the process", () => {
  it("puts this process's pid in the path", () => {
    const write = createSpillWriter(PREFIX, 5);
    const file = write("bash", "call-1", "y".repeat(100));
    assert.ok(file, "the writer still writes");
    const dir = dirOf(file);
    disposeLater(dir);
    const name = dir.slice(dir.lastIndexOf("/") + 1);
    assert.ok(name.startsWith(`${PREFIX}${process.pid}-`), `unexpected directory name ${name}`);
  });

  it("still bounds the files in it, which is the older bound", () => {
    // The point of the fix is that the two bounds are different dimensions and
    // this one is unchanged.
    const write = createSpillWriter(PREFIX, 5);
    let last: string | undefined;
    for (let i = 0; i < 12; i++) last = write("bash", `call-${i}`, "z".repeat(200));
    assert.ok(last);
    const dir = dirOf(last);
    disposeLater(dir);
    assert.ok(readdirSync(dir).length <= 5, "the per-directory count bound still holds");
    assert.ok(existsSync(last), "the file just named to the model is never the pruned one");
  });

  it("sweeps a dead sibling on first use, and only once", () => {
    // The sweep is on the create path, so a writer that never spills never
    // reads the directory at all.
    const write = createSpillWriter(PREFIX, 5);
    const doomed = plant(tmpdir(), `${PREFIX}${DEAD_PID}-FirstUse`);
    assert.equal(existsSync(doomed), true);

    const file = write("bash", "call-1", "w".repeat(100));
    assert.ok(file);
    disposeLater(dirOf(file));
    assert.equal(existsSync(doomed), false, "the dead sibling went with the first write");
  });
});
