// tool-result guard for pi — a malformed tool result must not kill the session.
//
// Every decision lives in ../src/normalize.ts, which imports nothing so it can
// be tested with bare node. This file is the pi coupling and nothing else — the
// same split vendor/pi-persona and vendor/rtk-pi use.
//
// ── WHY A `tool_result` HANDLER IS THE FIX, AND WHY IT WORKS ────────────────
//
// This is not a defensive `try`/`catch` hoping to land near the problem. It is
// the one place in pi 0.84.4 where a tool result can still be corrected, and it
// works by flipping a branch pi already has. Read off the bundle, not guessed:
//
//   1. `AgentSession` wires the agent's `afterToolCall` to the extension
//      runner (`chunk-OMWWHBTG.js:1237`):
//
//        const hookResult = runner.hasHandlers("tool_result")
//          ? await runner.emitToolResult({ …, content: result.content, … })
//          : undefined
//        const content = hookResult?.content ?? result.content ?? []
//        const normalizedContent = await normalizeToolResultImages(content, …)
//        if (!(!hookResult && normalizedContent === content))
//          return { content: normalizedContent, … }
//
//      pi ALREADY computes the repair — `result.content ?? []`. It just does
//      not return it. With no `tool_result` handler registered anywhere,
//      `hookResult` is undefined; `normalizeToolResultImages` returns its
//      argument BY REFERENCE when no block is an image (`:624`), so
//      `normalizedContent === content` holds, the condition is false, and the
//      function returns undefined. The repair is computed and thrown away.
//
//   2. `ExtensionRunner.emitToolResult` (`:1078`) returns a value ONLY when
//      some handler returned a non-undefined field — `if (modified) return {…}`.
//      So one handler that returns `{ content }` makes `hookResult` truthy,
//      which makes the condition true, which makes pi return the content it had
//      already worked out.
//
//   3. `finalizeExecutedToolCall` (`:826`) then merges it into the result the
//      UI is handed: `content: afterResult.content ?? result.content`. An empty
//      array is not nullish, so a repaired array wins.
//
// The consequence worth stating plainly: **returning nothing from this handler
// is not the same as not having the handler.** When there is nothing to repair
// we return `undefined`, `modified` stays false, `hookResult` stays undefined,
// and pi takes byte-for-byte the path it took before this package existed. The
// guard costs one function call per tool result and changes nothing else.
//
// It also carries the other two unguarded reads for free — `updateDisplay`'s
// image sweep and `maybeConvertImagesForKitty` both do `this.result.content
// .filter(…)` on the same object.
//
// ── WHAT IT DOES NOT COVER ─────────────────────────────────────────────────
//
// `tool_execution_update`. A streaming tool's `onUpdate(partialResult)` is
// emitted straight to the UI (`:826`) and never passes through `afterToolCall`,
// so a partial without `content` still crashes and nothing here can reach it.
// No tool in this stack streams updates; if one ever does, that is the gap.
//
// ── COST ───────────────────────────────────────────────────────────────────
//
// Zero tokens. No tool is registered (a tool costs its schema on every request
// whether or not it is called), no command, no system-prompt text. The only
// thing that ever reaches the model is the replacement block on a result that
// would otherwise have ended the session.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"

import { normalizeContent } from "../src/normalize.ts"

/** Shape of the fields this handler reads. pi's own type is wider. */
interface ToolResultLike {
  toolName?: string
  content?: unknown
}

export default function toolResultGuard(pi: ExtensionAPI) {
  // One notice per tool per session.
  //
  // Silence would be the wrong kind of success: the repair keeps the session
  // alive and leaves the operator with no idea that a tool is broken, so the
  // defect never gets fixed and the guard becomes load-bearing. Once per tool,
  // because a broken tool is usually broken on every call and a notice per call
  // is a notice nobody reads.
  const announced = new Set<string>()

  pi.on("tool_result", async (event, ctx) => {
    try {
      const e = event as ToolResultLike
      const toolName = typeof e.toolName === "string" && e.toolName ? e.toolName : "a tool"
      const repair = normalizeContent(e.content, toolName)
      if (!repair) return undefined

      console.warn(`[toolresult-guard] ${repair.reason}`)
      if (!announced.has(toolName)) {
        announced.add(toolName)
        notify(
          ctx,
          `${toolName} returned a tool result pi cannot render — ${
            repair.recovered ? "repaired" : "substituted a placeholder"
          }. Without this guard the session would have exited here. ${repair.reason}`,
          repair.recovered ? "warning" : "error",
        )
      }
      // `content` only. Returning `details`/`isError`/`usage` would overwrite
      // them with copies of themselves — harmless but untrue to what this
      // package claims to touch, and `emitToolResult` carries the originals
      // through on its own once `modified` is set.
      return { content: repair.content as never }
    } catch (err) {
      // A guard that throws is worse than no guard: `emitToolResult` catches it
      // and reports an extension error, and the malformed result then sails on
      // to the renderer exactly as it would have. Nothing in here should be
      // able to throw — normalizeContent has no I/O and no unchecked access —
      // so this exists to make that claim survive a future edit.
      console.warn("[toolresult-guard] the guard itself failed; the result was left alone", err)
      return undefined
    }
  })
}

/** Notify if there is a UI, log if there is not. Never throws at a call site. */
function notify(ctx: ExtensionContext, text: string, level: "warning" | "error"): void {
  try {
    if (ctx?.hasUI) ctx.ui.notify(text, level)
    else console.warn(`[toolresult-guard] ${text}`)
  } catch {
    /* a notice is not worth a turn */
  }
}
