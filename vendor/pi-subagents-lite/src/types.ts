import type { Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { AgentSession, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentOutputLog } from "./agents/output-file.js";
import type { AgentTranscript } from "./agents/transcript-entry.js";
import type { LifetimeUsage, AgentUsage } from "./agents/usage.js";
import type { SubagentType, AgentInvocation } from "./agents/types.js";

export type ThinkingLevel = ModelThinkingLevel;

export interface ToolActivity {
  type: "start" | "end";
  toolName: string;
  /** SDK tool call id; absent on synthetic events (e.g. extension-error end). */
  toolCallId?: string;
}

/** Widget live-view state: per-agent transient display data, fed by tool/stream callbacks. */
export interface LiveView {
  activeTools: Map<string, string>; // keyed by toolCallId (see createLiveViewCallbacks)
  responseText: string;
}

/**
 * Resolved model + run-limit tunables shared by every spawn/run shape
 * (RunOptions, SpawnOptions, SpawnIntent). Add a tunable here once and it
 * flows through the whole chain.
 */
export interface RunTunables {
  model?: Model<any>;
  maxTurns?: number;
  maxTokens?: number;
  thinkingLevel?: ThinkingLevel;
  graceTurns?: number;
}

/**
 * Forge fork: what the answer verifier concluded about one settled answer.
 *
 * The three skips are separate values rather than one `skipped` because they
 * are three different problems: nothing was said, the run was cut off before
 * it could say it, or no brief was recorded to check the answer against. The
 * first is usually a saturated context, the second explains itself in the
 * status note, and the third is a fault in the spawn path — one label for all
 * three would hide the only one that is a bug in us.
 */
export type AgentVerification =
  | "skipped-empty"
  | "skipped-cutoff"
  // A run that ended in a provider error. Grouped with the cutoffs by
  // `structuralVerdict` — judging it would spend a model call on text that
  // `executeAgentTool` discards anyway — but it is not the same fact, and it
  // used to wear the cutoff's "⊘ unchecked (cut off)" label. "Cut off" describes
  // a run that was stopped or ran out of turns. This is T4 one layer up: the
  // note there was split from `unparsed`'s for exactly the same reason, that the
  // two facts are different and a human reads the difference.
  | "skipped-error"
  | "skipped-nobrief"
  | "passed"
  | "unparsed"
  | "repaired"
  | "failed"
  | "errored";

/**
 * Forge fork: which verification step is running right now.
 *
 * Both are model calls on the slot the parent is waiting on, and they happen
 * *after* the child's run has settled — status is already terminal and
 * `completedAt` is not set yet, so without this field the record belongs to no
 * widget category at all and the row silently disappears for the duration.
 */
export type VerifyPhase = "judging" | "repairing";

export interface AgentRecord {
  id: string;
  result?: string;
  /**
   * Forge fork: what the answer verifier concluded, or absent when it did not
   * run. Kept on the record rather than only in the text so the widget and the
   * tests can tell "passed" from "was never checked".
   */
  verification?: AgentVerification;
  /**
   * Forge fork: set while the verifier is working, cleared when it settles.
   * Read by the widget to keep the row visible and say what the wait is for.
   */
  verifyPhase?: VerifyPhase;
  error?: string;
  lifecycle: AgentLifecycle;
  display: AgentDisplayInfo;
  execution: AgentExecutionState;
  stats: AgentAccumulatedStats;
}

export interface EnvInfo {
  isGitRepo: boolean;
  branch: string | null;
  platform: string;
}

/**
 * Streaming/callback surface shared by RunOptions and SpawnOptions.
 * Bridges agent-runner events to record tracking and live-view updates.
 */
export interface RunCallbacks {
  onToolActivity?: (activity: ToolActivity) => void;
  onTextDelta?: (delta: string, fullText: string) => void;
  onSessionCreated?: (session: AgentSession) => void;
  onTurnEnd?: (turnCount: number) => void;
  onAssistantUsage?: (usage: AgentUsage) => void;
  onCompaction?: (info: CompactionInfo) => void;
}

/**
 * Coordinator-side spawn config shared by SpawnOptions and SpawnIntent.
 * The resolved run params that both the manager and coordinator agree on;
 * extends RunTunables with display/identity fields.
 */
export interface SpawnConfig extends RunTunables {
  description: string;
  modelKey?: string;
  worktreePath?: string;
  worktreeLabel?: string;
  /**
   * Whether the subagent session treats the target project as trusted.
   * Absent/true = load project resources; false = ignore them (untrusted
   * cross-repo target, resolved by the trust gate).
   */
  projectTrusted?: boolean;
  invocation?: AgentInvocation;
}

/** How many characters of agent ID to show in display. */
export const SHORT_ID_LENGTH = 8;

export type CompactionReason = "manual" | "threshold" | "overflow";

export interface CompactionInfo {
  reason: CompactionReason;
  tokensBefore: number;
  /**
   * The run's agent loop had already emitted `agent_end` when this compaction
   * happened.
   *
   * Forge fork: pi only ever auto-compacts from two places, and both are
   * OUTSIDE the loop — `AgentSession._handlePostAgentRun()`
   * (`agent-session.js:776`), which runs after `agent.prompt()` has resolved,
   * and `AgentSession.prompt()` (`:865`), which runs before the next one
   * starts. The difference decides whether a steer sent from here rides on a
   * turn that was going to happen anyway or MANUFACTURES one — which is T1 and
   * V6's argument about the turn-limit steer, for the other steer in this
   * package. See Z2 in
   * `context/design/subagents-loop-verifier-answers.md`.
   */
  afterRun: boolean;
  /** pi is going to re-run the interrupted turn itself, so a steer still has a turn to ride on. */
  willRetry: boolean;
}

// --- Sub-object interfaces for decomposed AgentRecord ---

export type AgentStatus = "queued" | "running" | "completed" | "turn_limited" | "aborted" | "stopped" | "error";

/** Who initiated an agent stop: "user" via UI menu, "agent" via StopAgent tool, or "watchdog" (stuck-agent detection). */
export type StopInitiator = "user" | "agent" | "watchdog";

/** Structured reason for a watchdog stop: which check fired, and the offending tool for tool kills. */
export type WatchdogStopDetail =
  { kind: "tool"; toolName: string; elapsedMs: number } | { kind: "idle"; elapsedMs: number };

/**
 * Lifecycle state: when the agent started, completed, and its current status.
 * Used by agent-manager (lifecycle control), menus (status display), widget (linger logic).
 */
export interface AgentLifecycle {
  status: AgentStatus;
  startedAt: number;
  completedAt?: number;
  stoppedBy?: StopInitiator;
  /** Reason detail for watchdog stops (tool name + elapsed). Absent for user/agent stops. */
  stopDetail?: WatchdogStopDetail;
  /**
   * Whether the agent ever started running. Set false at spawn, flipped true
   * synchronously in startAgent before the run — distinguishes never-started
   * stops from ran-then-stopped ones so the status note is accurate.
   */
  started: boolean;
}

/**
 * Display-oriented fields: type name, description, output file, invocation params.
 * Used by widget (rendering), menus (listing), renderer (display).
 */
export interface AgentDisplayInfo {
  type: SubagentType;
  description: string;
  /** Path to the streaming output transcript file. */
  outputFile?: string;
  /** Resolved spawn params, captured for UI display. Fixed at spawn time. */
  invocation?: AgentInvocation;
  /** The tool_use_id from the original Agent tool call. */
  toolCallId?: string;
  worktreePath?: string;
  /** Short display label for the worktree (e.g., "feature" or "feature/packages/web"). */
  worktreeLabel?: string;
}

/**
 * Execution internals: session handle, abort controller, pending steers.
 * Used by agent-manager (session lifecycle), tool-execution (steering, nudge).
 */
export interface AgentExecutionState {
  session?: AgentSession;
  /**
   * Forge fork: the prompt this agent was given, kept verbatim.
   *
   * The verifier needs the task to check the answer against, and the anchor
   * needs it to restate after a compaction — and the transcript is exactly
   * where it stops being reliable, because a monotonic summary erodes the
   * oldest thing in it first, which is this. Held outside the session for that
   * reason.
   */
  brief?: string;
  abortController?: AbortController;
  /**
   * Aborts the VERIFICATION, which is a different run from the one above.
   *
   * Forge fork (T5, closed): verification happens inside the settlement chain,
   * after `lifecycle.status` has gone terminal, and every stop path keys off
   * `status === "running"` — so while a judge or a repair was in flight the
   * record was unstoppable. Esc reached `stopAgent()`, which returned false;
   * `StopAgent` the same; and the parent's `Agent` call was blocked on the
   * completion gate, which does not open until verification returns. A 300 s
   * per-call deadline was the only thing that could end that wait.
   *
   * Set for the duration of `runVerification` and cleared in its `finally`, so
   * `stopAgent` has something to abort exactly while `isVerifyingRecord` is
   * true. Aborting it routes through `verifyAnswer`'s catch, which is already the
   * "the verifier failed" path: the child's answer goes out annotated as
   * unchecked rather than being lost.
   */
  verifyAbort?: AbortController;
  /**
   * Completion gate, created at spawn, opened exactly once at the terminal
   * transition; never the run's own promise.
   */
  promise?: Promise<string>;
  /** Steering messages queued before the session was ready. */
  pendingSteers?: string[];
  /** Lifecycle wrapper for the output file stream. */
  outputLog?: AgentOutputLog;
  /**
   * This delegation's turns, as entries in the PARENT's session transcript.
   *
   * Forge fork, twentieth pass. Unlike `outputLog` this is not optional
   * behaviour an operator turns on: the operator asked for a subagent's turns
   * to be in the transcript the rest of the session goes into, and a record of
   * what a delegation did should not depend on somebody having predicted they
   * would want it. `SUBAGENT_TRANSCRIPT=0` turns it off, the way
   * `SUBAGENT_VERIFY_LOG=0` turns off the judge's log.
   */
  transcript?: AgentTranscript;
  /**
   * Model key the spawn reserved a concurrency slot for. Set at spawn; used
   * to re-reserve the slot when a settled agent is continued. Undefined when
   * the spawn had no model key (re-reservation is skipped entirely).
   */
  modelKey?: string;
  /**
   * Forge fork: whether this record is currently occupying a concurrency slot.
   *
   * Set when a run reserves one and cleared when it releases one, which is a
   * wider interval than `status === "running"`: the slot is held right through
   * the verification window, where the status has already gone terminal. It is
   * the only exact answer to "who is in flight", and `setConcurrency()` needs
   * one — it rebuilds the slot map, and used to leave the running agents behind
   * in the objects it dropped, so an in-flight subagent went invisible to the
   * limit and a second one started against PARALLEL_SLOTS=1.
   */
  holdsSlot?: boolean;
  /**
   * Whether the run promise chain has fully settled (its .finally ran).
   * False at spawn and while a continuation is running; true after every
   * settlement. Guards continuation against racing settlement cleanup.
   */
  settled: boolean;
  /**
   * Number of settlements so far (first run = 1, each continuation run
   * increments). Written at the top of the shared settlement chain's
   * .finally, before the completion callback fires, so the coordinator can
   * tell a continuation settlement from the first one. Never-started stops
   * (queued stop, already-aborted spawn) never increment it.
   */
  settlementCount: number;
  /**
   * Spawning-session ExtensionContext, attached by the coordinator at spawn
   * for every spawn. Kept for the record's lifetime so the UI-notify
   * fallback can reach a live context on any later nudge (continuations of
   * foreground agents included). Dies with the record at Clear/dispose.
   */
  spawnCtx?: ExtensionContext;
  /**
   * Lifetime cost already added to the session total (tallyCompletion
   * baseline). Undefined until the first settlement; continuations add only
   * the delta since the last tally.
   */
  talliedCost?: number;
  /**
   * Widget live-view state, attached by the coordinator at spawn. Retained
   * across settlement so a continuation keeps feeding the same view.
   */
  liveView?: LiveView;
  /**
   * Coordinator-supplied live-view bridge (tool activity + streamed text),
   * captured at spawn and re-wired on continuation. Without it the widget
   * would show a static "thinking…" while a continued agent runs.
   */
  liveViewCallbacks?: Pick<RunCallbacks, "onToolActivity" | "onTextDelta">;
}

/**
 * Accumulated statistics: usage breakdown, tool uses, turn count.
 * Used by widget (stats display), tool-execution (details building), menus (result viewer).
 */
export interface AgentAccumulatedStats {
  /**
   * Lifetime usage breakdown, accumulated via `message_end` events. Survives
   * compaction. Total = input + output (see getLifetimeTotal; cacheRead/cacheWrite
   * and cost deliberately excluded — see issue #38). Initialized to zeros at spawn.
   */
  lifetimeUsage: LifetimeUsage;
  /**
   * Forge fork: what the answer verifier itself spent, kept apart from the
   * child's own usage.
   *
   * The judge and each repair are real model calls on the slot the parent is
   * blocked on, and neither was counted anywhere — not on the record, not in
   * `getTotalAgentCost()` — so a verified delegation under-reported itself by
   * one to three calls. Separate rather than folded in, because the question the
   * operator asks is "what did the check cost me", and an answer hidden inside
   * the child's number cannot be asked. Undefined until the verifier spends
   * something, which keeps "never checked" distinguishable from "checked, free".
   */
  verifyUsage?: LifetimeUsage;
  toolUses: number;
  /** Final turn count (set on completion). Used by widget after activity cleanup. */
  turnCount?: number;
  /** Max turns limit (from invocation or default). */
  maxTurns?: number;
  /** Number of times this agent's session has compacted. Initialized to 0 at spawn. */
  compactionCount: number;
  /** Last-known context usage percentage (0–100), captured at completion. */
  contextPercent?: number | null;
}
