import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { parseStartArgs, type StartArgs } from "../src/arguments.ts";
import {
  contextBudgetMessage,
  contextBudgetStatus,
  CONTEXT_STARVATION_PERCENT,
  type ContextUsageLike,
} from "../src/context-budget.ts";
import {
  branchEndsInCompaction,
  buildEmergencyCompaction,
  buildHandoffCompaction,
  CONTEXT_PRESSURE_PERCENT,
  HANDOFF_MAX_WINDOW_TOKENS,
  isBenignCompactionError,
  isContextPressure,
  MAX_COMPRESSION_LEVEL,
} from "../src/context-recovery.ts";
import { applyCheckOutcome, type CheckOutcome } from "../src/goal-check.ts";
import { appendLogEntry, formatLoopStats, LOG_FILE, readLogEntries } from "../src/loop-log.ts";
import {
  defaultState,
  persistedLoopState,
  restoreLoopState,
  STATE_ENTRY_TYPE,
  type LoopState,
  type ToolSnapshot,
} from "../src/loop-state.ts";
import {
  contentToText,
  detectDegenerateRepetition,
  fingerprint,
  messageToRepetitionText,
  messageToText,
  normalizeText,
  sanitizeDegenerateMessage,
  snippet,
  textSimilarity,
} from "../src/repetition.ts";

export { detectDegenerateRepetition, sanitizeDegenerateText } from "../src/repetition.ts";
export type { DegenerateInfo } from "../src/repetition.ts";

const MESSAGE_TYPE = "loop";
const BASE_BACKOFF_SECONDS = 5;
const MAX_BACKOFF_SECONDS = 300;
const NO_PROGRESS_WINDOW = 8;
const AUTO_RESUME_DELAY_MS = 3_000;
/** Near-duplicate threshold for consecutive assistant responses (Jaccard on word trigrams). */
const SIMILARITY_THRESHOLD = 0.8;
/** Same fingerprint seen this many times in the recent window counts as stuck. */
const REPEAT_WINDOW_COUNT = 3;
/** Turns without any tool call before a stuck intervention fires. */
const MAX_TOOLLESS_TURNS = 3;
/** Consecutive stuck interventions before the hard-reset escalation kicks in. */
const HARD_RESET_AFTER = 3;
/** A sentence repeated this often inside ONE response = degenerate generation. */
const DEGENERATE_REPEATS = 4;
/** During streaming, abort once the repeated-sentence count reaches this. */
const DEGENERATE_STREAM_REPEATS = 6;
/** Re-run the degeneration check every N new streamed characters. */
const DEGENERATE_CHECK_INTERVAL = 500;
/** Consecutive context-pressure turns before the loop stops retrying and waits out a cooldown. */
const CONTEXT_RECOVERY_ATTEMPTS = 3;
/** Cooldowns survived without a single successful turn before the loop finally pauses for a human. */
const MAX_CONTEXT_COOLDOWNS = 3;
/** First context cooldown; doubles per escalation, capped at MAX_BACKOFF_SECONDS. */
const CONTEXT_COOLDOWN_SECONDS = 60;
/**
 * Fallback delay after pi says it will retry the overflowed turn itself. Any agent_end cancels it,
 * so it only ever fires if that retry never materializes — an unattended loop must not hang on a
 * promise from another component.
 */
const WILL_RETRY_WATCHDOG_MS = 45_000;
/** Consecutive stuck interventions before a rescue-model turn is triggered (if configured). */
const RESCUE_AFTER = 3;
/** Consecutive stuck interventions before the context is compacted to break fixation. */
const COMPACT_AFTER = 5;
/** Iterations that anti-repetition sampling penalties stay active after a stuck intervention. */
const PENALTY_TURNS = 3;
type TurnKind =
  | "start"
  | "continue"
  | "stuck"
  | "recover"
  | "improve"
  | "unblock"
  | "audit"
  | "resume"
  | "regression"
  | "check_failed"
  | "rescue";

let state: LoopState = defaultState();
let pendingTimer: ReturnType<typeof setTimeout> | undefined;
/**
 * Monotonic run token. Incremented on every start/resume/stop/end. All async continuations
 * (timers, agent_end tails after awaits, compaction callbacks) capture it and bail out when it
 * changed, so a /loop stop issued mid-await can never be overridden by stale code paths.
 */
let runToken = 0;
/** Set when we abort a streaming response due to degenerate repetition; consumed in agent_end. */
let degenerateAbortPending = false;
/** Marks a ctx.compact() request that must bypass the already-saturated summarization model. */
let emergencyCompactionPending = false;
/** True while the compaction pi is running is one WE asked for; session_compact then stays out of it. */
let ownCompactionInFlight = false;
/**
 * Context pressure seen in agent_end, held until agent_settled. pi runs its own overflow recovery
 * AFTER agent_end and before it settles; compacting from agent_end raced that recovery and lost,
 * and pi reports the loser as "Already compacted" — which used to strand the loop.
 */
let contextRecoveryPending: { reason: string; token: number } | undefined;
/** Stream position of the last degeneration check (throttle). */
let lastDegenerateCheckLength = 0;

function clearPendingTimer(): void {
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    pendingTimer = undefined;
  }
}

/** Drops every in-flight context-recovery marker. Safe to call from any lifecycle transition. */
function resetContextRecovery(): void {
  emergencyCompactionPending = false;
  ownCompactionInFlight = false;
  contextRecoveryPending = undefined;
}

/** Openings of recent responses; injected as banned phrases during hard-reset escalation. */
function bannedOpenings(): string {
  const openings = new Set<string>();
  for (const snip of state.lastAssistantSnippets.slice(-3)) {
    const words = snip.split(/\s+/).slice(0, 6).join(" ");
    if (words) openings.add(`"${words}…"`);
  }
  return [...openings].join(", ") || "-";
}

function pushLimited<T>(items: T[], item: T, max: number): void {
  items.push(item);
  while (items.length > max) items.shift();
}

function hasStateChange(toolName: string, text: string, isError: boolean): boolean {
  if (isError) return false;
  if (["write", "edit"].includes(toolName)) return true;
  return /\b(written|edited|changed|updated|created|deleted|renamed|committed|fixed|successfully|passed|installed)\b/i.test(text);
}

function recordToolResult(toolName: string, text: string, isError: boolean): void {
  pushLimited(
    state.recentToolResults,
    {
      tool: toolName,
      fingerprint: fingerprint(text),
      snippet: snippet(text),
      isError,
      time: Date.now(),
    },
    10,
  );

  if (hasStateChange(toolName, text, isError)) {
    state.lastStateChangeIteration = state.iterationCount + 1;
  }
}

function restoreState(ctx: ExtensionContext): void {
  state = restoreLoopState(ctx.sessionManager.getBranch());
}

function persistState(pi: ExtensionAPI): void {
  pi.appendEntry(STATE_ENTRY_TYPE, persistedLoopState(state));
}

/**
 * Context usage for the active model, with the window filled in from the model when pi cannot
 * supply it — right after a compaction pi reports `tokens: null`, and the window is still the
 * number every threshold decision here depends on.
 */
function contextUsage(ctx: ExtensionContext): ContextUsageLike | undefined {
  const reported = ctx.getContextUsage() as ContextUsageLike | undefined;
  const modelWindow = (ctx.model as { contextWindow?: number } | undefined)?.contextWindow ?? 0;
  if (!reported) return modelWindow > 0 ? { tokens: null, contextWindow: modelWindow, percent: null } : undefined;
  if (reported.contextWindow && reported.contextWindow > 0) return reported;
  return modelWindow > 0 ? { ...reported, contextWindow: modelWindow } : reported;
}

/**
 * True when the window is small enough that pi's own threshold compaction cannot keep up with it:
 * it keeps `keepRecentTokens` (20,000 by default) plus a summary that grows on every merge, which
 * on a 32k window is a floor above the point at which the model starts returning nothing.
 */
function windowNeedsHandoff(usage: ContextUsageLike | undefined): boolean {
  const window = usage?.contextWindow ?? 0;
  return window > 0 && window <= HANDOFF_MAX_WINDOW_TOKENS;
}

/** True while the context is full enough that adding prompt text makes the situation worse. */
function contextIsSaturated(usage: ContextUsageLike | undefined): boolean {
  return (usage?.percent ?? 0) >= CONTEXT_STARVATION_PERCENT;
}

function resolveModel(ctx: ExtensionContext, spec: string) {
  const slash = spec.indexOf("/");
  if (slash > 0) {
    const found = ctx.modelRegistry.find(spec.slice(0, slash), spec.slice(slash + 1));
    if (found) return found;
  }
  const all = ctx.modelRegistry.getAll();
  const lower = spec.toLowerCase();
  return (
    all.find((m) => m.id.toLowerCase() === lower) ??
    all.find((m) => `${m.provider}/${m.id}`.toLowerCase() === lower) ??
    all.find((m) => m.id.toLowerCase().includes(lower)) ??
    all.find((m) => `${m.provider}/${m.id}`.toLowerCase().includes(lower))
  );
}

async function switchModel(pi: ExtensionAPI, ctx: ExtensionContext, spec: string): Promise<boolean> {
  const model = resolveModel(ctx, spec);
  if (!model) {
    ctx.ui.notify(`Loop: model not found: ${spec} (try provider/id, e.g. anthropic/claude-sonnet-4-5)`, "error");
    return false;
  }
  const ok = await pi.setModel(model);
  if (!ok) {
    ctx.ui.notify(`Loop: no API key configured for ${model.provider}/${model.id}`, "error");
    return false;
  }
  ctx.ui.notify(`Loop: model set to ${model.provider}/${model.id}`, "info");
  return true;
}

/** Slightly varied continue prompts: identical repeated prompts encourage identical repeated answers. */
const CONTINUE_DIRECTIVES = [
  "Continue loop mode.",
  "Continue: execute the next concrete progress batch.",
  "Keep going — pick the next step from your plan and do it now.",
  "Proceed with the next focused unit of work on the goal.",
  "Advance the goal with one concrete, verifiable change.",
];

const STUCK_STRATEGIES = [
  "Step back: list 3 genuinely different approaches in one line each, then execute the most promising one immediately.",
  "Switch to a different subtask of the goal that you have not touched in the last few iterations.",
  "Create or update PROGRESS.md with: current state, what was tried, what failed, next 3 steps. Then execute step 1.",
  "Run the build and/or test suite, pick exactly one failure or warning, and fix only that.",
  "Review recent changes (git diff / git log), verify correctness, and fix any issue you find.",
];

function iterationLabel(): string {
  const next = state.iterationCount + 1;
  return state.maxIterations > 0 ? `${next}/${state.maxIterations}` : `${next}/∞`;
}

function kindDirective(kind: TurnKind): string {
  switch (kind) {
    case "start":
      return state.preparedAt > 0
        ? `Start loop mode. First read ${state.goalFile} to load the full specification, then do the first concrete progress batch.`
        : "Start loop mode. Begin with a short plan (max 5 bullets) if useful, then do the first concrete progress batch.";
    case "stuck": {
      const strategy = STUCK_STRATEGIES[state.interventionCount % STUCK_STRATEGIES.length];
      const escalation =
        state.consecutiveStuckCount >= HARD_RESET_AFTER
          ? ` HARD RESET (stuck intervention #${state.consecutiveStuckCount} in a row): forget your previous phrasing entirely. Banned openings: ${bannedOpenings()}. Your FIRST action this turn must be a tool call (read/bash/edit/write) that produces new information or a concrete file change — zero preamble text before it.`
          : "";
      return `Stuck intervention (${state.lastNotice}). You are repeating yourself. Do NOT repeat the previous answer, command, or question.${escalation} ${strategy}`;
    }
    case "recover":
      return "The previous turn failed with a model/provider error and was retried automatically. Briefly re-establish your bearings (check files/tests as needed), then continue with the next concrete progress batch. Do not restart from scratch.";
    case "improve":
      return (
        "You reported LOOP_DONE, but this loop runs in endless improvement mode. Work backlog-driven: open IMPROVEMENTS.md (create it if missing) — a checklist of concrete improvement items, each with affected file paths and a one-line acceptance criterion. " +
        "If fewer than 3 open items remain, first inspect the codebase with tools and add new specific items. Vague items without file paths (e.g. \"add support for other platforms\") are forbidden. " +
        "Then take the TOP open item, implement it now, and mark it done."
      );
    case "unblock":
      return "You reported LOOP_BLOCKED, but no operator is available. Make the most reasonable assumption, record it in ASSUMPTIONS.md (create if missing), and continue working toward the goal. Never wait for a human.";
    case "audit":
      return `No concrete file/system changes were detected in the last ${NO_PROGRESS_WINDOW} iterations. Stop analyzing and produce a tangible artifact this turn: a file change, a passing test, a fixed bug, or a committed improvement.`;
    case "resume":
      return "The loop was resumed. Briefly check the current project state (files, tests, PROGRESS.md if present), then continue with the next concrete progress batch.";
    case "regression":
      return `Goal check regression: the score dropped to ${state.lastCheckScore} (best so far ${state.bestCheckScore} at iteration ${state.bestScoreIteration}). A recent change made things worse. Inspect recent changes (git diff / git log), find and fix the regression before doing anything else. Check output: ${state.lastCheckOutput}`;
    case "check_failed":
      return `You reported LOOP_DONE, but the goal check command still fails (streak ${state.checkFailStreak}). Completion is decided by the check, not by your claim. Fix exactly what the check reports. Check output: ${state.lastCheckOutput}`;
    case "rescue":
      return (
        `RESCUE TURN: you are a stronger model called in because the loop model was stuck ${state.consecutiveStuckCount}x in a row (${state.lastNotice}). ` +
        `Do now: 1) inspect the project state (git status/diff, PROGRESS.md, ${state.goalFile} if present); 2) fix or finish ONE concrete thing; ` +
        `3) rewrite PROGRESS.md: current state, what keeps failing, the next 3 unambiguous steps with exact file paths; ` +
        `4) update the IMPROVEMENTS.md backlog with concrete items (file paths + acceptance criterion). ` +
        `End with one line "NEXT: <exact instruction for the next turn>". After this turn the loop returns to the regular model.`
      );
    default:
      return CONTINUE_DIRECTIVES[Math.floor(Math.random() * CONTINUE_DIRECTIVES.length)];
  }
}

function loopInstructions(kind: TurnKind): string {
  const doneRule = state.untilDone
    ? state.checkCommand
      ? "- Completion is decided by the goal check command (exit code 0), not by your claim. Work until the check passes; you may still say \"LOOP_DONE:\" once it does."
      : '- If the completion criteria are fully met, start your final message with "LOOP_DONE:".'
    : '- Endless mode: if the core goal appears complete, say "LOOP_DONE: <one-line summary>" — the loop will then continue with improvement work (features, tests, bug fixes, refactoring, docs). Never stop on your own.';

  const checkLine = state.checkCommand
    ? `Goal check: \`${state.checkCommand}\` → ${
        state.lastCheckPassed === undefined
          ? "not run yet"
          : state.lastCheckPassed
            ? "PASSING"
            : `FAILING (streak ${state.checkFailStreak})`
      }${state.lastCheckScore !== undefined ? ` · score ${state.lastCheckScore} (best ${state.bestCheckScore} @ iteration ${state.bestScoreIteration})` : ""}\n`
    : "";

  return (
    `${kindDirective(kind)}\n\n` +
    `Goal: ${state.description}\n` +
    `Completion criteria: ${state.completionCriteria || "continuous improvement until the operator stops the loop"}\n` +
    (state.preparedAt > 0 ? `Specification: ${state.goalFile} — read it whenever you lose track of the plan.\n` : "") +
    `Iteration: ${iterationLabel()}\n` +
    `${checkLine}\n` +
    `Rules:\n` +
    `- Do exactly one concrete progress batch, then stop this turn.\n` +
    `- Prefer tools and file changes over long explanations.\n` +
    `- Never respond with narration only: every turn must include at least one tool call. Do not claim something "already exists" — verify it with a tool and then produce the next concrete change.\n` +
    `- Hard output budget: max 1,200 characters; no large code blocks, logs, full diffs, or repeated context.\n` +
    `${doneRule}\n` +
    `- Never wait for a human. If information is missing, make the most reasonable assumption, document it in ASSUMPTIONS.md, and continue. Use "LOOP_BLOCKED:" only for truly impossible external barriers (e.g., missing credentials) — the loop will still continue with assumptions.\n` +
    `- Otherwise briefly say what changed and let the loop continue.`
  );
}

function sendLoopTurn(pi: ExtensionAPI, kind: TurnKind, ctx?: ExtensionContext): void {
  if (!state.active || state.softStopRequested) return;
  const idle = ctx?.isIdle() ?? false;
  const options = idle
    ? { triggerTurn: true as const }
    : { triggerTurn: true as const, deliverAs: "followUp" as const };

  pi.sendMessage(
    {
      customType: MESSAGE_TYPE,
      content: loopInstructions(kind),
      display: true,
      details: { kind, iteration: state.iterationCount + 1 },
    },
    options,
  );
}

function scheduleLoopTurn(pi: ExtensionAPI, kind: TurnKind, delayMs: number, ctx?: ExtensionContext): void {
  clearPendingTimer();
  if (delayMs <= 0) {
    sendLoopTurn(pi, kind, ctx);
    return;
  }
  const token = runToken;
  pendingTimer = setTimeout(() => {
    pendingTimer = undefined;
    if (!state.active || token !== runToken) return;
    // No ctx available in the timer; followUp + triggerTurn is safe both idle and busy.
    sendLoopTurn(pi, kind);
  }, delayMs);
}

/**
 * Watchdog for work another component promised to do. Re-arms while the agent is busy, so it only
 * ever sends a turn once pi really has gone quiet without producing the agent_end it implied.
 */
function scheduleWatchdogTurn(pi: ExtensionAPI, ctx: ExtensionContext, kind: TurnKind, delayMs: number): void {
  clearPendingTimer();
  const token = runToken;
  pendingTimer = setTimeout(() => {
    pendingTimer = undefined;
    if (!state.active || token !== runToken) return;
    if (!ctx.isIdle() || ctx.hasPendingMessages()) {
      scheduleWatchdogTurn(pi, ctx, kind, delayMs);
      return;
    }
    sendLoopTurn(pi, kind, ctx);
  }, delayMs);
}

/** Finalizes a pending soft stop: the loop stays intact for /loop resume, but nothing new is scheduled. */
function finalizeSoftStop(pi: ExtensionAPI, ctx: ExtensionContext, noticeSuffix = ""): void {
  runToken++;
  clearPendingTimer();
  degenerateAbortPending = false;
  resetContextRecovery();
  state.softStopRequested = false;
  state.active = false;
  state.status = "stopped";
  state.lastNotice = `Soft stop: iteration finished, loop stopped by operator.${noticeSuffix}`;
  persistState(pi);
  logIteration("soft_stop");
  ctx.ui.notify("Loop stopped after finishing the current iteration. Use /loop resume to continue.", "info");
  ctx.ui.setStatus("loop", "Loop stopped (soft)");
}

function backoffSeconds(): number {
  const exponent = Math.min(Math.max(state.consecutiveErrorCount - 1, 0), 6);
  return Math.min(MAX_BACKOFF_SECONDS, BASE_BACKOFF_SECONDS * 2 ** exponent);
}

/** Appends one JSONL entry per loop event; used by /loop stats. Never throws. */
function logIteration(event: string, extra: Record<string, unknown> = {}): void {
  appendLogEntry(LOG_FILE, {
    ts: new Date().toISOString(),
    iteration: state.iterationCount,
    event,
    model: state.rescueActive ? state.rescueModel : state.loopModel || undefined,
    score: state.lastCheckScore,
    checkPassed: state.lastCheckPassed,
    stuckStreak: state.consecutiveStuckCount,
    notice: state.lastNotice || undefined,
    ...extra,
  });
}

function statsText(): string {
  return formatLoopStats(readLogEntries(LOG_FILE), state.startTime, LOG_FILE);
}

function pauseForContextFailure(pi: ExtensionAPI, ctx: ExtensionContext, notice: string): void {
  runToken++;
  clearPendingTimer();
  resetContextRecovery();
  state.active = false;
  state.status = "paused";
  state.lastNotice = notice;
  persistState(pi);
  logIteration("context_circuit_open", { notice });
  ctx.ui.notify(`${notice} Use /compact, then /loop resume after reducing or repairing the context.`, "error");
  ctx.ui.setStatus("loop", "Loop paused — context recovery required");
}

/** Raises the compression level used for the next emergency summary, up to the tightest one. */
function tightenEmergencySummary(): void {
  state.contextCompressionLevel = Math.min(MAX_COMPRESSION_LEVEL, state.contextCompressionLevel + 1);
}

/**
 * A context recovery finished. `freedRoom` separates a compaction that actually shrank the context
 * (error streak and compression level reset) from a no-op — pi had already compacted, or there was
 * nothing left to summarize. A no-op keeps the streak, so a context that genuinely cannot shrink
 * still escalates instead of retrying against the same wall forever.
 *
 * `resumeTurn` is false when pi told us it will re-run the overflowed turn itself: sending our own
 * turn on top would run the iteration twice.
 */
function finishContextRecovery(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  reason: string,
  detail: string,
  freedRoom: boolean,
  resumeTurn = true,
): void {
  if (!state.active) return;
  if (state.softStopRequested) {
    finalizeSoftStop(pi, ctx, " (after context recovery)");
    return;
  }
  state.contextRecoveryCount++;
  if (freedRoom) {
    state.consecutiveErrorCount = 0;
    state.contextCooldownCount = 0;
    state.contextCompressionLevel = 0;
  } else {
    tightenEmergencySummary();
  }
  state.status = "running";
  state.lastNotice = `Context recovered: ${detail} (${reason}).`;
  persistState(pi);
  logIteration("context_recovered", { reason, detail, freedRoom, resumeTurn });
  ctx.ui.notify(`Loop: context recovered — ${detail}. Continuing.`, "info");
  ctx.ui.setStatus("loop", statusBarText(ctx));
  if (resumeTurn) {
    scheduleLoopTurn(pi, "recover", 0, ctx);
  } else {
    scheduleWatchdogTurn(pi, ctx, "recover", WILL_RETRY_WATCHDOG_MS);
  }
}

/**
 * Recovery is not converging. An unattended loop must not die here, so it waits out an escalating
 * cooldown and comes back with a tighter summary; only a run that spends the whole ladder without
 * one successful turn is genuinely unrecoverable and pauses for a human.
 */
function enterContextCooldown(pi: ExtensionAPI, ctx: ExtensionContext, reason: string): void {
  if (!state.active) return;
  if (state.softStopRequested) {
    finalizeSoftStop(pi, ctx, " (during context recovery)");
    return;
  }
  contextRecoveryPending = undefined;
  state.contextCooldownCount++;
  tightenEmergencySummary();
  if (state.contextCooldownCount > MAX_CONTEXT_COOLDOWNS) {
    pauseForContextFailure(
      pi,
      ctx,
      `Context recovery exhausted after ${MAX_CONTEXT_COOLDOWNS} cooldowns (${reason}).`,
    );
    return;
  }
  const delay = Math.min(MAX_BACKOFF_SECONDS, CONTEXT_COOLDOWN_SECONDS * 2 ** (state.contextCooldownCount - 1));
  // Fresh recovery budget on the other side of the cooldown; the cooldown counter is what escalates.
  state.consecutiveErrorCount = 0;
  state.status = "retrying";
  state.lastNotice = `Context cooldown ${state.contextCooldownCount}/${MAX_CONTEXT_COOLDOWNS} for ${delay}s (${reason}).`;
  persistState(pi);
  logIteration("context_cooldown", { reason, delay, cooldown: state.contextCooldownCount });
  ctx.ui.notify(
    `Loop: context recovery stalled (${reason}) — cooling down ${delay}s, then retrying with a tighter summary (${state.contextCooldownCount}/${MAX_CONTEXT_COOLDOWNS}).`,
    "warning",
  );
  ctx.ui.setStatus("loop", `Loop context cooldown ${delay}s (${state.contextCooldownCount}/${MAX_CONTEXT_COOLDOWNS})`);
  scheduleLoopTurn(pi, "recover", delay * 1000);
}

function requestEmergencyCompaction(pi: ExtensionAPI, ctx: ExtensionContext, reason: string): void {
  // pi refuses to compact a branch that already ends in a compaction entry, which is exactly the
  // state its own overflow recovery leaves behind. Asking anyway only produces "Already compacted",
  // so recognize the recovered context instead of reporting someone else's success as our failure.
  if (branchEndsInCompaction(ctx.sessionManager.getBranch())) {
    finishContextRecovery(pi, ctx, reason, "pi had already compacted this branch", false);
    return;
  }
  const token = runToken;
  emergencyCompactionPending = true;
  ownCompactionInFlight = true;
  ctx.compact({
    customInstructions: "Emergency loop recovery: preserve the saved goal, durable project state, and next concrete step.",
    onComplete: () => {
      emergencyCompactionPending = false;
      ownCompactionInFlight = false;
      if (!state.active || token !== runToken) return;
      if (state.softStopRequested) {
        finalizeSoftStop(pi, ctx, " (during emergency compaction)");
        return;
      }
      finishContextRecovery(pi, ctx, reason, "emergency compaction completed", true);
    },
    onError: (error) => {
      emergencyCompactionPending = false;
      ownCompactionInFlight = false;
      if (!state.active || token !== runToken) return;
      if (state.softStopRequested) {
        finalizeSoftStop(pi, ctx, " (emergency compaction failed)");
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      // "Already compacted" / "Nothing to compact" mean the context is already as small as this
      // session can make it — no work to do, not a failure worth stopping an unattended run for.
      if (isBenignCompactionError(message)) {
        finishContextRecovery(pi, ctx, reason, snippet(message, 80), false);
        return;
      }
      enterContextCooldown(pi, ctx, `emergency compaction failed: ${snippet(message, 120)}`);
    },
  });
}

async function runGoalCheck(pi: ExtensionAPI): Promise<CheckOutcome> {
  try {
    const result = await pi.exec("bash", ["-lc", state.checkCommand], { timeout: state.checkTimeoutSeconds * 1000 });
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
    const scoreMatches = [...output.matchAll(/SCORE:\s*(-?\d+(?:\.\d+)?)/gi)];
    const score = scoreMatches.length > 0 ? Number.parseFloat(scoreMatches[scoreMatches.length - 1][1]) : undefined;
    return { passed: result.code === 0, score, output: snippet(output, 400), execFailed: false };
  } catch (error) {
    return { passed: false, score: undefined, output: snippet(String(error), 200), execFailed: true };
  }
}

function detectStuck(lastAssistantText: string, repetitionText = lastAssistantText): string | undefined {
  const prints = state.lastAssistantFingerprints;

  // Degenerate generation: one sentence, word, or short phrase repeated many times within a single response.
  const degenerate = detectDegenerateRepetition(repetitionText, DEGENERATE_REPEATS);
  if (degenerate) {
    return `response degenerated: same ${degenerate.kind} repeated ${degenerate.repeats}× ("${snippet(degenerate.unit, 60)}")`;
  }

  // Narration-only loops: several turns without a single tool call.
  if (state.turnsWithoutTools >= MAX_TOOLLESS_TURNS) {
    return `no tool usage for ${state.turnsWithoutTools} turns (narration only)`;
  }

  const lastTwo = prints.slice(-2);
  if (lastTwo.length === 2 && lastTwo[0] === lastTwo[1] && normalizeText(lastAssistantText).length > 80) {
    return "assistant repeated the same response";
  }

  const lastThree = prints.slice(-3);
  if (lastThree.length === 3 && lastThree.every((p) => p === lastThree[0]) && normalizeText(lastAssistantText).length > 0) {
    return "assistant repeated the same response three times";
  }

  // Near-duplicate responses: exact fingerprints miss slight rephrasings ("…continue with improvements on X/Y").
  const texts = state.lastAssistantTexts;
  const previousText = texts.length >= 2 ? texts[texts.length - 2] : undefined;
  if (previousText && normalizeText(lastAssistantText).length > 60) {
    const similarity = textSimilarity(lastAssistantText, previousText);
    if (similarity >= SIMILARITY_THRESHOLD) {
      return `assistant response ~${Math.round(similarity * 100)}% similar to previous`;
    }
  }

  // Alternating repetition (A-B-A-B…): same fingerprint several times in the recent window.
  const currentPrint = prints[prints.length - 1];
  if (currentPrint && prints.filter((p) => p === currentPrint).length >= REPEAT_WINDOW_COUNT) {
    return `same response repeated ${REPEAT_WINDOW_COUNT}+ times in recent turns`;
  }

  const recentTools = state.recentToolResults.slice(-3);
  if (
    recentTools.length === 3 &&
    recentTools.every((result) => result.tool === recentTools[0].tool && result.fingerprint === recentTools[0].fingerprint)
  ) {
    return recentTools.every((result) => result.isError)
      ? `same ${recentTools[0].tool} error repeated`
      : `same ${recentTools[0].tool} result repeated`;
  }

  const asksQuestion = /\?\s*$/.test(lastAssistantText.trim());
  const lastSnippets = state.lastAssistantSnippets.slice(-2);
  if (asksQuestion && lastSnippets.length === 2 && lastSnippets[0] === lastSnippets[1]) {
    return "same question repeated";
  }

  return undefined;
}

function formatElapsed(): string {
  if (state.startTime <= 0) return "0m";
  let seconds = Math.round((Date.now() - state.startTime) / 1000);
  const days = Math.floor(seconds / 86_400);
  seconds -= days * 86_400;
  const hours = Math.floor(seconds / 3_600);
  seconds -= hours * 3_600;
  const minutes = Math.floor(seconds / 60);
  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
  return parts.join(" ");
}

function statusBarText(ctx?: ExtensionContext): string {
  if (state.softStopRequested) return `Loop finishing iteration ${state.iterationCount + 1} — soft stop pending`;
  const iterations = state.maxIterations > 0 ? `${state.iterationCount}/${state.maxIterations}` : `${state.iterationCount}/∞`;
  const check =
    state.lastCheckScore !== undefined
      ? ` · score ${state.lastCheckScore}`
      : state.lastCheckPassed !== undefined
        ? ` · check ${state.lastCheckPassed ? "✓" : "✗"}`
        : "";
  // The operator sees the same number the model is now told about, so a handoff is never a surprise.
  const budget = ctx ? contextBudgetStatus(contextUsage(ctx)) : undefined;
  return `Loop ${iterations} · ${formatElapsed()} · err ${state.totalErrorCount}${budget ? ` · ${budget}` : ""}${check}: ${snippet(state.description, 40)}`;
}

function statusText(ctx: ExtensionContext): string {
  const usage = contextUsage(ctx);
  const contextLine =
    usage && (usage.contextWindow ?? 0) > 0
      ? usage.tokens === null || usage.tokens === undefined
        ? `unknown (window ${usage.contextWindow}; usage is unknown until the next response after a compaction)`
        : `${usage.tokens}/${usage.contextWindow} tokens (${Math.round(usage.percent ?? 0)}%)${
            windowNeedsHandoff(usage) ? ", handoff mode" : ""
          }`
      : "-";
  return [
    `Active: ${state.active}`,
    `Status: ${state.status}${state.softStopRequested ? " (soft stop pending)" : ""}`,
    `Goal: ${state.description || "-"}`,
    `Criteria: ${state.completionCriteria || "- (endless improvement)"}`,
    `Mode: ${state.untilDone ? "until-done" : "endless"}`,
    `Iterations: ${state.iterationCount}${state.maxIterations > 0 ? `/${state.maxIterations}` : "/∞"}`,
    `Delay: ${state.delaySeconds}s`,
    `Check: ${state.checkCommand ? `${state.checkCommand} (timeout ${state.checkTimeoutSeconds}s)` : "-"}`,
    `Check status: ${
      state.lastCheckPassed === undefined ? "-" : state.lastCheckPassed ? "passing" : `failing (streak ${state.checkFailStreak})`
    }${state.lastCheckScore !== undefined ? `, score ${state.lastCheckScore} (best ${state.bestCheckScore} @ iter ${state.bestScoreIteration})` : ""}`,
    `Goal file: ${state.goalFile}${state.preparedAt > 0 ? " (prepared)" : " (not prepared)"}`,
    `Loop model: ${state.loopModel || "- (current model)"}`,
    `Rescue model: ${state.rescueModel || "-"}${state.rescueActive ? " (rescue turn in flight)" : ""}`,
    `Elapsed: ${formatElapsed()}`,
    `Errors: ${state.totalErrorCount} total, ${state.consecutiveErrorCount} consecutive`,
    `Context: ${contextLine}`,
    `Context recoveries: ${state.contextRecoveryCount}${
      state.contextCooldownCount > 0 ? `, cooldown ${state.contextCooldownCount}/${MAX_CONTEXT_COOLDOWNS}` : ""
    }${state.contextCompressionLevel > 0 ? `, summary level ${state.contextCompressionLevel}/${MAX_COMPRESSION_LEVEL}` : ""}`,
    `Interventions: ${state.interventionCount} (stuck streak: ${state.consecutiveStuckCount})`,
    `Done signals: ${state.doneSignalCount}, blocked signals: ${state.blockedSignalCount}`,
    `Last notice: ${state.lastNotice || "-"}`,
    `Session entries: ${ctx.sessionManager.getEntries().length}`,
  ].join("\n");
}

function applyGoalConfig(parsed: StartArgs): void {
  // Re-issuing the same goal (e.g. to tweak flags after /loop prepare) keeps the prepared spec.
  const preservedPreparedAt = state.description === parsed.description ? state.preparedAt : 0;
  state = {
    ...defaultState(),
    description: parsed.description,
    completionCriteria: parsed.criteria,
    maxIterations: parsed.maxIterations,
    untilDone: parsed.untilDone,
    delaySeconds: parsed.delaySeconds,
    checkCommand: parsed.checkCommand,
    checkTimeoutSeconds: parsed.checkTimeoutSeconds,
    goalFile: parsed.goalFile || "GOAL.md",
    loopModel: parsed.model,
    rescueModel: parsed.rescueModel,
    preparedAt: preservedPreparedAt,
    status: "stopped",
  };
}

function goalSummaryText(): string {
  return [
    `Goal: ${state.description || "-"}`,
    `Criteria: ${state.completionCriteria || "- (endless improvement)"}`,
    `Mode: ${state.untilDone ? "until-done" : "endless"}`,
    `Max iterations: ${state.maxIterations > 0 ? state.maxIterations : "∞"}`,
    `Delay: ${state.delaySeconds}s`,
    `Check: ${state.checkCommand || "-"}`,
    `Goal file: ${state.goalFile}`,
    `Prepared: ${state.preparedAt > 0 ? new Date(state.preparedAt).toISOString() : "no (optional: /loop prepare [--model M])"}`,
    `Loop model: ${state.loopModel || "- (current model)"}`,
    `Rescue model: ${state.rescueModel || "-"}`,
  ].join("\n");
}

function prepareInstructions(): string {
  return (
    `Prepare the loop goal specification. Do NOT start implementing the goal itself in this turn.\n\n` +
    `Goal: ${state.description}\n` +
    `Completion criteria: ${state.completionCriteria || "continuous improvement until the operator stops the loop"}\n\n` +
    `Tasks for this turn:\n` +
    `1. Inspect the current project state (files, README, tests) if one exists.\n` +
    `2. Write ${state.goalFile} containing: refined objective, scope & non-goals, measurable completion criteria, a milestone roadmap of small steps, quality standards (tests, docs, git commits), and explicit assumptions.\n` +
    `3. If the goal is objectively checkable, create a goal-check script (e.g. check.sh: exit 0 = criteria met, print "SCORE: <n>", higher = better) and reference it in ${state.goalFile}.\n` +
    `4. Keep ${state.goalFile} under ~200 lines, concrete and unambiguous — it must guide another (possibly weaker) model through a long unattended run.\n\n` +
    `End your final message with "GOAL_READY: <one-line summary>" and, if you created a check script, the exact --check command to use.`
  );
}

/** Shared stuck handling with escalation ladder: penalties → rescue model → compaction → rotating strategy. */
async function interveneStuck(pi: ExtensionAPI, ctx: ExtensionContext, reason: string): Promise<void> {
  const token = runToken;
  state.consecutiveStuckCount++;
  state.interventionCount++;
  state.status = "stuck";
  state.lastNotice = reason;
  state.turnsWithoutTools = 0;
  // Fight repetition at the sampling level too (applied via before_provider_request).
  state.penaltyTurnsRemaining = PENALTY_TURNS;

  // A full context is not fixation, and none of the prompt-level rungs below can fix it — they all
  // work by adding text to the thing that is already too big. Skip straight to the compaction.
  const saturated = contextIsSaturated(contextUsage(ctx));

  // Escalation 1: hand the situation to a stronger rescue model for one turn.
  if (!saturated && state.rescueModel && !state.rescueActive && state.consecutiveStuckCount >= RESCUE_AFTER) {
    if (!state.loopModel && ctx.model) state.rescueReturnModel = `${ctx.model.provider}/${ctx.model.id}`;
    const switched = await switchModel(pi, ctx, state.rescueModel);
    if (!state.active || token !== runToken) return;
    if (switched) {
      state.rescueActive = true;
      persistState(pi);
      logIteration("rescue_start", { reason });
      ctx.ui.notify(`Loop: stuck ${state.consecutiveStuckCount}x — rescue turn with ${state.rescueModel}.`, "warning");
      ctx.ui.setStatus("loop", `Loop rescue turn (stuck ${state.consecutiveStuckCount}x)`);
      scheduleLoopTurn(pi, "rescue", 0, ctx);
      return;
    }
    if (!state.loopModel) state.rescueReturnModel = "";
  }

  // Escalating pause between interventions to break tight garbage loops.
  const delayMs = Math.min(60, 2 ** Math.min(state.consecutiveStuckCount, 6)) * 1000;

  // Escalation 2: stubborn fixation — compact the context so the repeated pattern leaves the window.
  //
  // A saturated context takes this branch immediately rather than after COMPACT_AFTER interventions.
  // Measured on a 32k run: three "you are repeating yourself" injections in a row each produced
  // another empty response, and the compaction that finally arrived was followed immediately by a
  // turn that did real work. The prompt was never the problem; the room was.
  if (
    saturated ||
    (state.consecutiveStuckCount >= COMPACT_AFTER && state.iterationCount - state.lastCompactIteration >= COMPACT_AFTER)
  ) {
    state.lastCompactIteration = state.iterationCount;
    persistState(pi);
    logIteration("compact", { reason, saturated });
    ctx.ui.notify(
      saturated
        ? `Loop: stuck on a saturated context (${reason}) — compacting instead of re-prompting.`
        : `Loop: stuck ${state.consecutiveStuckCount}x — compacting context to break the pattern.`,
      "warning",
    );
    ctx.compact({
      customInstructions:
        "Summarize the work so far concisely. Explicitly EXCLUDE repetitive filler sentences and repeated failed attempts; keep the goal, the current project state, and concrete next steps.",
      onComplete: () => {
        if (!state.active || token !== runToken) return;
        if (state.softStopRequested) {
          finalizeSoftStop(pi, ctx, " (during compaction)");
          return;
        }
        scheduleLoopTurn(pi, "stuck", 0);
      },
      onError: () => {
        if (!state.active || token !== runToken) return;
        if (state.softStopRequested) {
          finalizeSoftStop(pi, ctx, " (during compaction)");
          return;
        }
        scheduleLoopTurn(pi, "stuck", delayMs);
      },
    });
    return;
  }

  persistState(pi);
  logIteration("stuck", { reason });
  ctx.ui.notify(`Loop stuck (${state.consecutiveStuckCount}x): ${reason} — injecting new strategy.`, "warning");
  ctx.ui.setStatus("loop", `Loop stuck ${state.consecutiveStuckCount}x — redirecting`);
  if (!ctx.hasPendingMessages()) scheduleLoopTurn(pi, "stuck", delayMs, ctx);
}

function runLoop(pi: ExtensionAPI, ctx: ExtensionContext): void {
  runToken++;
  clearPendingTimer();
  degenerateAbortPending = false;
  resetContextRecovery();
  state.active = true;
  state.startTime = Date.now();
  state.iterationCount = 0;
  state.consecutiveStuckCount = 0;
  state.consecutiveErrorCount = 0;
  state.totalErrorCount = 0;
  state.interventionCount = 0;
  state.doneSignalCount = 0;
  state.blockedSignalCount = 0;
  state.lastStateChangeIteration = 0;
  state.lastAssistantFingerprints = [];
  state.lastAssistantSnippets = [];
  state.lastAssistantTexts = [];
  state.recentToolResults = [];
  state.turnsWithoutTools = 0;
  state.toolCallsThisTurn = 0;
  state.rescueActive = false;
  state.rescueReturnModel = "";
  state.penaltyTurnsRemaining = 0;
  state.lastCompactIteration = 0;
  state.softStopRequested = false;
  state.status = "running";
  state.lastNotice = "";

  persistState(pi);
  const mode = state.untilDone ? "until-done" : "endless (stop with /loop stop)";
  ctx.ui.notify(`Loop active [${mode}]: ${state.description}`, "info");
  ctx.ui.setStatus("loop", statusBarText(ctx));
  sendLoopTurn(pi, "start", ctx);
}

export default function (pi: ExtensionAPI) {
  pi.on("session_before_compact", async (event, ctx) => {
    const usage = contextUsage(ctx);
    const percent = usage?.percent ?? 0;
    const loopOwnsThisSession = state.active && Boolean(state.description);

    // pi's own compactions summarize with the LLM. After an overflow that is the same LLM that just
    // refused this context, so the summarization request is the one least likely to succeed exactly
    // when it is needed most — build those locally instead.
    const unsafeToSummarizeWithModel =
      loopOwnsThisSession && (event.reason === "overflow" || Boolean(contextRecoveryPending));
    const saturatedManualCompaction =
      event.reason === "manual" && Boolean(state.description) && percent >= CONTEXT_PRESSURE_PERCENT;

    // A context this tight cannot afford what pi's defaults do to it, whatever triggered the
    // compaction: pi keeps `keepRecentTokens` (20,000 — 61% of a 32k window) and merges a summary
    // that grows on every compaction. Measured across one 32k run, compaction #4 onward freed
    // nothing at all and the session sat at 94–96% full, returning empty turns. Every compaction
    // here becomes a handoff instead: a bounded summary that does not grow, a cut at the last turn,
    // and no model call at all.
    const needsHandoff = loopOwnsThisSession && (windowNeedsHandoff(usage) || percent >= CONTEXT_STARVATION_PERCENT);

    if (!emergencyCompactionPending && !unsafeToSummarizeWithModel && !saturatedManualCompaction) {
      // A window with room to spare keeps pi's higher-quality model summary.
      if (!needsHandoff || (event.reason !== "threshold" && event.reason !== "manual")) return;
    }
    emergencyCompactionPending = false;

    if (needsHandoff) {
      const handoff = buildHandoffCompaction(
        state,
        event.preparation,
        ctx.cwd,
        event.branchEntries ?? [],
        state.contextCompressionLevel,
      );
      logIteration("context_handoff", {
        reason: event.reason,
        percent,
        window: usage?.contextWindow,
        summaryChars: handoff.summary.length,
        tightened: handoff.firstKeptEntryId !== event.preparation.firstKeptEntryId,
        level: state.contextCompressionLevel,
      });
      ctx.ui.notify(
        `Loop: handing off to a fresh context (${Math.round(percent)}% used, ${handoff.summary.length}-char summary).`,
        "info",
      );
      return { compaction: handoff };
    }
    return { compaction: buildEmergencyCompaction(state, event.preparation, ctx.cwd, state.contextCompressionLevel) };
  });

  // pi runs its own overflow recovery after agent_end and before the run settles. When it wins that
  // race the context IS recovered — the loop adopts that result rather than asking for a second
  // compaction pi can only answer with "Already compacted".
  pi.on("session_compact", async (event, ctx) => {
    if (!state.active || ownCompactionInFlight) return;
    const pending = contextRecoveryPending;
    contextRecoveryPending = undefined;
    const compactEvent = event as unknown as { reason?: string; willRetry?: boolean };
    if (!pending) {
      // Routine threshold compaction with no recovery in flight: nothing to resume, but the tighter
      // summary budget has served its purpose and should not leak into the next emergency.
      state.contextCompressionLevel = 0;
      persistState(pi);
      return;
    }
    if (pending.token !== runToken) return;
    finishContextRecovery(
      pi,
      ctx,
      pending.reason,
      `pi compacted the context (${compactEvent.reason ?? "unknown"})`,
      true,
      !compactEvent.willRetry,
    );
  });

  /**
   * Forge fork: the command body, lifted out so a TOOL can drive it too.
   *
   * Upstream exposes loop control only as `/loop`, which means only a human can
   * start or stop one — the model cannot type a slash command, it can only call
   * tools. That is the wrong shape for this stack: a loop is the thing the model
   * should reach for when it has a goal and a way to check it, and a subagent
   * running a bounded loop in its own window is the best version of delegation
   * here. It also means the model cannot stop a loop it started, which is worse.
   *
   * `suppressAbort` is for the tool path only. `stop` and `end` abort the
   * in-flight turn to drop queued loop follow-ups; called from a tool, the
   * in-flight turn is the one executing the tool, so aborting it would throw
   * away the tool's own result and leave the model with no idea whether the stop
   * took. The state changes and the runToken bump are what actually stop the
   * loop; the abort is only there to cut a turn the operator is not in.
   */
  const loopCommand = async (
    args: string,
    ctx: ExtensionContext,
    opts: { suppressAbort?: boolean } = {},
  ): Promise<void> => {
      const trimmed = args.trim();
      const [subcommand = "status", ...rest] = trimmed.split(/\s+/);
      const command = subcommand.toLowerCase();
      const remainder = rest.join(" ").trim();

      if (command === "start") {
        if (!remainder) {
          ctx.ui.notify(
            'Usage: /loop start <goal[. Done when: criteria]> [--max N] [--delay S] [--check "CMD"] [--check-timeout S] [--model M] [--rescue-model M] [--until-done]',
            "error",
          );
          return;
        }
        applyGoalConfig(parseStartArgs(remainder));
        if (state.loopModel && !(await switchModel(pi, ctx, state.loopModel))) return;
        runLoop(pi, ctx);
        return;
      }

      if (command === "goal") {
        if (!remainder) {
          ctx.ui.notify(`Loop goal:\n${goalSummaryText()}`, "info");
          return;
        }
        if (state.active) {
          ctx.ui.notify("Loop is running. Use /loop stop first, then set a new goal.", "error");
          return;
        }
        applyGoalConfig(parseStartArgs(remainder));
        persistState(pi);
        ctx.ui.notify(
          `Goal set (not started):\n${goalSummaryText()}\n\nNext: /loop prepare [--model M] (optional), then /loop run [--model M].`,
          "info",
        );
        return;
      }

      if (command === "prepare") {
        if (!state.description) {
          ctx.ui.notify("No goal set. Use /loop goal <goal> first.", "error");
          return;
        }
        if (state.active) {
          ctx.ui.notify("Loop is running. Use /loop stop first.", "error");
          return;
        }
        const parsed = parseStartArgs(remainder);
        if (parsed.goalFile) state.goalFile = parsed.goalFile;
        if (parsed.model && !(await switchModel(pi, ctx, parsed.model))) return;
        state.status = "preparing";
        persistState(pi);
        ctx.ui.notify(`Preparing goal specification in ${state.goalFile}… Review it when done, then /loop run [--model M].`, "info");
        pi.sendMessage(
          { customType: MESSAGE_TYPE, content: prepareInstructions(), display: true, details: { kind: "prepare" } },
          { triggerTurn: true },
        );
        return;
      }

      if (command === "run") {
        if (!state.description) {
          ctx.ui.notify("No goal set. Use /loop goal <goal> first (or /loop start <goal> for one step).", "error");
          return;
        }
        if (state.active) {
          ctx.ui.notify("Loop is already running. Use /loop status to inspect it.", "error");
          return;
        }
        const parsed = parseStartArgs(remainder);
        if (parsed.model) state.loopModel = parsed.model;
        if (parsed.rescueModel) state.rescueModel = parsed.rescueModel;
        if (state.loopModel && !(await switchModel(pi, ctx, state.loopModel))) return;
        runLoop(pi, ctx);
        return;
      }

      if (command === "resume") {
        if (!state.description) {
          ctx.ui.notify("No loop to resume. Use /loop start <goal>.", "error");
          return;
        }
        const parsed = parseStartArgs(remainder);
        if (remainder.includes("--max")) state.maxIterations = parsed.maxIterations;
        if (parsed.checkCommand) {
          state.checkCommand = parsed.checkCommand;
          state.checkTimeoutSeconds = parsed.checkTimeoutSeconds;
        }
        if (parsed.model) {
          state.loopModel = parsed.model;
          if (!(await switchModel(pi, ctx, parsed.model))) return;
        } else if (state.rescueReturnModel) {
          if (!(await switchModel(pi, ctx, state.rescueReturnModel))) return;
          state.rescueReturnModel = "";
        }
        if (parsed.rescueModel) state.rescueModel = parsed.rescueModel;
        if (state.maxIterations > 0 && state.iterationCount >= state.maxIterations) {
          state.maxIterations = 0;
          ctx.ui.notify("Iteration cap was exhausted; resuming without a cap (endless).", "warning");
        }
        runToken++;
        resetContextRecovery();
        state.active = true;
        state.status = "running";
        state.consecutiveStuckCount = 0;
        state.consecutiveErrorCount = 0;
        state.rescueActive = false;
        state.softStopRequested = false;
        state.lastNotice = "Resumed by operator.";
        persistState(pi);
        ctx.ui.notify(`Loop resumed: ${state.description}`, "info");
        ctx.ui.setStatus("loop", statusBarText(ctx));
        sendLoopTurn(pi, "resume", ctx);
        return;
      }

      if (command === "finish" || command === "soft-stop") {
        if (!state.active) {
          ctx.ui.notify("No active loop to finish. Use /loop status to inspect state.", "error");
          return;
        }
        if (ctx.isIdle()) {
          // Between iterations (delay timer pending): nothing to finish — stop right away.
          runToken++;
          clearPendingTimer();
          state.softStopRequested = false;
          state.active = false;
          state.status = "stopped";
          state.lastNotice = "Soft stop while idle; state preserved.";
          persistState(pi);
          ctx.ui.notify("Loop stopped (was idle between iterations). Use /loop resume to continue.", "info");
          ctx.ui.setStatus("loop", "Loop stopped");
          return;
        }
        state.softStopRequested = true;
        persistState(pi);
        ctx.ui.notify("Loop soft stop: finishing the current iteration, then stopping. (/loop resume to undo, /loop stop for hard stop.)", "info");
        ctx.ui.setStatus("loop", "Loop finishing — soft stop after this iteration");
        return;
      }

      if (command === "stop") {
        runToken++;
        clearPendingTimer();
        degenerateAbortPending = false;
        resetContextRecovery();
        const wasActive = state.active;
        state.active = false;
        state.softStopRequested = false;
        state.status = "stopped";
        state.lastNotice = "Stopped by operator; state preserved.";
        persistState(pi);
        // Abort the in-flight turn and drop queued loop messages; otherwise the
        // current turn (and any already-queued loop follow-up) keeps the agent running.
        if (wasActive && !opts.suppressAbort && !ctx.isIdle()) ctx.abort();
        ctx.ui.notify("Loop stopped. Use /loop resume to continue, /loop start to replace, or /loop end to clear.", "info");
        ctx.ui.setStatus("loop", "Loop stopped");
        return;
      }

      if (command === "end" || command === "clear") {
        runToken++;
        clearPendingTimer();
        degenerateAbortPending = false;
        resetContextRecovery();
        const wasActive = state.active;
        state = defaultState();
        persistState(pi);
        if (wasActive && !opts.suppressAbort && !ctx.isIdle()) ctx.abort();
        ctx.ui.notify("Loop ended and state cleared.", "info");
        ctx.ui.setStatus("loop", "Loop ended");
        return;
      }

      if (command === "status") {
        ctx.ui.notify(`Loop state:\n${statusText(ctx)}`, "info");
        return;
      }

      if (command === "stats") {
        ctx.ui.notify(statsText(), "info");
        return;
      }

      if (command === "help") {
        ctx.ui.notify(
          "Workflow: /loop goal <goal> → /loop prepare [--model M] → /loop run [--model M]\n" +
            '/loop goal <goal[. Done when: criteria]> [--max N] [--delay S] [--check "CMD"] [--check-timeout S] [--file GOAL.md] [--model M] [--rescue-model M] [--until-done] — set goal without starting\n' +
            "/loop prepare [--model M] [--file F] — have a (strong) model write the goal spec + check script\n" +
            "/loop run [--model M] — start the loop, optionally with a different model\n" +
            "/loop start <goal> [flags] — goal + run in one step\n" +
            '/loop resume [--max N] [--check "CMD"] [--model M] [--rescue-model M] | /loop status | /loop stats | /loop finish | /loop stop | /loop end\n' +
            "/loop finish — soft stop: finish the current iteration, then stop (state preserved for /loop resume)\n" +
            "--rescue-model M — stronger model that takes over for one turn after 3 stuck interventions in a row\n" +
            "Default: endless — runs until /loop stop. --until-done stops when the goal check passes (or LOOP_DONE without check).\n" +
            'Goal check: shell command, exit 0 = done criteria met, optional "SCORE: n" output for progress/regression tracking.\n' +
            `Per-iteration JSONL log in ${LOG_FILE} — inspect with /loop stats.`,
          "info",
        );
        return;
      }

      // Convenience: /loop <goal> starts a loop immediately.
      applyGoalConfig(parseStartArgs(trimmed));
      if (state.loopModel && !(await switchModel(pi, ctx, state.loopModel))) return;
      runLoop(pi, ctx);
  };

  pi.registerCommand("loop", {
    description:
      "Loop mode: /loop goal <goal> → /loop prepare [--model M] → /loop run [--model M]; or /loop start <goal>; /loop status|stats|resume|finish|stop|end",
    handler: async (args: string, ctx) => loopCommand(args, ctx),
  });

  // --- Forge fork: the same thing, as a tool the model can call itself. ------
  //
  // Everything the command reports, it reports through `ctx.ui.notify`, which
  // the operator sees and the model does not. A tool has to hand its caller
  // text, so the notices are captured on the way past and returned. A Proxy
  // rather than a spread: the context is a live object with methods that expect
  // their own `this`, and a shallow copy of it loses them.
  const withCapturedNotices = (base: ExtensionContext) => {
    const lines: string[] = [];
    const ui = new Proxy(base.ui, {
      get(target, prop, receiver) {
        if (prop === "notify") {
          return (message: unknown, level?: unknown) => {
            lines.push(String(message));
            try {
              (target as { notify?: (m: unknown, l?: unknown) => void }).notify?.(message, level);
            } catch {
              // A headless or absent UI is not a reason to fail the tool call.
            }
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const ctx = new Proxy(base, {
      get(target, prop, receiver) {
        if (prop === "ui") return ui;
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return { ctx: ctx as ExtensionContext, lines };
  };

  /** Build the `/loop` argument string this tool call stands for. */
  const argsForLoopTool = (params: Record<string, unknown>): string => {
    const action = String(params.action ?? "status").trim().toLowerCase();
    if (action !== "start") return action;

    const parts = ["start", String(params.goal ?? "").trim()];
    if (typeof params.max === "number" && Number.isFinite(params.max)) parts.push(`--max ${Math.max(1, Math.floor(params.max))}`);
    if (typeof params.check === "string" && params.check.trim()) parts.push(`--check ${JSON.stringify(params.check.trim())}`);
    if (params.until_done === true) parts.push("--until-done");
    return parts.join(" ");
  };

  // Guarded: the host may not offer tool registration (an older pi, or a test
  // harness with a partial ExtensionAPI). The command above is the baseline
  // capability; the tool is the addition, and it must not take the extension
  // down with it when it is unavailable.
  if (typeof (pi as { registerTool?: unknown }).registerTool === "function") {
  pi.registerTool({
    name: "loop",
    label: "loop",
    // Every character here is charged on every turn, so it carries only what
    // changes behaviour: what the thing does, that start needs a finish line,
    // and when NOT to reach for it. Measured at 912 chars before this trim.
    description:
      "Iterate toward a goal across turns until it is met. Needs a goal with a finish condition; not for a single answer.",
    // Written as literal JSON Schema rather than built with typebox. typebox is
    // a RUNTIME import, and this package deliberately has none — its only
    // non-relative import is an erased `import type`, which is what keeps
    // `vendor/` free of node_modules and lets `tests/` load this file under
    // plain node. Adding it broke the suite immediately; the schema pi puts on
    // the wire is this object either way.
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", description: "start|stop|status|finish|resume|end" },
        goal: { type: "string", description: 'start: "<goal>. Done when: <criteria>"' },
        max: { type: "number", description: "start: max iterations" },
        check: { type: "string", description: "start: shell command, exit 0 = done" },
        until_done: { type: "boolean", description: "start: stop when check passes" },
      },
      required: ["action"],
      additionalProperties: false,
    } as never,
    execute: async (
      _toolCallId: string,
      params: Record<string, unknown>,
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      baseCtx: ExtensionContext,
    ) => {
      const action = String(params.action ?? "").trim().toLowerCase();
      if (action === "start" && !String(params.goal ?? "").trim()) {
        return {
          content: [{ type: "text", text: 'loop start needs a goal. Give one that says when it is done: "<goal>. Done when: <criteria>".' }],
          isError: true,
        };
      }

      const { ctx, lines } = withCapturedNotices(baseCtx);
      try {
        await loopCommand(argsForLoopTool(params), ctx, { suppressAbort: true });
      } catch (error) {
        return {
          content: [{ type: "text", text: `loop ${action} failed: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }

      // No notice at all means the command took a silent path; say something
      // true rather than returning an empty result the model has to guess at.
      const text = lines.length > 0 ? lines.join("\n") : `loop ${action}: no change reported.`;
      return { content: [{ type: "text", text }] };
    },
  });
  }

  pi.on("session_start", async (_event, ctx) => {
    clearPendingTimer();
    resetContextRecovery();
    restoreState(ctx);
    if (!state.active) return;

    ctx.ui.setStatus("loop", statusBarText(ctx));

    // A soft stop that never finalized (pi exited mid-iteration): stop now instead of resuming.
    if (state.softStopRequested) {
      finalizeSoftStop(pi, ctx, " (finalized after restart)");
      return;
    }

    // Unattended operation: auto-resume an active loop after restart/reload.
    if (["running", "stuck", "retrying"].includes(state.status)) {
      const modelToRestore = state.loopModel || state.rescueReturnModel;
      state.rescueActive = false;
      state.rescueReturnModel = "";
      if (modelToRestore) {
        const model = resolveModel(ctx, modelToRestore);
        if (model) {
          const ok = await pi.setModel(model);
          if (!ok) ctx.ui.notify(`Loop: could not restore model ${modelToRestore} (no API key); using current model.`, "warning");
        } else {
          ctx.ui.notify(`Loop: stored model ${modelToRestore} not found; using current model.`, "warning");
        }
      }
      persistState(pi);
      ctx.ui.notify(`Loop auto-resuming in ${AUTO_RESUME_DELAY_MS / 1000}s: ${snippet(state.description, 80)} (stop with /loop stop)`, "info");
      scheduleLoopTurn(pi, "resume", AUTO_RESUME_DELAY_MS);
    }
  });

  pi.on("session_shutdown", async () => {
    clearPendingTimer();
    resetContextRecovery();
  });

  // Final safety net for /loop finish requested while agent_end awaited checks/model switches.
  pi.on("agent_settled", async (_event, ctx) => {
    if (state.active && state.softStopRequested) {
      finalizeSoftStop(pi, ctx, " (finalized after agent settled)");
      return;
    }
    if (!state.active) return;
    const pending = contextRecoveryPending;
    if (!pending || pending.token !== runToken) return;
    contextRecoveryPending = undefined;
    // "Settled" means no retry, compaction, or queued continuation is left to run, so pi has had its
    // turn at recovering and declined. Now the loop can compact without racing anything.
    ctx.ui.notify("Loop: pi did not recover the context itself — running emergency compaction.", "warning");
    ctx.ui.setStatus("loop", "Loop compacting saturated context");
    logIteration("context_compact", { reason: pending.reason, level: state.contextCompressionLevel });
    requestEmergencyCompaction(pi, ctx, pending.reason);
  });

  pi.on("before_agent_start", async (event) => {
    if (!state.active) return;
    const doneHint = state.untilDone
      ? "use LOOP_DONE: when the completion criteria are fully met"
      : "endless mode: after LOOP_DONE the loop continues with improvements, never stop on your own";
    return {
      systemPrompt:
        `${event.systemPrompt}\n\n` +
        `Loop mode is active. Goal: ${state.description}. Completion criteria: ${state.completionCriteria || "continuous improvement"}. ` +
        `Keep every assistant response under 1,200 characters, do one progress batch per turn, ` +
        `${doneHint}, never wait for a human (make documented assumptions instead), and never dump full logs/diffs/context.`,
    };
  });

  // --- Anti-repetition sampling penalties for a few iterations after a stuck intervention. ---
  // Prompt-level interventions rarely break degenerate repetition; sampling penalties usually do.
  pi.on("before_provider_request", async (event, ctx) => {
    if (!state.active || state.penaltyTurnsRemaining <= 0) return;
    // Penalties are only reliable on OpenAI-compatible completions APIs (vLLM, Ollama, …).
    const api = String((ctx.model as { api?: string } | undefined)?.api ?? "");
    if (api !== "openai-completions") return;
    const payload = event.payload;
    if (!payload || typeof payload !== "object") return;
    const currentTemperature = (payload as { temperature?: number }).temperature;
    return {
      ...(payload as object),
      frequency_penalty: 0.5,
      presence_penalty: 0.5,
      temperature: Math.min(1.3, (currentTemperature ?? 0.7) + 0.2),
    };
  });

  // --- Sanitize degenerate assistant messages, and show the model its own context budget. ---
  // Repeated text or thinking would otherwise reinforce the pattern each turn. The budget notice is
  // appended last, so the cached prefix is untouched and llama.cpp re-prefills only the notice; pi
  // clones the message array for this event, so none of it is ever written to the session.
  pi.on("context", async (event, ctx) => {
    if (!state.active) return;
    let changed = false;
    const messages = event.messages.map((message) => {
      if ((message as { role?: string }).role !== "assistant") return message;
      const sanitized = sanitizeDegenerateMessage(message as { content?: unknown });
      if (!sanitized) return message;
      changed = true;
      return sanitized as typeof message;
    });

    // `.pi/extensions/compaction-guard` injects the same kind of line in every
    // session, loop or not. pi runs `context` handlers in registration order, so
    // whichever of the two runs second must stand down — otherwise a loop
    // session pays for the notice twice and the model is told its budget by two
    // slightly different sentences. Both sides check, so neither ordering breaks.
    const budgetAlreadyPresent = messages.some((message) => {
      const customType = (message as { customType?: unknown } | null)?.customType;
      return typeof customType === "string" && /-context-budget$/.test(customType);
    });
    const budget = budgetAlreadyPresent ? undefined : contextBudgetMessage(contextUsage(ctx));
    if (budget) {
      messages.push(budget as (typeof messages)[number]);
      changed = true;
    }
    return changed ? { messages } : undefined;
  });

  // --- Mid-stream kill switch: abort runaway repetition instead of letting it fill the context. ---
  pi.on("message_start", async (event) => {
    if ((event.message as { role?: string }).role === "assistant") lastDegenerateCheckLength = 0;
  });

  pi.on("message_update", async (event, ctx) => {
    if (!state.active || degenerateAbortPending) return;
    if ((event.message as { role?: string }).role !== "assistant") return;
    const text = messageToRepetitionText(event.message);
    if (text.length - lastDegenerateCheckLength < DEGENERATE_CHECK_INTERVAL) return;
    lastDegenerateCheckLength = text.length;
    const info = detectDegenerateRepetition(text, DEGENERATE_STREAM_REPEATS);
    if (info) {
      degenerateAbortPending = true;
      ctx.ui.notify(`Loop: degenerate ${info.kind} repetition mid-stream (×${info.repeats}) — aborting turn.`, "warning");
      ctx.abort();
    }
  });

  pi.on("tool_result", async (event) => {
    if (!state.active) return;
    const anyEvent = event as unknown as { toolName: string; content?: unknown; result?: { content?: unknown }; isError?: boolean };
    const text = contentToText(anyEvent.content ?? anyEvent.result?.content);
    recordToolResult(anyEvent.toolName, text, Boolean(anyEvent.isError));
    state.toolCallsThisTurn++;
  });

  pi.on("message_end", async (event) => {
    if (!state.active || event.message.role !== "assistant") return;
    const stopReason = (event.message as { stopReason?: string }).stopReason;
    if (stopReason === "error" || stopReason === "aborted") return;
    const sanitizedMessage = sanitizeDegenerateMessage(event.message as { content?: unknown });
    const trackedMessage = sanitizedMessage ?? event.message;
    const tracked = messageToText(trackedMessage) || messageToRepetitionText(trackedMessage);
    if (!tracked.trim()) return;
    pushLimited(state.lastAssistantFingerprints, fingerprint(tracked), 8);
    pushLimited(state.lastAssistantSnippets, snippet(tracked), 5);
    pushLimited(state.lastAssistantTexts, tracked.slice(0, 1_500), 4);
    if (sanitizedMessage) return { message: sanitizedMessage as typeof event.message };
  });

  pi.on("agent_end", async (event, ctx) => {
    if (!state.active) {
      // Goal preparation turn: watch for the readiness marker.
      if (state.status === "preparing") {
        const prepAssistant = [...event.messages].reverse().find((message) => message.role === "assistant");
        const prepText = messageToText(prepAssistant);
        if (/\bGOAL_READY\s*:/i.test(prepText)) {
          state.preparedAt = Date.now();
          state.status = "stopped";
          state.lastNotice = "Goal prepared.";
          persistState(pi);
          ctx.ui.notify(`Goal preparation complete. Review ${state.goalFile}, then start with /loop run [--model M].`, "info");
        }
      }
      return;
    }
    clearPendingTimer();
    // Captured so that a /loop stop|end|start issued while this handler awaits
    // (goal check, model switch …) invalidates the rest of the handler.
    const token = runToken;

    const lastAssistant = [...event.messages].reverse().find((message) => message.role === "assistant") as
      | { role: string; content?: unknown; stopReason?: string; errorMessage?: string; usage?: { output?: number } }
      | undefined;
    const lastAssistantText = messageToText(lastAssistant);
    const lastAssistantRepetitionText = messageToRepetitionText(lastAssistant);
    const stopReason = lastAssistant?.stopReason;

    // --- Soft stop: the just-finished iteration was the last one; do not schedule anything new. ---
    if (state.softStopRequested) {
      if (lastAssistant && stopReason !== "error" && stopReason !== "aborted") state.iterationCount++;
      finalizeSoftStop(pi, ctx);
      return;
    }

    // --- Context pressure: compact without the saturated model, then retry at most twice. ---
    const usage = contextUsage(ctx);
    const contextPercent = usage?.percent ?? null;
    // Nothing said, nothing thought, nothing called. On a saturated context that is starvation, not
    // fixation — routing it here keeps the stuck ladder from answering an out-of-room model with a
    // longer prompt.
    const emptyResponse =
      Boolean(lastAssistant) &&
      !lastAssistantText.trim() &&
      !lastAssistantRepetitionText.trim() &&
      state.toolCallsThisTurn === 0;
    if (
      lastAssistant &&
      isContextPressure({
        stopReason,
        errorMessage: lastAssistant.errorMessage,
        outputTokens: lastAssistant.usage?.output,
        contextPercent,
        emptyResponse,
      })
    ) {
      state.consecutiveErrorCount++;
      state.totalErrorCount++;
      const starved = emptyResponse && stopReason === "stop";
      const reason = snippet(
        lastAssistant.errorMessage ??
          (starved
            ? `empty response at ${Math.round(contextPercent ?? 0)}% context (no text, no thinking, no tool call)`
            : `stop reason ${stopReason}`),
        140,
      );
      // Pressure that survived a recovery means the last summary did not free enough room; the next
      // one is built tighter rather than reproducing a context the model has already refused.
      if (state.consecutiveErrorCount > 1) tightenEmergencySummary();
      if (state.consecutiveErrorCount >= CONTEXT_RECOVERY_ATTEMPTS) {
        enterContextCooldown(pi, ctx, `${state.consecutiveErrorCount} consecutive context failures (${reason})`);
        return;
      }
      state.status = "retrying";
      state.lastNotice = `Context pressure ${state.consecutiveErrorCount}/${CONTEXT_RECOVERY_ATTEMPTS}: ${reason}.`;
      persistState(pi);
      logIteration("context_pressure", { reason, contextPercent, level: state.contextCompressionLevel });
      ctx.ui.notify(
        `Loop: context pressure detected (${state.consecutiveErrorCount}/${CONTEXT_RECOVERY_ATTEMPTS}) — recovering.`,
        "warning",
      );
      ctx.ui.setStatus("loop", "Loop recovering saturated context");
      // Deferred to agent_settled: pi's own overflow recovery runs first and usually handles this.
      contextRecoveryPending = { reason, token: runToken };
      return;
    }

    // --- Model/provider errors: retry with exponential backoff. ---
    if (!lastAssistant || stopReason === "error") {
      state.consecutiveErrorCount++;
      state.totalErrorCount++;
      state.status = "retrying";
      const delay = backoffSeconds();
      const reason = snippet(lastAssistant?.errorMessage ?? lastAssistantText ?? "no assistant message", 140);
      state.lastNotice = `Model/provider error (${reason}); retry #${state.consecutiveErrorCount} in ${delay}s.`;
      persistState(pi);
      logIteration("error", { reason });
      ctx.ui.notify(`Loop: model error, retrying in ${delay}s (attempt ${state.consecutiveErrorCount}): ${reason}`, "warning");
      ctx.ui.setStatus("loop", `Loop retrying in ${delay}s (err #${state.totalErrorCount})`);
      scheduleLoopTurn(pi, "recover", delay * 1000);
      return;
    }

    // --- Degenerate-repetition abort (ours, not the operator's): treat as stuck, keep looping. ---
    if (stopReason === "aborted" && degenerateAbortPending) {
      degenerateAbortPending = false;
      await interveneStuck(pi, ctx, "response degenerated into repeating a sentence, word, or phrase; turn aborted mid-stream");
      return;
    }

    // --- Operator abort (Esc): respect it, but keep state for /loop resume. ---
    if (stopReason === "aborted") {
      state.status = "paused";
      state.lastNotice = "Turn aborted by operator. Use /loop resume to continue.";
      persistState(pi);
      logIteration("operator_abort");
      ctx.ui.notify("Loop paused (turn aborted). Use /loop resume to continue.", "warning");
      ctx.ui.setStatus("loop", "Loop paused (aborted)");
      return;
    }

    state.consecutiveErrorCount = 0;
    // A turn that completed proves the context fits again: retire the recovery ladder entirely.
    state.contextCooldownCount = 0;
    state.contextCompressionLevel = 0;
    contextRecoveryPending = undefined;
    state.iterationCount++;

    // Track narration-only turns (no tool calls at all).
    if (state.toolCallsThisTurn === 0) {
      state.turnsWithoutTools++;
    } else {
      state.turnsWithoutTools = 0;
    }
    state.toolCallsThisTurn = 0;

    // --- Rescue turn finished: hand control back to the regular loop model. ---
    if (state.rescueActive) {
      state.rescueActive = false;
      state.consecutiveStuckCount = 0;
      const returnModel = state.loopModel || state.rescueReturnModel;
      if (returnModel) await switchModel(pi, ctx, returnModel);
      if (!state.active || token !== runToken) return;
      state.rescueReturnModel = "";
      state.status = "running";
      state.lastNotice = "Rescue turn completed; back to loop model.";
      persistState(pi);
      logIteration("rescue_end");
      ctx.ui.setStatus("loop", statusBarText(ctx));
      if (!ctx.hasPendingMessages()) scheduleLoopTurn(pi, "continue", state.delaySeconds * 1000, ctx);
      return;
    }

    // --- Objective goal function (if configured). ---
    let scoreRegressed = false;
    if (state.checkCommand) {
      const outcome = await runGoalCheck(pi);
      if (!state.active || token !== runToken) return;
      if (outcome.execFailed) {
        ctx.ui.notify(`Loop: goal check could not run: ${outcome.output}`, "warning");
      }
      scoreRegressed = applyCheckOutcome(state, outcome);

      // Verified completion: in until-done mode the check decides, not the model.
      if (state.untilDone && outcome.passed && !outcome.execFailed) {
        state.active = false;
        state.status = "completed";
        state.lastNotice = `Goal check passed: ${state.checkCommand}`;
        persistState(pi);
        logIteration("completed", { by: "check" });
        ctx.ui.notify(`Loop completed — goal check passed: ${state.description}`, "info");
        ctx.ui.setStatus("loop", "Loop completed (check passed)");
        return;
      }
    }

    // --- Completion marker. ---
    if (/\bLOOP_DONE\s*:/i.test(lastAssistantText)) {
      state.doneSignalCount++;
      if (state.untilDone) {
        if (state.checkCommand && state.lastCheckPassed === false) {
          state.status = "running";
          state.lastNotice = `LOOP_DONE claimed but goal check fails (streak ${state.checkFailStreak}).`;
          persistState(pi);
          logIteration("check_failed");
          ctx.ui.notify("Loop: LOOP_DONE claimed, but the goal check fails — continuing.", "warning");
          ctx.ui.setStatus("loop", statusBarText(ctx));
          if (!ctx.hasPendingMessages()) scheduleLoopTurn(pi, "check_failed", state.delaySeconds * 1000, ctx);
          return;
        }
        state.active = false;
        state.status = "completed";
        state.lastNotice = "Completion marker seen (until-done mode).";
        persistState(pi);
        logIteration("completed", { by: "marker" });
        ctx.ui.notify(`Loop completed: ${state.description}`, "info");
        ctx.ui.setStatus("loop", "Loop completed");
        return;
      }
      state.status = "running";
      state.lastNotice = `Done signal #${state.doneSignalCount}; continuing with improvements.`;
      persistState(pi);
      logIteration("done");
      ctx.ui.notify(`Loop: goal reported done (#${state.doneSignalCount}); continuing with improvement work.`, "info");
      ctx.ui.setStatus("loop", statusBarText(ctx));
      if (!ctx.hasPendingMessages()) scheduleLoopTurn(pi, "improve", state.delaySeconds * 1000, ctx);
      return;
    }

    // --- Blocked marker: never wait for the operator; force assumptions. ---
    if (/\bLOOP_BLOCKED\s*:/i.test(lastAssistantText)) {
      state.blockedSignalCount++;
      state.status = "running";
      state.lastNotice = `Blocked signal #${state.blockedSignalCount}; instructed to assume and continue.`;
      persistState(pi);
      logIteration("blocked");
      ctx.ui.notify(`Loop: blocked reported (${snippet(lastAssistantText, 120)}); continuing with assumptions.`, "warning");
      ctx.ui.setStatus("loop", statusBarText(ctx));
      if (!ctx.hasPendingMessages()) scheduleLoopTurn(pi, "unblock", state.delaySeconds * 1000, ctx);
      return;
    }

    // --- Optional iteration cap (only when --max was given). ---
    if (state.maxIterations > 0 && state.iterationCount >= state.maxIterations) {
      state.active = false;
      state.status = "paused";
      state.lastNotice = `Paused after max iterations (${state.maxIterations}).`;
      persistState(pi);
      logIteration("max_reached");
      ctx.ui.notify(`Loop paused after ${state.maxIterations} iterations. Use /loop resume [--max N] to continue.`, "warning");
      ctx.ui.setStatus("loop", "Loop paused (max iterations)");
      return;
    }

    // --- Score regression: a change made the objective measure worse. ---
    if (scoreRegressed) {
      state.interventionCount++;
      state.status = "running";
      state.lastNotice = `Score regression: ${state.lastCheckScore} (best ${state.bestCheckScore}).`;
      persistState(pi);
      logIteration("regression");
      ctx.ui.notify(`Loop: goal check score regressed to ${state.lastCheckScore} — requesting fix.`, "warning");
      ctx.ui.setStatus("loop", statusBarText(ctx));
      if (!ctx.hasPendingMessages()) scheduleLoopTurn(pi, "regression", state.delaySeconds * 1000, ctx);
      return;
    }

    // --- Stuck detection: intervene with rotating strategies, never pause. ---
    const stuckReason = detectStuck(lastAssistantText, lastAssistantRepetitionText);
    if (stuckReason) {
      await interveneStuck(pi, ctx, stuckReason);
      return;
    }

    // --- No-progress audit: analysis-only loops must produce artifacts. ---
    if (state.iterationCount - state.lastStateChangeIteration >= NO_PROGRESS_WINDOW) {
      state.lastStateChangeIteration = state.iterationCount;
      state.interventionCount++;
      state.status = "running";
      state.lastNotice = `No concrete changes for ${NO_PROGRESS_WINDOW} iterations; audit nudge sent.`;
      persistState(pi);
      logIteration("audit");
      ctx.ui.notify(`Loop: no concrete progress for ${NO_PROGRESS_WINDOW} iterations — requesting tangible output.`, "warning");
      ctx.ui.setStatus("loop", statusBarText(ctx));
      if (!ctx.hasPendingMessages()) scheduleLoopTurn(pi, "audit", state.delaySeconds * 1000, ctx);
      return;
    }

    // --- Normal continue. ---
    state.consecutiveStuckCount = 0;
    if (state.penaltyTurnsRemaining > 0) state.penaltyTurnsRemaining--;
    state.status = "running";
    state.lastNotice = "";
    persistState(pi);
    logIteration("continue");
    ctx.ui.setStatus("loop", statusBarText(ctx));

    if (!ctx.hasPendingMessages()) {
      scheduleLoopTurn(pi, "continue", state.delaySeconds * 1000, ctx);
    }
  });
}
