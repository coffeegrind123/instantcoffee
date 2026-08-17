/**
 * The verifier's ladder, with the model calls injected.
 *
 * The branch worth having tests for is the expensive one — judge says no,
 * repair runs, repair still fails — because it is the branch that only ever
 * fires in a live session with a deliberately bad subagent in it, which is to
 * say almost never, which is to say it would be broken and nobody would know.
 *
 * The counts matter as much as the outcomes: a check that quietly costs two
 * model calls where it promised one is a real regression on a stack with one
 * llama slot, and nothing else in the tree would catch it.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_VERIFY_ROUNDS,
  MAX_VERIFY_ROUNDS,
  resolveVerifyRounds,
  DEFAULT_VERIFY_TIMEOUT_MS,
  MIN_VERIFY_TIMEOUT_MS,
  MAX_VERIFY_TIMEOUT_MS,
  resolveVerifyTimeoutMs,
  verifyAnswer,
} from "../src/agents/verify-runner.ts";

const BRIEF = "Find every call site of decodeFrame() and report file and line.";

/**
 * A scripted pair of models.
 *
 * Both replies accept an array as well as a string: with rounds the judge is
 * called more than once and the interesting cases are exactly the ones where
 * its answer changes between calls. A short array keeps repeating its last
 * entry, so "always says no" stays a one-word setup.
 */
function deps(judgeReply: string | string[], repairReply: string | string[] = "repaired answer") {
  const calls = {
    judge: 0,
    repair: 0,
    notices: [] as string[],
    /** Every phase transition in order, undefined included — the clear matters as much as the set. */
    phases: [] as (string | undefined)[],
    /** The phase in force while each model call was in flight. */
    phaseDuringJudge: undefined as string | undefined,
    phaseDuringRepair: undefined as string | undefined,
    /** What the judge was actually shown each time, so "did it re-check the fix?" is answerable. */
    judged: [] as string[],
  };
  let phase: string | undefined;
  const next = (script: string | string[], index: number): string =>
    typeof script === "string" ? script : (script[Math.min(index, script.length - 1)] ?? "");
  return {
    calls,
    deps: {
      judge: async (prompt: string) => {
        calls.phaseDuringJudge = phase;
        calls.judged.push(prompt);
        return next(judgeReply, calls.judge++);
      },
      repair: async () => {
        calls.phaseDuringRepair = phase;
        return next(repairReply, calls.repair++);
      },
      notify: (m: string) => calls.notices.push(m),
      onPhase: (p: string | undefined) => {
        phase = p;
        calls.phases.push(p);
      },
    },
  };
}

const NO = "VERDICT: NOT_ADDRESSED\nWHY: it described the function instead.";
const YES = "VERDICT: ADDRESSED\nWHY: lists each call site.";

const clean = { lifecycle: { status: "completed" } } as any;

describe("verifyAnswer — the free checks come first", () => {
  it("spends nothing on an empty answer, and replaces it with something the parent can act on", async () => {
    const d = deps("VERDICT: ADDRESSED");
    const out = await verifyAnswer({ result: "", ...clean }, BRIEF, d.deps);
    assert.equal(out.status, "skipped-empty");
    assert.equal(d.calls.judge, 0, "an empty answer needs no judge");
    // Not appended: an empty string plus a note is still, to the parent, a
    // successful lookup that found nothing.
    assert.match(out.answer, /returned no answer at all/);
  });

  it("spends nothing confirming a cut-off run, which already says so", async () => {
    for (const status of ["aborted", "turn_limited", "stopped"]) {
      const d = deps("VERDICT: NOT_ADDRESSED");
      const out = await verifyAnswer({ result: "partial", lifecycle: { status } } as any, BRIEF, d.deps);
      assert.equal(out.status, "skipped-cutoff");
      assert.equal(out.answer, "partial", `${status} keeps its partial output untouched`);
      assert.equal(d.calls.judge, 0, `${status} already explains itself`);
    }
  });

  it("spends nothing when there is no brief to check against, and says which skip it was", async () => {
    const d = deps("VERDICT: NOT_ADDRESSED");
    const out = await verifyAnswer({ result: "an answer", ...clean }, "   ", d.deps);
    assert.equal(d.calls.judge, 0);
    assert.equal(out.answer, "an answer", "no comparison is better than an invented one");
    // Not "skipped-cutoff": a cut-off run explains itself in the status note,
    // while a missing brief is a fault in the spawn path. One label for both
    // would hide the only one of the two that is a bug in us.
    assert.equal(out.status, "skipped-nobrief");
  });

  it("reports no phase at all for a skip, so nothing flashes in the widget", async () => {
    for (const [answer, brief, lifecycle] of [
      ["", BRIEF, clean],
      ["partial", BRIEF, { lifecycle: { status: "turn_limited" } }],
      ["an answer", "   ", clean],
    ] as const) {
      const d = deps("VERDICT: ADDRESSED");
      await verifyAnswer({ result: answer, ...(lifecycle as any) }, brief, d.deps);
      assert.deepEqual(d.calls.phases, [], "the free checks return before any model call");
    }
  });
});

describe("verifyAnswer — the judged path", () => {
  it("passes a good answer through untouched, with no note", async () => {
    const d = deps("VERDICT: ADDRESSED\nWHY: lists each call site.");
    const out = await verifyAnswer({ result: "src/decode.ts:12", ...clean }, BRIEF, d.deps);
    assert.equal(out.status, "passed");
    assert.equal(out.answer, "src/decode.ts:12", "a passing answer must not be decorated");
    assert.equal(d.calls.judge, 1);
    assert.equal(d.calls.repair, 0);
  });

  it("repairs once, and says the answer is a second attempt", async () => {
    const d = deps([NO, YES], "src/decode.ts:12");
    const out = await verifyAnswer({ result: "decodeFrame decodes a frame.", ...clean }, BRIEF, d.deps);
    assert.equal(out.status, "repaired");
    assert.match(out.answer, /^src\/decode\.ts:12/);
    assert.match(out.answer, /corrected one/);
    assert.equal(d.calls.repair, 1);
  });

  it("re-judges the repair — the fix is the answer least worth trusting unchecked", async () => {
    const d = deps([NO, YES], "the corrected answer");
    await verifyAnswer({ result: "first attempt", ...clean }, BRIEF, d.deps);
    assert.equal(d.calls.judge, 2, "the repair goes back to the judge, not straight to the parent");
    assert.match(d.calls.judged[1], /the corrected answer/, "and it is the REPAIR that is re-judged");
    assert.doesNotMatch(d.calls.judged[1], /first attempt/);
  });

  it("returns the original, not the retry, when the retry is also off-task", async () => {
    const d = deps(NO, "a differently wrong answer");
    const out = await verifyAnswer({ result: "the first answer", ...clean }, BRIEF, d.deps);
    assert.equal(out.status, "failed");
    // The parent gets what it would have got with the verifier off, plus a
    // warning — not text produced by a child that has just been told it is wrong.
    assert.match(out.answer, /^the first answer/);
    assert.doesNotMatch(out.answer, /differently wrong/);
    assert.equal(d.calls.judge, 2);
    assert.equal(d.calls.repair, 1);
  });

  it("keeps the original when the repair comes back empty", async () => {
    const d = deps("VERDICT: NOT_ADDRESSED\nWHY: no.", "   ");
    const out = await verifyAnswer({ result: "the first answer", ...clean }, BRIEF, d.deps);
    assert.equal(out.status, "failed");
    assert.match(out.answer, /^the first answer/, "something beats nothing");
    assert.match(out.answer, /Treat it as unreliable/);
  });

  it("flags an unreadable verdict instead of silently claiming a pass", async () => {
    const d = deps("hmm, seems alright to me");
    const out = await verifyAnswer({ result: "an answer", ...clean }, BRIEF, d.deps);
    assert.equal(out.status, "unparsed");
    assert.match(out.answer, /went out unchecked/);
    assert.equal(d.calls.repair, 0, "an unreadable verdict is not a failure verdict");
    assert.ok(d.calls.notices.some((n) => /unchecked/.test(n)));
  });
});

/**
 * The budget is the same idea as the child's turn ceiling: not that the number
 * is right, but that the loop cannot run away. Three separate things stop it,
 * and the counter is only one of them — a child that has stopped moving would
 * otherwise spend the whole budget restating itself at two model calls a round.
 */
describe("verifyAnswer — the round budget", () => {
  it("costs 1 + 2·attempts model calls, and no more", async () => {
    for (const rounds of [0, 1, 2, 3]) {
      const d = deps(NO, ["retry one", "retry two", "retry three", "retry four"]);
      const out = await verifyAnswer({ result: "an answer", ...clean }, BRIEF, d.deps, { rounds });
      assert.equal(d.calls.repair, rounds, `rounds=${rounds} should spend exactly ${rounds} repairs`);
      assert.equal(d.calls.judge, rounds + 1, `rounds=${rounds} should judge each attempt once`);
      assert.equal(out.status, "failed");
    }
  });

  it("stops the moment an attempt passes, without spending the rest", async () => {
    const d = deps([NO, NO, YES], ["retry one", "retry two", "retry three"]);
    const out = await verifyAnswer({ result: "an answer", ...clean }, BRIEF, d.deps, { rounds: 3 });
    assert.equal(out.status, "repaired");
    assert.match(out.answer, /^retry two/);
    assert.equal(d.calls.repair, 2, "a budget is a ceiling, not a quota to be used up");
  });

  it("rounds: 0 checks but never repairs — report-only", async () => {
    const d = deps(NO);
    const out = await verifyAnswer({ result: "an answer", ...clean }, BRIEF, d.deps, { rounds: 0 });
    assert.equal(d.calls.judge, 1);
    assert.equal(d.calls.repair, 0);
    assert.equal(out.status, "failed");
    assert.match(out.answer, /no attempt was made to correct it/);
  });

  it("stops early when the child repeats itself", async () => {
    const d = deps(NO, "the same answer");
    const out = await verifyAnswer({ result: "the same answer", ...clean }, BRIEF, d.deps, { rounds: 3 });
    assert.equal(d.calls.repair, 1, "an unmoving child is done, whatever the budget says");
    assert.equal(out.status, "failed");
    assert.match(out.answer, /repeated itself/);
  });

  it("stops early when a repair comes back empty", async () => {
    const d = deps(NO, ["   ", "never reached"]);
    const out = await verifyAnswer({ result: "the first answer", ...clean }, BRIEF, d.deps, { rounds: 3 });
    assert.equal(d.calls.repair, 1);
    assert.equal(out.status, "failed");
    assert.match(out.answer, /^the first answer/);
  });

  it("counts the attempts it actually spent, not the budget it was given", async () => {
    const d = deps([NO, NO, YES], ["retry one", "retry two"]);
    const out = await verifyAnswer({ result: "an answer", ...clean }, BRIEF, d.deps, { rounds: 3 });
    assert.match(out.answer, /2th attempt/);
  });

  it("defaults to one round when no budget is passed", async () => {
    const d = deps(NO);
    await verifyAnswer({ result: "an answer", ...clean }, BRIEF, d.deps);
    assert.equal(d.calls.repair, DEFAULT_VERIFY_ROUNDS);
  });
});

describe("resolveVerifyRounds", () => {
  it("falls back to the default rather than to zero on anything unreadable", () => {
    // Zero would look, from the outside, exactly like a verifier that judged
    // everything correct — the most expensive kind of silent failure.
    for (const raw of [undefined, "", "   ", "two", "NaN"]) {
      assert.equal(resolveVerifyRounds(raw), DEFAULT_VERIFY_ROUNDS, `"${raw}" should fall back`);
    }
  });

  it("takes a deliberate zero, which is report-only", () => {
    assert.equal(resolveVerifyRounds("0"), 0);
  });

  it("clamps into range instead of trusting the operator with the slot", () => {
    assert.equal(resolveVerifyRounds("99"), MAX_VERIFY_ROUNDS);
    assert.equal(resolveVerifyRounds("-4"), 0);
    assert.equal(resolveVerifyRounds("2.7"), 2);
  });
});

/**
 * The deadline exists because nothing else can end a verification call.
 *
 * Verification runs inside the settlement chain, after the record's status has
 * gone terminal, and every stop path keys off `status === "running"`: the
 * operator's Esc reaches `abort()` → `stopAgent()` → false, the `StopAgent` tool
 * the same, and the watchdog's `check()` deletes the record's state rather than
 * skipping it. The parent's `Agent` tool call is meanwhile blocked on a gate
 * that opens only when verification returns.
 */
describe("resolveVerifyTimeoutMs", () => {
  it("falls back to the default on anything unreadable", () => {
    for (const raw of [undefined, "", "   ", "soon", "NaN"]) {
      assert.equal(resolveVerifyTimeoutMs(raw), DEFAULT_VERIFY_TIMEOUT_MS, `"${raw}" should fall back`);
    }
  });

  it("has no way to spell 'no deadline' — that is the bug, not a setting", () => {
    // Unlike rounds, where 0 is a meaningful report-only mode, a disabled
    // deadline is indistinguishable from the hang it exists to prevent.
    assert.equal(resolveVerifyTimeoutMs("0"), MIN_VERIFY_TIMEOUT_MS);
    assert.equal(resolveVerifyTimeoutMs("-1"), MIN_VERIFY_TIMEOUT_MS);
  });

  it("clamps both ends", () => {
    assert.equal(resolveVerifyTimeoutMs("5"), MIN_VERIFY_TIMEOUT_MS);
    assert.equal(resolveVerifyTimeoutMs("99999999999"), MAX_VERIFY_TIMEOUT_MS);
    assert.equal(resolveVerifyTimeoutMs("45000"), 45_000);
    assert.equal(resolveVerifyTimeoutMs("45000.9"), 45_000);
  });
});

/**
 * A deadline surfaces through the path the verifier already had for "the check
 * failed", so the answer still goes out — annotated as unchecked, not lost.
 */
describe("verifyAnswer — a judge that never answers", () => {
  it("reports errored and returns the child's answer, annotated", async () => {
    const out = await verifyAnswer(
      { result: "the child's answer", lifecycle: { status: "completed" } } as never,
      "the task",
      {
        judge: async () => {
          throw new Error("the verifier did not answer within 300s");
        },
        repair: async () => {
          throw new Error("must not be reached");
        },
      },
    );

    assert.equal(out.status, "errored", "a timed-out judge is a failed check, not a passed one");
    assert.ok(out.answer.startsWith("the child's answer"), "the answer survives the check that could not run");
    assert.match(out.answer, /went out unchecked/);
  });

  it("does the same for a repair that never answers, keeping the original", async () => {
    const out = await verifyAnswer(
      { result: "the child's answer", lifecycle: { status: "completed" } } as never,
      "the task",
      {
        judge: async () => "VERDICT: NOT_ADDRESSED\nWHY: it answered something else",
        repair: async () => {
          throw new Error("the repair did not answer within 300s");
        },
      },
      { rounds: 1 },
    );

    assert.equal(out.status, "errored");
    assert.ok(out.answer.startsWith("the child's answer"));
  });
});

/**
 * The phase hook is what keeps a verifying agent on screen. Verification runs
 * after the child's run has settled — terminal status, completedAt not yet
 * stamped — so the widget has no other way to know the row is still live, and a
 * phase left set would spin "checking the answer" forever on a finished agent.
 * Both directions are load-bearing, so both are tested.
 */
describe("verifyAnswer — the phase hook", () => {
  it("says which call is in flight, and clears when it settles", async () => {
    const d = deps("VERDICT: ADDRESSED");
    await verifyAnswer({ result: "an answer", ...clean }, BRIEF, d.deps);
    assert.deepEqual(d.calls.phases, ["judging", undefined]);
    assert.equal(d.calls.phaseDuringJudge, "judging", "the phase is set before the call, not after it");
  });

  it("alternates judging and repairing for as many rounds as it spends", async () => {
    const d = deps([NO, NO, YES], ["second attempt", "third attempt"]);
    await verifyAnswer({ result: "first attempt", ...clean }, BRIEF, d.deps, { rounds: 2 });
    assert.deepEqual(d.calls.phases, ["judging", "repairing", "judging", "repairing", "judging", undefined]);
    assert.equal(d.calls.phaseDuringRepair, "repairing");
  });

  it("clears the phase when the judge throws", async () => {
    const phases: (string | undefined)[] = [];
    const out = await verifyAnswer({ result: "an answer", ...clean }, BRIEF, {
      judge: async () => {
        throw new Error("no slot");
      },
      repair: async () => "unused",
      onPhase: (p) => phases.push(p),
    });
    assert.equal(out.status, "errored");
    assert.deepEqual(phases, ["judging", undefined], "a failed check must not leave a row spinning");
  });

  it("clears the phase when the repair throws", async () => {
    const phases: (string | undefined)[] = [];
    await verifyAnswer({ result: "an answer", ...clean }, BRIEF, {
      judge: async () => "VERDICT: NOT_ADDRESSED\nWHY: no.",
      repair: async () => {
        throw new Error("session gone");
      },
      onPhase: (p) => phases.push(p),
    });
    assert.deepEqual(phases, ["judging", "repairing", undefined]);
  });

  it("does not let a throwing phase hook change the verdict", async () => {
    const out = await verifyAnswer({ result: "an answer", ...clean }, BRIEF, {
      judge: async () => "VERDICT: ADDRESSED",
      repair: async () => "unused",
      onPhase: () => {
        throw new Error("the widget is gone");
      },
    });
    // Without the guard this lands in the outer catch and a passing answer is
    // reported as "errored" — a display concern rewriting a verdict.
    assert.equal(out.status, "passed");
    assert.equal(out.answer, "an answer");
  });
});

describe("verifyAnswer — it never takes the answer down with it", () => {
  it("returns the answer when the judge throws", async () => {
    const out = await verifyAnswer({ result: "an answer", ...clean }, BRIEF, {
      judge: async () => {
        throw new Error("no slot");
      },
      repair: async () => "unused",
    });
    assert.equal(out.status, "errored");
    assert.match(out.answer, /^an answer/);
    assert.match(out.answer, /unchecked/);
  });

  it("returns the first answer when the repair throws", async () => {
    const out = await verifyAnswer({ result: "an answer", ...clean }, BRIEF, {
      judge: async () => "VERDICT: NOT_ADDRESSED\nWHY: no.",
      repair: async () => {
        throw new Error("session gone");
      },
    });
    assert.equal(out.status, "errored");
    assert.match(out.answer, /^an answer/);
  });

  it("survives a record with no result field at all", async () => {
    const out = await verifyAnswer({ lifecycle: { status: "completed" } } as any, BRIEF, {
      judge: async () => "VERDICT: ADDRESSED",
      repair: async () => "",
    });
    assert.equal(out.status, "skipped-empty");
  });
});
