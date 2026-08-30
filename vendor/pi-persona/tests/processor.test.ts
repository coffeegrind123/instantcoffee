import assert from "node:assert/strict"
import { test } from "node:test"

import {
  buildProcessPrompt,
  EXTRACTION_PROMPT,
  FALLBACK_INLINE_BYTES,
  inlineThresholdBytes,
  isProcessPrompt,
  MAX_INLINE_BYTES,
  PROCESS_PROMPT_PREFIX,
  shapeSummary,
} from "../src/processor.ts"
import type { CharaCardV2 } from "../src/types.ts"

function card(overrides: Partial<CharaCardV2["data"]> = {}): CharaCardV2 {
  return {
    spec: "chara_card_v2",
    spec_version: "2.0",
    data: {
      name: "Nadia",
      description: "d",
      personality: "p",
      first_mes: "f",
      mes_example: "m",
      scenario: "s",
      creator_notes: "c",
      system_prompt: "",
      post_history_instructions: "",
      alternate_greetings: ["g1", "g2"],
      tags: ["a", "b"],
      creator: "someone",
      character_version: "1",
      ...overrides,
    },
  }
}

const PATHS = {
  stagedCardPath: "/home/pi/.pi/agent/personas/nadia-abc123/card.json",
  libraryPersonaPath: "/home/pi/.pi/agent/personas/nadia-abc123/PERSONA.md",
  activePersonaPath: "/home/pi/.pi/agent/PERSONA.md",
  cardName: "Nadia",
}

// 50 KB of card is ~12.5k tokens. On this stack's 32,768-token window that is
// 40% of the budget spent before the model has read the instruction. The jq
// path exists so it does not have to be.
test("the inline threshold scales with the window and never exceeds upstream's cap", () => {
  assert.equal(inlineThresholdBytes(32768), 19660)
  assert.equal(inlineThresholdBytes(98304), MAX_INLINE_BYTES)
  assert.equal(inlineThresholdBytes(1_000_000), MAX_INLINE_BYTES)
  assert.ok(inlineThresholdBytes(8192) >= 2000)
})

test("an unknown window falls back small rather than guessing large", () => {
  for (const v of [null, undefined, 0, -1, Number.NaN]) {
    assert.equal(inlineThresholdBytes(v as number), FALLBACK_INLINE_BYTES)
  }
})

test("a small card is inlined and no read is asked for", () => {
  const p = buildProcessPrompt({ card: card(), ...PATHS, contextWindow: 32768 })
  assert.ok(p.includes("<staged_card>"))
  assert.ok(p.includes('"name": "Nadia"'))
  assert.ok(!p.includes("<card_shape>"))
  assert.ok(!p.includes("jq -r '.data.description'"))
})

test("a large card gets the shape summary and the jq walk, never a read", () => {
  const p = buildProcessPrompt({
    card: card({ description: "x".repeat(60_000) }),
    ...PATHS,
    contextWindow: 32768,
  })
  assert.ok(!p.includes("<staged_card>"))
  assert.ok(p.includes("<card_shape>"))
  assert.ok(p.includes("DO NOT call the `read` tool"))
  assert.ok(p.includes(`jq -r '.data.description' ${PATHS.stagedCardPath}`))
  // The whole point: the card body is not in the prompt.
  assert.ok(!p.includes("x".repeat(1000)))
})

// The processing turn only does anything if both writes happen. openclaude
// spells this out because a model that prints the persona and stops leaves the
// user with a command that appeared to work and changed nothing.
test("both write targets are named and mandatory", () => {
  const p = buildProcessPrompt({ card: card(), ...PATHS, contextWindow: 32768 })
  assert.ok(p.includes(PATHS.libraryPersonaPath))
  assert.ok(p.includes(PATHS.activePersonaPath))
  assert.ok(p.includes("The write calls are MANDATORY"))
  assert.ok(p.includes("Use the `write` tool TWICE"))
})

// pi has no AskUserQuestion tool. Telling the model to call one is how you get
// an invented call; telling it to ask and then write anyway commits an answer
// the user has not given.
test("ambiguity is routed to a plain question that writes nothing", () => {
  const p = buildProcessPrompt({ card: card(), ...PATHS, contextWindow: 32768 })
  assert.ok(!p.includes("AskUserQuestion"))
  assert.ok(p.includes("ASK THE USER AND STOP"))
  assert.ok(p.includes("Do not ask a question and then write a file anyway"))
})

// The framing sentence is what parsePersonaName reads the name out of. If the
// extraction prompt stops mandating it, every persona is called "Custom".
test("the extraction prompt mandates the framing sentence and says why", () => {
  assert.ok(EXTRACTION_PROMPT.includes("the persona of <NAME>."))
  const p = buildProcessPrompt({ card: card(), ...PATHS, contextWindow: 32768 })
  assert.ok(p.includes("The extension reads the persona's NAME back out of it"))
})

test("the prompt carries its own fingerprint so the first-turn test can skip it", () => {
  const p = buildProcessPrompt({ card: card(), ...PATHS, contextWindow: 32768 })
  assert.ok(p.startsWith(PROCESS_PROMPT_PREFIX))
  assert.ok(isProcessPrompt(p))
  assert.ok(!isProcessPrompt("what does this repo do"))
  assert.ok(!isProcessPrompt(undefined))
  assert.ok(!isProcessPrompt(42))
})

test("the command name reaches the prompt", () => {
  const p = buildProcessPrompt({ card: card(), ...PATHS, contextWindow: 32768, commandName: "identity" })
  assert.ok(p.startsWith(`${PROCESS_PROMPT_PREFIX}identity.`))
  assert.ok(p.includes("/identity show"))
})

test("the shape summary reports lengths, not contents", () => {
  const s = shapeSummary(card({ description: "y".repeat(500) }))
  assert.ok(s.includes("description: 500 chars"))
  assert.ok(!s.includes("y".repeat(50)))
  assert.ok(s.includes("alternate_greetings: 2 entries"))
  assert.ok(s.includes("character_book.entries: 0"))
  assert.ok(s.includes("extensions.depth_prompt: absent"))
})

test("the extraction guidelines still separate voice from content mandates", () => {
  assert.ok(EXTRACTION_PROMPT.includes("The output is an *identity*, not a content policy"))
  assert.ok(EXTRACTION_PROMPT.includes("IGNORE (do not surface"))
  assert.ok(EXTRACTION_PROMPT.includes("Operating directives"))
})
