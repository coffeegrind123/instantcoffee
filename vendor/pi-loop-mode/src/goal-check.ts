import type { LoopState } from "./loop-state.ts";

export interface CheckOutcome {
  passed: boolean;
  score?: number;
  output: string;
  execFailed: boolean;
}

/** Updates check state; returns true when the score regressed vs. the previous run. */
export function applyCheckOutcome(state: LoopState, outcome: CheckOutcome): boolean {
  const previousScore = state.lastCheckScore;
  state.lastCheckPassed = outcome.passed;
  state.lastCheckOutput = outcome.output;
  state.checkFailStreak = outcome.passed ? 0 : state.checkFailStreak + 1;
  if (outcome.score !== undefined) {
    state.lastCheckScore = outcome.score;
    if (state.bestCheckScore === undefined || outcome.score > state.bestCheckScore) {
      state.bestCheckScore = outcome.score;
      state.bestScoreIteration = state.iterationCount;
      state.lastStateChangeIteration = state.iterationCount;
    }
  }
  return outcome.score !== undefined && previousScore !== undefined && outcome.score < previousScore;
}
