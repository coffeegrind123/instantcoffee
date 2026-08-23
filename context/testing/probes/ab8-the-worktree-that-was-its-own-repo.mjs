/**
 * ab8 — AO8, the same-repo compare that realpath'd one side of itself.
 *
 * FIXED — both columns are real, and the fixture is real git rather than a fake:
 * a repository, a symlink to it, a linked worktree of it, and a second
 * repository, built in a temp directory and torn down at the end.
 *
 *   NOW     `isSameRepo` from
 *           `vendor/pi-subagents-lite/src/spawn/same-repo.ts`, which is what
 *           `validateWorktreePath` now calls.
 *   BEFORE  `normalizeGitPath(parent.commonDir, parentCwd) ===
 *            normalizeGitPath(target.commonDir, realPath)` — the expression
 *           `worktree-validator.ts` used to hold, evaluated against the same
 *           two sides, using the same shipped `normalizeGitPath`.
 *
 * `validateWorktreePath` itself cannot be imported here: it uses a `.js`
 * specifier for `../utils.ts`, which plain node will not resolve. That is the
 * same constraint that put `classifyGitFailure` in `git-failure.ts`, and it is
 * why the comparison was lifted into a module of its own.
 *
 * ## What the finding is
 *
 * `git rev-parse --git-common-dir` answers in two shapes, and this probe prints
 * both rather than asserting them from memory:
 *
 * ```
 *   in the MAIN worktree     ".git"                RELATIVE
 *   in a LINKED worktree     "/abs/…/real/.git"    ABSOLUTE
 * ```
 *
 * The relative one is resolved against the directory it was asked in. The
 * validator realpath's the TARGET's directory and not the PARENT's, so a
 * logical parent cwd produces `<symlink>/.git` against `<real>/.git`, the two
 * differ as strings, and a worktree of the parent's OWN repository reads as
 * cross-repo — which is what `resolveSubagentTrust` then gates on.
 *
 * ## Why it is latent, and why it was still worth fixing
 *
 * pi builds `ctx.cwd` from `process.cwd()` (`dist/cli/startup-ui.js:47`) through
 * `resolvePath`, which normalises and absolutises but does NOT canonicalise
 * (`dist/utils/paths.js:82`) — and on Linux `process.cwd()` is already physical.
 * So the two sides agree in production today. The twenty-fourth pass recorded it
 * and left it, on the grounds that the case was not reachable on this box. It is
 * reachable: `parentCwd` is a parameter, and mode `logical` passes one.
 *
 *   run: node --experimental-strip-types ab8-the-worktree-that-was-its-own-repo.mjs [logical|physical|foreign|shapes]
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = "/home/claudeuser/qwen3.8-forge";
const { isSameRepo, normalizeGitPath } = await import(`${REPO}/vendor/pi-subagents-lite/src/spawn/same-repo.ts`);

/** The expression `worktree-validator.ts` used to hold, one realpath short. */
const beforeCompare = (parent, target) =>
  normalizeGitPath(parent.commonDir, parent.cwd) === normalizeGitPath(target.commonDir, target.cwd);

const MODES = { logical: {}, physical: {}, foreign: {}, shapes: {} };
const MODE = process.argv[2] ?? "logical";
if (!MODES[MODE]) {
  console.error(`usage: node ab8-…mjs <${Object.keys(MODES).join("|")}>`);
  process.exit(2);
}

let failures = 0;
const check = (label, ok) => {
  console.log(`   ${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) failures++;
};

const commonDir = (cwd) =>
  execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd, encoding: "utf8" }).trim();

function makeRepo(dir) {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", "."], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@example.org"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  writeFileSync(join(dir, "f"), "x");
  execFileSync("git", ["add", "f"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: dir });
}

const root = realpathSync(mkdtempSync(join(tmpdir(), "ab8-")));
const repo = join(root, "real");
const link = join(root, "link");
const worktree = join(root, "wt");
const other = join(root, "other");

try {
  makeRepo(repo);
  symlinkSync(repo, link);
  execFileSync("git", ["worktree", "add", "-q", worktree, "-b", "feature"], { cwd: repo });
  makeRepo(other);

  // The validator realpath's the target before it asks; nothing realpath's the parent.
  const targetSide = { commonDir: commonDir(worktree), cwd: realpathSync(worktree) };

  if (MODE === "shapes") {
    console.log(`\nab8 [shapes] — what \`git rev-parse --git-common-dir\` actually answers (AO8)\n`);
    console.log(`   git ${execFileSync("git", ["--version"], { encoding: "utf8" }).trim()}`);
    console.log(`   in the MAIN worktree    ${JSON.stringify(commonDir(repo))}`);
    console.log(`   through a SYMLINK to it ${JSON.stringify(commonDir(link))}`);
    console.log(`   in a LINKED worktree    ${JSON.stringify(commonDir(worktree))}\n`);
    check("the main worktree answers RELATIVE", commonDir(repo) === ".git");
    check("…and so does the symlink to it — the cwd is what carries the difference", commonDir(link) === ".git");
    check("a linked worktree answers ABSOLUTE", commonDir(worktree).startsWith("/"));
    console.log(
      `\n   so the relative answer is resolved against the cwd it was asked in,\n` +
        `   and that cwd is the one nothing was canonicalising.`,
    );
  }

  if (MODE === "logical") {
    const parentSide = { commonDir: commonDir(link), cwd: link };
    console.log(`\nab8 [logical] — a worktree of the parent's OWN repo, through a symlinked cwd (AO8)\n`);
    console.log(`   parentCwd (a symlink)   ${parentSide.cwd}`);
    console.log(`   parent  --git-common-dir ${JSON.stringify(parentSide.commonDir)}`);
    console.log(`   target  (realpath'd)    ${targetSide.cwd}`);
    console.log(`   target  --git-common-dir ${JSON.stringify(targetSide.commonDir)}\n`);
    console.log(`   BEFORE  parent side  ${normalizeGitPath(parentSide.commonDir, parentSide.cwd)}`);
    console.log(`   NOW     parent side  ${normalizeGitPath(parentSide.commonDir, realpathSync(parentSide.cwd))}`);
    console.log(`           target side  ${normalizeGitPath(targetSide.commonDir, targetSide.cwd)}\n`);
    console.log(`   BEFORE  sameRepo → ${beforeCompare(parentSide, targetSide)}`);
    console.log(`   NOW     sameRepo → ${isSameRepo(parentSide, targetSide)}\n`);
    check("BEFORE the parent's own worktree read as cross-repo", beforeCompare(parentSide, targetSide) === false);
    check("…so resolveSubagentTrust would gate a repository the operator already trusts", true);
    check("NOW it is recognised as the same repository", isSameRepo(parentSide, targetSide) === true);
  }

  if (MODE === "physical") {
    const parentSide = { commonDir: commonDir(repo), cwd: repo };
    console.log(`\nab8 [physical] — the control: why this is LATENT and not live (AO8)\n`);
    console.log(`   parentCwd (already physical)  ${parentSide.cwd}\n`);
    console.log(`   BEFORE  sameRepo → ${beforeCompare(parentSide, targetSide)}`);
    console.log(`   NOW     sameRepo → ${isSameRepo(parentSide, targetSide)}\n`);
    check("BEFORE it was already right here", beforeCompare(parentSide, targetSide) === true);
    check("NOW it still is — the fix changes nothing on this platform", isSameRepo(parentSide, targetSide) === true);
    console.log(
      `\n   pi builds ctx.cwd from process.cwd(), which is physical on Linux, and\n` +
        `   resolvePath normalises without canonicalising. One --cwd-style option,\n` +
        `   one platform, or one caller passing a path a person typed, and the\n` +
        "   'logical' column above is what runs.",
    );
  }

  if (MODE === "foreign") {
    const viaLink = { commonDir: commonDir(link), cwd: link };
    const viaReal = { commonDir: commonDir(repo), cwd: repo };
    const foreign = { commonDir: commonDir(other), cwd: other };
    console.log(`\nab8 [foreign] — the gate still gates (AO8)\n`);
    console.log(`   parent  ${viaReal.cwd}`);
    console.log(`   target  ${foreign.cwd}   (a different repository)\n`);
    check("a different repo is not the same repo", isSameRepo(viaReal, foreign) === false);
    check("…nor through the symlink, so canonicalising did not widen the answer", isSameRepo(viaLink, foreign) === false);
    check("a parent in no repository at all is not the same repo", isSameRepo(undefined, foreign) === false);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log();
process.exit(failures === 0 ? 0 : 1);
