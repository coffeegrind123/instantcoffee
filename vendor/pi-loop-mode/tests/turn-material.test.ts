/**
 * The turn's MATERIAL — every remaining reader in `agent_end` that was still
 * asking a question about the turn and answering it from one message, plus the
 * per-turn state that only one exit put back.
 *
 * W1 moved the completion markers and `emptyResponse` onto the turn's own
 * buffer. Four readers next to them were left where they were, and one of them
 * could not fire at all.
 *
 * ## X1 — the window commits the turn's last MESSAGE, not its last ANSWER
 *
 * `message_end` buffers `messageToText(m) || messageToRepetitionText(m)` per
 * message, and `commitTurnMemory` took the last non-empty of that buffer. For a
 * turn that answered and then produced one reasoning-only message — the shape W1
 * is about — the trailing THOUGHT went into the fingerprint, snippet and text
 * windows as the turn's answer, and every rule in `detectStuck` then compared
 * thoughts with thoughts. Measured against this module, in both directions:
 * four byte-identical answers with distinct trailing thoughts produced no
 * intervention at all (the control, at one message per turn, was caught on turn
 * 2 and escalated to a streak of 3), and four genuinely different answers with
 * one identical trailing thought were reported as "assistant repeated the same
 * response" from turn 2.
 *
 * ## X2 — the degenerate-repetition rule reads the LAST message
 *
 * `detectStuck`'s first rule is about ONE response, and it was handed
 * `messageToRepetitionText(lastAssistant)`. An answer that repeated a sentence
 * nine times was caught when it was the turn's only message and missed entirely
 * with one thought appended.
 *
 * ## X5 — …and it read the message AFTER the sanitizer rewrote it
 *
 * `message_end` returns a sanitized replacement for a degenerate message, and pi
 * applies it IN PLACE (`AgentSession._emitExtensionEvent` →
 * `_replaceMessageInPlace`, agent-session.js:481/425, whose own comment says the
 * mutation is what keeps "later turn/agent events" in sync). `agent_end` holds
 * those same objects, so rule 1 was reading text the sanitizer had already cut —
 * with the same threshold, DEGENERATE_REPEATS, on both sides. The rule could not
 * fire in a real session at all. The buffer now takes the ORIGINAL message.
 *
 * ## X3 — GOAL_READY is read off the last message too
 *
 * The one reader W1 could not move, because `message_end` was gated on
 * `state.active` and `/loop prepare` runs with it false. A prepare turn that said
 * `GOAL_READY:` and then produced a reasoning-only message left `preparedAt` at
 * 0 — so the run's first turn never says "read the specification", `/loop status`
 * reads "not prepared" forever, and the spec a strong model was spent producing
 * is never mentioned. That is V8's failure by another route.
 *
 * ## X4 — `state.toolCallsThisTurn` is per-turn state that only `agent_end` reset
 *
 * `/loop stop` sets `state.active = false`, which makes `agent_end` return at its
 * first line, so a loop stopped mid-turn kept the turn's tool count and the next
 * turn after `/loop resume` started with it. `emptyResponse` requires the count
 * to be zero, so the starvation rung was off for that turn — T2's defect, on the
 * stop/resume path. It now lives in `resetTurnBuffers`, with the buffers it
 * belongs to.
 *
 * The host below applies a `message_end` handler's replacement in place, exactly
 * as pi does. Without that, X5 is invisible and the other cases test a message
 * shape that never reaches `agent_end`.
 *
 * See X1–X5 in `context/design/subagents-loop-verifier-turns.md`.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import loopModeExtension from "../extensions/index.ts";

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

  /**
   * pi threads each `message_end` handler's returned message into the next one
   * and then writes the last of them over the object agent-core is holding —
   * `_replaceMessageInPlace` deletes every key and copies the replacement across.
   * `agent_end`'s `messages` are those same objects. Replaying that is the whole
   * of X5's evidence.
   */
  const fire = async (name: string, event: { message?: Record<string, unknown> } = {}) => {
    const results: unknown[] = [];
    for (const fn of handlers.get(name) ?? []) results.push(await fn(event, ctx));
    if (name !== "message_end" || !event.message) return;
    const replacement = [...results].reverse().find(
      (result): result is { message: Record<string, unknown> } =>
        Boolean(result) && typeof result === "object" && "message" in (result as object),
    )?.message;
    if (!replacement || replacement === event.message) return;
    for (const key of Object.keys(event.message)) delete event.message[key];
    Object.assign(event.message, replacement);
  };

  return {
    notices,
    async start(args: string) {
      loopModeExtension(pi as never);
      notices.length = 0;
      await command!(args, ctx);
    },
    async command(args: string) {
      notices.length = 0;
      await command!(args, ctx);
      return notices.join("\n");
    },
    /** One whole turn: N assistant messages, then the tool results, then agent_end. */
    async turn(messages: Record<string, unknown>[], tools: { tool: string; text: string }[] = []) {
      notices.length = 0;
      for (const message of messages) await fire("message_end", { message });
      for (const call of tools) {
        await fire("tool_result", { toolName: call.tool, content: [{ type: "text", text: call.text }] });
      }
      await fire("agent_end", { messages } as never);
      return notices.join(" | ");
    },
    /** Just the tool results, with no agent_end — a turn the operator cut short. */
    async toolCalls(tools: { tool: string; text: string }[]) {
      for (const call of tools) {
        await fire("tool_result", { toolName: call.tool, content: [{ type: "text", text: call.text }] });
      }
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

const thought = (t: string) => ({
  role: "assistant",
  content: [{ type: "thinking", thinking: t }],
  stopReason: "stop",
  usage: { output: 126 },
});

const ANSWER =
  "I re-read src/parser.ts and confirmed the tokenizer handles nested quotes; nothing else " +
  "to change here, so the work stands exactly as it is and I will move on.";

/** Three trailing thoughts with no trigram in common, so nothing but the answer can match. */
const THOUGHTS = [
  "the delegated search came back with a list of call sites in the templating layer, which does not touch this",
  "a background helper finished summarising release notes, none of which mention parsing or anything adjacent",
  "another agent reports that the migration script is unrelated, so I will simply carry on with what I planned",
];

const read = (n: number) => [{ tool: "read", text: `contents ${n}` }];

describe("X1 — the repetition window commits the turn's answer, not its last message", () => {
  it("catches four identical answers even when each turn ends on a different thought", async () => {
    const host = makeHost(20);
    await host.start("start audit the parser");

    const notices: string[] = [];
    for (let i = 0; i < 4; i++) {
      notices.push(await host.turn([answered(ANSWER), thought(THOUGHTS[i % 3] + " ".repeat(i + 1))], read(i)));
    }

    assert.equal(notices[0], "", "the first turn has nothing to compare against");
    assert.match(notices[1], /Loop stuck \(1x\): assistant repeated the same response/);
    assert.match(notices[3], /Loop stuck \(3x\)/);
    await host.stop();
  });

  it("control — the same four turns as single messages, which always worked", async () => {
    const host = makeHost(20);
    await host.start("start audit the parser");

    const notices: string[] = [];
    for (let i = 0; i < 4; i++) notices.push(await host.turn([answered(ANSWER)], read(i)));

    assert.equal(notices[0], "");
    assert.match(notices[1], /assistant repeated the same response/);
    assert.match(notices[3], /Loop stuck \(3x\)/);
    await host.stop();
  });

  it("does not report four different answers as repeated because the trailing thought is the same", async () => {
    const host = makeHost(20);
    await host.start("start audit the parser");

    const same = THOUGHTS[0];
    const notices: string[] = [];
    for (let i = 0; i < 4; i++) {
      notices.push(
        await host.turn(
          [
            answered(
              `Turn ${i}: I edited src/file${i}.ts, added a regression test for the ${
                ["quoting", "escaping", "nesting", "unicode"][i]
              } case, and confirmed the suite is green.`,
            ),
            thought(same),
          ],
          [{ tool: "edit", text: `edited file ${i}` }],
        ),
      );
    }

    assert.deepEqual(notices, ["", "", "", ""], "a productive turn must not be charged to the stuck ladder");
    await host.stop();
  });

  it("control — a turn whose only output is reasoning still commits the reasoning (V1/V2)", async () => {
    const host = makeHost(20);
    await host.start("start audit the parser");

    const notices: string[] = [];
    for (let i = 0; i < 3; i++) notices.push(await host.turn([thought(ANSWER)], read(i)));

    assert.match(notices[1], /assistant repeated the same response/);
    await host.stop();
  });
});

describe("X2/X5 — the degenerate rule reads what the model produced, over the whole turn", () => {
  const DEGENERATE = Array.from({ length: 9 }, () => "I will now verify the parser handles nested quotes.").join(" ");

  it("catches a degenerate answer that is followed by a reasoning-only message", async () => {
    const host = makeHost(20);
    await host.start("start audit the parser");

    const notice = await host.turn([answered(DEGENERATE), thought(THOUGHTS[0])], read(1));

    assert.match(notice, /response degenerated: same sentence repeated 9×/);
    await host.stop();
  });

  it("catches it through the sanitizer, which rewrites the message agent_end holds", async () => {
    const host = makeHost(20);
    await host.start("start audit the parser");

    // One message, so the only thing between the model's text and `agent_end` is
    // the in-place replacement. Before the fix this was already unreachable: the
    // sanitizer and the rule share DEGENERATE_REPEATS, so anything the rule would
    // catch had been truncated by the time it looked.
    const message = answered(DEGENERATE) as Record<string, unknown>;
    const notice = await host.turn([message], read(1));

    assert.match(notice, /response degenerated: same sentence repeated 9×/);
    assert.ok(
      String((message.content as { text?: string }[])[0].text).includes("degenerate repetition truncated"),
      "the host must replay pi's in-place replacement, or this case proves nothing",
    );
    await host.stop();
  });

  it("control — a clean answer is not reported as degenerate", async () => {
    const host = makeHost(20);
    await host.start("start audit the parser");

    assert.equal(await host.turn([answered(ANSWER), thought(THOUGHTS[0])], read(1)), "");
    await host.stop();
  });
});

describe("X3 — GOAL_READY is the prepare turn's answer", () => {
  it("marks the goal prepared when the marker is followed by a reasoning-only message", async () => {
    const host = makeHost(20);
    await host.start("goal write the spec. Done when: GOAL.md exists");
    await host.command("prepare");

    await host.turn([
      answered("GOAL_READY: the specification is in GOAL.md with milestones and a check script."),
      thought(THOUGHTS[1]),
    ]);

    const status = await host.status();
    assert.match(status, /Goal file: GOAL\.md \(prepared\)/);
    assert.doesNotMatch(status, /Status: preparing/);
  });

  it("control — the same marker on a one-message prepare turn", async () => {
    const host = makeHost(20);
    await host.start("goal write the spec. Done when: GOAL.md exists");
    await host.command("prepare");

    await host.turn([answered("GOAL_READY: the specification is in GOAL.md.")]);

    assert.match(await host.status(), /Goal file: GOAL\.md \(prepared\)/);
  });

  it("control — a prepare turn without the marker leaves the goal unprepared", async () => {
    const host = makeHost(20);
    // A different goal text on purpose: `state` is module-global across this
    // file's tests, and `applyGoalConfig` deliberately preserves `preparedAt`
    // when the goal is RE-issued unchanged (V8). Re-using the goal above would
    // inherit its prepared flag and this control would pass for the wrong reason.
    await host.start("goal write a different spec. Done when: SPEC.md exists");
    await host.command("prepare");

    await host.turn([answered("I have started on the specification but it is not finished yet.")]);

    assert.match(await host.status(), /Goal file: GOAL\.md \(not prepared\)/);
  });
});

describe("X4 — the per-turn tool counter is dropped with the turn's buffers", () => {
  it("sees a starved turn after a stop/resume that interrupted a tool-using turn", async () => {
    const host = makeHost(90);
    await host.start("start ship the feature");

    // A turn that made two calls and never reached agent_end, because the
    // operator stopped the loop in the middle of it.
    await host.toolCalls([
      { tool: "read", text: "some file" },
      { tool: "grep", text: "some matches" },
    ]);
    await host.command("stop");
    await host.command("resume");

    const notice = await host.turn([thought("I am not sure what to do and the window is nearly full")]);

    assert.match(notice, /context pressure detected \(1\/3\)/);
    assert.match(await host.status(), /Iterations: 0/);
    await host.stop();
  });

  it("control — the same starved turn on a fresh counter", async () => {
    const host = makeHost(90);
    await host.start("start ship the feature");

    const notice = await host.turn([thought("I am not sure what to do and the window is nearly full")]);

    assert.match(notice, /context pressure detected \(1\/3\)/);
    await host.stop();
  });

  it("control — a turn that really did call a tool is not starved", async () => {
    const host = makeHost(90);
    await host.start("start ship the feature");

    const notice = await host.turn([thought("thinking about the next step")], read(1));

    assert.doesNotMatch(notice, /context pressure/);
    await host.stop();
  });
});
