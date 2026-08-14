import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import type { LoopState } from "./loop-state.ts";

export const CONTEXT_PRESSURE_PERCENT = 85;
export const LOW_OUTPUT_LENGTH_TOKENS = 32;
export const MAX_EMERGENCY_SUMMARY_CHARS = 24_000;

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
  return lowOutputLength || saturatedLength || contextLikeError || explicitOverflow;
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

export function buildEmergencyCompaction(
  state: LoopState,
  preparation: EmergencyPreparation,
  cwd: string,
  compressionLevel = 0,
): EmergencyCompactionResult {
  const summaryChars = budget(SUMMARY_CHAR_BUDGETS, compressionLevel);
  const fileListEntries = budget(FILE_LIST_BUDGETS, compressionLevel);
  const excerptChars = budget(FILE_EXCERPT_CHAR_BUDGETS, compressionLevel);

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
  const finalDirection =
    "\n\n## Next Step\nRe-establish bearings from the working tree: inspect git status and recent git history, read the durable files above, then perform exactly one concrete next progress batch.";
  const body = `## Goal
${bounded(state.description || "No saved loop goal.", budget(GOAL_CHAR_BUDGETS, compressionLevel))}

## Completion Criteria
${bounded(
  state.completionCriteria || "Continuous improvement until the operator stops the loop.",
  budget(CRITERIA_CHAR_BUDGETS, compressionLevel),
)}

## Loop State
- Iteration: ${state.iterationCount}
- Status before recovery: ${state.status}
- Last check passed: ${state.lastCheckPassed ?? "unknown"}
- Last check score: ${state.lastCheckScore ?? "unknown"}
- Last notice: ${bounded(state.lastNotice || "none", budget(NOTICE_CHAR_BUDGETS, compressionLevel))}

## Durable Project Context
${fileContext}

## File Operations
${files}`;
  const summary = `${body.slice(0, Math.max(0, summaryChars - finalDirection.length))}${finalDirection}`;

  return {
    summary,
    firstKeptEntryId: preparation.firstKeptEntryId,
    tokensBefore: preparation.tokensBefore,
    details: { readFiles, modifiedFiles },
  };
}
