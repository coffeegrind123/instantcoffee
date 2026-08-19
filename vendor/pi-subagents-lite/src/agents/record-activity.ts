/**
 * record-activity.ts — Forge fork. Is this record still busy?
 *
 * One question, and until this module it was answered in three places that did
 * not agree.
 *
 * The child's run and the VERIFIER's run are two different things wearing one
 * status. `attachSettlementChain` sets `record.lifecycle.status` from
 * `classifyRun` and *then* awaits `runVerification`, so throughout a judge and
 * up to three repairs the record reads `completed` while a model call is in
 * flight on the one llama slot the parent is blocked behind. `verifyPhase` is
 * the only field that says so.
 *
 * `agent-widget.ts` knew that — `categorizeAgents` has had a comment since the
 * phase field existed saying a verifying record "is active work the user is
 * waiting on: it stays running". `menu-running-agents.ts` did not: its own
 * `isActive()` was `status === "running" || status === "queued"`, so the same
 * record was drawn as running in the widget and listed as finished, with a ✓,
 * in `/agents` — where Clear was the only action offered for it, and where
 * "Clear done" and "Clear all" both reached it.
 *
 * Clearing it is not cosmetic. `AgentManager.removeRecord` disposes
 * `execution.session`, which is the session a repair runs IN; it opens the
 * completion gate with `""`, so a foreground `Agent` call blocked on that gate
 * resumes with an empty answer while the real one is still being checked; and it
 * deletes the record the verifier is about to write its verdict to.
 *
 * So the predicate lives here, imports nothing, and has three readers instead of
 * three definitions. See Y1 in
 * `context/design/subagents-loop-verifier-turns.md`.
 */

/** The slice of a record these predicates read. Duck-typed so this module imports nothing. */
export interface ActivityLike {
  lifecycle: { status: string };
  verifyPhase?: unknown;
}

/** The agent's own run is still going: running or waiting for a slot. */
export function isActiveRecord(record: ActivityLike): boolean {
  return record.lifecycle.status === "running" || record.lifecycle.status === "queued";
}

/**
 * The verifier is still working on this record.
 *
 * True only between `runVerification`'s first phase report and its `finally`,
 * which clears the field on every path it owns — including the two throwing
 * ones — so this cannot latch on.
 */
export function isVerifyingRecord(record: ActivityLike): boolean {
  return Boolean(record.verifyPhase);
}

/**
 * Active work, in the sense ADR-0006 means it: nothing here may be cleared, and
 * nothing here belongs in a "finished" list.
 */
export function isBusyRecord(record: ActivityLike): boolean {
  return isActiveRecord(record) || isVerifyingRecord(record);
}
