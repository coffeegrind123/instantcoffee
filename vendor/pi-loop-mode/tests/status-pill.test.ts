/**
 * AL8 — the footer pill that outlived the loop it named.
 *
 * `ctx.ui.setStatus("loop", …)` appears thirty times in `extensions/index.ts`.
 * `ctx.ui.setStatus("loop", undefined)` appeared none. So nothing this extension
 * does has ever taken the pill OUT of pi's footer; the only thing that ever did
 * was the host, at `resetExtensionUI()`, which runs when the session is
 * replaced.
 *
 * Twenty-nine of the thirty are right as they stand. "Loop paused (max
 * iterations)", "Loop stopped", "Loop completed (check passed)", "Loop context
 * cooldown 30s" all describe a loop that still EXISTS: it is in
 * `.pi-loop-state.json`, `/loop status` reports it, and `/loop resume` acts on
 * it. A footer that keeps saying so is telling the truth.
 *
 * `end` is the exception, and it is the only one. Its whole meaning is that
 * there is no loop any more — the statement above the notice is
 * `state = defaultState()` — so the pill was left naming a thing that had been
 * deleted one line earlier, for the rest of the session. `/loop status` and the
 * footer then disagreed, and the footer is the one nobody has to ask.
 *
 * See AL8 in `context/design/subagents-loop-verifier-lifetimes.md`.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import loopModeExtension from "../extensions/index.ts";
import { completedCheck } from "./exec-shapes.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

const MODEL = { provider: "local", id: "small", api: "openai-completions", contextWindow: 32_768 };

function makeHost() {
  const handlers = new Map<string, Handler[]>();
  /** Every ("loop", text) this run put in the footer, in order. `null` is a clear. */
  const pills: (string | null)[] = [];
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
      notify() {},
      setStatus(key: string, text: string | undefined) {
        if (key !== "loop") return;
        pills.push(text === undefined ? null : text);
      },
    },
    sessionManager: { getBranch: () => [], getEntries: () => [] },
    modelRegistry: { find: () => MODEL, getAll: () => [MODEL] },
    model: MODEL,
    isIdle: () => true,
    hasPendingMessages: () => false,
    getContextUsage: () => ({ tokens: 6_554, contextWindow: 32_768, percent: 20 }),
    compact() {},
    abort() {},
    async waitForIdle() {},
  };

  const assistant = (text: string) => ({
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
    usage: { output: 40 },
  });

  return {
    pills,
    /** What the footer says right now: the last pill, or null once cleared. */
    footer: () => (pills.length === 0 ? undefined : pills[pills.length - 1]),
    async start(args: string) {
      loopModeExtension(pi as never);
      await command!(args, ctx);
      pills.length = 0;
    },
    async run(args: string) {
      await command!(args, ctx);
    },
    async turn(text: string) {
      for (const fn of handlers.get("message_end") ?? []) await fn({ message: assistant(text) }, ctx);
      for (const fn of handlers.get("agent_end") ?? []) await fn({ messages: [assistant(text)] }, ctx);
    },
  };
}

describe("AL8 — /loop end takes its own pill out of the footer", () => {
  it("clears the pill", async () => {
    const host = makeHost();
    await host.start("start improve the parser");
    await host.turn("Rewrote the tokenizer; the suite is green.");
    assert.ok(host.footer(), "a running loop puts something in the footer");

    await host.run("end");
    assert.equal(host.footer(), null, "and ending it takes that something back out");
  });

  it("clears it for /loop clear, which is the same command", async () => {
    const host = makeHost();
    await host.start("start improve the parser");
    await host.turn("Rewrote the tokenizer; the suite is green.");

    await host.run("clear");
    assert.equal(host.footer(), null);
  });

  it("clears it even for a loop that was already stopped", async () => {
    // `/loop stop` then `/loop end` is the ordinary two-step, and the pill it
    // leaves behind is "Loop stopped" — a loop that no longer exists.
    const host = makeHost();
    await host.start("start improve the parser");
    await host.turn("Rewrote the tokenizer; the suite is green.");
    await host.run("stop");
    assert.equal(host.footer(), "Loop stopped");

    await host.run("end");
    assert.equal(host.footer(), null);
  });
});

describe("AL8 — the twenty-nine that stay (controls)", () => {
  it("/loop stop still says so — the loop is resumable and the footer should say it", async () => {
    const host = makeHost();
    await host.start("start improve the parser");
    await host.turn("Rewrote the tokenizer; the suite is green.");

    await host.run("stop");
    assert.equal(host.footer(), "Loop stopped");
  });

  it("a running loop keeps a pill", async () => {
    const host = makeHost();
    await host.start("start improve the parser");
    await host.turn("Rewrote the tokenizer; the suite is green.");

    const footer = host.footer();
    assert.ok(typeof footer === "string" && footer.length > 0);
    await host.run("stop");
  });

  it("/loop finish leaves one: a soft stop still has a loop behind it", async () => {
    const host = makeHost();
    await host.start("start improve the parser");
    await host.turn("Rewrote the tokenizer; the suite is green.");

    await host.run("finish");
    assert.notEqual(host.footer(), null, "finish is not end");
    await host.run("end");
  });
});
