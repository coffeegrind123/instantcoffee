/**
 * Compaction guard — the parts of the `/loop` context work that every session needs.
 *
 * `vendor/pi-loop-mode` fixed pi's compaction for unattended runs, and three of
 * the four fixes were not loop-specific at all. Two of those three are already
 * universal on this box: `scripts/pi-local.sh` sizes `reserveTokens` and
 * `keepRecentTokens` from `CTX_SIZE` into pi's GLOBAL settings, which removes
 * the silent no-op window between 50% and 66% and drops the post-compaction
 * floor. Every pi session here gets that, loop or not.
 *
 * This extension carries the remaining two across, and deliberately not the
 * fourth — plus a third thing the /loop work never had, added after the notice
 * was watched failing to prevent the exact damage it warns about. What is left,
 * measured over the 42 real compaction points and 259 assistant turns under
 * `~/.pi/agent/sessions`:
 *
 *   1. The carried-over summary grows without bound (456 → 4,029 → 11,054 chars;
 *      monotonic within a session), because pi's own update prompt tells the
 *      model to PRESERVE everything it already contains. Sizing `keepRecentTokens`
 *      does nothing about this — it is the one defect the settings fix leaves
 *      standing. See `src/summary-budget.ts`.
 *   2. The model cannot see its own context budget, and above 87% of the window
 *      52% of its turns come back empty against 1.5% below it. See
 *      `src/context-notice.ts`.
 *   3. Telling it does not stop it. On 2026-08-17 the CRITICAL notice was in
 *      context at 84.5% — "do not run commands with large output this turn" —
 *      and the model ran a curl loop that returned 17,790 characters, taking the
 *      window to 100% and the run to an empty turn. A single tool result is now
 *      bounded to a share of what context is LEFT, with the overflow written to
 *      a file the marker names. See `src/output-cap.ts`.
 *   4. …and that bound applies to a FAILING command too (AF6, fifteenth pass).
 *      The cap used to begin `if (event.isError) return undefined;` under "an
 *      error is short and is the one thing worth reading in full". pi's bash
 *      tool throws the whole formatted output on a non-zero exit — its own bound
 *      is 2,000 lines or 50 KB — and `createErrorToolResult` makes that the
 *      result's only text block. So the exemption covered up to ~12,500 tokens
 *      of a 32,768-token window, on the most common path an unattended `/loop`
 *      has: running a test suite that is still red. See the `tool_result`
 *      handler, `tests/error-output.test.ts`, and §6.1 of
 *      `context/design/subagents-loop-verifier-omissions.md`.
 *
 * What is NOT ported, and why: `/loop`'s handoff replaces pi's model-written
 * summary with a locally-built one and cuts to the last turn, keeping ~1.4k
 * chars where pi keeps ~30k. That is correct FOR A LOOP, where the conversation
 * is not the state — the goal lives in `GOAL.md`, progress in `PROGRESS.md`, and
 * each iteration re-derives its bearings from the working tree. In an ordinary
 * session the conversation IS the state, and building that summary from an
 * inactive `LoopState` yields "No saved loop goal / Iteration: 0 / No durable
 * loop files were readable" — 792 chars of form, in place of what the user
 * actually asked for. Its tighter cut is not needed here either: measured with
 * pi's own token estimator, the kept tail at the current global settings is 13%
 * of the window at the low end, 20% at the median and 31% at the worst of those
 * 42 points, with nothing above 35%. pi's cut is fine; only the summary is not.
 *
 * Failure mode by construction: both hooks only ever ADD a bounded line or SHRINK
 * a string that pi was about to send to the summarizer. `session_before_compact`
 * returns undefined, so pi still writes its own model summary and this extension
 * can never replace, cancel or truncate a compaction. Every handler swallows its
 * own errors — pi reports a throwing handler as an extension error to the user,
 * and a guard is not worth a visible error.
 *
 * The summary cap works by mutating `event.preparation` in place. That is checked
 * against pi 0.84.2 rather than assumed: `ExtensionRunner.emit()` passes the event
 * by reference with no `structuredClone`, and `agent-session.js` then calls
 * `compact(preparation, ...)` with that same object on both the manual and the
 * auto-compaction paths. If a future pi clones the event, the mutation simply
 * stops having an effect and pi's unmodified behaviour returns — it cannot break.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { createSpillWriter } from "./src/spill.ts";
import { capSummary, summaryCapChars } from "./src/summary-budget.ts";
import { allowanceChars, planOutputCap } from "./src/output-cap.ts";
import { type ContextUsageLike, contextNoticeMessage, hasBudgetMessage } from "./src/context-notice.ts";
import { PI_OWNER, beginCompaction, endCompaction } from "./src/compaction-lock.ts";

/**
 * Context usage for the active model, with the window filled in from the model
 * when pi cannot supply it — right after a compaction pi reports `tokens: null`,
 * and the window is the number both thresholds here depend on.
 */
function contextUsage(ctx: ExtensionContext): ContextUsageLike | undefined {
  try {
    const reported = ctx.getContextUsage() as ContextUsageLike | undefined;
    const modelWindow = (ctx.model as { contextWindow?: number } | undefined)?.contextWindow ?? 0;
    if (!reported) return modelWindow > 0 ? { tokens: null, contextWindow: modelWindow, percent: null } : undefined;
    if (reported.contextWindow && reported.contextWindow > 0) return reported;
    return modelWindow > 0 ? { ...reported, contextWindow: modelWindow } : reported;
  } catch {
    return undefined;
  }
}

/** The window to size the summary cap against, whether or not usage has been reported yet. */
function contextWindowOf(ctx: ExtensionContext): number | undefined {
  const usage = contextUsage(ctx);
  const window = usage?.contextWindow ?? (ctx.model as { contextWindow?: number } | undefined)?.contextWindow ?? 0;
  return window > 0 ? window : undefined;
}

/**
 * Where a capped tool result's full text is kept, created on first use.
 *
 * Forge fork, seventeenth pass: the writer and its bound now live in
 * `src/spill.ts`, because there is a SECOND cap in this stack —
 * `vendor/pi-subagents-lite/src/spawn/result-cap.ts`, which bounds a background
 * subagent's result and already imports `allowanceChars`/`planOutputCap` from
 * here so the numbers cannot drift. It had copied this writer without the prune.
 * The rationale for the count bound, and for it being a count rather than a
 * teardown sweep, moved with the code.
 */
const spillFile = createSpillWriter("pi-tool-output-");

function spill(toolName: string, callId: string, text: string): string | undefined {
  return spillFile(toolName, callId, text);
}

/**
 * Is this factory being run for a SUBAGENT's session?
 *
 * Forge fork, twenty-second pass (AM2). Everything else in this file is
 * deliberately the same in a child as in a parent — capping a child's own tool
 * output is why `.pi/extensions/**` is on a child's discovery route at all — and
 * the compaction lock is the one thing that is not, because it is a
 * process-global answering a per-session question. A child's compaction must not
 * hold back the PARENT's loop turns and delegation results.
 *
 * The same question, asked the same way, that `vendor/pi-loop-mode` and
 * `.pi/extensions/stack.ts` ask before registering anything at all;
 * `vendor/pi-subagents-lite/src/shell.ts` publishes the depth for exactly this.
 * Read at FACTORY time, which is inside the spawn bracket
 * (`buildSubagentSession` wraps `reloadAndMap()`, which calls every factory).
 *
 * One consequence, stated rather than guarded: an operator `/reload` that lands
 * inside a child's session BUILD would make the parent's own instance read as a
 * child's and never take the lock again for that session. That is a return to
 * the behaviour of every pass before this one, not a new failure.
 */
function bornInsideSubagentSpawn(): boolean {
  const depth = (globalThis as unknown as Record<string, unknown>)["__PI_SUBAGENT_SPAWN_DEPTH__"];
  return typeof depth === "number" && depth > 0;
}

export default function (pi: ExtensionAPI) {
  // AM2: captured once, at factory time. See bornInsideSubagentSpawn.
  const inChildSession = bornInsideSubagentSpawn();

  /**
   * Release pi's hold, if pi has one.
   *
   * `endCompaction` only releases an owner's own lock, so this is a no-op while
   * `pi-loop-mode` or `prinny-channel` holds it for a compaction IT asked for —
   * which is the case `session_before_compact` also fires for.
   */
  const releasePiCompaction = () => {
    if (inChildSession) return;
    try {
      endCompaction(PI_OWNER);
    } catch {
      // A lock that cannot be released is not worth an extension error; STALE_MS
      // is the backstop behind this one.
    }
  };

  // --- 1. Bound the summary pi carries from one compaction into the next. -----
  //
  // Returns undefined in every path: pi keeps ownership of the compaction and
  // still writes the model summary. The only change is how much previous summary
  // it is allowed to feed itself.
  pi.on("session_before_compact", async (event, ctx) => {
    // AM2: FIRST, and outside the try that owns the summary cap. pi is
    // compacting from this line until one of the three releases below,
    // whatever this handler goes on to decide about the summary — and the three
    // senders that read this lock are the reason it has to be said out loud.
    // See src/compaction-lock.ts for which of pi's two compaction call sites is
    // the dangerous one and why.
    if (!inChildSession) {
      try {
        beginCompaction(PI_OWNER);
      } catch {
        // A lock that cannot be taken leaves the stack exactly as it was before
        // this pass. It is never a reason to skip the trim below.
      }
    }
    try {
      const preparation = (event as { preparation?: { previousSummary?: string } }).preparation;
      const previous = preparation?.previousSummary;
      if (!preparation || typeof previous !== "string" || previous.length === 0) return undefined;

      const cap = summaryCapChars(contextWindowOf(ctx));
      const capped = capSummary(previous, cap);
      if (typeof capped !== "string" || capped.length >= previous.length) return undefined;

      preparation.previousSummary = capped;
      try {
        // Says what was DONE, not what pi will do with it. `session_before_compact`
        // results are last-truthy-wins and are not threaded (pi
        // `extensions/runner.js`, the generic `emit()`), so when another
        // extension returns a `{compaction}` — `vendor/pi-loop-mode` does, on a
        // small window — pi uses that and never reads `previousSummary` at all.
        // This handler cannot see that decision, and the old wording ("trimmed
        // the carried-over summary") claimed an outcome it does not control.
        ctx.ui.notify(
          `Compaction guard: capped the summary it would carry forward, ${previous.length} → ${capped.length} chars (cap ${cap}).`,
          "info",
        );
      } catch {
        // A missing or headless UI is not a reason to skip the trim.
      }
    } catch {
      // Never surface a guard failure as an extension error; pi's own behaviour is the fallback.
    }
    return undefined;
  });

  // --- 3. Bound a single tool result to a share of what context is left. -----
  //
  // The advisory in `context-notice.ts` cannot cover this case and never could:
  // it fired at 84.5% telling the model not to run commands with large output,
  // the model ran one anyway, and 17,790 characters took the context from 84.5%
  // to 100% in one step. Nobody knows how much a command will print until it has
  // printed it, so the bound has to be applied to the output, not requested of
  // the caller.
  pi.on("tool_result", async (event, ctx) => {
    try {
      const content = (event as { content?: unknown }).content;
      if (!Array.isArray(content) || content.length === 0) return undefined;
      // Forge fork, fifteenth pass (AF6): an error result is NOT exempt, and the
      // sentence that used to be here — "an error is short and is the one thing
      // worth reading in full" — was a guess about pi's bash tool that its
      // source contradicts.
      //
      //   const { text: outputText, details } = formatOutput(snapshot);
      //   if (exitCode !== 0 && exitCode !== null) {
      //       throw new Error(appendStatus(outputText, `Command exited with code ${exitCode}`));
      //   }                                   dist/core/tools/bash.js:346-349
      //
      // The throw carries the WHOLE captured output — bash's own bound is 2,000
      // lines or 50 KB (`core/tools/truncate.js`) — and `executePreparedToolCall`
      // turns it into `createErrorToolResult(error.message)`, i.e.
      // `content: [{type:"text", text: <all of it>}]` with `isError: true`. So
      // `isError` on this stack does not mean "a short message"; it means "the
      // command failed", and up to 50 KB (~12,500 tokens, 38% of a 32k window)
      // arrived here exempt from the one thing that bounds it.
      //
      // It is also the COMMON case for the runs this extension exists for: a
      // `/loop` fixing a failing test suite runs that suite every iteration, and
      // while it is failing every one of those results is an error result. The
      // incident in `src/output-cap.ts` — a 17,790-character tool result taking
      // the window from 84.5% to 100% and the turn to nothing — would not have
      // been capped had the command exited non-zero.
      //
      // Nothing else changes: `planOutputCap` keeps a head AND a tail, so the
      // `Command exited with code N` line and the failing assertion above it —
      // the part of an error anyone reads — survive the cap, and the full text is
      // in the spill file the marker names.

      const usage = contextUsage(ctx);
      const window = usage?.contextWindow ?? 0;
      const tokens = usage?.tokens ?? null;
      const remaining = window > 0 && tokens !== null ? window - tokens : null;
      const allowance = allowanceChars(remaining);

      // Only text is capped. An image block has no meaningful head and tail, and
      // truncating one produces something that is not an image.
      let total = 0;
      let firstText = -1;
      for (let i = 0; i < content.length; i++) {
        const part = content[i] as { type?: string; text?: unknown };
        if (part?.type === "text" && typeof part.text === "string") {
          total += part.text.length;
          if (firstText < 0) firstText = i;
        }
      }
      if (firstText < 0 || total <= allowance) return undefined;

      const joined = (content as { type?: string; text?: string }[])
        .filter((part) => part?.type === "text" && typeof part.text === "string")
        .map((part) => part.text as string)
        .join("\n");

      const toolName = String((event as { toolName?: unknown }).toolName ?? "tool");
      const callId = String((event as { toolCallId?: unknown }).toolCallId ?? "call");
      const plan = planOutputCap(joined, allowance, spill(toolName, callId, joined), usage?.percent ?? null);
      if (!plan) return undefined;

      try {
        ctx.ui.notify(
          `Compaction guard: capped ${toolName} output ${plan.originalChars} -> ${plan.keptChars} chars.`,
          "info"
        );
      } catch {
        // Headless is fine; the cap still applied.
      }

      // One text block replaces every text block, images kept in place.
      const rebuilt = (content as unknown[]).filter(
        (part) => (part as { type?: string })?.type !== "text"
      );
      rebuilt.unshift({ type: "text", text: plan.text });
      return { content: rebuilt as never };
    } catch {
      return undefined;
    }
  });

  // --- 2. Show the model its remaining budget, above 60% of the window. -------
  //
  // pi clones the message array before this event, so nothing added here reaches
  // the session. Appended last, so the cached prefix is untouched.
  pi.on("context", async (event, ctx) => {
    try {
      const messages = event.messages;
      // vendor/pi-loop-mode injects its own loop-flavoured budget line when a loop
      // is running. Whichever of the two runs second defers, so there is never a
      // second notice competing with the first.
      if (hasBudgetMessage(messages)) return undefined;

      const notice = contextNoticeMessage(contextUsage(ctx));
      if (!notice) return undefined;
      return { messages: [...messages, notice as (typeof messages)[number]] };
    } catch {
      return undefined;
    }
  });

  // --- 4. Say when pi has FINISHED compacting (AM2). --------------------------
  //
  // Three events, because `session_compact` is not enough on its own: pi emits
  // it only on the success path, so a compaction the operator cancelled with Esc
  // (`interactive-mode.js:2703` → `session.abortCompaction()`) or one whose
  // summariser failed has no closing extension event at all. Left at that, the
  // hold would run to STALE_MS — five minutes of an unattended loop deferring
  // every turn because one compaction was cancelled, which is worse than the
  // collision the lock prevents.
  //
  // `agent_start` and `agent_settled` are both strictly after any compaction pi
  // can run: the post-run one completes inside `_runAgentPrompt`'s `while`
  // before `_emitAgentSettled`, and the pre-prompt one completes before
  // `agent.prompt()` emits `agent_start`. `session_shutdown` is there so a hold
  // cannot outlive the session that took it — the lock is process-global and the
  // session is not.
  pi.on("session_compact", async () => {
    releasePiCompaction();
  });
  pi.on("agent_start", async () => {
    releasePiCompaction();
  });
  pi.on("agent_settled", async () => {
    releasePiCompaction();
  });
  pi.on("session_shutdown", async () => {
    releasePiCompaction();
  });
}
