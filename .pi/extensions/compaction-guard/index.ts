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

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { capSummary, summaryCapChars } from "./src/summary-budget.ts";
import { allowanceChars, planOutputCap } from "./src/output-cap.ts";
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

/** Where a capped tool result's full text is kept, created on first use. */
let spillDir: string | undefined;

function spill(toolName: string, callId: string, text: string): string | undefined {
  try {
    spillDir ??= mkdtempSync(join(tmpdir(), "pi-tool-output-"));
    // The id makes it unique; the tool name makes the path readable in the
    // marker, which is the only place the model ever sees it.
    const safe = String(toolName).replace(/[^\w.-]+/g, "_").slice(0, 24) || "tool";
    const file = join(spillDir, `${safe}-${String(callId).replace(/[^\w.-]+/g, "_").slice(0, 32)}.txt`);
    writeFileSync(file, text, "utf8");
    return file;
  } catch {
    // A cap that cannot save the overflow still caps — it just says so.
    return undefined;
  }
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
      // An error is short and is the one thing worth reading in full.
      if ((event as { isError?: boolean }).isError) return undefined;

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
}
