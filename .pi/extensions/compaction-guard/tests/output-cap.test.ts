import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_CAP_ADVICE,
  CHARS_PER_TOKEN,
  MAX_ALLOWANCE_CHARS,
  MIN_ALLOWANCE_CHARS,
  REMAINING_FRACTION,
  allowanceChars,
  planOutputCap,
} from "../src/output-cap.ts";

const WINDOW = 32_768;

describe("allowanceChars", () => {
  it("scales with the room that is left", () => {
    const roomy = allowanceChars(WINDOW - 5_000);
    const tight = allowanceChars(WINDOW - 27_684);
    assert.ok(roomy > tight, "an emptier context must allow more");
  });

  it("gives the failing turn a bound that would have saved it", () => {
    // Entry 48 of the real session: 27,684 tokens used of 32,768. The tool
    // result that followed was 17,790 chars (~4,447 tokens) and took the
    // context to 100%.
    const remaining = WINDOW - 27_684;
    const allowed = allowanceChars(remaining);
    assert.equal(allowed, Math.round(remaining * REMAINING_FRACTION * CHARS_PER_TOKEN));
    assert.ok(allowed < 17_790, `must cap the 17,790-char result, allowed ${allowed}`);
    // And the capped result must fit in what was actually left.
    assert.ok(allowed / CHARS_PER_TOKEN < remaining, "the kept text must fit the remaining window");
  });

  it("floors, so a nearly-full context still returns something usable", () => {
    assert.equal(allowanceChars(0), MIN_ALLOWANCE_CHARS);
    assert.equal(allowanceChars(-500), MIN_ALLOWANCE_CHARS);
  });

  it("ceilings, so one result cannot eat a fresh context either", () => {
    assert.equal(allowanceChars(1_000_000), MAX_ALLOWANCE_CHARS);
  });

  it("uses the ceiling when usage is unknown, which is the state after a compaction", () => {
    assert.equal(allowanceChars(null), MAX_ALLOWANCE_CHARS);
    assert.equal(allowanceChars(undefined), MAX_ALLOWANCE_CHARS);
    assert.equal(allowanceChars(Number.NaN), MAX_ALLOWANCE_CHARS);
  });
});

describe("planOutputCap", () => {
  const big = Array.from({ length: 600 }, (_, i) => `line ${i} ${"x".repeat(20)}`).join("\n");

  it("leaves a result that already fits completely alone", () => {
    assert.equal(planOutputCap("short output", 2_000, "/tmp/f.txt"), undefined);
  });

  it("brings an oversized result within the allowance", () => {
    const plan = planOutputCap(big, 4_000, "/tmp/f.txt", 85);
    assert.ok(plan);
    assert.ok(plan.keptChars <= 4_000, `expected <= 4000, got ${plan.keptChars}`);
    assert.equal(plan.originalChars, big.length);
  });

  it("keeps the head AND the tail, because the end says whether it worked", () => {
    const plan = planOutputCap(big, 4_000, "/tmp/f.txt");
    assert.ok(plan);
    assert.ok(plan.text.includes("line 0"), "the start must survive");
    assert.ok(plan.text.includes("line 599"), "the end must survive");
    assert.ok(!plan.text.includes("line 300"), "the middle is what goes");
  });

  it("names the file the full output went to, and how to narrow next time", () => {
    const plan = planOutputCap(big, 4_000, "/tmp/spill/bash-abc.txt", 85);
    assert.ok(plan);
    assert.ok(plan.text.includes("/tmp/spill/bash-abc.txt"));
    assert.ok(plan.text.includes("85% context"));
    assert.ok(plan.text.includes("grep"), "must suggest narrowing, not just report");
  });

  it("says so plainly when the overflow could not be saved", () => {
    const plan = planOutputCap(big, 4_000, undefined);
    assert.ok(plan);
    assert.ok(plan.text.includes("could not be saved"));
    assert.ok(!plan.text.includes("undefined"), "must never print a broken path");
  });

  it("survives an allowance smaller than its own marker", () => {
    const plan = planOutputCap(big, 10, "/tmp/f.txt");
    assert.ok(plan);
    assert.ok(plan.text.length > 0);
    assert.ok(plan.text.includes("output capped"));
  });

  it("ignores a non-string body rather than throwing mid-turn", () => {
    assert.equal(planOutputCap(undefined as unknown as string, 100, undefined), undefined);
  });

  it("tells a bash-shaped caller to narrow the command, by default", () => {
    const plan = planOutputCap(big, 2_000, "/tmp/f.txt");
    assert.ok(plan);
    assert.ok(plan.text.includes(DEFAULT_CAP_ADVICE));
  });

  it("takes the caller's advice when the default would not fit what happened", () => {
    // A subagent's report cannot be narrowed by re-running a command, so the
    // caller supplies advice the model can actually act on. Watched live: the
    // model reads this line and acts on it, so wrong advice is followed too.
    const advice = "Read the file, or re-task the agent with a narrower question.";
    const plan = planOutputCap(big, 2_000, "/tmp/f.txt", 20, advice);
    assert.ok(plan);
    assert.ok(plan.text.includes(advice));
    assert.ok(!plan.text.includes(DEFAULT_CAP_ADVICE), "the default must not also appear");
  });

  it("end to end: the real failure is contained", () => {
    // The real numbers, not an approximation of them. From the session:
    //   entry 48  27,684 tokens used (84.5%)   <- where the command was issued
    //   entry 49  tool result, 17,790 chars
    //   entry 50  32,432 tokens (99.0%)        <- empty turn, run dead
    // Anchoring on the OBSERVED 32,432 rather than on chars/4, because the real
    // tokenizer counted denser than four characters per token and an assertion
    // built on the approximation claims things the session does not support.
    const OBSERVED_AFTER = 32_432;
    const result = "y".repeat(17_790);
    const allowed = allowanceChars(WINDOW - 27_684);
    const plan = planOutputCap(result, allowed, "/tmp/spill/bash-1.txt", 84.5);
    assert.ok(plan);

    const removedChars = 17_790 - plan.keptChars;
    const cappedTotal = OBSERVED_AFTER - Math.round(removedChars / CHARS_PER_TOKEN);
    const cappedPercent = (cappedTotal / WINDOW) * 100;

    assert.ok(OBSERVED_AFTER / WINDOW > 0.95, "the real run genuinely ended at the wall");
    // Back under the 87% cliff, which is the point of the whole exercise.
    assert.ok(
      cappedPercent < 87,
      `capped run must land below the empty-turn cliff, got ${cappedPercent.toFixed(1)}%`
    );
  });
});
