/**
 * record-teardown.ts — Forge fork. Everything one delegation OWNS, ended in the
 * one order that works.
 *
 * Forge fork, twenty-second pass (AM3).
 *
 * ## Why the ORDER is the whole of it
 *
 * A record owns three things that have to be ended, and two of them are ended by
 * the same call in the wrong direction:
 *
 * ```
 *   execution.transcript   a subscription on the child's session + a buffer
 *   execution.verifyAbort  the controller that ends a judge or a repair
 *   execution.session      the child's AgentSession — which is the session the
 *                          REPAIR runs in
 * ```
 *
 * `AgentManager.dispose()` ended the transcript and the session and left the
 * verifier alone. `stopAgent()` knows better — T5 built the abort precisely so a
 * verifying record is stoppable, and its comment says the fix is for "the
 * operator's Esc, for `StopAgent`, and for anything else that asked".
 * `session_shutdown` is something else that asks.
 *
 * ## What the wrong order actually produced
 *
 * Not a crash, which is why it is worth writing down. `AgentSession.dispose()`
 * aborts the agent and calls `_disconnectFromAgent()`, so a `prompt()` issued
 * afterwards still reaches the provider — and its events reach nobody, because
 * the session is no longer subscribed to the agent. So:
 *
 * ```
 *   dispose() disposes the session
 *   → the repair's continueAgentSession() prompts it anyway
 *   → one model call on the one llama slot, during a session teardown
 *   → collectResponseText sees no message_end at all      → ""
 *   → structuralVerdict("")                               → ok: false
 *   → verifyAnswer returns verificationNote("failed")
 *   → the child's perfectly good ORIGINAL answer goes back annotated
 *     "this answer was checked against the task and did not address it"
 * ```
 *
 * The check being torn down is reported to the parent model as the child having
 * failed. That is the exact inversion `verifyAnswer`'s "never throws" contract
 * exists to prevent, arriving from the outside.
 *
 * Aborting first routes it through `verifyAnswer`'s catch, which is this layer's
 * "the check did not happen" path: the answer is preserved and labelled
 * `errored`.
 *
 * ## Why it is a module, and why it imports nothing
 *
 * There were two teardowns for one record — `dispose()` and `removeRecord()` —
 * and they had drifted: only one of them cleared `execution.session`, and
 * neither ended the verifier. `agent-manager.ts` imports pi and therefore cannot
 * be loaded by the suite, so the order was untestable where it lived. Same move,
 * and the same reason, as `concurrency-slots.ts`, `turn-tracking.ts`,
 * `record-activity.ts` and `run-answer.ts`.
 */

/** The slice of a record this reads. Duck-typed so the module imports nothing. */
export interface TeardownRecord {
  execution: {
    transcript?: { dispose(): void };
    verifyAbort?: { abort(): void };
    session?: { dispose(): void };
  };
}

/**
 * End the transcript, the verifier and the session — in that order — and drop
 * the handles.
 *
 * Every step is guarded on its own: a transcript that throws on the way out must
 * not be the reason a session is left running, and an abort that throws must not
 * be the reason a session is left undisposed. The record is going away either
 * way; what matters is that nothing it owns outlives it.
 *
 * `verifyAbort` is deliberately NOT cleared here. `runVerification`'s own
 * `finally` owns that field and clears it on every path, including the one this
 * abort creates; clearing it here would race that and could leave
 * `isVerifyingRecord` reading a record as idle while its catch is still running.
 */
export function teardownRecord(record: TeardownRecord): void {
  try {
    record.execution.transcript?.dispose();
  } catch {
    // A transcript is a record of the work, not the work.
  }
  record.execution.transcript = undefined;

  // AM3: before the session, because the session is what the repair runs in.
  try {
    record.execution.verifyAbort?.abort();
  } catch {
    // An AbortController that throws is not a reason to leak a session.
  }

  try {
    record.execution.session?.dispose();
  } catch {
    // Same rule as everywhere else in this teardown: keep going.
  }
  record.execution.session = undefined;
}
