/**
 * AF2 — the operator's action, and the answer nobody read.
 *
 * `AgentManager.abort()`, `.clear()` and `.steer()` each answer with a boolean,
 * and each of those `false`s is a deliberate refusal:
 *
 *   abort   the record is not running, not queued and not verifying — it
 *           finished while the menu was open, which is when `/agents` is open
 *   clear   it is still running, or its answer is still being checked, which is
 *           Y1: `removeRecord` disposes the session a repair is running in, and
 *           opens the completion gate with "" under a parent that is waiting for
 *           the real answer
 *   steer   still settling, no session, streaming, or the model's concurrency
 *           slot is full — and at this fork's default of 1 that last one is
 *           every continuation attempted while any other agent runs
 *
 * Five of the six call sites discarded the answer:
 *
 *   menu   Stop        → "Stopped 1a2b3c4d"
 *   menu   Clear       → "Cleared 1a2b3c4d"
 *   menu   Stop all    → "Stopped 3 agent(s)"        from a stale snapshot
 *   menu   Clear all   → "Cleared 7 finished agent(s)"      "
 *   menu   Clear done  → "Cleared 4 completed agent(s)"     "
 *   viewer steer       → nothing at all, anywhere
 *
 * The sixth — the menu's single-agent Steer — has always read it, which is what
 * makes this a `W`-shaped finding rather than an oversight: the rule existed and
 * was applied to the instance in front of it.
 *
 * See AF2 in `context/design/subagents-loop-verifier-omissions.md`.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  bulkReport,
  clearReport,
  steerReport,
  stopReport,
  undeliveredSteersReport,
} from "../src/ui/action-report.ts";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

describe("AF2 — what the operator is told when the manager says no", () => {
  it("a stop that did not happen does not say it did", () => {
    assert.match(stopReport(true, "1a2b3c4d").text, /^Stopped 1a2b3c4d/);
    const refused = stopReport(false, "1a2b3c4d");
    assert.doesNotMatch(refused.text, /^Stopped/);
    assert.match(refused.text, /already finished/);
  });

  it("a stop that hit the verifier says which run it stopped", () => {
    // The child's own run really did finish, so "Stopped X" alone would be a
    // claim about that one. Same sentence as the StopAgent tool's (AD2).
    assert.match(stopReport(true, "1a2b3c4d", true).text, /answer check/);
  });

  it("a clear that was refused says which of the two reasons it was", () => {
    assert.match(clearReport(true, "x").text, /^Cleared x/);
    assert.match(clearReport(false, "x", true).text, /answer checked/);
    assert.match(clearReport(false, "x", false).text, /still running/);
    // …and neither of them is an "info" line the operator will scroll past.
    assert.equal(clearReport(false, "x", true).level, "warning");
    assert.equal(clearReport(false, "x", false).level, "warning");
  });

  it("a steer that was refused names the reason the operator can act on", () => {
    const refused = steerReport(false, "x", "continue");
    assert.match(refused.text, /concurrency slot/, "at a limit of 1 this is the ordinary cause");
    assert.match(refused.text, /Nothing was sent/, "and the operator has to know their text did not go");
    assert.equal(refused.level, "error");
    assert.match(steerReport(true, "x").text, /Steer sent/);
  });

  it("a bulk action counts what happened, not what was on screen", () => {
    assert.equal(bulkReport("Cleared", 7, 7).text, "Cleared 7 agent(s)");
    const partial = bulkReport("Cleared", 6, 7);
    assert.match(partial.text, /6 of 7/);
    assert.match(partial.text, /still busy/);
    assert.equal(partial.level, "warning");
    assert.match(bulkReport("Stopped", 0, 0).text, /Nothing to stop/);
  });
});

/**
 * AG5 — the two verbs' refusals are opposites, and they shared one sentence.
 *
 * `AgentManager.clear()` refuses a running or a verifying record, so "still
 * busy" is exactly right for a partial Clear. `AgentManager.stopAgent()` has one
 * reachable `return false` and it is the `status !== "running"` arm, reached
 * only after the queued and the verifying cases have been handled — so a refused
 * Stop always means the record had already FINISHED, which is the one thing the
 * shared sentence ruled out. The module's own `stopReport` has said so since
 * AF2; this pins that the bulk path says it too.
 *
 * The `stopAgent` source is read here rather than restated, because the claim
 * "a refused stop means already finished" is a claim about that function and it
 * is the thing that would silently stop being true.
 */
describe("AG5 — what a partial bulk action actually refused", () => {
  const manager = readFileSync(join(PACKAGE_ROOT, "src", "agents", "agent-manager.ts"), "utf8");
  const stopBody = manager.slice(manager.indexOf("private stopAgent("), manager.indexOf("private removeRecord("));

  it("the premise: stopAgent refuses only a record that has finished", () => {
    assert.equal(
      (stopBody.match(/return false;/g) ?? []).length,
      1,
      "a second `return false` would be a second meaning for the same report",
    );
    assert.match(stopBody, /else if \(record\.lifecycle\.status !== "running"\) \{\s+return false;/);
    // …and the verifying case is intercepted ABOVE it and returns true (T5), so
    // "not running" here really does exclude every kind of busy.
    assert.ok(
      stopBody.indexOf("isVerifyingRecord(record) && record.execution.verifyAbort") <
        stopBody.indexOf("return false;"),
    );
  });

  it("a partial Stop says they had finished, not that they were busy", () => {
    const partial = bulkReport("Stopped", 2, 3);
    assert.match(partial.text, /2 of 3/);
    assert.match(partial.text, /already finished/);
    assert.doesNotMatch(partial.text, /still busy/, "the one thing a refused stop cannot mean");
    assert.equal(partial.level, "warning");
  });

  it("a partial Clear still says they were busy — that one was always right", () => {
    const partial = bulkReport("Cleared", 6, 7);
    assert.match(partial.text, /still busy/);
    assert.doesNotMatch(partial.text, /already finished/);
  });

  it("and it agrees with the single-agent sentence for the same refusal", () => {
    assert.match(stopReport(false, "1a2b3c4d").text, /already finished/);
    assert.match(clearReport(false, "1a2b3c4d", false).text, /still running/);
  });

  it("the count reads as a sentence at one as well as at many", () => {
    assert.match(bulkReport("Cleared", 6, 7).text, /1 was still busy and was left alone/);
    assert.match(bulkReport("Cleared", 5, 7).text, /2 were still busy and were left alone/);
  });
});

describe("AF2 — the wiring", () => {
  const menu = readFileSync(join(PACKAGE_ROOT, "src", "ui", "menu", "menu-running-agents.ts"), "utf8");
  const events = readFileSync(join(PACKAGE_ROOT, "src", "events.ts"), "utf8");

  it("no call site drops the manager's answer any more", () => {
    // The shape of the defect, as a text search: a bare call whose value is not
    // read. Written as an absence assertion, so the thirteenth pass's rule
    // applies — the control is the positive assertions below, which fail if the
    // calls move or are renamed.
    assert.doesNotMatch(menu, /^\s*getManager\(\)\?\.(abort|clear)\([^)]*\);\s*$/m);
    assert.match(menu, /const stopped = getManager\(\)\?\.abort\(record\.id, "user"\) === true;/);
    assert.match(menu, /const cleared = getManager\(\)\?\.clear\(record\.id\) === true;/);
  });

  it("the bulk actions re-derive their targets when the action is chosen", () => {
    // Not from `running` / `finished` / `completed`, which are snapshotted
    // before `ctx.ui.custom` opens — the menu is open exactly while agents are
    // settling, so those arrays describe a world several seconds old.
    const apply = menu.slice(menu.indexOf("const applyBulk ="));
    const body = apply.slice(0, apply.indexOf("\n    };"));
    assert.match(body, /manager\?\.listAgents\(\) \?\? \[\]/);
    assert.match(body, /if \(ok === true\) applied\+\+;/);
    assert.match(body, /bulkReport\(verb, applied, targets\.length\)/);
  });

  it("both viewers report a steer the agent refused", () => {
    for (const [name, source] of [
      ["menu-running-agents.ts", menu],
      ["events.ts", events],
    ] as const) {
      assert.match(source, /steerReport\(/, `${name} must read the boolean`);
      assert.match(source, /await manager\?\.steer\(record\.id, msg\)/, `${name} must await it`);
    }
  });

  it("and the callback cannot take the process down with it", () => {
    // The viewer calls `this.onSteer?.(message)` without awaiting, so a
    // rejection would surface as an unhandled rejection — which node treats as
    // fatal. Both callbacks catch their own.
    for (const source of [menu, events]) {
      const at = source.indexOf("async (msg: string) => {");
      assert.ok(at > 0);
      const body = source.slice(at, at + 900);
      assert.match(body, /try \{/);
      assert.match(body, /\} catch \(err\) \{/);
    }
  });
});

/**
 * AI3 — the steer that was accepted for a session that never opened.
 *
 * `AgentManager.steer()` returns `true` for a steer it parks in
 * `record.execution.pendingSteers`, so `steerReport(true, …)` says "Steer sent
 * to X…". The comment beside the push is the promise it rests on:
 *
 * ```ts
 *   // Queued, so it WILL reach the model — onSessionCreated flushes it.
 * ```
 *
 * `onSessionCreated` fires from `createAndConfigureSession`, and everything
 * `runAgentImpl` does before that — the settings manager, the system-prompt
 * sources, `detectEnv`'s two git subprocesses, and `reloadAndMap()`, which runs
 * every extension factory — is a window in which the record is already `running`
 * and there is no session. A run that dies in it never flushes, and until now
 * said nothing: the operator had been told it was sent, and `growBrief` had
 * already put it in the brief the judge checks the answer against.
 */
describe("AI3 — a queued steer that never reached a session", () => {
  const src = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
  const manager = readFileSync(join(src, "agents", "agent-manager.ts"), "utf8");

  it("says the steer was not delivered, and what to do instead", () => {
    const report = undeliveredSteersReport(1, "1a2b3c4d");
    assert.match(report.text, /1a2b3c4d/);
    assert.match(report.text, /never delivered/);
    assert.match(report.text, /Re-send/);
    assert.equal(report.level, "warning");
  });

  it("counts, because the queue is a queue", () => {
    assert.match(undeliveredSteersReport(1, "x").text, /the steer queued for it was/);
    assert.match(undeliveredSteersReport(3, "x").text, /the 3 steers queued for it were/);
  });

  it("says the answer was not written with them — that is the part the parent acts on", () => {
    assert.match(undeliveredSteersReport(2, "x").text, /answer was not written with them/);
  });

  it("the wiring: the settlement chain reports and clears the queue", () => {
    const at = manager.indexOf("private reportUndeliveredSteers");
    assert.ok(at > 0, "the report has to exist somewhere the settlement can reach");
    const body = manager.slice(at, manager.indexOf("\n  }", at));
    assert.match(body, /record\.execution\.pendingSteers = undefined/, "or a continuation reports it twice");
    assert.match(body, /console\.warn\(/, "noOpUIContext.notify is () => {} headless");
    assert.match(body, /spawnCtx\?\.ui\?\.notify/);
    // Called from the one place every settlement passes through — the same
    // `.finally` that releases the slot and opens the gate.
    const settle = manager.slice(manager.indexOf("private attachSettlementChain"));
    assert.match(settle.slice(0, settle.indexOf("\n  private")), /this\.reportUndeliveredSteers\(record\)/);
  });

  it("the premise: steer() still answers true for a queued one", () => {
    // The finding is not that queueing is wrong — it is that the promise had no
    // backstop. If this branch ever stops returning true the sentence above is
    // describing something that no longer happens.
    const at = manager.indexOf("async steer(id: string, message: string)");
    const body = manager.slice(at, at + 900);
    assert.match(body, /record\.execution\.pendingSteers\.push\(message\)/);
    assert.match(body, /this\.growBrief\(record, message\)/, "which is why the brief can outrun the child");
  });
});
