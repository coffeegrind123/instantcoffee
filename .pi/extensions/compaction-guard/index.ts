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
 * fourth. What is left, measured over the 42 real compaction points and 259
 * assistant turns under `~/.pi/agent/sessions`:
 *
 *   1. The carried-over summary grows without bound (456 → 4,029 → 11,054 chars;
 *      monotonic within a session), because pi's own update prompt tells the
 *      model to PRESERVE everything it already contains. Sizing `keepRecentTokens`
 *      does nothing about this — it is the one defect the settings fix leaves
 *      standing. See `src/summary-budget.ts`.
 *   2. The model cannot see its own context budget, and above 87% of the window
 *      52% of its turns come back empty against 1.5% below it. See
 *      `src/context-notice.ts`.
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

import { capSummary, summaryCapChars } from "./src/summary-budget.ts";
import { type ContextUsageLike, contextNoticeMessage, hasBudgetMessage } from "./src/context-notice.ts";

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

export default function (pi: ExtensionAPI) {
  // --- 1. Bound the summary pi carries from one compaction into the next. -----
  //
  // Returns undefined in every path: pi keeps ownership of the compaction and
  // still writes the model summary. The only change is how much previous summary
  // it is allowed to feed itself.
  pi.on("session_before_compact", async (event, ctx) => {
    try {
      const preparation = (event as { preparation?: { previousSummary?: string } }).preparation;
      const previous = preparation?.previousSummary;
      if (!preparation || typeof previous !== "string" || previous.length === 0) return undefined;

      const cap = summaryCapChars(contextWindowOf(ctx));
      const capped = capSummary(previous, cap);
      if (typeof capped !== "string" || capped.length >= previous.length) return undefined;

      preparation.previousSummary = capped;
      try {
        ctx.ui.notify(
          `Compaction guard: trimmed the carried-over summary ${previous.length} → ${capped.length} chars (cap ${cap}).`,
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
}
