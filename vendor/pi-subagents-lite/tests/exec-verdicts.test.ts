/**
 * exec-verdicts.test.ts — Forge fork, seventeenth pass (AH3), widened by the
 * eighteenth (AI5).
 *
 * A STANDING CHECK rather than a reproduction: every `pi.exec(…)` result in the
 * scanned roots must have its verdict read through a classifier, or must test
 * `killed` itself.
 *
 * ## The rule, and why it needs a test rather than a comment
 *
 * `ExtensionAPI.exec` is `execCommand` (pi `core/exec.js`), whose body is a
 * `new Promise((resolve) => …)` with no `reject` in it, and which resolves a
 * child it killed on its own timeout with `code: code ?? 0` — a signalled child
 * exits with a signal and no code. Measured, in `git-failure.ts`'s header:
 *
 * ```
 *   git missing   { code: 1,   stdout: "", stderr: "" ,    killed: false }
 *   not a repo    { code: 128, stdout: "", stderr: "fatal…" }
 *   timed out     { code: 0,   stdout: "", stderr: "",     killed: TRUE  }
 * ```
 *
 * So `result.code === 0` is TRUE for a probe that never answered, and a
 * code-first test reads a wedged git as a success returning the empty string.
 * That is AA2 (the loop's goal check), AB3 (rtk's version probe) and the defect
 * `git-failure.ts` was extracted for — three findings about one property of one
 * host function.
 *
 * `git-failure.ts` fixed the two call sites it was lifted out of and nothing
 * enumerated the rest. Three more in this package tested `code` first for
 * another pass, one of them under a docstring saying it used "the same strategy
 * as the worktree validator". A grep is what stops that recurring, because the
 * next `pi.exec` will be written by somebody reading a neighbour rather than
 * reading `git-failure.ts`.
 *
 * ## Why the scan reaches outside this package (AI5)
 *
 * The seventeenth pass applied the rule by hand to two call sites in
 * `.pi/extensions/stack.ts` and wrote the rest down as safe:
 *
 * > The remaining seven are script runners whose output is reported verbatim,
 * > where a wedge shows up as empty output rather than as a wrong verdict.
 * >                — `context/testing/probes/u2-…`, seventeenth pass
 *
 * Five of the seven chose a verdict from `r.code` and said a sentence about it:
 * two `compose up -d --force-recreate llama` calls on a 600-second timeout, in a
 * file whose own confirmation prompt says the cold load is "roughly 20 minutes",
 * reported *"llama recreated"* for a compose command pi had killed. **The scan
 * did not cover the file the fix had just been applied to**, which is the same
 * hole one level up: a rule with a gate on one package and a hand-application on
 * another.
 *
 * The extra root is guarded by `existsSync` so this package stays vendorable,
 * and by a control assertion PER ROOT so the guard cannot quietly turn the scan
 * off — a scan that finds nothing passes, which is the one way this kind of test
 * rots.
 *
 * Comments are stripped before the scan, for the reason the sixteenth pass's
 * `t5` learned the hard way: every module here quotes its own wiring at length,
 * and a scan for wiring must not read the prose about the wiring. A regex
 * literal's own `.exec(` is excluded the same way, and by shape rather than by
 * name — `stack.ts` parses `.env` and `docker-compose.yml` with four of them.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, "..", "src");
/**
 * The scan's own control input — a fixture this file owns, holding one host
 * `pi.exec` call. Used by the `.pi/extensions` control below so the check that
 * "the scanner is looking at the source" no longer depends on how many host
 * calls some other tree happens to contain.
 */
const SELF_CHECK = path.join(HERE, "fixtures");
/**
 * `vendor/pi-subagents-lite/tests` → the repo root → `.pi/extensions`.
 *
 * The same relative reach `src/spawn/result-cap.ts` already makes to import
 * `compaction-guard`'s output-cap constants, and for the same reason stated
 * there: the rule and the code that has to follow it are one thing.
 */
const EXTENSIONS = path.resolve(HERE, "..", "..", "..", ".pi", "extensions");

interface Root {
  label: string;
  dir: string;
  /**
   * Fewest call sites this root must contain for the scan to be believed.
   * Omitted where the tree legitimately contains none (see `.pi/extensions`).
   */
  atLeast?: number;
  /**
   * A directory the test owns with a known host call site. When present, the
   * root's control proves the scanner works by scanning this instead of relying
   * on a count that another branch can move.
   */
  selfCheck?: string;
}

const ROOTS: Root[] = [
  { label: "vendor/pi-subagents-lite/src", dir: SRC, atLeast: 3 },
  /**
   * `.pi/extensions` no longer holds any host `pi.exec` call site: the fork's
   * only ones lived in `.pi/extensions/stack.ts` (nine of them), and that file
   * was deleted with the local-model layer. The `atLeast: 5` control it used to
   * carry therefore asserted something false about the tree and rotted. The
   * control now checks `selfCheck` instead, and this row keeps the directory
   * covered so the classifier sweep still runs if a host call comes back.
   */
  { label: ".pi/extensions", dir: EXTENSIONS, selfCheck: SELF_CHECK },
];

/** Every .ts under a directory, recursively. */
function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) sources(full, out);
    else if (full.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** Block comments and line comments removed. */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/**
 * Is this line a call to a HOST `exec`, rather than `RegExp.prototype.exec`?
 *
 * The receiver is matched by name, because "any `.exec(` that is not a regex
 * literal" is not enough: `.pi/extensions/observe/src/git.ts` parses text
 * through regex CONSTANTS (`GITDIR_LINE.exec(…)`, `HEAD_REF.exec(…)`), which
 * that rule reads as host calls and the classifier sweep then flags as
 * offenders. A host call here always goes through pi — `pi.exec(…)`, or
 * `getPiInstance().exec(…)` — so those are the receivers counted, and a call the
 * scan cannot name is left alone rather than reported as a defect it is not.
 */
function isHostExec(line: string): boolean {
  return /\bpi\.exec\(/i.test(line) || /\b\w*[Ii]nstance\(?\)?\.exec\(/.test(line);
}

/** How many lines after a `.exec(` call the verdict has to be read within. */
const VERDICT_WINDOW = 12;

/** Anything that proves the result was classified rather than trusted. */
const CLASSIFIED = /classifyGitFailure|execVerdict|\.killed|killed\s*[:)]/;

function callSites(dir: string): { file: string; line: number; text: string }[] {
  const sites: { file: string; line: number; text: string }[] = [];
  for (const file of sources(dir)) {
    const lines = stripComments(readFileSync(file, "utf8")).split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!isHostExec(lines[i])) continue;
      sites.push({ file, line: i + 1, text: lines.slice(i, i + VERDICT_WINDOW).join("\n") });
    }
  }
  return sites;
}

describe("every pi.exec verdict reads `killed`, not `code` alone", () => {
  /**
   * The roots themselves, asserted by name.
   *
   * Eighteenth pass (AI5), and it is this file's own lesson pointed at itself.
   * The per-root control below catches a directory that has MOVED; it cannot
   * catch a row deleted from `ROOTS`, because a scan with one fewer root still
   * passes — measured: removing the second row took the suite from 377 tests to
   * 375 with nothing failing. A scan that finds nothing passes, and a scan that
   * is no longer asked passes even more quietly.
   */
  it("covers both roots the rule has been applied to", () => {
    assert.deepEqual(
      [...ROOTS].map((root) => root.label).sort(),
      [".pi/extensions", "vendor/pi-subagents-lite/src"],
      "a root removed here removes coverage without failing anything else",
    );
  });

  for (const root of ROOTS) {
    it(`${root.label}: has call sites to check (the control for the scan itself)`, () => {
      assert.ok(existsSync(root.dir), `${root.label} is not where the scan expects it (${root.dir})`);
      if (root.selfCheck) {
        // A tree another branch can legitimately shrink must not be the control
        // for "the scanner works" — scan a fixture this test owns instead. One
        // host call was written into it on purpose, so anything other than one
        // is a broken scanner or a broken fixture, not a fact about the tree.
        assert.ok(existsSync(root.selfCheck), `the ${root.label} self-check fixture is missing (${root.selfCheck})`);
        const found = callSites(root.selfCheck);
        assert.equal(
          found.length,
          1,
          `the scan found ${found.length} host exec call sites in the self-check fixture, expected exactly 1 — ` +
            `the scanner is not reading the source it was pointed at`,
        );
        return;
      }
      const found = callSites(root.dir);
      assert.ok(
        found.length >= (root.atLeast ?? 0),
        `the scan found ${found.length} pi.exec call sites under ${root.label}, expected at least ` +
          `${root.atLeast} — it is not looking at the source`,
      );
    });

    it(`${root.label}: discriminates a host exec from a RegExp-literal exec`, () => {
      // `isHostExec` has to match a host call by name and refuse everything that
      // only looks like one. If it stopped matching, the sweep below would pass
      // vacuously; if it started matching regex receivers — the literal at
      // `stack.ts:1024` or the named constants in `observe/src/git.ts` — the
      // sweep would flag text parsing as an exec defect. One line of each shape
      // in a controlled string pins both ends.
      const probe = [
        'const a = /x/.exec(s);', // regex literal
        'const b = GITDIR_LINE.exec(line);', // regex constant, as in observe/git.ts
        'const c = pi.exec("git", ["status"]);', // host call
        'const d = getPiInstance().exec("git", ["status"]);', // host call via the instance
      ].join("\n");
      assert.equal(
        probe.split("\n").filter(isHostExec).length,
        2,
        "the host-exec detector must count both pi exec calls and neither regex .exec",
      );
    });

    it(`${root.label}: classifies every result rather than testing result.code`, () => {
      if (!existsSync(root.dir)) return;
      const offenders = callSites(root.dir)
        .filter((site) => !CLASSIFIED.test(site.text))
        .map((site) => `${path.relative(root.dir, site.file)}:${site.line}  ${site.text.split("\n")[0].trim()}`);
      assert.deepEqual(
        offenders,
        [],
        "a pi.exec result whose verdict is read from `code` alone reads a WEDGED command as a success " +
          "returning nothing — see git-failure.ts and stack.ts's execVerdict:\n" + offenders.join("\n"),
      );
    });
  }
});
