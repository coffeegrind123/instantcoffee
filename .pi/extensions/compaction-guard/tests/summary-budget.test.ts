import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CHARS_PER_TOKEN,
  MAX_SUMMARY_CAP_CHARS,
  MIN_SUMMARY_CAP_CHARS,
  SUMMARY_WINDOW_FRACTION,
  TRIM_MARKER,
  capSummary,
  splitSections,
  summaryCapChars,
} from "../src/summary-budget.ts";

/** A summary in the exact shape pi's UPDATE_SUMMARIZATION_PROMPT asks the model to maintain. */
function summaryFixture(doneItems: number): string {
  const done = Array.from({ length: doneItems }, (_, i) => `- [x] Completed unit of work number ${i} in src/module-${i}.ts`).join("\n");
  return `## Goal
Port the compaction fixes out of /loop so ordinary sessions get them too.

## Constraints & Preferences
- Do not replace pi's model-written summary
- Keep the extension free of node_modules

## Progress
### Done
${done}

### In Progress
- [ ] Writing the tests

### Blocked
- (none)

## Key Decisions
- **Cap the input, not the output**: pi writes the summary after the hook returns

## Next Steps
1. Wire the extension into pi-local.sh
2. Record the measurement in context/design/decisions.md

## Critical Context
- pi's ExtensionRunner.emit() does not clone the event, so preparation is mutable`;
}

describe("summaryCapChars", () => {
  it("sizes the cap from the context window", () => {
    const window = 32_768;
    assert.equal(summaryCapChars(window), Math.round(window * SUMMARY_WINDOW_FRACTION * CHARS_PER_TOKEN));
    // The measured median summary (4,029 chars) must survive untouched on this window,
    // while the measured maximum (11,054) must not.
    assert.ok(summaryCapChars(window) > 4_029);
    assert.ok(summaryCapChars(window) < 11_054);
  });

  it("clamps at both ends and survives an unknown window", () => {
    assert.equal(summaryCapChars(1_000), MIN_SUMMARY_CAP_CHARS);
    assert.equal(summaryCapChars(10_000_000), MAX_SUMMARY_CAP_CHARS);
    assert.equal(summaryCapChars(undefined), MIN_SUMMARY_CAP_CHARS);
    assert.equal(summaryCapChars(0), MIN_SUMMARY_CAP_CHARS);
    assert.equal(summaryCapChars(Number.NaN), MIN_SUMMARY_CAP_CHARS);
  });
});

describe("splitSections", () => {
  it("splits on level-2 headings and keeps level-3 headings with their parent", () => {
    const sections = splitSections(summaryFixture(2));
    const headings = sections.map((s) => s.heading);
    assert.deepEqual(headings, [
      "## Goal",
      "## Constraints & Preferences",
      "## Progress",
      "## Key Decisions",
      "## Next Steps",
      "## Critical Context",
    ]);
    // "### Done" must not have started a section of its own.
    const progress = sections.find((s) => s.heading === "## Progress");
    assert.ok(progress);
    assert.ok(progress.text.includes("### Done"));
    assert.ok(progress.text.includes("### In Progress"));
  });

  it("keeps text that appears before the first heading", () => {
    const sections = splitSections("preamble text\n\n## Goal\nship it");
    assert.equal(sections[0].heading, "");
    assert.ok(sections[0].text.includes("preamble text"));
  });
});

describe("capSummary", () => {
  it("returns a summary that already fits, unchanged", () => {
    const summary = summaryFixture(2);
    assert.equal(capSummary(summary, 10_000), summary);
  });

  it("passes through non-strings and empty input untouched", () => {
    assert.equal(capSummary(undefined, 100), undefined);
    assert.equal(capSummary("", 100), "");
  });

  it("brings an oversized summary within the cap", () => {
    const summary = summaryFixture(400);
    const cap = 6_553;
    assert.ok(summary.length > cap * 3, "fixture should be well over the cap");
    const capped = capSummary(summary, cap) as string;
    assert.ok(capped.length <= cap, `expected <= ${cap}, got ${capped.length}`);
  });

  it("keeps Goal and Next Steps and sheds the accumulating Progress list", () => {
    const capped = capSummary(summaryFixture(400), 6_553) as string;
    assert.ok(capped.includes("## Goal"), "Goal must survive");
    assert.ok(capped.includes("## Next Steps"), "Next Steps must survive");
    assert.ok(capped.includes("Wire the extension into pi-local.sh"), "Next Steps content must survive");
    // The Done list is what grows on every compaction, so it is what goes first.
    assert.ok(!capped.includes("Completed unit of work number 399"), "the tail of Done must not survive");
  });

  it("reassembles surviving sections in their original order", () => {
    const capped = capSummary(summaryFixture(400), 6_553) as string;
    const goal = capped.indexOf("## Goal");
    const next = capped.indexOf("## Next Steps");
    assert.ok(goal >= 0 && next >= 0);
    assert.ok(goal < next, "## Goal must still precede ## Next Steps");
  });

  it("marks that it trimmed, and never stacks the marker across repeated trims", () => {
    const once = capSummary(summaryFixture(400), 6_553) as string;
    assert.ok(once.includes(TRIM_MARKER));
    // Feeding a previously-trimmed summary back in is the normal case: every
    // compaction re-caps whatever the last one produced.
    const twice = capSummary(`${once}\n\n## Progress\n### Done\n${"- [x] more work\n".repeat(500)}`, 6_553) as string;
    assert.equal(twice.split(TRIM_MARKER).length - 1, 1, "exactly one marker");
    assert.ok(twice.length <= 6_553);
  });

  it("is idempotent: re-capping its own output changes nothing", () => {
    // Every compaction re-caps whatever the previous one produced. If this is not
    // exactly stable, each pass shaves the summary again and drops the marker —
    // which is what an end-to-end run through jiti caught before it was fixed.
    const cap = 6_553;
    const once = capSummary(summaryFixture(400), cap) as string;
    const twice = capSummary(once, cap) as string;
    assert.equal(twice, once, "second application must return the identical string");
    assert.equal(capSummary(twice, cap), once, "and so must the third");
    assert.ok(once.includes(TRIM_MARKER), "the marker must survive re-capping");
  });

  it("converges instead of growing when applied repeatedly", () => {
    // The failure being fixed is monotonic growth across compactions. Simulate
    // it: each round appends new material to the previous (capped) summary.
    const cap = 6_553;
    let summary = summaryFixture(20);
    const sizes: number[] = [];
    for (let round = 0; round < 12; round++) {
      summary = `${summary}\n\n## Progress\n### Done\n${`- [x] round ${round} work in src/file-${round}.ts\n`.repeat(60)}`;
      summary = capSummary(summary, cap) as string;
      sizes.push(summary.length);
    }
    assert.ok(Math.max(...sizes) <= cap, `every round must stay within the cap, saw ${Math.max(...sizes)}`);
    // And it must not be creeping upward round on round.
    assert.ok(sizes[sizes.length - 1] <= sizes[2] + 1, "size must not grow with iteration count");
  });

  it("handles a summary with no headings at all", () => {
    const blob = "x".repeat(20_000);
    const capped = capSummary(blob, 5_000) as string;
    assert.ok(capped.length <= 5_000);
    assert.ok(capped.includes(TRIM_MARKER));
  });
});
