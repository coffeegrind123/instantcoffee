/**
 * The two defects that let an unattended run spin forever on the local stack.
 *
 * Both were found in one live session on 2026-08-27 — `/loop` against
 * Qwen3.8-27B through forge — and they compound, which is why they are pinned in
 * one file. The run made zero file changes across 33 iterations and roughly 45
 * minutes of continuous GPU time, and the operator ended it by hand.
 *
 * ## AP1 — an empty turn was counted as narration
 *
 * `emptyResponse` (no answer text, no tool call) is computed in `agent_end` and
 * had exactly ONE reader: the context-pressure rung, which only looks at it when
 * the window is nearly full. Below that threshold the turn fell through to the
 * ordinary accounting, where it counted as one narration turn — so THREE of them
 * were needed before the stuck ladder fired.
 *
 * On this stack an empty turn is not a cheap wait. Measured from the same run:
 * llama-server generated the full 8,192-token cap on every one of them (~85 s of
 * GPU each), and what came back through forge was `content: []` with no usage,
 * no finish_reason and no log line — the model had been cut off mid-tool-call,
 * and forge's tool-error budget outlived its attempt budget, so `run_inference`
 * fell out of its own loop and returned None. `patches/forge_empty_turn.py` is
 * that half; this half is that the loop must not answer such a turn by waiting
 * for two more of them.
 *
 * ## AP2 — the stuck streak could never reach rung 2
 *
 * `interveneStuck` sets `turnsWithoutTools = 0`, so after a narration-only
 * verdict the NEXT turn cannot be stuck under that rule however silent it is:
 * the rule needs MAX_TOOLLESS_TURNS of them and the counter was just zeroed. The
 * streak was cleared on any non-stuck turn, so it was retired one turn after
 * every intervention and never reached 2 — with the hard reset (3), the rescue
 * model (3) and the compaction (5) unreachable for the whole run.
 *
 * The evidence is in `.pi-loop-log.jsonl` from that session: six `stuck` events
 * over 33 iterations, every single one of them `"stuckStreak":1`.
 *
 * ## Controls
 *
 * Every case is paired. A fix that simply intervened more often would pass the
 * first half of this file and fail the controls: a turn that says something is
 * still not an empty turn, and a turn that calls a tool still ends the run of
 * stuck turns on the spot.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import loopModeExtension from "../extensions/index.ts";
import { completedCheck } from "./exec-shapes.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

function makeHost() {
  const handlers = new Map<string, Handler[]>();
  const notices: string[] = [];

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
    async setModel() {
      return true;
    },
  };
  let command: ((args: string, ctx: unknown) => Promise<void>) | undefined;

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
    model: { api: "openai-completions", contextWindow: 98_304 },
    isIdle: () => true,
    hasPendingMessages: () => false,
    // 20% of a 96k window — the fill the live run was at when it wedged was 66%,
    // and both are far below every saturation rung. The context is not the
    // explanation here, which is the whole point: these turns are empty with
    // room to spare.
    getContextUsage: () => ({ tokens: 19_660, contextWindow: 98_304, percent: 20 }),
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
    async start(args: string) {
      loopModeExtension(pi as never);
      notices.length = 0;
      await command!(args, ctx);
    },
    /** A turn that said something, with optional tool calls. */
    async turn(text: string, tools: { tool: string; text: string }[] = []) {
      notices.length = 0;
      await fire("message_end", { message: assistant(text) });
      for (const call of tools) {
        await fire("tool_result", {
          toolName: call.tool,
          content: [{ type: "text", text: call.text }],
          isError: false,
        });
      }
      await fire("agent_end", { messages: [assistant(text)] });
      return notices.join(" | ");
    },
    /**
     * What forge actually delivered, 20+ times in a row: an assistant message
     * with no content blocks at all, reported as a natural stop. No
     * `message_end` fires for it, which is why the turn buffers stay empty.
     */
    async emptyTurn() {
      notices.length = 0;
      await fire("agent_end", {
        messages: [{ role: "assistant", content: [], stopReason: "stop", usage: { output: 0 } }],
      });
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

const streakOf = (status: string): number =>
  Number(/stuck streak: (\d+)/.exec(status)?.[1] ?? -1);

describe("AP1 — an empty turn is a failed turn, not narration", () => {
  it("intervenes on the FIRST empty turn", async () => {
    const host = makeHost();
    await host.start("continue GOAL.md");
    const first = await host.emptyTurn();
    const status = await host.status();
    await host.stop();

    assert.match(first, /stuck \(1x\)/, "one empty turn is already the whole signal there is");
    assert.match(first, /empty turn/i, "and the operator is told which shape it was");
    assert.equal(streakOf(status), 1);
  });

  it("control — a turn that SAYS something is not an empty turn", async () => {
    const host = makeHost();
    await host.start("continue GOAL.md");
    const first = await host.turn("Reading the importer to see how the ragged-row case is wired.");
    const status = await host.status();
    await host.stop();

    assert.doesNotMatch(first, /stuck/i, "narration is still given the three turns its rule asks for");
    assert.equal(streakOf(status), 0);
  });

  it("control — a turn that called a tool is not an empty turn either", async () => {
    const host = makeHost();
    await host.start("continue GOAL.md");
    const first = await host.turn("", [{ tool: "bash", text: "ok" }]);
    const status = await host.status();
    await host.stop();

    assert.doesNotMatch(first, /stuck/i, "a pure tool-call turn answers with the tool call");
    assert.equal(streakOf(status), 0);
  });
});

describe("AP2 — the streak is what the ladder spends, so it has to survive", () => {
  it("consecutive empty turns climb the ladder instead of resetting it", async () => {
    const host = makeHost();
    await host.start("continue GOAL.md");
    const seen: number[] = [];
    for (let i = 0; i < 5; i++) {
      await host.emptyTurn();
      seen.push(streakOf(await host.status()));
    }
    await host.stop();

    // Before the fix this was [1, 0, 1, 0, 1]: every intervention zeroed
    // `turnsWithoutTools`, the next turn could not be stuck under that rule, and
    // the streak was cleared by it. The rescue model and the hard reset are at 3
    // and the compaction is at 5 — none of them were reachable.
    assert.deepEqual(seen, [1, 2, 3, 4, 5], "five empty turns are five stuck turns in a row");
  });

  it("a narration-only run reaches rung 2, which is what the ladder is for", async () => {
    const host = makeHost();
    await host.start("continue GOAL.md");
    // Three turns with text and no tool call is what the narration-only rule
    // fires on. Each line differs, so no repetition rule can claim the verdict.
    const first = ["Reading the loader.", "Considering the reader.", "Weighing two options."];
    for (const text of first) await host.turn(text);
    assert.match(await host.status(), /stuck streak: 1/);

    // Three more of the same. The intervention zeroed the counter, so this is
    // the earliest the rule can fire again — and it must find the streak it left.
    const second = ["Thinking about the parser.", "Reviewing the plan.", "Listing the remaining work."];
    let last = "";
    for (const text of second) last = await host.turn(text);
    const status = await host.status();
    await host.stop();

    assert.match(last, /stuck \(2x\)/, "the second run of narration is the second in a row");
    assert.equal(streakOf(status), 2);
  });

  it("control — one tool call ends the run of stuck turns on the spot", async () => {
    const host = makeHost();
    await host.start("continue GOAL.md");
    for (const text of ["Reading the loader.", "Considering the reader.", "Weighing two options."]) {
      await host.turn(text);
    }
    assert.equal(streakOf(await host.status()), 1);

    // The evidence the narration-only rule is missing is a tool call, so a tool
    // call is what retires the streak — not merely the next turn arriving.
    await host.turn("Grepped for the handler; it is in reader/rows.ts.", [
      { tool: "bash", text: "reader/rows.ts:42" },
    ]);
    const status = await host.status();
    await host.stop();

    assert.equal(streakOf(status), 0, "a turn that used a tool is not stuck in the way the rule means");
  });

  it("control — the repetition rules still clear on a different answer", async () => {
    const host = makeHost();
    await host.start("continue GOAL.md");
    const REPEATED =
      "The core goal looks complete: the parser handles every fixture in the suite and the tests are green.";
    // Armed by a repetition rule, with tool calls throughout, so the
    // narration-only marker never stands.
    await host.turn(REPEATED, [{ tool: "bash", text: "ok" }]);
    assert.match(await host.turn(REPEATED, [{ tool: "bash", text: "ok" }]), /stuck \(1x\)/);

    await host.turn("Split the CSV front end out of the importer; nothing else moved.", [
      { tool: "edit", text: "edited src/importer.ts" },
    ]);
    const status = await host.status();
    await host.stop();

    assert.equal(streakOf(status), 0, "a turn that stops repeating is evidence on its own");
  });
});
