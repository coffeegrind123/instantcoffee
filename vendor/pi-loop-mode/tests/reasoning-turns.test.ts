/**
 * A reasoning-only turn, and the two places the loop stopped recognising one.
 *
 * ## What changed underneath
 *
 * `patches/forge_reasoning_passthrough.py` (commit e81a7e5, 2026-08-17) fixed a
 * defect in the forge proxy: when llama.cpp produced reasoning and no
 * accompanying text, forge dropped the `reasoning_content` key entirely and pi
 * recorded a clean, successful, EMPTY turn. The patch put the reasoning back on
 * the wire, so pi now maps it onto a thinking block and the same turn arrives as
 * `content: [thinking]` rather than `content: []`.
 *
 * That commit's own message names the hazard, and `vendor/prinny-channel` was
 * changed in the same commit to keep noticing ("said nothing is not the same as
 * has no blocks"). This package was not, and it consumes the same shape twice.
 *
 * ## V1 — the starvation rung read "empty" as "no text AND no thinking"
 *
 * `emptyResponse` fed `isContextPressure`'s starvation rung: a clean `stop` with
 * nothing in it, at or above CONTEXT_STARVATION_PERCENT, is an out-of-room model
 * and belongs on the recovery path rather than in front of the stuck ladder,
 * which answers it by adding more prompt text to the context that caused it. The
 * flag required no thinking either, which was the same test until the patch.
 *
 * After it, a starved turn was counted as a SUCCESSFUL iteration — and the
 * success path resets `consecutiveErrorCount`, `contextCooldownCount` and
 * `contextCompressionLevel`, so the ladder could never accumulate the three
 * consecutive failures it needs.
 *
 * ## V2 — the window held a string the comparison rules could not see
 *
 * `commitTurnMemory` fills the fingerprint, snippet and text windows from
 * `messageToText(m) || messageToRepetitionText(m)`; `detectStuck` was handed
 * `messageToText(lastAssistant)`, and three of its comparisons are gated on that
 * string's length while a fourth tests whether it ends in "?". For a thinking-only
 * message those guards measure the empty string.
 *
 * ## Controls
 *
 * Every case is paired with the shape that behaved correctly before the patch —
 * `content: []` for V1, a text message for V2 — so a fix that broke the old shape
 * fails here.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import loopModeExtension from "../extensions/index.ts";
import { completedCheck } from "./exec-shapes.ts";

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
      // Faithful to what pi resolves for a check that reached its own exit; see
      // tests/exec-shapes.ts for why a bare `{ code: 0 }` is not (AB1).
      return completedCheck(0);
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
    /** One turn made of one assistant message of the given content shape. */
    async turn(content: unknown[], tools: { tool: string; text: string }[] = []) {
      const message = { role: "assistant", content, stopReason: "stop", usage: { output: 126 } };
      notices.length = 0;
      await fire("message_end", { message });
      for (const call of tools) {
        await fire("tool_result", { toolName: call.tool, content: [{ type: "text", text: call.text }] });
      }
      await fire("agent_end", { messages: [message] });
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

const text = (t: string) => [{ type: "text", text: t }];
const thinking = (t: string) => [{ type: "thinking", thinking: t }];

const REASONING =
  "Let me think about which file to open first. The parser lives in src/, and the failing test " +
  "names tokenize(), so that is probably where the fault is. I should read it before changing anything.";

const line = (notices: string, pattern: RegExp) =>
  notices.split("\n").find((l) => pattern.test(l)) ?? "";

describe("V1 — a reasoning-only turn is starvation, not a successful iteration", () => {
  it("routes it to context recovery, and names it as reasoning-only", async () => {
    const host = makeHost(90);
    await host.start("migrate the callsites");
    const notice = await host.turn(thinking(REASONING));
    const status = await host.status();
    await host.stop();

    assert.match(notice, /context pressure detected \(1\/3\)/);
    assert.match(
      line(status, /^Last notice/),
      /reasoning-only response at 90% context \(\d+ chars of thinking, no answer, no tool call\)/,
      "the operator is told which of the two empties it was — 126 tokens spent on reasoning is not nothing at all",
    );
    assert.match(line(status, /^Iterations/), /: 0\//, "a starved turn is not an iteration");
    assert.match(line(status, /^Errors/), /1 total, 1 consecutive/, "and it advances the recovery ladder");
  });

  it("still routes an actually-empty turn there too — the pre-patch control", async () => {
    const host = makeHost(90);
    await host.start("migrate the callsites");
    const notice = await host.turn([]);
    const status = await host.status();
    await host.stop();

    assert.match(notice, /context pressure detected \(1\/3\)/);
    assert.match(line(status, /^Last notice/), /no text, no thinking, no tool call/);
    assert.match(line(status, /^Iterations/), /: 0\//);
  });

  it("leaves a turn that produced an ANSWER alone, however full the context — the control", async () => {
    const host = makeHost(90);
    await host.start("migrate the callsites");
    const notice = await host.turn(text("Migrated src/reader.ts; two callsites left."), [
      { tool: "edit", text: "written" },
    ]);
    const status = await host.status();
    await host.stop();

    assert.doesNotMatch(notice, /context pressure/);
    assert.match(line(status, /^Iterations/), /: 1\//);
    assert.match(line(status, /^Errors/), /0 total/);
  });

  it("leaves a reasoning turn that CALLED something alone — a tool call is an answer", async () => {
    const host = makeHost(90);
    await host.start("migrate the callsites");
    const notice = await host.turn(thinking(REASONING), [{ tool: "read", text: "…file…" }]);
    const status = await host.status();
    await host.stop();

    assert.doesNotMatch(notice, /context pressure/);
    assert.match(line(status, /^Iterations/), /: 1\//);
  });
});

describe("V2 — the stuck rules compare the string that was committed", () => {
  const A =
    "The documentation still matches the code as far as I can tell, so there is nothing concrete to " +
    "change in this batch; I will look again next time round and report if that changes.";
  const B = A.replace("next time round", "next iteration");
  const C = A.replace("next time round", "next cycle");

  // Consecutive pairs sit at textSimilarity 0.80 — exactly SIMILARITY_THRESHOLD —
  // so this is the near-duplicate rule, the one that catches a model rephrasing
  // itself rather than repeating itself byte for byte.
  const REPHRASINGS = [A, B, C, B];

  for (const [label, block] of [
    ["text (control)", text],
    ["thinking", thinking],
  ] as const) {
    it(`catches a model rephrasing itself from turn 2 — ${label}`, async () => {
      const host = makeHost();
      await host.start("keep the docs in step with the code");
      const seen: string[] = [];
      for (const [i, t] of REPHRASINGS.entries()) {
        // A distinct tool result each turn, so the tool-signature rule cannot be
        // what fires and this stays a test about the text rules.
        seen.push(await host.turn(block(t), [{ tool: "read", text: `file ${i}` }]));
      }
      await host.stop();

      assert.doesNotMatch(seen[0], /stuck/, "the first turn has nothing to compare against");
      for (const notice of seen.slice(1)) {
        assert.match(notice, /similar to previous/, `every rephrasing after the first must be caught (${label})`);
      }
    });
  }

  it("does not compare a turn that committed nothing", async () => {
    // A turn with no assistant text at all contributes no entry, so the rules
    // that need one are skipped rather than run against a stale window.
    const host = makeHost();
    await host.start("keep the docs in step with the code");
    await host.turn(text(A), [{ tool: "read", text: "a" }]);
    const bare = await host.turn([], [{ tool: "read", text: "b" }]);
    await host.stop();

    assert.doesNotMatch(bare, /similar to previous|repeated the same response/);
  });

  it("still catches byte-identical repeats, in both shapes", async () => {
    for (const block of [text, thinking]) {
      const host = makeHost();
      await host.start("keep the docs in step with the code");
      await host.turn(block(A), [{ tool: "read", text: "x0" }]);
      const second = await host.turn(block(A), [{ tool: "read", text: "x1" }]);
      await host.stop();
      assert.match(second, /repeated the same response/);
    }
  });
});
