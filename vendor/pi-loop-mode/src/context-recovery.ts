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
 * True when the branch has nothing to compact because it already ends in a compaction.
 *
 * pi's `prepareCompaction()` returns undefined — surfacing as "Already compacted" — when the
 * branch's LAST entry is a compaction, so asking for one then is a guaranteed error.
 *
 * Forge fork: entries that are not conversation are skipped. This used to test the literal last
 * entry, and the loop appends its own `{type:"custom"}` state entry through `pi.appendEntry()` on
 * roughly thirty-three paths — including `session_compact`'s own handler, which persists
 * immediately after pi finishes compacting. So the branch stopped *ending* in a compaction the
 * moment the loop recorded that one had happened, this guard read false, and the short circuit it
 * exists to provide was lost on exactly the path it was written for.
 *
 * The consequence was mild — pi still refuses ("Nothing to compact (session too small)", which
 * `BENIGN_COMPACTION_ERROR` also matches) and recovery finishes one round trip later — but that
 * round trip runs `AgentSession.compact()`, whose first statement is `await this.abort()`. A guard
 * that is meant to avoid a call should not be defeated by bookkeeping the same module wrote.
 *
 * `custom` and `session_info` entries carry no messages and are invisible to `prepareCompaction`,
 * which is why skipping them asks pi's question rather than a different one.
 */
const NON_CONVERSATION_ENTRY_TYPES = new Set(["custom", "session_info", "label_change"]);

export function branchEndsInCompaction(entries: readonly unknown[]): boolean {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as { type?: string } | null | undefined;
    if (!entry) continue;
    if (NON_CONVERSATION_ENTRY_TYPES.has(String(entry.type))) continue;
    return entry.type === "compaction";
  }
  return false;
}

function budgetIndex(length: number, level: number): number {
  return Math.min(Math.max(Math.trunc(level) || 0, 0), length - 1);
}

function budget(budgets: readonly number[], level: number): number {
  return budgets[budgetIndex(budgets.length, level)];
}

/** The same clamped lookup, for the per-level text blocks. */
function budgetText(texts: readonly string[], level: number): string {
  return texts[budgetIndex(texts.length, level)];
}

export interface ContextPressureInput {
  stopReason?: string;
  errorMessage?: string;
  outputTokens?: number;
  contextPercent?: number | null;
  /**
   * True when the assistant produced no ANSWER: no visible text and no tool call.
   *
   * Forge fork: this used to require "no thinking" as well, which was the same
   * test until `patches/forge_reasoning_passthrough.py` began delivering a
   * reasoning-only turn as `content: [thinking]` rather than `content: []`. A
   * turn that spends its output budget on reasoning and answers nothing is
   * starvation in exactly the way this rung exists for — see the caller in
   * `extensions/index.ts` and V1 in
   * `context/design/subagents-loop-verifier-shapes.md`.
   */
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

/** Appended by `bounded` when it cuts, and charged against the budget by `claim`. */
const TRUNCATION_MARKER = "\n[truncated]";

function bounded(value: unknown, maxChars: number): string {
  const text = String(value ?? "").trim();
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}${TRUNCATION_MARKER}`;
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

/**
 * The least a section may be cut to before it is dropped instead, and the floor
 * each section holds back for the ones after it.
 *
 * Without it the allocation is still positional in one respect: the first
 * section claims up to its own budget, and at the tightest level a per-section
 * budget can exceed the whole body's room — `HANDOFF_GOAL_CHAR_BUDGETS[2]` is
 * 600 against 531 characters of body. A long goal then starves everything after
 * it, which is the failure this repair exists to remove, one level down.
 *
 * 150 characters is a sentence: enough for a section to say something, small
 * enough that reserving four of them costs nothing at level 0, where there are
 * thousands to spare.
 */
const MIN_SECTION_CHARS = 150;

/** Section separator, and the order the sections are READ in. */
const SECTION_SEPARATOR = "\n\n";
const SECTION_ORDER = ["goal", "criteria", "state", "durable", "files"] as const;

/**
 * The order the sections are ALLOCATED budget in, which is not the order they
 * are read in.
 *
 * The per-section budgets do not fit inside the total — measured on the handoff
 * ladder, level 0 has room for 3,531 characters of body while its sections may
 * claim 7,500, and levels 1 and 2 are over by 1,469 and 489. That is not by
 * itself a defect; a summary has to degrade somehow. The defect was that it
 * degraded by position: the whole body was assembled and then cut with a blind
 * `slice()` from the front, so what fell off the end was `## File Operations`
 * first and `## Durable Project Context` next — and the compression levels that
 * cut hardest are reached only after a recovery that did not free enough room,
 * which is exactly when the carried state matters most.
 *
 * `.pi/extensions/compaction-guard/src/summary-budget.ts` exists because pi's
 * summary had the same failure, and says so: a blind slice "keeps `## Goal`
 * while cutting exactly the two sections that carry the work forward, because
 * they are last". This is the same repair applied to the loop's own builder.
 *
 * The order below is by what cannot be recovered any other way:
 *
 *   goal      the objective. Without it the next context is not doing this job.
 *   state     iteration, check status, last notice — a few hundred characters,
 *             and written down nowhere else at all.
 *   criteria  what "done" means. Usually short.
 *   files     what was read and changed. Recoverable from `git status`, but cheap.
 *   durable   the GOAL.md / PROGRESS.md / IMPROVEMENTS.md / ASSUMPTIONS.md
 *             excerpts. By far the largest, and the ONLY section that is also
 *             sitting on disk — the Next Step block the summary ends with
 *             already tells the model to read those files. So it is the section
 *             to shrink, and it now absorbs whatever the others leave rather
 *             than being cut off mid-file by an arithmetic accident.
 *
 * Every section still appears at every level; what changes with the level is how
 * much of the excerpts come with it.
 */
const SECTION_PRIORITY = ["goal", "state", "criteria", "files", "durable"] as const;

type SectionKey = (typeof SECTION_ORDER)[number];

const SECTION_HEADINGS: Record<SectionKey, string> = {
  goal: "## Goal",
  criteria: "## Completion Criteria",
  state: "## Loop State",
  durable: "## Durable Project Context",
  files: "## File Operations",
};

/**
 * The durable-file excerpts, sized to the room actually left for them.
 *
 * `perFileCap` is the level's own budget; `room` is what the other sections did
 * not use. Whichever is smaller wins, shared equally between the files that
 * exist — so a run with one PROGRESS.md gets a long excerpt and a run with four
 * durable files gets four short ones, instead of the first two crowding the
 * others off the end.
 */
function durableExcerpts(cwd: string, goalFile: string, perFileCap: number, room: number): string {
  const candidates = [...new Set([goalFile || "GOAL.md", "PROGRESS.md", "IMPROVEMENTS.md", "ASSUMPTIONS.md"])];
  if (perFileCap <= 0 || room <= 0) {
    return "Excerpts omitted to fit the context; read the durable files listed under Goal from disk.";
  }

  // Which of them exist at all, before deciding how to divide the room.
  const present = candidates
    .map((file) => ({ file, text: readDurableFile(cwd, file, perFileCap) }))
    .filter((entry): entry is { file: string; text: string } => Boolean(entry.text));
  if (present.length === 0) return "No durable loop files were readable.";

  const separators = SECTION_SEPARATOR.length * (present.length - 1);
  const share = Math.floor((room - separators) / present.length);
  const sections = present
    .map((entry) => {
      const heading = `### ${entry.file}\n`;
      const forBody = Math.min(perFileCap, share - heading.length - TRUNCATION_MARKER.length);
      if (forBody <= 0) return undefined;
      return `${heading}${bounded(entry.text, forBody)}`;
    })
    .filter((section): section is string => section !== undefined);

  return sections.length > 0
    ? sections.join(SECTION_SEPARATOR)
    : "Excerpts omitted to fit the context; read the durable files listed under Goal from disk.";
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

  const filesBody = [
    readFiles.length > 0 ? `<read-files>\n${readFiles.join("\n")}\n</read-files>` : "<read-files>\n</read-files>",
    modifiedFiles.length > 0
      ? `<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`
      : "<modified-files>\n</modified-files>",
  ].join("\n\n");

  const stateBody = [
    `- Iteration: ${state.iterationCount}`,
    `- Status before recovery: ${state.status}`,
    `- Last check passed: ${state.lastCheckPassed ?? "unknown"}`,
    `- Last check score: ${state.lastCheckScore ?? "unknown"}`,
    `- Last notice: ${bounded(state.lastNotice || "none", budgets.noticeChars)}`,
  ].join("\n");

  // The direction block is appended after the body, so it is never part of what
  // has to fit — it is subtracted up front instead.
  let left = Math.max(0, summaryChars - finalDirection.length);
  const parts = new Map<SectionKey, string>();

  /**
   * Claim room for one section, truncating it to whatever is still available
   * once the sections after it have been left their floor.
   */
  const claim = (key: SectionKey, body: string, cap: number, sectionsAfter: number): void => {
    const heading = SECTION_HEADINGS[key];
    const overhead = (parts.size > 0 ? SECTION_SEPARATOR.length : 0) + heading.length + 1;
    const reserved = MIN_SECTION_CHARS * sectionsAfter;
    const forBody = Math.min(cap, left - overhead - TRUNCATION_MARKER.length - reserved);
    if (forBody <= 0) return;
    const text = bounded(body, forBody);
    parts.set(key, `${heading}\n${text}`);
    left -= overhead + text.length;
  };

  claim("goal", state.description || "No saved loop goal.", budgets.goalChars, 4);
  claim("state", stateBody, stateBody.length, 3);
  claim(
    "criteria",
    state.completionCriteria || "Continuous improvement until the operator stops the loop.",
    budgets.criteriaChars,
    2,
  );
  claim("files", filesBody, filesBody.length, 1);
  // Last, and it takes everything still unspent — see SECTION_PRIORITY.
  const durableOverhead = (parts.size > 0 ? SECTION_SEPARATOR.length : 0) + SECTION_HEADINGS.durable.length + 1;
  claim(
    "durable",
    durableExcerpts(cwd, state.goalFile, excerptChars, left - durableOverhead),
    Number.POSITIVE_INFINITY,
    0,
  );

  const body = SECTION_ORDER.filter((key) => parts.has(key))
    .map((key) => parts.get(key) as string)
    .join(SECTION_SEPARATOR);
  // Backstop. The allocation above should already fit; this guarantees it even
  // if a future section is added without a budget.
  const summary = `${body.slice(0, Math.max(0, summaryChars - finalDirection.length))}${finalDirection}`;

  return { summary, readFiles, modifiedFiles };
}

/** Exported for the tests: allocation order is the load-bearing part of the fix. */
export { SECTION_ORDER, SECTION_PRIORITY };

const RECOVERY_DIRECTION =
  "\n\n## Next Step\nRe-establish bearings from the working tree: inspect git status and recent git history, read the durable files above, then perform exactly one concrete next progress batch.";

/**
 * The handoff's closing instruction, per compression level.
 *
 * It is appended after the body, so its length is subtracted from the budget
 * before anything else is allocated — and at level 2 the long form is 469
 * characters of a 1,000-character summary. Explaining what a handoff is at
 * length, in the summary that has the least room to say anything, spends
 * half the budget on boilerplate the model has read on every previous handoff.
 * The short forms say the same three things in a fifth of the space.
 */
const HANDOFF_DIRECTIONS = [
  "\n\n## Next Step\nThis is a handoff: the conversation above was dropped, and everything that survived it is written down here or in the files named above. Do not try to recall it. Re-establish bearings from the working tree (git status, git log, the durable files), then perform exactly one concrete next progress batch and write what you did to PROGRESS.md before the next handoff.",
  "\n\n## Next Step\nHandoff: the conversation above was dropped and is not recoverable. Re-establish bearings from the working tree (git status, git log, the durable files), do one concrete progress batch, and write it to PROGRESS.md.",
  "\n\n## Next Step\nHandoff; the conversation is gone. Read the working tree, do one concrete batch, write it to PROGRESS.md.",
];

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
    budgetText(HANDOFF_DIRECTIONS, compressionLevel),
  );

  return {
    summary,
    firstKeptEntryId: findHandoffCutEntryId(branchEntries, preparation.firstKeptEntryId),
    tokensBefore: preparation.tokensBefore,
    details: { readFiles, modifiedFiles },
  };
}
