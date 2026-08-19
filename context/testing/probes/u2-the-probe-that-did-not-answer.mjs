/**
 * u2 — AH3. A `pi.exec` result whose verdict is read from `code` alone.
 *
 * FIXED — this probe prints BEFORE and NOW, and it also runs the STANDING SCAN
 * over the whole package, which is the half that stops it recurring.
 *
 * `ExtensionAPI.exec` is pi's `execCommand` (`core/exec.js`), whose body is a
 * `new Promise((resolve) => …)` with no `reject` in it, and which resolves a
 * child it killed on its own timeout with `code: code ?? 0` — a signalled child
 * exits with a signal and no code. Measured against the real function:
 *
 *     bash -lc 'sleep 5'  (timeout 400)   { code: 0,   killed: TRUE  }
 *     git rev-parse … in /               { code: 128, killed: false }
 *     a binary that is not on PATH        { code: 1,   killed: false }
 *
 * So `result.code === 0` is TRUE for a probe that never answered, and every
 * code-first test reads a wedged command as a SUCCESS RETURNING NOTHING.
 *
 * That property of that one function has now produced four findings:
 *
 *     AA2   the loop's goal check — a hung check reported as one that PASSED,
 *           which in --until-done is the only condition that ends a run
 *     AB3   rtk's `rtk --version` probe — a wedged rtk indistinguishable from a
 *           healthy one that printed nothing
 *     (—)   `worktree-validator.ts`, which is why `git-failure.ts` was extracted
 *           and which states the rule with the table above in its header
 *     AH3   three more call sites in the same package as that module, and nine
 *           in `.pi/extensions/stack.ts`
 *
 * `git-failure.ts` fixed the two call sites it was lifted out of. Nothing
 * enumerated the rest, and its header even says what it is — *"This is AA2 one
 * package over"* — which is the sentence that should have prompted the
 * enumeration.
 *
 *   run: node --experimental-strip-types u2-the-probe-that-did-not-answer.mjs
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { classifyGitFailure } from "/home/claudeuser/qwen3.8-forge/vendor/pi-subagents-lite/src/spawn/git-failure.ts";

const REPO = "/home/claudeuser/qwen3.8-forge";
const SUBAGENTS_SRC = `${REPO}/vendor/pi-subagents-lite/src`;

let failures = 0;
const check = (label, ok) => {
  console.log(`   ${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) failures++;
};

console.log("\nu2 — the probe that did not answer, read as one that said nothing\n");

// ── 1. pi's own shape, pinned out of the source rather than remembered ───────
{
  const src = readFileSync("/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/exec.js", "utf8");
  check("execCommand never rejects — no `reject` in its promise body", !/new Promise\(\((resolve|res)\s*,\s*rej/.test(src));
  check("…and it reports a signalled child's code as `code ?? 0`", /code:\s*code\s*\?\?\s*0/.test(src));
  check("…while `killed` is set by its own kill path", /killed/.test(src));
}

// ── 2. What each reading makes of a wedged probe ─────────────────────────────
const WEDGED = { code: 0, stdout: "", stderr: "", killed: true };
const EMPTY_OK = { code: 0, stdout: "", stderr: "", killed: false };
const REAL_FAIL = { code: 128, stdout: "", stderr: "fatal: not a git repository", killed: false };

console.log(`
   git rev-parse, three ways it can come back:

      result                                   code-first      classifyGitFailure
      ───────────────────────────────────────  ─────────────   ──────────────────
      { code: 0,   killed: TRUE  }  (wedged)   "" — SUCCESS    GIT_TIMEOUT
      { code: 0,   killed: false }  (silent)   "" — success    (none) — success
      { code: 128, stderr: fatal }  (no repo)  null            NOT_IN_GIT_REPO
`);
check("a wedged probe is a failure now", classifyGitFailure(WEDGED) !== undefined);
check("…and says it TIMED OUT rather than 'not a git repository'", /timed out/.test(classifyGitFailure(WEDGED) ?? ""));
check("a genuinely silent success is still a success", classifyGitFailure(EMPTY_OK) === undefined);
check("a real failure still classifies as one", classifyGitFailure(REAL_FAIL) !== undefined);

// ── 3. The standing scan — every exec verdict in the package ─────────────────
function sources(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) sources(full, out);
    else if (full.endsWith(".ts")) out.push(full);
  }
  return out;
}
/** Comments stripped: every module here quotes its own wiring, and a scan for
 *  wiring must not read the prose about the wiring (the sixteenth pass's t5). */
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

const sites = [];
for (const file of sources(SUBAGENTS_SRC)) {
  const lines = strip(readFileSync(file, "utf8")).split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!/\.exec\(/.test(lines[i])) continue;
    const window = lines.slice(i, i + 12).join("\n");
    sites.push({
      where: `${file.slice(SUBAGENTS_SRC.length + 1)}:${i + 1}`,
      classified: /classifyGitFailure|\.killed|killed\s*[:)]/.test(window),
      what: lines[i].trim().slice(0, 62),
    });
  }
}

console.log("\n   Every pi.exec verdict in vendor/pi-subagents-lite/src:\n");
for (const s of sites) {
  console.log(`      ${s.classified ? "reads killed " : "code ONLY    "}  ${s.where.padEnd(38)} ${s.what}`);
}
check(`all ${sites.length} call sites classify the result`, sites.length >= 5 && sites.every((s) => s.classified));

console.log(`
   BEFORE, three of these read \`result.code\` alone:

      agent-runner.ts   execGit          a wedged git returned "" rather than null,
                                         so detectEnv told the CHILD it was not in a
                                         git repository and gave it no branch
      menu-spawn-wizard listWorktrees    a wedged git parsed as an EMPTY LIST, and
                                         the operator was shown "no worktrees" for a
                                         probe that never answered — under a
                                         docstring saying it returns null "if git is
                                         unavailable or the command fails"
      menu-spawn-wizard isInGitRepo      under a docstring naming "the same strategy
                                         as the worktree validator", which is the
                                         module that classifies

   The scan above is the fix that lasts: the next \`pi.exec\` in this package will
   be written by somebody reading a neighbour, not by somebody reading
   git-failure.ts. tests/exec-verdicts.test.ts is the same scan as a gate.

   Out of this package and stated rather than fixed silently:
   \`.pi/extensions/stack.ts\` has nine exec sites and read \`killed\` in none of
   them. Two are now fixed — \`docker ps\`, whose empty stdout made \`/stack status\`
   report every container "not running" when the daemon merely did not answer
   within ten seconds, and \`dockerVram\`. The remaining seven are script runners
   whose output is reported verbatim, where a wedge shows up as empty output
   rather than as a wrong verdict.
`);

console.log(failures > 0 ? `   ${failures} expectation(s) failed` : "   all expectations held");
process.exit(failures > 0 ? 1 : 0);
