/**
 * u3 — AH4. Two output caps, two spill directories, one bound.
 *
 * FIXED — this probe prints BEFORE and NOW, by driving both SHIPPED caps and
 * counting the files that really appear on disk.
 *
 * There are two output caps in this stack, and they exist separately for a
 * reason that is not duplication:
 *
 *   `.pi/extensions/compaction-guard`            hooks `tool_result`, so it
 *                                                covers every tool, including
 *                                                extension-registered ones
 *   `pi-subagents-lite/src/spawn/result-cap.ts`  a BACKGROUND subagent's answer
 *                                                is delivered by
 *                                                `sendCustomMessage`, which emits
 *                                                no `tool_result` at all — there
 *                                                is no generic hook to use
 *
 * Both keep what they cut: the model gets a head, a tail and a marker naming a
 * file, so a truncation is a redirection rather than a loss. The guard prunes its
 * directory to `MAX_SPILL_FILES`; `result-cap.ts` had copied the writer and not
 * the prune.
 *
 * The interesting part is that `result-cap.ts` already knew the rule. Its own
 * header says, about the guard's NUMBERS:
 *
 *   > A second copy of those constants here would drift away from the test that
 *   > justifies them, so this imports them instead.
 *
 * — and the prune is the same kind of thing, with the same justification, in the
 * same file it was already importing from. The bound's own docstring even names
 * the shape it exists for:
 *
 *   > An unattended `/loop` run is exactly the shape that fills a disk with them:
 *   > days of iterations, each capping the test-runner output it just produced.
 *
 * A `/loop` that delegates in the background produces exactly that, one file per
 * capped subagent answer, keyed by a record id that is unique per delegation.
 *
 *   run: node --experimental-strip-types u3-the-two-spill-directories.mjs
 */

import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const REPO = "/home/claudeuser/qwen3.8-forge";

const { capBackgroundResult } = await import(`${REPO}/vendor/pi-subagents-lite/src/spawn/result-cap.ts`);
const { MAX_SPILL_FILES } = await import(`${REPO}/.pi/extensions/compaction-guard/src/spill.ts`);
const guard = (await import(`${REPO}/.pi/extensions/compaction-guard/index.ts`)).default;

let failures = 0;
const check = (label, ok) => {
  console.log(`   ${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) failures++;
};

console.log("\nu3 — two spill directories, and only one of them was bounded\n");

/** Bigger than the 20,000-char ceiling, so both caps always fire. */
const HUGE = "z".repeat(40_000);
/** A parent at 20% of a 32k window: plenty of room, so only SIZE triggers a cap. */
const ctx = {
  ui: { notify() {} },
  model: { contextWindow: 32_768 },
  getContextUsage: () => ({ tokens: 6_554, contextWindow: 32_768, percent: 20 }),
};
const WRITES = MAX_SPILL_FILES + 12;

// ── the guard, through its real tool_result handler ─────────────────────────
const handlers = new Map();
guard({ on: (n, f) => handlers.set(n, [...(handlers.get(n) ?? []), f]) });
let guardDir;
for (let i = 0; i < WRITES; i++) {
  const event = { toolName: "bash", toolCallId: `call-${String(i).padStart(4, "0")}`, isError: false, content: [{ type: "text", text: HUGE }] };
  let out;
  for (const fn of handlers.get("tool_result") ?? []) out = await fn(event, ctx);
  const path = /Full output: (\S+)/.exec(out?.content?.[0]?.text ?? "")?.[1];
  if (path) guardDir ??= dirname(path);
}

// ── the background-result cap, through its real entry point ─────────────────
let resultDir;
for (let i = 0; i < WRITES; i++) {
  const capped = capBackgroundResult(HUGE, ctx, "Explore", `agent-${String(i).padStart(4, "0")}`);
  const path = /Full output: (\S+)/.exec(capped.text)?.[1];
  if (path) resultDir ??= dirname(path);
}

// ── what the OLD writer would have left, run for real ───────────────────────
const beforeDir = mkdtempSync(join(tmpdir(), "probe-old-result-cap-"));
for (let i = 0; i < WRITES; i++) {
  writeFileSync(join(beforeDir, `Explore-agent-${String(i).padStart(4, "0")}.txt`), HUGE, "utf8");
}

const guardFiles = readdirSync(guardDir ?? beforeDir).length;
const resultFiles = readdirSync(resultDir ?? beforeDir).length;
const beforeFiles = readdirSync(beforeDir).length;

console.log(`   ${WRITES} capped payloads of ${HUGE.length.toLocaleString()} chars each, through each cap:\n`);
console.log("      spill directory                              BEFORE   NOW");
console.log("      ───────────────────────────────────────────  ──────   ──────");
console.log(`      compaction-guard   (pi-tool-output-…)        ${String(guardFiles).padStart(6)}   ${String(guardFiles).padStart(6)}`);
console.log(`      result-cap.ts      (pi-subagent-result-…)    ${String(beforeFiles).padStart(6)}   ${String(resultFiles).padStart(6)}`);
console.log(`      the bound                                    ${String(MAX_SPILL_FILES).padStart(6)}   ${String(MAX_SPILL_FILES).padStart(6)}`);

check("the guard's directory was and is bounded", guardFiles <= MAX_SPILL_FILES);
check("the background-result directory is bounded NOW", resultFiles <= MAX_SPILL_FILES);
check("…and was not BEFORE", beforeFiles > MAX_SPILL_FILES);

// The control that matters: the prune must drop the OLDEST. A prune that took
// the wrong end would satisfy the count and lose the answer the newest marker
// names — which is the whole reason the file exists.
const newest = `Explore-agent-${String(WRITES - 1).padStart(4, "0")}.txt`;
check(
  `the NEWEST spill survives (${newest})`,
  readdirSync(resultDir ?? beforeDir).includes(newest),
);
const oldest = "Explore-agent-0000.txt";
check(`…and the oldest is the one that went (${oldest})`, !readdirSync(resultDir ?? beforeDir).includes(oldest));
check(
  "the surviving newest file still holds the whole payload",
  readFileSync(join(resultDir ?? beforeDir, newest), "utf8").length === HUGE.length,
);

console.log(`
   ${(HUGE.length * (beforeFiles - MAX_SPILL_FILES) / 1_000_000).toFixed(1)} MB of the BEFORE column is files nothing would ever have removed,
   for ${WRITES} delegations. An unattended run does that for days, into a mkdtemp
   under tmpdir(), which on this box is the container's writable layer — the same
   disk everything else is on.

   The fix is one module: .pi/extensions/compaction-guard/src/spill.ts now holds
   the writer, the bound and the reason the bound is a COUNT rather than a
   teardown sweep (spillDir is module-global and a CHILD inherits the guard by
   discovery, so parent and child share one directory and a shutdown hook on
   either would delete files the other's markers still name). Both caps import
   it, exactly as both already imported allowanceChars/planOutputCap.

   Pinned by pi-subagents-lite/tests/result-cap-spill.test.ts, which fails with
   "${WRITES} capped results left ${beforeFiles} files" when the bound is removed.
`);

console.log(failures > 0 ? `   ${failures} expectation(s) failed` : "   all expectations held");
process.exit(failures > 0 ? 1 : 0);
