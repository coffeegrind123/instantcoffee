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

import { verifyAnswer } from "../src/agents/verify-runner.ts";

const BRIEF = "Find every call site of decodeFrame() and report file and line.";

function deps(judgeReply: string, repairReply = "repaired answer") {
  const calls = { judge: 0, repair: 0, notices: [] as string[] };
  return {
    calls,
    deps: {
      judge: async () => {
        calls.judge++;
        return judgeReply;
      },
      repair: async () => {
        calls.repair++;
        return repairReply;
      },
      notify: (m: string) => calls.notices.push(m),
    },
  };
}

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

  it("spends nothing when there is no brief to check against", async () => {
    const d = deps("VERDICT: NOT_ADDRESSED");
    const out = await verifyAnswer({ result: "an answer", ...clean }, "   ", d.deps);
    assert.equal(d.calls.judge, 0);
    assert.equal(out.answer, "an answer", "no comparison is better than an invented one");
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
    const d = deps("VERDICT: NOT_ADDRESSED\nWHY: it described the function instead.", "src/decode.ts:12");
    const out = await verifyAnswer({ result: "decodeFrame decodes a frame.", ...clean }, BRIEF, d.deps);
    assert.equal(out.status, "repaired");
    assert.match(out.answer, /^src\/decode\.ts:12/);
    assert.match(out.answer, /corrected one/);
    assert.equal(d.calls.judge, 1);
    assert.equal(d.calls.repair, 1);
  });

  it("does not re-judge the repair — one judge, one repair, that is the budget", async () => {
    const d = deps("VERDICT: NOT_ADDRESSED\nWHY: no.", "second attempt");
    await verifyAnswer({ result: "first attempt", ...clean }, BRIEF, d.deps);
    assert.equal(d.calls.judge, 1, "a re-judge invites a loop on the slot the parent is waiting for");
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
