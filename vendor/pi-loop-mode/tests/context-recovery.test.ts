// Tests for the forge fork's context-recovery behaviour.
//
//   node --experimental-strip-types --test tests/*.test.ts      (from vendor/pi-loop-mode)
//
// The scenarios below are the real failure this fork exists to fix, replayed against the
// extension's own event handlers rather than against a description of them: pi recovers an
// overflowed context itself, between our agent_end handler and the end of the run. Upstream asked
// for a second compaction in that window, pi answered "Already compacted", and the loop treated
// another component's success as its own fatal error.

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";

import {
  branchEndsInCompaction,
  buildEmergencyCompaction,
  isBenignCompactionError,
  isContextPressure,
  MAX_COMPRESSION_LEVEL,
} from "../src/context-recovery.ts";
import { defaultState, type LoopState } from "../src/loop-state.ts";
import loopModeExtension from "../extensions/index.ts";

// The extension logs to `.pi-loop-log.jsonl` in the process cwd; keep that out of the checkout.
const WORKDIR = mkdtempSync(join(tmpdir(), "loop-mode-test-"));
const ORIGINAL_CWD = process.cwd();
before(() => process.chdir(WORKDIR));
after(() => process.chdir(ORIGINAL_CWD));

// --------------------------------------------------------------------------------------------
// Pure helpers
// --------------------------------------------------------------------------------------------

describe("isBenignCompactionError", () => {
  test("recognizes pi's two no-work-to-do compaction errors", () => {
    assert.equal(isBenignCompactionError("Already compacted"), true);
    assert.equal(isBenignCompactionError("Nothing to compact (session too small)"), true);
  });

  test("does not swallow real compaction failures", () => {
    assert.equal(isBenignCompactionError("Summarization failed: Backend returned 500"), false);
    assert.equal(isBenignCompactionError("Compaction cancelled"), false);
    assert.equal(isBenignCompactionError("No model selected"), false);
  });
});

describe("branchEndsInCompaction", () => {
  test("matches pi's own prepareCompaction() guard", () => {
    assert.equal(branchEndsInCompaction([]), false);
    assert.equal(branchEndsInCompaction([{ type: "message" }]), false);
    assert.equal(branchEndsInCompaction([{ type: "message" }, { type: "compaction" }]), true);
    // Anything appended after the compaction makes a fresh compaction possible again.
    assert.equal(branchEndsInCompaction([{ type: "compaction" }, { type: "custom" }]), false);
  });
});

describe("isContextPressure", () => {
  test("classifies the observed failure: a bare 400 on a saturated context", () => {
    assert.equal(
      isContextPressure({ stopReason: "error", errorMessage: 'Backend returned 400', contextPercent: 100 }),
      true,
    );
  });

  test("classifies a named overflow whatever the local estimate says", () => {
    // percent is null right after a compaction and 0 before the first usage report. A real
    // overflow routed to the generic retry path would back off forever against a context that
    // can never fit, so the provider's own wording has to be enough on its own.
    for (const contextPercent of [null, 0, 12]) {
      assert.equal(
        isContextPressure({
          stopReason: "error",
          errorMessage: "the request exceeds the model's maximum context length",
          contextPercent,
        }),
        true,
        `percent ${contextPercent}`,
      );
      assert.equal(
        isContextPressure({ stopReason: "error", errorMessage: "n_ctx exceeded", contextPercent }),
        true,
        `percent ${contextPercent}`,
      );
    }
  });

  test("leaves ordinary provider errors on the backoff path", () => {
    assert.equal(
      isContextPressure({ stopReason: "error", errorMessage: "Backend returned 503", contextPercent: 20 }),
      false,
    );
    assert.equal(isContextPressure({ stopReason: "stop", contextPercent: 99 }), false);
  });

  test("still catches a truncated turn on a full context", () => {
    assert.equal(isContextPressure({ stopReason: "length", outputTokens: 4, contextPercent: 10 }), true);
    assert.equal(isContextPressure({ stopReason: "length", outputTokens: 900, contextPercent: 92 }), true);
  });
});

describe("buildEmergencyCompaction", () => {
  const preparation = {
    firstKeptEntryId: "entry-1",
    tokensBefore: 33_719,
    fileOps: {
      read: new Set(["src/a.ts", "src/b.ts"]),
      written: new Set(["src/c.ts"]),
      edited: new Set(["src/d.ts"]),
    },
  };

  function state(): LoopState {
    return {
      ...defaultState(),
      description: "x".repeat(20_000),
      completionCriteria: "y".repeat(9_000),
      lastNotice: "z".repeat(5_000),
      iterationCount: 7,
    };
  }

  before(() => {
    writeFileSync(join(WORKDIR, "GOAL.md"), "g".repeat(30_000));
    writeFileSync(join(WORKDIR, "PROGRESS.md"), "p".repeat(30_000));
  });

  test("each compression level produces a materially smaller summary", () => {
    const sizes = [0, 1, 2].map((level) => buildEmergencyCompaction(state(), preparation, WORKDIR, level).summary.length);
    assert.ok(sizes[0] > sizes[1], `level 0 (${sizes[0]}) should exceed level 1 (${sizes[1]})`);
    assert.ok(sizes[1] > sizes[2], `level 1 (${sizes[1]}) should exceed level 2 (${sizes[2]})`);
    assert.ok(sizes[2] < 4_000, `tightest level should be small, got ${sizes[2]}`);
  });

  test("the tightest level drops durable file excerpts but still names the goal file", () => {
    const tight = buildEmergencyCompaction(state(), preparation, WORKDIR, MAX_COMPRESSION_LEVEL).summary;
    assert.doesNotMatch(tight, /gggggggggg/, "file excerpts must be gone at the tightest level");
    assert.match(tight, /Excerpts omitted/);
  });

  test("every level keeps the goal and the instruction to make progress", () => {
    for (let level = 0; level <= MAX_COMPRESSION_LEVEL; level++) {
      const result = buildEmergencyCompaction(state(), preparation, WORKDIR, level);
      assert.match(result.summary, /## Goal/, `level ${level}`);
      assert.match(result.summary, /## Next Step/, `level ${level}`);
      assert.equal(result.firstKeptEntryId, "entry-1");
      assert.equal(result.tokensBefore, 33_719);
    }
  });

  test("an out-of-range level clamps instead of throwing", () => {
    const clamped = buildEmergencyCompaction(state(), preparation, WORKDIR, 99).summary;
    const tightest = buildEmergencyCompaction(state(), preparation, WORKDIR, MAX_COMPRESSION_LEVEL).summary;
    assert.equal(clamped, tightest);
  });
});

// --------------------------------------------------------------------------------------------
// Extension harness — drives the registered handlers exactly as pi does
// --------------------------------------------------------------------------------------------

type Handler = (event: any, ctx: any) => Promise<any>;

const handlers = new Map<string, Handler>();
let commandHandler: (args: string, ctx: any) => Promise<void>;

const notifications: { message: string; level: string }[] = [];
const statuses: string[] = [];
const compactRequests: any[] = [];
const sentTurns: any[] = [];

let branch: any[] = [];
let contextPercent: number | null = 100;

const pi = {
  on(event: string, handler: Handler) {
    handlers.set(event, handler);
  },
  registerCommand(_name: string, config: { handler: (args: string, ctx: any) => Promise<void> }) {
    commandHandler = config.handler;
  },
  appendEntry(customType: string, data: unknown) {
    branch.push({ type: "custom", customType, data });
  },
  sendMessage(message: unknown, options: unknown) {
    sentTurns.push({ message, options });
    branch.push({ type: "custom", customType: "loop" });
  },
  async exec() {
    return { code: 0, stdout: "", stderr: "" };
  },
  async setModel() {
    return true;
  },
};

const ctx = {
  cwd: WORKDIR,
  mode: "tui",
  hasUI: true,
  ui: {
    notify(message: string, level = "info") {
      notifications.push({ message, level });
    },
    setStatus(_key: string, text: string) {
      statuses.push(text);
    },
  },
  sessionManager: {
    getBranch: () => branch,
    getEntries: () => branch,
  },
  modelRegistry: { find: () => undefined, getAll: () => [] },
  isIdle: () => true,
  hasPendingMessages: () => false,
  getContextUsage: () => (contextPercent === null ? undefined : { percent: contextPercent }),
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

const goodTurn = {
  messages: [
    {
      role: "assistant",
      content: [{ type: "text", text: "Edited src/server.ts and ran the build." }],
      stopReason: "stop",
      usage: { output: 120 },
    },
  ],
};

function reset(): void {
  notifications.length = 0;
  statuses.length = 0;
  compactRequests.length = 0;
  sentTurns.length = 0;
}

/** Reads the loop's own /loop status report — the only supported view of its private state. */
async function loopStatus(): Promise<string> {
  const before = notifications.length;
  await commandHandler("status", ctx);
  return notifications
    .slice(before)
    .map((entry) => entry.message)
    .join("\n");
}

async function startLoop(): Promise<void> {
  await commandHandler("end", ctx);
  branch = [{ type: "message" }];
  contextPercent = 100;
  reset();
  await commandHandler("start Improve the site. Done when: the build passes", ctx);
  reset();
}

/** One full pressure cycle: the turn fails, pi declines to recover, the loop compacts itself. */
async function pressureCycle(compactionError = "Already compacted"): Promise<void> {
  await emit("agent_end", overflowTurn);
  await emit("agent_settled", {});
  const request = compactRequests.at(-1);
  if (request) request.onError(new Error(compactionError));
}

describe("loop context recovery", () => {
  before(() => {
    loopModeExtension(pi as any);
    assert.ok(commandHandler, "extension registered no /loop command");
  });

  beforeEach(async () => {
    await startLoop();
  });

  after(async () => {
    // Leaves no pending timer behind to keep the test runner alive.
    await commandHandler("end", ctx);
  });

  test("agent_end does not race pi's own overflow recovery", async () => {
    await emit("agent_end", overflowTurn);
    assert.equal(compactRequests.length, 0, "compaction must wait until pi has settled");
    assert.match(notifications.map((n) => n.message).join("\n"), /context pressure detected/i);
  });

  test("pi's own compaction is adopted as the recovery, not answered with a second one", async () => {
    await emit("agent_end", overflowTurn);
    // pi compacts the overflowed turn itself and will re-run it.
    branch.push({ type: "compaction" });
    await emit("session_compact", { reason: "overflow", willRetry: true });
    await emit("agent_settled", {});

    assert.equal(compactRequests.length, 0, "the loop must not ask pi to compact what it just compacted");
    const status = await loopStatus();
    assert.match(status, /Active: true/);
    assert.match(status, /Status: running/);
    assert.match(status, /Context recoveries: 1/);
  });

  test("pi promising a retry does not produce a second turn for the same iteration", async () => {
    await emit("agent_end", overflowTurn);
    branch.push({ type: "compaction" });
    reset();
    await emit("session_compact", { reason: "overflow", willRetry: true });
    assert.equal(sentTurns.length, 0, "pi is re-running the turn; sending our own would double it");
  });

  test("pi compacting without a retry resumes the loop immediately", async () => {
    await emit("agent_end", overflowTurn);
    branch.push({ type: "compaction" });
    reset();
    await emit("session_compact", { reason: "threshold", willRetry: false });
    assert.equal(sentTurns.length, 1, "nobody else will send the next turn");
  });

  test("'Already compacted' keeps the loop running instead of pausing it", async () => {
    await pressureCycle("Already compacted");

    const status = await loopStatus();
    assert.match(status, /Active: true/);
    assert.doesNotMatch(status, /Status: paused/);
    assert.match(status, /Context recoveries: 1/);
    assert.ok(sentTurns.length > 0, "the loop must schedule its next turn");
    assert.ok(
      !notifications.some((entry) => /Use \/compact/.test(entry.message)),
      "an unattended loop must not stop to ask for a manual /compact",
    );
  });

  test("a branch that already ends in a compaction is never sent to pi", async () => {
    // Belt and braces for a compaction whose session_compact event we never saw: pi compacted
    // between agent_end and the settle, so the branch ends in a compaction entry and pi's
    // prepareCompaction() would refuse. The loop reads the branch instead of asking and finding out.
    await emit("agent_end", overflowTurn);
    branch.push({ type: "compaction" });
    await emit("agent_settled", {});
    assert.equal(compactRequests.length, 0, "pi would only answer 'Already compacted'");
    const status = await loopStatus();
    assert.match(status, /Status: running/);
    assert.ok(sentTurns.length > 0, "the recovered context must be put back to work");
  });

  test("a genuine compaction failure cools down and retries rather than stopping", async () => {
    await pressureCycle("Summarization failed: Backend returned 500");
    const status = await loopStatus();
    assert.match(status, /Active: true/);
    assert.match(status, /Status: retrying/);
    assert.match(status, /cooldown 1\/3/);
    assert.match(notifications.map((n) => n.message).join("\n"), /cooling down/i);
  });

  test("repeated pressure escalates the summary instead of repeating it", async () => {
    await pressureCycle();
    await pressureCycle();
    const status = await loopStatus();
    assert.match(status, /summary level [1-9]/, "a summary that did not free room must be built tighter");
  });

  test("the ladder ends in a pause only after every cooldown is spent", async () => {
    let pausedAfter = 0;
    for (let cycle = 1; cycle <= 40; cycle++) {
      await pressureCycle();
      const status = await loopStatus();
      if (/Status: paused/.test(status)) {
        pausedAfter = cycle;
        break;
      }
    }
    assert.ok(pausedAfter > 0, "an unrecoverable context must eventually stop burning turns");
    assert.ok(
      pausedAfter >= 9,
      `the loop should exhaust the cooldown ladder first, paused after only ${pausedAfter} cycles`,
    );
  });

  test("a completed turn retires the whole recovery ladder", async () => {
    await pressureCycle();
    contextPercent = 40;
    await emit("agent_end", goodTurn);
    const status = await loopStatus();
    assert.match(status, /Status: running/);
    assert.doesNotMatch(status, /cooldown/);
    assert.doesNotMatch(status, /summary level/);
  });

  test("an overflow compaction is built locally, not by the model that just refused the context", async () => {
    await emit("agent_end", overflowTurn);
    const result = await emit("session_before_compact", {
      reason: "overflow",
      willRetry: true,
      preparation: {
        firstKeptEntryId: "entry-9",
        tokensBefore: 33_719,
        fileOps: { read: new Set(), written: new Set(), edited: new Set() },
      },
    });
    assert.ok(result?.compaction, "pi must be handed a summary it does not need the LLM for");
    assert.match(result.compaction.summary, /## Goal/);
    assert.equal(result.compaction.firstKeptEntryId, "entry-9");
  });

  test("a routine threshold compaction still uses pi's own model summary", async () => {
    contextPercent = 60;
    const result = await emit("session_before_compact", {
      reason: "threshold",
      willRetry: false,
      preparation: {
        firstKeptEntryId: "entry-2",
        tokensBefore: 20_000,
        fileOps: { read: new Set(), written: new Set(), edited: new Set() },
      },
    });
    assert.equal(result, undefined, "there is context room to spare; the better summary wins");
  });
});
