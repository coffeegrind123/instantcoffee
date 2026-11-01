/**
 * An operator stop the turn's last message does not show.
 *
 * The loop reads an operator abort from the last assistant message's
 * `stopReason === "aborted"` at `agent_end`. Esc pressed while pi is waiting to
 * RETRY a provider error leaves that message at `stopReason: "error"`, so the
 * loop counted a provider failure and carried on with the next iteration. pi
 * 1.1.0 added `aborted` to `agent_settled` for exactly this ("so integrations
 * can tell a cancelled run from a finished one"); it is the run's
 * `_agentRunAbortRequested`, set by every abort, including the loop's own.
 *
 * So the loop pauses on `agent_settled.aborted` too, except when the abort was
 * its own: the mid-stream degenerate-repetition abort, which it handles by
 * intervening and continuing.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";

import loopModeExtension from "../extensions/index.ts";
import { resetCompactionLock } from "../src/compaction-lock.ts";
import { completedCheck } from "./exec-shapes.ts";

type Handler = (event: any, ctx: any) => Promise<any>;

const handlers = new Map<string, Handler>();
let commandHandler: (args: string, ctx: any) => Promise<void>;
const notifications: string[] = [];
let branch: any[] = [];

const pi = {
  on(event: string, handler: Handler) {
    handlers.set(event, handler);
  },
  registerCommand(_name: string, config: { handler: (args: string, ctx: any) => Promise<void> }) {
    commandHandler = config.handler;
  },
  registerTool() {},
  appendEntry(customType: string, data: unknown) {
    branch.push({ type: "custom", customType, data });
  },
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
    notify(message: string) {
      notifications.push(String(message));
    },
    setStatus() {},
  },
  sessionManager: { getBranch: () => branch, getEntries: () => branch },
  modelRegistry: { find: () => undefined, getAll: () => [] },
  model: { api: "openai-completions", contextWindow: 131_072 },
  isIdle: () => true,
  hasPendingMessages: () => false,
  getContextUsage: () => ({ percent: 10, contextWindow: 131_072, tokens: 13_000 }),
  compact() {},
  abort() {},
  async waitForIdle() {},
};

function emit(event: string, payload: unknown = {}): Promise<any> {
  const handler = handlers.get(event);
  assert.ok(handler, `extension registered no ${event} handler`);
  return handler(payload, ctx);
}

async function status(): Promise<string> {
  notifications.length = 0;
  await commandHandler("status", ctx);
  return notifications.join("\n");
}

/** The turn a cancelled retry leaves behind: the failed attempt, not an aborted one. */
const retryCancelledTurn = {
  messages: [{ role: "assistant", content: [], stopReason: "error", errorMessage: "server_busy", usage: { output: 0 } }],
};

loopModeExtension(pi as never);

beforeEach(async () => {
  branch = [{ type: "message" }];
  resetCompactionLock();
  await commandHandler("end", ctx);
  await commandHandler("start Improve the parser --max 10", ctx);
  notifications.length = 0;
});

describe("agent_settled.aborted pauses the loop", () => {
  test("Esc during a provider-error retry pauses, although the last message says error", async () => {
    await emit("agent_end", retryCancelledTurn);
    await emit("agent_settled", { aborted: true });
    const s = await status();
    assert.match(s, /Active: false/, s);
    assert.match(s, /Status: paused/, s);
    await commandHandler("end", ctx);
  });

  test("control — the same turn, settled without an abort, keeps the loop running", async () => {
    await emit("agent_end", retryCancelledTurn);
    await emit("agent_settled", { aborted: false });
    assert.match(await status(), /Active: true/);
    await commandHandler("end", ctx);
  });

  test("the loop's own degenerate-repetition abort does not pause it", async () => {
    // Enough identical sentences to trip the mid-stream detector, which calls
    // ctx.abort() itself; pi then reports the run as aborted.
    const text = "The parser handles this case correctly now. ".repeat(80);
    await emit("message_update", { message: { role: "assistant", content: [{ type: "text", text }] } });
    assert.ok(notifications.some((n) => /degenerate/.test(n)), "control: the detector fired");
    await emit("agent_end", { messages: [{ role: "assistant", content: [{ type: "text", text }], stopReason: "aborted", usage: { output: 900 } }] });
    await emit("agent_settled", { aborted: true });
    assert.match(await status(), /Active: true/, "a self-inflicted abort read as an operator stop");
    await commandHandler("end", ctx);
  });

  test("pi before 1.1 sends no aborted field, and nothing changes", async () => {
    await emit("agent_end", retryCancelledTurn);
    await emit("agent_settled", {});
    assert.match(await status(), /Active: true/);
    await commandHandler("end", ctx);
  });
});
