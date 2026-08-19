/**
 * AG2 — a loop turn is not delivered into a compaction that is already running.
 *
 * pi has exactly one refusal for "you cannot prompt while a compaction is in
 * progress", and it is on the entry point this package does not use:
 *
 *   AgentSession.prompt()          if (this._compactionAbortController !== undefined)
 *                                      throw "Cannot submit a prompt while
 *                                             compaction is in progress…"   :807
 *   AgentSession.sendCustomMessage else if (options?.triggerTurn)
 *                                      await this._runAgentPrompt(appMessage) :1090
 *
 * `pi.sendMessage` IS `sendCustomMessage`, and `_runAgentPrompt` checks nothing.
 * So every turn this package drives could start a whole agent run inside
 * somebody else's compaction — two model calls queued at a one-slot llama
 * server, the turn built from the pre-compaction context, and `compact()`
 * finishing with `this.agent.state.messages = sessionContext.messages`, which
 * REPLACES the array the run is streaming into.
 *
 * The flag is the one this package already half-owns. `requestEmergencyCompaction`
 * and `interveneStuck`'s compaction rung both read `compactionInFlight()` before
 * they act; `sendLoopTurn` did not — and the most reachable route to the defect
 * is this package's own adoption branch, which schedules a `recover` turn with
 * delay 0 straight into the compaction it has just decided not to duplicate.
 *
 * Driven end to end, with both real extensions in one process, in
 * `context/testing/probes/t2-the-turn-that-does-not-have-to-ask.mjs`.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import loopModeExtension from "../extensions/index.ts";
import { LOOP_OWNER, beginCompaction, endCompaction, resetCompactionLock } from "../src/compaction-lock.ts";
import { completedCheck } from "./exec-shapes.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;
type Sent = { details?: { kind?: string; iteration?: number } };

/** The module's state is per-MODULE, so every test starts from a stop. */
function makeHost() {
  const handlers = new Map<string, Handler[]>();
  const notices: string[] = [];
  const sent: Sent[] = [];
  const timers: { fn: () => void; delay: number; handle: { id: number; unref(): void } }[] = [];
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
    sendMessage(message: { details?: Sent["details"] }) {
      sent.push({ details: message.details });
    },
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
        notices.push(String(message));
      },
      setStatus() {},
    },
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

  // The scheduled iteration is a real setTimeout in the module; capture it so a
  // test can fire the wait deterministically rather than sleeping.
  //
  // `clearTimeout` is stubbed too, and that is not tidiness — AH6 is entirely
  // about a timer being CLEARED by the next `agent_end`, and a harness whose
  // handles cannot be cancelled cannot fail when the module can. That is X1's
  // lesson (the evidence models the host, and the model omits the one thing
  // under test) applied to this file's own scaffolding.
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  let nextTimerId = 1;
  (globalThis as { setTimeout: unknown }).setTimeout = ((fn: () => void, delay: number) => {
    const handle = { id: nextTimerId++, unref() {} };
    timers.push({ fn, delay, handle });
    return handle as unknown as ReturnType<typeof realSetTimeout>;
  }) as unknown as typeof realSetTimeout;
  (globalThis as { clearTimeout: unknown }).clearTimeout = ((handle: { id?: number } | undefined) => {
    if (!handle || typeof handle.id !== "number") return;
    const at = timers.findIndex((t) => t.handle.id === handle.id);
    if (at !== -1) timers.splice(at, 1);
  }) as unknown as typeof realClearTimeout;
  const restore = () => {
    (globalThis as { setTimeout: unknown }).setTimeout = realSetTimeout;
    (globalThis as { clearTimeout: unknown }).clearTimeout = realClearTimeout;
  };

  const assistant = (text: string) => ({
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
    usage: { output: 40 },
  });

  return {
    notices,
    sent,
    timers,
    restore,
    ctx,
    async start(args = "start keep the docs in step with the code") {
      loopModeExtension(pi as never);
      await command!(args, ctx);
      notices.length = 0;
      sent.length = 0;
      timers.length = 0;
    },
    async stop() {
      await command!("stop", ctx);
    },
    /** Any `/loop …` line, WITHOUT re-registering the extension. */
    async run(args: string) {
      await command!(args, ctx);
      notices.length = 0;
      sent.length = 0;
      timers.length = 0;
    },
    /** One completed turn; the fall-through schedules the next iteration. */
    async turn(text = "Updated README.md with the new flag.") {
      await (handlers.get("message_end") ?? []).at(0)?.({ message: assistant(text) }, ctx);
      for (const fn of handlers.get("agent_end") ?? []) await fn({ messages: [assistant(text)] }, ctx);
    },
    /** Run every pending timer once, as the event loop would. */
    fireTimers() {
      const due = [...timers];
      timers.length = 0;
      for (const t of due) t.fn();
    },
  };
}

describe("AG2 — a turn waits for somebody else's compaction", () => {
  let host: ReturnType<typeof makeHost>;

  beforeEach(() => {
    resetCompactionLock();
  });
  afterEach(async () => {
    await host?.stop();
    host?.restore();
    resetCompactionLock();
  });

  it("holds the iteration while another extension holds the lock", async () => {
    host = makeHost();
    await host.start("start keep the docs in step with the code --delay 1");
    beginCompaction("prinny-channel");

    await host.turn();
    host.fireTimers();

    assert.equal(host.sent.length, 0, "a turn sent now starts a run inside the compaction");
    assert.ok(
      host.timers.length > 0,
      "and it must be RESCHEDULED, not dropped — an unattended run cannot lose an iteration",
    );
  });

  it("and delivers it once the lock is released", async () => {
    host = makeHost();
    await host.start("start keep the docs in step with the code --delay 1");
    beginCompaction("prinny-channel");

    await host.turn();
    host.fireTimers();
    assert.equal(host.sent.length, 0);

    endCompaction("prinny-channel");
    host.fireTimers();

    assert.equal(host.sent.length, 1, "the iteration is deferred, never lost");
    assert.equal(host.sent[0].details?.kind, "continue");
  });

  it("says so once, not once per wait", async () => {
    host = makeHost();
    await host.start("start keep the docs in step with the code --delay 1");
    beginCompaction("prinny-channel");

    await host.turn();
    const said = () => host.notices.filter((n) => /is compacting/.test(n)).length;
    // The turn only SCHEDULES the iteration; the deferral happens when that
    // timer fires — which is the `--delay N` path, i.e. the ordinary one, and
    // the one whose timer deliberately carries no delivery ctx.
    host.fireTimers();
    assert.equal(said(), 1, "an unattended run must leave a trace");
    assert.match(host.notices.join(" | "), /prinny-channel/, "and it names who is compacting");
    assert.match(host.notices.join(" | "), /holding iteration/, "and says what is being held");

    for (let i = 0; i < 4; i++) host.fireTimers();
    assert.equal(said(), 1, "…and must not repeat it every five seconds");
  });

  it("the loop's OWN compaction is not something it waits for", async () => {
    // `requestEmergencyCompaction` and `interveneStuck` both release the lock in
    // their callbacks BEFORE they schedule the next turn, so this never fires in
    // practice — but the lock is re-entrant for the same owner and a turn held
    // for a compaction this package is running would be a deadlock, not a wait.
    host = makeHost();
    await host.start("start keep the docs in step with the code --delay 1");
    beginCompaction(LOOP_OWNER);
    endCompaction(LOOP_OWNER);

    await host.turn();
    host.fireTimers();
    assert.equal(host.sent.length, 1);
  });

  it("control — with the lock free the iteration goes as before", async () => {
    host = makeHost();
    await host.start("start keep the docs in step with the code --delay 1");

    await host.turn();
    host.fireTimers();

    assert.equal(host.sent.length, 1);
    assert.equal(host.sent[0].details?.kind, "continue");
    assert.equal(host.notices.filter((n) => /is compacting/.test(n)).length, 0);
  });
});

/**
 * AH6 — the directive survives the deferral AG2 introduced.
 *
 * `deliverLoopTurn` and `interveneStuck` take the `queueOnly` path in exactly one
 * situation: `ctx.hasPendingMessages()` is true, i.e. a turn is already coming.
 * That is also the situation in which `_handlePostAgentRun()` will run
 * `agent.continue()` and produce ANOTHER `agent_end` within milliseconds — well
 * inside `COMPACTION_WAIT_MS`, and `agent_end`'s first act is
 * `clearPendingTimer()`.
 *
 * So AG2's deferral, on that path, did not delay the directive; it deleted it.
 * Everything above it in the ladder had already been charged — the signal
 * counters, the intervention count, the penalty turns, `turnsWithoutTools`, and
 * the operator's notice saying what the model has been told — and what the model
 * eventually received was `continue`.
 *
 * That is V4's and AF3's own failure ("the loop needs THIS TEXT to reach the
 * model"), arriving through the fix that was written eleven passes later.
 */
describe("AH6 — a deferred DIRECTIVE is not lost to the next agent_end", () => {
  let host: ReturnType<typeof makeHost>;

  beforeEach(() => {
    resetCompactionLock();
  });
  afterEach(async () => {
    await host?.stop();
    host?.restore();
    resetCompactionLock();
  });

  it("re-attaches the charged directive to the next turn the loop sends", async () => {
    host = makeHost();
    await host.start("start keep the docs in step with the code --endless");
    // A human typed while the run was streaming: this is the ONLY thing that
    // makes hasPendingMessages() true (AA3), and it is the whole premise of the
    // queueOnly path.
    host.ctx.hasPendingMessages = () => true;
    beginCompaction("prinny-channel");

    // LOOP_BLOCKED charges blockedSignalCount and announces "continuing with
    // assumptions" before the directive is delivered.
    await host.turn("LOOP_BLOCKED: no credentials for the staging registry.");
    assert.equal(host.sent.length, 0, "nothing may be sent into the compaction");
    assert.match(host.notices.join(" | "), /continuing with assumptions/, "the ladder was charged and announced");

    // The turn that was already coming ends. Its agent_end clears the loop's one
    // timer slot — the deferred `unblock` had nowhere else to live.
    host.ctx.hasPendingMessages = () => false;
    await host.turn("Right, carrying on.");

    endCompaction("prinny-channel");
    host.fireTimers();

    assert.equal(host.sent.length, 1, "exactly one turn is still sent");
    assert.equal(
      host.sent[0].details?.kind,
      "unblock",
      "the model must be told to assume and continue — the thing the operator was told it had been told",
    );
  });

  it("a fresher directive supersedes a remembered one", async () => {
    host = makeHost();
    await host.start("start keep the docs in step with the code --endless");
    host.ctx.hasPendingMessages = () => true;
    beginCompaction("prinny-channel");

    await host.turn("LOOP_BLOCKED: no credentials.");
    assert.equal(host.sent.length, 0);

    // The same run, read again, now reports done instead. `improve` is this
    // ladder's answer to that, and it is the newer reading.
    endCompaction("prinny-channel");
    host.ctx.hasPendingMessages = () => false;
    await host.turn("LOOP_DONE: docs are in step.");
    host.fireTimers();

    const kinds = host.sent.map((s) => s.details?.kind);
    assert.deepEqual(kinds, ["improve"], `expected one improve, got ${JSON.stringify(kinds)}`);
  });

  it("does not invent a directive out of a deferred `continue`", async () => {
    // The asymmetry AF3 draws, unchanged: a continue carries no decision and is
    // still allowed to be dropped, so nothing about it is worth remembering.
    host = makeHost();
    await host.start("start keep the docs in step with the code --endless");
    beginCompaction("prinny-channel");

    await host.turn("Updated README.md.");
    host.fireTimers();
    assert.equal(host.sent.length, 0, "held for the compaction");

    await host.turn("Updated CHANGELOG.md.");
    endCompaction("prinny-channel");
    host.fireTimers();

    assert.deepEqual(
      host.sent.map((s) => s.details?.kind),
      ["continue"],
      "exactly one continue, and no directive conjured out of two of them",
    );
  });

  it("a directive does not outlive the run it was decided for", async () => {
    host = makeHost();
    await host.start("start keep the docs in step with the code --endless");
    host.ctx.hasPendingMessages = () => true;
    beginCompaction("prinny-channel");
    await host.turn("LOOP_BLOCKED: no credentials.");
    assert.equal(host.sent.length, 0);

    // /loop start replaces the run; resetContextRecovery drops every marker.
    await host.run("start something else entirely --endless");
    endCompaction("prinny-channel");
    host.ctx.hasPendingMessages = () => false;
    await host.turn("Made a start.");
    host.fireTimers();

    assert.deepEqual(
      host.sent.map((s) => s.details?.kind),
      ["continue"],
      "the previous run's unblock must not arrive in this one",
    );
  });
});
