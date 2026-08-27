export const STATE_ENTRY_TYPE = "loop-state";

export interface ToolSnapshot {
  tool: string;
  fingerprint: string;
  snippet: string;
  isError: boolean;
  time: number;
}

export interface LoopState {
  active: boolean;
  description: string;
  completionCriteria: string;
  startTime: number;
  iterationCount: number;
  maxIterations: number;
  untilDone: boolean;
  delaySeconds: number;
  checkCommand: string;
  checkTimeoutSeconds: number;
  lastCheckPassed?: boolean;
  lastCheckScore?: number;
  bestCheckScore?: number;
  bestScoreIteration: number;
  checkFailStreak: number;
  lastCheckOutput: string;
  /**
   * Consecutive goal checks that could not RUN (pi.exec rejected). Kept apart
   * from `checkFailStreak`, which counts checks that ran and reported failure —
   * see `applyCheckOutcome` for why the two must not be the same number.
   */
  checkErrorStreak: number;
  /** The last exec error, for the operator. Never shown to the model as check output. */
  lastCheckError: string;
  goalFile: string;
  loopModel: string;
  rescueModel: string;
  rescueActive: boolean;
  rescueReturnModel: string;
  penaltyTurnsRemaining: number;
  lastCompactIteration: number;
  preparedAt: number;
  softStopRequested: boolean;
  lastAssistantFingerprints: string[];
  lastAssistantSnippets: string[];
  lastAssistantTexts: string[];
  recentToolResults: ToolSnapshot[];
  turnsWithoutTools: number;
  toolCallsThisTurn: number;
  consecutiveStuckCount: number;
  /**
   * Was the intervention that armed `consecutiveStuckCount` the narration-only
   * rule? The streak is what every rung of the ladder spends, and `interveneStuck`
   * zeroes `turnsWithoutTools` — so the turn AFTER an intervention cannot be
   * stuck under that rule however silent it is, and clearing the streak on any
   * non-stuck turn retired it before it could ever reach rung 2. Measured on a
   * live unattended run: six interventions over 33 iterations, every one of them
   * logged `stuckStreak: 1`, so the hard reset (3), the rescue model (3) and the
   * compaction (5) were unreachable for the whole run. With this flag standing,
   * only a turn that called a tool clears the streak; the repetition rules are
   * unaffected, because a turn that stops repeating is evidence on its own.
   */
  lastStuckWasToolless: boolean;
  interventionCount: number;
  /**
   * Consecutive CONTEXT-pressure turns. Named for history; it is the context
   * ladder's counter and nothing else reads it.
   *
   * Forge fork: the provider-error retry used to share it, so one context event
   * lengthened the next provider backoff and one provider error advanced the
   * context-recovery ladder toward its cooldown. Two mechanisms, two questions,
   * two counters — `providerErrorStreak` is the other one.
   */
  consecutiveErrorCount: number;
  /**
   * Consecutive turns that ended in a MODEL/PROVIDER error, which drives the
   * retry backoff and the terminal state at MAX_PROVIDER_ERRORS.
   */
  providerErrorStreak: number;
  totalErrorCount: number;
  /** Cooldown escalations in the current unrecovered context-pressure streak. */
  contextCooldownCount: number;
  /** Compression level for the next emergency summary; raised when a recovery did not free room. */
  contextCompressionLevel: number;
  /** Context recoveries completed since the loop started (any source, including pi's own). */
  contextRecoveryCount: number;
  doneSignalCount: number;
  blockedSignalCount: number;
  lastStateChangeIteration: number;
  status: "running" | "stuck" | "retrying" | "paused" | "completed" | "stopped" | "preparing";
  lastNotice: string;
}

export function defaultState(): LoopState {
  return {
    active: false,
    description: "",
    completionCriteria: "",
    startTime: 0,
    iterationCount: 0,
    maxIterations: 0,
    untilDone: false,
    delaySeconds: 0,
    checkCommand: "",
    checkTimeoutSeconds: 120,
    bestScoreIteration: 0,
    checkFailStreak: 0,
    lastCheckOutput: "",
    checkErrorStreak: 0,
    lastCheckError: "",
    goalFile: "GOAL.md",
    loopModel: "",
    rescueModel: "",
    rescueActive: false,
    rescueReturnModel: "",
    penaltyTurnsRemaining: 0,
    lastCompactIteration: 0,
    preparedAt: 0,
    softStopRequested: false,
    lastAssistantFingerprints: [],
    lastAssistantSnippets: [],
    lastAssistantTexts: [],
    recentToolResults: [],
    turnsWithoutTools: 0,
    toolCallsThisTurn: 0,
    consecutiveStuckCount: 0,
    lastStuckWasToolless: false,
    interventionCount: 0,
    consecutiveErrorCount: 0,
    providerErrorStreak: 0,
    totalErrorCount: 0,
    contextCooldownCount: 0,
    contextCompressionLevel: 0,
    contextRecoveryCount: 0,
    doneSignalCount: 0,
    blockedSignalCount: 0,
    lastStateChangeIteration: 0,
    status: "stopped",
    lastNotice: "",
  };
}

export function restoreLoopState(entries: readonly unknown[]): LoopState {
  const restored = [...entries]
    .reverse()
    .find(
      (entry) =>
        Boolean(entry) &&
        typeof entry === "object" &&
        (entry as { type?: string }).type === "custom" &&
        (entry as { customType?: string }).customType === STATE_ENTRY_TYPE,
    ) as { data?: Partial<LoopState> } | undefined;
  return { ...defaultState(), ...(restored?.data ?? {}) };
}

/**
 * How much of each rolling window survives a persist, and therefore a restart.
 *
 * These must match the `pushLimited` bounds in `extensions/index.ts`, or a
 * restored loop silently runs with a shorter memory than the one that was
 * persisted. `lastAssistantTexts` was kept to 4 in memory and written at 3, so
 * after every restore the near-duplicate check in `detectStuck` had one fewer
 * response to compare against than it was designed for.
 *
 * `textChars` is the same rule for the OTHER dimension of that window, and it
 * was the one bound in `commitTurnMemory` that did not come from here — a bare
 * `.slice(0, 1_500)`. It bounds how much of each answer is kept, and
 * `detectStuck`'s near-duplicate rule has to cut the current answer to the same
 * length before comparing: `textSimilarity` is Jaccard over word trigrams, so a
 * stored string that is a PREFIX of the current one scores roughly
 * `textChars / length` however identical the two turns were. Measured: a
 * rephrasing that scores 0.86 same-unit scores 0.47 at 2,800 characters, and the
 * threshold is 0.80. See W2 in
 * `context/design/subagents-loop-verifier-readers.md`.
 */
export const PERSISTED_WINDOW = {
  fingerprints: 8,
  snippets: 5,
  texts: 4,
  textChars: 1_500,
  toolResults: 10,
} as const;

export function persistedLoopState(state: LoopState): LoopState {
  return {
    ...state,
    lastAssistantFingerprints: state.lastAssistantFingerprints.slice(-PERSISTED_WINDOW.fingerprints),
    lastAssistantSnippets: state.lastAssistantSnippets.slice(-PERSISTED_WINDOW.snippets),
    lastAssistantTexts: state.lastAssistantTexts.slice(-PERSISTED_WINDOW.texts),
    recentToolResults: state.recentToolResults.slice(-PERSISTED_WINDOW.toolResults),
  };
}
