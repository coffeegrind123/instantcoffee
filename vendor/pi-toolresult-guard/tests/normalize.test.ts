// The decision, on its own. No pi, no extension, no I/O.

import assert from "node:assert/strict"
import { test } from "node:test"

import { normalizeContent, placeholderText } from "../src/normalize.ts"

const ok = [{ type: "text", text: "hello" }]

// The property this package lives or dies on. A healthy result must return
// null, because null means the handler returns undefined, which means
// `modified` stays false, which means pi takes byte-for-byte the path it took
// before this package existed. Anything else is a behaviour change on every
// tool call in the session.
test("a renderable result is left completely alone", () => {
  assert.equal(normalizeContent(ok, "bash"), null)
  assert.equal(normalizeContent([], "bash"), null, "an empty array is renderable and legal")
  assert.equal(
    normalizeContent([{ type: "text", text: "a" }, { type: "image", data: "AA", mimeType: "image/png" }], "read"),
    null,
  )
  // getTextOutput reads `c.text || ""`, so a missing or non-string text is safe
  // and is NOT this package's business to rewrite.
  assert.equal(normalizeContent([{ type: "text" }], "bash"), null)
  assert.equal(normalizeContent([{ type: "custom", payload: 1 }], "bash"), null)
})

// The shape that killed two sessions. `afterToolCall` is handed the tool's
// return value and reads `.content` off it, so `return "message"` arrives here
// as undefined and the message itself is already gone.
test("a missing content is replaced with a placeholder, not an empty array", () => {
  for (const bad of [undefined, null, 0, 42, true, { text: "hi" }]) {
    const repair = normalizeContent(bad, "prinny")!
    assert.ok(repair, `${String(bad)} should be repaired`)
    assert.equal(repair.recovered, false)
    assert.equal(repair.content.length, 1)
    assert.equal(repair.content[0]!.type, "text")
    assert.ok(String(repair.content[0]!.text).includes("prinny"))
    assert.ok(repair.reason.startsWith("prinny: content was "))
  }
})

// An empty array would render, but it makes a claim ("the tool ran and produced
// nothing") that is not true, and some providers reject a tool result with no
// content at all.
test("the placeholder says the call completed and the output is gone", () => {
  const text = placeholderText("prinny")
  assert.ok(text.startsWith("prinny "))
  assert.ok(text.includes("output was lost"))
  assert.ok(text.includes("The call itself completed"))
  assert.ok(text.includes("rather than as an error to retry blindly"))
  assert.equal(placeholderText("").startsWith("a tool "), true)
})

// The one shape whose payload survives.
test("a string content is recovered as a text block, not thrown away", () => {
  const repair = normalizeContent("the tool's actual message", "prinny")!
  assert.equal(repair.recovered, true)
  assert.deepEqual(repair.content, [{ type: "text", text: "the tool's actual message" }])
  assert.ok(repair.reason.includes("was a string"))
  // Even an empty string is the tool's own output, and dropping it would lose
  // the only evidence of what happened.
  assert.deepEqual(normalizeContent("", "x")!.content, [{ type: "text", text: "" }])
})

// getTextOutput's `.filter(c => c.type === "text")` dereferences every element,
// so one null in an otherwise fine array is as fatal as no array at all.
test("unrenderable elements are dropped and the rest survives", () => {
  const repair = normalizeContent([{ type: "text", text: "keep" }, null, undefined, "loose", 7], "bash")!
  assert.equal(repair.recovered, true)
  assert.deepEqual(repair.content, [{ type: "text", text: "keep" }])
  assert.ok(repair.reason.includes("dropped 4 unrenderable content blocks"))
  assert.ok(normalizeContent([{ type: "text", text: "a" }, null], "b")!.reason.includes("dropped 1 unrenderable content block"))
})

test("an array with nothing renderable in it falls back to the placeholder", () => {
  const repair = normalizeContent([null, 1, "x"], "mcp__thing")!
  assert.equal(repair.recovered, false)
  assert.equal(repair.content.length, 1)
  assert.ok(repair.reason.includes("all 3 content blocks were unrenderable"))
})

test("a block with no string type is not renderable", () => {
  const repair = normalizeContent([{ text: "no type" }, { type: 7 }], "x")!
  assert.equal(repair.content.length, 1)
  assert.equal(repair.recovered, false)
})

// normalizeToolResultImages does `Buffer.from(block.data, "base64")` before any
// guard. That throw is caught and degrades to an error result — still the wrong
// answer for a call that worked, so the block goes with the rest.
test("an image block without string data or mimeType is dropped", () => {
  const bad = [
    { type: "text", text: "fine" },
    { type: "image", mimeType: "image/png" },
    { type: "image", data: "AA" },
    { type: "image", data: 5, mimeType: "image/png" },
  ]
  const repair = normalizeContent(bad, "read")!
  assert.deepEqual(repair.content, [{ type: "text", text: "fine" }])
  assert.ok(repair.reason.includes("dropped 3"))
})
