/**
 * A subagent's session must not be able to touch the operator's loop.
 *
 * ## The failure this pins
 *
 * `vendor/pi-subagents-lite` runs its children **in the parent's process**, and
 * a child session binds the parent's extensions. Node's module cache means the
 * child's copy of this extension is the SAME module object — the `state`,
 * `pendingTimer`, `runToken` and `degenerateAbortPending` at the top of
 * `extensions/index.ts` are shared between the operator's session and every
 * subagent's. What is *not* shared is `pi` and the event bus: each session gets
 * its own, so every handler this package registers runs a second time, on the
 * child's events, against the operator's one `LoopState`.
 *
 * An earlier fix guarded two handlers, `session_start` and `session_shutdown`,
 * because that was the pair the first symptom was traced to (a loop that stopped
 * advancing the moment the model delegated anything, with `/loop status`
 * reporting no loop at all — the state was not paused, it was overwritten). The
 * other eleven were left. They are worse, and each one below was reproduced
 * before it was fixed:
 *
 *   before_agent_start      the CHILD's system prompt gained "Loop mode is
 *                           active. Goal: <the operator's goal> … keep every
 *                           response under 1,200 characters … never stop on your
 *                           own". Every clause of that is wrong for a subagent,
 *                           and it is injected into exactly the mechanism the
 *                           answer verifier exists to detect drift in.
 *   agent_end               the whole iteration ladder ran on the operator's
 *                           state with the child's ctx: the operator's scheduled
 *                           iteration cancelled, its iteration count
 *                           incremented, its state persisted into the child's
 *                           throwaway in-memory branch, and its next loop turn
 *                           delivered INTO THE CHILD.
 *   session_before_compact  the child's compaction was replaced by a handoff
 *                           built from the operator's loop state, so a child
 *                           that compacted lost its whole conversation and was
 *                           told to work on the operator's goal instead.
 *   before_provider_request sampling penalties from the operator's stuck ladder
 *                           applied to the child's requests.
 *
 * The fix is the whole factory: an instance born inside a spawn registers
 * nothing at all. `vendor/pi-subagents-lite` no longer hands this package to a
 * subagent either, so in practice the guard is the second line of defence — but
 * `SUBAGENT_EXTRA_EXTENSIONS` can still name it, which is why it has to hold on
 * its own.
 *
 * ## Why this test loads the extension twice
 *
 * Because that is what actually happens: one factory call for the operator's
 * session, another for the child's, sharing module state. The second is loaded
 * with the spawn-depth global set, which is how `pi-subagents-lite` announces
 * "a subagent session is being built right now" to packages that must not
 * import it.
 *
 * ## Control
 *
 * Every assertion here is paired with the operator doing the same thing, so a
 * guard that accidentally disabled the whole package would fail the suite rather
 * than pass it.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import loopModeExtension from "../extensions/index.ts";

const SPAWN_DEPTH_GLOBAL = "__PI_SUBAGENT_SPAWN_DEPTH__";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

/** One extension instance's host: its own pi, ctx, captured handlers, notices and messages. */
function makeHost(label: string) {
  const handlers = new Map<string, Handler[]>();
  const notices: string[] = [];
  const sent: unknown[] = [];
  const entries: unknown[] = [];
  let command: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  let tool: { name: string; execute: (...args: any[]) => Promise<unknown> } | undefined;

  const pi = {
    on(name: string, fn: Handler) {
      const list = handlers.get(name) ?? [];
      list.push(fn);
      handlers.set(name, list);
    },
    registerCommand(_name: string, config: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      command = config.handler;
    },
    registerTool(config: { name: string; execute: (...args: any[]) => Promise<unknown> }) {
      tool = config;
    },
    appendEntry(...args: unknown[]) {
      entries.push(args);
    },
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
    // An empty branch is exactly what a subagent has: SessionManager.inMemory.
    sessionManager: { getBranch: () => [], getEntries: () => [] },
    modelRegistry: { find: () => undefined, getAll: () => [] },
    model: { api: "openai-completions", contextWindow: 32_768 },
    isIdle: () => true,
    hasPendingMessages: () => false,
    getContextUsage: () => ({ tokens: 4_000, contextWindow: 32_768, percent: 12 }),
    compact() {},
    abort() {},
    async waitForIdle() {},
  };

  return {
    pi,
    ctx,
    notices,
    sent,
    entries,
    hasCommand: () => command !== undefined,
    hasTool: () => tool !== undefined,
    handlerCount: () => [...handlers.values()].reduce((n, list) => n + list.length, 0),
    fire: async (name: string, event: unknown = {}) => {
      const results: unknown[] = [];
      for (const fn of handlers.get(name) ?? []) results.push(await fn(event, ctx));
      return results;
    },
    hasHandler: (name: string) => (handlers.get(name)?.length ?? 0) > 0,
    run: async (args: string) => {
      notices.length = 0;
      await command!(args, ctx);
      return notices.join("\n");
    },
  };
}

function loadAsSubagent(label = "child") {
  const host = makeHost(label);
  (globalThis as unknown as Record<string, unknown>)[SPAWN_DEPTH_GLOBAL] = 1;
  try {
    loopModeExtension(host.pi as never);
  } finally {
    (globalThis as unknown as Record<string, unknown>)[SPAWN_DEPTH_GLOBAL] = 0;
  }
  return host;
}

/** An operator instance with a live loop, plus a child instance sharing its module state. */
async function withRunningLoop() {
  const operator = makeHost("operator");
  loopModeExtension(operator.pi as never);
  const child = loadAsSubagent();
  await operator.run("start hold the line. Done when: never");
  return { operator, child };
}

const ASSISTANT_TURN = {
  messages: [
    {
      role: "assistant",
      content: [{ type: "text", text: "the child's own answer, about something else entirely" }],
      stopReason: "stop",
      usage: { output: 12 },
    },
  ],
};

describe("a subagent instance registers nothing", () => {
  it("registers no handlers, no command and no tool", () => {
    const child = loadAsSubagent();
    assert.equal(child.handlerCount(), 0, "a child instance must register no event handlers at all");
    assert.equal(child.hasCommand(), false, "and no /loop command");
    assert.equal(child.hasTool(), false, "and no loop tool — it would cost the child's window ~177 tok/turn");
  });

  it("control: an ordinary session registers all of it", () => {
    const operator = makeHost("operator");
    loopModeExtension(operator.pi as never);
    assert.ok(operator.handlerCount() >= 13, "every other pi session must be unaffected");
    assert.equal(operator.hasCommand(), true);
    assert.equal(operator.hasTool(), true);
  });
});

describe("a subagent session cannot clobber the operator's loop", () => {
  it("leaves the operator's loop running when a child session starts and ends", async () => {
    const { operator, child } = await withRunningLoop();

    const before = await operator.run("status");
    assert.match(before, /Active: true/);
    assert.match(before, /hold the line/);

    await child.fire("session_start");
    await child.fire("session_shutdown");

    const after = await operator.run("status");
    assert.match(after, /Active: true/, "a subagent spawn must not deactivate the operator's loop");
    assert.match(after, /hold the line/, "and must not replace its goal with the child's empty state");

    await operator.run("end");
  });

  it("says nothing into the child's UI — the housekeeping is skipped, not moved", async () => {
    const { operator, child } = await withRunningLoop();

    child.notices.length = 0;
    await child.fire("session_start");
    assert.deepEqual(child.notices, [], "a child must not narrate, resume or finalize the parent's loop");

    await operator.run("end");
  });

  it("never persists loop state into a subagent's branch", async () => {
    const { operator, child } = await withRunningLoop();

    // persistState() writes through pi.appendEntry, and a subagent's
    // SessionManager is inMemory — so a persist from a child both writes to a
    // branch that is thrown away and stops the operator's own branch receiving
    // the update, which is what a restart restores from.
    //
    // agent_end alone, deliberately: session_start would have destroyed the loop
    // first (test above), and this needs the ladder to actually run to reach the
    // persist.
    child.entries.length = 0;
    await child.fire("agent_end", ASSISTANT_TURN);
    assert.deepEqual(child.entries, [], "loop state must never be persisted into a subagent's branch");

    // Control: the operator's own turn does persist.
    operator.entries.length = 0;
    await operator.fire("agent_end", ASSISTANT_TURN);
    assert.ok(operator.entries.length > 0, "the operator's own turn must still persist its state");

    await operator.run("end");
  });

  it("does not put the operator's goal into the child's system prompt", async () => {
    const { operator, child } = await withRunningLoop();

    const results = await child.fire("before_agent_start", { systemPrompt: "<<CHILD SYSTEM PROMPT>>" });
    assert.deepEqual(results, [], "no handler may run, so the child's prompt comes back untouched");

    // Control: the operator's own turn still gets the loop instructions, so this
    // is testing the guard and not a broken before_agent_start.
    const own = (await operator.fire("before_agent_start", { systemPrompt: "<<OPERATOR>>" })) as Array<{
      systemPrompt?: string;
    }>;
    assert.match(String(own[0]?.systemPrompt), /Loop mode is active/);
    assert.match(String(own[0]?.systemPrompt), /hold the line/);

    await operator.run("end");
  });

  it("does not let a child's finished turn drive the operator's iteration ladder", async () => {
    const { operator, child } = await withRunningLoop();

    operator.sent.length = 0;
    child.sent.length = 0;
    await child.fire("agent_end", ASSISTANT_TURN);

    assert.deepEqual(child.sent, [], "the operator's next loop turn must not be delivered into the child");
    const after = await operator.run("status");
    assert.match(after, /Iterations: 0\//, "a child's turn must not burn one of the operator's iterations");

    // Control: the operator's own agent_end still advances the loop.
    operator.sent.length = 0;
    await operator.fire("agent_end", ASSISTANT_TURN);
    assert.equal(operator.sent.length, 1, "the operator's own turn must still schedule the next one");
    assert.match(await operator.run("status"), /Iterations: 1\//);

    await operator.run("end");
  });

  it("does not replace a child's compaction with the operator's loop handoff", async () => {
    const { operator, child } = await withRunningLoop();

    const preparation = {
      firstKeptEntryId: "child-entry-42",
      tokensBefore: 26_000,
      fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
    };
    const results = await child.fire("session_before_compact", {
      reason: "threshold",
      preparation,
      branchEntries: [],
    });
    assert.deepEqual(results, [], "pi must keep ownership of a subagent's own compaction");

    // Control: the operator on a 32k window still gets the handoff, since that
    // is the fork's whole reason for owning compaction below 64k.
    const own = (await operator.fire("session_before_compact", {
      reason: "threshold",
      preparation,
      branchEntries: [],
    })) as Array<{ compaction?: { summary: string } }>;
    assert.match(String(own[0]?.compaction?.summary), /hold the line/);

    await operator.run("end");
  });

  it("does not apply the operator's sampling penalties to a child's requests", async () => {
    const { operator, child } = await withRunningLoop();

    // Drive the operator into a stuck intervention, which is what arms the
    // penalties (PENALTY_TURNS iterations of frequency/presence penalty).
    const repeated = {
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "the same sentence. the same sentence. the same sentence. the same sentence." }],
          stopReason: "stop",
          usage: { output: 40 },
        },
      ],
    };
    await operator.fire("message_end", repeated.messages[0] ? { message: repeated.messages[0] } : {});
    await operator.fire("agent_end", repeated);

    const childPayload = await child.fire("before_provider_request", { payload: { temperature: 0.7 } });
    assert.deepEqual(childPayload, [], "a child's provider payload must not be rewritten by the operator's loop");

    await operator.run("end");
  });

  it("does not let a child's assistant text feed the operator's repetition detector", async () => {
    const { operator, child } = await withRunningLoop();

    // Long enough to clear detectStuck's 80-char floor for the two-in-a-row rule.
    const text =
      "I read the file, considered the callers, and concluded that the existing implementation already handles this case correctly.";
    const message = { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" };

    // The child answers twice. Shared, those two land in the operator's
    // lastAssistantFingerprints; the operator's own single turn below then looks
    // like the third repeat of a response it has never given.
    await child.fire("message_end", { message });
    await child.fire("message_end", { message });

    await operator.fire("message_end", { message });
    await operator.fire("agent_end", { messages: [{ ...message, usage: { output: 40 } }] });

    const status = await operator.run("status");
    assert.match(status, /stuck streak: 0/, "one operator turn must not read as repetition because a child spoke twice");
    assert.match(status, /Interventions: 0/, "and must not trigger a stuck intervention");

    await operator.run("end");
  });
});
