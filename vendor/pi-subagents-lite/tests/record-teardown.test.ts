/**
 * AM3 — the teardown that ended the session the verifier was running in.
 *
 * A record owns three things. `AgentManager.dispose()` ended two of them and
 * left the third — the verifier — holding a handle to one it had just disposed:
 *
 * ```
 *   record.execution.transcript?.dispose();
 *   record.execution.transcript = undefined;
 *   record.execution.session?.dispose();     ← the session a REPAIR runs in
 *   this.detachParentBinding(record);
 * ```
 *
 * `stopAgent()` has known how to end a verifying record since T5, and its own
 * comment says the abort is for "the operator's Esc, for `StopAgent`, and for
 * anything else that asked". `session_shutdown` is something else that asked.
 *
 * The consequence is not a crash, which is why it needs writing down.
 * `AgentSession.dispose()` aborts the agent and calls `_disconnectFromAgent()`,
 * so a `prompt()` afterwards still reaches the provider and its events reach
 * nobody — the repair spends a model call on the one llama slot and comes back
 * empty. `structuralVerdict("")` is `ok: false`, so `verifyAnswer` returns the
 * child's ORIGINAL answer annotated *"this answer was checked against the task
 * and did not address it"*. The check being torn down is reported to the parent
 * model as the child having failed.
 *
 * The second suite below drives the real `verifyAnswer` for both orders and
 * shows the two sentences the parent actually receives.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { teardownRecord } from "../src/agents/record-teardown.ts";
import { verifyAnswer } from "../src/agents/verify-runner.ts";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** A record with all three handles, each recording when it was ended. */
function makeRecord() {
  const order: string[] = [];
  const record = {
    execution: {
      transcript: {
        dispose() {
          order.push("transcript");
        },
      },
      verifyAbort: {
        abort() {
          order.push("verify");
        },
      },
      session: {
        dispose() {
          order.push("session");
        },
      },
    },
  };
  return { record, order };
}

describe("AM3 — one teardown, one order", () => {
  it("ends the verifier BEFORE the session it is running in", () => {
    const { record, order } = makeRecord();
    teardownRecord(record);
    assert.deepEqual(order, ["transcript", "verify", "session"]);
  });

  it("ends the verifier at all", () => {
    const { record, order } = makeRecord();
    teardownRecord(record);
    // The whole finding: `dispose()` did the other two and not this one.
    assert.ok(order.includes("verify"), "a record whose answer is still being checked must be stopped");
  });

  it("drops the handles, so nothing can prompt a disposed session afterwards", () => {
    const { record } = makeRecord();
    teardownRecord(record);
    assert.equal(record.execution.transcript, undefined);
    assert.equal(record.execution.session, undefined);
  });

  it("leaves verifyAbort in place — runVerification's own finally owns that field", () => {
    const { record } = makeRecord();
    teardownRecord(record);
    // Clearing it here would race `runVerification`'s `finally` and could leave
    // `isVerifyingRecord` reading a record as idle while its catch is running.
    assert.notEqual(record.execution.verifyAbort, undefined);
  });

  it("keeps going when one handle throws", () => {
    const order: string[] = [];
    const record = {
      execution: {
        transcript: {
          dispose() {
            order.push("transcript");
            throw new Error("transcript is gone");
          },
        },
        verifyAbort: {
          abort() {
            order.push("verify");
            throw new Error("already aborted");
          },
        },
        session: {
          dispose() {
            order.push("session");
          },
        },
      },
    };
    teardownRecord(record);
    // The record is going away either way; what matters is that nothing it owns
    // outlives it.
    assert.deepEqual(order, ["transcript", "verify", "session"]);
    assert.equal(record.execution.session, undefined);
  });

  it("a record with nothing attached is not an error", () => {
    const record = { execution: {} as { transcript?: never; verifyAbort?: never; session?: never } };
    teardownRecord(record);
    assert.equal(record.execution.session, undefined);
  });

  it("both of the manager's teardowns go through it", () => {
    const source = readFileSync(join(PACKAGE_ROOT, "src", "agents", "agent-manager.ts"), "utf8");
    // Two teardowns for one record is how they drifted in the first place: only
    // `removeRecord` cleared `execution.session`, and neither ended the
    // verifier.
    assert.equal((source.match(/teardownRecord\(record\)/g) ?? []).length, 2);
    const remove = source.slice(source.indexOf("private removeRecord("));
    assert.match(remove.slice(0, remove.indexOf("\n  }")), /teardownRecord\(record\)/);
    const dispose = source.slice(source.indexOf("  dispose() {"));
    assert.match(dispose.slice(0, dispose.indexOf("\n  }")), /teardownRecord\(record\)/);
  });
});

describe("AM3 — what the two orders hand the parent model", () => {
  const BRIEF = "List every call site of decodeFrame().";
  const ANSWER = "decodeFrame() is called from src/a.ts:12 and src/b.ts:44.";

  /** The judge always says no, so the repair is always reached. */
  const judge = async () => "VERDICT: NOT_ADDRESSED\nWHY: it lists two and there are three.";

  it("BEFORE — a repair prompting a disposed session comes back empty, and the answer is blamed", async () => {
    // A disposed AgentSession still accepts prompt(); it is simply no longer
    // subscribed to its agent, so nothing streams back and the collector's text
    // is "".
    const outcome = await verifyAnswer(
      { result: ANSWER, lifecycle: { status: "completed" } } as never,
      BRIEF,
      { judge, repair: async () => ({ text: "", status: "completed" as const }) },
      { rounds: 1 },
    );
    assert.equal(outcome.status, "failed");
    assert.match(outcome.answer, /did not address it/);
    assert.ok(outcome.answer.startsWith(ANSWER), "the answer itself survives, but it is now labelled unreliable");
  });

  it("NOW — an ABORTED verifier says the check did not happen, and blames nothing", async () => {
    // `teardownRecord` aborts `verifyAbort` first, which composes into the
    // deadline; `assertNotExpired()` then throws "the repair was stopped", and
    // `verifyAnswer`'s catch is this layer's "the check did not happen" path.
    const outcome = await verifyAnswer(
      { result: ANSWER, lifecycle: { status: "completed" } } as never,
      BRIEF,
      {
        judge,
        repair: async () => {
          throw new Error("the repair was stopped");
        },
      },
      { rounds: 1 },
    );
    assert.equal(outcome.status, "errored");
    assert.match(outcome.answer, /the check did not complete/);
    assert.doesNotMatch(outcome.answer, /did not address it/, "a torn-down check must not read as a failed answer");
    assert.ok(outcome.answer.startsWith(ANSWER));
  });
});
