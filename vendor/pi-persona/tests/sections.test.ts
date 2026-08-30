import assert from "node:assert/strict"
import { test } from "node:test"

import { approxTokens, describeCard, flattenCardForViewer } from "../src/sections.ts"
import type { CharaCardV2 } from "../src/types.ts"

function card(overrides: Partial<CharaCardV2["data"]> = {}): CharaCardV2 {
  return {
    spec: "chara_card_v2",
    spec_version: "2.0",
    data: {
      name: "Nadia",
      description: "a description",
      personality: "",
      first_mes: "hello",
      mes_example: "",
      scenario: "",
      creator_notes: "",
      system_prompt: "",
      post_history_instructions: "",
      alternate_greetings: ["one", "two"],
      tags: ["dev", "sardonic", "coffee"],
      creator: "someone",
      character_version: "1",
      ...overrides,
    },
  }
}

test("every documented card field gets a section", () => {
  const names = flattenCardForViewer(card()).map(s => s.name)
  for (const expected of [
    "name",
    "description",
    "personality",
    "first_mes",
    "alternate_greetings",
    "mes_example",
    "scenario",
    "creator_notes",
    "system_prompt",
    "post_history_instructions",
    "tags",
    "character_book",
    "extensions.depth_prompt",
    "extensions.chub",
    "avatar",
    "creator",
    "character_version",
    "spec",
  ]) {
    assert.ok(names.includes(expected), `no section for ${expected}`)
  }
})

// Empty sections are labelled rather than hidden: "this card has no
// mes_example" is exactly what you want to know before spending a turn
// extracting a voice from it.
test("empty is detected for blanks, empty arrays and empty objects", () => {
  const s = flattenCardForViewer(card({ personality: "   " }))
  const by = (n: string) => s.find(x => x.name === n)!
  assert.equal(by("personality").isEmpty, true)
  assert.equal(by("character_book").isEmpty, true)
  assert.equal(by("extensions.depth_prompt").isEmpty, true)
  assert.equal(by("description").isEmpty, false)
})

test("array sections are numbered so a greeting can be referred to", () => {
  const s = flattenCardForViewer(card()).find(x => x.name === "alternate_greetings")!
  assert.equal(s.kind, "array")
  assert.ok(s.content.includes("[1] one"))
  assert.ok(s.content.includes("[2] two"))
})

test("token counts are reported per section", () => {
  const s = flattenCardForViewer(card({ description: "x".repeat(400) }))
  assert.equal(s.find(x => x.name === "description")!.tokenCount, 100)
  assert.equal(approxTokens(""), 0)
})

test("describeCard gives a one-line row with a total cost", () => {
  const line = describeCard(card())
  assert.ok(line.startsWith("Nadia — "))
  assert.match(line, /~\d+ tok/)
  assert.ok(line.includes("by someone"))
  assert.ok(line.includes("dev, sardonic, coffee"))
})

test("a card with no tags or creator still produces a row", () => {
  const line = describeCard(card({ tags: [], creator: "" }))
  assert.ok(line.startsWith("Nadia — "))
  assert.match(line, /~\d+ tok/)
})
