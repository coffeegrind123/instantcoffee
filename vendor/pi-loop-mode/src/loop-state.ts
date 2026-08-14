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
  interventionCount: number;
  consecutiveErrorCount: number;
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
    interventionCount: 0,
    consecutiveErrorCount: 0,
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

export function persistedLoopState(state: LoopState): LoopState {
  return {
    ...state,
    lastAssistantFingerprints: state.lastAssistantFingerprints.slice(-8),
    lastAssistantSnippets: state.lastAssistantSnippets.slice(-5),
    lastAssistantTexts: state.lastAssistantTexts.slice(-3),
    recentToolResults: state.recentToolResults.slice(-10),
  };
}
