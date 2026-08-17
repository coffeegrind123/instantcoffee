/**
 * result-cap.ts — Forge fork. Bounds a finished BACKGROUND subagent's result
 * before it is injected into the parent's context.
 *
 * ## Why this file exists at all
 *
 * A foreground subagent returns through the `Agent` tool, so its result is a
 * tool result, and `.pi/extensions/compaction-guard` already bounds it: that
 * extension hooks `pi.on("tool_result")` and keys off `toolName`, not a list of
 * pi's builtin tools, so an extension-registered tool is covered for free.
 *
 * A background subagent does not take that path. `spawn-coordinator.ts` delivers
 * it with `pi.sendMessage({ customType: "subagent-result", ... }, { triggerTurn:
 * true })`, and pi's `sendCustomMessage` (dist/core/agent-session.js:1068) builds
 * a `role: "custom"` message and hands it straight to `agent.steer()` /
 * `agent.followUp()` / `_runAgentPrompt()`. Checked against pi 0.84.2's own
 * source: that path emits no `input` event, no `tool_result`, and — on the
 * triggerTurn branches — no `message_start`/`message_end` either. There is no
 * generic hook an extension could have used. The only interception points left
 * are the `context` event, which would see the message already in history with
 * the original text gone, or here, at the source, while the full result still
 * exists and can be spilled to a file.
 *
 * So: here. Uncapped, this is the exact failure the guard was written for —
 * a large result arriving at high context and triggering a turn on arrival,
 * which is how a run reached 100% and came back empty on 2026-08-17.
 *
 * ## Why it imports the guard rather than carrying its own numbers
 *
 * `REMAINING_FRACTION = 0.1`, the 1,500-char floor and the 20,000 ceiling were
 * measured against that failure — a fifth of the remainder would have landed the
 * run at 88.5%, still above the 87% cliff, and a tenth lands it at 86.8%, under
 * it. `compaction-guard/tests/output-cap.test.ts` pins that end state. A second
 * copy of those constants here would drift away from the test that justifies
 * them, so this imports them instead and the coupling is stated in FORK.md.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { allowanceChars, planOutputCap } from "../../../../.pi/extensions/compaction-guard/src/output-cap.ts";

/** Shape of what `ctx.getContextUsage()` reports; matches the guard's own view. */
interface ContextUsageLike {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

/** Where a capped result's full text is kept, created on first use. */
let spillDir: string | undefined;

function spill(agentType: string, agentId: string, text: string): string | undefined {
  try {
    spillDir ??= mkdtempSync(join(tmpdir(), "pi-subagent-result-"));
    const safeType = String(agentType).replace(/[^\w.-]+/g, "_").slice(0, 24) || "agent";
    const safeId = String(agentId).replace(/[^\w.-]+/g, "_").slice(0, 32);
    const file = join(spillDir, `${safeType}-${safeId}.txt`);
    writeFileSync(file, text, "utf8");
    return file;
  } catch {
    // A cap that cannot save the overflow still caps — the marker says so.
    return undefined;
  }
}

/**
 * Read the parent session's usage the same way the guard does.
 *
 * `getContextUsage()` can report a zero window before the first response has
 * come back, so the model's own `contextWindow` is the fallback; usage missing
 * entirely is reported as unknown rather than as zero, which would cap to the
 * floor on a context that is probably nearly empty.
 */
function contextUsage(ctx: ExtensionContext | undefined): ContextUsageLike | undefined {
  if (!ctx) return undefined;
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

export interface CappedResult {
  /** What to inject. Identical to the input when it already fitted. */
  text: string;
  /** Set only when a cap was applied, for the operator-facing notify(). */
  applied?: { originalChars: number; keptChars: number; spillPath: string | undefined };
}

/**
 * Bound one background subagent result against the parent's remaining window.
 *
 * Deliberately never throws: a subagent that finished is worth delivering even
 * if the bounding fails, so every failure path returns the original text.
 */
export function capBackgroundResult(
  text: string,
  ctx: ExtensionContext | undefined,
  agentType: string,
  agentId: string,
): CappedResult {
  try {
    if (typeof text !== "string" || text.length === 0) return { text };

    const usage = contextUsage(ctx);
    const window = usage?.contextWindow ?? 0;
    const tokens = usage?.tokens ?? null;
    const remaining = window > 0 && tokens !== null ? window - tokens : null;
    const allowance = allowanceChars(remaining);
    if (text.length <= allowance) return { text };

    const spillPath = spill(agentType, agentId, text);
    // Not the default advice. That one says "run a narrower command", which is
    // meaningless here — the parent did not run a command, an agent reported
    // back, and the only ways forward are the file or a fresh, narrower task.
    const plan = planOutputCap(
      text,
      allowance,
      spillPath,
      usage?.percent ?? null,
      "Read the file if you need the rest, or re-task the agent with a narrower question — do not re-run it for the same report.",
    );
    if (!plan) return { text };

    return {
      text: plan.text,
      applied: { originalChars: plan.originalChars, keptChars: plan.keptChars, spillPath },
    };
  } catch {
    return { text };
  }
}
