/**
 * action-report.ts — Forge fork. What the operator is told when the manager says no.
 *
 * ## The defect this was extracted for
 *
 * Every action in `/agents` and in the conversation viewer goes through
 * `AgentManager`, and every one of those methods answers with a boolean:
 *
 *     abort(id)   false  — the record is not running, not queued and not verifying
 *     clear(id)   false  — it is still running, or its answer is still being checked (Y1)
 *     steer(id)   false  — still settling, no session, streaming, or the model's
 *                          concurrency slot is full (which, at this fork's default
 *                          of 1, is any continuation while another agent runs)
 *
 * Those refusals are the correct behaviour and several of them were installed
 * deliberately — Y1 exists to stop `Clear` disposing the session a repair is
 * running in. What was missing is the other half: five of the six call sites
 * discarded the answer and told the operator the action had happened.
 *
 *     menu  Stop        `getManager()?.abort(...)`   → "Stopped 1a2b3c4d"
 *     menu  Clear       `getManager()?.clear(...)`   → "Cleared 1a2b3c4d"
 *     menu  Stop all    a loop, no count             → "Stopped 3 agent(s)"
 *     menu  Clear all   a loop, no count             → "Cleared 7 finished agent(s)"
 *     menu  Clear done  a loop, no count             → "Cleared 4 completed agent(s)"
 *     viewer steer      `this.onSteer?.(message)`    → nothing at all
 *
 * The three bulk counts came from a snapshot taken before the menu opened, so
 * they were a claim about the state of the world several seconds earlier — and
 * `/agents` is open precisely while agents are running and settling.
 *
 * The sixth call site is the menu's own single-agent Steer, which has always
 * read the boolean and says "Steer failed for X". It is the counter-example that
 * shows the rule was known; this module is that rule, in one place, for all six.
 *
 * The sentences live here rather than at the call sites because this file
 * imports nothing and can therefore be tested — the same move as
 * `record-activity.ts`, `status-listing.ts` and `concurrency-slots.ts`, and for
 * the same reason: `menu-running-agents.ts` and `conversation-viewer.ts` import
 * `@earendil-works/pi-tui`, which the suite cannot load.
 *
 * See AF2 in `context/design/subagents-loop-verifier-omissions.md`.
 */

export interface ActionReport {
  text: string;
  level: "info" | "warning" | "error";
}

/**
 * Stopping one agent.
 *
 * `verifying` names WHICH run was stopped, for the reason `StopAgent`'s own
 * sentence does (AD2): the child's own run has already finished by then, and
 * "Stopped X" alone would be a claim about that one.
 */
export function stopReport(ok: boolean, shortId: string, verifying = false): ActionReport {
  if (!ok) {
    return {
      text: `${shortId} was already finished — nothing to stop.`,
      level: "info",
    };
  }
  return verifying
    ? { text: `Stopped the answer check on ${shortId}; its own run had already finished.`, level: "info" }
    : { text: `Stopped ${shortId}`, level: "info" };
}

/**
 * Clearing one agent.
 *
 * The refusal has two causes and the operator can act on the difference: a
 * record that is still running is theirs to stop first, and one whose answer is
 * being checked will clear itself in a moment.
 */
export function clearReport(ok: boolean, shortId: string, verifying = false): ActionReport {
  if (ok) return { text: `Cleared ${shortId}`, level: "info" };
  return verifying
    ? {
        text: `${shortId} is still having its answer checked — it will clear once the check finishes.`,
        level: "warning",
      }
    : { text: `${shortId} is still running — stop it first.`, level: "warning" };
}

/**
 * Steering or continuing one agent.
 *
 * The reason is stated rather than left as "failed", because on this fork the
 * likeliest one is mundane and fixable: `continueSettledAgent` refuses when the
 * model's concurrency slot is full, and the default limit is 1.
 */
export function steerReport(ok: boolean, shortId: string, verb: "steer" | "continue" = "steer"): ActionReport {
  if (ok) return { text: `Steer sent to ${shortId}…`, level: "info" };
  return {
    text:
      `Could not ${verb} ${shortId} — it is still settling, or another agent holds the ` +
      `concurrency slot. Nothing was sent; try again in a moment.`,
    level: "error",
  };
}

/**
 * A bulk action, counted from what actually happened.
 *
 * `attempted` is the list the menu acted on, `applied` is how many the manager
 * accepted. When they differ the difference is stated: the records that refused
 * are still there, and an operator told "Cleared 7" will not look for them.
 *
 * ## AG6 (sixteenth pass) — one sentence per verb, because the two refusals are
 * opposites
 *
 * Both verbs used to share *"N were still busy and were left alone"*. That is
 * right for a refused CLEAR — `AgentManager.clear()` refuses exactly a running
 * or a verifying record (Y1) — and it is the one thing a refused STOP cannot
 * mean. `stopAgent()` has a single reachable `return false`:
 *
 * ```ts
 *   } else if (record.lifecycle.status !== "running") {
 *     return false;
 *   }
 * ```
 *
 * reached only when the record is not queued, not running, and not verifying —
 * the verifying case is intercepted above it and returns `true` (T5). So a
 * refused stop always means the record had already **finished**, and an operator
 * told it was "still busy" goes looking for a busy agent that does not exist.
 * `stopReport(false, …)` — the same module, one agent at a time — has said
 * "was already finished — nothing to stop" since AF2 landed; this is that
 * sentence at the call site whose two verbs have opposite causes.
 *
 * The count is pluralised for the same reason it is stated at all: "1 were still
 * busy" is text an operator reads.
 */
export function bulkReport(verb: "Stopped" | "Cleared", applied: number, attempted: number): ActionReport {
  if (attempted === 0) return { text: `Nothing to ${verb === "Stopped" ? "stop" : "clear"}.`, level: "info" };
  if (applied === attempted) return { text: `${verb} ${applied} agent(s)`, level: "info" };
  const left = attempted - applied;
  const were = left === 1 ? "was" : "were";
  return {
    text:
      verb === "Stopped"
        ? `Stopped ${applied} of ${attempted} agent(s); ${left} had already finished.`
        : `Cleared ${applied} of ${attempted} agent(s); ${left} ${were} still busy and ${were} left alone.`,
    level: "warning",
  };
}
