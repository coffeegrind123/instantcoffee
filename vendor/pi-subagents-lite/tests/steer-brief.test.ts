/**
 * W3 — the brief has to grow on EVERY branch of `steer()`, not on the one that
 * happened to get the fix.
 *
 * ## The failure
 *
 * `record.execution.brief` is the task the subagent layer checks work against.
 * Three things read it and all three are consequential:
 *
 *   - the JUDGE, via `verifyAnswer(record, brief, …)` — what the answer is
 *     checked against;
 *   - `buildRepairPrompt(brief, why)` — what the child is told to answer instead,
 *     in the child's own session, when the judge says NOT_ADDRESSED;
 *   - `buildAnchorMessage(brief)` — what is restated into a context that was just
 *     compacted, which is the one place a drifting child's task has most likely
 *     gone missing.
 *
 * The fork already fixed this for a SETTLED agent, and `continueSettledAgent`'s
 * own comment says what went wrong: an answer to the steer, judged against the
 * original prompt, comes back NOT_ADDRESSED — correctly — and the repair then
 * hands the child the original task with "Answer it now" and "Do not restate the
 * task", which is the operator's instruction being undone by the layer that
 * exists to catch drift, and the result labelled `✎ repaired`, which reads as an
 * improvement.
 *
 * `AgentManager.steer()` reaches `continueSettledAgent` only when the record is
 * NOT running. Its two running branches — `session.steer(message)`, and the
 * queue-it-until-the-session-exists branch above it — never touched the field.
 * That is not the obscure path: `conversation-viewer.ts` picks its verb with
 * `this.isActive() ? "steer" : "continue"`, so "steer" IS the running case, and
 * the /agents running-agents menu offers the same action.
 *
 * ## Why this is a source pin
 *
 * `agent-manager.ts` imports pi, which does not resolve under the plain
 * `node --experimental-strip-types --test` this suite runs on. Same standing
 * problem, same answer as V7's and U8's pins: when the rule cannot be moved
 * somewhere testable, test the file — with comments stripped first, because the
 * fix's own comment describes the defective form.
 *
 * The behavioural half is below: `appendFollowUp` is pure and importable, so what
 * each branch LEAVES the three readers is checked for real.
 *
 * See W3 in context/design/subagents-loop-verifier-readers.md.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { appendFollowUp, buildAnchorMessage, buildRepairPrompt } from "../src/agents/verify.ts";

function managerCode(): string {
  const source = readFileSync(fileURLToPath(new URL("../src/agents/agent-manager.ts", import.meta.url)), "utf8");
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** The body of `async steer(...)` alone, stopping at the next method. */
function steerBody(code: string): string {
  const start = code.indexOf("async steer(id: string");
  assert.ok(start > 0, "steer() must still exist");
  // Whichever comes first: the helper it calls, or the settled path. Both are
  // outside the method and both mention `growBrief`, which is what is counted.
  const end = Math.min(
    ...["private growBrief", "private continueSettledAgent"]
      .map((needle) => code.indexOf(needle, start))
      .filter((index) => index > start),
  );
  assert.ok(Number.isFinite(end) && end > start, "another method must still follow steer()");
  return code.slice(start, end);
}

describe("steer() grows the brief on every branch", () => {
  it("the running branch records the follow-up, so the judge checks against it", () => {
    const body = steerBody(managerCode());
    assert.ok(
      /growBrief\(record, message\)|appendFollowUp\(record\.execution\.brief/.test(body),
      "steering a RUNNING agent changes the task; the brief the judge, the repair prompt and " +
        "the compaction anchor all read has to change with it",
    );
  });

  it("both running branches do — the queued one reaches the model too", () => {
    const body = steerBody(managerCode());
    const grows = (body.match(/growBrief\(record, message\)/g) ?? []).length;
    assert.equal(
      grows,
      2,
      "one for the live session and one for the pendingSteers queue, which onSessionCreated flushes",
    );
  });

  it("and the settled branch still does, through the same helper", () => {
    const code = managerCode();
    const continued = code.slice(code.indexOf("private continueSettledAgent"));
    assert.match(continued, /growBrief\(record, message\)/);
  });

  it("a steer that threw does not claim to have reached the model", () => {
    // The catch returns false and the brief must be untouched: a brief that
    // records an instruction the model never saw is the same defect pointing the
    // other way — the judge would then fail an answer for not addressing
    // something nobody asked.
    const body = steerBody(managerCode());
    const caught = body.slice(body.indexOf("} catch {"));
    assert.equal(/growBrief/.test(caught), false, "nothing is appended from the failure path");
    const tryBlock = body.slice(body.indexOf("try {"), body.indexOf("} catch {"));
    const steerAt = tryBlock.indexOf("await record.execution.session.steer(message)");
    const growAt = tryBlock.indexOf("growBrief(record, message)");
    assert.ok(steerAt >= 0 && growAt > steerAt, "the brief grows only after the steer went");
  });
});

describe("what each branch leaves the three readers", () => {
  const ORIGINAL = "List every caller of tokenize() in src/, with file:line.";
  const STEER = "Now also list the callers of lex(), same format.";
  const WHY = "it lists callers of lex(), which the task did not ask for";

  it("the grown brief carries both halves into the judge, the repair and the anchor", () => {
    const brief = appendFollowUp(ORIGINAL, STEER);

    assert.ok(brief.includes(ORIGINAL), "the follow-up presupposes the original");
    assert.ok(brief.includes(STEER), "and the steer is half of what the answer has to satisfy");

    const repair = buildRepairPrompt(brief, WHY);
    assert.ok(repair.includes(STEER), "the repair must not hand the child a task the operator has moved on from");

    assert.ok(buildAnchorMessage(brief).includes(STEER), "nor may the post-compaction anchor");
  });

  it("control — an ungrown brief is what the defect handed all three", () => {
    // This is what the running branch used to produce, and it is why the fix is
    // in the manager rather than in any of the readers: each of them is correct
    // about the text it is given.
    const repair = buildRepairPrompt(ORIGINAL, WHY);
    assert.equal(repair.includes(STEER), false);
    assert.match(repair, /Answer it now/);
  });
});
