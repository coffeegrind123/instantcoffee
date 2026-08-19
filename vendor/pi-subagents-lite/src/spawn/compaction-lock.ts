/**
 * compaction-lock.ts — Forge fork. Is somebody compacting this session right now?
 *
 * **This package never takes the lock. It only reads it**, and this file exists
 * because there is one sender in this package that must not fire into somebody
 * else's compaction: `SpawnCoordinator.emitIndividualNudge`, which delivers a
 * finished BACKGROUND subagent's answer to the parent model.
 *
 * ## Why a sender has to ask at all
 *
 * pi has exactly one refusal for "do not start a turn during a compaction", and
 * it is on the entry point none of these extensions use:
 *
 * ```js
 *   //  AgentSession.prompt()                       dist/core/agent-session.js:807
 *   if (this._compactionAbortController !== undefined) {
 *       throw new Error("Cannot submit a prompt while compaction is in progress…");
 *   }
 *
 *   //  AgentSession.sendCustomMessage()                                    :1068
 *   else if (options?.triggerTurn) {
 *       await this._runAgentPrompt(appMessage);   // :1090 — checks NOTHING
 *   }
 * ```
 *
 * `pi.sendMessage(…, { triggerTurn: true })` is `sendCustomMessage`, and during a
 * compaction the session is idle — `compact()`'s first statement is
 * `await this.abort()`, which awaits `waitForIdle()` — so the `_runAgentPrompt`
 * branch is not merely reachable, it is the ONLY branch a nudge can take while a
 * compaction is running.
 *
 * What that costs, measured out of pi 0.84.2's own source rather than assumed:
 *
 *   - `Agent.prompt()` → `runPromptMessages` → `createContextSnapshot()`, which is
 *     `{ messages: this._state.messages.slice() }`. The whole run is built from a
 *     COPY taken at its first instant — the pre-compaction context, i.e. the
 *     oversized one the compaction exists to shrink — and the compaction
 *     finishing does not change it.
 *   - `compact()` ends `this.agent.state.messages = sessionContext.messages`
 *     (`:1434`), replacing the array underneath a run that is streaming into it.
 *   - Two model calls on a one-slot llama server, one of which is the summariser.
 *   - `_runAgentPrompt`'s `finally` emits `agent_settled`, so a whole
 *     `agent_start … agent_end … agent_settled` cycle runs INSIDE the compaction
 *     window and re-enters every handler in the stack.
 *
 * ## Why this one is worse than the two the sixteenth pass fixed
 *
 * `pi-loop-mode`'s `sendLoopTurn` (AG2) and `prinny-channel`'s empty-turn
 * continuation (AG3) are the other two senders, and both now read this lock. Each
 * of them has somewhere to put what it was holding: the loop DEFERS and the same
 * iteration goes five seconds later; prinny HOLDS and tells the sender to ask
 * again. This one is holding a finished delegation's only answer.
 * `emitIndividualNudge` runs once per record — `scheduleNudge` adds the id to a
 * set, the timer drains it — and the record is already settled, its slot
 * released and its gate open. There is no second attempt and nothing else to ask.
 *
 * So the coordinator defers, exactly as the loop does, and for the same reason:
 * the answer is not lost, it arrives late.
 *
 * ## Why a third copy of the protocol
 *
 * Vendor packages must not import each other — the whole reason the lock is a
 * `globalThis` key rather than a shared module, and the same arrangement
 * `shell.ts` uses to publish `__PI_SUBAGENT_SPAWN_DEPTH__` (which
 * `pi-loop-mode` and `.pi/extensions/stack.ts` read without importing this
 * package). `vendor/pi-loop-mode/src/compaction-lock.ts` and
 * `vendor/prinny-channel/src/compaction-lock.ts` are the other two, and the three
 * are asserted to agree by a test in each that imports the others' source.
 *
 * This copy is READ-ONLY on purpose. `beginCompaction`/`endCompaction` are absent
 * because nothing in this package calls `ctx.compact()`, and shipping them would
 * invite a future caller to take a lock this package has no compaction to
 * release.
 */

/** The one key all three implementations agree on. Changing it is a protocol change. */
export const COMPACTION_LOCK_KEY = "__PI_COMPACTION_IN_FLIGHT__";

/**
 * How long a holder may go unreleased before it is treated as absent.
 *
 * Five minutes, and the same number in all three copies. A latched lock is worse
 * than the collision it prevents: without the bound, a holder whose release was
 * lost would hold a finished subagent's answer for the rest of the process.
 */
export const STALE_MS = 300_000;

export interface CompactionHolder {
  owner: string;
  at: number;
}

function slot(): Record<string, unknown> {
  return globalThis as unknown as Record<string, unknown>;
}

/**
 * Who is compacting right now, or undefined. `now` is injectable for tests.
 *
 * Anything in the process can write this key, so a shape this module does not
 * recognise reads as FREE rather than throwing — a malformed global must not be
 * the reason a finished delegation's answer is never delivered.
 */
export function compactionInFlight(now: number = Date.now()): CompactionHolder | undefined {
  const value = slot()[COMPACTION_LOCK_KEY] as CompactionHolder | undefined;
  if (!value || typeof value !== "object") return undefined;
  if (typeof value.owner !== "string" || typeof value.at !== "number") return undefined;
  if (now - value.at >= STALE_MS) return undefined;
  return value;
}
