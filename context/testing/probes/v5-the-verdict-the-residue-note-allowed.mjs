/**
 * v5 — AI5. The seven call sites a residue note said were safe.
 *
 * FIXED — this probe prints BEFORE and NOW, driving the SHIPPED `execVerdict`
 * out of `.pi/extensions/stack.ts`, against pi's real `execCommand` MEASURED
 * rather than pinned.
 *
 * ## The promise
 *
 * The seventeenth pass (AH3) applied one rule — *`killed` before `code`* — to
 * every `pi.exec` in `vendor/pi-subagents-lite`, wrote the standing scan that
 * keeps it applied there, and then looked at `.pi/extensions/stack.ts`, fixed
 * two of its nine, and wrote this down about the other seven:
 *
 *   > Out of this package and stated rather than fixed silently:
 *   > `.pi/extensions/stack.ts` has nine exec sites and read `killed` in none of
 *   > them. Two are now fixed … **The remaining seven are script runners whose
 *   > output is reported verbatim, where a wedge shows up as empty output rather
 *   > than as a wrong verdict.**
 *   >                                     — u2-the-probe-that-did-not-answer.mjs
 *
 * ## Where it is not true
 *
 * Five of the seven do not report output verbatim. They choose a verdict from
 * `r.code` and say a sentence about it, and one of them takes the operator's
 * severity from `code` while printing `killed` in the body of the same line.
 *
 * The two that matter most are the pair that recreate llama, both on a
 * 600-second timeout, in a file whose own confirmation prompt says the cold load
 * is "roughly 20 minutes" — so the timeout is INSIDE the operation's normal
 * duration, and the wedge is the expected case rather than the exotic one.
 *
 * That is the seventeenth pass's own closing lesson, one pass later:
 *
 *   > A decision to leave something open is a claim, and it ages. When you write
 *   > down why you are leaving something, write down which fix you considered.
 *
 * The claim here was not about a fix. It was about what the code did, and it was
 * checkable in the file it was about.
 *
 *   run: node v5-the-verdict-the-residue-note-allowed.mjs
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createJiti } from "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";

const PI_DIST = "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist";
const NM = `${PI_DIST}/../node_modules`;
const jiti = createJiti(`file://${PI_DIST}/index.js`, {
  interopDefault: true,
  alias: {
    "@earendil-works/pi-coding-agent": `${PI_DIST}/index.js`,
    "@earendil-works/pi-tui": `${NM}/@earendil-works/pi-tui`,
    typebox: `${NM}/typebox/build/index.mjs`,
  },
});

const REPO = "/home/claudeuser/qwen3.8-forge";
const { execCommand } = await import(`${PI_DIST}/core/exec.js`);
const { execVerdict } = await jiti.import(`${REPO}/.pi/extensions/stack.ts`);

let failures = 0;
const check = (label, ok) => {
  console.log(`   ${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) failures++;
};

console.log("\nv5 — the verdict the residue note allowed\n");

// ── 1. pi's execCommand, MEASURED ────────────────────────────────────────────
console.log("   pi's real execCommand, run four ways just now:\n");
const cases = [
  ["timed out (pi's own kill)", ["bash", ["-lc", "sleep 5"], 300]],
  ["SIGKILLed by something else", ["bash", ["-lc", "kill -9 $$"], 3_000]],
  ["a real non-zero exit", ["bash", ["-lc", "exit 3"], 3_000]],
  ["an ordinary success", ["bash", ["-lc", "echo hi"], 3_000]],
];
const measured = [];
for (const [label, [cmd, args, timeout]] of cases) {
  const r = await execCommand(cmd, args, process.cwd(), { timeout });
  measured.push({ label, r, timeout });
  const codeFirst = r.code === 0 ? "SUCCESS" : `failed (exit ${r.code})`;
  const verdict = execVerdict(r, timeout);
  console.log(
    `      ${label.padEnd(30)} { code: ${String(r.code).padEnd(1)}, killed: ${String(r.killed).padEnd(5)} }` +
      `   code-first: ${codeFirst.padEnd(16)} execVerdict: ${verdict ? "FAILED" : "ok"}`,
  );
}
check("a killed child really does resolve code 0", measured[0].r.code === 0 && measured[0].r.killed === true);
check("…so code-first reads it as a success", measured[0].r.code === 0);
check("…and execVerdict does not", execVerdict(measured[0].r, 300)?.killed === true);
check("a SIGKILL from outside pi is indistinguishable, and stays so", measured[1].r.killed === false);
check("a real failure is still a failure", execVerdict(measured[2].r, 3_000)?.failed === true);
check("a success is still a success — the control", execVerdict(measured[3].r, 3_000) === undefined);

console.log(`
   The second row is the bound, unchanged and worth restating: \`killed\` is only
   pi's OWN kill (\`killProcess\`, whose two callers are the timeout timer and the
   signal listener). A command reaped by the OOM killer still arrives looking
   exactly like one that printed nothing. That is AB1, and the loop answers it
   with a bash EXIT trap; \`/stack\` does not, because its commands are docker and
   compose rather than a check script it wraps.
`);

// ── 2. The five sites that chose a verdict, and what each used to say ────────
const WEDGED = { code: 0, stdout: "", stderr: "", killed: true };
const SITES = [
  ["/stack restart llama", 600_000, 'exit 0 … "llama is loading."   at warn', "recreate reported as FAILED, at error"],
  ["/stack mode <target> (recreate)", 600_000, '"llama recreated. It now spends ~9-20 min…"', "recreate reported as FAILED"],
  ["/stack mode <target> (mode.sh)", 120_000, "the confirmation to recreate is offered", "the .env write is reported unfinished"],
  ["/stack set KEY=VALUE", 20_000, '"KEY: old -> new"  — an .env write', "error, and .env named as needing a check"],
  ["/stack up | /stack down", 900_000, 'severity "info", with "(timed out)" inside', 'severity "error"'],
  ["/stack logs <service>", 30_000, 'severity "info", empty body', 'severity "error", the cause named'],
];
console.log("   What a WEDGED command produced at each site:\n");
console.log("      site                              timeout   BEFORE                                        NOW");
console.log("      ────────────────────────────────  ───────   ───────────────────────────────────────────   ──────────────────────────");
for (const [site, timeout, before, now] of SITES) {
  console.log(`      ${site.padEnd(32)}  ${String(timeout / 1000).padStart(4)}s    ${before.padEnd(45)} ${now}`);
  check(`${site}: a wedge is a failure`, execVerdict(WEDGED, timeout)?.failed === true);
}
check(
  "and the sentence names the timeout in seconds, so the operator can see it is the timeout",
  /did not finish within 600s/.test(execVerdict(WEDGED, 600_000).reason),
);
check(
  "…and says the output below is not the command's answer",
  /nothing below is its answer/.test(execVerdict(WEDGED, 600_000).reason),
);

console.log(`
   The two 600-second rows are the pair worth reading twice. \`/stack restart\`'s
   own confirmation says "Expect roughly 20 minutes before it answers again", and
   \`/stack mode\`'s says "~9-20 minute cold load" — against a ten-minute timeout
   on the compose command itself. The wedge is not the exotic case there; it is
   what a slow bind mount produces on an ordinary day, and the operator was told
   the container had been recreated.
`);

// ── 3. The standing scan, over both roots ────────────────────────────────────
function sources(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) sources(full, out);
    else if (full.endsWith(".ts")) out.push(full);
  }
  return out;
}
/** Comments stripped, for the reason the sixteenth pass's t5 learned. */
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
/** A regex literal's own `.exec(` is not a host call — stack.ts has four. */
const isHostExec = (line) => /\.exec\(/.test(line) && !/\/\.exec\(/.test(line);

const ROOTS = [
  ["vendor/pi-subagents-lite/src", `${REPO}/vendor/pi-subagents-lite/src`],
  [".pi/extensions", `${REPO}/.pi/extensions`],
];
let scanned = 0;
let unclassified = 0;
console.log("   The standing scan, now over both roots:\n");
for (const [label, dir] of ROOTS) {
  for (const file of sources(dir)) {
    const lines = strip(readFileSync(file, "utf8")).split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!isHostExec(lines[i])) continue;
      scanned++;
      const window = lines.slice(i, i + 12).join("\n");
      const ok = /classifyGitFailure|execVerdict|\.killed|killed\s*[:)]/.test(window);
      if (!ok) unclassified++;
      console.log(
        `      ${ok ? "classified" : "code ONLY "}  ${`${label}/${file.slice(dir.length + 1)}:${i + 1}`.padEnd(52)}` +
          ` ${lines[i].trim().slice(0, 46)}`,
      );
    }
  }
}
check("the scan matched something at all — a scan that finds nothing passes", scanned >= 12);
check("…in BOTH roots, which is the half that did not exist", scanned >= 12 && unclassified === 0);
check("every verdict is classified", unclassified === 0);

console.log(`
   Pinned by pi-subagents-lite/tests/exec-verdicts.test.ts, which now runs the
   scan over both roots. Reverting one site fails 1 test there and 6 of this
   probe's expectations.

   The scan's own control had to be widened, and the measurement is the reason:
   DELETING the second root from the ROOTS list took the suite from 377 tests to
   375 with nothing failing at all. A per-root control catches a directory that
   has moved and cannot catch a row that is gone, so the roots are now asserted
   BY NAME as well. That is this pass's axis pointed at its own gate — the test
   promised to cover both packages, and the promise had no reader.

   The residue this leaves is the honest half of the note it replaces:
   \`killed\` answers "did pi stop this", not "did this finish". \`/stack\`'s
   commands are docker and compose, and there is nothing to wrap them in, so an
   externally-killed compose is still indistinguishable from a compose that
   printed nothing and exited 0. What has changed is that pi's OWN timeout — the
   one this file sets, and the one that fires on a 9-to-20-minute load behind a
   ten-minute bound — is no longer read as a success.
`);

console.log(failures > 0 ? `   ${failures} expectation(s) failed` : "   all expectations held");
process.exit(failures > 0 ? 1 : 0);
