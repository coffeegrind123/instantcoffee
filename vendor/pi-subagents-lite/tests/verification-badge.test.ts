/**
 * The verdict marker.
 *
 * The one assertion that carries the whole feature is the pair at the top: a
 * checked-and-fine answer renders something, and an unchecked one renders
 * nothing. Every other test here exists to stop that distinction being eroded
 * later by a well-meaning tidy-up — a default case, a fallback label, a
 * placeholder for the absent verdict — each of which would restore exactly the
 * ambiguity the verifier was built to remove.
 *
 * The mapping is exhaustive against the type on purpose: a new verification
 * status added to AgentVerification without a badge would otherwise render as
 * `undefined undefined` on a live line, and nothing else in the tree looks at
 * this table.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  verificationBadge,
  verificationBadgeText,
  verifyPhaseActivity,
} from "../src/ui/verification-badge.ts";

/** Every value of AgentVerification. Kept literal so adding one to the type breaks this list, loudly. */
const ALL = [
  "passed",
  "repaired",
  "failed",
  "unparsed",
  "errored",
  "skipped-empty",
  "skipped-cutoff",
  "skipped-error",
  "skipped-nobrief",
] as const;

describe("verificationBadge — checked-and-fine is not the same as never-checked", () => {
  it("marks a passing answer", () => {
    const badge = verificationBadge("passed");
    assert.ok(badge, "a pass must be visible somewhere, or the verifier proves nothing to the operator");
    assert.equal(badge.icon, "✓");
    assert.equal(badge.tone, "dim", "the common case must not train the eye to skip the column");
  });

  it("shows nothing when the verifier never ran", () => {
    assert.equal(verificationBadge(undefined), undefined);
    assert.equal(verificationBadgeText(undefined), undefined);
  });

  it("has a badge for every status the verifier can produce", () => {
    for (const status of ALL) {
      const badge = verificationBadge(status);
      assert.ok(badge, `${status} has no badge`);
      assert.ok(badge.icon.length > 0 && badge.label.length > 0, `${status} renders an empty marker`);
    }
  });
});

describe("verificationBadge — the loud ones are loud", () => {
  it("colours the two verdicts that change what the answer is worth", () => {
    assert.equal(verificationBadge("repaired")!.tone, "warning");
    assert.equal(verificationBadge("failed")!.tone, "error");
  });

  it("keeps the four skips distinguishable from each other", () => {
    // Four different problems with four different fixes: nothing was said, the
    // run was cut off, the run failed on the provider, or no brief was recorded
    // to check against. One label for all of them hides the only one that is a
    // bug in us — and, until the fourth pass, "cut off" was worn by a provider
    // error too, which describes the wrong thing to whoever reads the widget.
    const labels = ["skipped-empty", "skipped-cutoff", "skipped-error", "skipped-nobrief"].map(
      (s) => verificationBadge(s as any)!.label,
    );
    assert.equal(new Set(labels).size, 4, "collapsing the skips hides which problem to go and fix");
    assert.doesNotMatch(verificationBadge("skipped-error")!.label, /cut off/, "a failed run was not cut off");
  });

  it("does not reuse the stats line's glyphs", () => {
    // ⟳ is the turn counter and ↻ is the compaction counter in buildStatsParts;
    // both sit on the same line as the badge.
    for (const status of ALL) {
      const icon = verificationBadge(status)!.icon;
      assert.ok(!"⟳↻".includes(icon), `${status} uses ${icon}, which already means something on that line`);
    }
  });

  it("keeps labels short enough to survive a narrow line", () => {
    for (const status of ALL) {
      assert.ok(verificationBadgeText(status)!.length <= 22, `${status} is too long for the line it lands on`);
    }
  });
});

describe("verifyPhaseActivity", () => {
  it("names the call that is holding the slot", () => {
    assert.match(verifyPhaseActivity("judging")!, /checking the answer/);
    assert.match(verifyPhaseActivity("repairing")!, /asking again/);
    // Not "once more" — the budget is configurable, so a row must not promise
    // that the attempt it is showing is the last one.
    assert.doesNotMatch(verifyPhaseActivity("repairing")!, /once more/);
  });

  it("says nothing when nothing is being verified", () => {
    assert.equal(verifyPhaseActivity(undefined), undefined);
  });
});
