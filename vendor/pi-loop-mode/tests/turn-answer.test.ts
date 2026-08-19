/**
 * The turn's ANSWER, and the window's own unit. Two readers that were each right
 * about a string and wrong about which string.
 *
 * ## W1 — a turn is not its last message
 *
 * `agent_end` asks "what did the model say this turn" three times and used to
 * get three different answers:
 *
 *   committedText                 commitTurnMemory(turnTexts, …)   — the last
 *                                 NON-EMPTY message of the turn (V2 moved
 *                                 `detectStuck` onto this)
 *   messageToText(lastAssistant)  the LAST message, text blocks only
 *                                 (`emptyResponse`, LOOP_DONE, LOOP_BLOCKED)
 *   messageToRepetitionText(…)    the LAST message, text OR thinking
 *
 * Identical for a one-message turn, which is every turn in this suite. Not
 * identical when a turn ends on a message that is not its answer, and pi runs
 * another assistant message inside the SAME turn whenever a steer or follow-up
 * arrives mid-turn (`agent-loop.js`: `while (hasMoreToolCalls ||
 * pendingMessages.length > 0)`). A background subagent's result is delivered
 * exactly that way — `SpawnCoordinator.emitIndividualNudge` sends it with
 * `deliverAs: "steer", triggerTurn: true` while the parent is busy — and since
 * `patches/forge_reasoning_passthrough.py` (2026-08-17) that extra message can be
 * reasoning-only, with no text at all.
 *
 * Measured against this module: an `--until-done` loop whose turn said
 * `LOOP_DONE:` and then thought out loud did not complete, and at >= 80% the same
 * turn was read as starved and charged to the context-recovery ladder.
 *
 * ## W2 — the near-duplicate rule compared two different units
 *
 * `commitTurnMemory` stores `PERSISTED_WINDOW.textChars` (1,500) of each answer;
 * rule 5 compared the CURRENT answer in full against that stored prefix.
 * `textSimilarity` is Jaccard over word trigrams, so a prefix scores about
 * `textChars / length` — and above roughly 1,875 characters the rule could not
 * reach SIMILARITY_THRESHOLD even for a byte-identical repeat. What that lost is
 * the case rule 5 is the ONLY rule for: a model that keeps saying almost the same
 * LONG thing, which is also the model ignoring the 1,200-character output budget
 * the loop asks for.
 *
 * ## Controls
 *
 * Every case is paired with the shape that behaved correctly before: a
 * one-message turn for W1, and a sub-1,500-character answer for W2.
 *
 * See W1 and W2 in `context/design/subagents-loop-verifier-readers.md`.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import loopModeExtension from "../extensions/index.ts";
import { PERSISTED_WINDOW } from "../src/loop-state.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

function makeHost(percent = 20) {
  const handlers = new Map<string, Handler[]>();
  const notices: string[] = [];
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
    sendMessage() {},
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

  const fire = async (name: string, event: unknown = {}) => {
    for (const fn of handlers.get(name) ?? []) await fn(event, ctx);
  };

  return {
    notices,
    async start(args: string) {
      loopModeExtension(pi as never);
      notices.length = 0;
      await command!(args, ctx);
    },
    /** One whole turn: N assistant messages, then the tool results, then agent_end. */
    async turn(messages: unknown[], tools: { tool: string; text: string }[] = []) {
      notices.length = 0;
      for (const message of messages) await fire("message_end", { message });
      for (const call of tools) {
        await fire("tool_result", { toolName: call.tool, content: [{ type: "text", text: call.text }] });
      }
      await fire("agent_end", { messages });
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

const answered = (t: string) => ({
  role: "assistant",
  content: [{ type: "text", text: t }],
  stopReason: "stop",
  usage: { output: 40 },
});

/** The shape the forge reasoning patch introduced: reasoning, and no answer. */
const thought = (t: string) => ({
  role: "assistant",
  content: [{ type: "thinking", thinking: t }],
  stopReason: "stop",
  usage: { output: 126 },
});

const DONE = "LOOP_DONE: the feature is shipped and the tests pass.";
const AFTERTHOUGHT =
  "the operator asked whether it is shipped and I have already said so, so there is nothing further to do";

describe("W1 — the turn's answer is the last message that answered", () => {
  it("completes an --until-done run whose turn ends on a reasoning-only message", async () => {
    const host = makeHost(20);
    await host.start("start ship the feature. Done when: the feature is shipped --until-done");

    const notice = await host.turn([answered(DONE), thought(AFTERTHOUGHT)]);

    assert.match(notice, /Loop completed/);
    assert.match(await host.status(), /Active: false/);
  });

  it("control — the same marker on a one-message turn, which always worked", async () => {
    const host = makeHost(20);
    await host.start("start ship the feature. Done when: the feature is shipped --until-done");

    assert.match(await host.turn([answered(DONE)]), /Loop completed/);
  });

  it("does not read a turn that answered as starved, however it ended", async () => {
    // At >= CONTEXT_STARVATION_PERCENT the same turn used to reach the starvation
    // rung: `emptyResponse` was true because the LAST message had no text and the
    // turn made no tool call, so a turn that answered was charged to the recovery
    // ladder and its marker was never looked at.
    const host = makeHost(90);
    await host.start("start ship the feature. Done when: the feature is shipped --until-done");

    const notice = await host.turn([answered(DONE), thought(AFTERTHOUGHT)]);

    assert.doesNotMatch(notice, /context pressure/);
    assert.match(notice, /Loop completed/);
  });

  it("control — a turn that answered NOTHING is still starved at 90%", async () => {
    // V1's case, which has to survive: no text anywhere in the turn, no tool call.
    const host = makeHost(90);
    await host.start("start ship the feature");

    const notice = await host.turn([thought("I have nothing to add this turn, the work looks complete to me")]);

    assert.match(notice, /context pressure/);
    // The operator-facing notify says which of the two it was; the detail lives
    // on `lastNotice`, which /loop status prints.
    assert.match(await host.status(), /reasoning-only response/);
    await host.stop();
  });

  it("control — a turn that made a tool call is not starved, whatever it said", async () => {
    const host = makeHost(90);
    await host.start("start ship the feature");

    const notice = await host.turn([thought("reading the entry point before deciding")], [
      { tool: "read", text: "export function main() {}" },
    ]);

    assert.doesNotMatch(notice, /context pressure/);
    await host.stop();
  });

  it("the marker still has to be in the ANSWER, not in the reasoning", async () => {
    // The other direction, and it must not move: a model that talks itself into
    // completion inside its own thinking has not reported completion.
    const host = makeHost(20);
    await host.start("start ship the feature. Done when: the feature is shipped --until-done");

    const notice = await host.turn([thought(`I could write ${DONE} here but I will not`)]);

    assert.doesNotMatch(notice, /Loop completed/);
    await host.stop();
  });
});

describe("W2 — the near-duplicate rule and the window's own bound", () => {
  /** Distinct word trigrams, so the shingle set grows with the text. */
  const pool = Array.from({ length: 4_000 }, (_, i) => `w${i.toString(36)}x`);
  let seed = 12_345;
  const next = () => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648);
  const base = Array.from({ length: 1_000 }, () => pool[next() % pool.length]);

  /** Turn N's answer: the same paragraph with one word in forty swapped. */
  const rephrase = (words: number, turn: number) =>
    base
      .slice(0, words)
      .map((word, i) => (i % 40 === turn % 40 ? pool[(i * 7_919 + turn) % pool.length] : word))
      .join(" ");

  async function fourRephrasedTurns(words: number) {
    const host = makeHost(20);
    await host.start("start refactor the parser");
    const notices: string[] = [];
    for (let turn = 0; turn < 4; turn++) {
      // A distinct tool result each turn, so the repeated-signature rule cannot
      // be what fires.
      notices.push(
        await host.turn([answered(rephrase(words, turn))], [{ tool: "read", text: `file-${turn}.ts body ${turn}` }]),
      );
    }
    await host.stop();
    return notices;
  }

  it("catches a rephrasing longer than the stored window", async () => {
    assert.ok(rephrase(500, 0).length > PERSISTED_WINDOW.textChars, "the case only exists above the bound");

    const notices = await fourRephrasedTurns(500);

    assert.match(notices[1], /similar to previous/);
    assert.match(notices[2], /Loop stuck \(2x\)/);
  });

  it("control — the same rephrasing under the bound, which always worked", async () => {
    assert.ok(rephrase(200, 0).length < PERSISTED_WINDOW.textChars, "the control has to be the other side of it");

    const notices = await fourRephrasedTurns(200);

    assert.match(notices[1], /similar to previous/);
  });

  it("control — two genuinely different long answers are not stuck", async () => {
    const host = makeHost(20);
    await host.start("start refactor the parser");

    await host.turn([answered(base.slice(0, 500).join(" "))], [{ tool: "read", text: "a" }]);
    const notice = await host.turn([answered(base.slice(500, 1_000).join(" "))], [{ tool: "read", text: "b" }]);

    assert.doesNotMatch(notice, /similar to previous/);
    await host.stop();
  });

  it("the window's char bound lives with its length bounds", () => {
    // `commitTurnMemory`'s comment says the bounds come from PERSISTED_WINDOW so
    // the in-memory window and the persisted one cannot drift. `textChars` was the
    // one that did not, which is also why the comparison had no way to know it.
    assert.equal(typeof PERSISTED_WINDOW.textChars, "number");
    assert.ok(PERSISTED_WINDOW.textChars > 0);
  });
});
