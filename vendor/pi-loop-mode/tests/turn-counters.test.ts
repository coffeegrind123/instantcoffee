/**
 * The per-turn tool counter must not survive the turn it counted.
 *
 * ## The failure this pins
 *
 * `tool_result` increments `state.toolCallsThisTurn`. The reset used to sit at
 * the bottom of the `agent_end` ladder, below every early return — soft stop,
 * context pressure, model error, degenerate-repetition abort, operator abort —
 * so any turn that ended one of those ways handed its count to the next turn.
 *
 * Two things read that counter, and both are load-bearing:
 *
 *   - `emptyResponse` requires it to be zero. `isContextPressure`'s starvation
 *     rung requires `emptyResponse`, and that rung is the whole 87%-cliff fix:
 *     a clean `stop` with no text, no thinking and no tool call on a nearly full
 *     window is an out-of-room model, and it must go to context recovery rather
 *     than to the stuck ladder, which answers it by adding more prompt text.
 *   - `turnsWithoutTools`, which feeds the narration-only stuck rule.
 *
 * A stale count switched the starvation rung off for precisely the turn most
 * likely to be starved: the retry of a turn that had already failed. Measured
 * against this module at 90% context — the starved turn alone is recovered, the
 * same turn after a two-tool turn that died on a provider error is not.
 *
 * ## Control
 *
 * Each case is paired with the same turn arriving with no history behind it, so
 * a change that broke starvation detection outright would fail the suite rather
 * than pass it.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import loopModeExtension from "../extensions/index.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

/** A host whose context usage is fixed at `percent` of a 32k window. */
function makeHost(percent: number) {
  const handlers = new Map<string, Handler[]>();
  const notices: string[] = [];
  const sent: unknown[] = [];
  let command: ((args: string, ctx: unknown) => Promise<void>) | undefined;

  const pi = {
    on(name: string, fn: Handler) {
      const list = handlers.get(name) ?? [];
      list.push(fn);
      handlers.set(name, list);
    },
    registerCommand(_name: string, config: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      command = config.handler;
    },
    registerTool() {},
    appendEntry() {},
    sendMessage(message: unknown) {
      sent.push(message);
    },
    async exec() {
      return { code: 0, stdout: "", stderr: "" };
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

/** A fresh loop on a host at `percent` full. runLoop() resets every counter. */
async function loopAt(percent: number) {
  const host = makeHost(percent);
  loopModeExtension(host.pi as never);
  await host.run("start hold the line. Done when: never");
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

const toolResult = { toolName: "read", content: [{ type: "text", text: "some file" }], isError: false };

describe("state.toolCallsThisTurn is cleared for every exit from agent_end", () => {
  it("routes a starved turn to context recovery when nothing preceded it (control)", async () => {
    const host = await loopAt(90);

    host.notices.length = 0;
    await host.fire("agent_end", STARVED_TURN);

    assert.match(
      host.notices.join(" | "),
      /context pressure/i,
      "the starvation rung is the whole point of isContextPressure's emptyResponse branch",
    );
  });

  it("still routes it when the previous turn used tools and died on a provider error", async () => {
    const host = await loopAt(90);

    await host.fire("tool_result", toolResult);
    await host.fire("tool_result", toolResult);
    await host.fire("agent_end", assistantTurn("", "error", "boom"));

    host.notices.length = 0;
    await host.fire("agent_end", STARVED_TURN);

    assert.match(
      host.notices.join(" | "),
      /context pressure/i,
      "the errored turn's tool count must not mask the next turn's emptiness",
    );
  });

  it("still routes it when the previous turn used tools and was aborted by the operator", async () => {
    const host = await loopAt(90);

    await host.fire("tool_result", toolResult);
    await host.fire("agent_end", assistantTurn("some work", "aborted"));
    // AE1 (fourteenth pass): an operator abort now PAUSES the loop for real —
    // `state.active` goes false — so the ladder does not run again until the
    // operator says so. X4's fact is unchanged and is still what this asserts:
    // the aborted turn's tool count must not survive into the next turn the loop
    // does run. The drain that clears it sits above the abort branch, which is
    // exactly why it still holds across the pause.
    await host.run("resume");

    host.notices.length = 0;
    await host.fire("agent_end", STARVED_TURN);

    assert.match(host.notices.join(" | "), /context pressure/i);
  });

  it("AE1 — an aborted turn leaves the loop inactive, and the next turn does not resume it", async () => {
    const host = await loopAt(90);

    await host.fire("agent_end", assistantTurn("half a sen", "aborted"));
    assert.match(host.notices.join(" | "), /Loop paused \(turn aborted\)/);

    // The turn a person actually produces next: they answer the notice they were
    // just shown. Before the fix this ran the whole agent_end ladder on the
    // operator's own turn, advanced the iteration count and scheduled the next
    // loop iteration, with no notice at all.
    host.notices.length = 0;
    host.sent.length = 0;
    const injected = await host.fire("before_agent_start", {});
    await host.fire("agent_end", assistantTurn("answered the human"));

    assert.deepEqual(
      injected.filter(Boolean),
      [],
      "a paused loop must not tell an operator-typed turn that loop mode is active",
    );
    assert.deepEqual(
      host.sent.map((message) => (message as { customType?: string }).customType),
      [],
      "nothing may be scheduled or sent by a turn that arrives while the loop is paused",
    );
    const status = await host.run("status");
    assert.match(status, /Active: false/);
    assert.match(status, /Iterations: 0/, "a turn the loop did not drive is not one of its iterations");
  });

  it("still routes it when the previous turn was itself context pressure", async () => {
    const host = await loopAt(90);

    await host.fire("tool_result", toolResult);
    await host.fire("agent_end", STARVED_TURN); // pressure 1/3, early return
    host.notices.length = 0;
    await host.fire("agent_end", STARVED_TURN); // pressure 2/3

    assert.match(host.notices.join(" | "), /context pressure/i);
  });

  it("does not treat a turn that really did call a tool as starved", async () => {
    const host = await loopAt(90);

    await host.fire("tool_result", toolResult);
    host.notices.length = 0;
    await host.fire("agent_end", STARVED_TURN);

    assert.doesNotMatch(
      host.notices.join(" | "),
      /context pressure/i,
      "a turn with a tool call is not 'nothing said, nothing called' — the counter still has to work",
    );
  });
});

/**
 * The same shape, three lines away, and it survived the fix above.
 *
 * `interveneStuck()` arms the anti-repetition sampling penalties for
 * PENALTY_TURNS iterations; `before_provider_request` rewrites the payload while
 * the counter is above zero. The only decrement was in the "Normal continue"
 * block at the bottom of `agent_end`, so LOOP_DONE (endless mode) and
 * LOOP_BLOCKED — which are the loop's own designed-for, every-iteration outcomes
 * — never aged it, and an endless run kept temperature +0.2 and both penalties
 * at 0.5 for the rest of the session.
 */
describe("penaltyTurnsRemaining is aged by every exit from agent_end", () => {
  /** Ask the real before_provider_request handler whether the penalties are on. */
  async function penaltiesOn(host: Awaited<ReturnType<typeof loopAt>>): Promise<boolean> {
    const [result] = await host.fire("before_provider_request", { payload: { temperature: 0.7, messages: [] } });
    return result !== undefined;
  }

  /** Two identical substantial responses trip "assistant repeated the same response". */
  const REPEAT = "I will now examine the parser module and consider the options available before making any change at all.";

  async function armedLoop() {
    // 20% context, so interveneStuck takes the prompt-level rung that arms the
    // penalties rather than the saturated-context shortcut.
    const host = await loopAt(20);
    for (let i = 0; i < 2; i++) {
      await host.fire("message_end", { message: { role: "assistant", content: [{ type: "text", text: REPEAT }], stopReason: "stop" } });
      await host.fire("tool_result", toolResult);
      await host.fire("agent_end", assistantTurn(REPEAT));
    }
    assert.equal(await penaltiesOn(host), true, "the stuck intervention must have armed the penalties");
    return host;
  }

  // Bodies that differ AFTER stripVolatile() maps digit runs to "#": a series
  // that differs only by an index reads as 100% similar and re-arms the
  // intervention, which would make this measure the wrong thing.
  const BODIES = [
    "Rewrote the tokenizer to stream, and the suite is green.",
    "Split the CSV front end out of the importer; nothing else moved.",
    "Added a fixture for ragged rows and taught the reader to skip them.",
    "Replaced the buffered read with a chunked one and measured the difference.",
  ];

  async function runTurns(host: Awaited<ReturnType<typeof loopAt>>, prefix: string) {
    for (const body of BODIES) {
      const text = `${prefix}${body}`;
      await host.fire("message_end", { message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" } });
      await host.fire("tool_result", { toolName: "edit", content: [{ type: "text", text: body }], isError: false });
      await host.fire("agent_end", assistantTurn(text));
    }
  }

  it("retires them after PENALTY_TURNS normal turns (control)", async () => {
    const host = await armedLoop();
    await runTurns(host, "");
    assert.equal(await penaltiesOn(host), false, "three normal turns is what PENALTY_TURNS documents");
  });

  it("retires them across LOOP_DONE turns, which endless mode produces every iteration", async () => {
    const host = await armedLoop();
    await runTurns(host, "LOOP_DONE: ");
    assert.equal(await penaltiesOn(host), false, "the improve branch returns above the old decrement");
  });

  it("retires them across LOOP_BLOCKED turns", async () => {
    const host = await armedLoop();
    await runTurns(host, "LOOP_BLOCKED: no credential for the upload step. ");
    assert.equal(await penaltiesOn(host), false, "the unblock branch returns above the old decrement");
  });

  it("still applies them on the turns immediately after the intervention", async () => {
    // The other control: aging every exit must not retire them instantly, or the
    // sampling measure never gets the turns it was armed for.
    const host = await armedLoop();
    await host.fire("message_end", { message: { role: "assistant", content: [{ type: "text", text: BODIES[0] }], stopReason: "stop" } });
    await host.fire("tool_result", toolResult);
    await host.fire("agent_end", assistantTurn(BODIES[0]));
    assert.equal(await penaltiesOn(host), true, "one turn spent, two still owed");
  });
});

describe("turnsWithoutTools counts the turn it belongs to", () => {
  it("does not carry a completed turn's tool calls into the next narration-only turn", async () => {
    const host = await loopAt(20);

    // Turn 1: real work.
    await host.fire("tool_result", toolResult);
    await host.fire("agent_end", assistantTurn("did the thing with the parser and wrote it down"));

    // Turns 2-4: narration only. MAX_TOOLLESS_TURNS is 3, so the third must trip
    // the narration-only stuck rule — which it cannot if turn 1's count leaked.
    await host.fire("agent_end", assistantTurn("first, a plan for the parser rewrite ahead"));
    await host.fire("agent_end", assistantTurn("second, some considerations about the lexer"));
    host.notices.length = 0;
    await host.fire("agent_end", assistantTurn("third, a note on the token table layout"));

    assert.match(
      host.notices.join(" | "),
      /no tool usage for 3 turns/i,
      "three toolless turns in a row is the narration-only rule, whatever came before them",
    );
  });
});
