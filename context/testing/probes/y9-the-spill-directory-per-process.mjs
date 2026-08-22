/**
 * y9 — AL9. The spill bound was fifty files per DIRECTORY, and the directory
 * was one per PROCESS.
 *
 * FIXED — this drives the REAL `createSpillWriter` and the REAL sweep against a
 * temporary root full of directories shaped exactly as the shipped writer names
 * them, and prints what a week of sessions leaves behind in each column.
 *
 * ## The finding
 *
 * `.pi/extensions/compaction-guard/src/spill.ts` bounds the FILES in a spill
 * directory to fifty, with a careful argument for why it is a count and not a
 * teardown sweep — a parent and its child share one directory, so either one
 * clearing it at `session_shutdown` would break the other's markers. Every word
 * of that argument is about the files.
 *
 * The DIRECTORY is created by `mkdtempSync` on first use, and nothing has ever
 * removed one. So the real bound was "fifty files per process", and the number
 * of processes was bounded by nothing.
 *
 * Measured on the box before the fix, rather than argued about:
 *
 *     /tmp/pi-tool-output-*        116 directories
 *     /tmp/pi-subagent-result-*    131 directories
 *                                  ─── 247 directories, 230 MB, four days
 *
 * Every file in them is by construction a payload that did not fit a context
 * window. `npm test` on the guard contributes one per run, deliberately: the
 * suite drives the shipped handler so the assertion is about a real directory.
 *
 * The fix keeps the file bound untouched and adds the missing one. The
 * directory now carries the pid of the process that made it, and a new writer
 * sweeps the directories of DEAD owners once, when it creates its own. Pid
 * rather than age, because age cannot tell a finished session from a `/loop`
 * that has been running for a week and last spilled on Monday — and the
 * precedent is in this tree twice already, in prinny's bootstrap lock and its
 * `bot.pid`.
 *
 *   run: node --experimental-strip-types y9-the-spill-directory-per-process.mjs [week|live|legacy]
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = "/home/claudeuser/qwen3.8-forge";
const { createSpillWriter, pruneDeadSpillDirs, MAX_SPILL_FILES } = await import(
  `${REPO}/.pi/extensions/compaction-guard/src/spill.ts`
);

const PREFIX = "pi-probe-spill-";
/** Above the kernel's pid ceiling, so it is certainly not running. */
const DEAD = 4_194_300;

const MODES = {
  /** A week of finished sessions, then one more starting today. */
  week: {},
  /** A `/loop` still running alongside them — the directory that must survive. */
  live: {},
  /** Directories from a build that did not tag the pid — 247 of these exist. */
  legacy: {},
};

const MODE = process.argv[2] ?? "week";
if (!MODES[MODE]) {
  console.error(`usage: node y9-…mjs <${Object.keys(MODES).join("|")}>`);
  process.exit(2);
}

let failures = 0;
const check = (label, ok) => {
  console.log(`   ${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) failures++;
};

const root = mkdtempSync(join(tmpdir(), "y9-root-"));
const cleanup = () => rmSync(root, { recursive: true, force: true });
process.on("exit", cleanup);

/** A finished session's directory, at the bound: fifty capped tool results. */
function plantSession(name, files = MAX_SPILL_FILES) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < files; i++) writeFileSync(join(dir, `bash-call-${i}.txt`), "x".repeat(20_000));
  return dir;
}

const SESSIONS = 30;
const planted = [];
for (let i = 0; i < SESSIONS; i++) planted.push(plantSession(`${PREFIX}${DEAD - i}-Sess${i}`));
const live = MODE === "live" ? plantSession(`${PREFIX}${process.pid}-Running`) : undefined;
const legacy = MODE === "legacy" ? plantSession(`${PREFIX}NoPidHere`) : undefined;

const count = () => readdirSync(root).filter((n) => n.startsWith(PREFIX)).length;
const bytes = () =>
  readdirSync(root)
    .filter((n) => n.startsWith(PREFIX))
    .reduce((total, n) => total + readdirSync(join(root, n)).length * 20_000, 0);

console.log(`\ny9 [${MODE}] — the spill directory nobody removed (AL9)\n`);
console.log(`   finished sessions on disk : ${SESSIONS}`);
console.log(`   files per directory (cap) : ${MAX_SPILL_FILES}`);
console.log(`   a live session's directory: ${live ? "yes" : "no"}`);
console.log(`   pre-fix, untagged ones    : ${legacy ? "yes" : "no"}\n`);

console.log("   BEFORE");
console.log(`     directories : ${count()}`);
console.log(`     bytes       : ${(bytes() / 1e6).toFixed(1)} MB`);
console.log("     removed by  : nothing, ever\n");

const removed = pruneDeadSpillDirs(root, PREFIX);

console.log("   NOW  (one new session starts and sweeps on its first spill)");
console.log(`     swept       : ${removed}`);
console.log(`     directories : ${count()}`);
console.log(`     bytes       : ${(bytes() / 1e6).toFixed(1)} MB\n`);

check("every finished session's directory is gone", removed === SESSIONS);

if (MODE === "live") {
  console.log("   the whole risk of a sweep: a `/loop` running for days shares /tmp");
  console.log("   with whatever starts next, and its markers still name these files.\n");
  check("the running session's directory survives", existsSync(live));
  check("…with its files intact", readdirSync(live).length === MAX_SPILL_FILES);
} else if (MODE === "legacy") {
  console.log("   a directory with no pid in its name carries no evidence either");
  console.log("   way, and deleting on no evidence is how a sweep eats a live");
  console.log("   session's spills. They are left, and the format change means no");
  console.log("   more are made.\n");
  check("an untagged directory is left alone", existsSync(legacy));
} else {
  check("nothing is left", count() === 0);
}

// And the writer really does tag, and really does still bound its own files.
const write = createSpillWriter(PREFIX, 5);
const file = write("bash", "call-1", "y".repeat(1_000));
const dir = file.slice(0, file.lastIndexOf("/"));
const name = dir.slice(dir.lastIndexOf("/") + 1);
console.log(`   the directory this process makes: ${name}`);
check("carries this process's pid", name.startsWith(`${PREFIX}${process.pid}-`));
for (let i = 0; i < 12; i++) write("bash", `call-${i}`, "z".repeat(1_000));
check("and the older file bound is untouched", readdirSync(dir).length <= 5);
rmSync(dir, { recursive: true, force: true });

console.log(failures === 0 ? "\n   all expectations held\n" : `\n   ${failures} expectation(s) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
