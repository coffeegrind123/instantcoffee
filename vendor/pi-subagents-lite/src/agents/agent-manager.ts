/**
 * agent-manager.ts — Tracks agents, per-model concurrency, background execution.
 *
 * Supports per-model and per-provider concurrency limits with queuing.
 */

import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { continueAgentSession, runAgent, type RunResult } from "./agent-runner.js";
import { AgentOutputLog, streamAgentOutput } from "./output-file.ts";
import { AgentTranscript, transcriptEnabled } from "./transcript-entry.ts";
import { Watchdog } from "./watchdog.js";
import { getPiInstance, getStore } from "../shell.js";
import { appendFollowUp, buildAnchorMessage } from "./verify.ts";
import { resolveVerifyRounds, resolveVerifyTimeoutMs, verifyAnswer, type VerifyDeps } from "./verify-runner.ts";
import { appendVerifyLog } from "./verify-log.ts";
import { VERIFIER_AGENT_TYPE } from "./default-agents.js";
import {
  SHORT_ID_LENGTH,
  type AgentRecord,
  type AgentStatus,
  type RunCallbacks,
  type StopInitiator,
  type WatchdogStopDetail,
  type SpawnConfig,
} from "../types.js";
import type { SubagentType } from "./types.js";
import { getAgentConfig } from "./agent-types.js";
import { resolveAgentId, type AgentIdResolution } from "./agent-id.ts";
import { addUsage, emptyUsage, getLifetimeTotal, getSessionContextPercent } from "./usage.js";
import { errorMessage, toSingleLine } from "../utils.js";
import { DEFAULT_CONCURRENCY, DEFAULT_GRACE_TURNS } from "../config/config-io.js";
import { SlotTable, type ConcurrencyConfig, type ConcurrencySlot } from "./concurrency-slots.ts";
import { anchorReachesATurn } from "./compaction-anchor.ts";
import { isVerifyingRecord } from "./record-activity.ts";
import { teardownRecord } from "./record-teardown.ts";
import { undeliveredSteersReport } from "../ui/action-report.ts";

export type { ConcurrencyConfig } from "./concurrency-slots.ts";

export const WATCHDOG_TICK_MS = 5_000;

/** Milliseconds in one minute (config timeout thresholds are stored in minutes). */
const MINUTE_MS = 60_000;

/** Exact error message for queued agents that never start because the manager disposed (US-9). */
const DISPOSE_QUEUED_MESSAGE = "Agent manager disposed before the queued agent could start.";

/** UUID prefix length for agent IDs stored in the agents map (uniqueness). */
const AGENT_ID_PREFIX_LENGTH = 17;

// Forge fork: upstream default is 4. This stack runs llama.cpp with
// PARALLEL_SLOTS=1 — a single slot, so concurrent subagents do not execute
// concurrently. They queue at the server instead, and the queue that forms
// there is the worse of the two: four in-flight sessions each hold their own
// context alive, and four growing prefixes compete for one prompt cache.
//
// Measured, because the obvious version of that claim turned out to be wrong:
// a subagent having its OWN system prompt does not by itself evict the
// parent's cached prefix. The parent held a 99.2% cache hit across six small
// child turns, on :8080 and :8081 alike. What evicts it is SIZE — a child that
// grew to 18k tokens took the parent's next call from 2,117 cached tokens to
// zero, and from 442 ms to 2,949 ms. Serialising children means at most one
// foreign prefix is competing at a time, which is the difference this default
// actually buys. Raise it only if PARALLEL_SLOTS goes up with it; per-provider
// overrides still apply (`concurrency.providers.forge`).
//
// The number itself lives in `config/config-io.ts`, and is read from there
// rather than restated here. It has to be one constant: this file's fallback
// only applies when the caller passes NO concurrency config, and the real wiring
// always passes one (`events.ts` hands the manager `getStore().concurrency`,
// which merges DEFAULT_CONCURRENCY). While the two were separate they diverged —
// this said 1, the config said 4, and 4 is what every session actually ran with,
// which is the state the paragraph above argues against.
const DEFAULT_CONCURRENCY_LIMIT = DEFAULT_CONCURRENCY.default;

/** Whether the agent status is terminal (no longer running or queued). */
function isTerminalStatus(status: AgentStatus): boolean {
  return status !== "running" && status !== "queued";
}

/** A cancellable per-call deadline. See startDeadline. */
interface Deadline {
  /** Forward to the run as its abort signal. */
  signal: AbortSignal;
  /** Throw if the deadline fired. Call once the awaited work has returned. */
  assertNotExpired(): void;
  /** Always call, in a finally — an uncleared timer keeps a handle alive. */
  cancel(): void;
}

/**
 * Forge fork: bound one verification model call in time.
 *
 * Verification runs inside the settlement chain, after the record's status has
 * gone terminal — and every stop path in this file keys off `status ===
 * "running"`. So while a judge or a repair was in flight the record was
 * unstoppable: `stopAgent()` returned false for the operator's Esc and for the
 * `StopAgent` tool alike. Meanwhile the parent's `Agent` tool call is blocked on
 * the completion gate, which does not open until verification returns.
 *
 * That is T5, and it is now closed: `runVerification` creates
 * `record.execution.verifyAbort`, `stopAgent()` recognises a verifying record
 * and aborts it, and `startDeadline` composes that signal with the timer so the
 * call ends on whichever comes first. This deadline stays, and is still the only
 * bound on an UNATTENDED run — nobody presses Esc in a cron job.
 *
 * `checkWatchdogs()` still skips a verifying record, and `Watchdog.check()`
 * deletes its state rather than merely skipping it. That is harmless and stays:
 * the per-call deadline is minutes where the watchdog is 45 of them, and
 * `continueSettledAgent` calls `watchdog.start()` again for any later run.
 *
 * `assertNotExpired()` is separate from the signal on purpose: `runAgent` does
 * not reject when aborted, it returns with `aborted: true` and whatever text
 * arrived. Left at that, a timeout would look like a judge that replied with
 * nothing — which the parser reads as "unparsed", i.e. a pass. Throwing instead
 * routes it to `verifyAnswer`'s catch, which is already the "the verifier
 * failed" path: the answer goes out annotated as unchecked, and the operator is
 * told why.
 */
function startDeadline(label: string, timeoutMs: number, stopSignal?: AbortSignal): Deadline {
  const controller = new AbortController();
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    controller.abort();
  }, timeoutMs);
  // Never hold the process open for a deadline that has outlived its session.
  timer.unref?.();
  // Forge fork (T5): the operator's stop composes with the timer, so the same
  // call is bounded by whichever comes first. Composed here rather than passed
  // through as a second signal because `runAgent`/`continueAgentSession` take
  // one, and because the two outcomes need different sentences below.
  const onStop = () => controller.abort();
  if (stopSignal) {
    if (stopSignal.aborted) controller.abort();
    else stopSignal.addEventListener("abort", onStop, { once: true });
  }
  return {
    signal: controller.signal,
    assertNotExpired: () => {
      if (stopSignal?.aborted) throw new Error(`the ${label} was stopped`);
      if (expired) throw new Error(`the ${label} did not answer within ${Math.round(timeoutMs / 1000)}s`);
    },
    cancel: () => {
      clearTimeout(timer);
      stopSignal?.removeEventListener("abort", onStop);
    },
  };
}

/**
 * The status a settled run has, from its own result.
 *
 * Extracted because there were two callers and only one of them read the whole
 * object. `attachSettlementChain` classified with this expression inline;
 * `buildVerifyDeps.repair` returned `result.responseText` and dropped `aborted`,
 * `turnLimited` and `modelError` on the floor — so the verifier's structural
 * gate, whose whole job is to refuse to judge a run that was cut off, was applied
 * to the child's first run and to nothing else. A repair hard-aborted at
 * `maxTurns + graceTurns` went to the judge as an answer and could go back to the
 * parent labelled "corrected … re-checked", truncated mid-token.
 *
 * One function, so a caller taking a subset has to say so. See V5 in
 * `context/design/subagents-loop-verifier-shapes.md`.
 *
 * Precedence: an abort during a model error wins; a model error outranks a turn
 * limit.
 */
function classifyRun(result: Pick<RunResult, "aborted" | "turnLimited" | "modelError">): AgentStatus {
  if (result.aborted) return "aborted";
  if (result.modelError) return "error";
  if (result.turnLimited) return "turn_limited";
  return "completed";
}

function formatModelError(
  type: SubagentType,
  model: { provider: string; id: string } | undefined,
  providerError: string,
): string {
  const sanitizedError = toSingleLine(providerError);
  return model ? `${type} (${model.provider}/${model.id}): ${sanitizedError}` : `${type}: ${sanitizedError}`;
}

/**
 * Point `streamAgentOutput` at a record's transcript.
 *
 * The wiring is here rather than inside `AgentTranscript` so that module can
 * import neither pi nor the package's `.js`-suffixed siblings — which is what
 * lets the suite load it under bare `node --experimental-strip-types` and test
 * the bounds that an unattended run depends on. Two lines here, one dependency
 * fewer there.
 */
function attachTranscript(
  record: AgentRecord,
  session: Parameters<typeof streamAgentOutput>[0],
  startIndex?: number,
): void {
  const transcript = record.execution.transcript;
  if (!transcript) return;
  try {
    transcript.setCleanup(
      streamAgentOutput(
        session,
        transcript.sink,
        undefined,
        getStore().agent.outputThinkingBufferSize,
        transcript.endTurn,
        // AL1: undefined here means "this session is new", which is true at
        // `onSessionCreated` and false for a continuation. See
        // `streamAgentOutput` for what the wrong answer cost.
        startIndex,
      ),
    );
  } catch {
    // A transcript that cannot be attached is not a reason to fail a spawn.
  }
}

type OnAgentComplete = (record: AgentRecord) => void;
type OnAgentStart = (record: AgentRecord) => void;

interface SpawnArgs {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  type: SubagentType;
  prompt: string;
  options: SpawnOptions;
}

export interface SpawnOptions extends SpawnConfig, RunCallbacks {
  isBackground?: boolean;
  /** Parent abort signal — when aborted, the subagent is also stopped. */
  signal?: AbortSignal;
}

export class AgentManager {
  private agents = new Map<string, AgentRecord>();
  private watchdog = new Watchdog();
  private watchdogInterval: ReturnType<typeof setInterval>;
  private onComplete?: OnAgentComplete;
  private onStart?: OnAgentStart;

  /** Completion-gate resolvers for every spawned record, keyed by agent id. The gate
   * (record.execution.promise) is created at spawn and opened exactly once at the record's
   * terminal transition; the resolver is dropped when the gate opens. Never assigned the
   * run's own promise (gate invariant). */
  private gateResolvers = new Map<string, (value: string) => void>();

  /** Parent-interrupt bindings by record, removed at every terminal transition. */
  private parentBindings = new WeakMap<AgentRecord, { signal: AbortSignal; handler: () => void }>();

  /** Session-level cumulative agent cost. Survives record removal (Clear/dispose). */
  private totalAgentCost = 0;

  /** Session-level completed agent count. Survives record removal (Clear/dispose). */
  private totalAgentCount = 0;

  /**
   * Limits, precedence and running counts. Extracted to `concurrency-slots.ts`
   * so the arithmetic can be tested — this file imports pi and the suite cannot
   * load it. See that module's header for the defect that prompted the move.
   */
  private slots: SlotTable;

  private queue: { id: string; modelKey: string; args: SpawnArgs }[] = [];

  constructor(onComplete?: OnAgentComplete, concurrency?: ConcurrencyConfig, onStart?: OnAgentStart) {
    this.onComplete = onComplete;
    this.onStart = onStart;
    this.slots = new SlotTable(concurrency, DEFAULT_CONCURRENCY_LIMIT);

    this.watchdogInterval = setInterval(() => this.checkWatchdogs(), WATCHDOG_TICK_MS);
    this.watchdogInterval.unref();
  }

  /**
   * Update the concurrency configuration, then rebuild the running counts.
   *
   * The rebuild is the fix, and `concurrency-slots.ts` carries the reasoning:
   * the slot map has to be re-derived on a config change, and it used to take
   * the in-flight agents' counts down with it. The queue is drained afterwards
   * so a newly expanded limit starts something.
   */
  setConcurrency(config: ConcurrencyConfig): void {
    this.slots.setLimits(config, this.agents.values());
    this.drainQueue();
  }

  /** The slot serving a model key. Kept as a method because the probes drive it. */
  private getSlot(modelKey: string): ConcurrencySlot {
    return this.slots.slotFor(modelKey);
  }

  /** Spawn an agent, returning its ID immediately; queued when the concurrency limit is reached. */
  spawn(pi: ExtensionAPI, ctx: ExtensionContext, type: SubagentType, prompt: string, options: SpawnOptions): string {
    const id = randomUUID().slice(0, AGENT_ID_PREFIX_LENGTH);
    const abortController = new AbortController();
    const args: SpawnArgs = { pi, ctx, type, prompt, options };

    let queued = false;
    let concurrencySlot: ConcurrencySlot | undefined;
    if (options.modelKey) {
      const slot = this.getSlot(options.modelKey);
      if (slot.running >= slot.limit) {
        queued = true;
        this.queue.push({ id, modelKey: options.modelKey, args });
      } else {
        concurrencySlot = slot;
      }
    }

    const record: AgentRecord = {
      id,
      lifecycle: {
        status: queued ? "queued" : "running",
        startedAt: Date.now(),
        // Flipped synchronously in startAgent; distinguishes never-started stops.
        started: false,
      },
      display: {
        type,
        description: options.description,
        invocation: options.invocation,
        worktreePath: options.worktreePath,
        worktreeLabel: options.worktreeLabel,
      },
      execution: {
        abortController,
        modelKey: options.modelKey,
        settled: false,
        settlementCount: 0,
        // Forge fork: kept for the verifier and the compaction anchor.
        brief: prompt,
      },
      stats: {
        lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
        toolUses: 0,
        // Forge fork: 0, not 1. `onTurnEnd` writes the RUNNING total, so this is
        // only ever read before the first `turn_end` — and there, "1" is a claim
        // that a turn has finished when none has. A record that fails during
        // setup (bindExtensions rejecting, a model with no auth) settles with
        // this value, and reported one completed turn it never took. Every
        // reader treats it as a count of finished turns: the widget, `/agents`,
        // and `buildAgentDetails`, which the parent model reads.
        turnCount: 0,
        compactionCount: 0,
        maxTurns: options.maxTurns,
      },
    };
    // Capture the coordinator's live-view bridge so a continuation can re-wire
    // tool activity and streamed text into the widget's live view.
    record.execution.liveViewCallbacks = {
      onToolActivity: options.onToolActivity,
      onTextDelta: options.onTextDelta,
    };
    this.agents.set(id, record);

    // Completion gate: every record carries one from birth, opened exactly once
    // at its terminal transition (settlement, queued stop, start failure,
    // already-aborted spawn, dispose, removal).
    record.execution.promise = this.createCompletionGate(id);

    // Parent interrupt binding: registered before the queued early-return so
    // queued subagents are covered too. An already-aborted signal never starts
    // the subagent — it is recorded as stopped immediately instead (ADR-0005).
    if (options.signal) {
      if (options.signal.aborted) {
        // Never-started record: no run will settle it, so stopAgent opens the gate and notifies.
        this.stopAgent(record, "user");
        return id;
      }
      const handler = () => this.abort(id, "user");
      options.signal.addEventListener("abort", handler, { once: true });
      this.parentBindings.set(record, { signal: options.signal, handler });
    }

    if (queued) return id;

    // startAgent can throw — clean up record so callers don't see an orphan
    try {
      this.startAgent(id, record, args, concurrencySlot);
    } catch (err) {
      // A start that threw after reserving used to leak the slot for the life of
      // the process; releaseSlot is a no-op when nothing was reserved.
      this.slots.release(record);
      this.detachParentBinding(record);
      this.openGate(id, "");
      this.agents.delete(id);
      throw err;
    }
    return id;
  }

  /**
   * Forge fork: the model calls the verifier needs, or undefined to skip it.
   *
   * Two different sessions on purpose, and the asymmetry is the design:
   *
   * - **judge** runs as a fresh `__verifier` agent — no tools, no extensions,
   *   no skills, one turn — and is shown only the task and the answer. Asking
   *   the child to review its own work is the weakest check available, because
   *   every step that led it astray is in its context with a justification
   *   attached, and a model handed its own reasoning ratifies it. The judge is
   *   harder to fool because it knows less.
   * - **repair** goes the other way and continues the CHILD's session, which is
   *   the only place with the context to actually fix the answer.
   *
   * Returns undefined for the verifier's own runs — a judge that spawns a judge
   * does not terminate. That is a structural fact about the record and is
   * decided here.
   *
   * Forge fork: `SUBAGENT_VERIFY` is NOT read here. This runs when the child
   * STARTS, while `SUBAGENT_VERIFY_ROUNDS` and `SUBAGENT_VERIFY_TIMEOUT_MS` are
   * read when it SETTLES — so of three switches over one feature, one was
   * captured minutes earlier than the other two, and an operator turning
   * verification off during a long delegation still got a verification. All
   * three are now read at the same moment, in `runVerification`.
   */
  private buildVerifyDeps(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    record: AgentRecord,
  ): VerifyDeps | undefined {
    if (record.display.type === VERIFIER_AGENT_TYPE) return undefined;

    return {
      judge: async (prompt: string) => {
        // runAgent directly, NOT this.spawn(): verification happens inside the
        // settlement chain's .then, and the child's concurrency slot is only
        // released in the .finally that follows it. A judge that asked for a
        // slot would wait for a slot that is waiting for the judge, and with
        // the fork's default of 1 that is a deadlock rather than a slowdown.
        //
        // Going around spawn() also means going around every teardown spawn()
        // would have arranged: no record, so nothing in dispose() or clear()
        // ever reaches this session. Disposing it here is the whole cleanup —
        // without it every judged answer leaks one AgentSession, its message
        // history and its bound extensions, for the life of the process. The
        // dispose is in the `finally` so a deadline that fires still tears down.
        //
        // The session is captured at CREATION, not read off the result. It used
        // to be `result?.session?.dispose()`, and `result` is only assigned when
        // the await RESOLVES — so every rejection after `createAgentSession()`
        // had returned (bindExtensions throwing, session.prompt() rejecting on a
        // provider fault) dropped the only reference to a live session. That is
        // exactly the leak the paragraph above is about, on the one exit it did
        // not cover. A timeout was never the problem: the deadline aborts the
        // signal, prompt() resolves, and assertNotExpired() throws afterwards.
        // See V7 in context/design/subagents-loop-verifier-shapes.md.
        //
        // `onSessionCreated` now really does fire before `bindExtensions`, which
        // is what V7 claimed and W6 found was not true: it was the last line of
        // `createAndConfigureSession`, below the bind and the tool filtering, so
        // the bindExtensions exit named above stayed uncovered for another pass.
        // See W6 in context/design/subagents-loop-verifier-readers.md.
        const deadline = startDeadline(
          "verifier",
          resolveVerifyTimeoutMs(process.env.SUBAGENT_VERIFY_TIMEOUT_MS),
          record.execution.verifyAbort?.signal,
        );
        let judgeSession: { dispose(): void } | undefined;
        try {
          const result = await runAgent(ctx, VERIFIER_AGENT_TYPE, prompt, {
            pi,
            maxTurns: 1,
            signal: deadline.signal,
            onSessionCreated: (session) => {
              judgeSession = session;
            },
            // Without this the judge's cost landed nowhere at all — not on the
            // record, not in the session total — so a verified delegation
            // under-reported itself by a whole model call.
            //
            // It goes to `verifyUsage`, not `lifetimeUsage`, and the split is
            // exact rather than aesthetic: `lifetimeUsage` is what the CHILD's
            // session spent (its run, and any repair turn, which really is the
            // child's own turn in its own window), `verifyUsage` is what the
            // verifier spent in sessions of its own. Nothing is in both, and
            // `tallyCompletion` adds them.
            onAssistantUsage: (usage) => {
              record.stats.verifyUsage ??= emptyUsage();
              addUsage(record.stats.verifyUsage, usage);
            },
          });
          deadline.assertNotExpired();
          return result.responseText;
        } finally {
          deadline.cancel();
          try {
            judgeSession?.dispose();
          } catch {
            // A judge that answered is worth more than a tidy teardown.
          }
        }
      },
      repair: async (prompt: string) => {
        const session = record.execution.session;
        if (!session) throw new Error("the subagent's session is gone");
        const deadline = startDeadline(
          "repair",
          resolveVerifyTimeoutMs(process.env.SUBAGENT_VERIFY_TIMEOUT_MS),
          record.execution.verifyAbort?.signal,
        );
        // Captured ONCE, before the run, exactly as continueSettledAgent does.
        // `onTurnEnd` fires per turn with the RUNNING total (1, then 2, then 3),
        // so the previous form — `record.stats.turnCount = (record.stats.turnCount
        // ?? 0) + turnCount` — re-read the field it was writing and accumulated
        // 1+2+3+…: a five-turn repair took a record from 5 to 20 instead of 10.
        // A one-turn repair was correct, which is why it stayed invisible; a
        // repair runs more than one turn whenever the child uses a tool before
        // answering, because `maxTurns: 1` sends no wrap-up steer (T1) and pi's
        // loop keeps going while there are tool results.
        const previousTurns = record.stats.turnCount ?? 0;
        try {
          const result = await continueAgentSession(session, prompt, {
            maxTurns: 1,
            // The operator's setting, like every other run in this file. This was
            // the one place that hardcoded the default, so an operator who set
            // grace turns to 0 in /agents got 0 for the child's run and for a
            // steer, and 6 inside the verifier.
            graceTurns: getStore().agent.graceTurns ?? DEFAULT_GRACE_TURNS,
            signal: deadline.signal,
            // A repair is a real turn in the child's own session: it uses tools,
            // it counts against the child's window, and it can compact. Running
            // it without the tracking callbacks meant none of that was recorded
            // — and, worse, `onCompaction` is what fires the task anchor, so the
            // one turn most likely to compact (the child is already near the end
            // of its window; that is usually why it drifted) was the one turn
            // with the anchor switched off. Its usage lands in `lifetimeUsage`
            // rather than `verifyUsage` because it is the child spending the
            // child's window; see the judge above for the split.
            ...this.runTrackingCallbacks(record, record.execution.liveViewCallbacks, (turnCount) => {
              record.stats.turnCount = previousTurns + turnCount;
            }),
          });
          deadline.assertNotExpired();
          // The whole result, classified the same way the settlement chain
          // classifies the child's own run. It used to be `result.responseText`
          // alone, so a repair that was hard-aborted at maxTurns + graceTurns,
          // or that died on the provider, reached the judge as an ordinary answer
          // — and the structural gate, which exists to refuse to judge exactly
          // that, had no way to see it. See classifyRun and V5.
          return { text: result.responseText, status: classifyRun(result) };
        } finally {
          deadline.cancel();
        }
      },
      notify: (message: string) => {
        try {
          ctx.ui?.notify?.(`[subagents] ${message}`, "info");
        } catch {
          // Headless is fine; the verdict still applied.
        }
      },
      // The widget polls the record, so writing the field is the whole update.
      onPhase: (phase) => {
        record.verifyPhase = phase;
      },
      // Forge fork, fifteenth pass: the judge's raw reply, kept. It has been the
      // #1 item on the "still unwatched" list since the fourth pass, and it is
      // what four earlier findings (S2, U4, V5, W5) each needed a probe to
      // establish — every one of them a claim about a string that existed for a
      // few milliseconds inside `verifyAnswer` and was then dropped.
      //
      // The record's own identity is added here rather than in `verifyAnswer`,
      // which has no idea what it is checking; the module is what owns the file,
      // the bounds and the switch. It never throws.
      log: (entry) => {
        appendVerifyLog({ ...entry, agentId: record.id, agentType: record.display.type });
        // …and into the session transcript, so the judge's question and its
        // answer sit next to the turns they are about rather than in a third
        // file. This is the half of the operator's request that also closes
        // item 12 of the still-unwatched list: a real prompt and a real reply,
        // in a place somebody is already reading.
        record.execution.transcript?.verify(
          entry.phase === "repair" ? "repair" : "verify",
          entry.prompt,
          entry.reply,
        );
      },
    };
  }

  /**
   * Run the verifier over a settled record, in place.
   *
   * Rewrites `record.result` so every reader — the foreground tool result, the
   * background nudge, the widget, the completion gate — sees the same checked
   * answer. There is deliberately no second copy of the original: two answers in
   * the tree is how a parent ends up quoting the one that failed.
   */
  private async runVerification(record: AgentRecord, deps: VerifyDeps | undefined): Promise<void> {
    if (!deps) return;
    // All three switches read here, at the same moment. This one used to be read
    // in `buildVerifyDeps`, which runs when the child STARTS — see there.
    if (process.env.SUBAGENT_VERIFY === "0") return;
    const brief = record.execution.brief ?? "";
    // T5, closed. The record's status is already terminal, so `stopAgent()`'s
    // `status === "running"` test cannot see this work; this controller is what
    // it aborts instead. Created before the first model call and cleared in the
    // `finally`, so it exists exactly while `isVerifyingRecord` is true.
    record.execution.verifyAbort = new AbortController();
    try {
      // Read per call, not cached at construction: an operator who changes the
      // budget between sessions should not have to reason about when it was
      // captured, and this runs once per settled subagent.
      const rounds = resolveVerifyRounds(process.env.SUBAGENT_VERIFY_ROUNDS);
      const outcome = await verifyAnswer(record, brief, deps, { rounds });
      record.verification = outcome.status;
      record.result = outcome.answer;
    } catch (error) {
      // `verifyAnswer` is documented as never throwing, and it is careful about
      // it — but only inside its own try, which starts AFTER the structural
      // gate, the brief check and clampRounds. A throw from that prologue, or
      // from anything added here later, does not stay local: this runs inside
      // `attachSettlementChain`'s `.then`, so it lands in the `.catch` below,
      // which sets `record.result = undefined` and `status = "error"`. A
      // finished subagent's answer would be discarded and its run reported to
      // the parent as a failure, because the CHECK broke.
      //
      // The whole failure policy of this layer is that an unverified answer
      // beats no answer, so the answer is left exactly as the run produced it
      // and the verdict says the check did not happen.
      record.verification = "errored";
      try {
        deps.notify?.(`Subagent answer went out unchecked — the verifier failed: ${errorMessage(error)}`);
      } catch {
        // Headless is fine; the answer is still intact.
      }
    } finally {
      // verifyAnswer clears the phase itself on every path it owns; this is the
      // backstop for the one it does not — a throw from outside its own try.
      record.verifyPhase = undefined;
      record.execution.verifyAbort = undefined;
    }
  }

  /** Start an agent now or from queue drain; manages the slot's running count when one is held. */
  private startAgent(
    id: string,
    record: AgentRecord,
    { pi, ctx, type, prompt, options }: SpawnArgs,
    concurrencySlot?: ConcurrencySlot,
  ) {
    if (concurrencySlot) this.slots.reserve(record);

    record.lifecycle.status = "running";
    record.lifecycle.startedAt = Date.now();
    // Set synchronously before the run so a stop before the session exists
    // still renders as ran-then-stopped, not never-started.
    record.lifecycle.started = true;
    // The idle clock starts here, so a hung pre-session init phase is covered.
    this.watchdog.start(id);

    // Output transcript: agent frontmatter overrides the global setting (default false).
    const agentConfig = getAgentConfig(type);
    const outputTranscript = agentConfig?.outputTranscript ?? getStore().agent.outputTranscript;
    if (outputTranscript) {
      record.execution.outputLog = new AgentOutputLog(id, prompt, undefined, getStore().agent.outputThinkingBufferSize);
      record.display.outputFile = record.execution.outputLog.path;
    }

    // Forge fork, twentieth pass: the same turns, in the operator's own session
    // transcript, marked as a subagent's. Not behind `outputTranscript` — that
    // switch is about a file in /tmp, and this is about the record of what
    // happened being where the rest of the record is. `getPiInstance()` is the
    // PARENT's pi on purpose: the child's own is bound to a session that is
    // thrown away.
    if (transcriptEnabled()) {
      const parentPi = getPiInstance();
      if (parentPi) {
        const transcript = new AgentTranscript(parentPi, id, type);
        record.execution.transcript = transcript;
        transcript.brief(prompt, options.description);
      }
    }

    this.onStart?.(record);

    const promise = runAgent(ctx, type, prompt, {
      pi,
      agentId: id,
      model: options.model,
      maxTurns: options.maxTurns,
      maxTokens: options.maxTokens,
      thinkingLevel: options.thinkingLevel,
      cwd: options.worktreePath,
      graceTurns: options.graceTurns,
      projectTrusted: options.projectTrusted,
      signal: record.execution.abortController!.signal,
      ...this.runTrackingCallbacks(record, options, (turnCount) => {
        record.stats.turnCount = turnCount;
        options.onTurnEnd?.(turnCount);
      }),
      onSessionCreated: (session) => {
        record.execution.session = session;
        attachTranscript(record, session);
        // Flush any steers that arrived before the session was ready
        if (record.execution.pendingSteers?.length) {
          for (const msg of record.execution.pendingSteers) {
            session.steer(msg).catch(() => {
              // Steer is advisory — a failure here (e.g. session already aborting)
              // is fine; the user can re-send if needed.
            });
          }
          record.execution.pendingSteers = undefined;
        }
        if (record.execution.outputLog) {
          record.execution.outputLog.attach(session);
        }
        options.onSessionCreated?.(session);
      },
    });
    this.attachSettlementChain(record, promise, this.buildVerifyDeps(pi, ctx, record));
  }

  /**
   * Wire the shared settlement chain (status precedence, error formatting,
   * tally, slot release, gate open) onto a run promise. Used by both the
   * first run (startAgent) and continuations (continueSettledAgent) so the two paths
   * cannot drift. openGate is idempotent, so a continuation's second call
   * is a no-op — the gate resolver is dropped at the first settlement.
   */
  private attachSettlementChain(
    record: AgentRecord,
    runPromise: Promise<RunResult>,
    verifyDeps?: VerifyDeps,
  ) {
    runPromise
      .then(async ({ responseText, session, aborted, turnLimited, modelError }) => {
        // Don't overwrite status if externally stopped via abort()
        if (record.lifecycle.status !== "stopped") {
          record.lifecycle.status = classifyRun({ aborted, turnLimited, modelError });
        }
        record.result = responseText;
        // Forge fork: check the answer against the task before anyone reads it.
        // Inside this .then rather than chained after it, so the try/catch in
        // verifyAnswer is the only failure path — a broken verifier must never
        // turn a finished subagent into a failed one.
        await this.runVerification(record, verifyDeps);
        if (modelError) {
          record.error = formatModelError(record.display.type, session?.model, modelError);
        }
        record.execution.session = session;
        record.stats.contextPercent = getSessionContextPercent(session);
        record.lifecycle.completedAt ??= Date.now();
        return responseText;
      })
      .catch((err) => {
        // Don't overwrite status if externally stopped via abort()
        if (record.lifecycle.status !== "stopped") {
          record.lifecycle.status = "error";
        }
        // A failed continuation must not leave the prior run's result visible.
        record.result = undefined;
        record.error = errorMessage(err);
        record.lifecycle.completedAt ??= Date.now();
        return "";
      })
      .finally(() => {
        // Count this settlement before notifying, so the completion callback
        // can tell a continuation settlement (>= 2) from the first one.
        record.execution.settlementCount++;
        // AI3: a steer queued for a session that was never created. See
        // `undeliveredSteersReport` for what was promised and by whom.
        this.reportUndeliveredSteers(record);
        // Before the output log, so the transcript's closing entry and the
        // file's DONE line report the same numbers rather than two readings a
        // few statements apart.
        this.finalizeTranscript(record);
        if (record.execution.outputLog) {
          try {
            record.execution.outputLog.finalize({
              turnCount: record.stats.turnCount ?? 0,
              toolUseCount: record.stats.toolUses,
              totalTokens: getLifetimeTotal(record.stats.lifetimeUsage),
            });
          } catch {
            /* ignore */
          }
          record.execution.outputLog = undefined;
        }

        this.slots.release(record);

        this.tallyCompletion(record);
        this.drainQueue();
        // Detach before opening the gate so an abort racing settlement cannot
        // re-target the record, and the coordinator's await resumes only after
        // the result text is captured and the completion notify has fired.
        this.detachParentBinding(record);
        this.openGate(record.id, record.result ?? "");
        // The run chain is fully settled: a continuation may now re-reserve
        // the slot and prompt the session again.
        record.execution.settled = true;
      });
  }

  /**
   * Say that a queued steer never reached a model, and drop it.
   *
   * Forge fork, eighteenth pass (AI3). `steer()` answers `true` for a steer it
   * parks in `record.execution.pendingSteers`, on the promise in its own comment
   * — *"Queued, so it WILL reach the model — onSessionCreated flushes it"* — and
   * `onSessionCreated` is the one thing a run that dies during setup never
   * reaches. `runAgentImpl` builds a `SettingsManager`, resolves the system
   * prompt sources, runs `detectEnv` (two git subprocesses on a 9p mount) and
   * then `reloadAndMap()`, which calls every extension factory; that is seconds,
   * and `record.lifecycle.status` is `running` throughout it.
   *
   * Reported on the same two channels every other undelivered thing in this
   * package uses — `console.warn`, which exists headless, and the spawning
   * session's own context. The queue is cleared afterwards so a continuation of
   * the same record cannot report it twice.
   *
   * The brief is deliberately left alone. `growBrief` recorded the steer when it
   * was accepted, and the honest repair for that is the sentence, not a rewrite:
   * un-growing it would silently change what the verifier checks against on a
   * record whose run is already over, and the note says the answer was not
   * written with them.
   */
  /**
   * Close this run's transcript with one line saying how it ended.
   *
   * Called from the settlement chain's `finally`, which is the one place every
   * exit reaches — a completed run, a provider error, an abort, a watchdog
   * stop and a dispose all pass through it. Anything narrower would leave a
   * transcript that simply stops, which reads as a delegation that is still
   * going.
   */
  private finalizeTranscript(record: AgentRecord): void {
    const transcript = record.execution.transcript;
    if (!transcript) return;
    const verification = record.verification ? `, check ${record.verification}` : "";
    const error = record.error ? ` — ${toSingleLine(record.error)}` : "";
    transcript.finalize(
      `${record.display.type} ${record.lifecycle.status}: ${record.stats.turnCount ?? 0} turn(s), ` +
        `${record.stats.toolUses} tool use(s), ${getLifetimeTotal(record.stats.lifetimeUsage)} token(s)` +
        `${verification}${error}`,
    );
    record.execution.transcript = undefined;
  }

  private reportUndeliveredSteers(record: AgentRecord): void {
    const pending = record.execution.pendingSteers;
    if (!pending || pending.length === 0) return;
    record.execution.pendingSteers = undefined;
    const report = undeliveredSteersReport(pending.length, record.id.slice(0, SHORT_ID_LENGTH));
    console.warn(`[pi-subagents-lite] ${report.text}`);
    try {
      record.execution.spawnCtx?.ui?.notify?.(report.text, report.level);
    } catch {
      // A session that is going away is exactly the case here; the line above is
      // the record.
    }
  }

  private createCompletionGate(id: string): Promise<string> {
    let resolve!: (value: string) => void;
    const gate = new Promise<string>((res) => {
      resolve = res;
    });
    this.gateResolvers.set(id, resolve);
    return gate;
  }

  /** Open a record's completion gate. Idempotent — the resolver is dropped on first open. */
  private openGate(id: string, value: string): void {
    const resolve = this.gateResolvers.get(id);
    if (!resolve) return;
    this.gateResolvers.delete(id);
    resolve(value);
  }

  /** Remove a record's parent-interrupt binding; a later abort of the signal is a no-op. */
  private detachParentBinding(record: AgentRecord): void {
    const binding = this.parentBindings.get(record);
    if (!binding) return;
    this.parentBindings.delete(record);
    binding.signal.removeEventListener("abort", binding.handler);
  }

  private notifyComplete(record: AgentRecord): void {
    try {
      this.onComplete?.(record);
    } catch {
      /* ignore */
    }
  }

  private tallyCompletion(record: AgentRecord): void {
    // Usage is monotonic (addUsage only accumulates), so the delta from the
    // last tally is the cost this run added. The first tally (talliedCost
    // undefined) also counts the agent; continuations never double-count.
    //
    // Both accumulators, because they partition the spend rather than overlap:
    // lifetimeUsage is the child's own session, verifyUsage is the judge's.
    // Counting only the first hid every judge call from the session total.
    const cost = record.stats.lifetimeUsage.cost + (record.stats.verifyUsage?.cost ?? 0);
    const baseline = record.execution.talliedCost ?? 0;
    this.totalAgentCost += cost - baseline;
    const firstTally = record.execution.talliedCost === undefined;
    record.execution.talliedCost = cost;
    if (firstTally) this.totalAgentCount++;
    this.notifyComplete(record);
  }

  setOnComplete(cb: OnAgentComplete): void {
    this.onComplete = cb;
  }

  /**
   * Told whenever a record starts running — a first run or a continuation.
   *
   * Forge fork, twenty-first pass (AL5). `onStart` was a constructor parameter
   * with no setter, and `ensureManagerAndWidget` passed `undefined` for it, so
   * the hook `startAgent` has always called was wired to nothing. It is wired
   * now, and it is what re-arms the widget's refresh poll — which is only safe
   * to stop because this exists.
   */
  setOnStart(cb: OnAgentStart): void {
    this.onStart = cb;
  }

  /** Get the session-level cumulative agent cost. Survives record removal (Clear/dispose). */
  getTotalAgentCost(): number {
    return this.totalAgentCost;
  }

  /** Get the session-level completed agent count. Survives record removal (Clear/dispose). */
  getTotalAgentCount(): number {
    return this.totalAgentCount;
  }

  /**
   * Callback set shared by a first run and a continuation: accumulates stats
   * on the record, feeds the watchdog, and forwards to the caller's own
   * callbacks. writeTurnCount is the per-path policy — the first run records
   * the absolute count, a continuation adds to the previous total.
   */
  private runTrackingCallbacks(
    record: AgentRecord,
    forward: RunCallbacks | undefined,
    writeTurnCount: (turnCount: number) => void,
  ): RunCallbacks {
    return {
      onToolActivity: (activity) => {
        if (activity.type === "end") record.stats.toolUses++;
        this.watchdog.recordActivity(record.id, activity);
        forward?.onToolActivity?.(activity);
      },
      onAssistantUsage: (usage) => {
        addUsage(record.stats.lifetimeUsage, usage);
        forward?.onAssistantUsage?.(usage);
      },
      onCompaction: (info) => {
        record.stats.compactionCount++;
        // Forge fork: the anchor. pi merges each summary into the last under a
        // "PRESERVE all existing information" prompt, so a summary grows and
        // what it erodes first is the oldest thing in the transcript — the task
        // the child was given. Restating it here costs ~50 tokens in a context
        // that was just cleared, and it is the difference between a child that
        // finishes the job and one that answers a question which has quietly
        // drifted. Prevention; the verifier at settle is only the backstop.
        const brief = record.execution.brief;
        const session = record.execution.session;
        // Forge fork: …but only into a run that is still going.
        //
        // `session.steer()` is not a way to put text in a context, it is a way
        // to put text in a context AND get an answer to it: pi drains the
        // steering queue at the top of its agent loop, and when the loop has
        // already finished `_handlePostAgentRun()` restarts it precisely because
        // the queue is not empty (`agent-session.js:776` → `agent.continue()` →
        // `Agent.continue()`'s assistant-last branch, which drains steering and
        // runs it as a prompt). pi's only two auto-compaction call sites are
        // both outside the loop, and the one that fires at the END of a run —
        // any child that finishes above pi's compaction threshold — therefore
        // bought an extra model call on the one llama slot the parent is blocked
        // on, AND the reply to it became the child's answer. Measured against
        // the shipped `runSessionPrompt`: a child that had answered handed its
        // parent "Understood — nothing further to add."
        //
        // This is T1 and V6's argument for the other steer in this package —
        // "there is no wrap-up to ask for, and asking manufactures a turn" —
        // applied to the one nobody had asked it about. `willRetry` is the
        // exception and it is the same rule: pi is going to re-run the
        // interrupted turn itself, so the anchor rides on a turn that was
        // already coming, which is exactly what it is for. See Z2 in
        // `context/design/subagents-loop-verifier-answers.md`.
        if (brief && session && anchorReachesATurn(info)) {
          // Advisory, like every other steer here: a session that is already
          // tearing down is not a reason to fail the run.
          void session.steer(buildAnchorMessage(brief)).catch(() => {});
        }
        forward?.onCompaction?.(info);
      },
      onTextDelta: (delta: string, fullText: string) => {
        // Streamed response text counts as activity for the idle watchdog.
        this.watchdog.recordText(record.id);
        forward?.onTextDelta?.(delta, fullText);
      },
      onTurnEnd: writeTurnCount,
    };
  }

  private drainQueue() {
    const started = new Set<string>();
    for (const entry of this.queue) {
      const record = this.agents.get(entry.id);
      if (!record || record.lifecycle.status !== "queued") continue;

      const slot = this.getSlot(entry.modelKey);
      if (slot.running >= slot.limit) continue;

      try {
        this.startAgent(entry.id, record, entry.args, slot);
        started.add(entry.id);
      } catch (err) {
        // Late failure — surface on the record so the user can see it
        this.slots.release(record);
        record.lifecycle.status = "error";
        record.error = errorMessage(err);
        record.lifecycle.completedAt = Date.now();
        this.detachParentBinding(record);
        this.openGate(record.id, "");
        started.add(entry.id);
        // Failed starts notify the UI but aren't tallied as completed agents
        this.notifyComplete(record);
      }
    }
    this.queue = this.queue.filter((e) => !started.has(e.id));
  }

  /**
   * Steer a running agent; queues the message when the session isn't created
   * yet. A settled agent (completed, errored, aborted, stopped, turn-limited)
   * with a live session is continued: the concurrency slot is re-reserved,
   * the record is reset to running, and the session is prompted again.
   */
  async steer(id: string, message: string): Promise<boolean> {
    const record = this.agents.get(id);
    if (!record) return false;

    if (record.lifecycle.status === "running") {
      if (!record.execution.session) {
        if (!record.execution.pendingSteers) record.execution.pendingSteers = [];
        record.execution.pendingSteers.push(message);
        // Queued, so it WILL reach the model — onSessionCreated flushes it.
        this.growBrief(record, message);
        return true;
      }

      try {
        await record.execution.session.steer(message);
        // Only after it went. A steer that threw never reached the model, and a
        // brief that claims otherwise is the same defect one direction over.
        this.growBrief(record, message);
        return true;
      } catch {
        // steer failures are surfaced to the caller via the boolean return value
        return false;
      }
    }
    return this.continueSettledAgent(record, message);
  }

  /**
   * Forge fork: the brief grows with the task, on EVERY branch of `steer()`.
   *
   * `continueSettledAgent` has done this since the fork landed, and its comment
   * says why: an answer to the steer judged against the original prompt comes
   * back NOT_ADDRESSED, and the repair then tells the child "This is the task, in
   * full, as it was given to you: <the original>. Answer it now" — the operator's
   * instruction undone by the layer that exists to catch drift, and labelled
   * `✎ repaired`, which reads as an improvement.
   *
   * The branch above never called it, so all of that was true for a RUNNING
   * agent — which is not the obscure case. `conversation-viewer.ts` picks its
   * verb with `this.isActive() ? "steer" : "continue"`, so "steer" IS the running
   * one, and the /agents running-agents menu offers the same action.
   *
   * Three readers take this field and all three were given the wrong text: the
   * judge (what the answer is checked against), `buildRepairPrompt` (what the
   * child is told to answer instead), and `buildAnchorMessage` (what is restated
   * into a context that was just compacted — the one place a drifting child's
   * task has most likely gone missing). See W3 in
   * `context/design/subagents-loop-verifier-readers.md`.
   */
  private growBrief(record: AgentRecord, message: string): void {
    record.execution.brief = appendFollowUp(record.execution.brief, message);
  }

  /**
   * Continue a settled agent: re-reserve the concurrency slot, reset the
   * record to running, and prompt the session again. Returns false when the
   * record cannot be continued (still settling, no session, streaming, or
   * the model's concurrency slot is full).
   */
  private continueSettledAgent(record: AgentRecord, message: string): boolean {
    // settled flips to true only after the previous run chain's .finally, so
    // a continuation cannot race the settlement cleanup (slot release, gate).
    if (!record.execution.settled) return false;
    const session = record.execution.session;
    if (!session) return false;
    // Defensive: a streaming session is mid-response and cannot be prompted.
    if (session.isStreaming) return false;

    // Re-reserve the concurrency slot (reject when full, don't queue). Skip
    // entirely when the spawn had no model key — the record never held a slot.
    let concurrencySlot: ConcurrencySlot | undefined;
    const modelKey = record.execution.modelKey;
    if (modelKey) {
      const slot = this.getSlot(modelKey);
      if (slot.running >= slot.limit) return false;
      concurrencySlot = slot;
    }
    if (concurrencySlot) this.slots.reserve(record);

    // Forge fork: the brief the verifier and the anchor check against has to
    // grow with the task, or the continuation is checked against a question it
    // was not asked.
    //
    // `brief` was written once, at spawn, and never updated. So steering a
    // settled agent — the /agents menu's steer action, or the viewer's steer box
    // — produced an answer to the STEER, judged against the ORIGINAL prompt. The
    // judge said NOT_ADDRESSED, correctly, and the repair then told the child
    // "This is the task, in full, as it was given to you: <the original>. Answer
    // it now" — actively undoing the operator's instruction, and labelling the
    // result `✎ repaired`, which reads as an improvement.
    //
    // Appended rather than replaced: a follow-up almost always presupposes the
    // original task ("now also list the callers"), so replacing would lose the
    // half the answer still has to satisfy. The anchor reads the same field, and
    // wants the same thing after a compaction.
    //
    // `steer()`'s running branches do the same thing through `growBrief` — this
    // used to be the only path that did, which was W3.
    this.growBrief(record, message);

    // Forge fork: a verdict describes one answer. The new answer has not been
    // checked yet, and may never be — verification is skipped when the pi
    // instance or the spawning ctx is missing (see below), and when
    // SUBAGENT_VERIFY is off. Leaving the old verdict in place showed a `✓
    // checked` badge, and a `verification: "passed"` in the tool result details,
    // against text nothing had looked at. Absence is already the "never checked"
    // signal every reader keys off, so clearing it is the whole fix.
    record.verification = undefined;

    // Reset the record to running; stats (usage, toolUses, turnCount) carry over.
    const abortController = new AbortController();
    record.execution.abortController = abortController;
    record.execution.settled = false;
    record.lifecycle.status = "running";
    record.lifecycle.startedAt = Date.now();
    record.lifecycle.completedAt = undefined;
    record.result = undefined;
    record.error = undefined;
    // A stale idle clock from the first run would kill the continuation
    // immediately — restart the watchdog before the new turn begins.
    this.watchdog.start(record.id);

    // A continuation is a second run of the same record, and it settles through
    // the same chain — which finalized the first transcript. Give it its own,
    // so a follow-up is recorded rather than silently absent. `brief` carries
    // the follow-up, not the original task, because that is what this run was
    // asked.
    if (transcriptEnabled() && !record.execution.transcript) {
      const parentPi = getPiInstance();
      if (parentPi) {
        const transcript = new AgentTranscript(parentPi, record.id, record.display.type);
        record.execution.transcript = transcript;
        transcript.brief(message, record.display.description);
        // AL1: this session is NOT new. It holds every message of the run that
        // just settled, and a subscription anchored at 1 replays all of them
        // into the follow-up's first entry — where `MAX_LINES` then drops the
        // answer the follow-up was about. Anchored at the end of what is
        // already there, so the first thing this transcript records is the
        // follow-up message itself.
        attachTranscript(record, session, session.messages.length);
      }
    }

    // AL5: a continuation is a record going from settled back to running, and
    // the widget's poll now stops when there is nothing to draw. `startAgent`
    // has always announced itself here; this path never did, so the one route
    // back into "there is something to show" that does not go through spawn()
    // was also the one that could not re-arm the refresh.
    this.onStart?.(record);

    const previousTurns = record.stats.turnCount ?? 0;
    const promise = continueAgentSession(session, message, {
      ...this.runTrackingCallbacks(record, record.execution.liveViewCallbacks, (turnCount) => {
        record.stats.turnCount = previousTurns + turnCount;
      }),
      maxTurns: record.stats.maxTurns,
      graceTurns: getStore().agent.graceTurns ?? DEFAULT_GRACE_TURNS,
      signal: abortController.signal,
    });
    // `pi` and `ctx` are NOT in scope here — this is not startAgent, which gets
    // them from SpawnArgs. Referencing them directly threw
    // `ReferenceError: pi is not defined` on every continuation, and nothing
    // caught it: `steer()` is async, so continuing a settled agent from the
    // menu or the viewer rejected instead of running. The pi instance is a
    // shell singleton and the spawning context is kept on the record for
    // exactly this kind of later use; when either is missing the continuation
    // still runs, just unverified.
    const verifyCtx = record.execution.spawnCtx;
    const verifyPi = getPiInstance();
    this.attachSettlementChain(
      record,
      promise,
      verifyPi && verifyCtx ? this.buildVerifyDeps(verifyPi, verifyCtx, record) : undefined,
    );
    // The run proceeds asynchronously; the caller only learns the wiring
    // succeeded. The parent abort binding is deliberately NOT re-attached —
    // the parent turn that spawned the agent is over.
    return true;
  }

  getRecord(id: string): AgentRecord | undefined {
    return this.agents.get(id);
  }

  /**
   * Which record an identifier from OUTSIDE this process names — AO1.
   *
   * `getRecord` above is the exact lookup, and every caller in this package but
   * one hands it an id this package produced. The exception is `StopAgent`,
   * whose `agent_id` comes from the model, which has only ever been SHOWN the
   * first `SHORT_ID_LENGTH` characters. See `agent-id.ts`.
   */
  resolveId(requested: unknown): AgentIdResolution {
    return resolveAgentId(requested, this.agents.keys());
  }

  listAgents(): AgentRecord[] {
    return [...this.agents.values()].sort((a, b) => b.lifecycle.startedAt - a.lifecycle.startedAt);
  }

  /**
   * Remove a terminal record: dispose its session and detach any parent
   * interrupt binding (ADR-0006). Running/queued records are rejected — Stop is
   * the action there. Clear is the only per-record removal besides dispose().
   *
   * Forge fork: a record whose VERIFIER is still running is rejected too, and
   * `isTerminalStatus` cannot see that. The child's status goes terminal in the
   * settlement chain's `.then`, *before* `runVerification` is awaited, so
   * throughout a judge and up to three repairs the record reads `completed` and
   * `isTerminalStatus` says yes. Clearing it there does three things at once:
   * `removeRecord` disposes `execution.session`, which is the session the repair
   * is running IN; it opens the completion gate with `""`, so a foreground
   * `Agent` call blocked on it resumes with an empty answer while the real one is
   * still being checked; and it deletes the record the verifier is about to write
   * its verdict to.
   *
   * The widget already draws this distinction — `categorizeAgents` puts a record
   * with a `verifyPhase` in the RUNNING column, with a comment saying it "is
   * active work the user is waiting on" — and this is the second reader of that
   * same fact. See Y1 in
   * `context/design/subagents-loop-verifier-turns.md`.
   */
  clear(id: string): boolean {
    const record = this.agents.get(id);
    if (!record || !isTerminalStatus(record.lifecycle.status)) return false;
    if (isVerifyingRecord(record)) return false;
    this.removeRecord(id, record);
    return true;
  }

  abort(id: string, stoppedBy?: StopInitiator, stopDetail?: WatchdogStopDetail): boolean {
    const record = this.agents.get(id);
    if (!record) return false;

    return this.stopAgent(record, stoppedBy, stopDetail);
  }

  /** Abort the session or remove the agent from the queue. Returns false if not running/queued. */
  private stopAgent(record: AgentRecord, stoppedBy?: StopInitiator, stopDetail?: WatchdogStopDetail): boolean {
    // T5, closed: a record whose VERIFIER is still running is stoppable.
    //
    // The status is already terminal by then — `attachSettlementChain` sets it
    // from `classifyRun` and only afterwards awaits `runVerification` — so the
    // `status === "running"` test below returned false for the operator's Esc,
    // for `StopAgent`, and for anything else that asked, while a judge or a
    // repair held the one llama slot and the parent's `Agent` call sat on the
    // completion gate. A 300 s per-call deadline was the only exit.
    //
    // Aborting `verifyAbort` routes through `verifyAnswer`'s catch, which is
    // already this layer's "the check did not happen" path: the child's answer
    // is preserved and annotated, the phase clears, the gate opens, and Y1's
    // refusal to Clear a verifying record stops being a dead end. The run's own
    // status is NOT overwritten — the child really did complete, and saying
    // "stopped" would be a claim about the wrong run.
    if (isVerifyingRecord(record) && record.execution.verifyAbort) {
      record.execution.verifyAbort.abort();
      record.lifecycle.stoppedBy = stoppedBy;
      record.lifecycle.stopDetail = stopDetail;
      return true;
    }

    const wasQueued = record.lifecycle.status === "queued";
    if (wasQueued) {
      this.queue = this.queue.filter((q) => q.id !== record.id);
    } else if (record.lifecycle.status !== "running") {
      return false;
    } else {
      record.execution.abortController?.abort();
    }
    record.lifecycle.status = "stopped";
    record.lifecycle.stoppedBy = stoppedBy;
    record.lifecycle.stopDetail = stopDetail;
    record.lifecycle.completedAt = Date.now();
    this.detachParentBinding(record);
    if (!record.lifecycle.started) {
      // A record that never started has no run whose .finally opens the
      // gate — open it now and notify directly. Such stops never tally as
      // completed agents.
      this.openGate(record.id, "");
      this.notifyComplete(record);
    }
    return true;
  }

  private removeRecord(id: string, record: AgentRecord): void {
    // AM3: one teardown, one order — see `record-teardown.ts`. This path and
    // `dispose()` below had drifted: only this one cleared `execution.session`,
    // and neither ended the verifier.
    teardownRecord(record);
    this.detachParentBinding(record);
    // A stopped record's run can still be settling (stopAgent flips status
    // synchronously; the gate opens in .finally) — resolve so the coordinator's
    // await never dangles, then drop the resolver. A later .finally resolve no-ops.
    this.openGate(id, "");
    this.agents.delete(id);
  }

  /** Stop agents violating tool/idle timeouts. Thresholds are read live so menu changes apply to running agents. */
  private checkWatchdogs(): void {
    const { toolTimeoutMinutes, idleTimeoutMinutes } = getStore().agent;
    const decisions = this.watchdog.check(
      toolTimeoutMinutes * MINUTE_MS,
      idleTimeoutMinutes * MINUTE_MS,
      (id) => this.agents.get(id)?.lifecycle.status === "running",
    );
    for (const [id, detail] of decisions) {
      this.abort(id, "watchdog", detail);
    }
  }

  dispose() {
    clearInterval(this.watchdogInterval);
    this.queue = [];
    for (const record of this.agents.values()) {
      // Queued subagents never start: fail them honestly so the waiting tool
      // call resumes with an explicit error instead of hanging (US-9).
      if (record.lifecycle.status === "queued") {
        record.lifecycle.status = "error";
        record.error = DISPOSE_QUEUED_MESSAGE;
        record.lifecycle.completedAt = Date.now();
        this.openGate(record.id, "");
      }
      // AM3: the verifier is ENDED before the session it is running in, and
      // this path used to end neither.
      //
      // `stopAgent()` has known how to stop a record whose verifier is still
      // working since T5, and its comment says the fix is for "the operator's
      // Esc, for `StopAgent`, and for anything else that asked".
      // `session_shutdown` is something else that asked: it disposed
      // `execution.session` — the session a REPAIR runs in — and left the
      // verifier holding a handle to it. `record-teardown.ts` has the measured
      // consequence, which is not a crash: the child's good answer came back to
      // the parent annotated as having failed the check, because the check was
      // torn down.
      teardownRecord(record);
      this.detachParentBinding(record);
    }
    // Running records' gates open when their runs settle after this synchronous
    // pass — keep their resolvers so .finally can still resolve (no dangling gate).
    this.agents.clear();
  }
}
