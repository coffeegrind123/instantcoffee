import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { CONTEXT_STARVATION_PERCENT } from "./context-budget.ts";
import type { LoopState } from "./loop-state.ts";

export const CONTEXT_PRESSURE_PERCENT = 85;
export const LOW_OUTPUT_LENGTH_TOKENS = 32;
export const MAX_EMERGENCY_SUMMARY_CHARS = 24_000;

/**
 * Context windows at or below this get a locally-built handoff summary for ordinary threshold
 * compactions too, not just for overflow recovery. Above it, pi's model-written summary is better
 * and there is room to pay for it.
 *
 * Why the split exists at all, measured against pi 0.84.2's defaults (reserveTokens 16384,
 * keepRecentTokens 20000) on a 32768-token window:
 *
 *   - `shouldCompact()` turns true at 50% of the window, but `prepareCompaction()` returns
 *     undefined until the context exceeds keepRecentTokens — so from 50% to ~66% pi decides to
 *     compact on every turn and silently does nothing.
 *   - When it does fire it keeps keepRecentTokens (61% of this window) plus the new summary, so
 *     the floor after a compaction is higher than the cliff the model starts failing at.
 *   - `reserveTokens` doubles as the summarizer's own maxTokens (`min(0.8 * reserve, maxTokens)`),
 *     and the summary is merged into the previous one every time. Observed growth across one run:
 *     1,666 → 11,054 chars, at which point compaction freed nothing at all and the session sat at
 *     94–96% full permanently.
 *
 * A bounded, locally-built summary fixes all three: it does not grow, it costs no model call on a
 * context the model has already shown it cannot handle, and it picks its own cut point.
 */
export const HANDOFF_MAX_WINDOW_TOKENS = 65_536;

/**
 * Budgets per compression level. Level 0 is the normal emergency summary; each further level is
 * used after a recovery that did not free enough room, so the next summary is materially smaller
 * instead of reproducing the same saturated context.
 */
const SUMMARY_CHAR_BUDGETS = [MAX_EMERGENCY_SUMMARY_CHARS, 8_000, 3_000];
const FILE_EXCERPT_CHAR_BUDGETS = [4_000, 1_200, 0];
const GOAL_CHAR_BUDGETS = [4_000, 1_500, 600];
const CRITERIA_CHAR_BUDGETS = [2_000, 800, 400];
const NOTICE_CHAR_BUDGETS = [1_000, 400, 200];
const FILE_LIST_BUDGETS = [100, 25, 0];

/** Highest compression level the budgets above define. */
export const MAX_COMPRESSION_LEVEL = SUMMARY_CHAR_BUDGETS.length - 1;

/**
 * Budgets for a handoff. Level 0 is the routine one — roughly 1k tokens, or 3% of a 32k window,
 * and the same size on iteration 400 as on iteration 4, because a summary that grew with every
 * compaction is the exact failure this replaces. The tighter levels are reused from the recovery
 * ladder for a handoff that did not free enough room.
 */
const HANDOFF_SUMMARY_CHAR_BUDGETS = [4_000, 2_000, 1_000];
const HANDOFF_EXCERPT_CHAR_BUDGETS = [1_200, 400, 0];
const HANDOFF_GOAL_CHAR_BUDGETS = [1_500, 800, 600];
const HANDOFF_CRITERIA_CHAR_BUDGETS = [800, 400, 300];
const HANDOFF_NOTICE_CHAR_BUDGETS = [400, 200, 120];
const HANDOFF_FILE_LIST_BUDGETS = [25, 10, 0];

/**
 * Entries kept after a handoff cut must fit this, or the cut falls back to keeping a single
 * message. One oversized turn (a tool result that dumped a file) is exactly what saturated the
 * context, and keeping it would hand the next context the same problem.
 */
const HANDOFF_MAX_KEPT_CHARS = 8_000;

interface SummaryBudgets {
  summaryChars: number;
  excerptChars: number;
  goalChars: number;
  criteriaChars: number;
  noticeChars: number;
  fileListEntries: number;
}

/**
 * Errors pi raises when a compaction is not possible because the context is ALREADY as small as
 * this session can make it — the branch ends in a compaction entry, or there is nothing left to
 * summarize. Both mean "no work to do", not "recovery failed": pi's own overflow auto-compaction
 * routinely wins this race, and treating its success as our failure is what used to strand a loop.
 */
const BENIGN_COMPACTION_ERROR = /already compacted|nothing to compact/i;

/** Provider wording that names a context overflow outright, whatever the local usage estimate says. */
const EXPLICIT_OVERFLOW_ERROR =
  /(?:context (?:length|window|size)|context_length_exceeded|too many tokens|exceeds? (?:the )?(?:model'?s? )?(?:maximum )?context|maximum context|prompt is too long|n_ctx)/i;

export function isBenignCompactionError(message: string): boolean {
  return BENIGN_COMPACTION_ERROR.test(message);
}

/**
 * True when the branch already ends in a compaction entry. pi's `prepareCompaction()` refuses to
 * compact in that state ("Already compacted"), so asking for one is a guaranteed error.
 */
export function branchEndsInCompaction(entries: readonly unknown[]): boolean {
  const last = entries.length > 0 ? (entries[entries.length - 1] as { type?: string } | null) : undefined;
  return Boolean(last) && last?.type === "compaction";
}

function budget(budgets: readonly number[], level: number): number {
  const index = Math.min(Math.max(Math.trunc(level) || 0, 0), budgets.length - 1);
  return budgets[index];
}

export interface ContextPressureInput {
  stopReason?: string;
  errorMessage?: string;
  outputTokens?: number;
  contextPercent?: number | null;
  /** True when the assistant produced no visible text, no thinking, and no tool call at all. */
  emptyResponse?: boolean;
}

export interface EmergencyFileOperations {
  read: Set<string>;
  written: Set<string>;
  edited: Set<string>;
}

export interface EmergencyPreparation {
  firstKeptEntryId: string;
  tokensBefore: number;
  fileOps: EmergencyFileOperations;
}

export interface EmergencyCompactionResult {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  details: {
    readFiles: string[];
    modifiedFiles: string[];
  };
}

export function isContextPressure(input: ContextPressureInput): boolean {
  const percent = input.contextPercent ?? 0;
  const message = input.errorMessage ?? "";
  const lowOutputLength =
    input.stopReason === "length" && (input.outputTokens ?? Number.POSITIVE_INFINITY) <= LOW_OUTPUT_LENGTH_TOKENS;
  const saturatedLength = input.stopReason === "length" && percent >= CONTEXT_PRESSURE_PERCENT;
  const contextLikeError =
    input.stopReason === "error" &&
    /(?:\b400\b|context|token|length|maximum output)/i.test(message) &&
    percent >= CONTEXT_PRESSURE_PERCENT;
  // An overflow the provider names outright is context pressure whatever the local estimate says.
  // The estimate is null right after a compaction and 0 before the first usage report, and a real
  // overflow routed to the generic retry path would back off forever against a context that can
  // never fit.
  const explicitOverflow = input.stopReason === "error" && EXPLICIT_OVERFLOW_ERROR.test(message);
  // A clean "stop" with nothing in it, on a context that is nearly full. pi sees a successful turn
  // and the loop's stuck ladder sees fixation, so the response is to inject MORE prompt text into
  // the context that caused it — measured on this stack as a 5-turn run of empty responses, each
  // answered with a longer scolding, until a compaction finally arrived and the very next turn did
  // real work. It is context pressure, and it belongs on the recovery path.
  const starvedTurn =
    input.stopReason === "stop" && input.emptyResponse === true && percent >= CONTEXT_STARVATION_PERCENT;
  return lowOutputLength || saturatedLength || contextLikeError || explicitOverflow || starvedTurn;
}

function bounded(value: unknown, maxChars: number): string {
  const text = String(value ?? "").trim();
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n[truncated]`;
}

function readDurableFile(cwd: string, file: string, maxChars: number): string | undefined {
  if (maxChars <= 0) return undefined;
  try {
    const path = isAbsolute(file) ? file : join(cwd, file);
    const text = readFileSync(path, "utf8").trim();
    return text ? bounded(text, maxChars) : undefined;
  } catch {
    return undefined;
  }
}

function buildSummary(
  state: LoopState,
  preparation: EmergencyPreparation,
  cwd: string,
  budgets: SummaryBudgets,
  finalDirection: string,
): EmergencyCompactionResult["details"] & { summary: string } {
  const { summaryChars, fileListEntries, excerptChars } = budgets;

  const allModifiedFiles = new Set([...preparation.fileOps.written, ...preparation.fileOps.edited]);
  const modifiedFiles = [...allModifiedFiles].sort().slice(0, fileListEntries);
  const readFiles = [...preparation.fileOps.read]
    .filter((file) => !allModifiedFiles.has(file))
    .sort()
    .slice(0, fileListEntries);

  const durableSections = [...new Set([state.goalFile || "GOAL.md", "PROGRESS.md", "IMPROVEMENTS.md", "ASSUMPTIONS.md"])]
    .map((file) => ({ file, text: readDurableFile(cwd, file, excerptChars) }))
    .filter((entry): entry is { file: string; text: string } => Boolean(entry.text))
    .map((entry) => `### ${entry.file}\n${entry.text}`);

  const fileContext =
    durableSections.length > 0
      ? durableSections.join("\n\n")
      : excerptChars > 0
        ? "No durable loop files were readable."
        : "Excerpts omitted to fit the context; read the durable files listed under Goal from disk.";
  const files = [
    readFiles.length > 0 ? `<read-files>\n${readFiles.join("\n")}\n</read-files>` : "<read-files>\n</read-files>",
    modifiedFiles.length > 0
      ? `<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`
      : "<modified-files>\n</modified-files>",
  ].join("\n\n");
  const body = `## Goal
${bounded(state.description || "No saved loop goal.", budgets.goalChars)}

## Completion Criteria
${bounded(state.completionCriteria || "Continuous improvement until the operator stops the loop.", budgets.criteriaChars)}

## Loop State
- Iteration: ${state.iterationCount}
- Status before recovery: ${state.status}
- Last check passed: ${state.lastCheckPassed ?? "unknown"}
- Last check score: ${state.lastCheckScore ?? "unknown"}
- Last notice: ${bounded(state.lastNotice || "none", budgets.noticeChars)}

## Durable Project Context
${fileContext}

## File Operations
${files}`;
  const summary = `${body.slice(0, Math.max(0, summaryChars - finalDirection.length))}${finalDirection}`;

  return { summary, readFiles, modifiedFiles };
}

const RECOVERY_DIRECTION =
  "\n\n## Next Step\nRe-establish bearings from the working tree: inspect git status and recent git history, read the durable files above, then perform exactly one concrete next progress batch.";

const HANDOFF_DIRECTION =
  "\n\n## Next Step\nThis is a handoff: the conversation above was dropped, and everything that survived it is written down here or in the files named above. Do not try to recall it. Re-establish bearings from the working tree (git status, git log, the durable files), then perform exactly one concrete next progress batch and write what you did to PROGRESS.md before the next handoff.";

export function buildEmergencyCompaction(
  state: LoopState,
  preparation: EmergencyPreparation,
  cwd: string,
  compressionLevel = 0,
): EmergencyCompactionResult {
  const { summary, readFiles, modifiedFiles } = buildSummary(
    state,
    preparation,
    cwd,
    {
      summaryChars: budget(SUMMARY_CHAR_BUDGETS, compressionLevel),
      excerptChars: budget(FILE_EXCERPT_CHAR_BUDGETS, compressionLevel),
      goalChars: budget(GOAL_CHAR_BUDGETS, compressionLevel),
      criteriaChars: budget(CRITERIA_CHAR_BUDGETS, compressionLevel),
      noticeChars: budget(NOTICE_CHAR_BUDGETS, compressionLevel),
      fileListEntries: budget(FILE_LIST_BUDGETS, compressionLevel),
    },
    RECOVERY_DIRECTION,
  );

  return {
    summary,
    firstKeptEntryId: preparation.firstKeptEntryId,
    tokensBefore: preparation.tokensBefore,
    details: { readFiles, modifiedFiles },
  };
}

/** A session entry as far as the cut needs to understand one. pi validates nothing on load. */
interface BranchEntryLike {
  type?: string;
  id?: string;
  customType?: string;
  content?: unknown;
  message?: { role?: string; content?: unknown };
}

/** Entries that start a turn, matching pi's own `isTurnStartMessage()` for the roles we can produce. */
function isTurnStart(entry: BranchEntryLike): boolean {
  if (entry.type === "custom_message" || entry.type === "branch_summary" || entry.type === "bash_execution") return true;
  return entry.type === "message" && entry.message?.role === "user";
}

/** A message that is safe to keep on its own, with no preceding tool call to orphan. */
function standsAlone(entry: BranchEntryLike): boolean {
  if (entry.type === "custom_message") return true;
  return entry.type === "message" && (entry.message?.role === "user" || entry.message?.role === "assistant");
}

function entryChars(entry: BranchEntryLike): number {
  if (entry.type === "message") return JSON.stringify(entry.message ?? {}).length;
  if (entry.type === "custom_message") return JSON.stringify(entry.content ?? {}).length;
  return 0;
}

/**
 * Where to cut for a handoff: the start of the last turn, so the summary is followed by one
 * complete, self-consistent exchange rather than by 20k tokens of history pi would have kept.
 *
 * Falls back, in order, to the last message that can stand on its own (when that final turn is
 * itself oversized — the runaway tool result is usually what saturated the context in the first
 * place), and then to pi's own cut point, which is always valid even when it is not tight.
 */
export function findHandoffCutEntryId(branchEntries: readonly unknown[], fallbackEntryId: string): string {
  const entries = branchEntries as readonly BranchEntryLike[];
  let tailChars = 0;
  let newestStandalone: string | undefined;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] ?? {};
    // Everything before an existing compaction is already out of context; do not cut into it.
    if (entry.type === "compaction") break;
    if (entry.id && newestStandalone === undefined && standsAlone(entry)) newestStandalone = entry.id;
    tailChars += entryChars(entry);
    if (entry.id && isTurnStart(entry)) {
      // Older turn starts can only make the tail bigger, so this is the tightest whole turn there is.
      return tailChars <= HANDOFF_MAX_KEPT_CHARS ? entry.id : (newestStandalone ?? fallbackEntryId);
    }
  }
  return newestStandalone ?? fallbackEntryId;
}

/**
 * A routine handoff to a fresh context: a bounded summary that does not grow, and a cut at the last
 * turn instead of at pi's `keepRecentTokens`. Used for threshold compactions on a small window,
 * where pi's own compaction leaves a floor higher than the point at which the model stops
 * answering (see {@link HANDOFF_MAX_WINDOW_TOKENS}).
 */
export function buildHandoffCompaction(
  state: LoopState,
  preparation: EmergencyPreparation,
  cwd: string,
  branchEntries: readonly unknown[] = [],
  compressionLevel = 0,
): EmergencyCompactionResult {
  const { summary, readFiles, modifiedFiles } = buildSummary(
    state,
    preparation,
    cwd,
    {
      summaryChars: budget(HANDOFF_SUMMARY_CHAR_BUDGETS, compressionLevel),
      excerptChars: budget(HANDOFF_EXCERPT_CHAR_BUDGETS, compressionLevel),
      goalChars: budget(HANDOFF_GOAL_CHAR_BUDGETS, compressionLevel),
      criteriaChars: budget(HANDOFF_CRITERIA_CHAR_BUDGETS, compressionLevel),
      noticeChars: budget(HANDOFF_NOTICE_CHAR_BUDGETS, compressionLevel),
      fileListEntries: budget(HANDOFF_FILE_LIST_BUDGETS, compressionLevel),
    },
    HANDOFF_DIRECTION,
  );

  return {
    summary,
    firstKeptEntryId: findHandoffCutEntryId(branchEntries, preparation.firstKeptEntryId),
    tokensBefore: preparation.tokensBefore,
    details: { readFiles, modifiedFiles },
  };
}
