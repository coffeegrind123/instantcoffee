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

import { resetCompactionLock } from "../src/compaction-lock.ts";

import {
  branchEndsInCompaction,
  buildEmergencyCompaction,
  buildHandoffCompaction,
  findHandoffCutEntryId,
  isBenignCompactionError,
  isContextPressure,
  MAX_COMPRESSION_LEVEL,
} from "../src/context-recovery.ts";
import { defaultState, type LoopState } from "../src/loop-state.ts";
import loopModeExtension from "../extensions/index.ts";
import { completedCheck } from "./exec-shapes.ts";

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
    // A real message after the compaction is something to summarize again.
    assert.equal(branchEndsInCompaction([{ type: "compaction" }, { type: "message" }]), false);
  });

  test("the loop's own state entries do not make a fresh compaction possible", () => {
    // This assertion used to say the opposite, with the comment "anything
    // appended after the compaction makes a fresh compaction possible again".
    // That is true of a MESSAGE and false of a `custom` entry, and the loop
    // appends one of those through `pi.appendEntry()` on ~33 paths — including
    // the `session_compact` handler, which persists immediately after pi
    // finishes compacting. So the branch stopped ending in a compaction the
    // moment the loop recorded that one had happened, and the short circuit was
    // lost on exactly the path it was written for.
    //
    // pi agrees: `prepareCompaction` gets past its own last-entry check but then
    // finds no messages between the previous compaction's boundary and the cut
    // point, and returns undefined anyway ("Nothing to compact"). A custom entry
    // carries no message, so it cannot change the answer.
    assert.equal(branchEndsInCompaction([{ type: "compaction" }, { type: "custom" }]), true);
    assert.equal(
      branchEndsInCompaction([{ type: "compaction" }, { type: "custom" }, { type: "custom" }]),
      true,
    );
    assert.equal(branchEndsInCompaction([{ type: "compaction" }, { type: "session_info" }]), true);
    // Control: a state entry AFTER a real message still reads as compactable.
    assert.equal(
      branchEndsInCompaction([{ type: "compaction" }, { type: "message" }, { type: "custom" }]),
      false,
    );
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

describe("findHandoffCutEntryId", () => {
  const smallTail = [
    { type: "session", id: "s" },
    { type: "message", id: "u1", message: { role: "user", content: [{ type: "text", text: "first" }] } },
    { type: "message", id: "a1", message: { role: "assistant", content: [{ type: "text", text: "first answer" }] } },
    { type: "custom", customType: "loop-state", id: "c1" },
    { type: "custom_message", customType: "loop", id: "p2", content: [{ type: "text", text: "continue" }] },
    { type: "message", id: "a2", message: { role: "assistant", content: [{ type: "text", text: "second answer" }] } },
  ];

  test("cuts at the start of the last turn, not at pi's 20k-token tail", () => {
    assert.equal(findHandoffCutEntryId(smallTail, "pi-cut"), "p2");
  });

  test("an oversized final turn keeps one message instead of carrying the flood into the next context", () => {
    const flooded = [
      ...smallTail.slice(0, -1),
      {
        type: "message",
        id: "a2",
        message: { role: "assistant", content: [{ type: "text", text: "x".repeat(40_000) }] },
      },
    ];
    // Keeping from p2 would keep the 40k-char answer too — the very thing that filled the context.
    assert.equal(findHandoffCutEntryId(flooded, "pi-cut"), "a2");
  });

  test("never cuts across an existing compaction boundary", () => {
    const compacted = [{ type: "compaction", id: "k1" }, ...smallTail.slice(4)];
    assert.equal(findHandoffCutEntryId(compacted, "pi-cut"), "p2");
  });

  test("falls back to pi's own cut point when there is nothing to cut at", () => {
    assert.equal(findHandoffCutEntryId([], "pi-cut"), "pi-cut");
    assert.equal(findHandoffCutEntryId([{ type: "custom", customType: "loop-state", id: "c1" }], "pi-cut"), "pi-cut");
  });
});

describe("buildHandoffCompaction", () => {
  const preparation = {
    firstKeptEntryId: "pi-cut",
    tokensBefore: 29_000,
    fileOps: { read: new Set(["src/a.ts"]), written: new Set<string>(), edited: new Set(["src/b.ts"]) },
  };

  function state(iteration: number): LoopState {
    return { ...defaultState(), description: "Improve the site", iterationCount: iteration };
  }

  test("does not grow with the run — the failure it replaces was a summary that did", () => {
    // pi merges each compaction summary into the previous one. Measured across one 32k session:
    // 1,666 → 11,054 chars, by which point compaction freed nothing at all.
    const early = buildHandoffCompaction(state(4), preparation, WORKDIR).summary.length;
    const late = buildHandoffCompaction(state(400), preparation, WORKDIR).summary.length;
    assert.ok(late - early <= 8, `grew by ${late - early} chars over 396 iterations`);
    assert.ok(late <= 4_000, `a handoff summary must stay bounded, got ${late}`);
  });

  test("stays materially smaller than the emergency summary it replaces on a small window", () => {
    const handoff = buildHandoffCompaction(state(4), preparation, WORKDIR).summary.length;
    const emergency = buildEmergencyCompaction(state(4), preparation, WORKDIR, 0).summary.length;
    assert.ok(handoff < emergency, `handoff ${handoff} should be smaller than emergency ${emergency}`);
  });

  test("tightens further when a handoff did not free enough room", () => {
    const sizes = [0, 1, 2].map((level) => buildHandoffCompaction(state(4), preparation, WORKDIR, [], level).summary.length);
    assert.ok(sizes[0] > sizes[1], `level 0 (${sizes[0]}) should exceed level 1 (${sizes[1]})`);
    assert.ok(sizes[1] > sizes[2], `level 1 (${sizes[1]}) should exceed level 2 (${sizes[2]})`);
  });

  test("tells the model the conversation is gone rather than letting it try to recall it", () => {
    const result = buildHandoffCompaction(state(4), preparation, WORKDIR);
    assert.match(result.summary, /## Goal/);
    assert.match(result.summary, /handoff/i);
    assert.match(result.summary, /PROGRESS\.md/);
    assert.equal(result.tokensBefore, 29_000);
  });

  /**
   * The per-section budgets do not fit inside the total, and they never did:
   * level 0 has room for 3,531 characters of body while its sections may claim
   * 7,500, and levels 1 and 2 are over by 1,469 and 489. That is fine — a
   * summary has to degrade somehow. What was not fine is that it degraded by
   * POSITION: the whole body was assembled and then cut with a blind `slice()`
   * from the front, so `## File Operations` fell off first and `## Durable
   * Project Context` next, and the levels that cut hardest are only reached
   * after a recovery that did not free enough room.
   *
   * `.pi/extensions/compaction-guard/src/summary-budget.ts` exists because pi's
   * own summary had exactly this failure. These pin the same repair on the
   * loop's own builder.
   */
  describe("every section survives every compression level", () => {
    const SECTIONS = [
      "## Goal",
      "## Completion Criteria",
      "## Loop State",
      "## Durable Project Context",
      "## File Operations",
      "## Next Step",
    ];

    /** A long-run state: the goal, criteria and last notice all outgrow their budgets. */
    function crowded(): LoopState {
      return {
        ...defaultState(),
        description: "Port the legacy importer to the new pipeline, keeping the CSV and JSONL front ends working. ".repeat(6),
        completionCriteria: "npm test passes and the 2GB fixture imports in under 90 seconds. ".repeat(6),
        iterationCount: 137,
        status: "retrying",
        lastNotice: "Context pressure 2/3: empty response at 91% context (no text, no thinking, no tool call). ".repeat(4),
      };
    }

    const crowdedPrep = {
      firstKeptEntryId: "pi-cut",
      tokensBefore: 30_000,
      fileOps: {
        read: new Set(Array.from({ length: 30 }, (_, i) => `src/read${i}.ts`)),
        written: new Set(["src/importer.ts", "src/stream.ts"]),
        edited: new Set(["src/pipeline.ts"]),
      },
    };

    for (const level of [0, 1, 2]) {
      test(`handoff level ${level} keeps all six sections`, () => {
        const { summary } = buildHandoffCompaction(crowded(), crowdedPrep, WORKDIR, [], level);
        for (const section of SECTIONS) {
          assert.ok(summary.includes(section), `level ${level} dropped ${section}`);
        }
      });

      test(`emergency level ${level} keeps all six sections`, () => {
        const { summary } = buildEmergencyCompaction(crowded(), crowdedPrep, WORKDIR, level);
        for (const section of SECTIONS) {
          assert.ok(summary.includes(section), `level ${level} dropped ${section}`);
        }
      });
    }

    test("still respects the total budget it was given (control)", () => {
      // Keeping every section must not be bought by overshooting the size the
      // whole mechanism exists to enforce.
      const budgets = [4_000, 2_000, 1_000];
      for (const level of [0, 1, 2]) {
        const { summary } = buildHandoffCompaction(crowded(), crowdedPrep, WORKDIR, [], level);
        assert.ok(summary.length <= budgets[level], `level ${level} produced ${summary.length} chars`);
      }
    });

    test("still shrinks with the level (control)", () => {
      const sizes = [0, 1, 2].map((l) => buildHandoffCompaction(crowded(), crowdedPrep, WORKDIR, [], l).summary.length);
      assert.ok(sizes[0] > sizes[1] && sizes[1] > sizes[2], `sizes were ${sizes.join(", ")}`);
    });

    test("spends the room on the sections that are written down nowhere else", () => {
      // The durable excerpts are the only section that is also on disk, and the
      // Next Step block already tells the model to read those files — so it is
      // the section that absorbs the shortfall, not the goal or the loop state.
      const { summary } = buildHandoffCompaction(crowded(), crowdedPrep, WORKDIR, [], 2);
      assert.match(summary, /- Iteration: 137/, "the iteration count exists nowhere else");
      assert.match(summary, /Port the legacy importer/, "and neither does the goal");
    });
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
/** 0 keeps the pre-handoff behaviour: pi reports no window, so no window-based decision fires. */
let contextWindow = 0;
let contextTokens: number | null = null;

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
    // Faithful to what pi resolves for a check that reached its own exit; see
    // tests/exec-shapes.ts for why a bare `{ code: 0 }` is not (AB1).
    return completedCheck(0);
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
  model: undefined as { contextWindow?: number } | undefined,
  isIdle: () => true,
  hasPendingMessages: () => false,
  getContextUsage: () =>
    contextPercent === null ? undefined : { percent: contextPercent, contextWindow, tokens: contextTokens },
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

/**
 * A clean "stop" with nothing in it — the exact shape found 36 times in the measured sessions
 * (`content: []`, `stopReason: "stop"`, one output token), always on a nearly-full context.
 */
const emptyTurn = {
  messages: [{ role: "assistant", content: [], stopReason: "stop", usage: { output: 1 } }],
};

/** Text, but no tool call: what the narration-only rule counts. */
const narrationTurn = {
  messages: [
    {
      role: "assistant",
      content: [{ type: "text", text: "Considering the next step in the plan." }],
      stopReason: "stop",
      usage: { output: 40 },
    },
  ],
};

function reset(): void {
  notifications.length = 0;
  statuses.length = 0;
  compactRequests.length = 0;
  sentTurns.length = 0;
  // Fifteenth pass: the compaction lock is process-global on purpose — it is how
  // two extensions in one process avoid aborting each other's compaction (§11.12)
  // — and this harness's `compact` stub never calls back, which is a faithful
  // model of a compaction that is STILL RUNNING. So without this, one test's
  // in-flight compaction makes the next test's loop stand aside, correctly, for a
  // session that no longer exists. Same shape as `r3`'s one-process-per-scenario
  // rule, one scope smaller.
  resetCompactionLock();
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
  contextWindow = 0;
  contextTokens = null;
  ctx.model = undefined;
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

  test("a routine threshold compaction on a roomy window still uses pi's own model summary", async () => {
    contextPercent = 60;
    contextWindow = 200_000;
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

// --------------------------------------------------------------------------------------------
// Small windows: handoff instead of compaction, and starvation instead of fixation
//
// pi's compaction defaults (reserveTokens 16384, keepRecentTokens 20000) are sized for a 200k
// window. On the 32k window this fork runs against they leave a floor of 20,000 tokens plus a
// summary that grows on every merge — above the point at which the model stops answering at all.
// --------------------------------------------------------------------------------------------

describe("small-window handoff", () => {
  const handoffBranch = [
    { type: "message", id: "u1", message: { role: "user", content: [{ type: "text", text: "first" }] } },
    { type: "message", id: "a1", message: { role: "assistant", content: [{ type: "text", text: "first answer" }] } },
    { type: "custom_message", customType: "loop", id: "p2", content: [{ type: "text", text: "continue" }] },
    { type: "message", id: "a2", message: { role: "assistant", content: [{ type: "text", text: "second answer" }] } },
  ];

  const preparation = {
    firstKeptEntryId: "pi-cut",
    tokensBefore: 29_000,
    fileOps: { read: new Set(), written: new Set(), edited: new Set() },
  };

  beforeEach(async () => {
    await startLoop();
  });

  after(async () => {
    await commandHandler("end", ctx);
  });

  test("a threshold compaction on a 32k window becomes a bounded handoff", async () => {
    // Well below any pressure threshold: it is the window, not the fill, that makes pi's defaults
    // unusable here — its own compaction would keep 20,000 of these 32,768 tokens.
    contextPercent = 55;
    contextWindow = 32_768;
    const result = await emit("session_before_compact", {
      reason: "threshold",
      willRetry: false,
      branchEntries: handoffBranch,
      preparation,
    });
    assert.ok(result?.compaction, "pi must not be left to keep 61% of this window");
    assert.match(result.compaction.summary, /handoff/i);
    assert.ok(result.compaction.summary.length <= 4_000, `summary was ${result.compaction.summary.length} chars`);
    assert.equal(result.compaction.firstKeptEntryId, "p2", "the cut is the last turn, not pi's 20k tail");
  });

  test("a saturated big window hands off too — the fill is enough on its own", async () => {
    contextPercent = 88;
    contextWindow = 200_000;
    const result = await emit("session_before_compact", {
      reason: "threshold",
      willRetry: false,
      branchEntries: handoffBranch,
      preparation,
    });
    assert.ok(result?.compaction);
    assert.equal(result.compaction.firstKeptEntryId, "p2");
  });

  test("an empty response on a full context is recovered, not scolded", async () => {
    contextPercent = 92;
    contextWindow = 32_768;
    await emit("agent_end", emptyTurn);

    const messages = notifications.map((entry) => entry.message).join("\n");
    assert.match(messages, /context pressure detected/i);
    assert.doesNotMatch(messages, /stuck/i, "an out-of-room model is not a repeating model");
    assert.equal(sentTurns.length, 0, "no prompt may be injected into a context that is already full");

    await emit("agent_settled", {});
    assert.equal(compactRequests.length, 1, "the room is the problem, so take room back");
  });

  test("an empty response with room to spare is a stuck verdict, not a recovery", async () => {
    // This test used to assert `Status: running` — a proxy for "the context
    // ladder did not claim this turn". That half still holds and is what the
    // compaction assertion below measures.
    //
    // What changed is the other half. An empty turn below the pressure
    // threshold used to fall through to the ordinary accounting and be counted
    // as ONE narration turn, so three of them were needed before anything
    // fired. On the local stack an empty turn costs the full generation cap
    // (~85 s of GPU) and carries no information at all — no answer, no tool
    // call, no fingerprint for any text rule to read — so it now gets its own
    // rule in `detectStuck` and fires on the first one.
    contextPercent = 30;
    contextWindow = 32_768;
    await emit("agent_end", emptyTurn);
    await emit("agent_settled", {});
    assert.equal(compactRequests.length, 0, "at 30% full the context is not the explanation");
    const messages = notifications.map((entry) => entry.message).join("\n");
    assert.doesNotMatch(messages, /context pressure/i, "the room is not the problem here");
    assert.match(messages, /empty turn/i, "and an empty turn is not a turn to wait three of");
    const status = await loopStatus();
    assert.match(status, /Status: stuck/);
    assert.match(status, /stuck streak: 1/);
  });

  test("a stuck verdict on a saturated context compacts instead of re-prompting", async () => {
    contextPercent = 90;
    contextWindow = 32_768;
    // Three turns without a tool call is what the narration-only rule fires on.
    await emit("agent_end", narrationTurn);
    await emit("agent_end", narrationTurn);
    reset();
    await emit("agent_end", narrationTurn);

    assert.equal(compactRequests.length, 1, "the ladder's prompt rungs cannot help a full context");
    assert.equal(sentTurns.length, 0, "a strategy prompt would add text to the thing that is too big");
    assert.match(notifications.map((entry) => entry.message).join("\n"), /compacting instead of re-prompting/i);
  });

  test("the same stuck verdict with room to spare still gets the rotating strategy", async () => {
    contextPercent = 30;
    contextWindow = 32_768;
    await emit("agent_end", narrationTurn);
    await emit("agent_end", narrationTurn);
    reset();
    await emit("agent_end", narrationTurn);

    assert.equal(compactRequests.length, 0, "nothing is wrong with this context");
    // The strategy turn goes out after the ladder's escalating delay, so the notification is what
    // is observable here without running the clock.
    assert.match(
      notifications.map((entry) => entry.message).join("\n"),
      /injecting new strategy/i,
      "with room to spare, redirecting the model is the right answer",
    );
  });

  test("the model is told how much context is left, and only when it matters", async () => {
    contextWindow = 32_768;
    contextTokens = 6_000;
    contextPercent = 18;
    const quiet = await emit("context", { messages: [{ role: "user", content: [] }] });
    assert.equal(quiet, undefined, "a notice on every turn from turn one is pure overhead");

    contextTokens = 21_000;
    contextPercent = 64;
    const noticed = await emit("context", { messages: [{ role: "user", content: [] }] });
    assert.ok(noticed?.messages, "above the notice threshold the model gets its own budget");
    assert.equal(noticed.messages.length, 2);
    const injected = noticed.messages.at(-1);
    assert.equal(injected.role, "custom", "appended last, so the cached prefix is untouched");
    assert.match(injected.content[0].text, /11\.8k of 32\.8k tokens left \(64% used\)/);
    assert.match(injected.content[0].text, /PROGRESS\.md/);
  });

  test("the notice stops advising and starts forbidding once the context is nearly gone", async () => {
    contextWindow = 32_768;
    contextTokens = 29_500;
    contextPercent = 90;
    const result = await emit("context", { messages: [{ role: "user", content: [] }] });
    const text = result.messages.at(-1).content[0].text;
    assert.match(text, /CRITICAL/);
    assert.match(text, /Do not read files/);
  });
});
