/**
 * `/loop run` starts a NEW run. What it carries over, and what it must not.
 *
 * ## V3 — the goal check's state survived a restart it does not belong to
 *
 * `runLoop()` is what `/loop run` calls. It enumerated twenty-five fields to
 * reset and left seven pieces of per-run state standing, six of them the goal
 * check's own. `/loop start` was never affected (it goes through
 * `applyGoalConfig`, which spreads `defaultState()`), and `/loop resume` is
 * deliberately unaffected — a resumed run IS the same run. Two failures came out
 * of it:
 *
 *   - a score from run 1 made run 2's first check look like a regression, with a
 *     directive naming an iteration number from a run that had ended;
 *   - a `lastCheckPassed: true` from run 1 satisfied the `!== true` guard that
 *     U3 added precisely so "the check decides" cannot mean "the model decides
 *     when the check is broken", so an `--until-done` run 2 completed on the
 *     model's word with a check that had never run.
 *
 * ## V8 — a re-issued goal kept `preparedAt` and reset `goalFile`
 *
 * `applyGoalConfig` preserves `preparedAt` across a re-issue of the same goal, on
 * purpose — "re-issuing the same goal (e.g. to tweak flags after /loop prepare)
 * keeps the prepared spec". `goalFile` is what that flag POINTS AT, and it was
 * reset with every other flag, so both lines that exist BECAUSE the spec is
 * prepared pointed at a file nobody wrote.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import loopModeExtension from "../extensions/index.ts";
import { defaultState } from "../src/loop-state.ts";
import { CHECK_STATE_KEYS, resetCheckState } from "../src/goal-check.ts";
import { completedCheck } from "./exec-shapes.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;
type ExecStep = { code: number; stdout?: string } | { throws: string };

function makeHost(script: ExecStep[]) {
  const handlers = new Map<string, Handler[]>();
  const notices: string[] = [];
  const sent: { details?: { kind?: string }; content?: string }[] = [];
  let command: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  let call = 0;

  const pi = {
    on(name: string, fn: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), fn]);
    },
    registerCommand(_name: string, config: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      command = config.handler;
    },
    registerTool() {},
    appendEntry() {},
    sendMessage(message: { details?: { kind?: string }; content?: string }) {
      sent.push(message);
    },
    async exec() {
      const step = script[Math.min(call++, script.length - 1)];
      if ("throws" in step) throw new Error(step.throws);
      // Every step here is a check that RAN — the whole file is about what a run
      // inherits from the previous one — so each carries the completion marker
      // bash's EXIT trap prints. See tests/exec-shapes.ts (AB1).
      return completedCheck(step.code, step.stdout ?? "");
    },
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
  const assistant = (t: string) => ({
    role: "assistant",
    content: [{ type: "text", text: t }],
    stopReason: "stop",
    usage: { output: 40 },
  });

  return {
    sent,
    /** Replace the exec script for the next run. */
    rescript(next: ExecStep[]) {
      script = next;
      call = 0;
    },
    async start(args: string) {
      loopModeExtension(pi as never);
      notices.length = 0;
      await command!(args, ctx);
    },
    async run(args: string) {
      notices.length = 0;
      sent.length = 0;
      await command!(args, ctx);
      return notices.join("\n");
    },
    async turn(text: string) {
      notices.length = 0;
      await fire("message_end", { message: assistant(text) });
      await fire("tool_result", { toolName: "read", content: [{ type: "text", text: "ok" }] });
      await fire("agent_end", { messages: [assistant(text)] });
      return notices.join(" | ");
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

const line = (status: string, pattern: RegExp) => status.split("\n").find((l) => pattern.test(l)) ?? "";

describe("V3 — resetCheckState covers every field defaultState gives the check", () => {
  it("returns each one to its default", () => {
    // The list and the defaults are compared rather than restated, so a field
    // added to LoopState and to defaultState() but forgotten here fails.
    const dirty = defaultState();
    dirty.lastCheckPassed = false;
    dirty.lastCheckScore = 12;
    dirty.bestCheckScore = 99;
    dirty.bestScoreIteration = 7;
    dirty.checkFailStreak = 4;
    dirty.lastCheckOutput = "2 tests failed";
    dirty.checkErrorStreak = 2;
    dirty.lastCheckError = "Command timed out";

    resetCheckState(dirty);

    const fresh = defaultState();
    for (const key of CHECK_STATE_KEYS) {
      assert.deepEqual(dirty[key], fresh[key], `${key} was not reset`);
    }
  });
});

describe("V3 — /loop run does not inherit the previous run's check state", () => {
  it("does not report a regression against a score from a run that ended", async () => {
    const host = makeHost([{ code: 1, stdout: "SCORE: 90" }]);
    await host.start('goal improve the parser. Done when: score 100 --check ./check.sh');
    await host.run("run");
    await host.turn("Raised coverage on the tokenizer.");
    assert.match(line(await host.status(), /^Check status/), /score 90 \(best 90/);

    await host.stop();
    host.rescript([{ code: 1, stdout: "SCORE: 70" }]);
    await host.run("run");
    const notice = await host.turn("Starting on the error recovery path.");
    const status = await host.status();
    await host.stop();

    assert.doesNotMatch(notice, /regress/i, "nothing regressed — this is a different run");
    assert.match(line(status, /^Check status/), /failing \(streak 1\)/, "the streak starts at one, not two");
    assert.match(line(status, /^Check status/), /score 70 \(best 70/, "and the best score is this run's");
  });

  it("does not let a passing verdict from a previous run complete an until-done run", async () => {
    const host = makeHost([{ code: 0, stdout: "all green" }]);
    await host.start('goal ship the feature. Done when: tests pass --until-done --check ./check.sh');
    await host.run("run");
    await host.turn("Implemented it.");
    assert.match(line(await host.status(), /^Status/), /completed/);

    // Started again for more work, with the check script now broken.
    host.rescript([{ throws: "Command timed out after 120000ms" }]);
    await host.run("run");
    const notice = await host.turn("LOOP_DONE: nothing left to do.");
    const status = await host.status();
    await host.stop();

    assert.doesNotMatch(notice, /Loop completed/, "the check has never run in this run");
    assert.match(notice, /could not be run/);
    assert.match(line(status, /^Active/), /true/, "the loop keeps going and asks for the check to be fixed");
    assert.match(line(status, /^Check status/), /^Check status: -/, "no verdict, because none was reached");
  });

  it("a check that passes in the NEW run still completes it — the control", async () => {
    const host = makeHost([{ code: 0, stdout: "all green" }]);
    await host.start('goal ship the feature. Done when: tests pass --until-done --check ./check.sh');
    await host.run("run");
    await host.turn("Implemented it.");

    host.rescript([{ code: 0, stdout: "still green" }]);
    await host.run("run");
    const notice = await host.turn("Tidied the imports.");
    await host.stop();

    assert.match(notice, /Loop completed/, "a check that ran and passed decides, as it always did");
  });

  it("/loop resume keeps the check state, deliberately — the control", async () => {
    const host = makeHost([{ code: 1, stdout: "SCORE: 90" }]);
    await host.start('goal improve the parser. Done when: score 100 --check ./check.sh');
    await host.run("run");
    await host.turn("Raised coverage.");
    await host.stop();

    host.rescript([{ code: 1, stdout: "SCORE: 70" }]);
    await host.run("resume");
    const notice = await host.turn("Different subsystem.");
    await host.stop();

    // A resumed run IS the same run, so the score really did drop within it.
    assert.match(notice, /regress/i);
  });
});

describe("V8 — a re-issued goal keeps the spec it was prepared with", () => {
  it("keeps --file across a re-issue of the same goal", async () => {
    const host = makeHost([{ code: 0 }]);
    const GOAL = "port the renderer to the new API";
    await host.start(`goal ${GOAL} --file SPEC.md`);
    await host.run("prepare");
    // The readiness marker is what sets preparedAt.
    await host.turn("GOAL_READY: spec written to SPEC.md");

    await host.run(`start ${GOAL}`);
    const status = await host.status();
    const first = host.sent.find((m) => m.details?.kind === "start")?.content ?? "";
    await host.stop();

    assert.match(line(status, /^Goal file/), /SPEC\.md \(prepared\)/);
    assert.match(first, /First read SPEC\.md/, "the directive points at the spec that exists");
    assert.match(first, /Specification: SPEC\.md/);
  });

  it("an explicit --file still wins", async () => {
    const host = makeHost([{ code: 0 }]);
    const GOAL = "port the renderer to the new API";
    await host.start(`goal ${GOAL} --file SPEC.md`);
    await host.run("prepare");
    await host.turn("GOAL_READY: spec written.");
    await host.run(`start ${GOAL} --file OTHER.md`);
    const status = await host.status();
    await host.stop();

    assert.match(line(status, /^Goal file/), /OTHER\.md/);
  });

  it("a DIFFERENT goal drops both the flag and the file — the control", async () => {
    const host = makeHost([{ code: 0 }]);
    await host.start("goal port the renderer to the new API --file SPEC.md");
    await host.run("prepare");
    await host.turn("GOAL_READY: spec written.");
    await host.run("start rewrite the CSV importer");
    const status = await host.status();
    await host.stop();

    assert.match(line(status, /^Goal file/), /GOAL\.md \(not prepared\)/);
  });

  it("an unprepared re-issue still defaults to GOAL.md — the control", async () => {
    const host = makeHost([{ code: 0 }]);
    const GOAL = "port the renderer to the new API";
    await host.start(`goal ${GOAL}`);
    await host.run(`start ${GOAL}`);
    const status = await host.status();
    await host.stop();

    assert.match(line(status, /^Goal file/), /GOAL\.md \(not prepared\)/);
  });
});
