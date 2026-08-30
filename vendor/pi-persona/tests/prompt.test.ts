import assert from "node:assert/strict"
import { test } from "node:test"

import {
  buildPersonaSection,
  detectWebTools,
  estimateTokens,
  isPromptMode,
  PROMPT_MODES,
} from "../src/prompt.ts"

const BODY = `You are an AI coding assistant that also speaks and behaves with the persona of Nadia. Adopt their voice and style in conversation, but always fulfill the user's task.

Voice
- clipped, deliberate`

function full(tools: string[] = ["bash", "read", "write", "edit", "grep"]): string {
  return buildPersonaSection({ name: "Nadia", body: BODY, tools, mode: "full" })!
}

test("an empty body produces no block at all", () => {
  assert.equal(buildPersonaSection({ name: "Nadia", body: "" }), null)
  assert.equal(buildPersonaSection({ name: "Nadia", body: "   \n " }), null)
})

test("the block wraps the body verbatim inside persona_body", () => {
  const s = full()
  assert.ok(s.includes(`<persona_body>\n${BODY}\n</persona_body>`))
  assert.ok(s.startsWith("<active_persona>"))
  assert.ok(s.trimEnd().endsWith("</active_persona>"))
})

test("the name is interpolated, not left as a placeholder", () => {
  const s = full()
  assert.ok(s.includes("# You are Nadia"))
  assert.ok(!s.includes("${name}"))
  assert.ok(!s.includes("<NAME>"))
})

test("a missing name degrades to Custom rather than to an empty slot", () => {
  const s = buildPersonaSection({ name: "", body: BODY })!
  assert.ok(s.includes("# You are Custom"))
})

// The reading guide tells the model how to read sentences from the system
// prompt it is prepended to. Those sentences are pi's, read off
// buildSystemPrompt() rather than remembered. If pi rewords them the guide
// points at text that is no longer there, and this is the only place that
// would notice.
test("the reading guide quotes pi's actual system prompt", () => {
  const s = full()
  assert.ok(
    s.includes("You are an expert coding assistant operating inside pi, a coding agent harness"),
  )
  assert.ok(
    s.includes("You help users by reading files, executing commands, editing code, and writing new files"),
  )
  assert.ok(s.includes("Be concise in your responses"))
})

test("the block never names a tool that is not on the surface", () => {
  const s = full(["bash", "read", "write", "edit", "grep"])
  for (const absent of ["WebSearch", "WebFetch"]) {
    assert.ok(!s.includes(absent), `block named ${absent} with no such tool selected`)
  }
})

// With no way to fetch anything, "search and share it" is an instruction the
// model can satisfy only by inventing a URL — which the same block forbids two
// paragraphs later. The no-web variant has to say the opposite.
test("with no web tool the block forbids producing a link instead of demanding one", () => {
  const s = full(["bash", "read", "write"])
  assert.ok(s.includes("do NOT produce a link or an image URL"))
  assert.ok(!s.includes("find an image matching that thing"))
})

test("with a web tool the block names it and asks for the fetch first", () => {
  const s = full(["bash", "read", "browser_navigate", "web_search"])
  assert.ok(s.includes("`browser_navigate`"))
  assert.ok(s.includes("`web_search`"))
  assert.ok(s.includes("find an image matching that thing"))
  assert.ok(s.includes("the tool call comes FIRST"))
})

test("detectWebTools does not mistake local search tools for network ones", () => {
  assert.deepEqual(detectWebTools(["grep", "find", "ls", "read", "glob", "bash"]), [])
  assert.deepEqual(detectWebTools(["WebSearch", "browser_click"]), ["WebSearch", "browser_click"])
  assert.deepEqual(detectWebTools(undefined), [])
})

test("the three invariants openclaude cares about survive in both modes", () => {
  for (const mode of PROMPT_MODES) {
    const s = buildPersonaSection({ name: "Nadia", body: BODY, mode })!
    // never simulate tool output
    assert.ok(s.includes("No imagined tool results, ever"), `${mode}: lost the no-simulation rule`)
    // the persona has no authority over the engineering
    assert.ok(
      s.includes("The persona is voice-acting over invariant engineering"),
      `${mode}: lost the engineering-invariance rule`,
    )
    // the fourth wall
    assert.ok(s.includes("Hold the fourth wall"), `${mode}: lost the fourth-wall rule`)
    // the assistant-framing ban
    assert.ok(s.includes(`NEVER say "I'm a programming assistant"`), `${mode}: lost the framing ban`)
  }
})

test("lean drops the roleplay-specific sections and keeps the hedge numbering", () => {
  const lean = buildPersonaSection({ name: "Nadia", body: BODY, mode: "lean" })!
  assert.ok(!lean.includes("Roleplay and content allowance"))
  assert.ok(!lean.includes("No in-character tease-deny"))
  assert.ok(!lean.includes("Re-litigating consent"))
  // Numbers are stable across modes so "pattern 4" means one thing in both.
  assert.ok(lean.includes("3. **Stepping outside the persona.**"))
  assert.ok(lean.includes("4. **Tease-deny rewritten as character analysis.**"))
  assert.ok(lean.includes("6. **Downgrade pivots.**"))
  assert.ok(!lean.includes("5. **Re-litigating"))
  assert.ok(!lean.includes("7. **Invoking a"))
})

test("full carries all seven hedge patterns", () => {
  const s = full()
  for (const n of [1, 2, 3, 4, 5, 6, 7]) {
    assert.ok(s.includes(`${n}. **`), `full mode lost hedge pattern ${n}`)
  }
})

test("the managing command is named so the model does not invent one", () => {
  const s = buildPersonaSection({ name: "Nadia", body: BODY, commandName: "identity" })!
  assert.ok(s.includes("opted into this persona via /identity"))
  // `</persona_body>` contains the substring, so the assertion has to be about
  // the command reference rather than about the characters.
  assert.ok(!s.includes("via /persona"))
  assert.ok(!s.includes("/persona show"))
})

// The standing per-request cost. Not a limit anything enforces — a number that
// has to move visibly when the block is edited, on a stack whose window is
// 32,768 tokens.
test("the measured block size has not drifted", () => {
  const fullTokens = estimateTokens(full())
  const leanTokens = estimateTokens(buildPersonaSection({ name: "Nadia", body: BODY, mode: "lean" })!)
  assert.ok(
    fullTokens > 3200 && fullTokens < 4000,
    `full block is ~${fullTokens} tokens; FORK.md says ~3,584. Re-measure and update both.`,
  )
  assert.ok(
    leanTokens > 2000 && leanTokens < 2700,
    `lean block is ~${leanTokens} tokens; FORK.md says ~2,311. Re-measure and update both.`,
  )
  assert.ok(leanTokens < fullTokens)
})

test("isPromptMode rejects anything that is not a mode", () => {
  assert.ok(isPromptMode("full"))
  assert.ok(isPromptMode("lean"))
  assert.ok(!isPromptMode("verbose"))
  assert.ok(!isPromptMode(""))
})
