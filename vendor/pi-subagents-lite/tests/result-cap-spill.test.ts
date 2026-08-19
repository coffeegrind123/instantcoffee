/**
 * The background-result spill directory is bounded.
 *
 * AH4, seventeenth pass. `result-cap.ts` is the second output cap in this stack.
 * The first — `.pi/extensions/compaction-guard` — writes what it cuts to a
 * `mkdtemp` under `tmpdir()` and prunes it to `MAX_SPILL_FILES`, under a
 * docstring that names the shape the bound exists for:
 *
 *   > An unattended `/loop` run is exactly the shape that fills a disk with
 *   > them: days of iterations, each capping the test-runner output it just
 *   > produced.
 *
 * This file copied that writer and not the prune, so of the two spill
 * directories in one process the one whose rationale names the unattended run
 * was bounded and the one an unattended run's background delegations feed was
 * not. Every file is by construction a payload that did not fit a 32k window,
 * the key is a record id that is unique per delegation, and nothing removed one.
 *
 * The suite drives the SHIPPED `capBackgroundResult`, so the assertion is about
 * the directory that really appears on disk. The path is read out of the marker
 * the model is shown, which is the only place it is ever named.
 */

import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { capBackgroundResult } from "../src/spawn/result-cap.ts";
import { MAX_SPILL_FILES } from "../../../.pi/extensions/compaction-guard/src/spill.ts";

/** Bigger than the 20,000-char ceiling, so the cap always fires. */
const HUGE = "y".repeat(40_000);

/** A parent at 20% of a 32k window — plenty of room, so only SIZE triggers the cap. */
const ctx = {
  model: { contextWindow: 32_768 },
  getContextUsage: () => ({ tokens: 6_554, contextWindow: 32_768, percent: 20 }),
} as never;

describe("capBackgroundResult", () => {
  it("bounds its spill directory, like the guard whose numbers it imports", () => {
    let spillDir: string | undefined;
    const written = MAX_SPILL_FILES + 12;

    for (let i = 0; i < written; i++) {
      const capped = capBackgroundResult(HUGE, ctx, "Explore", `agent-${String(i).padStart(4, "0")}`);
      assert.ok(capped.applied, "the cap must have fired — otherwise this proves nothing");
      const match = /Full output: (\S+)/.exec(capped.text);
      assert.ok(match, "the marker must name the spill file, or the overflow is simply lost");
      spillDir ??= path.dirname(match[1]);
    }

    assert.ok(spillDir, "no spill file was written at all");
    const files = readdirSync(spillDir);
    assert.ok(
      files.length <= MAX_SPILL_FILES,
      `${written} capped results left ${files.length} files in ${spillDir}; the bound is ${MAX_SPILL_FILES}`,
    );
    // The control: the bound must prune the OLDEST, so the newest marker still
    // resolves to a file that is there. A prune that dropped the wrong end would
    // satisfy the count and lose the answer the marker points at.
    const newest = `Explore-agent-${String(written - 1).padStart(4, "0")}.txt`;
    assert.ok(files.includes(newest), `the newest spill was pruned: ${newest} is not in ${files.join(", ")}`);
  });
});
