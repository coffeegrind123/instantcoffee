/**
 * The fork's own bound on a background subagent result.
 *
 * The case that makes this necessary is not hypothetical: a background agent
 * settles, `spawn-coordinator.ts` injects its whole result with `triggerTurn:
 * true`, and pi's `sendCustomMessage` hands it to `agent.steer()` without
 * emitting a `tool_result` — so `.pi/extensions/compaction-guard`, which bounds
 * every other large payload in this stack, never sees it. On 2026-08-17 a
 * 17,790-char payload arriving at 84.5% of a 32k window took the context to
 * 100% and the model produced nothing. A subagent that searched a large tree is
 * exactly the shape of thing that produces payloads that size.
 *
 * These assert the fork's behaviour at that boundary. The cap ARITHMETIC is the
 * guard's and is pinned by the guard's own suite; what is pinned here is that
 * the coordinator's path uses it, keeps the result recoverable, and never
 * refuses to deliver a finished agent because bounding it went wrong.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { capBackgroundResult } from "../src/spawn/result-cap.ts";

const WINDOW = 32_768;

/** A stand-in for the parent session context, reporting a chosen usage. */
function ctxAt(tokensUsed: number | null): any {
  return {
    model: { contextWindow: WINDOW },
    getContextUsage: () => ({
      tokens: tokensUsed,
      contextWindow: WINDOW,
      percent: tokensUsed === null ? null : (tokensUsed / WINDOW) * 100,
    }),
  };
}

describe("capBackgroundResult", () => {
  it("leaves a result that fits completely alone", () => {
    const text = "a short answer from a subagent";
    const out = capBackgroundResult(text, ctxAt(5_000), "Explore", "abc123");
    assert.equal(out.text, text);
    assert.equal(out.applied, undefined);
  });

  it("caps the payload that broke the run, at the context where it broke it", () => {
    // 27,684 of 32,768 used — the exact state of entry 48 of the real session.
    const huge = "x".repeat(17_790);
    const out = capBackgroundResult(huge, ctxAt(27_684), "general-purpose", "abc123");
    assert.ok(out.applied, "a 17,790-char result at 84.5% must be capped");
    assert.ok(out.text.length < huge.length, "the capped text must be shorter");
    // The whole point: what lands in the context has to fit in what is left.
    const remainingChars = (WINDOW - 27_684) * 4;
    assert.ok(
      out.text.length < remainingChars,
      `kept ${out.text.length} chars into ${remainingChars} chars of room`,
    );
  });

  it("keeps the head and the tail, because either alone loses half the answer", () => {
    const body = "\n".concat("filler line\n".repeat(4_000));
    const text = `FINDING: the parser drops the last frame${body}CONCLUSION: fix is in decode()`;
    const out = capBackgroundResult(text, ctxAt(27_684), "Explore", "abc123");
    assert.ok(out.applied, "this must be capped for the assertion to mean anything");
    assert.match(out.text, /FINDING: the parser drops the last frame/);
    assert.match(out.text, /CONCLUSION: fix is in decode\(\)/);
  });

  it("writes the full result somewhere and names the file in what the model reads", () => {
    const huge = "y".repeat(60_000);
    const out = capBackgroundResult(huge, ctxAt(27_684), "Explore", "abc123");
    assert.ok(out.applied?.spillPath, "the overflow must be recoverable");
    assert.equal(readFileSync(out.applied!.spillPath!, "utf8"), huge);
    assert.ok(
      out.text.includes(out.applied!.spillPath!),
      "the marker must name the file, or the model cannot page back into it",
    );
  });

  it("gives advice the parent can act on, not the bash-shaped default", () => {
    // Observed live: the model reads this line and follows it. "Run a narrower
    // command" sends it looking for a command that was never run.
    const out = capBackgroundResult("w".repeat(60_000), ctxAt(27_684), "Explore", "abc123");
    assert.ok(out.applied);
    assert.match(out.text, /re-task the agent with a narrower question/);
    assert.ok(!out.text.includes("--max-count"), "the bash advice must not appear here");
  });

  it("bounds a result even when usage is unknown", () => {
    // Right after a compaction, before a response has reported usage. Unknown
    // must not mean unbounded — it means the ceiling.
    const huge = "z".repeat(60_000);
    const out = capBackgroundResult(huge, ctxAt(null), "Explore", "abc123");
    assert.ok(out.applied, "unknown usage must still bound the payload");
    assert.ok(out.text.length < huge.length);
  });

  it("delivers the agent's work even when there is no context to measure", () => {
    // A finished agent is worth delivering. Missing ctx is a reason to skip the
    // bound, never a reason to drop the result.
    const text = "s".repeat(200);
    assert.equal(capBackgroundResult(text, undefined, "Explore", "abc123").text, text);
  });

  it("delivers the agent's work even when reading the context throws", () => {
    const exploding: any = {
      model: { contextWindow: WINDOW },
      getContextUsage: () => {
        throw new Error("session replaced mid-flight");
      },
    };
    const huge = "q".repeat(60_000);
    const out = capBackgroundResult(huge, exploding, "Explore", "abc123");
    // No usage means no window; the ceiling still applies rather than nothing.
    assert.ok(out.text.length <= huge.length);
    assert.ok(typeof out.text === "string" && out.text.length > 0);
  });

  it("passes an empty result through untouched", () => {
    assert.equal(capBackgroundResult("", ctxAt(27_684), "Explore", "abc123").text, "");
  });
});
