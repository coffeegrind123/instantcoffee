/**
 * compaction-lock.ts — the fourth copy of the protocol, and the first one that
 * takes the lock on pi's OWN behalf.
 *
 * Forge fork, twenty-second pass (AM2).
 *
 * ## The bound this closes
 *
 * The lock was added in the fifteenth pass because two extensions can call
 * `ExtensionContext.compact()` on the same session and pi's `compact()` does not
 * refuse a second call. Three readers were then built on it, each with the same
 * sentence in its header — *"is somebody compacting this session right now?"*:
 *
 * ```
 *   pi-subagents-lite  SpawnCoordinator.emitIndividualNudge   AH1, 17th pass
 *   pi-loop-mode       sendLoopTurn                           AG2, 16th pass
 *   prinny-channel     the empty-turn continuation            AG3, 16th pass
 * ```
 *
 * All three could only ever see **two of the three things that compact this
 * session**, and the third is pi. The handoff has recorded it as open for seven
 * passes, in these words:
 *
 * > **One bound, unchanged for seven passes:** the compaction lock can only be
 * > read for compactions an *extension* asked for. pi emits `compaction_start`
 * > internally (`agent-session.js:1370`) but not as an `ExtensionEvent`.
 *
 * That sentence is true about `compaction_start`, and it is the wrong event.
 * `session_before_compact` **is** an `ExtensionEvent`, and pi emits it from both
 * of its compaction entry points — `compact()` at `agent-session.js:1389` and
 * `_runAutoCompaction()` at `:1613` — for every reason there is (`manual`,
 * `threshold`, `overflow`), whenever any extension has a handler for it. Two in
 * this stack do. So the START of every pi compaction has been observable all
 * along; only the END is awkward, and the lock already carries a bound for that.
 *
 * ## Which window is actually dangerous, measured against pi 0.84.2
 *
 * pi calls `_checkCompaction()` from exactly two places, and they are not
 * equally exposed:
 *
 * ```
 *   _handlePostAgentRun()   :776   inside _runAgentPrompt's while loop, so
 *                                  _isAgentRunActive is still TRUE. A sender's
 *                                  sendCustomMessage(triggerTurn) therefore
 *                                  takes the isStreaming branch (:1080) and
 *                                  QUEUES. Safe by accident, and safe.
 *
 *   prompt()                :865   after the isStreaming branch has already
 *                                  returned, so _isAgentRunActive is FALSE.
 *                                  sendCustomMessage then takes :1088
 *                                  `await this._runAgentPrompt(appMessage)`,
 *                                  which checks NOTHING.               ← here
 * ```
 *
 * The second is not exotic on this stack. `prompt()` is what an operator's typed
 * message reaches, and what `prinny-channel`'s `sendUserMessage` reaches — so a
 * Matrix message arriving on a session over the compaction threshold opens a
 * multi-second window in which the session reads as idle, the lock reads as
 * free, and any of the three senders above will start a whole agent run inside
 * the compaction. What that costs is written out in
 * `vendor/pi-subagents-lite/src/spawn/compaction-lock.ts` and is the reason all
 * three ask:
 *
 *   - the run is built from `createContextSnapshot()`, a copy of the
 *     PRE-compaction messages — the oversized ones the compaction exists to
 *     shrink — and the compaction finishing does not change it;
 *   - `compact()` ends `this.agent.state.messages = sessionContext.messages`,
 *     replacing the array underneath a run that is streaming into it;
 *   - two model calls on a one-slot llama server, one of them the summariser.
 *
 * ## Why the guard is the one that takes it
 *
 * It is the only extension in this stack that is loaded in **every** session
 * regardless of what else is enabled, and compaction is the whole of what it is
 * for. `pi-loop-mode` has a `session_before_compact` handler too, but a loop is
 * not always running and the loop's own handlers are inert inside a subagent
 * spawn, which is a different question from the one below.
 *
 * ## The one thing that has to be got right: a CHILD's compaction
 *
 * The lock is process-global and the question it answers is per-SESSION. That
 * has never mattered, because the two packages that take it — the loop and
 * prinny — both register nothing at all inside a subagent's session. **This
 * extension does**: `.pi/extensions/**` is on a child's discovery route, which
 * is deliberate (it is how a child's own tool output gets capped).
 *
 * A subagent's session compacts — `AgentRecord.stats.compactionCount` counts it
 * and the task anchor fires on it — and a child's compaction must not hold back
 * the PARENT's loop turns and delegation results. So the take is gated on the
 * factory-time answer to "am I a child's instance", which is the same question,
 * asked the same way, that `vendor/pi-loop-mode` and `.pi/extensions/stack.ts`
 * both ask before registering anything at all.
 *
 * ## Why the release is three events and not one
 *
 * `session_compact` fires only on the SUCCESS path — `compact()` emits it at
 * `:1441` after `appendCompaction`, and the catch below emits nothing. A
 * compaction that is cancelled (the operator's Esc reaches
 * `session.abortCompaction()` via `interactive-mode.js:2703`), or that fails on
 * the summariser, therefore has no closing extension event at all.
 *
 * Left at that, the hold would fall through to `STALE_MS` — five minutes of an
 * unattended loop deferring every turn because one compaction was cancelled,
 * which is worse than the collision. So `agent_start` and `agent_settled`
 * release it too. Both are strictly after any compaction pi can run:
 * the post-run one completes inside `_runAgentPrompt`'s `while` before
 * `_emitAgentSettled`, and the pre-prompt one completes before `agent.prompt()`
 * emits `agent_start`.
 *
 * ## The protocol
 *
 * Unchanged, and asserted to agree with the other three by
 * `vendor/pi-loop-mode/tests/compaction-lock.test.ts`, which imports all four.
 * A cross-package import would be the alternative and is the thing the whole
 * arrangement exists to avoid — see that file's header, and `shell.ts`'s
 * `__PI_SUBAGENT_SPAWN_DEPTH__`, which is the same trade.
 */

/** The one key all four implementations agree on. Changing it is a protocol change. */
export const COMPACTION_LOCK_KEY = "__PI_COMPACTION_IN_FLIGHT__";

/**
 * How long a holder may go unreleased before it is treated as absent.
 *
 * Five minutes, the same number in all four copies. A latched lock is worse than
 * the collision it prevents. For THIS owner it is a second backstop rather than
 * the first: the three release events above are the first.
 */
export const STALE_MS = 300_000;

/**
 * This owner's name in the lock.
 *
 * Deliberately the host's name and not this extension's: the compaction being
 * held is pi's, the guard is only the thing that noticed, and the sentence every
 * reader prints is `${holder.owner} is compacting`. "compaction-guard is
 * compacting" would name the wrong actor to an operator reading a notice.
 */
export const PI_OWNER = "pi";

export interface CompactionHolder {
  owner: string;
  at: number;
}

function slot(): Record<string, unknown> {
  return globalThis as unknown as Record<string, unknown>;
}

function read(now: number): CompactionHolder | undefined {
  const value = slot()[COMPACTION_LOCK_KEY] as CompactionHolder | undefined;
  if (!value || typeof value !== "object") return undefined;
  if (typeof value.owner !== "string" || typeof value.at !== "number") return undefined;
  // A holder past the bound is not a holder. Read as absent rather than cleared:
  // clearing here would race the owner's own `endCompaction`, and the owner
  // check in `endCompaction` already makes a late release harmless.
  if (now - value.at >= STALE_MS) return undefined;
  return value;
}

/** Who is compacting right now, or undefined. `now` is injectable for tests. */
export function compactionInFlight(now: number = Date.now()): CompactionHolder | undefined {
  return read(now);
}

/**
 * Take the lock, or report that somebody else has it.
 *
 * Re-entrant for the same owner. It matters here more than in the other copies:
 * a compaction an EXTENSION asked for also emits `session_before_compact`, so
 * this is called while `pi-loop-mode` or `prinny-channel` holds it — and the
 * right answer is to leave their hold alone and take nothing, which is what
 * `false` means and what `endCompaction` then declines to undo.
 */
export function beginCompaction(owner: string, now: number = Date.now()): boolean {
  const held = read(now);
  if (held && held.owner !== owner) return false;
  slot()[COMPACTION_LOCK_KEY] = { owner, at: now };
  return true;
}

/** Release the lock, if this owner holds it. Safe to call on every path. */
export function endCompaction(owner: string, now: number = Date.now()): void {
  const held = read(now);
  if (held && held.owner !== owner) return;
  slot()[COMPACTION_LOCK_KEY] = undefined;
}

/** Drop the lock whatever state it is in. For tests, and for a session teardown. */
export function resetCompactionLock(): void {
  slot()[COMPACTION_LOCK_KEY] = undefined;
}
