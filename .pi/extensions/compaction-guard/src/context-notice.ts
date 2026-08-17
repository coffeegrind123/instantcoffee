/**
 * Tell the model how much context it has left, in any session.
 *
 * pi renders context usage in its footer and nowhere else, so the model works
 * blind: it cannot know that the file it is about to read will not fit, and it
 * cannot decide to wrap up. On this stack that is not a graceful degradation but
 * a cliff, counted over 259 real assistant turns in `~/.pi/agent/sessions`:
 *
 *   context <  87% of the window  →   3 empty assistant turns out of 196  (1.5%)
 *   context >= 87% of the window  →  33 empty assistant turns out of  63  (52%)
 *
 * An empty turn is `content: []`, `stopReason: "stop"`, one output token — a
 * clean success as far as pi is concerned, and a wasted round trip to the user.
 *
 * That cliff is a property of the model and the window, not of `/loop`, so the
 * notice belongs in every session rather than only in a loop. This is the
 * generic sibling of `vendor/pi-loop-mode/src/context-budget.ts`: same measured
 * thresholds, wording with no loop vocabulary in it — no iteration count, no
 * `PROGRESS.md`, nothing about a run that is going to continue without the user.
 *
 * The notice is aimed BELOW the cliff on purpose. A warning delivered at 90%
 * arrives in the regime where the model most often says nothing at all, so it
 * starts at 60% while there is still room to act on it.
 *
 * Cost and safety: nothing is added below 60%, and above it the notice is a
 * single line of roughly 40 tokens. It is appended LAST so llama.cpp's cached
 * prefix is untouched and only the notice is re-prefilled. It never reaches the
 * session either — pi's `emitContext()` does `structuredClone(messages)` before
 * handlers run, so a `context` handler cannot write to history and the notice
 * cannot compound across turns.
 */

/** Percent of the window above which the model is told how much room is left. */
export const NOTICE_PERCENT = 60;

/** Percent above which the notice stops advising and starts forbidding large-output tool calls. */
export const CRITICAL_PERCENT = 80;

/**
 * customType of the injected message. Ephemeral — never persisted.
 *
 * The suffix matters: `vendor/pi-loop-mode` injects its own loop-flavoured
 * budget line as `loop-context-budget`, and both extensions are loaded in a
 * forge session. Whichever runs second recognises the other by the shared
 * `-context-budget` suffix and stays out, so the model never sees two.
 */
export const NOTICE_MESSAGE_TYPE = "compaction-guard-context-budget";

/** Matches this notice and the loop's, so the two can never both be appended. */
export const ANY_BUDGET_TYPE = /-context-budget$/;

export interface ContextUsageLike {
  /** null right after a compaction, before the next assistant response reports real usage. */
  tokens?: number | null;
  contextWindow?: number;
  percent?: number | null;
}

function formatTokens(tokens: number): string {
  if (tokens < 1_000) return String(Math.max(0, Math.round(tokens)));
  return `${(tokens / 1_000).toFixed(1)}k`;
}

/**
 * The one-line budget the model sees, or undefined when there is nothing worth
 * saying: usage is unknown (which is the case right after a compaction), the
 * window is unknown, or there is still plenty of room.
 */
export function contextNoticeText(usage: ContextUsageLike | undefined): string | undefined {
  const window = usage?.contextWindow ?? 0;
  const tokens = usage?.tokens ?? null;
  if (!usage || window <= 0 || tokens === null || tokens < 0) return undefined;
  const percent = usage.percent ?? (tokens / window) * 100;
  if (!Number.isFinite(percent) || percent < NOTICE_PERCENT) return undefined;

  const left = Math.max(0, window - tokens);
  const head = `[context budget] ${formatTokens(left)} of ${formatTokens(window)} tokens left (${Math.round(percent)}% used).`;
  if (percent >= CRITICAL_PERCENT) {
    return (
      `${head} CRITICAL — the context is about to be compacted, and older messages will be replaced ` +
      `by a summary. Do not read whole files or run commands with large output this turn. Finish or ` +
      `report the current step now, and put anything that must survive into a file or your reply.`
    );
  }
  return (
    `${head} Wrap up the current unit of work rather than starting a large one. Prefer targeted tool ` +
    `calls (a grep, a line range) over reading whole files, since the older part of this conversation ` +
    `will be summarised away once the window fills.`
  );
}

/**
 * The notice as a message to append for ONE model call.
 *
 * `role: "custom"` is the right shape: pi's `convertToLlm()` turns it into a
 * user message, and `display: false` keeps it out of the transcript the user
 * reads.
 */
export function contextNoticeMessage(usage: ContextUsageLike | undefined): unknown | undefined {
  const text = contextNoticeText(usage);
  if (!text) return undefined;
  return {
    role: "custom",
    customType: NOTICE_MESSAGE_TYPE,
    content: [{ type: "text", text }],
    display: false,
    timestamp: Date.now(),
  };
}

/** True when some extension (this one, or the loop's) already put a budget line in this context. */
export function hasBudgetMessage(messages: readonly unknown[]): boolean {
  return messages.some((message) => {
    const customType = (message as { customType?: unknown } | null)?.customType;
    return typeof customType === "string" && ANY_BUDGET_TYPE.test(customType);
  });
}
