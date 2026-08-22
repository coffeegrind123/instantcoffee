/**
 * x6 — AK5. `passed` counted as progress, so the audit rung could not fire on
 * the runs it was written for.
 *
 * FIXED — this drives the REAL loop module for eight iterations and prints what
 * the operator would have seen, with the shipped predicate reconstructed beside
 * the real one so BEFORE is a measurement.
 *
 * ## The finding
 *
 * `hasStateChange(toolName, text, isError)` is named for a change to the
 * project. It tested the WORDS in a tool's output — any tool's — against
 *
 *   /\b(written|edited|changed|updated|created|deleted|renamed|committed
 *      |fixed|successfully|passed|installed)\b/i
 *
 * and wrote `state.lastStateChangeIteration` when it matched. The audit rung
 * reads exactly that:
 *
 *   iterationCount - lastStateChangeIteration >= NO_PROGRESS_WINDOW  (8)
 *
 * and it is the loop's only defence against eight iterations of analysis with
 * nothing to show:
 *
 *   > No concrete file/system changes were detected in the last 8 iterations.
 *   > Stop analyzing and produce a tangible artifact this turn.
 *
 * A `--until-done --check "cargo test"` run is the shape this loop exists for,
 * and on it the model re-runs the suite every iteration. `42 passed` in the
 * output pinned `lastStateChangeIteration` to the current iteration, so the
 * difference never reached 8 and the rung could not fire — on precisely the
 * runs it was written for. A `read` of a CHANGELOG did the same, and so did a
 * `grep` that matched the word `updated`.
 *
 *   run: for m in cargo jest changelog grep control-edit control-bash; do \
 *          node --experimental-strip-types x6-the-word-that-counted-as-progress.mjs $m; done
 */

import { REPO, makeHost, toolResult } from "./_host.mjs";

const loopMode = (await import(`${REPO}/vendor/pi-loop-mode/extensions/index.ts`)).default;

const MODES = {
  cargo: { tool: "bash", text: (i) => `test result: ok. 42 passed; 0 failed; finished in 1.${i}s`, expect: "audit" },
  jest: { tool: "bash", text: (i) => `Tests: 42 passed, 42 total\nTime: 1.${i}s`, expect: "audit" },
  changelog: {
    tool: "read",
    text: (i) => `CHANGELOG.md\n## 1.2.${i}\n- fixed the parser, updated the docs`,
    expect: "audit",
  },
  grep: { tool: "grep", text: (i) => `src/a.ts:1${i}: // updated by the migration`, expect: "audit" },
  "control-edit": { tool: "edit", text: (i) => `written 42 bytes to src/step-${i}.ts`, expect: "quiet" },
  "control-bash": {
    tool: "bash",
    text: (i) => `create mode 100644 src/step-${i}.ts\n 1 file changed, 3 insertions(+)`,
    expect: "quiet",
  },
};

const MODE = process.argv[2] ?? "cargo";
if (!MODES[MODE]) {
  console.error(`usage: node x6-…mjs <${Object.keys(MODES).join("|")}>`);
  process.exit(2);
}
const spec = MODES[MODE];

let failures = 0;
const check = (label, ok) => {
  console.log(`   ${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) failures++;
};

/** The shipped predicate, for the BEFORE column. */
const beforePredicate = (tool, text) =>
  ["write", "edit"].includes(tool) ||
  /\b(written|edited|changed|updated|created|deleted|renamed|committed|fixed|successfully|passed|installed)\b/i.test(
    text,
  );

console.log(`\nx6 [${MODE}] — the word that counted as progress (AK5)\n`);

const sample = spec.text(0);
console.log(`   the tool call every iteration:  ${spec.tool}`);
console.log(`   what it prints:                 ${JSON.stringify(sample)}`);
console.log(`   BEFORE, hasStateChange said:    ${beforePredicate(spec.tool, sample) ? "a change happened" : "nothing changed"}\n`);

const host = makeHost({ percent: 20 });
loopMode(host.pi);
await host.run("start investigate the flaky test. Done when: the cause is named");

let lastNotice = "";
for (let i = 0; i < 8; i++) {
  lastNotice = await host.turn({
    messages: [`Looked at hypothesis ${i}; the timing is not it.`],
    tools: [toolResult(spec.tool, spec.text(i))],
  });
}
const audits = host.sent.filter((m) => m.details?.kind === "audit");
await host.quit();

console.log(`   after 8 iterations of analysis, the loop said:\n     ${lastNotice}\n`);

if (spec.expect === "audit") {
  console.log("   BEFORE  nothing — the window never reached 8, because every");
  console.log("           iteration wrote lastStateChangeIteration.");
  console.log("   NOW     the audit rung fires and the model is told to produce");
  console.log("           something tangible.\n");
  check("the audit nudge fired", /no concrete progress/i.test(lastNotice));
  check("…and the model was actually sent the directive", audits.length === 1);
  check(
    "…which asks for a tangible artifact",
    audits.length === 1 && /tangible artifact/.test(String(audits[0].content)),
  );
} else {
  console.log("   the control: this really did change something, and the loop");
  console.log("   must not interrupt a run that is making progress.\n");
  check("no audit nudge", !/no concrete progress/i.test(lastNotice));
  check("…and nothing was sent", audits.length === 0);
}

console.log(failures === 0 ? "   all expectations held\n" : `   ${failures} expectation(s) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
