/**
 * exec-verdicts.test.ts — Forge fork, seventeenth pass (AH3).
 *
 * A STANDING CHECK rather than a reproduction: every `pi.exec(…)` result in this
 * package must have its verdict read through `classifyGitFailure`, or must test
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
 * Comments are stripped before the scan, for the reason the sixteenth pass's
 * `t5` learned the hard way: every module here quotes its own wiring at length,
 * and a scan for wiring must not read the prose about the wiring.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

/** Every .ts under src/, recursively. */
function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) sources(full, out);
    else if (full.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** Block comments, line comments and string literals removed. */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** How many lines after a `.exec(` call the verdict has to be read within. */
const VERDICT_WINDOW = 12;

describe("every pi.exec verdict reads `killed`, not `code` alone", () => {
  it("has at least one call site to check (the control for the scan itself)", () => {
    const found = sources(SRC).filter((file) => /\.exec\(/.test(stripComments(readFileSync(file, "utf8"))));
    assert.ok(found.length >= 3, `the scan found ${found.length} files with a .exec( call — it is not looking at the source`);
  });

  it("classifies every result rather than testing result.code", () => {
    const offenders: string[] = [];
    for (const file of sources(SRC)) {
      const lines = stripComments(readFileSync(file, "utf8")).split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (!/\.exec\(/.test(lines[i])) continue;
        const window = lines.slice(i, i + VERDICT_WINDOW).join("\n");
        if (/classifyGitFailure|\.killed|killed\s*[:)]/.test(window)) continue;
        offenders.push(`${path.relative(SRC, file)}:${i + 1}  ${lines[i].trim()}`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      "a pi.exec result whose verdict is read from `code` alone reads a WEDGED command as a success " +
        "returning nothing — see git-failure.ts:\n" + offenders.join("\n"),
    );
  });
});
