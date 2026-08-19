/**
 * AA1 — the loop's `before_agent_start` must not write the session's system
 * prompt.
 *
 * ## The two facts about pi that make this a rule rather than a preference
 *
 * **`before_agent_start` is emitted from exactly one place.**
 * `AgentSession.prompt()` (`agent-session.js:885`) — the operator-typed path.
 * Every turn this package drives goes through the other entry point:
 * `pi.sendMessage(…, {triggerTurn:true})` → `sendCustomMessage` (`:1068`) →
 * `_runAgentPrompt` (`:1090`, defined at `:744`), which does not emit it. So in
 * an unattended run the handler never ran, and whatever it returned reached
 * nothing.
 *
 * **What it returned outlived the run.** `prompt()` writes the returned text to
 * `_systemPromptOverride` AND to `agent.state.systemPrompt` (`:902`/`:903`);
 * `_runAgentPrompt`'s `finally` clears only the override (`:753`) and never
 * restores `agent.state.systemPrompt`. Turn 1 of every later run reads
 * `agent.state.systemPrompt` (`Agent.createContextSnapshot`), while turns 2+ are
 * rebuilt by `_installAgentNextTurnRefresh` (`:274`) from
 * `_systemPromptOverride ?? _baseSystemPrompt` (`:286`) — the base again. So one
 * operator-typed turn during a loop left a stale copy of the block on the first
 * turn of every subsequent iteration, and dropped it at that iteration's second
 * turn: a system-prompt change inside one run, at offset 0 of the cached prefix.
 *
 * The `message` form has neither problem: `emitBeforeAgentStart` collects it
 * (`runner.js:863`) and `prompt()` appends it as one `role:"custom"` message for
 * that turn only (`:889`).
 *
 * See AA1 in `context/design/subagents-loop-verifier-hosts.md` and probe
 * `context/testing/probes/n1-the-system-prompt-no-loop-turn-ever-sees.mjs`.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import loopModeExtension from "../extensions/index.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

interface BeforeAgentStartResult {
  systemPrompt?: string;
  message?: { customType?: string; content?: string; display?: boolean };
}

function makeHost() {
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
    ui: { notify: (m: string) => notices.push(String(m)), setStatus() {} },
    sessionManager: { getBranch: () => [], getEntries: () => [] },
    modelRegistry: { find: () => undefined, getAll: () => [] },
    model: { api: "openai-completions", contextWindow: 32_768 },
    isIdle: () => true,
    hasPendingMessages: () => false,
    getContextUsage: () => ({ tokens: 6_554, contextWindow: 32_768, percent: 20 }),
    compact() {},
    abort() {},
    async waitForIdle() {},
  };

  loopModeExtension(pi as never);

  return {
    notices,
    async run(args: string) {
      notices.length = 0;
      await command!(args, ctx);
      return notices.join("\n");
    },
    async beforeAgentStart(systemPrompt = "<<BASE SYSTEM PROMPT>>") {
      const out: BeforeAgentStartResult[] = [];
      for (const fn of handlers.get("before_agent_start") ?? []) {
        out.push((await fn({ systemPrompt }, ctx)) as BeforeAgentStartResult);
      }
      return out;
    },
  };
}

describe("AA1 — before_agent_start must not write the session's system prompt", () => {
  it("returns a per-turn message, never a systemPrompt", async () => {
    const host = makeHost();
    await host.run("start ship the parser rewrite --max 5");

    const results = await host.beforeAgentStart();
    assert.equal(results.length, 1, "exactly one handler");

    // The rule. A returned systemPrompt is written to agent.state.systemPrompt
    // and never taken back off it.
    assert.equal(
      results[0]?.systemPrompt,
      undefined,
      "returning a systemPrompt leaks it onto agent.state.systemPrompt for the rest of the session",
    );

    assert.ok(results[0]?.message, "the loop still tells an operator-typed turn that a loop is running");
    assert.equal(results[0]?.message?.customType, "loop-rules");
    assert.match(String(results[0]?.message?.content), /Loop mode is active/);
    assert.match(String(results[0]?.message?.content), /ship the parser rewrite/);

    await host.run("end");
  });

  it("does not repeat the base prompt back at pi", async () => {
    const host = makeHost();
    await host.run("start ship it --max 5");

    // The old shape was `${event.systemPrompt}\n\n…`, i.e. it re-sent the whole
    // base prompt as its replacement. A message carries only the addition.
    const [result] = await host.beforeAgentStart("<<BASE SYSTEM PROMPT>>");
    assert.doesNotMatch(carried(result), /BASE SYSTEM PROMPT/);

    await host.run("end");
  });

  it("control — says nothing at all when no loop is running", async () => {
    const host = makeHost();
    // The loop's state is module-global, so an earlier test that threw before its
    // own `end` would leave a run active here. Say so explicitly rather than
    // depending on test order.
    await host.run("end");
    const results = await host.beforeAgentStart();
    assert.deepEqual(results, [undefined], "an inactive loop must not touch anyone's turn");
  });

  it("control — the rules still track the mode, whichever carrier they take", async () => {
    const host = makeHost();

    await host.run("start ship it --until-done --max 5");
    const [untilDone] = await host.beforeAgentStart();
    assert.match(carried(untilDone), /use LOOP_DONE: when the completion criteria are fully met/);
    await host.run("end");

    await host.run("start ship it --max 5");
    const [endless] = await host.beforeAgentStart();
    assert.match(carried(endless), /endless mode/);
    await host.run("end");
  });
});

/**
 * The text the handler produced, whichever field it came back in. Used by the
 * two controls so they assert on the CONTENT and pass under either shape —
 * otherwise they would fail without the fix and stop being controls.
 */
function carried(result: BeforeAgentStartResult | undefined): string {
  return String(result?.message?.content ?? result?.systemPrompt ?? "");
}
