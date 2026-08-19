/**
 * p1 — AC1. The background subagent result that stopped reaching the parent.
 *
 * `SpawnCoordinator.emitIndividualNudge` is the only route by which a background
 * subagent's answer, or any continuation's, gets into the parent's context. The
 * tenth pass (AA4) rewrote its delivery-mode choice: it deleted
 *
 *     const ctx = getSessionCtx();
 *     const parentIdle = ctx?.isIdle?.() ?? true;
 *     const deliverAs = parentIdle ? "followUp" : "steer";
 *
 * and replaced it with `const deliverAs = "followUp" as const;`. Correct on its
 * own terms — and it removed the binding for THREE readers further down that had
 * nothing to do with the ternary: the result cap's `ctx` argument and both
 * `ctx.ui.notify` calls.
 *
 * Nothing failed. This package's `lint` is `node --check` (syntax only), pi loads
 * `.ts` through jiti, which strips types without checking them, and the test that
 * pins AA4 reads the file as TEXT — it cannot, by its own admission, load a module
 * that imports pi. So the free variable shipped, and `emitIndividualNudge` threw
 * `ReferenceError: ctx is not defined` three lines before `pi.sendMessage`,
 * inside a `try` whose `catch` was written for a stale runtime and reports
 * "Result available" — to `noOpUIContext.notify`, which is `() => {}` headless.
 *
 * This drives the REAL coordinator through pi's own bundled jiti, the way `h6`,
 * `l6`, `m1` and `m2` do. Both columns are EXECUTED: the left one is a copy of the
 * shipped file with the binding taken back out, loaded and run and then removed;
 * the right one is the tree as it stands.
 *
 *   run: node p1-the-background-result-that-never-arrived.mjs
 */

import { readFileSync, rmSync, writeFileSync } from "node:fs";

import { createJiti } from "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";

const PI = "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
const jiti = createJiti(`file://${PI}`, { interopDefault: true, alias: { "@earendil-works/pi-coding-agent": PI } });
const R = "/home/claudeuser/qwen3.8-forge/vendor/pi-subagents-lite/src";

const shell = await jiti.import(`${R}/shell.ts`);
const { SpawnCoordinator } = await jiti.import(`${R}/spawn/spawn-coordinator.ts`);

let failures = 0;
const check = (label, ok) => {
  console.log(`   ${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) failures++;
};

/** A settled background record, and the session state the nudge reads at call time. */
function harness({ answer = "src/parser.ts exports parse() and tokenize().", percent = 24 } = {}) {
  const sent = [];
  const notices = [];
  const ctx = {
    ui: { notify: (m, kind) => notices.push(`${kind ?? "info"}: ${m}`) },
    model: { contextWindow: 32768 },
    getContextUsage: () => ({ tokens: Math.round((32768 * percent) / 100), contextWindow: 32768, percent }),
    isIdle: () => true,
  };
  shell.setPiInstance({ sendMessage: (m, options) => sent.push({ content: m.content, options }) });
  shell.setSessionCtx(ctx);

  const record = {
    id: "agent-0123456789ab",
    result: answer,
    verification: "passed",
    lifecycle: { status: "completed", startedAt: Date.now() - 5000, completedAt: Date.now(), started: true },
    display: { type: "general-purpose", description: "read the parser" },
    execution: { modelKey: "forge/local", settled: true, settlementCount: 1, brief: "b", spawnCtx: ctx },
    stats: {
      lifetimeUsage: { input: 10, output: 20, cacheWrite: 0, cacheRead: 0, cost: 0 },
      toolUses: 1,
      turnCount: 2,
      compactionCount: 0,
    },
  };
  const coordinator = new SpawnCoordinator({ getRecord: (id) => (id === record.id ? record : undefined) });
  return { coordinator, record, sent, notices };
}

console.log("AC1 — where a background subagent's answer ends up\n");

// ── BEFORE ────────────────────────────────────────────────────────────────────
// The defect is a MISSING binding, so the only faithful way to run it is to take
// the binding back out of the real file. A copy is written next to the original
// (so its relative imports resolve identically), loaded through the same jiti,
// and removed again — the defective build, executed, not described.
console.log("BEFORE — the tenth pass's tree: `ctx` unbound in emitIndividualNudge");
{
  const original = `${R}/spawn/spawn-coordinator.ts`;
  const copy = `${R}/spawn/spawn-coordinator.__probe-before.ts`;
  const source = readFileSync(original, "utf8");
  const bindingLine = /^\s*const ctx = getSessionCtx\(\);\s*$/m;
  check("the fix is in the tree (this probe's premise)", bindingLine.test(source));

  writeFileSync(copy, source.replace(bindingLine, "    // (AC1: the binding AA4 deleted)"), "utf8");
  try {
    const before = await jiti.import(copy);
    const { record, sent, notices } = harness();
    const coordinator = new before.SpawnCoordinator({ getRecord: (id) => (id === record.id ? record : undefined) });
    coordinator.emitIndividualNudge(record.id);
    console.log(`   messages injected : ${sent.length}`);
    console.log(`   operator told     : ${notices[0] ?? "(nothing)"}`);
    check("the answer never reaches the parent model", sent.length === 0);
    check("and the only trace is a UI line, which is a no-op headless", notices.length === 1);
  } finally {
    rmSync(copy, { force: true });
  }
}

// ── NOW ───────────────────────────────────────────────────────────────────────
console.log("\nNOW — the shipped coordinator");
{
  const { coordinator, record, sent } = harness();
  coordinator.emitIndividualNudge(record.id);
  console.log(`   messages injected : ${sent.length}`);
  console.log(`   delivery options  : ${JSON.stringify(sent[0]?.options)}`);
  console.log(`   content           : ${JSON.stringify((sent[0]?.content ?? "").slice(0, 70))}…`);
  check("the parent model is given the answer it did not block on", sent.length === 1);
  check("as a follow-up, which is AA4's own decision", sent[0]?.options?.deliverAs === "followUp");
  check("carrying the child's text", /parse\(\) and tokenize\(\)/.test(sent[0]?.content ?? ""));
}

// ── the cap, which the same binding switched off ──────────────────────────────
console.log("\nNOW — and the cap the binding also feeds (90% of the window used)");
{
  const { coordinator, record, sent, notices } = harness({ answer: "w".repeat(60_000), percent: 90 });
  coordinator.emitIndividualNudge(record.id);
  console.log(`   injected chars    : ${sent[0]?.content?.length ?? 0} (of 60,000)`);
  console.log(`   notice            : ${notices[0] ?? "(none)"}`);
  check("a 60k result is bounded against the parent's remaining window", (sent[0]?.content?.length ?? 0) < 60_000);
  check("and the cap reports through the session ctx", notices.some((n) => /capped/i.test(n)));
}

// ── controls ──────────────────────────────────────────────────────────────────
console.log("\ncontrols");
{
  const { coordinator, sent } = harness();
  coordinator.emitIndividualNudge("agent-does-not-exist");
  check("no record, no message", sent.length === 0);
}
{
  const { coordinator, record, sent } = harness();
  shell.setSessionCtx(undefined);
  coordinator.emitIndividualNudge(record.id);
  check("a session ctx that is not there yet bounds nothing, and loses nothing", sent.length === 1);
}

console.log(`\n${failures === 0 ? "all expectations met" : `${failures} expectation(s) unmet`}`);
process.exit(failures === 0 ? 0 : 1);
