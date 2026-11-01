/**
 * thinking-resolution.ts — The thinking precedence chain, ported from upstream
 * 1.17.1 (src/models/thinking-resolution.ts) without its display half.
 *
 *   explicit spawn choice > agent frontmatter > pi per-model level
 *     > subagents defaultThinking > pi's own default
 *
 * Per-model sits above defaultThinking by design: defaultThinking exists to
 * override pi's GLOBAL default, not an operator's per-model choice. pi only
 * consults its per-model table when no level is passed to createAgentSession
 * (sdk.js), so anything handed over as the explicit level shadows it — which is
 * how defaultThinking used to win.
 *
 * Any configurable position may hold `parent`: the parent session's current
 * level (`ctx.thinkingLevel`). With no parent level available a source holding
 * `parent` reads as unwritten and the chain continues.
 *
 * Pure: no store, no file I/O, no pi imports.
 */

import type { ThinkingLevel } from "../types.js";
import { VALID_THINKING_LEVELS } from "../utils.js";

/** The value that makes a source follow the parent session's current level. */
export const PARENT_THINKING_CHOICE = "parent";

/** A configured thinking value: a concrete level, or `parent`. */
export type ThinkingChoice = ThinkingLevel | typeof PARENT_THINKING_CHOICE;

/** Validate and narrow a raw string to a ThinkingChoice; undefined if invalid. */
export function parseThinkingChoice(raw: string | undefined): ThinkingChoice | undefined {
  if (raw === PARENT_THINKING_CHOICE) return raw;
  if (raw === undefined) return undefined;
  return VALID_THINKING_LEVELS.includes(raw as ThinkingLevel) ? (raw as ThinkingLevel) : undefined;
}

/** The inputs of the chain, in precedence order. Absent = source unset. */
export interface ThinkingLevelSources {
  explicit?: ThinkingChoice;
  frontmatter?: ThinkingChoice;
  /** pi's own per-model setting; pi validates it, so it holds concrete levels only. */
  perModel?: ThinkingLevel;
  defaultThinking?: ThinkingChoice;
  /** The parent session's current level, for a source holding `parent`. */
  parentLevel?: ThinkingLevel;
}

function resolveValue(value: ThinkingChoice | undefined, parentLevel: ThinkingLevel | undefined) {
  return value === PARENT_THINKING_CHOICE ? parentLevel : value;
}

/** The first source holding a level in precedence order; undefined = leave it to pi. */
export function resolveThinkingLevel(sources: ThinkingLevelSources): ThinkingLevel | undefined {
  const { parentLevel } = sources;
  return (
    resolveValue(sources.explicit, parentLevel) ??
    resolveValue(sources.frontmatter, parentLevel) ??
    sources.perModel ??
    resolveValue(sources.defaultThinking, parentLevel)
  );
}
