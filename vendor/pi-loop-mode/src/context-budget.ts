/**
 * The context budget, made visible to the model instead of only to the operator.
 *
 * pi renders context usage in its footer and nowhere else, so the model works blind: it cannot
 * know that the file it is about to read will not fit, and it cannot decide to wrap up. Measured on
 * this stack (24 compactions across one 32k Qwen run, `~/.pi/agent/sessions`), the consequence is
 * not a graceful degradation — it is a cliff:
 *
 *   context < 87% of the window   →   3 empty assistant turns out of 196
 *   context >= 87% of the window  →  33 empty assistant turns out of 63
 *
 * A turn above the cliff is a coin flip, and an empty turn still costs a full iteration. The notice
 * below is therefore aimed *below* the cliff: the model is told how much room is left while it can
 * still act on it, and what to do with the remaining room (finish, write state to a file), because
 * a warning delivered at 90% arrives in the regime where the model most often says nothing at all.
 */

/** Percent of the context window above which the model is told how much room is left. */
export const CONTEXT_NOTICE_PERCENT = 60;

/**
 * Percent above which a turn is treated as context-starved rather than as the model misbehaving.
 * The lowest context at which an empty response was observed in the sessions above was 80%.
 */
export const CONTEXT_STARVATION_PERCENT = 80;

/** Percent above which the notice stops advising and starts forbidding expensive tool calls. */
export const CONTEXT_CRITICAL_PERCENT = 80;

/** customType of the ephemeral budget message. Never persisted — it is injected per LLM call. */
export const BUDGET_MESSAGE_TYPE = "loop-context-budget";

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
 * The one-line budget the model sees, or undefined when there is nothing worth saying: usage is
 * unknown (right after a compaction), the window is unknown, or there is still plenty of room.
 */
export function contextBudgetText(usage: ContextUsageLike | undefined): string | undefined {
  const window = usage?.contextWindow ?? 0;
  const tokens = usage?.tokens ?? null;
  if (!usage || window <= 0 || tokens === null || tokens < 0) return undefined;
  const percent = usage.percent ?? (tokens / window) * 100;
  if (percent < CONTEXT_NOTICE_PERCENT) return undefined;

  const left = Math.max(0, window - tokens);
  const head = `[context budget] ${formatTokens(left)} of ${formatTokens(window)} tokens left (${Math.round(percent)}% used).`;
  if (percent >= CONTEXT_CRITICAL_PERCENT) {
    return (
      `${head} CRITICAL — this context is about to be compacted away. Do not read files or run commands ` +
      `with large output this turn. Write the current state and the next concrete step to PROGRESS.md in ` +
      `one edit, then stop.`
    );
  }
  return (
    `${head} Finish the current unit of work this turn and record state in PROGRESS.md — the loop will ` +
    `compact to a fresh context shortly, and anything not written to a file is lost. Prefer small, ` +
    `targeted tool calls over reading whole files.`
  );
}

/**
 * The budget as a message to append to the context for ONE LLM call.
 *
 * A `custom` message is the right shape: pi's `convertToLlm()` turns it into a user message, and
 * appending it last leaves the cached prefix intact, so llama.cpp re-prefills only the notice.
 * It is never written to the session — pi clones the message array before the `context` event
 * (`emitContext()` → `structuredClone`), so nothing here can leak into history and compound.
 */
export function contextBudgetMessage(usage: ContextUsageLike | undefined): unknown | undefined {
  const text = contextBudgetText(usage);
  if (!text) return undefined;
  return {
    role: "custom",
    customType: BUDGET_MESSAGE_TYPE,
    content: [{ type: "text", text }],
    display: false,
    timestamp: Date.now(),
  };
}

/** Short form for the loop status bar, e.g. `ctx 64%`. Undefined while usage is unknown. */
export function contextBudgetStatus(usage: ContextUsageLike | undefined): string | undefined {
  const percent = usage?.percent ?? null;
  if (percent === null || !Number.isFinite(percent)) return undefined;
  return `ctx ${Math.round(percent)}%`;
}
