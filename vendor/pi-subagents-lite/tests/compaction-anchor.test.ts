/**
 * Z2 — the task anchor was steered into a run that had already ended.
 *
 * `session.steer()` gets an ANSWER, not just a line of context: pi drains the
 * steering queue at the top of its agent loop, and when the loop has finished
 * `_handlePostAgentRun` (`agent-session.js:779`) restarts it precisely because
 * the queue is not empty. pi's only two auto-compaction call sites are both
 * outside that loop — after the run (`:776`) and before the next one (`:865`) —
 * and `onCompaction` could not tell them apart.
 *
 * From the second, the anchor rides on the prompt that is about to run, which is
 * what it is for. From the first, it manufactures a whole extra turn: one more
 * model call on the single llama slot the parent is blocked on, and — because
 * `collectResponseText` takes the run's last message (Z1) — the reply to it
 * became the child's answer.
 *
 * That is T1's and V6's argument for the other steer in this package ("there is
 * no wrap-up to ask for, and asking manufactures a turn"), applied to the one
 * nobody had asked it about.
 *
 * The predicate is here rather than inline in `agent-manager.ts` for Y1's
 * reason: a second reader of this question would be a defect waiting to be
 * written, and the manager cannot be loaded under plain node.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { anchorReachesATurn } from "../src/agents/compaction-anchor.ts";

describe("Z2 — the anchor is steered only into a turn that was already coming", () => {
  it("refuses after the run's agent loop has ended", () => {
    assert.equal(
      anchorReachesATurn({ afterRun: true, willRetry: false }),
      false,
      "pi compacted from _handlePostAgentRun: a steer here restarts the loop for one more turn",
    );
  });

  it("control — a compaction on the way INTO a prompt still gets the anchor", () => {
    assert.equal(
      anchorReachesATurn({ afterRun: false, willRetry: false }),
      true,
      "pi compacted from prompt(): the steer is drained by the run that is about to start",
    );
  });

  it("control — pi re-running the interrupted turn itself still gets the anchor", () => {
    assert.equal(
      anchorReachesATurn({ afterRun: true, willRetry: true }),
      true,
      "the continuation happens whether or not the anchor is queued, so it rides on it",
    );
  });

  it("control — an info with neither flag set reads as reachable", () => {
    // A caller that predates the flags, or a test fixture, must not silently
    // switch the anchor off: the whole point of the layer is prevention.
    assert.equal(anchorReachesATurn({}), true);
  });
});
