/**
 * ab9 — AO9. The one line that makes AO1's fix reach a caller.
 *
 * FIXED — and this probe exists because the fix was held by nothing for a day.
 *
 * AO1 moved `StopAgent`'s lookup from an exact `getRecord(requestedId)` to
 * `AgentManager.resolveId`, and shipped with `tests/agent-id.test.ts` (12 tests,
 * control run 5 of 12) and probe `ab1`. Both drive `resolveAgentId` — the
 * extracted rule — and neither touches the CALL:
 *
 *     const resolution = getManager()!.resolveId(requestedId);   tool-execution.ts:450
 *
 * Measured 2026-08-23: that line was put back to `getRecord(requestedId)` and
 * **1,434 tests and all 121 probes stayed green.** A live delegation caught it on
 * the first `StopAgent` call — `context/testing/subagents-loop-verifier.md` §AI.1.
 *
 * ## Why `ab1` did not do this, and why that reason did not hold
 *
 * `ab1`'s header says `tool-execution.ts` and `agent-manager.ts` import pi, so
 * neither loads under `node --experimental-strip-types` — true, and it is the
 * constraint the SUITE runs under. A probe is not the suite. `q2` has driven the
 * real `executeStopAgentTool` through **pi's own jiti** since the thirteenth
 * pass, and it is a probe about this same function. The constraint was inherited
 * from the wrong place; the technique was already in this directory.
 *
 * So this probe drives the shipped function. Both columns are the real
 * `executeStopAgentTool` over the real `AgentManager`, with **one operator
 * swapped** — the form the twenty-fourth-pass addendum in `README.md` calls the
 * strongest a BEFORE column can take:
 *
 *   NOW     the manager's own `resolveId` — the ladder in `agent-id.ts`
 *   BEFORE  `resolveId` replaced, on the instance, by the exact `Map` lookup the
 *           tool used to make: `getRecord(requested)` and nothing else
 *
 * Nothing else differs. The ids, the records, the manager, the function under
 * test and the sentence it writes are identical, so the two columns cannot
 * disagree for any reason except the finding.
 *
 *   run: node ab9-the-wiring-no-probe-drove.mjs [published|ambiguous|refusal|full]
 */

import { randomUUID } from "node:crypto";
import { createJiti } from "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";

const PI = "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
const jiti = createJiti(`file://${PI}`, { interopDefault: true, alias: { "@earendil-works/pi-coding-agent": PI } });
const R = "/home/claudeuser/qwen3.8-forge/vendor/pi-subagents-lite/src";

const shell = await jiti.import(`${R}/shell.ts`);
const { executeStopAgentTool } = await jiti.import(`${R}/agents/tool-execution.ts`);
const { AgentManager } = await jiti.import(`${R}/agents/agent-manager.ts`);
const { SHORT_ID_LENGTH } = await jiti.import(`${R}/types.ts`);

/** `agent-manager.ts:49` and `:297`, verbatim. */
const AGENT_ID_PREFIX_LENGTH = 17;
const mintId = () => randomUUID().slice(0, AGENT_ID_PREFIX_LENGTH);
/** What every model-facing surface prints, `AgentStatus` included. */
const published = (id) => id.slice(0, SHORT_ID_LENGTH);

const MODES = { published: {}, ambiguous: {}, refusal: {}, full: {} };
const MODE = process.argv[2] ?? "published";
if (!MODES[MODE]) {
  console.error(`usage: node ab9-…mjs <${Object.keys(MODES).join("|")}>`);
  process.exit(2);
}

let failures = 0;
const check = (label, ok) => {
  console.log(`   ${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) failures++;
};

/** A record in the one state `StopAgent` is meant to act on: its own run live. */
function runningRecord(id, type = "general-purpose") {
  return {
    id,
    lifecycle: { status: "running", startedAt: Date.now() - 3000, started: true },
    display: { type, description: "slow counter" },
    execution: { abortController: new AbortController(), verifyAbort: undefined, settled: false, settlementCount: 0 },
    stats: { lifetimeUsage: { input: 1, output: 1, cacheWrite: 0, cost: 0 }, toolUses: 0, turnCount: 1 },
  };
}

/** q2's harness: a real manager, reached the way both callers reach it. */
function harness(records) {
  const manager = new AgentManager();
  const agents = Object.values(manager).find((v) => v instanceof Map);
  for (const r of records) agents.set(r.id, r);
  shell.setManager(manager);
  return manager;
}

/**
 * The BEFORE column, applied to a real manager: `resolveId` reduced to the exact
 * `Map` lookup `executeStopAgentTool` used to make. This is the ONE operator that
 * differs between the columns.
 */
function makeItPreAO1(manager) {
  manager.resolveId = (requested) => {
    const record = manager.getRecord(requested);
    return record ? { kind: "resolved", id: requested } : { kind: "not-found" };
  };
  return manager;
}

const textOf = (result) => result?.content?.[0]?.text ?? "";
const stop = (id) => executeStopAgentTool(`call-${id}`, { agent_id: id }, undefined, undefined, {});

console.log(`\nab9 — the id AgentStatus printed, handed to the REAL StopAgent  [${MODE}]\n`);
console.log(`   ids are ${AGENT_ID_PREFIX_LENGTH} characters; every surface publishes ${SHORT_ID_LENGTH}\n`);

// ── published — the finding, through the shipped function ────────────────────
if (MODE === "published" || MODE === "full") {
  const N = 50;
  let beforeResolved = 0;
  let nowResolved = 0;
  let nowAborted = 0;
  let beforeRefusal = "";
  let nowSentence = "";

  for (let i = 0; i < N; i++) {
    const id = mintId();

    // BEFORE
    {
      const record = runningRecord(id);
      const manager = makeItPreAO1(harness([record]));
      const text = textOf(await stop(published(id)));
      if (/^Stopped agent/.test(text)) beforeResolved++;
      if (!beforeRefusal) beforeRefusal = text;
      manager.dispose();
    }

    // NOW
    {
      const record = runningRecord(id);
      const manager = harness([record]);
      const text = textOf(await stop(published(id)));
      if (/^Stopped agent/.test(text)) nowResolved++;
      if (record.execution.abortController.signal.aborted) nowAborted++;
      if (!nowSentence) nowSentence = text;
      manager.dispose();
    }
  }

  console.log(`   BEFORE  StopAgent(published id) stopped it : ${beforeResolved}/${N}`);
  console.log(`           what the model was told           : ${beforeRefusal}`);
  console.log("");
  console.log(`   NOW     StopAgent(published id) stopped it : ${nowResolved}/${N}`);
  console.log(`           the child's run really was aborted : ${nowAborted}/${N}`);
  console.log(`           what the model is told            : ${nowSentence}`);
  console.log("");
  check("BEFORE: the shipped tool refused every id every surface prints", beforeResolved === 0);
  check("BEFORE: and its refusal listed the id it had just rejected", (() => {
    const m = /^Agent (\S+) not found\. Running agents: (\S+)/.exec(beforeRefusal);
    return Boolean(m) && m[1] === m[2];
  })());
  check("NOW: every one of them resolves", nowResolved === N);
  check("NOW: and the run is actually aborted, not merely reported", nowAborted === N);
  check("NOW: the reply names the agent in the published spelling", (() => {
    const m = /^Stopped agent (\S+)$/.exec(nowSentence);
    return Boolean(m) && m[1].length === SHORT_ID_LENGTH;
  })());
}

// ── ambiguous — two records that share the published eight ───────────────────
if (MODE === "ambiguous" || MODE === "full") {
  const base = mintId();
  const twin = `${published(base)}${mintId().slice(SHORT_ID_LENGTH)}`;
  const a = runningRecord(base, "explore");
  const b = runningRecord(twin, "general-purpose");
  const manager = harness([a, b]);

  const text = textOf(await stop(published(base)));
  console.log(`   two records share the published eight     : ${published(base)}`);
  console.log(`   NOW     the tool answers                  : ${text}`);
  check("NOW: it reports the ambiguity instead of stopping one of them", /matches 2 agents/.test(text));
  check("NOW: and neither run was aborted", !a.execution.abortController.signal.aborted && !b.execution.abortController.signal.aborted);

  // The sentence's own advice has to work: every candidate it prints must resolve.
  const shown = /: (.+)\. Use/.exec(text)?.[1]?.split(", ") ?? [];
  console.log(`   the candidates it printed                 : ${shown.join(", ")}`);
  check("NOW: it printed two DISTINCT spellings", new Set(shown).size === 2);
  let each = 0;
  for (const s of shown) {
    const r = manager.resolveId(s);
    if (r.kind === "resolved") each++;
  }
  check("NOW: and each one resolves, so the advice is usable", each === shown.length && each === 2);
  manager.dispose();
}

// ── refusal — an id that really is absent, both columns ──────────────────────
if (MODE === "refusal" || MODE === "full") {
  const present = [runningRecord(mintId(), "explore"), runningRecord(mintId(), "general-purpose")];
  const absent = published(mintId());

  // Each offered id is fed back through the TOOL, not through the manager's
  // resolveId. That distinction is the whole of AO9: asking the manager tests the
  // ladder, which is fine either way, and says nothing about whether this call
  // site uses it. The first draft of this probe asked the manager, and its
  // `refusal` mode passed with the defect restored in the source — the same
  // mistake the finding is about, in the probe written to hold it.
  const retryThroughTheTool = async (makeManager, ids) => {
    let accepted = 0;
    for (const id of ids) {
      const records = present.map((r) => ({ ...r, execution: { ...r.execution, abortController: new AbortController() } }));
      const manager = makeManager(harness(records));
      if (/^Stopped agent/.test(textOf(await stop(id)))) accepted++;
      manager.dispose();
    }
    return accepted;
  };

  const idsIn = (text) =>
    [...(/Running agents: (.*)$/.exec(text)?.[1] ?? "").matchAll(/([0-9a-f]+) \(/g)].map((m) => m[1]);

  {
    const manager = makeItPreAO1(harness(present.map((r) => ({ ...r }))));
    const text = textOf(await stop(absent));
    console.log(`   BEFORE  asking for an absent id           : ${text}`);
    const ids = idsIn(text);
    manager.dispose();
    const accepted = await retryThroughTheTool(makeItPreAO1, ids);
    console.log(`           ids in that sentence              : ${ids.join(", ")}`);
    console.log(`           of which the SAME TOOL accepts    : ${accepted}/${ids.length}`);
    check("BEFORE: the hint offered ids", ids.length === 2);
    check("BEFORE: and retrying with one changed nothing — the loop with no exit", accepted === 0);
  }

  {
    const manager = harness(present.map((r) => ({ ...r })));
    const text = textOf(await stop(absent));
    console.log("");
    console.log(`   NOW     asking for an absent id           : ${text}`);
    const ids = idsIn(text);
    manager.dispose();
    const accepted = await retryThroughTheTool((m) => m, ids);
    console.log(`           of which the SAME TOOL accepts    : ${accepted}/${ids.length}`);
    check("NOW: an id that really is absent is still refused", /not found/.test(text));
    check("NOW: and retrying with any id the refusal offered stops that agent", ids.length === 2 && accepted === 2);
  }
}

console.log("");
if (failures) {
  console.log(`   ${failures} FAILED\n`);
  process.exit(1);
}
console.log("   all checks passed\n");
