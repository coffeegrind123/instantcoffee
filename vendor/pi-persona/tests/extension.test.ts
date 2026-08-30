// The extension, driven through its real handlers.
//
// This is the suite that catches what no unit test can: a method pi does not
// have, an event name that never fires, a handler that returns the wrong shape.
// The src/ modules are pure and tested on their own; this file is about the
// coupling.
//
// pi's package is redirected onto the installed copy (see harness.ts), so the
// factory runs against the SAME import a session would. When pi is absent the
// load tests skip and the source assertions still run, so a checkout without pi
// still fails on a regression in the extension itself.

import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { before, describe, test } from "node:test"

import { assistantEntry, FakeApi, FakeCtx, findPiIndex, hookPiResolution, userEntry } from "./harness.ts"
import { IMMERSION_MARKER } from "../src/immersion.ts"
import { PERSONA_FILE } from "../src/storage.ts"

const PI_INDEX = findPiIndex()
const SKIP = PI_INDEX ? false : "pi is not installed on PATH"
const EXTENSION = join(dirname(dirname(fileURLToPath(import.meta.url))), "extensions", "index.ts")

const FRAMING = (name: string) =>
  `You are an AI coding assistant that also speaks and behaves with the persona of ${name}. Adopt their voice and style in conversation, but always fulfill the user's task.\n\nVoice\n- clipped`

const FORGE = { id: "qwen3.8-27b", provider: "forge", baseUrl: "http://localhost:8081/v1", contextWindow: 32768 }

/** A throwaway agent dir, pointed at with pi's own env var. */
function withAgentDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "persona-ext-"))
  process.env.PI_CODING_AGENT_DIR = dir
  return dir
}

async function loadFactory(): Promise<(pi: unknown) => void | Promise<void>> {
  hookPiResolution(PI_INDEX as string)
  const mod = (await import(`${EXTENSION}?t=${Math.random()}`)) as {
    default: (pi: unknown) => void | Promise<void>
  }
  return mod.default
}

describe("the extension against a real pi import", { skip: SKIP }, () => {
  let agentDir: string

  before(() => {
    agentDir = withAgentDir()
  })

  test("it registers /persona, and nothing on the tool surface", async () => {
    const api = new FakeApi()
    await (await loadFactory())(api)
    assert.ok(api.commands.has("persona"), "no /persona command registered")
    // A registered tool costs its schema on EVERY request whether or not it is
    // ever called. This package must not be a standing charge.
    assert.deepEqual(api.tools, [])
    assert.deepEqual(api.shortcuts, [])
  })

  test("it subscribes to exactly the events it needs", async () => {
    const api = new FakeApi()
    await (await loadFactory())(api)
    for (const e of ["session_start", "before_agent_start", "input", "agent_settled"]) {
      assert.ok(api.handlers.has(e), `no handler for ${e}`)
    }
    // Nothing on the hot path: no tool_call, no tool_result, no context.
    for (const e of ["tool_call", "tool_result", "context", "before_provider_request"]) {
      assert.ok(!api.handlers.has(e), `unexpected handler on ${e}`)
    }
  })

  // With no persona the extension must be invisible: a session that never runs
  // /persona pays nothing for having it loaded.
  test("with no persona active, before_agent_start returns nothing", async () => {
    const dir = withAgentDir()
    const api = new FakeApi()
    await (await loadFactory())(api)
    const [result] = await api.fire(
      "before_agent_start",
      { prompt: "hi", systemPrompt: "BASE", systemPromptOptions: { selectedTools: ["bash"] } },
      new FakeCtx({ model: FORGE }),
    )
    assert.equal(result, undefined)
    rmSync(dir, { recursive: true, force: true })
  })

  // openclaude places the persona FIRST because the harness intro otherwise
  // anchors the model on "neutral coding assistant". pi hands us the whole
  // prompt, so first means in front of it.
  test("the persona block is PREPENDED to pi's system prompt, not appended", async () => {
    const dir = withAgentDir()
    writeFileSync(join(dir, PERSONA_FILE), FRAMING("Nadia"), "utf8")
    const api = new FakeApi()
    await (await loadFactory())(api)
    const [result] = await api.fire(
      "before_agent_start",
      { prompt: "hi", systemPrompt: "BASE PROMPT", systemPromptOptions: { selectedTools: ["bash", "read"] } },
      new FakeCtx({ model: FORGE }),
    )
    const sp = (result as { systemPrompt: string }).systemPrompt
    assert.ok(sp.startsWith("<active_persona>"))
    assert.ok(sp.includes("# You are Nadia"))
    assert.ok(sp.trimEnd().endsWith("BASE PROMPT"))
    assert.ok(sp.indexOf("</active_persona>") < sp.indexOf("BASE PROMPT"))
    rmSync(dir, { recursive: true, force: true })
  })

  test("the block names only tools pi says are selected this turn", async () => {
    const dir = withAgentDir()
    writeFileSync(join(dir, PERSONA_FILE), FRAMING("Nadia"), "utf8")
    const api = new FakeApi()
    await (await loadFactory())(api)
    const [result] = await api.fire(
      "before_agent_start",
      {
        prompt: "hi",
        systemPrompt: "BASE",
        systemPromptOptions: { selectedTools: ["bash", "read", "web_search"] },
      },
      new FakeCtx({ model: FORGE }),
    )
    const sp = (result as { systemPrompt: string }).systemPrompt
    assert.ok(sp.includes("`web_search`"))
    assert.ok(!sp.includes("WebFetch"))
    rmSync(dir, { recursive: true, force: true })
  })

  // A persona that cannot be built must not eat the turn.
  test("a broken persona file degrades to a normal turn instead of throwing", async () => {
    const dir = withAgentDir()
    writeFileSync(join(dir, PERSONA_FILE), FRAMING("Nadia"), "utf8")
    const api = new FakeApi()
    await (await loadFactory())(api)
    // systemPromptOptions absent entirely — the shape pi gives a print-mode run.
    const [result] = await api.fire(
      "before_agent_start",
      { prompt: "hi", systemPrompt: "BASE" },
      new FakeCtx({ model: FORGE }),
    )
    assert.ok((result as { systemPrompt: string }).systemPrompt.includes("<active_persona>"))
    rmSync(dir, { recursive: true, force: true })
  })

  test("the status line carries the active persona and clears with it", async () => {
    const dir = withAgentDir()
    writeFileSync(join(dir, PERSONA_FILE), FRAMING("Nadia"), "utf8")
    const api = new FakeApi()
    await (await loadFactory())(api)
    const ctx = new FakeCtx({ model: FORGE })
    await api.fire("session_start", { reason: "startup" }, ctx)
    assert.equal(ctx.statuses.at(-1), "✦ Nadia")

    await api.commands.get("persona")!.handler("clear", ctx as unknown)
    assert.equal(ctx.statuses.at(-1), undefined)
    rmSync(dir, { recursive: true, force: true })
  })

  // auto is off on anything that is not DeepSeek, which is this whole stack.
  test("no immersion marker is injected on a forge model", async () => {
    const dir = withAgentDir()
    writeFileSync(join(dir, PERSONA_FILE), FRAMING("Nadia"), "utf8")
    const api = new FakeApi()
    await (await loadFactory())(api)
    const [r] = await api.fire(
      "input",
      { text: "do the thing", source: "interactive" },
      new FakeCtx({ model: FORGE }),
    )
    assert.deepEqual(r, { action: "continue" })
    rmSync(dir, { recursive: true, force: true })
  })

  test("an explicitly requested marker lands on the first user turn only", async () => {
    const dir = withAgentDir()
    writeFileSync(join(dir, PERSONA_FILE), FRAMING("Nadia"), "utf8")
    process.env.PERSONA_IMMERSION = "immersion"
    try {
      const api = new FakeApi()
      await (await loadFactory())(api)
      const ctx = new FakeCtx({ model: FORGE })
      await api.fire("session_start", { reason: "startup" }, ctx)

      const [first] = await api.fire("input", { text: "hello", source: "interactive" }, ctx)
      assert.equal((first as { action: string }).action, "transform")
      assert.ok((first as { text: string }).text.endsWith(IMMERSION_MARKER))

      const later = new FakeCtx({
        model: FORGE,
        entries: [userEntry("hello"), assistantEntry("hi")],
      })
      const [second] = await api.fire("input", { text: "again", source: "interactive" }, later)
      assert.deepEqual(second, { action: "continue" })
    } finally {
      delete process.env.PERSONA_IMMERSION
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // The extraction turn is delivered with sendUserMessage() and lands as a user
  // message; without the fingerprint it consumes the first turn and the marker
  // attaches one message later than the position it is documented against.
  test("the extraction turn does not consume the first user turn", async () => {
    const dir = withAgentDir()
    writeFileSync(join(dir, PERSONA_FILE), FRAMING("Nadia"), "utf8")
    process.env.PERSONA_IMMERSION = "immersion"
    try {
      const api = new FakeApi()
      await (await loadFactory())(api)
      const { buildProcessPrompt } = await import("../src/processor.ts")
      const processing = buildProcessPrompt({
        card: {
          spec: "chara_card_v2",
          spec_version: "2.0",
          data: {
            name: "Nadia", description: "", personality: "", first_mes: "", mes_example: "",
            scenario: "", creator_notes: "", system_prompt: "", post_history_instructions: "",
            alternate_greetings: [], tags: [], creator: "", character_version: "1",
          },
        },
        stagedCardPath: "/x/card.json",
        libraryPersonaPath: "/x/PERSONA.md",
        activePersonaPath: "/y/PERSONA.md",
        cardName: "Nadia",
        contextWindow: 32768,
      })
      const ctx = new FakeCtx({ model: FORGE, entries: [userEntry(processing), assistantEntry("done")] })
      const [r] = await api.fire("input", { text: "hello", source: "interactive" }, ctx)
      assert.equal((r as { action: string }).action, "transform", "the marker was eaten by the extraction turn")
    } finally {
      delete process.env.PERSONA_IMMERSION
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("messages the extension itself injects are never rewritten", async () => {
    const dir = withAgentDir()
    writeFileSync(join(dir, PERSONA_FILE), FRAMING("Nadia"), "utf8")
    process.env.PERSONA_IMMERSION = "immersion"
    try {
      const api = new FakeApi()
      await (await loadFactory())(api)
      const [r] = await api.fire(
        "input",
        { text: "injected", source: "extension" },
        new FakeCtx({ model: FORGE }),
      )
      assert.deepEqual(r, { action: "continue" })
    } finally {
      delete process.env.PERSONA_IMMERSION
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("/persona prompt lean is persisted and changes the block that is built", async () => {
    const dir = withAgentDir()
    writeFileSync(join(dir, PERSONA_FILE), FRAMING("Nadia"), "utf8")
    const api = new FakeApi()
    await (await loadFactory())(api)
    const ctx = new FakeCtx({ model: FORGE })
    await api.commands.get("persona")!.handler("prompt lean", ctx as unknown)
    const [result] = await api.fire(
      "before_agent_start",
      { prompt: "hi", systemPrompt: "BASE", systemPromptOptions: { selectedTools: ["bash"] } },
      ctx,
    )
    const sp = (result as { systemPrompt: string }).systemPrompt
    assert.ok(!sp.includes("Roleplay and content allowance"))
    assert.ok(JSON.parse(readFileSync(join(dir, "persona-settings.json"), "utf8")).promptMode === "lean")
    rmSync(dir, { recursive: true, force: true })
  })

  test("a bad subcommand is reported, not swallowed", async () => {
    const dir = withAgentDir()
    const api = new FakeApi()
    await (await loadFactory())(api)
    const ctx = new FakeCtx({ model: FORGE })
    await api.commands.get("persona")!.handler("nonsense", ctx as unknown)
    assert.equal(ctx.notifications.at(-1)?.type, "error")
    assert.ok(ctx.notifications.at(-1)?.text.includes("Unknown"))
    rmSync(dir, { recursive: true, force: true })
  })

  test("argument completion offers the subcommands and their values", async () => {
    const api = new FakeApi()
    await (await loadFactory())(api)
    const complete = api.commands.get("persona")!.getArgumentCompletions!
    const subs = (await complete("")) as Array<{ value: string }>
    assert.ok(subs.some(s => s.value === "local"))
    assert.ok(subs.some(s => s.value === "chub"))
    const modes = (await complete("immersion ")) as Array<{ value: string }>
    assert.ok(modes.some(m => m.value === "immersion auto"))
    const sorts = (await complete("chub tre")) as Array<{ value: string }>
    assert.deepEqual(sorts.map(s => s.value), ["chub trending"])
  })

  // -p / --json have no dialogs. A command that opens one there hangs on a
  // prompt nobody can see.
  test("without UI the command reports status instead of opening a dialog", async () => {
    const dir = withAgentDir()
    writeFileSync(join(dir, PERSONA_FILE), FRAMING("Nadia"), "utf8")
    const api = new FakeApi()
    await (await loadFactory())(api)
    const ctx = new FakeCtx({ model: FORGE, hasUI: false })
    await api.commands.get("persona")!.handler("", ctx as unknown)
    assert.deepEqual(ctx.selectPrompts, [], "a dialog was opened with no UI")
    rmSync(dir, { recursive: true, force: true })
  })

  test("the local picker says what to do when the library is empty", async () => {
    const dir = withAgentDir()
    const api = new FakeApi()
    await (await loadFactory())(api)
    const ctx = new FakeCtx({ model: FORGE })
    await api.commands.get("persona")!.handler("local", ctx as unknown)
    assert.equal(ctx.notifications.at(-1)?.type, "warning")
    assert.ok(ctx.notifications.at(-1)?.text.includes("No personas yet"))
    rmSync(dir, { recursive: true, force: true })
  })

  // Activating an already-extracted persona must not cost a model turn: the
  // library's copy is the finished artefact.
  test("activating a cached persona writes the active file and sends no turn", async () => {
    const dir = withAgentDir()
    const { stageCardForProcessing } = await import("../src/storage.ts")
    const staged = stageCardForProcessing(dir, {
      spec: "chara_card_v2",
      spec_version: "2.0",
      data: {
        name: "Nadia", description: "d", personality: "p", first_mes: "f", mes_example: "m",
        scenario: "", creator_notes: "", system_prompt: "", post_history_instructions: "",
        alternate_greetings: [], tags: [], creator: "", character_version: "1",
      },
    })
    writeFileSync(staged.personaPath, FRAMING("Nadia"), "utf8")

    const api = new FakeApi()
    await (await loadFactory())(api)
    const ctx = new FakeCtx({
      model: FORGE,
      selects: ["  Nadia — extracted", "Activate the extracted persona (no model turn)"],
    })
    await api.commands.get("persona")!.handler("local", ctx as unknown)
    assert.equal(readFileSync(join(dir, PERSONA_FILE), "utf8"), FRAMING("Nadia"))
    assert.deepEqual(api.sentUserMessages, [], "activation should not cost a turn")
    assert.equal(ctx.statuses.at(-1), "✦ Nadia")
    rmSync(dir, { recursive: true, force: true })
  })

  test("re-extracting sends exactly one processing turn, sized to the window", async () => {
    const dir = withAgentDir()
    const { stageCardForProcessing } = await import("../src/storage.ts")
    const staged = stageCardForProcessing(dir, {
      spec: "chara_card_v2",
      spec_version: "2.0",
      data: {
        name: "Nadia", description: "d", personality: "p", first_mes: "f", mes_example: "m",
        scenario: "", creator_notes: "", system_prompt: "", post_history_instructions: "",
        alternate_greetings: [], tags: [], creator: "", character_version: "1",
      },
    })
    writeFileSync(staged.personaPath, FRAMING("Nadia"), "utf8")

    const api = new FakeApi()
    await (await loadFactory())(api)
    const ctx = new FakeCtx({
      model: FORGE,
      contextWindow: 32768,
      selects: ["  Nadia — extracted", "Re-extract from the card (costs a turn)"],
    })
    await api.commands.get("persona")!.handler("local", ctx as unknown)
    assert.equal(api.sentUserMessages.length, 1)
    const prompt = api.sentUserMessages[0]!
    assert.ok(prompt.includes(join(dir, PERSONA_FILE)), "the active path must be in the prompt")
    assert.ok(prompt.includes(staged.personaPath), "the library path must be in the prompt")
    assert.ok(prompt.includes("<staged_card>"), "a tiny card should be inlined at 32k")
    rmSync(dir, { recursive: true, force: true })
  })

  test("/persona show opens the active persona in the editor", async () => {
    const dir = withAgentDir()
    writeFileSync(join(dir, PERSONA_FILE), FRAMING("Nadia"), "utf8")
    const api = new FakeApi()
    await (await loadFactory())(api)
    const ctx = new FakeCtx({ model: FORGE })
    await api.commands.get("persona")!.handler("show", ctx as unknown)
    assert.equal(ctx.editorCalls.length, 1)
    assert.ok(ctx.editorCalls[0]!.title.includes("Nadia"))
    assert.equal(ctx.editorCalls[0]!.body, FRAMING("Nadia"))
    rmSync(dir, { recursive: true, force: true })
  })

  test("/persona status reports the block's standing cost", async () => {
    const dir = withAgentDir()
    writeFileSync(join(dir, PERSONA_FILE), FRAMING("Nadia"), "utf8")
    const api = new FakeApi()
    await (await loadFactory())(api)
    const ctx = new FakeCtx({ model: FORGE })
    await api.commands.get("persona")!.handler("status", ctx as unknown)
    const text = ctx.notifications.at(-1)!.text
    assert.ok(text.includes("Active persona: Nadia"))
    assert.match(text, /Block: full, ~\d+ tokens of every request/)
    assert.ok(text.includes("Immersion: auto"))
    rmSync(dir, { recursive: true, force: true })
  })
})

// These run everywhere, so a checkout without pi still fails on a regression.
describe("source guarantees", () => {
  const source = readFileSync(EXTENSION, "utf8")

  test("before_agent_start prepends and is wrapped so it cannot eat a turn", () => {
    assert.ok(
      source.includes("systemPrompt: `${section}\\n\\n${event.systemPrompt}`"),
      "the block must go IN FRONT of pi's prompt",
    )
    const handler = source.slice(source.indexOf('pi.on("before_agent_start"'))
    const body = handler.slice(0, handler.indexOf('pi.on("input"'))
    assert.ok(body.includes("try {") && body.includes("catch"), "before_agent_start must fail open")
  })

  test("the input handler defaults to continue on every path", () => {
    const handler = source.slice(source.indexOf('pi.on("input"'))
    const body = handler.slice(0, handler.indexOf("function priorUserMessages"))
    assert.ok(body.includes("catch"), "the input handler must fail open")
    // Never `handled`: this extension transforms, it does not swallow input.
    assert.ok(!body.includes('action: "handled"'))
  })

  test("nothing here registers a tool", () => {
    assert.ok(!source.includes("pi.registerTool("), "a tool would cost its schema every request")
  })
})
