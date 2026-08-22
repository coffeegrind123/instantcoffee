/**
 * nudge-drop.ts — Forge fork. A background result that was not delivered, said out loud.
 *
 * ## The three silent returns
 *
 * `SpawnCoordinator.emitIndividualNudge` is the only route a BACKGROUND
 * subagent's answer has to the parent model, and it began with three guards:
 *
 *     if (this.disposed) return;                    // the session was replaced
 *     const pi = getPiInstance();
 *     if (!pi) return;                              // no runtime to send through
 *     const record = this.manager.getRecord(agentId);
 *     if (!record) return;                          // the record is gone
 *
 * Each of them is correct — there is genuinely nothing to send through, or
 * nothing to send. And each of them dropped a finished delegation's answer with
 * nothing said anywhere: not to the model, not to the operator, not to the log.
 * That is §11.1 of `…-omissions.md`, recorded by the fifteenth pass and closed
 * here.
 *
 * AC1 already settled what this class of failure is worth saying:
 *
 *   > A delivery that did not happen is the loudest thing this class can report;
 *   > it must not be the quietest.
 *
 * — and it built exactly that for the `catch` around the send: a `console.warn`
 * that runs whether or not there is a UI, plus a notice through the spawning
 * session's context. The three guards above bypassed it, because they return
 * before the `try`.
 *
 * ## Why the sentences live here
 *
 * `spawn-coordinator.ts` imports `../shell.js`, which imports pi, so the suite
 * cannot load it — the same reason `record-activity.ts`, `status-listing.ts`,
 * `action-report.ts` and `concurrency-slots.ts` exist. This module imports
 * nothing, so what the operator is told is testable, and the coordinator keeps
 * only the wiring.
 *
 * ## What each reason means for the operator
 *
 * ## AG6, sixteenth pass — the recovery has to be one that works
 *
 * All three used to end *"Read it with AgentStatus"*, and `AgentStatus` prints
 * one line per agent:
 *
 * ```ts
 *   return `${shortId} (${record.display.type}) ${listedStatus(record)}`;
 *                                          agents/agent-status.ts:37
 * ```
 *
 * — the id, the type and the status. Not the result, not the error, not the
 * output file; the whole module never touches `record.result`. The surface that
 * CAN show it is `/agents` → the agent → **"View result"**
 * (`ui/menu/menu-running-agents.ts`, which reaches `showTextViewer(ctx, record,
 * "result", record.result!)`).
 *
 * The paragraph this replaces already knew — it said "`AgentStatus` (or
 * `/agents`) will show it" — and the sentence it shipped carried the half that
 * does not work. That is the shape of the whole sixteenth pass: **the thing you
 * name is a file you can open.**
 *
 * `record-gone` gets a different sentence again, because for that one there is
 * no recovery at all: the record was removed from the manager's map, and
 * `AgentStatus` and `/agents` both list exactly that map. Saying so is the
 * honest answer, and recommending a surface that cannot work is worse than
 * saying nothing.
 */

export type NudgeDropReason =
  /** The coordinator was disposed — `session_shutdown`, or a session replaced under it. */
  | "session-replaced"
  /**
   * The nudge was still QUEUED when the coordinator was disposed.
   *
   * Forge fork, eighteenth pass (AI1). Distinct from `session-replaced`, which is
   * a nudge that fired after the dispose: this one never fired at all, because
   * `dispose()` cleared the batch set it was sitting in. The difference matters
   * for what is said — there is no `/agents` to open by then, so naming it would
   * be AG6's defect restored — and it is why the reason exists rather than
   * reusing the neighbour's sentence.
   */
  | "session-ending"
  /** `getPiInstance()` is empty: there is no runtime to send a message through. */
  | "no-runtime"
  /** The record was removed between the nudge being scheduled and this firing. */
  | "record-gone";

export interface NudgeDrop {
  /** For `console.warn`, which runs whether or not there is a UI. */
  log: string;
  /** For `ctx.ui.notify`, which is a no-op headless — hence the line above. */
  notice: string;
}

/**
 * What to say about a background result that was not delivered.
 *
 * `type` is absent for `record-gone`, which is the one case where there is no
 * record left to ask.
 */
/**
 * How to read the answer that was not delivered, per reason.
 *
 * Exported so the coordinator's own `catch` — a different drop, with the same
 * question to answer — uses one sentence rather than a fourth copy of it.
 */
export const RECOVERY_ADVICE = 'Open /agents, select it, and choose "View result" to read it.';

/** What to say when there is no answer left to read. */
export const NO_RECOVERY_ADVICE = "The answer is gone with it.";

/**
 * What to say about a background result that is being HELD rather than dropped.
 *
 * Forge fork, seventeenth pass (AH1). A held nudge is not a drop and must not
 * read like one — the answer is intact, the record is intact, and it will be
 * delivered as soon as the compaction that is running finishes. The operator is
 * told once per record, at `info`, because the interesting thing about it is that
 * nothing is wrong.
 *
 * It says WHO is compacting for the same reason `startCompaction` and
 * `sendLoopTurn` do: the lock's whole value over a boolean is that it names the
 * holder, and "something is compacting" is a sentence an operator can do nothing
 * with.
 *
 * The wait is bounded by the lock itself — a holder older than `STALE_MS` (five
 * minutes) reads as absent — so the worst case is one five-minute pause and then
 * the answer goes, which is the bound `pi-loop-mode`'s own deferral relies on.
 */
export function describeNudgeHold(owner: string, shortId: string, type?: string): NudgeDrop {
  const who = type ? `"${type}" ${shortId}` : shortId;
  return {
    log: `holding the result of ${who}: ${owner} is compacting, and pi does not refuse a turn started during one`,
    notice: `[Subagent ${who}] result held — ${owner} is compacting; it will be delivered when that finishes.`,
  };
}

export function describeNudgeDrop(
  reason: NudgeDropReason,
  shortId: string,
  type?: string,
  /**
   * The record's own transcript file, when one was kept.
   *
   * AI1's case has no live surface to point at — the session that owns `/agents`
   * is the thing that is ending — so the only recovery that can work is a file
   * that is already on disk. `outputTranscript` is off by default, so this is
   * usually absent and the sentence says so instead of inventing a recovery.
   */
  outputFile?: string,
): NudgeDrop {
  const who = type ? `"${type}" ${shortId}` : shortId;
  const because =
    reason === "session-replaced"
      ? "the session was replaced before the result could be delivered"
      : reason === "session-ending"
        ? "the session ended while the result was still queued for delivery"
        : reason === "no-runtime"
          ? "there is no live extension runtime to deliver it through"
          : "its record was removed before the result could be delivered (cleared from /agents?)";
  // AG6: the record is what holds the answer, so when the record is gone there
  // is nothing to point at — and both surfaces read the same map.
  //
  // AI1: the same rule for the session that is ending. `/agents` reads the
  // manager's map, and `session_shutdown` disposes the manager two statements
  // after the coordinator — so naming that surface here would be a recovery that
  // cannot work, which is exactly what AG6 was about. The transcript file is the
  // one thing that outlives the session, when there is one.
  const recovery =
    reason === "record-gone"
      ? NO_RECOVERY_ADVICE
      : reason === "session-ending"
        ? outputFile
          ? `The session is going away with it; the transcript is at ${outputFile}.`
          : NO_RECOVERY_ADVICE
        : RECOVERY_ADVICE;
  return {
    log: `could not deliver the result of ${who}: ${because}`,
    // The operator's copy names the recovery, and it has to be one that can
    // actually produce the answer — see AG6 in the header.
    notice: `[Subagent ${who}] result NOT delivered to the model — ${because}. ${recovery}`,
  };
}
