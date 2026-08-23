import { getPiInstance, getSessionCtx, getWidget } from "../shell.js";
import { SHORT_ID_LENGTH } from "../types.js";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentRecord, LiveView, SpawnConfig, ToolActivity } from "../types.js";
import type { AgentManager, SpawnOptions } from "../agents/agent-manager.js";
import { buildAgentDetails, formatResultContent } from "../agents/tool-execution.js";
import { capBackgroundResult } from "./result-cap.js";
import { describeNudgeDrop, describeNudgeHold, RECOVERY_ADVICE, type NudgeDropReason } from "./nudge-drop.js";
import { compactionInFlight } from "./compaction-lock.ts";
import { NudgeSchedule } from "./nudge-schedule.ts";

/**
 * spawn-coordinator.ts — Spawn-and-track coordination for subagents.
 *
 * Single entry point for both LLM tool and menu spawn paths.
 * Owns: Nudge system (schedule/batch/emit), background agent tracking. Live-view
 * state rides on the record (attached here at spawn) so continuations re-feed it.
 * Delegates concurrency and record lifecycle to AgentManager (peers, not ownership).
 *
 * Decision refs: D3 (forward events to live-view), D4 (stats on record only),
 * D6 (Nudge owned here), D2 (peers with AgentManager).
 */

// --- Types ---

/** Input for spawn(). Built by each caller from its own validation. */
export interface SpawnIntent extends SpawnConfig {
  type: string;
  prompt: string;
  runInBackground: boolean;
  /**
   * Parent run's interrupt signal, forwarded to the manager for foreground
   * spawns only. Background and menu-wizard spawns never carry one.
   */
  signal?: AbortSignal;
  /** Narrowed to required — all callers resolve this before spawn. */
  graceTurns: number;
}

export interface SpawnResult {
  agentId: string;
  record: AgentRecord;
}

// --- Constants ---

/** Batch delay for nudges — only emit one update per batch window (ms). */
const NUDGE_DELAY_MS = 200;

/**
 * How long to wait before asking again when somebody else is compacting (ms).
 *
 * Forge fork, seventeenth pass (AH1). Five seconds, the same number
 * `pi-loop-mode`'s `COMPACTION_WAIT_MS` uses for the same decision, and chosen
 * the same way: long enough that a real compaction is not polled a hundred
 * times, short enough that the answer it holds back is delayed rather than
 * stale. The wait cannot become a stall — `compaction-lock.ts` treats a holder
 * older than `STALE_MS` (five minutes) as absent — so the worst case is one
 * five-minute pause and then the result goes.
 */
const COMPACTION_WAIT_MS = 5_000;

// --- SpawnCoordinator ---

export class SpawnCoordinator {
  /**
   * Who is owed a nudge and when the batch fires — `./nudge-schedule.ts`.
   *
   * Extracted in the twenty-second pass because both of its rules are about
   * ORDER and neither could be tested here: the one-shot background gate that
   * `dispose()` used to clear one statement before the settlements that needed
   * it (AM5), and the single timer whose delay was decided by whichever caller
   * happened to be first (AM6).
   */
  private nudges = new NudgeSchedule();

  private nudgeTimer: ReturnType<typeof setTimeout> | null = null;

  /** Set during dispose to prevent nudge emission after session replacement. */
  private disposed = false;

  /**
   * Records whose nudge is being held for somebody else's compaction (AH1).
   *
   * Only so the operator is told ONCE per record rather than every
   * `COMPACTION_WAIT_MS`. Cleared when the result is actually delivered, and by
   * `dispose()`.
   */
  private heldForCompaction = new Set<string>();

  constructor(private manager: AgentManager) {}

  /**
   * Spawn + wire tracking + (foreground) await.
   * Single entry point for LLM tool executor and menu wizard.
   */
  async spawn(pi: ExtensionAPI, ctx: ExtensionContext, intent: SpawnIntent): Promise<SpawnResult> {
    // Create live view BEFORE spawn so callbacks can close over it
    const liveView: LiveView = {
      activeTools: new Map(),
      responseText: "",
    };
    const liveViewCallbacks = this.createLiveViewCallbacks(liveView);

    // SpawnConfig fields pass through unchanged; only the intent-only fields
    // (type/prompt/runInBackground/signal) are forwarded explicitly.
    const { type, prompt, runInBackground, signal, ...config } = intent;
    const spawnOptions: SpawnOptions = {
      ...config,
      isBackground: runInBackground,
      signal,
      ...liveViewCallbacks,
    };

    const agentId = this.manager.spawn(pi, ctx, type, prompt, spawnOptions);
    const record = this.manager.getRecord(agentId)!;
    // Spawn-time state rides on the record so it survives settlement: the
    // live view is re-fed by continuations, and the ctx keeps the UI-notify
    // fallback reachable for any later nudge (continuations included).
    record.execution.liveView = liveView;
    record.execution.spawnCtx = ctx;

    // Ensure widget timer is running so it displays the new agent
    // (menu path calls this explicitly, but tool path doesn't)
    const widget = getWidget();
    if (widget) {
      widget.ensureTimer();
    }

    if (intent.runInBackground) {
      this.nudges.markBackground(agentId);
    } else {
      await record.execution.promise;
    }

    return { agentId, record };
  }

  /** Read the live view for an agent. Widget calls this. */
  liveView(id: string): LiveView | undefined {
    return this.manager.getRecord(id)?.execution.liveView;
  }

  isBackground(agentId: string): boolean {
    return this.nudges.isBackground(agentId);
  }

  /**
   * Schedule a nudge for an agent.
   * Batches with NUDGE_DELAY_MS window to coalesce rapid completions.
   */
  scheduleNudge(agentId: string): void {
    this.scheduleNudgeIn(agentId, NUDGE_DELAY_MS);
  }

  /**
   * Queue a nudge to fire after `delayMs`.
   *
   * Forge fork, seventeenth pass (AH1): the delay is a parameter because there
   * are now two of them. `NUDGE_DELAY_MS` coalesces rapid completions;
   * `COMPACTION_WAIT_MS` is the re-ask after a deferral. An id put back while the
   * timer is already armed rides the existing one, which widens the batch window
   * and is the behaviour a batch wants.
   */
  private scheduleNudgeIn(agentId: string, delayMs: number): void {
    // AM6: the EARLIEST due time wins. This used to be `if (this.nudgeTimer)
    // return`, so a record held for somebody else's compaction re-armed the one
    // timer at five seconds and every delegation that settled inside that window
    // waited it out — twenty-five times its own delay, for a hold that was not
    // about it. A batch window should widen because more work arrived, not
    // because unrelated work is blocked.
    const plan = this.nudges.add(agentId, delayMs);
    if (plan.armInMs === null) return;
    if (this.nudgeTimer) clearTimeout(this.nudgeTimer);

    this.nudgeTimer = setTimeout(() => {
      this.nudgeTimer = null;
      for (const id of this.nudges.drain()) {
        this.emitIndividualNudge(id);
      }
    }, plan.armInMs);
  }

  /**
   * Called by AgentManager's onComplete callback (wired at session_start).
   * Owns the completion side-effects: nudge scheduling. The live view stays
   * on the record — a settled agent can be continued and re-feeds it.
   */
  onAgentComplete(record: AgentRecord): void {
    // One-shot background gate: the first settlement of a background agent
    // nudges and consumes the set entry. Continuation settlements (ordinal
    // >= 2, written by the manager before this callback fires) nudge for both
    // spawn classes — the coordinator never observes steers itself.
    if (this.nudges.owes(record.id, record.execution.settlementCount)) {
      this.scheduleNudge(record.id);
    }
  }

  /**
   * Tear the coordinator down at `session_shutdown`.
   *
   * Forge fork, eighteenth pass (AI1): **a queued nudge is a finished
   * delegation's only answer, and clearing the set is a drop.**
   *
   * `pendingNudges` is the batch set and `nudgeTimer` is the one timer that
   * drains it. Everything below used to be four `clear()` calls, so any id
   * sitting in that set when a session ended was discarded with nothing said —
   * not to the model, not to the operator, not to the log. That is precisely the
   * failure §11.1 (fifteenth pass) closed for the three guards INSIDE
   * `emitIndividualNudge`, under AC1's rule:
   *
   *   > A delivery that did not happen is the loudest thing this class can
   *   > report; it must not be the quietest.
   *
   * And the `session-replaced` guard at the top of `emitIndividualNudge` was
   * written for this very case — its own docstring says "`session_shutdown`, or
   * a session replaced under it" — but it can only fire for a record that
   * settles AFTER the dispose, because the ids that were already queued are
   * cleared here and their timer is cancelled. The report existed and the path
   * to it did not.
   *
   * **AH1 made the window large.** Before it, an id sat in this set for
   * `NUDGE_DELAY_MS` — 200 milliseconds. Since the seventeenth pass a nudge held
   * for somebody else's compaction is put back with `COMPACTION_WAIT_MS`, over
   * and over, for as long as the lock is held — up to `STALE_MS`, five minutes.
   * A `/loop` that delegates in the background and is stopped while a compaction
   * is running is the ordinary shape of that.
   *
   * The control is thirty lines away in the same package: `AgentManager.dispose`
   * fails its QUEUED records honestly rather than dropping them, "so the waiting
   * tool call resumes with an explicit error instead of hanging (US-9)". Same
   * teardown, same kind of pending work, opposite treatment.
   *
   * Reported before `disposed` is set, so the drop is attributed to the session
   * ending rather than to a session that was replaced under a live nudge — two
   * different sentences for two different facts (see `nudge-drop.ts`).
   */
  dispose(): void {
    if (this.nudgeTimer) {
      clearTimeout(this.nudgeTimer);
      this.nudgeTimer = null;
    }
    // AM5: `retire()` drops the BATCH and leaves the background one-shot alone.
    //
    // It used to clear `backgroundAgentIds` too, and this runs at
    // `session_shutdown` BEFORE `AgentManager.dispose()` — which is what
    // actually ends the runs. So every background delegation still running was
    // stripped of the flag that says its answer is owed, and then settled into
    // an `onAgentComplete` that scheduled nothing: no delivery, and no report of
    // one. The `session-replaced` guard below was written for exactly those
    // records ("`session_shutdown`, or a session replaced under it") and this
    // line was the reason nothing could reach it. See `./nudge-schedule.ts`.
    const undelivered = this.nudges.retire();
    this.heldForCompaction.clear();
    this.disposed = true;
    // The manager is disposed AFTER the coordinator (`events.ts`'s
    // `session_shutdown`), so the records are still readable here and the notice
    // can name the agent and its transcript.
    for (const agentId of undelivered) {
      this.reportDrop("session-ending", agentId, this.manager.getRecord(agentId));
    }
  }

  // ── Private ──

  /** Create callbacks that bridge manager events to a specific live view. */
  private createLiveViewCallbacks(view: LiveView): Pick<SpawnOptions, "onToolActivity" | "onTextDelta"> {
    return {
      onToolActivity: (activity: ToolActivity) => {
        // Forge fork, fourteenth pass: keyed by `toolCallId`, which is the id pi
        // already gives every call, not by a timestamp.
        //
        // `${toolName}_${Date.now()}` claims to identify one call and identifies
        // a millisecond: two calls to the same tool that start in the same one
        // collapse to a single entry, the second `end` finds nothing to delete,
        // and the widget shows a tool still running after it has finished — for
        // the rest of the child's run, because nothing else clears the map. pi
        // dispatches a turn's tool calls together, so same-tool-same-millisecond
        // is the ordinary case for a parallel batch rather than a rare one.
        //
        // `Watchdog.recordActivity` has keyed on `toolCallId` since it was
        // written, and carries the note this branch needs: a SYNTHETIC end event
        // (`extension-error:…`, emitted by `createAndConfigureSession`'s
        // `bindExtensions` handler) has no id, so the by-name fallback below is
        // kept for exactly that case rather than deleted.
        if (activity.type === "start") {
          view.activeTools.set(activity.toolCallId ?? `${activity.toolName}_${Date.now()}`, activity.toolName);
        } else if (activity.toolCallId) {
          view.activeTools.delete(activity.toolCallId);
        } else {
          for (const [key, name] of view.activeTools) {
            if (name === activity.toolName) {
              view.activeTools.delete(key);
              break;
            }
          }
        }
      },
      onTextDelta: (_delta: string, fullText: string) => {
        view.responseText = fullText;
      },
    };
  }

  /**
   * Say that a background result was not delivered — §11.1, closed.
   *
   * Forge fork, fifteenth pass. The three guards below are each correct: there is
   * genuinely nothing to send through, or nothing to send. Each of them also used
   * to drop a finished delegation's answer in silence, which is the one thing
   * AC1 established this class of failure must never be:
   *
   *   > A delivery that did not happen is the loudest thing this class can
   *   > report; it must not be the quietest.
   *
   * AC1 built exactly that for the `catch` around the send. The guards return
   * before the `try`, so they bypassed it. The sentences are in
   * `nudge-drop.ts`, which imports nothing and can therefore be tested; the
   * `console.warn` runs whether or not there is a UI, because
   * `noOpUIContext.notify` is `() => {}` headless.
   */
  private reportDrop(reason: NudgeDropReason, agentId: string, record?: AgentRecord): void {
    const drop = describeNudgeDrop(
      reason,
      agentId.slice(0, SHORT_ID_LENGTH),
      record?.display.type,
      // AI1: only `session-ending` reads it, and only when the operator turned
      // the transcript on — see describeNudgeDrop.
      record?.display.outputFile,
    );
    console.warn(`[pi-subagents-lite] ${drop.log}`);
    const ctx = record?.execution.spawnCtx ?? getSessionCtx();
    try {
      ctx?.ui?.notify?.(drop.notice, "warning");
    } catch {
      // A session that is going away is exactly the case here; the line above is
      // the record.
    }
  }

  private emitIndividualNudge(agentId: string): void {
    // The record first, so a drop below can name what was lost and reach the
    // spawning session's own context. A map read cannot fail.
    const record = this.manager.getRecord(agentId);

    // Skip if disposed — prevents stale pi usage after session replacement
    if (this.disposed) {
      this.reportDrop("session-replaced", agentId, record);
      return;
    }

    // Read pi from shell at call time so we get a fresh reference after reload.
    const pi = getPiInstance();
    if (!pi) {
      this.reportDrop("no-runtime", agentId, record);
      return;
    }

    // Forge fork, twelfth pass (AC1): this line is load-bearing and was deleted
    // by accident. AA4 removed the `parentIdle ? "followUp" : "steer"` ternary
    // and, with it, the `const ctx = getSessionCtx()` that fed it — while three
    // readers of `ctx` below it (the result cap, and both notify calls) stayed.
    // A free variable is not a build error here: this package is typechecked by
    // nobody (`npm run lint` is `node --check`, pi loads .ts through jiti), so
    // it shipped as a ReferenceError thrown on the first use — INSIDE the try
    // below, whose catch exists for a different failure and reports "Result
    // available" to a UI that is a no-op headless. Every background subagent's
    // answer, and every continuation's, stopped reaching the parent model.
    // Same reason as pi: read at call time, not at spawn time.
    const ctx = getSessionCtx();

    if (!record) {
      this.reportDrop("record-gone", agentId);
      return;
    }

    // Forge fork, seventeenth pass (AH1): not into a compaction that is already
    // running.
    //
    // This is the THIRD sender in this stack through `sendCustomMessage`'s
    // `triggerTurn` branch, and it was the last one that did not ask.
    // `pi-loop-mode`'s `sendLoopTurn` (AG2) and `prinny-channel`'s empty-turn
    // continuation (AG3) both read this lock; both of those have somewhere to
    // put what they are holding if they cannot send it — the loop reschedules
    // the same iteration, prinny tells the sender to ask again. This one is
    // holding a finished delegation's ONLY answer: `emitIndividualNudge` runs
    // once per record, the record is already settled, its slot is released and
    // its gate is open. Sending it into a compaction spends it.
    //
    // pi's refusal lives on `prompt()` alone (`agent-session.js:807`);
    // `sendCustomMessage` → `_runAgentPrompt` (`:1090`/`:744`) checks nothing,
    // and during a compaction the session is idle — `compact()` begins
    // `await this.abort()` — so that branch is the only one a nudge can take.
    // See `./compaction-lock.ts` for what the run then costs.
    //
    // Deferred, never dropped, and bounded by the lock's own five-minute
    // staleness. The check sits ABOVE the cap deliberately: `capBackgroundResult`
    // sizes the result against `ctx.getContextUsage()`, which during a compaction
    // still reports the pre-compaction window — so waiting also measures the
    // context the result will actually land in.
    const holder = compactionInFlight();
    if (holder) {
      if (!this.heldForCompaction.has(agentId)) {
        this.heldForCompaction.add(agentId);
        const hold = describeNudgeHold(holder.owner, agentId.slice(0, SHORT_ID_LENGTH), record.display.type);
        console.warn(`[pi-subagents-lite] ${hold.log}`);
        try {
          (record.execution.spawnCtx ?? ctx)?.ui?.notify?.(hold.notice, "info");
        } catch {
          // Headless is fine; the console.warn above is the record.
        }
      }
      this.scheduleNudgeIn(agentId, COMPACTION_WAIT_MS);
      return;
    }
    this.heldForCompaction.delete(agentId);

    const details = buildAgentDetails(record, {
      includeStats: true,
      includeStatus: true,
    });

    try {
      // Delivery mode: `followUp`, and it is the one pi can honour.
      //
      // This used to read `parentIdle ? "followUp" : "steer"` under a comment
      // describing a choice between two behaviours. pi can only produce one of
      // them, because `isIdle` and `isStreaming` are the same bit
      // (`agent-session.js:588`/`:592`, both `_isAgentRunActive`) and
      // `sendCustomMessage` only reads `deliverAs` on the streaming branch:
      //
      //   deliverAs === "nextTurn"                          :1078  (not us)
      //   isStreaming && triggerTurn !== false              :1081  reads it
      //   triggerTurn  → await _runAgentPrompt(appMessage)  :1089  IGNORES it
      //
      // `parentIdle === true` is exactly the case that falls to `:1089`, where
      // the value is discarded and the result starts a fresh run; `parentIdle
      // === false` is exactly the case that reads it, where the ternary had
      // already committed to `"steer"`. So the `followUp` arm only ever existed
      // for the state in which pi does not look at it.
      //
      // ## Why followUp rather than steer, now that it is a real choice
      //
      // Both queues drain inside the SAME agent run and end in the same
      // `agent_end` — `runLoop`'s outer while feeds follow-ups back into the
      // inner loop (`pi-agent-core/agent-loop.js`) — so this does NOT retire the
      // two-message turn that W1, X1, X2 and X3 were each written to repair.
      // What it changes is WHERE in the run the result lands:
      //
      //   steer     drained by the INNER while, injected before the next
      //             assistant response — i.e. possibly in the middle of a tool
      //             chain the parent is halfway through (read → edit → test).
      //   followUp  drained by the OUTER while, only once the model has stopped
      //             calling tools — i.e. at the natural end of what it was doing.
      //
      // A background subagent's result is by construction not urgent: the parent
      // chose not to block on it. Interrupting a tool sequence with an unrelated
      // answer costs the parent a context switch for at most one turn of
      // latency, and on a one-slot llama server that turn is not a queue wait —
      // the parent already owns the slot either way. So the later injection
      // point is the coherent one, and it is now the one that gets picked.
      //
      // See AA4 in `context/design/subagents-loop-verifier-hosts.md` and probe
      // `context/testing/probes/n4-the-delivery-mode-that-is-never-read.mjs`.
      const deliverAs = "followUp" as const;

      // Forge fork: bound the result against the parent's REMAINING window
      // before it is injected. This message never passes through the
      // `tool_result` hook that compaction-guard uses to bound everything else
      // — see src/spawn/result-cap.ts for why there is no generic hook here and
      // why the numbers are imported rather than restated.
      const capped = capBackgroundResult(
        formatResultContent(record),
        ctx,
        record.display.type,
        record.id,
      );
      if (capped.applied && ctx?.ui?.notify) {
        try {
          ctx.ui.notify(
            `Subagent result capped ${capped.applied.originalChars} -> ${capped.applied.keptChars} chars.`,
            "info",
          );
        } catch {
          // Headless is fine; the cap still applied.
        }
      }

      pi.sendMessage(
        {
          customType: "subagent-result",
          content: `[Subagent "${record.display.type}" ${record.id.slice(0, SHORT_ID_LENGTH)} ${record.lifecycle.status}]\n\n${capped.text}`,
          details,
          display: true,
        },
        {
          deliverAs,
          triggerTurn: true,
        },
      );
    } catch (error) {
      // sendMessage failed (shared runtime overwritten by subagent bindCore).
      // Fall back to UI notification using the captured spawning-session context.
      //
      // Forge fork (AC1): the reason is in the line now, and `console.warn` runs
      // whether or not there is a UI. This catch swallowed a ReferenceError for
      // two passes and reported it as "Result available" — a sentence that
      // describes the intended failure (a stale runtime) so exactly that nobody
      // looked further, and that says nothing at all outside a TUI, because
      // `noOpUIContext.notify` is `() => {}`. A delivery that did not happen is
      // the loudest thing this class can report; it must not be the quietest.
      //
      // Forge fork, sixteenth pass (AG6): the recovery this names is the one
      // that can actually produce the answer. `AgentStatus` prints
      // `id (type) status` and never touches `record.result`; `/agents` → the
      // agent → "View result" is what shows it. The sentence lives in
      // `nudge-drop.ts` so this drop and the three guarded ones cannot drift.
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`[pi-subagents-lite] could not deliver the result of ${record.id}: ${reason}`);
      const spawnCtx = record.execution.spawnCtx;
      if (spawnCtx?.ui?.notify) {
        try {
          spawnCtx.ui.notify(
            `[Subagent "${record.display.type}" ${record.lifecycle.status}] result NOT delivered to the model (${reason}) — ${RECOVERY_ADVICE}`,
            "warning",
          );
        } catch {
          // ctx may also be stale if session was replaced
        }
      }
    }
  }
}
