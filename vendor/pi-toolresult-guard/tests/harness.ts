// Load the real extension factory with pi's module resolvable.
//
// Two targets, and the difference matters. The INSTALLED package is the only
// thing that can answer "does pi still export this, does that event still
// fire"; a renamed export fails there rather than at a user's next launch. The
// STUB answers everything else, and it exists because this package's whole job
// is to keep a session alive — a suite that skips itself on a box without pi is
// no use against a bug whose symptom is the session exiting.
//
// pi is resolved from the `pi` binary on PATH rather than an absolute path, for
// the reason vendor/rtk-pi's version-probe suite spells out: an absolute path
// is true of one box and of nowhere else, and it took CI down for nine days.

import { existsSync, realpathSync } from "node:fs"
import { registerHooks } from "node:module"
import { delimiter, dirname, join } from "node:path"
import { pathToFileURL } from "node:url"

export const PI_SPECIFIER = "@earendil-works/pi-coding-agent"

export function findPiIndex(): string | null {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue
    const bin = join(dir, "pi")
    if (!existsSync(bin)) continue
    try {
      // `.../dist/cli.js` on a plain npm install, `.../dist/bundle/cli.js` on
      // this stack's image. `index.js` sits beside whichever one it is, so
      // resolve relative to the binary rather than assuming a layout.
      const cli = realpathSync(bin)
      const index = join(dirname(cli), "index.js")
      if (existsSync(index)) return index
    } catch {
      // an unreadable PATH entry is not this test's problem
    }
  }
  const legacy = "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js"
  return existsSync(legacy) ? legacy : null
}

/**
 * A stand-in for pi's package.
 *
 * This extension takes NOTHING from pi at runtime — its only imports from the
 * package are `import type`, which `--experimental-strip-types` erases — so the
 * stub is empty and the factory runs unmodified against it.
 */
const STUB_URL = "data:text/javascript,export%20const%20__stub%20%3D%20true"

let hooked = false
let target: string | null = null

function ensureHook(): void {
  if (hooked) return
  hooked = true
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === PI_SPECIFIER && target) return { url: target, shortCircuit: true }
      return nextResolve(specifier, context)
    },
  })
}

export function hookPiResolution(piIndex: string): void {
  target = pathToFileURL(piIndex).href
  ensureHook()
}

/**
 * Point pi's specifier at the stub.
 *
 * Per PROCESS: node's test runner gives each FILE its own process, and the two
 * hooks share one `target`, so a suite that stubs and a suite that does not
 * must not live in the same file.
 */
export function hookStubPi(): void {
  target = STUB_URL
  ensureHook()
}

// ── a recording stand-in for ExtensionAPI ────────────────────────────────────

export class FakeApi {
  handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>()
  tools: unknown[] = []
  commands: string[] = []

  on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void {
    const list = this.handlers.get(event) ?? []
    list.push(handler)
    this.handlers.set(event, list)
  }

  registerTool(tool: unknown): void {
    this.tools.push(tool)
  }

  registerCommand(name: string): void {
    this.commands.push(name)
  }

  registerShortcut(): void {}
  registerFlag(): void {}
  appendEntry(): void {}
  sendUserMessage(): void {}
  sendMessage(): void {}

  async fire(event: string, payload: unknown, ctx: unknown): Promise<unknown[]> {
    const out: unknown[] = []
    for (const h of this.handlers.get(event) ?? []) out.push(await h(payload, ctx))
    return out
  }
}

export class FakeCtx {
  notifications: Array<{ text: string; type?: string }> = []
  hasUI: boolean

  constructor(opts: { hasUI?: boolean } = {}) {
    this.hasUI = opts.hasUI ?? true
  }

  ui = {
    notify: (text: string, type?: string) => {
      this.notifications.push({ text, type })
    },
    setStatus: () => {},
    select: async () => undefined,
    confirm: async () => true,
    input: async () => undefined,
    editor: async (_t: string, body: string) => body,
    setWidget: () => {},
  }
}

/**
 * pi's own merge, transcribed from `chunk-OMWWHBTG.js` at 0.84.4.
 *
 * The tests drive THIS rather than asserting on the handler's return value,
 * because the return value is not the claim worth pinning. The claim is that
 * what pi does with it stops the crash — and that runs through three functions
 * in two files, only one of which this package controls. Transcribed so a pi
 * upgrade that changes the merge shows up as a failing test with a diff to read.
 *
 *   emitToolResult          runner.js:1078   — returns a value only if modified
 *   afterToolCall           :1237            — the branch that discards a repair
 *   finalizeExecutedToolCall :826            — merges it back into the result
 *   getTextOutput           :1133            — the unguarded read that crashes
 */
export async function piWouldRender(
  api: FakeApi,
  ctx: FakeCtx,
  toolName: string,
  rawResult: unknown,
): Promise<{ crashed: boolean; text: string; content: unknown }> {
  const result = (rawResult ?? {}) as { content?: unknown; details?: unknown; usage?: unknown }

  // ── ExtensionRunner.emitToolResult (:1078) ────────────────────────────────
  const currentEvent = {
    type: "tool_result",
    toolName,
    toolCallId: "call_test",
    input: {},
    content: result.content,
    details: result.details,
    isError: false,
    usage: result.usage,
  } as Record<string, unknown>
  let modified = false
  for (const handler of api.handlers.get("tool_result") ?? []) {
    const handlerResult = (await handler(currentEvent, ctx)) as Record<string, unknown> | undefined
    if (!handlerResult) continue
    for (const key of ["content", "details", "isError", "usage"]) {
      if (handlerResult[key] !== undefined) {
        currentEvent[key] = handlerResult[key]
        modified = true
      }
    }
  }
  const hookResult = modified
    ? {
        content: currentEvent.content,
        details: currentEvent.details,
        isError: currentEvent.isError,
        usage: currentEvent.usage,
      }
    : undefined

  // ── AgentSession afterToolCall (:1237) ────────────────────────────────────
  const content = hookResult?.content ?? result.content ?? []
  // normalizeToolResultImages (:624) returns its argument BY REFERENCE when no
  // block is an image. That identity is the whole reason the repair is dropped.
  const normalizedContent = content
  let after: { content: unknown } | undefined
  if (!(!hookResult && normalizedContent === content)) {
    after = { content: normalizedContent }
  }

  // ── finalizeExecutedToolCall (:826) ───────────────────────────────────────
  let merged: { content?: unknown } = result
  if (after) merged = { ...result, content: after.content ?? result.content }

  // ── ToolExecutionComponent -> getTextOutput (:1133) ───────────────────────
  try {
    const final = { ...merged, isError: false } as { content: unknown }
    if (!final) return { crashed: false, text: "", content: undefined }
    const blocks = (final.content as Array<{ type: string; text?: string }>).filter(c => c.type === "text")
    return { crashed: false, text: blocks.map(c => c.text || "").join("\n"), content: final.content }
  } catch {
    return { crashed: true, text: "", content: merged.content }
  }
}
