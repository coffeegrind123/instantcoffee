/**
 * turn-tracking.ts — Forge fork. The turn ceiling, and why a one-turn budget is
 * not the same shape as a long one.
 *
 * Lifted out of `agent-runner.ts` for one reason: that file imports
 * `@earendil-works/pi-coding-agent`, which does not resolve under the plain
 * `node --experimental-strip-types --test` the suite runs on, so nothing here
 * could be tested. This module imports nothing at all and duck-types the session,
 * which is the same shape `verify.ts`, `declared-resources.ts` and
 * `verification-badge.ts` take for the same reason.
 *
 * ## The ceiling
 *
 * A subagent always has one, even when nothing set it. Upstream leaves `maxTurns`
 * undefined unless an agent file or the caller supplies it, and undefined means
 * unbounded — defensible when a subagent is a short-lived search, not defensible
 * here, because `AgentSession.prompt()` defaults `expandPromptTemplates` to true
 * and this fork calls it bare, so a prompt beginning with `/loop …` starts a real
 * loop inside the child. An unbounded loop on a one-slot llama server is not a
 * runaway subagent, it is a stopped machine: the parent's next turn queues behind
 * it forever.
 *
 * 40 is generous for the work people actually delegate — a search that reads a
 * dozen files, or a bounded loop with a clear goal — while still being a number.
 *
 * ## The soft limit, and the one-turn exception
 *
 * On reaching the ceiling the run is steered "wrap up immediately", and hard
 * aborted `graceTurns` later, so hitting it produces a final answer rather than a
 * severed run. That works because the steer lands in a run that was going to keep
 * going anyway.
 *
 * With `maxTurns: 1` it does not, and the difference is not cosmetic. pi's agent
 * loop drains the steering queue immediately after `turn_end` (pi-agent-core
 * `agent-loop.js:160`, inside `while (hasMoreToolCalls || pendingMessages.length
 * > 0)`) and `AgentSession._emit` calls subscribers synchronously, so a steer
 * queued from a `turn_end` handler is picked up before the loop can decide to
 * stop. A single-turn run therefore takes a SECOND provider call, and
 * `collectResponseText` resets on the injected user message's `message_start`, so
 * the text handed back is the reply to "wrap up" rather than the answer.
 *
 * Both of the answer verifier's model calls run with `maxTurns: 1`. Measured
 * against a loop-faithful stub with the real `runSessionPrompt`: a judge that
 * replied `VERDICT: NOT_ADDRESSED` had that verdict replaced by "I have already
 * given my final answer above", which `parseJudgeVerdict` reads as unreadable and
 * therefore — by the fail-open policy — as a pass. Every verified delegation paid
 * for two calls on the single llama slot the parent is blocked on, and could not
 * read the one it paid for.
 *
 * So the soft-limit steer is skipped when the budget is one turn. A one-turn run
 * that made tool calls still continues (pi's loop keeps going while there are
 * tool results) and is still bounded by the hard abort, so nothing loses its
 * ceiling; it is simply not asked to wrap up a turn it has already finished.
 *
 * ## …and the flag that goes with it
 *
 * `turnLimited` follows the steer rather than the ceiling, for the same reason.
 * Reaching a one-turn ceiling IS finishing, and the two readers of the flag both
 * take it to mean the opposite: the status note tells the parent the output "may
 * be partial", and the verifier's structural gate declines to check the answer at
 * all. `ceilingReached` is kept separate and still arms the grace-turn abort, so
 * a one-turn run that keeps calling tools is still hard-aborted — and reports
 * `aborted`, which is true. See V6 in
 * `context/design/subagents-loop-verifier-shapes.md`.
 */

/** See the header: a subagent always has a turn ceiling, even when nothing set one. */
export const DEFAULT_MAX_TURNS = 40;

/** Normalize max turns. 0 = unlimited, absent = DEFAULT_MAX_TURNS, else min 1. */
export function normalizeMaxTurns(n: number | undefined): number | undefined {
  if (n === 0) return undefined;
  if (n == null) return DEFAULT_MAX_TURNS;
  return Math.max(1, n);
}

/**
 * Whether reaching the soft limit should ask the run to wrap up.
 *
 * False for a one-turn budget — there is no wrap-up to ask for, and asking
 * manufactures a turn. Exported so the test asserts on the decision rather than
 * on a side effect of it.
 */
export function shouldSteerAtSoftLimit(maxTurns: number): boolean {
  return maxTurns > 1;
}

/** The slice of AgentSession the ceiling needs. Duck-typed so this module imports nothing. */
export interface TurnTrackedSession {
  subscribe(listener: (event: { type: string }) => void): () => void;
  steer(text: string): Promise<unknown>;
  abort(): Promise<unknown>;
}

export interface TurnTrackingOptions {
  maxTurns?: number;
  /** Turns allowed after the soft limit before the hard abort. Required: the default lives in config-io. */
  graceTurns: number;
  onTurnEnd?: (turnCount: number) => void;
}

export const TURN_LIMIT_STEER =
  "You have reached your turn limit. Wrap up immediately — provide your final answer now.";

export function wireTurnTracking(session: TurnTrackedSession, options: TurnTrackingOptions) {
  let turnCount = 0;
  const maxTurns = normalizeMaxTurns(options.maxTurns);
  /**
   * The ceiling has been reached. Arms the grace-turn abort below, and nothing
   * else.
   */
  let ceilingReached = false;
  /**
   * The run was cut short of what it was doing — which is what the two readers
   * of this flag mean by it: `status-note.ts` appends "wrapped up at the turn
   * limit — output may be partial" to the text the PARENT MODEL reads, and
   * `verify.ts`'s structural gate refuses to judge the answer at all
   * (`worthJudging: false`, `skip: "cutoff"`).
   *
   * Forge fork: this used to be the same variable as `ceilingReached`, so a
   * `maxTurns: 1` run reported it on the turn it FINISHED. T1 established that a
   * one-turn budget is a different shape — `shouldSteerAtSoftLimit(1)` is false
   * because "there is no wrap-up to ask for, and asking manufactures a turn" —
   * and the flag on the line above was left agreeing with the long case. Every
   * other run that reports this was asked to wrap up; a one-turn run reaches its
   * ceiling by answering.
   *
   * The cost was two-sided and silent: a deliberately one-turn agent (a
   * classifier, a summariser) had every answer labelled possibly-partial to its
   * parent AND was never verified, which is the one distinction the verifier
   * exists to draw. Reachable through `max_turns:` in an agent .md, the /agents
   * spawn wizard's "Max turns" field, and `defaultMaxTurns` in the model-family
   * config. See V6 in `context/design/subagents-loop-verifier-shapes.md`.
   */
  let turnLimited = false;
  let aborted = false;
  const graceTurns = options.graceTurns;

  const unsubscribe = session.subscribe((event) => {
    if (event.type !== "turn_end") return;
    turnCount++;
    options.onTurnEnd?.(turnCount);
    if (maxTurns == null) return;
    if (!ceilingReached && turnCount >= maxTurns) {
      ceilingReached = true;
      if (graceTurns <= 0) {
        // No grace turns means no grace turns. The two branches here are `if` /
        // `else if`, so the turn that REACHES the ceiling can never also abort on
        // it — which meant `graceTurns: 0` did not remove the grace turn, it
        // bought one anyway: the wrap-up steer ran a further turn and the abort
        // landed at the end of it. Severing here is what makes the setting mean
        // what it says. The /agents spawn-options menu accepts 0, so this is
        // reachable.
        //
        // Forge fork: except for a ONE-TURN budget, which reaches its ceiling by
        // FINISHING. That is the whole of T1's argument and of V6's — see the
        // header — and this branch was left agreeing with the long case, in the
        // strongest terms available: `aborted` outranks `turnLimited` in
        // `classifyRun`, so with grace turns off a classifier that answered in
        // one turn went to its parent as "hit the turn limit before completion;
        // output may be incomplete" AND was never verified. V6's repair, undone
        // by a supported setting.
        //
        // Nothing loses its ceiling. `ceilingReached` is set either way, so a
        // one-turn run that keeps calling tools is severed by the `else if`
        // below on its very next turn — at `maxTurns + 0` — and reports
        // `aborted`, which is then true. See W4 in
        // `context/design/subagents-loop-verifier-readers.md`.
        if (shouldSteerAtSoftLimit(maxTurns)) {
          aborted = true;
          void session.abort().catch(() => {});
        }
        return;
      }
      // steer() returns a promise and fires from a subscribe callback: a
      // rejection would escape the run. It only costs the graceful wrap-up;
      // the hard abort below still fires.
      //
      // The steer and the flag are set together on purpose: "this run was cut
      // short" and "this run is being asked to stop early" are the same fact, and
      // they are true under exactly the same condition.
      if (shouldSteerAtSoftLimit(maxTurns)) {
        turnLimited = true;
        void session.steer(TURN_LIMIT_STEER).catch(() => {});
      }
    } else if (ceilingReached && turnCount >= maxTurns + graceTurns) {
      aborted = true;
      // `aborted` is already set, so a rejected abort() cannot change the
      // reported outcome — only swallow the rejection.
      void session.abort().catch(() => {});
    }
  });

  return { unsubscribe, getAborted: () => aborted, getTurnLimited: () => turnLimited };
}
