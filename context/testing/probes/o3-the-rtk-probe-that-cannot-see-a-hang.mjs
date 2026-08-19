/**
 * o3 — AB3. rtk's load-time version probe reads `code` and not `killed`, so a
 * WEDGED rtk is indistinguishable from a healthy one that printed nothing.
 *
 * `vendor/rtk-pi` is one of the two packages the first ten passes never swept,
 * and it turns out to hold both halves of AA2's lesson in one file: the
 * per-command path (`rewriteCommand`) tests `result.killed` first and is right,
 * and the load-time probe forty lines above it tests only `ver.code !== 0`.
 *
 * A hang is not exotic for this binary — `rtk rewrite` reads its own config and
 * cache under `~/.local/share/rtk`, and on this box that is a 9p mount.
 *
 *   node --experimental-strip-types o3-the-rtk-probe-that-cannot-see-a-hang.mjs
 */

import { readFileSync } from "node:fs";

const PI = "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist";
const { execCommand } = await import(`${PI}/core/exec.js`);
const EXT = "../../../vendor/rtk-pi/extensions/index.ts";
const source = readFileSync(new URL(EXT, import.meta.url), "utf8");

let failures = 0;
const expect = (ok, what) => {
  if (!ok) {
    failures++;
    console.log(`  !! ${what}`);
  }
};

// ── what pi hands the probe, for each state rtk can be in ───────────────────

const REWRITE_TIMEOUT_MS = 2_000;

const CASES = [
  ["rtk is healthy", "echo 'rtk 0.45.0'", {}],
  ["rtk is not installed", "definitely-not-rtk-9x8 --version", {}],
  ["rtk is WEDGED (hangs)", "sleep 5", { timeout: 400 }],
  ["rtk is old", "echo 'rtk 0.19.3'", {}],
];

console.log("=".repeat(88));
console.log("what `pi.exec(\"rtk\", [\"--version\"])` reports, per state");
console.log("=".repeat(88));
console.log(`  ${"state".padEnd(24)} code  killed  stdout            verdict BEFORE   verdict NOW`);
console.log("  " + "-".repeat(84));

for (const [label, command, options] of CASES) {
  const r = await execCommand("bash", ["-lc", command], process.cwd(), options);
  const stdout = r.stdout.trim();

  // BEFORE: `if (ver.code !== 0) { warn; return }`, then parseSemver(stdout).
  const semver = stdout.replace(/^rtk\s+/, "").match(/(\d+)\.(\d+)\.(\d+)/);
  const before =
    r.code !== 0
      ? "not on PATH"
      : semver && Number(semver[1]) === 0 && Number(semver[2]) < 23
        ? "too old"
        : "FILTERING";
  const now = r.killed ? "wedged" : before;

  console.log(
    `  ${label.padEnd(24)} ${String(r.code).padEnd(5)} ${String(r.killed).padEnd(7)}` +
      ` ${JSON.stringify(stdout).slice(0, 17).padEnd(17)} ${before.padEnd(16)} ${now}`,
  );
}

console.log(`
  Row 3 is the finding. A wedged rtk resolves \`{ code: 0, stdout: "" }\` — because
  a SIGTERMed child exits with no code and \`execCommand\` does \`code: code ?? 0\` —
  so:

    · the "not on PATH" warning does not fire, and nothing is said;
    · \`parseSemver("")\` returns null, so the \`>= 0.23.0\` guard is SKIPPED, which
      is the one place this extension decides not to filter;
    · the tool_call handler registers, and every allow-listed command then spends
      ${REWRITE_TIMEOUT_MS}ms waiting for the same wedged binary before
      \`rewriteCommand\`'s own \`killed\` check fails it open.

  Compare rows 2 and 4: both of the states the probe was WRITTEN for are answered
  correctly. It is only the state nobody thought about that reads as healthy —
  which is AA2's shape exactly, in the package nobody had read.
`);

// ── the order, in the shipped source ───────────────────────────────────────

const probeAt = source.indexOf('pi.exec("rtk", ["--version"]');
const after = source.slice(probeAt);
const killedAt = after.indexOf("ver.killed");
const codeAt = after.indexOf("ver.code !== 0");

const rewriteAt = source.indexOf("async function rewriteCommand");
const rewriteBody = source.slice(rewriteAt, source.indexOf("export default"));

console.log("=".repeat(88));
console.log("the two call sites, in order");
console.log("=".repeat(88));
console.log(`
  rewriteCommand   result.killed at +${rewriteBody.indexOf("result.killed")}, result.code at +${rewriteBody.indexOf("result.code !== 0")}   ${
    rewriteBody.indexOf("result.killed") < rewriteBody.indexOf("result.code !== 0") ? "killed first  ✔ (was already right)" : "code first  ✘"
  }
  the version probe   ver.killed at +${killedAt}, ver.code at +${codeAt}   ${
    killedAt >= 0 && killedAt < codeAt ? "killed first  ✔ (AB3, fixed)" : "code first  ✘ (AB3)"
  }
`);

expect(killedAt >= 0, "the version probe never reads `killed`");
expect(killedAt < codeAt, "the version probe tests `code` before `killed`, which swallows a hang");
expect(
  rewriteBody.indexOf("result.killed") < rewriteBody.indexOf("result.code !== 0"),
  "rewriteCommand stopped checking `killed` first",
);

if (failures) {
  console.log(`FAILED: ${failures} expectation(s).`);
  process.exit(1);
}
console.log("ok — every expectation held.");
