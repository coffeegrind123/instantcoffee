/**
 * Y1 — a record whose VERIFIER is still running is not finished, and three
 * readers of that fact disagreed.
 *
 * ## The failure
 *
 * `attachSettlementChain` sets `record.lifecycle.status` from `classifyRun` and
 * then awaits `runVerification`. So for the whole of a judge and up to three
 * repairs — model calls, on the one llama slot the parent is blocked behind —
 * the record reads `completed` and `lifecycle.completedAt` is not stamped yet.
 * `verifyPhase` is the only field that says what is actually happening.
 *
 * `agent-widget.ts` knew: `categorizeAgents` put a verifying record in the
 * RUNNING column, with a comment saying it "is active work the user is waiting
 * on". `menu-running-agents.ts` had its own `isActive()` — `status === "running"
 * || status === "queued"` — so the same record was drawn as running in the widget
 * and listed as finished with a ✓ in `/agents`, where **Clear was the only action
 * offered for it**, and where "Clear done" and "Clear all" both reached it.
 * `AgentManager.clear()` accepted, because `isTerminalStatus` cannot see a phase
 * either.
 *
 * What clearing it does, from `removeRecord`:
 *
 *   - disposes `execution.session` — the session a repair runs IN;
 *   - opens the completion gate with `""`, so a foreground `Agent` call blocked
 *     on that gate resumes with an empty answer while the real one is still being
 *     checked;
 *   - deletes the record the verifier is about to write its verdict to.
 *
 * ## The fix
 *
 * The predicate moved to `record-activity.ts`, which imports nothing and is
 * therefore testable, and the three readers import it. The manager refuses the
 * clear; the menu stops offering it and says "checking" on the row instead.
 *
 * The behavioural half below drives the real predicates. The source pins are for
 * the two files the suite cannot load — `agent-manager.ts` imports pi and
 * `menu-running-agents.ts` imports pi-tui — and they assert the CALL, in the file
 * that makes it, which is the habit W6 paid for.
 *
 * See Y1 in `context/design/subagents-loop-verifier-turns.md`.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { isActiveRecord, isBusyRecord, isVerifyingRecord } from "../src/agents/record-activity.ts";

const source = (path: string): string =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");

/** A record in the state the settlement chain leaves one in while the judge runs. */
const verifying = () => ({ lifecycle: { status: "completed" }, verifyPhase: "judging" as const });
const repairing = () => ({ lifecycle: { status: "completed" }, verifyPhase: "repairing" as const });
const settled = () => ({ lifecycle: { status: "completed" } });
const running = () => ({ lifecycle: { status: "running" } });
const queued = () => ({ lifecycle: { status: "queued" } });

describe("Y1 — the predicate itself", () => {
  it("counts a record being judged or repaired as busy", () => {
    assert.equal(isBusyRecord(verifying()), true);
    assert.equal(isBusyRecord(repairing()), true);
  });

  it("does not count it as active — its own run really has finished", () => {
    assert.equal(isActiveRecord(verifying()), false, "the child's run is over; only the check is not");
    assert.equal(isVerifyingRecord(verifying()), true);
  });

  it("control — a settled record with no phase is neither", () => {
    assert.equal(isBusyRecord(settled()), false);
    assert.equal(isVerifyingRecord(settled()), false);
  });

  it("control — running and queued are unchanged", () => {
    assert.equal(isActiveRecord(running()), true);
    assert.equal(isActiveRecord(queued()), true);
    assert.equal(isBusyRecord(running()), true);
    assert.equal(isVerifyingRecord(running()), false);
  });
});

describe("Y1 — the readers", () => {
  it("the manager refuses to clear a record the verifier still holds", () => {
    const code = source("../src/agents/agent-manager.ts");
    const clearBody = code.slice(code.indexOf("clear(id: string): boolean"));
    const guard = clearBody.indexOf("isVerifyingRecord(record)");
    const remove = clearBody.indexOf("this.removeRecord(");
    assert.ok(guard > -1, "clear() must consult the phase, not only the status");
    assert.ok(remove > -1);
    assert.ok(guard < remove, "the refusal has to come before the record is disposed");
  });

  it("the widget categorises with the shared predicate", () => {
    const code = source("../src/ui/agent-widget.ts");
    assert.match(code, /import \{ isBusyRecord \} from "\.\.\/agents\/record-activity\.ts"/);
    assert.match(code, /if \(isBusyRecord\(a\)\)/);
  });

  it("the /agents menu offers Clear only when nothing is checking the answer", () => {
    const code = source("../src/ui/menu/menu-running-agents.ts");
    assert.match(code, /isActiveRecord, isBusyRecord, isVerifyingRecord/);
    // The Clear item, and the two bulk clears, all gated on the same question.
    //
    // The shape changed with T5: a verifying record now gets its own branch
    // offering Stop (which aborts `execution.verifyAbort`) and still no Clear
    // (which would dispose the session a repair runs in and open the completion
    // gate with ""). What this pins is that Clear is reached ONLY on the
    // not-verifying branch.
    assert.match(code, /\} else if \(isVerifying\(record\)\) \{/);
    assert.match(code, /items\.push\(\{ value: "stop", label: "Stop the answer check" \}\)/);
    assert.match(code, /\} else \{\s*items\.push\(\{ value: "clear"/);
    // …and that the verifying branch never offers it.
    const verifyingBranch = code.slice(
      code.indexOf("} else if (isVerifying(record)) {"),
      code.indexOf('items.push({ value: "clear"'),
    );
    assert.doesNotMatch(verifyingBranch, /value: "clear"/);
    assert.match(code, /const finished = agents\.filter\(\(r\) => !isBusy\(r\)\)/);
    assert.match(code, /const completed = agents\.filter\(\(r\) => r\.lifecycle\.status === "completed" && !isVerifying\(r\)\)/);
  });

  it("no reader keeps a private copy of the question", () => {
    for (const path of ["../src/ui/agent-widget.ts", "../src/ui/menu/menu-running-agents.ts"]) {
      const code = source(path);
      assert.doesNotMatch(
        code,
        /status === "running" \|\| .*status === "queued"/,
        `${path} must not re-derive "is this record active" — record-activity.ts owns it`,
      );
    }
  });
});
