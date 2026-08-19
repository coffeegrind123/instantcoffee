/**
 * `AgentStatus` is bounded, and the bound never hides live work.
 *
 * The tool listed EVERY agent ever spawned in the session, unbounded, in one
 * line, into the parent's context. `AgentManager` never evicts a settled record
 * (`/agents` needs them, and so does `continueSettledAgent`), so on a long
 * session the tool's own result becomes the thing filling the window it exists
 * to report on.
 *
 * The rule the bound has to satisfy is not "be short" — it is "never elide
 * something the parent can still act on". A `running` or `queued` agent is
 * actionable; a settled one is history, and history is what `/agents` is for.
 *
 * See §9 of `context/design/subagents-loop-verifier-hosts.md`.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MAX_SETTLED_LISTED, listedStatus, selectAgentsToList } from "../src/agents/status-listing.ts";

/**
 * A record, with the timestamps the bound is measured in.
 *
 * Fifteenth pass (AF4): these used to be absent, and every test here therefore
 * modelled recency as ARRAY POSITION — which is exactly the assumption the
 * shipped code made and the one that was false. `at` defaults to a rising clock,
 * so a test that builds records in order still means what it meant; the tests
 * that are ABOUT recency now say so out loud.
 */
let clock = 0;
const agent = (id: string, status: string, at: number = ++clock) => ({
  id,
  lifecycle: { status, startedAt: at, completedAt: at },
});

/**
 * The state `attachSettlementChain` leaves a record in while the verifier runs:
 * the CHILD's run is classified and terminal, and a judge (or up to three
 * repairs) is in flight on the one llama slot the parent is queued behind.
 * `verifyPhase` is the only field that says so.
 */
const verifying = (id: string, at: number = ++clock) => ({
  id,
  lifecycle: { status: "completed", startedAt: at },
  verifyPhase: "judging",
});

describe("selectAgentsToList", () => {
  it("never elides a running or queued agent, however many there are", () => {
    const agents = [
      ...Array.from({ length: 20 }, (_, i) => agent(`done${i}`, "completed")),
      ...Array.from({ length: 12 }, (_, i) => agent(`live${i}`, "running")),
      ...Array.from({ length: 5 }, (_, i) => agent(`wait${i}`, "queued")),
    ];
    const { listed, elided } = selectAgentsToList(agents);

    const liveListed = listed.filter((a) => a.lifecycle.status !== "completed");
    assert.equal(liveListed.length, 17, "every running and queued agent must survive the bound");
    assert.equal(elided, 20 - MAX_SETTLED_LISTED);
  });

  it("keeps the most recent settled agents, not the oldest", () => {
    const agents = Array.from({ length: 10 }, (_, i) => agent(`a${i}`, "completed", 1_000 + i));
    const { listed } = selectAgentsToList(agents);

    assert.equal(listed.length, MAX_SETTLED_LISTED);
    assert.equal(listed[listed.length - 1].id, "a9", "the newest settled agent must be listed");
    assert.ok(
      !listed.some((a) => a.id === "a0"),
      "the oldest is the one to drop — the model is looking for the batch it just launched",
    );
  });

  /**
   * AF4 — the same ten agents, handed over the way the caller actually hands
   * them over.
   *
   * `AgentManager.listAgents()` is
   * `[...this.agents.values()].sort((a, b) => b.lifecycle.startedAt - a.lifecycle.startedAt)`
   * — newest FIRST. The bound was `settled.slice(-limit)` under a comment saying
   * the caller's order is spawn order, so it kept the six OLDEST agents in the
   * session and reported the four the model had just launched as
   * "(+4 older, see /agents)". The test above could not see it: it built its
   * array oldest-first, which is the one order the caller never uses.
   *
   * Executed against the real manager and the real tool in
   * `context/testing/probes/s2-the-six-oldest-agents.mjs`.
   */
  it("AF4 — and keeps them when the caller hands them over newest-first", () => {
    const newestFirst = Array.from({ length: 10 }, (_, i) => agent(`a${9 - i}`, "completed", 1_000 + (9 - i)));
    const { listed, elided } = selectAgentsToList(newestFirst);

    assert.deepEqual(
      listed.map((a) => a.id),
      ["a4", "a5", "a6", "a7", "a8", "a9"],
      "the six newest, oldest-first so the newest sits next to the nudge",
    );
    assert.equal(elided, 4);
  });

  it("AF4 — recency is when the agent SETTLED, not when it started", () => {
    // A long delegation started first and came back last; a short one started
    // after it and came back before it. "What came back" is the question the
    // tool answers.
    const slow = { id: "slow", lifecycle: { status: "completed", startedAt: 1, completedAt: 900 } };
    const quick = Array.from({ length: 6 }, (_, i) => ({
      id: `quick${i}`,
      lifecycle: { status: "completed", startedAt: 100 + i, completedAt: 100 + i },
    }));
    const { listed } = selectAgentsToList([slow, ...quick]);
    assert.equal(listed[listed.length - 1].id, "slow", "the most recently settled record is last");
    assert.ok(!listed.some((a) => a.id === "quick0"), "and the oldest settlement is the one dropped");
  });

  it("counts what it left out", () => {
    const agents = Array.from({ length: 9 }, (_, i) => agent(`a${i}`, "error"));
    assert.equal(selectAgentsToList(agents).elided, 3);
  });

  it("control — a short session is listed in full and elides nothing", () => {
    const agents = [agent("a", "completed"), agent("b", "running"), agent("c", "stopped")];
    const { listed, elided } = selectAgentsToList(agents);
    assert.equal(listed.length, 3);
    assert.equal(elided, 0);
  });

  it("control — no agents at all", () => {
    assert.deepEqual(selectAgentsToList([]), { listed: [], elided: 0 });
  });

  it("every terminal status counts as settled, not just `completed`", () => {
    // The predicate is written the other way round — unfinished is running or
    // queued — precisely so a status added later (`turn_limited`, `stopped`,
    // `error`, and whatever comes next) is history by default rather than
    // silently unbounded.
    const agents = [
      agent("a", "error"),
      agent("b", "stopped"),
      agent("c", "turn_limited"),
      agent("d", "aborted"),
      agent("e", "completed"),
      agent("f", "completed"),
      agent("g", "completed"),
    ];
    assert.equal(selectAgentsToList(agents, 2).elided, 5);
  });

  it("a bound of zero still lists everything unfinished", () => {
    const agents = [agent("a", "completed"), agent("b", "running")];
    const { listed, elided } = selectAgentsToList(agents, 0);
    assert.deepEqual(
      listed.map((a) => a.id),
      ["b"],
    );
    assert.equal(elided, 1);
  });
});

/**
 * AE5 — the record that is still working while its status says it finished.
 *
 * `record-activity.ts` exists so "is this record busy" has one answer, and this
 * module had its own. The consequence is worse here than in the three readers
 * that were already fixed, because the bound is what makes it worse: a verifying
 * record fell into the SETTLED bucket, so it was not merely mislabelled — with
 * seven or more finished agents behind it, it was elided from a reply whose own
 * closing sentence is "Don't poll".
 *
 * See AE5 in `context/design/subagents-loop-verifier-claims.md`.
 */
describe("AE5 — a record whose answer is still being checked is still busy", () => {
  it("is never elided, however much history is in front of it", () => {
    const agents = [
      ...Array.from({ length: 20 }, (_, i) => agent(`done${i}`, "completed")),
      verifying("judge-me"),
    ];
    const { listed, elided } = selectAgentsToList(agents);

    assert.ok(
      listed.some((a) => a.id === "judge-me"),
      "the one agent holding the slot must not be dropped as history",
    );
    assert.equal(elided, 20 - MAX_SETTLED_LISTED, "and the settled ones are still bounded");
  });

  it("is listed FIRST, with the finished ones after it", () => {
    const agents = [agent("old", "completed"), verifying("judge-me")];
    assert.deepEqual(
      selectAgentsToList(agents).listed.map((a) => a.id),
      ["judge-me", "old"],
    );
  });

  it("says what is actually happening, without dropping the child's own verdict", () => {
    assert.equal(listedStatus(verifying("x")), "completed (answer being checked)");
  });

  it("control — the same record once the check is over is ordinary history", () => {
    const finished = { id: "judge-me", lifecycle: { status: "completed", startedAt: 9_000, completedAt: 9_000 } };
    const agents = [...Array.from({ length: 20 }, (_, i) => agent(`done${i}`, "completed", 1_000 + i)), finished];

    assert.equal(listedStatus(finished), "completed", "no decoration once nothing is in flight");
    assert.ok(
      selectAgentsToList(agents).listed.some((a) => a.id === "judge-me"),
      "it is the newest settled record, so it survives on recency alone — which is why the",
    );
    // …and with more history behind it, recency alone is not enough: this is the
    // control that shows the first assertion above is about `verifyPhase` and
    // not about position.
    const buried = [finished, ...Array.from({ length: 20 }, (_, i) => agent(`done${i}`, "completed", 10_000 + i))];
    assert.ok(!selectAgentsToList(buried).listed.some((a) => a.id === "judge-me"));
    assert.ok(
      selectAgentsToList([verifying("judge-me"), ...Array.from({ length: 20 }, (_, i) => agent(`d${i}`, "completed"))])
        .listed.some((a) => a.id === "judge-me"),
      "the identical record WITH a verify phase survives the same burial",
    );
  });
});
