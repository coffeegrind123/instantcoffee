/**
 * nudge-schedule.ts — Forge fork. WHO is owed a nudge, and WHEN the batch fires.
 *
 * Two rules, both about ordering, both extracted for the reason everything else
 * in this package is: `spawn-coordinator.ts` reaches pi through
 * `../agents/tool-execution.js`, so the suite cannot load it and neither rule
 * could be driven where it lived.
 *
 * ## AM5 — the one-shot `dispose()` cleared, and the report that needed it
 *
 * A background delegation's answer reaches the parent model exactly once, and
 * `backgroundAgentIds` is the one-shot that says it is owed:
 *
 * ```js
 *   onAgentComplete(record) {
 *     if (this.backgroundAgentIds.delete(record.id) || record.execution.settlementCount >= 2) {
 *       this.scheduleNudge(record.id);
 *     }
 *   }
 * ```
 *
 * `dispose()` cleared that set — and `dispose()` runs at `session_shutdown`,
 * BEFORE `AgentManager.dispose()`, which is what actually ends the runs. So the
 * ordering was:
 *
 * ```
 *   session_shutdown
 *     coordinator.dispose()      backgroundAgentIds.clear()   ← the one-shot goes
 *     manager.dispose()          disposes every child session
 *       → each run's .finally    → onAgentComplete            ← set is empty,
 *                                                               settlementCount is 1
 *       → no nudge scheduled, so no drop reported either
 * ```
 *
 * The eighteenth pass (AI1) fixed the OTHER half of this and named the half that
 * was left. Its own note says the `session-replaced` guard inside
 * `emitIndividualNudge`
 *
 * > was written for this very case — its own docstring says "`session_shutdown`,
 * > or a session replaced under it" — but it can only fire for a record that
 * > settles AFTER the dispose
 *
 * and then fixed the ids that were already queued. The records that settle after
 * the dispose are the ones that guard is *for*, and the line one statement above
 * removed their only route to it. Every one of them is a finished delegation
 * whose answer went nowhere, reported to nobody — which is the one thing AC1
 * established this class of failure must never be:
 *
 * > A delivery that did not happen is the loudest thing this class can report;
 * > it must not be the quietest.
 *
 * The set costs three short strings and the coordinator is dropped whole at
 * `setCoordinator(null)`, so the clear was never reclaiming anything. It is gone,
 * and the reason it is gone is written here rather than in a blank line.
 *
 * ## AM6 — one timer, two deadlines
 *
 * The batch has exactly one timer, and the FIRST caller's delay decided when it
 * fires for everyone in it. Since the seventeenth pass there are two delays:
 *
 * ```
 *   NUDGE_DELAY_MS       200 ms   coalesce rapid completions
 *   COMPACTION_WAIT_MS   5,000 ms re-ask after AH1 deferred a nudge
 * ```
 *
 * A held record re-arms at five seconds. Any delegation that settles inside that
 * window — a continuation, or a second agent on another model's slot — was then
 * held for the remainder of somebody else's wait, at twenty-five times its own
 * delay, for no reason: nothing is holding IT back. The batch window is supposed
 * to widen because more work arrived, not because unrelated work is blocked.
 *
 * So the schedule keeps the EARLIEST due time and re-arms when a shorter delay
 * arrives. The other direction is deliberately left alone: a re-ask that fires
 * early because a fresh completion armed a 200 ms timer simply asks the lock
 * again and defers again, which costs one map read.
 */

/** What the caller must do with its timer after `add()`. */
export interface NudgePlan {
  /**
   * Arm a timer for this many milliseconds, clearing any existing one first.
   * `null` means the armed timer is already due no later than this request.
   */
  armInMs: number | null;
}

/**
 * The batch: who is owed a nudge, and when the one timer should fire.
 *
 * The timer itself stays with the coordinator — this module imports nothing and
 * must stay loadable by the suite — so `add()` returns what to do with it and
 * `fired()` is the caller saying it happened.
 */
export class NudgeSchedule {
  /**
   * Agent IDs spawned as background: the one-shot first-settlement gate.
   *
   * AM5: never cleared by a teardown. A record that settles after the session
   * has gone still owes the operator the sentence that its answer was dropped,
   * and this set is what routes it to `emitIndividualNudge`'s `session-replaced`
   * branch.
   */
  private background = new Set<string>();

  /** Ids waiting for the next batch. */
  private pending = new Set<string>();

  /** When the caller's armed timer is due, or undefined when nothing is armed. */
  private dueAt: number | undefined;

  /** This spawn was a background one, so its first settlement owes a nudge. */
  markBackground(agentId: string): void {
    this.background.add(agentId);
  }

  /** Was this spawned in the background? Read by `isBackground()`. */
  isBackground(agentId: string): boolean {
    return this.background.has(agentId);
  }

  /**
   * Does this settlement owe the parent a nudge? Consumes the one-shot.
   *
   * A first settlement owes one when the spawn was background; every
   * continuation settlement owes one for both spawn classes, because the
   * coordinator never observes the steer that caused it. `settlementCount` is
   * written at the top of the settlement chain's `.finally`, before this is
   * asked.
   */
  owes(agentId: string, settlementCount: number): boolean {
    return this.background.delete(agentId) || settlementCount >= 2;
  }

  /**
   * Queue an id for the batch and say what the timer should do.
   *
   * AM6: the earliest due time wins. `now` is injectable for tests.
   */
  add(agentId: string, delayMs: number, now: number = Date.now()): NudgePlan {
    this.pending.add(agentId);
    const dueAt = now + delayMs;
    if (this.dueAt !== undefined && dueAt >= this.dueAt) return { armInMs: null };
    this.dueAt = dueAt;
    return { armInMs: delayMs };
  }

  /** The timer fired: hand over the batch and disarm. */
  drain(): string[] {
    const batch = [...this.pending];
    this.pending.clear();
    this.dueAt = undefined;
    return batch;
  }

  /** Ids still queued, for a teardown that has to report them. */
  queued(): string[] {
    return [...this.pending];
  }

  /**
   * Session teardown: drop the batch (its ids are reported by the caller) and
   * disarm.
   *
   * `background` is deliberately untouched — that is AM5. The header says why.
   */
  retire(): string[] {
    const undelivered = this.drain();
    return undelivered;
  }
}
