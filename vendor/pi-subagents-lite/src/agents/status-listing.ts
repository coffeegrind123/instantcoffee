/**
 * status-listing.ts — Forge fork. Which agents the `AgentStatus` tool prints.
 *
 * Lifted out of `agent-status.ts` for the reason `turn-tracking.ts`,
 * `record-activity.ts`, `run-answer.ts`, `compaction-anchor.ts` and
 * `git-failure.ts` were: that file imports `../shell.js`, which imports pi, so
 * nothing in it could be tested. This module imports nothing and duck-types the
 * record.
 *
 * ## The defect
 *
 * `AgentStatus` listed EVERY agent ever spawned in the session, unbounded, in
 * one line, into the parent's context. `AgentManager` never evicts a settled
 * record — `/agents` needs them, and so does `continueSettledAgent` — so on a
 * long session the tool's own result becomes the thing filling the window it
 * exists to report on. Fifty delegations is a ~2 kB line of which the last three
 * entries are the only ones anyone can act on.
 *
 * ## The bound
 *
 * Everything unfinished, plus the most recent few that are finished.
 *
 * A `running` or `queued` agent is actionable and is never dropped, however many
 * there are — the tool's job is to answer "what is still happening", and a bound
 * that could elide that would make it answer a different question. A settled one
 * is history, and history is what `/agents` is for. The elided count is stated
 * rather than silently omitted, for the same reason: a tool that quietly answers
 * a narrower question than it was asked is worse than a long one.
 */

import { isBusyRecord } from "./record-activity.ts";

/**
 * The slice of a record this needs.
 *
 * `verifyPhase` is here because `lifecycle.status` alone cannot answer the
 * question this module asks — see `isUnfinished`. `record-activity.ts` imports
 * nothing either, so taking the predicate from there costs this module none of
 * its testability.
 */
export interface ListableAgent {
  /**
   * `startedAt` and `completedAt` are what "the most recent few" is measured in.
   *
   * Forge fork, fifteenth pass (AF4): they used to be absent, and the bound read
   * recency off the CALLER's array order instead — under a comment saying "order
   * within each group is the manager's own (spawn order), so the newest settled
   * agents come last". `AgentManager.listAgents()` sorts
   * `(a, b) => b.lifecycle.startedAt - a.lifecycle.startedAt`, i.e. newest
   * FIRST, so `settled.slice(-limit)` kept the OLDEST six and the "+N older"
   * count described the newest. A bound has to carry the field it bounds on.
   */
  lifecycle: { status: string; startedAt?: number; completedAt?: number };
  verifyPhase?: unknown;
}

/**
 * How many SETTLED agents the tool lists. Unfinished ones are never elided.
 *
 * Six: enough that the model sees the batch it just launched come back, few
 * enough that the line stays around 250 characters on a busy session.
 */
export const MAX_SETTLED_LISTED = 6;

/**
 * True for a record the parent can still act on — never elided.
 *
 * Forge fork, fourteenth pass (AE5): `isBusyRecord`, not a status
 * test. `attachSettlementChain` sets `lifecycle.status` from `classifyRun` and
 * only THEN awaits `runVerification`, so throughout a judge and up to three
 * repairs the record reads `completed` while a model call is in flight on the
 * one llama slot the parent is queued behind. A status test therefore put the
 * one agent that is still working into the SETTLED bucket — where the bound
 * below can elide it entirely, under a comment that says an actionable agent
 * "is never dropped, however many there are".
 *
 * That is AD2 at the sibling tool. `StopAgent` was moved to `isBusyRecord` in
 * the thirteenth pass and `AgentStatus` — the tool whose whole job is answering
 * "what is still happening", and the one the model reaches for first — was left
 * with its own copy. `record-activity.ts` exists so this question has one
 * answer; this was the fifth reader that still had its own.
 */
export function isUnfinished(record: ListableAgent): boolean {
  return isBusyRecord(record);
}

/**
 * What the tool prints for a record's state.
 *
 * A verifying record's `lifecycle.status` is `completed`, which is true of the
 * CHILD's run and false of the record: the answer the parent is about to be
 * handed has not been decided yet, and the slot is still held. Printing
 * `completed` alone told the model the work was done, at the one moment it was
 * not — and, since the same reply carries "don't poll", the model had no reason
 * to look again.
 *
 * The child's own status is kept rather than replaced, because it is also true
 * and the two facts are about different runs. See `record-activity.ts`.
 */
export function listedStatus(record: ListableAgent): string {
  const status = record.lifecycle.status;
  return record.verifyPhase ? `${status} (answer being checked)` : status;
}

/**
 * When a settled record last did anything, for "the most recent few".
 *
 * `completedAt` rather than `startedAt` where both exist: the question the tool
 * answers is "what came back", and a long delegation started first can settle
 * last. `startedAt` is the fallback for a record that has no completion time
 * (never started, or one the manager stopped before it ran).
 */
function settledAt(record: ListableAgent): number {
  const { completedAt, startedAt } = record.lifecycle;
  return typeof completedAt === "number" ? completedAt : typeof startedAt === "number" ? startedAt : 0;
}

/**
 * The agents worth printing — every unfinished one, then the most recent settled
 * ones — and how many settled records were left out.
 *
 * Unfinished records keep the caller's order. Settled ones are ordered HERE, by
 * their own timestamps, and printed oldest-first so the newest is last, next to
 * the nudge.
 *
 * Forge fork, fifteenth pass (AF4): this used to be `settled.slice(-limit)`, on
 * the strength of a comment claiming the caller hands them over in spawn order.
 * `AgentManager.listAgents()` hands them over NEWEST FIRST, so the bound kept
 * the six oldest agents in the session and reported the ones the model had just
 * launched as `(+N older, see /agents)`. Measured:
 * `context/testing/probes/s2-the-six-oldest-agents.mjs` — ten settled agents
 * `a0`…`a9` printed as `a5, a4, a3, a2, a1, a0 (+4 older)`.
 *
 * A bound is a refusal with a rule in it, and the rule has to be checked against
 * what the caller actually hands over. This one now reads the field the rule is
 * about instead of trusting an order.
 */
export function selectAgentsToList<T extends ListableAgent>(
  agents: readonly T[],
  maxSettled: number = MAX_SETTLED_LISTED,
): { listed: T[]; elided: number } {
  const limit = Math.max(0, Math.floor(maxSettled));
  const unfinished = agents.filter((record) => isUnfinished(record));
  const settled = agents.filter((record) => !isUnfinished(record));
  // Oldest → newest, so the tail is the most recent and `slice(-limit)` keeps
  // the end the comment above promises. Stable in node, so records that carry no
  // timestamps at all keep the caller's order rather than being reshuffled.
  const byRecency = [...settled].sort((a, b) => settledAt(a) - settledAt(b));
  const keptSettled = limit > 0 ? byRecency.slice(-limit) : [];
  return { listed: [...unfinished, ...keptSettled], elided: settled.length - keptSettled.length };
}
