/**
 * `/loop` with no arguments shows the status. It started an endless loop with
 * an empty goal instead (2026-11-01, sent from the Ovis chat and reproduced
 * from pi's own prompt): `"".split(/\s+/)` is `[""]`, not `[]`, so the
 * destructuring default `subcommand = "status"` never applied, no branch
 * matched "", and the handler fell through to "/loop <goal> starts a loop
 * immediately" with nothing as the goal.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import loopModeExtension from "../extensions/index.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

function makeHost() {
  const handlers = new Map<string, Handler[]>();
  const notices: string[] = [];
  const sent: unknown[] = [];
  let command: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  const pi = {
    on(name: string, fn: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), fn]);
    },
    registerCommand(name: string, config: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      if (name === "loop") command = config.handler;
    },
    registerTool() {},
    appendEntry() {},
    sendMessage(message: unknown) {
      sent.push(message);
    },
    async exec() {
      return { code: 0, stdout: "", stderr: "", killed: false };
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
    getContextUsage: () => ({ tokens: 1000, contextWindow: 32_768, percent: 3 }),
    compact() {},
    abort() {},
    async waitForIdle() {},
  };
  loopModeExtension(pi as never);
  return {
    notices,
    sent,
    async run(args: string) {
      notices.length = 0;
      await command!(args, ctx);
      return notices.join("\n");
    },
  };
}

describe("/loop with no arguments", () => {
  for (const args of ["", "   ", "\t"]) {
    it(`shows the status and starts nothing (${JSON.stringify(args)})`, async () => {
      const host = makeHost();
      const said = await host.run(args);
      assert.match(said, /Loop state:/);
      assert.doesNotMatch(said, /Loop active/);
      assert.equal(host.sent.length, 0, "a loop turn was sent");
      await host.run("stop");
    });
  }

  it("control: a goal after /loop still starts a loop", async () => {
    const host = makeHost();
    const said = await host.run("tidy the README");
    assert.match(said, /Loop active/);
    await host.run("stop");
  });
});
