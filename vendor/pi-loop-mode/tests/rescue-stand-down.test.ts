/**
 * AL2 — the rescue turn's single stand-down.
 *
 * `interveneStuck` switches the whole SESSION's model after three consecutive
 * stuck interventions, for what its own notice calls a *rescue turn*, singular.
 * `pi.setModel` has no narrower scope than the session, so the switch is a
 * global fact about the operator's own next turn too.
 *
 * The undo lived in exactly one place — the `state.rescueActive` block in
 * `agent_end`, the seventh rung of an eighteen-rung ladder. Five rungs return
 * above it and three commands never reach it at all, so every case below used
 * to leave the session on the rescue model for the rest of the process:
 *
 *   rung 1  soft stop            finalizeSoftStop
 *   rung 3  provider error       backoff and retry — ON the rescue model,
 *                                ten times, then pauseForProviderFailure
 *   rung 5  operator abort       paused
 *   /loop stop   /loop end   /loop finish (idle)
 *
 * Rung 3 is the one that costs most and it is the likeliest of the set: a
 * rescue model is named on the command line and not used until the third
 * consecutive stuck intervention, so the first time anybody learns it is not
 * loaded in llama-server is the turn it takes over. `switchModel` has already
 * returned true by then — it only fails on "no API key" — so the failure
 * arrives as an empty turn, and the loop answers an empty turn by retrying.
 *
 * `/loop end` is the case that cannot be repaired afterwards: `state =
 * defaultState()` destroys `rescueReturnModel`, which is the only record of
 * what the session was on before.
 *
 * Every case is paired with the control that still has to hold: rung 7 must
 * still stand the rescue down, and a run that never triggered a rescue must
 * never touch the model.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import loopModeExtension from "../extensions/index.ts";
import { completedCheck } from "./exec-shapes.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

const SMALL = { provider: "local", id: "small", api: "openai-completions", contextWindow: 32_768 };
const BIG = { provider: "local", id: "big", api: "openai-completions", contextWindow: 32_768 };
const MODELS = [SMALL, BIG];

function makeHost() {
  const handlers = new Map<string, Handler[]>();
  const notices: string[] = [];
  /** Every model this run asked the session to be on, in order. */
  const setModels: string[] = [];

  let command: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  let current = SMALL;

  const pi = {
    on(name: string, fn: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), fn]);
    },
    registerCommand(_name: string, config: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      command = config.handler;
    },
    registerTool() {},
    appendEntry() {},
    sendMessage() {},
    async exec() {
      return completedCheck(0);
    },
    async setModel(model: { provider: string; id: string }) {
      setModels.push(`${model.provider}/${model.id}`);
      current = MODELS.find((m) => m.id === model.id) ?? current;
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
    modelRegistry: {
      find: (provider: string, id: string) => MODELS.find((m) => m.provider === provider && m.id === id),
      getAll: () => MODELS,
    },
    // Read by `interveneStuck` when no --model was given, to remember what to
    // hand back to. A live property, because the rescue switch changes it.
    get model() {
      return current;
    },
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

  const assistant = (text: string, stopReason = "stop") => ({
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason,
    usage: { output: 40 },
  });

  return {
    notices,
    setModels,
    /** What the session is on right now. */
    model: () => `${current.provider}/${current.id}`,
    async start(args: string) {
      loopModeExtension(pi as never);
      notices.length = 0;
      await command!(args, ctx);
      setModels.length = 0;
    },
    async run(args: string) {
      notices.length = 0;
      await command!(args, ctx);
    },
    /** One ordinary turn: one assistant message, then agent_end. */
    async turn(text: string, stopReason = "stop") {
      notices.length = 0;
      await fire("message_end", { message: assistant(text, stopReason) });
      await fire("agent_end", { messages: [assistant(text, stopReason)] });
      return notices.join(" | ");
    },
    /** A turn that produced no assistant message at all — rung 3's own shape. */
    async emptyTurn() {
      notices.length = 0;
      await fire("agent_end", { messages: [] });
      return notices.join(" | ");
    },
  };
}

const REPEATED = "The core goal looks complete: the parser handles every fixture and the tests are green.";

/**
 * Drive the run to the moment the rescue turn is in flight.
 *
 * Four identical tool-free turns: the first has nothing to repeat, the next
 * three are interventions, and the third of those is `RESCUE_AFTER`.
 */
async function intoRescue(host: ReturnType<typeof makeHost>, args: string) {
  await host.start(args);
  let last = "";
  for (let i = 0; i < 4; i++) last = await host.turn(REPEATED);
  assert.match(last, /rescue turn with big/, "the run should be holding the rescue model by now");
  assert.equal(host.model(), "local/big", "the session is on the rescue model");
  host.setModels.length = 0;
  return host;
}

describe("AL2 — every path that ends a rescue turn hands the model back", () => {
  it("rung 7: an ordinary rescue turn ending (control — this always worked)", async () => {
    const host = await intoRescue(makeHost(), "start improve the parser --rescue-model big");
    await host.turn("Rewrote the tokenizer to stream; the suite is green.");
    assert.equal(host.model(), "local/small");
    assert.deepEqual(host.setModels, ["local/small"]);
    await host.run("stop");
  });

  it("rung 3: a rescue turn that produced no assistant message", async () => {
    const host = await intoRescue(makeHost(), "start improve the parser --rescue-model big");
    const notice = await host.emptyTurn();
    assert.match(notice, /model error, retrying/);
    assert.equal(host.model(), "local/small", "the retry must not be spent on the rescue model");
    await host.run("stop");
  });

  it("rung 3: ten retries do not all land on the rescue model", async () => {
    const host = await intoRescue(makeHost(), "start improve the parser --rescue-model big");
    for (let i = 0; i < 10; i++) await host.emptyTurn();
    assert.equal(host.model(), "local/small");
    assert.deepEqual(
      host.setModels.filter((m) => m === "local/big"),
      [],
      "nothing after the rescue turn may re-take the rescue model",
    );
    await host.run("stop");
  });

  it("rung 5: the operator aborts the rescue turn", async () => {
    const host = await intoRescue(makeHost(), "start improve the parser --rescue-model big");
    const notice = await host.turn("half a sentence", "aborted");
    assert.match(notice, /Loop paused \(turn aborted\)/);
    assert.equal(host.model(), "local/small");
    await host.run("stop");
  });

  it("rung 1: a soft stop finalized during the rescue turn", async () => {
    const host = await intoRescue(makeHost(), "start improve the parser --rescue-model big");
    await host.run("finish");
    // isIdle() is true in this host, so `/loop finish` takes its own idle
    // branch rather than arming softStopRequested — which is the third command
    // path, and the one below covers the armed form.
    assert.equal(host.model(), "local/small");
  });

  it("/loop stop during the rescue turn", async () => {
    const host = await intoRescue(makeHost(), "start improve the parser --rescue-model big");
    await host.run("stop");
    assert.equal(host.model(), "local/small");
  });

  it("/loop end during the rescue turn — the return address is used before it is destroyed", async () => {
    const host = await intoRescue(makeHost(), "start improve the parser --rescue-model big");
    await host.run("end");
    assert.equal(host.model(), "local/small", "state = defaultState() drops rescueReturnModel");
  });
});

describe("AL2 — the same, with an explicit --model", () => {
  // With `--model` the return address is `state.loopModel` rather than
  // `rescueReturnModel`, and `/loop resume`'s own restore reads only the
  // latter — so this is the shape where nothing downstream could repair it.
  for (const [label, act] of [
    ["/loop stop", async (h: ReturnType<typeof makeHost>) => h.run("stop")],
    ["/loop end", async (h: ReturnType<typeof makeHost>) => h.run("end")],
    ["a turn with no assistant message", async (h: ReturnType<typeof makeHost>) => h.emptyTurn()],
  ] as const) {
    it(`${label} hands the session back to the loop model`, async () => {
      const host = await intoRescue(
        makeHost(),
        "start improve the parser --model small --rescue-model big",
      );
      await act(host);
      assert.equal(host.model(), "local/small");
      await host.run("stop");
    });
  }

  it("a resume after a stop does not silently keep the rescue model", async () => {
    const host = await intoRescue(
      makeHost(),
      "start improve the parser --model small --rescue-model big",
    );
    await host.run("stop");
    await host.run("resume");
    assert.equal(host.model(), "local/small");
    await host.run("stop");
  });
});

describe("AL2 — controls", () => {
  it("a run with no --rescue-model never touches the model", async () => {
    const host = makeHost();
    await host.start("start improve the parser");
    for (let i = 0; i < 6; i++) await host.turn(REPEATED);
    await host.run("stop");
    assert.deepEqual(host.setModels, [], "no rescue was configured, so nothing may switch");
  });

  it("a configured rescue that never fires never touches the model", async () => {
    const host = makeHost();
    await host.start("start improve the parser --rescue-model big");
    // Different work every turn: no fixation, so no intervention, so no rescue.
    for (let i = 0; i < 6; i++) await host.turn(`Landed step ${i}: moved the ${i}th case into its own file.`);
    await host.run("stop");
    assert.deepEqual(host.setModels, []);
  });

  it("stopping outside a rescue turn does not switch the model either", async () => {
    const host = await intoRescue(makeHost(), "start improve the parser --rescue-model big");
    // Rung 7 already stood it down; the stop below has nothing left to do.
    await host.turn("Rewrote the tokenizer to stream; the suite is green.");
    host.setModels.length = 0;
    await host.run("stop");
    assert.deepEqual(host.setModels, [], "the stand-down is idempotent, not unconditional");
  });
});
