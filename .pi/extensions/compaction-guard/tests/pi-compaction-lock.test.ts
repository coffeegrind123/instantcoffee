/**
 * AM2 — the compaction the lock could not see.
 *
 * Three senders in this stack ask "is somebody compacting this session right
 * now?" before they start a turn, and all three could only ever see the two
 * EXTENSIONS that compact. The third compactor is pi, and it is the one that
 * compacts most:
 *
 * ```
 *   pi-subagents-lite  SpawnCoordinator.emitIndividualNudge   AH1, 17th pass
 *   pi-loop-mode       sendLoopTurn                           AG2, 16th pass
 *   prinny-channel     the empty-turn continuation            AG3, 16th pass
 * ```
 *
 * The handoff has carried it as open for seven passes on the strength of a
 * sentence about the wrong event — pi does not emit `compaction_start` to
 * extensions, but it emits `session_before_compact` from BOTH of its compaction
 * entry points, for every reason, whenever any extension has a handler. Two in
 * this stack do.
 *
 * The window that matters is `prompt()`'s pre-run `_checkCompaction`
 * (`agent-session.js:865`), where `_isAgentRunActive` is false — so a sender's
 * `sendCustomMessage(triggerTurn)` takes `_runAgentPrompt` (`:1088`), which
 * checks nothing, and a whole agent run happens inside the compaction, built
 * from the pre-compaction context. `prompt()` is what an operator's typed
 * message reaches and what `prinny-channel`'s `sendUserMessage` reaches.
 *
 * The suite drives the SHIPPED handlers, and reads the lock through
 * `vendor/pi-subagents-lite`'s own read-only copy — i.e. through one of the
 * three actual readers, not through the writer's view of itself.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import guard from "../index.ts";
import { PI_OWNER, beginCompaction, resetCompactionLock } from "../src/compaction-lock.ts";
// A READER's copy, deliberately: this is what `emitIndividualNudge` calls.
import { compactionInFlight as readerSees } from "../../../../vendor/pi-subagents-lite/src/spawn/compaction-lock.ts";
import { LOOP_OWNER, beginCompaction as loopTakes, endCompaction as loopReleases } from "../../../../vendor/pi-loop-mode/src/compaction-lock.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

const SPAWN_DEPTH_GLOBAL = "__PI_SUBAGENT_SPAWN_DEPTH__";

function setSpawnDepth(depth: number | undefined): void {
  const slot = globalThis as unknown as Record<string, unknown>;
  if (depth === undefined) delete slot[SPAWN_DEPTH_GLOBAL];
  else slot[SPAWN_DEPTH_GLOBAL] = depth;
}

/**
 * The guard, loaded as pi loads it.
 *
 * `inChild` is applied around the FACTORY call, because that is where the
 * extension asks — a child's factory runs inside `buildSubagentSession`'s
 * bracket, and its handlers run long after the bracket has closed.
 */
function makeHost(opts: { inChild?: boolean; percent?: number } = {}) {
  const handlers = new Map<string, Handler[]>();
  const notices: string[] = [];
  const pi = {
    on(name: string, fn: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), fn]);
    },
  };
  const window = 32_768;
  const percent = opts.percent ?? 40;
  const ctx = {
    ui: {
      notify(message: string) {
        notices.push(message);
      },
    },
    model: { contextWindow: window },
    getContextUsage: () => ({ tokens: Math.round((window * percent) / 100), contextWindow: window, percent }),
  };

  setSpawnDepth(opts.inChild ? 1 : undefined);
  try {
    guard(pi as never);
  } finally {
    setSpawnDepth(undefined);
  }

  const fire = async (name: string, event: unknown = {}) => {
    let result: unknown;
    for (const fn of handlers.get(name) ?? []) result = await fn(event, ctx);
    return result;
  };

  return {
    notices,
    fire,
    handlerNames: () => [...handlers.keys()],
    beforeCompact: (previousSummary = "") =>
      fire("session_before_compact", {
        reason: "threshold",
        preparation: { previousSummary },
      }),
  };
}

describe("AM2 — pi's own compaction takes the lock", () => {
  beforeEach(() => {
    resetCompactionLock();
    setSpawnDepth(undefined);
  });

  it("is free before anything compacts", async () => {
    makeHost();
    assert.equal(readerSees(), undefined);
  });

  it("a reader sees a holder once pi starts compacting", async () => {
    const host = makeHost();
    await host.beforeCompact();
    assert.equal(readerSees()?.owner, PI_OWNER);
  });

  it("names the HOST, not this extension — it is what the notices print", async () => {
    const host = makeHost();
    await host.beforeCompact();
    // Every reader's sentence is `${holder.owner} is compacting`. "compaction-guard
    // is compacting" would name the wrong actor to an operator.
    assert.equal(readerSees()?.owner, "pi");
  });

  it("session_compact releases it", async () => {
    const host = makeHost();
    await host.beforeCompact();
    await host.fire("session_compact", { reason: "threshold" });
    assert.equal(readerSees(), undefined);
  });

  it("agent_start releases it — the compaction pi cancelled emits no session_compact", async () => {
    const host = makeHost();
    await host.beforeCompact();
    // The operator's Esc reaches `session.abortCompaction()`
    // (interactive-mode.js:2703) and `compact()`'s catch emits nothing to
    // extensions. Without this rung the hold would run to STALE_MS.
    await host.fire("agent_start");
    assert.equal(readerSees(), undefined);
  });

  it("agent_settled releases it", async () => {
    const host = makeHost();
    await host.beforeCompact();
    await host.fire("agent_settled");
    assert.equal(readerSees(), undefined);
  });

  it("session_shutdown releases it, because the lock outlives the session", async () => {
    const host = makeHost();
    await host.beforeCompact();
    await host.fire("session_shutdown");
    assert.equal(readerSees(), undefined);
  });
});

describe("AM2 — each release is load-bearing on its own", () => {
  // Asserted without going through the take, so removing ONE of the four rungs
  // fails exactly one test. `session_compact` is the only one pi guarantees;
  // the other three exist because a cancelled or failed compaction emits it
  // never, and a five-minute hold is worse than the collision.
  beforeEach(() => {
    resetCompactionLock();
    setSpawnDepth(undefined);
  });

  for (const event of ["session_compact", "agent_start", "agent_settled", "session_shutdown"]) {
    it(`${event} releases a hold this extension already had`, async () => {
      const host = makeHost();
      beginCompaction(PI_OWNER);
      assert.equal(readerSees()?.owner, PI_OWNER, "precondition");
      await host.fire(event, { reason: "threshold" });
      assert.equal(readerSees(), undefined, `${event} must release pi's hold`);
    });
  }
});

describe("AM2 — a CHILD's compaction is not the parent's business", () => {
  beforeEach(() => {
    resetCompactionLock();
    setSpawnDepth(undefined);
  });

  it("a subagent's instance takes nothing", async () => {
    const child = makeHost({ inChild: true });
    await child.beforeCompact();
    // The lock is process-global and the question is per-session. A child
    // compacting must not defer the PARENT's loop turns and delegation results.
    assert.equal(readerSees(), undefined);
  });

  it("…and does not release the parent's hold either", async () => {
    const parent = makeHost();
    await parent.beforeCompact();
    assert.equal(readerSees()?.owner, PI_OWNER);

    const child = makeHost({ inChild: true });
    await child.fire("agent_settled");
    await child.fire("session_compact", { reason: "threshold" });
    assert.equal(readerSees()?.owner, PI_OWNER, "a child's turn ending is not the parent's compaction ending");
  });

  it("control — the child still caps its own tool output", async () => {
    const child = makeHost({ inChild: true, percent: 84.5 });
    const big = `${"x".repeat(200)}\n`.repeat(400);
    const capped = (await child.fire("tool_result", {
      toolName: "bash",
      toolCallId: "call-child",
      isError: false,
      content: [{ type: "text", text: big }],
    })) as { content?: { text: string }[] } | undefined;
    // The lock is the ONLY thing gated on being a child. Everything the guard
    // exists for is the same in both.
    assert.ok(capped?.content?.[0]?.text, "a child's oversized tool result is still capped");
    assert.ok(capped.content[0].text.length < big.length);
  });
});

describe("AM2 — it never takes a lock somebody else holds", () => {
  beforeEach(() => {
    resetCompactionLock();
    setSpawnDepth(undefined);
  });

  it("leaves an extension's own hold alone", async () => {
    const host = makeHost();
    // `pi-loop-mode`'s emergency compaction takes the lock and THEN calls
    // ctx.compact(), which emits session_before_compact — so this handler runs
    // inside somebody else's hold on the ordinary path.
    loopTakes(LOOP_OWNER);
    await host.beforeCompact();
    assert.equal(readerSees()?.owner, LOOP_OWNER, "the loop still owns its own compaction");
    loopReleases(LOOP_OWNER);
  });

  it("and cannot release one", async () => {
    const host = makeHost();
    loopTakes(LOOP_OWNER);
    await host.beforeCompact();
    await host.fire("session_compact", { reason: "manual" });
    await host.fire("agent_settled");
    assert.equal(readerSees()?.owner, LOOP_OWNER, "only the owner releases");
    loopReleases(LOOP_OWNER);
    assert.equal(readerSees(), undefined);
  });
});

describe("AM2 — controls: the guard's own work is unchanged", () => {
  beforeEach(() => {
    resetCompactionLock();
    setSpawnDepth(undefined);
  });

  it("still caps the carried-over summary while holding the lock", async () => {
    const host = makeHost();
    const previous = "s".repeat(20_000);
    const event = { reason: "threshold", preparation: { previousSummary: previous } };
    await host.fire("session_before_compact", event);
    assert.ok(event.preparation.previousSummary.length < previous.length, "the trim still happens");
    assert.equal(readerSees()?.owner, PI_OWNER, "and the lock is held across it");
  });

  it("still returns undefined, so pi keeps ownership of the compaction", async () => {
    const host = makeHost();
    const result = await host.beforeCompact("s".repeat(20_000));
    assert.equal(result, undefined);
  });

  it("registers the four release events", () => {
    const host = makeHost();
    const names = host.handlerNames();
    for (const name of ["session_compact", "agent_start", "agent_settled", "session_shutdown"]) {
      assert.ok(names.includes(name), `expected a ${name} handler`);
    }
  });
});
