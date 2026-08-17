/**
 * The verifier's judgement, without a model in the loop.
 *
 * These pin the decisions that are easy to get subtly wrong and impossible to
 * notice afterwards: that "NOT_ADDRESSED" is not read as "ADDRESSED" because it
 * contains it, that an unreadable verdict fails open rather than throwing away
 * good work, and that the repair prompt restates the brief instead of pointing
 * at it — the brief being exactly the thing that may have gone missing.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  JUDGE_ANSWER_CHARS,
  buildAnchorMessage,
  buildJudgePrompt,
  buildRepairPrompt,
  parseJudgeVerdict,
  structuralVerdict,
  verificationNote,
} from "../src/agents/verify.ts";

const BRIEF = "Find every call site of decodeFrame() and report the file and line of each.";

describe("structuralVerdict", () => {
  it("fails an empty answer, and says what to do instead of repeating the task", () => {
    const v = structuralVerdict("", { status: "completed" } as any);
    assert.equal(v.ok, false);
    assert.equal(v.worthJudging, false);
    assert.match(v.note ?? "", /narrower question/);
  });

  it("treats whitespace as empty", () => {
    assert.equal(structuralVerdict("   \n\t ", { status: "completed" } as any).ok, false);
  });

  it("does not pay a judge to confirm what the status note already says", () => {
    for (const status of ["aborted", "turn_limited", "stopped"]) {
      const v = structuralVerdict("partial work", { status } as any);
      assert.equal(v.ok, true, `${status} keeps its partial output`);
      assert.equal(v.worthJudging, false, `${status} already explains itself`);
    }
  });

  it("sends a clean, non-empty answer to the judge — the case where drift is invisible", () => {
    const v = structuralVerdict("src/decode.ts:12", { status: "completed" } as any);
    assert.deepEqual(v, { ok: true, worthJudging: true });
  });
});

describe("buildJudgePrompt", () => {
  it("shows the judge the task and the answer, and nothing else", () => {
    const prompt = buildJudgePrompt(BRIEF, "src/decode.ts:12");
    assert.ok(prompt.includes(BRIEF));
    assert.ok(prompt.includes("src/decode.ts:12"));
    assert.match(prompt, /not checking whether the work is correct/i);
  });

  it("asks for the verdict before the reasoning", () => {
    // A local model allowed to reason first talks itself into agreement.
    const prompt = buildJudgePrompt(BRIEF, "x");
    assert.ok(prompt.indexOf("VERDICT:") < prompt.indexOf("WHY:"));
  });

  it("bounds what it quotes, so a huge answer cannot make the check expensive", () => {
    const prompt = buildJudgePrompt(BRIEF, "y".repeat(50_000));
    assert.ok(prompt.length < JUDGE_ANSWER_CHARS + 3_000, `judge prompt was ${prompt.length} chars`);
    assert.match(prompt, /more chars/);
  });
});

describe("parseJudgeVerdict", () => {
  it("reads a pass", () => {
    const v = parseJudgeVerdict("VERDICT: ADDRESSED\nWHY: it lists every call site with line numbers.");
    assert.equal(v.addressed, true);
    assert.equal(v.unparsed, false);
    assert.match(v.why, /call site/);
  });

  it("reads a fail without being fooled by the substring", () => {
    // "NOT_ADDRESSED" contains "ADDRESSED". Matching the wrong one first turns
    // every failure into a pass, silently.
    const v = parseJudgeVerdict("VERDICT: NOT_ADDRESSED\nWHY: it describes the function instead of finding callers.");
    assert.equal(v.addressed, false);
    assert.match(v.why, /instead of finding callers/);
  });

  it("accepts the loose shapes a 27B actually produces", () => {
    assert.equal(parseJudgeVerdict("verdict: not addressed\nwhy: nope").addressed, false);
    assert.equal(parseJudgeVerdict("NOT-ADDRESSED — it answered a different question").addressed, false);
    assert.equal(parseJudgeVerdict("VERDICT:ADDRESSED").addressed, true);
  });

  it("fails OPEN on an unreadable reply, and says so rather than claiming a pass", () => {
    const v = parseJudgeVerdict("I think it's probably fine, honestly.");
    assert.equal(v.addressed, true, "a chatty judge must not discard good work");
    assert.equal(v.unparsed, true, "but the parent must be told it went unchecked");
  });

  it("survives a non-string reply rather than throwing at settle time", () => {
    const v = parseJudgeVerdict(undefined as unknown as string);
    assert.equal(v.addressed, true);
    assert.equal(v.unparsed, true);
  });
});

describe("buildRepairPrompt", () => {
  it("restates the brief in full rather than referring to it", () => {
    // Pointing at "the original task" points at the thing that went missing.
    const prompt = buildRepairPrompt(BRIEF, "it described the function instead");
    assert.ok(prompt.includes(BRIEF));
    assert.match(prompt, /it described the function instead/);
  });

  it("forbids the two answers a cornered model gives instead of answering", () => {
    const prompt = buildRepairPrompt(BRIEF, "why");
    assert.match(prompt, /do not restate the task/i);
    assert.match(prompt, /do not describe what you would do/i);
  });
});

describe("buildAnchorMessage", () => {
  it("carries the brief and says it is not new work", () => {
    const msg = buildAnchorMessage(BRIEF);
    assert.ok(msg.includes(BRIEF));
    assert.match(msg, /Nothing here is new work/);
  });

  it("stays short — it lands in a context that was just cut down for room", () => {
    const msg = buildAnchorMessage("z".repeat(50_000));
    assert.ok(msg.length < 2_000, `anchor was ${msg.length} chars`);
  });
});

describe("verificationNote", () => {
  it("distinguishes a failed check from an unread one", () => {
    assert.match(verificationNote("failed"), /Treat it as unreliable/);
    assert.match(verificationNote("unparsed"), /went out unchecked/);
    assert.match(verificationNote("repaired"), /corrected one/);
  });
});
