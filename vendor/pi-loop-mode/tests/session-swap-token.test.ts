/**
 * AM4 — the one continuation that survives a session swap, and the token that
 * did not move for it.
 *
 * `runToken` exists for exactly this, and says so:
 *
 * > Monotonic run token. Incremented on every start/resume/stop/end. All async
 * > continuations (timers, `agent_end` tails after awaits, compaction callbacks)
 * > capture it and bail out when it changed, so a `/loop stop` issued mid-await
 * > can never be overridden by stale code paths.
 *
 * Eleven places bump it — `runLoop`, `resume`, `stop`, `end`, `finalizeSoftStop`,
 * the three pauses, the operator-abort rung — and the two SESSION transitions
 * did not. A session swap (`/new`, `/resume`, `/fork`, a reload) is the
 * transition that invalidates the most: it replaces `state` wholesale via
 * `restoreState`, and it makes the `pi` and `ctx` every surviving continuation
 * captured stale, because pi calls `_extensionRunner.invalidate()` on the old
 * one.
 *
 * ## Which continuation survives
 *
 * Exactly one, and that is why this took twenty-two passes to notice.
 * `session_start` clears `pendingTimer` and drops the turn buffers, so timers
 * and per-turn state are already handled. A `ctx.compact()` callback is not
 * reachable from here at all: pi holds it inside
 *
 * ```js
 *   compact: (options) => { void (async () => {
 *       try { const result = await this.compact(...); options?.onComplete?.(result); }
 *       catch (error) { options?.onError?.(err); }
 *   })(); },                                    agent-session.js:1911
 * ```
 *
 * and there are two of them: `requestEmergencyCompaction` and `interveneStuck`'s
 * compaction rung.
 *
 * ## And the swap is what makes it fire
 *
 * `AgentSession.dispose()` calls `abortCompaction()`, so replacing the session
 * aborts an in-flight compaction and pi throws `"Compaction cancelled"` — which
 * `isBenignCompactionError` correctly does NOT swallow. So the callback runs, on
 * the ordinary path, at the exact moment everything it captured has gone stale.
 *
 * What it then did: charged the NEWLY RESTORED run's context-cooldown ladder for
 * a compaction that belonged to the previous one, and called `persistState(pi)`
 * on the previous session's `pi` — whose `appendEntry` is
 * `runtime.assertActive(); runtime.appendEntry(...)`. That throw leaves through
 * pi's `catch (error) { options?.onError?.(err) }`, i.e. out of a `void`ed async
 * IIFE: an unhandled rejection, not a caught error.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";

import loopModeExtension from "../extensions/index.ts";
import { resetCompactionLock } from "../src/compaction-lock.ts";
import { completedCheck } from "./exec-shapes.ts";

type Handler = (event: any, ctx: any) => Promise<any>;

const handlers = new Map<string, Handler>();
let commandHandler: (args: string, ctx: any) => Promise<void>;

const notifications: { message: string; level: string }[] = [];
const compactRequests: any[] = [];
const sentTurns: any[] = [];
let branch: any[] = [];
/** Set once the previous session's `pi` has been invalidated, as pi does on a swap. */
let piIsStale = false;

const pi = {
  on(event: string, handler: Handler) {
    handlers.set(event, handler);
  },
  registerCommand(_name: string, config: { handler: (args: string, ctx: any) => Promise<void> }) {
    commandHandler = config.handler;
  },
  registerTool() {},
  appendEntry(customType: string, data: unknown) {
    // Faithful to pi's binding: `runtime.assertActive()` first, and it THROWS
    // rather than returning — which is the second half of the damage.
    if (piIsStale) throw new Error("This extension ctx is stale after session replacement or reload.");
    branch.push({ type: "custom", customType, data });
  },
  sendMessage(message: unknown, options: unknown) {
    sentTurns.push({ message, options });
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
    notify(message: string, level = "info") {
      notifications.push({ message, level });
    },
    setStatus() {},
  },
  sessionManager: { getBranch: () => branch, getEntries: () => branch },
  modelRegistry: { find: () => undefined, getAll: () => [] },
  model: { api: "openai-completions", contextWindow: 32_768 },
  isIdle: () => true,
  hasPendingMessages: () => false,
  getContextUsage: () => ({ percent: 100, contextWindow: 32_768, tokens: 32_768 }),
  compact(options: any) {
    compactRequests.push(options);
  },
  abort() {},
  async waitForIdle() {},
};

function emit(event: string, payload: unknown = {}): Promise<any> {
  const handler = handlers.get(event);
  assert.ok(handler, `extension registered no ${event} handler`);
  return handler(payload, ctx);
}

/** An overflowed turn: what routes the loop into its context ladder. */
const overflowTurn = {
  messages: [
    {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "Backend returned 400",
      usage: { output: 0 },
    },
  ],
};

loopModeExtension(pi as never);

beforeEach(async () => {
  piIsStale = false;
  branch = [{ type: "message" }];
  notifications.length = 0;
  compactRequests.length = 0;
  sentTurns.length = 0;
  resetCompactionLock();
  await commandHandler("end", ctx);
  branch = [{ type: "message" }];
  await commandHandler("start Improve the site. Done when: the build passes", ctx);
  notifications.length = 0;
  compactRequests.length = 0;
  sentTurns.length = 0;
});

/** Drive the loop to the point where it has asked pi to compact and is holding the callbacks. */
async function reachEmergencyCompaction(): Promise<void> {
  await emit("agent_end", overflowTurn);
  await emit("agent_settled", {});
  assert.equal(compactRequests.length, 1, "the loop must have asked pi to compact");
}

describe("AM4 — a compaction callback that outlives its session", () => {
  test("does nothing once the session has been replaced", async () => {
    await reachEmergencyCompaction();
    const pending = compactRequests[0];

    // The swap. pi tears the old session down and builds a new one; both halves
    // reach this extension.
    await emit("session_shutdown", {});
    await emit("session_start", {});
    piIsStale = true;
    notifications.length = 0;
    sentTurns.length = 0;

    // `AgentSession.dispose()` calls `abortCompaction()`, so the swap is what
    // MAKES this fire, with pi's own wording.
    await pending.onError(new Error("Compaction cancelled"));

    assert.deepEqual(
      notifications.map((n) => n.message).filter((m) => /context recovery stalled|cooling down/i.test(m)),
      [],
      "the previous session's compaction must not charge this run's cooldown ladder",
    );
    assert.deepEqual(sentTurns, [], "…and must not schedule a turn into it");
  });

  test("the success callback is invalidated the same way", async () => {
    await reachEmergencyCompaction();
    const pending = compactRequests[0];

    await emit("session_shutdown", {});
    await emit("session_start", {});
    piIsStale = true;
    notifications.length = 0;
    sentTurns.length = 0;

    await pending.onComplete({});

    assert.deepEqual(
      notifications.map((n) => n.message).filter((m) => /context recovered/i.test(m)),
      [],
      "a recovery that belongs to a dead session is not this run's recovery",
    );
    assert.deepEqual(sentTurns, [], "…and must not resume it with a `recover` turn");
  });

  test("session_shutdown alone is enough — the callback may fire before the new session opens", async () => {
    await reachEmergencyCompaction();
    const pending = compactRequests[0];

    await emit("session_shutdown", {});
    piIsStale = true;
    notifications.length = 0;
    sentTurns.length = 0;

    await pending.onError(new Error("Compaction cancelled"));

    assert.deepEqual(notifications, []);
    assert.deepEqual(sentTurns, []);
  });
});

describe("AM4 — controls: the token still lets the RIGHT callback through", () => {
  test("a compaction that completes inside its own session still recovers it", async () => {
    await reachEmergencyCompaction();
    notifications.length = 0;
    sentTurns.length = 0;

    await compactRequests[0].onComplete({});

    assert.ok(
      notifications.some((n) => /context recovered/i.test(n.message)),
      "nothing has moved, so the recovery is this run's",
    );
    assert.equal(sentTurns.length, 1, "and it resumes with a turn");
  });

  test("a compaction that fails inside its own session still cools down", async () => {
    await reachEmergencyCompaction();
    notifications.length = 0;
    sentTurns.length = 0;

    await compactRequests[0].onError(new Error("Summarization failed: Backend returned 500"));

    assert.ok(
      notifications.some((n) => /context recovery stalled/i.test(n.message)),
      "a real failure inside the live run still escalates",
    );
  });

  test("/loop stop already invalidated it, and still does", async () => {
    await reachEmergencyCompaction();
    await commandHandler("stop", ctx);
    notifications.length = 0;
    sentTurns.length = 0;

    await compactRequests[0].onError(new Error("Summarization failed: Backend returned 500"));

    assert.deepEqual(
      notifications.map((n) => n.message).filter((m) => /context recovery stalled/i.test(m)),
      [],
      "the mechanism this pass extended to session transitions",
    );
  });
});
