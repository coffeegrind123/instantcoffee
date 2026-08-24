/**
 * Every way the loop stops being active must leave the turn's buffers empty —
 * and `/loop resume` must NOT empty them itself.
 *
 * ## The item this closes
 *
 * Carried since the eighth pass as "`/loop resume` is the one lifecycle
 * transition of nine that does not clear the turn buffers", and re-listed
 * unchanged for four more. Reading the branch is what kept it open: `resume`
 * plainly does not call `resetTurnBuffers()` while `stop`, `end` and the idle
 * `finish` all do, and an odd one out looks like an omission.
 *
 * It is not one, and the reason is in two halves.
 *
 * THE FIRST HALF: there is nothing left to drain. `agent_end` returns at its
 * first line when `state.active` is false, which is why a path that deactivates
 * the loop from OUTSIDE that handler has to drain for itself — X4's defect, and
 * the reason `stop` and `end` carry the call. Every other way the loop
 * deactivates happens INSIDE `agent_end`, below the drain at the top of it:
 * the provider pause, the check pause, the operator abort, the iteration cap,
 * and both completions. By the time `resume` runs, the buffers are already
 * empty however the run stopped.
 *
 * THE SECOND HALF, and it is why adding the call would be a defect rather than
 * a tidy-up: `resume` is also how an operator UNDOES a soft stop, and a soft
 * stop is requested MID-TURN. `/loop finish` on a busy loop sets
 * `softStopRequested` and lets the turn finish; `/loop resume` before that turn
 * ends clears the flag with the turn still running. Draining there would throw
 * away the tool count and buffered text of a turn that is still in flight, and
 * `agent_end` would then read a turn that used tools as one that used none —
 * which is X4's failure, introduced by the fix for X4.
 *
 * ## How it is observed
 *
 * `state.toolCallsThisTurn` is module-private, so these tests read it the way
 * `turn-counters.test.ts` does: through a consequence. `emptyResponse` requires
 * the count to be zero and `isContextPressure`'s starvation rung requires
 * `emptyResponse`, so at 90% context a clean empty turn is reported as "context
 * pressure" if and only if the count was drained. The notice is the instrument.
 *
 * Every case is paired: the drained paths assert the notice APPEARS, and the
 * soft-stop-undo case asserts it does NOT — with a control run beside it, on the
 * same host, proving the notice would have appeared if the count had been zero.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import loopModeExtension from "../extensions/index.ts";
import { completedCheck, signalledCheck, type ExecResult } from "./exec-shapes.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

/**
 * The same host `turn-counters.test.ts` uses, with two knobs it does not need:
 * `idle`, because `/loop stop` and `/loop finish` take completely different
 * branches on it, and `exec`, because one of the nine transitions is the goal
 * check giving up.
 */
function makeHost(percent: number, exec: () => Promise<ExecResult> = async () => completedCheck(1)) {
  const handlers = new Map<string, Handler[]>();
  const notices: string[] = [];
  const sent: unknown[] = [];
  let command: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  let idle = true;

  const pi = {
    on(name: string, fn: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), fn]);
    },
    registerCommand(_name: string, config: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      command = config.handler;
    },
    registerTool() {},
    appendEntry() {},
    sendMessage(message: unknown) {
      sent.push(message);
    },
    exec() {
      return exec();
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
    isIdle: () => idle,
    hasPendingMessages: () => false,
    getContextUsage: () => ({
      tokens: Math.round((32_768 * percent) / 100),
      contextWindow: 32_768,
      percent,
    }),
    compact() {},
    abort() {},
    async waitForIdle() {},
  };

  return {
    pi,
    ctx,
    notices,
    sent,
    setIdle(value: boolean) {
      idle = value;
    },
    fire: async (name: string, event: unknown = {}) => {
      const out: unknown[] = [];
      for (const fn of handlers.get(name) ?? []) out.push(await fn(event, ctx));
      return out;
    },
    run: async (args: string) => {
      notices.length = 0;
      await command!(args, ctx);
      return notices.join("\n");
    },
  };
}

async function loopAt(percent: number, args = "start hold the line. Done when: never", exec?: () => Promise<ExecResult>) {
  const host = makeHost(percent, exec);
  loopModeExtension(host.pi as never);
  await host.run(args);
  return host;
}

const assistantTurn = (text: string, stopReason = "stop", errorMessage?: string) => ({
  messages: [
    {
      role: "assistant",
      content: text ? [{ type: "text", text }] : [],
      stopReason,
      errorMessage,
      usage: { output: text ? 40 : 1 },
    },
  ],
});

/** The 87%-cliff turn: clean stop, nothing said, nothing called. */
const STARVED_TURN = assistantTurn("", "stop");
const TOOL_RESULT = { toolName: "read", content: [{ type: "text", text: "some file" }], isError: false };

const sawPressure = (notices: string[]) => /context pressure/i.test(notices.join(" | "));

describe("every deactivation drains, so the resume after it starts clean", () => {
  it("control — a starved turn on a fresh loop is recognised", async () => {
    // If this ever fails the rest of the file is measuring nothing.
    const host = await loopAt(90);
    host.notices.length = 0;
    await host.fire("agent_end", STARVED_TURN);
    assert.ok(sawPressure(host.notices), "the starvation rung is the instrument these tests read");
  });

  it("control — and it is NOT recognised while a tool count is still standing", async () => {
    // The other direction, on the same host: this is what a missed drain looks
    // like, and it is what every case below has to avoid.
    const host = await loopAt(90);
    await host.fire("tool_result", TOOL_RESULT);
    host.notices.length = 0;
    await host.fire("agent_end", STARVED_TURN);
    assert.ok(!sawPressure(host.notices), "a turn that used a tool is not a starved turn");
  });

  it("/loop stop on a busy loop, then resume", async () => {
    const host = await loopAt(90);
    host.setIdle(false);
    await host.fire("tool_result", TOOL_RESULT);
    await host.fire("tool_result", TOOL_RESULT);
    await host.run("stop");
    await host.run("resume");

    host.notices.length = 0;
    await host.fire("agent_end", STARVED_TURN);
    assert.ok(sawPressure(host.notices), "stop drains for itself — agent_end never sees the turn");
  });

  it("/loop finish while idle, then resume", async () => {
    const host = await loopAt(90);
    await host.fire("tool_result", TOOL_RESULT);
    await host.run("finish");
    await host.run("resume");

    host.notices.length = 0;
    await host.fire("agent_end", STARVED_TURN);
    assert.ok(sawPressure(host.notices), "the idle finish branch is the tenth transition and drains too");
  });

  it("the provider pause, then resume", async () => {
    const host = await loopAt(90);
    // Ten consecutive provider errors is MAX_PROVIDER_ERRORS. The tool calls go
    // on the turn that trips the pause, which is the one whose count could
    // survive it.
    for (let i = 0; i < 9; i += 1) await host.fire("agent_end", assistantTurn("", "error", "boom"));
    await host.fire("tool_result", TOOL_RESULT);
    await host.fire("agent_end", assistantTurn("", "error", "boom"));
    assert.match(host.notices.join(" | "), /paused/i, "ten in a row must pause the run");

    await host.run("resume");
    host.notices.length = 0;
    await host.fire("agent_end", STARVED_TURN);
    assert.ok(sawPressure(host.notices), "the provider pause runs below agent_end's drain");
  });

  it("the goal-check pause, then resume", async () => {
    // A check whose process died without running its EXIT trap: pi reports
    // success and the missing marker is the only evidence, which is what
    // `execFailed` is for.
    const host = await loopAt(90, 'start ship it --check "npm test" --until-done', async () => signalledCheck());
    await host.fire("agent_end", assistantTurn("working"));
    await host.fire("agent_end", assistantTurn("working"));
    await host.fire("tool_result", TOOL_RESULT);
    await host.fire("agent_end", assistantTurn("working"));
    assert.match(host.notices.join(" | "), /paused/i, "MAX_CHECK_ERRORS in a row must pause the run");

    await host.run("resume");
    host.notices.length = 0;
    await host.fire("agent_end", STARVED_TURN);
    assert.ok(sawPressure(host.notices), "the check pause runs below agent_end's drain");
  });

  it("the iteration cap, then resume", async () => {
    const host = await loopAt(90, "start hold the line --max 1");
    await host.fire("tool_result", TOOL_RESULT);
    await host.fire("agent_end", assistantTurn("did one iteration"));

    await host.run("resume");
    host.notices.length = 0;
    await host.fire("agent_end", STARVED_TURN);
    assert.ok(sawPressure(host.notices), "the cap pause runs below agent_end's drain");
  });

  it("a verified completion, then resume", async () => {
    const host = await loopAt(90, 'start ship it --check "npm test" --until-done', async () => completedCheck(0));
    await host.fire("tool_result", TOOL_RESULT);
    await host.fire("agent_end", assistantTurn("done"));
    assert.match(host.notices.join(" | "), /passed|complete/i, "a passing check ends an until-done run");

    await host.run("resume");
    host.notices.length = 0;
    await host.fire("agent_end", STARVED_TURN);
    assert.ok(sawPressure(host.notices), "completion runs below agent_end's drain too");
  });
});

describe("…and resume must not drain, because it also undoes a soft stop", () => {
  it("keeps the in-flight turn's tool count when it cancels a pending soft stop", async () => {
    const host = await loopAt(90);
    host.setIdle(false);

    await host.fire("tool_result", TOOL_RESULT);
    await host.fire("tool_result", TOOL_RESULT);
    // The turn is STILL RUNNING: `/loop finish` on a busy loop only sets the
    // flag, and `/loop resume` is the documented way to take it back.
    const finished = await host.run("finish");
    assert.match(finished, /soft stop/i);
    const resumed = await host.run("resume");
    assert.match(resumed, /resumed/i);

    host.notices.length = 0;
    await host.fire("agent_end", STARVED_TURN);
    assert.ok(
      !sawPressure(host.notices),
      "the turn used two tools; a resume that drained would make agent_end read it as starved"
    );
  });

  it("and the same host reports pressure once a turn really has ended", async () => {
    // The control for the case above. Same host, same 90%, but with the counts
    // legitimately drained by an agent_end — so the absence asserted there is
    // the tool count and not something about this host.
    const host = await loopAt(90);
    host.setIdle(false);
    await host.fire("tool_result", TOOL_RESULT);
    await host.run("finish");
    await host.run("resume");
    await host.fire("agent_end", assistantTurn("finished the work"));

    host.notices.length = 0;
    await host.fire("agent_end", STARVED_TURN);
    assert.ok(sawPressure(host.notices), "one completed turn later, the count is gone");
  });
});
