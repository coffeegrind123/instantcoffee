/**
 * A goal check that CANNOT RUN is not a goal check that RAN AND FAILED.
 *
 * ## The failure this pins
 *
 * `runGoalCheck()` already distinguished the two — `execFailed` is true when
 * `pi.exec` rejects: a timeout against `checkTimeoutSeconds`, a missing
 * interpreter, a spawn failure — and exactly one line consumed the distinction,
 * an operator-facing `notify` the model never sees. Everything after it treated
 * the outcome as a failure, so all three of these were the same object:
 *
 *   - `/loop status` reported `failing (streak N)`, which is a claim about the
 *     project, when it was a claim about the check harness;
 *   - the `check_failed` directive told the model "Completion is decided by the
 *     check, not by your claim. Fix exactly what the check reports", with the
 *     spawn error standing in for what the check reports — an unanswerable
 *     instruction;
 *   - and in `--until-done` mode the loop's ONLY terminating condition quietly
 *     stopped existing. A loop designed never to stop on its own, with the one
 *     thing that could stop it removed, is a loop that runs forever.
 *
 * ## What is asserted
 *
 * That the two failures are now distinguishable everywhere a reader or the model
 * can see them, that the model is told the truth (the check is the work), that
 * the loop still refuses to complete on a claim it cannot verify, and that it
 * escalates to a pause rather than spinning — with a check that ran and failed,
 * and a check that passed, as the controls on both sides.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import loopModeExtension from "../extensions/index.ts";
import { applyCheckOutcome, MAX_CHECK_ERRORS } from "../src/goal-check.ts";
import { defaultState } from "../src/loop-state.ts";
import { completedCheck } from "./exec-shapes.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

type ExecResult = { code: number; stdout: string; stderr: string; killed?: boolean };

function makeHost(exec: () => Promise<ExecResult>) {
  const handlers = new Map<string, Handler[]>();
  const notices: string[] = [];
  const sent: { content?: unknown }[] = [];
  let command: ((args: string, ctx: unknown) => Promise<void>) | undefined;

  const pi = {
    on(name: string, fn: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), fn]);
    },
    registerCommand(_name: string, config: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      command = config.handler;
    },
    registerTool() {},
    appendEntry() {},
    sendMessage(message: { content?: unknown }) {
      sent.push(message);
    },
    exec,
    async setModel() {
      return true;
    },
  };

  const ctx = {
    cwd: process.cwd(),
    mode: "tui",
    hasUI: true,
    ui: {
      notify(message: string) {
        notices.push(String(message));
      },
      setStatus() {},
    },
    sessionManager: { getBranch: () => [], getEntries: () => [] },
    modelRegistry: { find: () => undefined, getAll: () => [] },
    model: { api: "openai-completions", contextWindow: 32_768 },
    isIdle: () => true,
    hasPendingMessages: () => false,
    getContextUsage: () => ({ tokens: 6_554, contextWindow: 32_768, percent: 20 }),
    compact() {},
    abort() {},
    async waitForIdle() {},
  };

  const fire = async (name: string, event: unknown = {}) => {
    for (const fn of handlers.get(name) ?? []) await fn(event, ctx);
  };

  const assistant = (text: string) => ({
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
    usage: { output: 40 },
  });

  return {
    notices,
    sent,
    async start(args: string) {
      loopModeExtension(pi as never);
      notices.length = 0;
      await command!(args, ctx);
    },
    async turn(text: string) {
      notices.length = 0;
      sent.length = 0;
      await fire("message_end", { message: assistant(text) });
      await fire("tool_result", {
        toolName: "edit",
        content: [{ type: "text", text: "edited src/x.ts" }],
        isError: false,
      });
      await fire("agent_end", { messages: [assistant(text)] });
      return notices.join(" | ");
    },
    /** Everything the loop injected into the model's next turn. */
    injected() {
      return sent.map((m) => String(m.content)).join("\n");
    },
    async status() {
      notices.length = 0;
      await command!("status", ctx);
      return notices.join("\n");
    },
    async stop() {
      notices.length = 0;
      await command!("stop", ctx);
    },
  };
}

const THROWS = async (): Promise<ExecResult> => {
  throw new Error("Command timed out after 120000ms");
};
// Both of these are checks that RAN, so both carry the completion marker bash's
// EXIT trap prints. A bare `{ code, stdout }` is the shape of a check the OOM
// killer reaped as well as of one that finished — see tests/exec-shapes.ts (AB1).
const FAILS = async (): Promise<ExecResult> => completedCheck(1, "2 tests failed");
const PASSES = async (): Promise<ExecResult> => completedCheck(0, "ok");

const DONE = "LOOP_DONE: everything the goal asked for is in place.";

describe("applyCheckOutcome — an unrunnable check leaves the check state alone", () => {
  it("does not move lastCheckPassed, checkFailStreak or the score", () => {
    const state = defaultState();
    applyCheckOutcome(state, { passed: false, output: "2 tests failed", execFailed: false, score: 7 });
    assert.equal(state.lastCheckPassed, false);
    assert.equal(state.checkFailStreak, 1);
    assert.equal(state.lastCheckScore, 7);

    applyCheckOutcome(state, { passed: false, output: "Error: spawn ENOENT", execFailed: true });
    assert.equal(state.lastCheckPassed, false, "unchanged — this is the LAST KNOWN result");
    assert.equal(state.checkFailStreak, 1, "an absent check is not another failure");
    assert.equal(state.lastCheckScore, 7, "and it is not a score of nothing");
    assert.equal(state.lastCheckOutput, "2 tests failed", "the model must not be shown a spawn error as check output");
    assert.equal(state.checkErrorStreak, 1);
    assert.equal(state.lastCheckError, "Error: spawn ENOENT");
  });

  it("a check that runs again clears the error streak", () => {
    const state = defaultState();
    applyCheckOutcome(state, { passed: false, output: "boom", execFailed: true });
    applyCheckOutcome(state, { passed: false, output: "boom", execFailed: true });
    assert.equal(state.checkErrorStreak, 2);
    applyCheckOutcome(state, { passed: true, output: "ok", execFailed: false });
    assert.equal(state.checkErrorStreak, 0);
    assert.equal(state.lastCheckError, "");
  });

  it("never reports a regression from a check that did not run", () => {
    const state = defaultState();
    applyCheckOutcome(state, { passed: true, output: "ok", execFailed: false, score: 10 });
    const regressed = applyCheckOutcome(state, { passed: false, output: "boom", execFailed: true });
    assert.equal(regressed, false);
  });
});

describe("the loop — a check that cannot run", () => {
  it("says which failure it is, and does not claim the project is failing", async () => {
    const host = makeHost(THROWS);
    await host.start('start make the suite green. Done when: the check passes --until-done --check "./check.sh"');
    const notice = await host.turn(DONE);
    const status = await host.status();
    await host.stop();

    assert.match(notice, /could not run \(1\/3\)/);
    assert.doesNotMatch(notice, /the goal check fails/, "that sentence belongs to a check that ran");
    assert.match(status, /LAST KNOWN/);
    assert.doesNotMatch(status, /failing \(streak/);
  });

  it("tells the model the check is the work, not the code", async () => {
    const host = makeHost(THROWS);
    await host.start('start make the suite green. Done when: the check passes --until-done --check "./check.sh"');
    await host.turn(DONE);
    const injected = host.injected();
    await host.stop();

    assert.match(injected, /could not be RUN/);
    assert.match(injected, /fix or replace `\.\/check\.sh`/i);
    assert.doesNotMatch(injected, /Fix exactly what the check reports/);
  });

  it("still refuses to complete on the model's claim alone", async () => {
    const host = makeHost(THROWS);
    await host.start('start make the suite green. Done when: the check passes --until-done --check "./check.sh"');
    await host.turn(DONE);
    const status = await host.status();
    await host.stop();

    assert.match(status, /Active: true/, '"the check decides" cannot mean "the model decides when the check is broken"');
  });

  it(`pauses after ${MAX_CHECK_ERRORS} in a row instead of running forever`, async () => {
    const host = makeHost(THROWS);
    await host.start('start make the suite green. Done when: the check passes --until-done --check "./check.sh"');
    for (let i = 0; i < MAX_CHECK_ERRORS - 1; i++) {
      assert.match(await host.status(), /Active: true/);
      await host.turn(DONE);
    }
    const last = await host.turn(DONE);
    const status = await host.status();

    assert.match(last, /Loop paused/);
    assert.match(status, /Active: false/);
    assert.match(status, /Status: paused/);
  });
});

describe("controls — a check that ran", () => {
  it("a failing check still refuses the marker and reports the streak", async () => {
    const host = makeHost(FAILS);
    await host.start('start make the suite green. Done when: the check passes --until-done --check "./check.sh"');
    const notice = await host.turn(DONE);
    const injected = host.injected();
    const status = await host.status();
    await host.stop();

    assert.match(notice, /the goal check fails/);
    assert.match(injected, /Fix exactly what the check reports/);
    assert.match(injected, /2 tests failed/);
    assert.match(status, /failing \(streak 1\)/);
    assert.doesNotMatch(status, /LAST KNOWN/);
  });

  it("a passing check still completes the loop", async () => {
    const host = makeHost(PASSES);
    await host.start('start make the suite green. Done when: the check passes --until-done --check "./check.sh"');
    const notice = await host.turn(DONE);
    const status = await host.status();

    assert.match(notice, /Loop completed/);
    assert.match(status, /Status: completed/);
  });
});
