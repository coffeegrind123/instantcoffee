import assert from "node:assert/strict"
import { test } from "node:test"

import {
  ANALYSIS_MARKER,
  chooseMarker,
  IMMERSION_MARKER,
  IMMERSION_MODES,
  isFirstUserTurn,
  isImmersionMode,
  looksLikeDeepSeek,
  maybeAppendMarker,
} from "../src/immersion.ts"

const FORGE = { id: "qwen3.8-27b", provider: "forge", baseUrl: "http://localhost:8081/v1" }
const DEEPSEEK_PROVIDER = { id: "deepseek-chat", provider: "deepseek", baseUrl: "https://api.deepseek.com" }
// The case that matters on this stack: a DeepSeek model served THROUGH forge.
// A provider-only check reads this as forge and never fires.
const DEEPSEEK_VIA_FORGE = { id: "DeepSeek-V4-GGUF", provider: "forge", baseUrl: "http://localhost:8081/v1" }

// These strings are the mechanism. A paraphrase, a translation or a "cleanup"
// is a different string, and a different string routes nowhere.
test("the markers are byte-exact", () => {
  assert.ok(IMMERSION_MARKER.startsWith("\n\n【角色沉浸要求】"))
  assert.ok(IMMERSION_MARKER.includes("请以角色第一人称进行内心独白"))
  assert.ok(ANALYSIS_MARKER.startsWith("\n\n【思维模式要求】"))
  assert.ok(ANALYSIS_MARKER.includes("禁止以角色第一人称描写内心活动"))
  assert.notEqual(IMMERSION_MARKER, ANALYSIS_MARKER)
})

test("auto injects nothing on this stack's model", () => {
  assert.equal(chooseMarker("auto", true, FORGE), null)
})

test("auto injects on a DeepSeek model, however it is served", () => {
  assert.equal(chooseMarker("auto", true, DEEPSEEK_PROVIDER), IMMERSION_MARKER)
  assert.equal(chooseMarker("auto", true, DEEPSEEK_VIA_FORGE), IMMERSION_MARKER)
})

test("looksLikeDeepSeek reads id and baseUrl, not just the provider", () => {
  assert.ok(looksLikeDeepSeek(DEEPSEEK_VIA_FORGE))
  assert.ok(looksLikeDeepSeek({ provider: "forge", baseUrl: "https://api.deepseek.com/v1" }))
  assert.ok(!looksLikeDeepSeek(FORGE))
  assert.ok(!looksLikeDeepSeek(undefined))
  assert.ok(!looksLikeDeepSeek(null))
  assert.ok(!looksLikeDeepSeek({}))
})

test("explicit modes fire on any model", () => {
  assert.equal(chooseMarker("immersion", true, FORGE), IMMERSION_MARKER)
  assert.equal(chooseMarker("analysis", true, FORGE), ANALYSIS_MARKER)
})

test("off and no-persona both suppress every mode", () => {
  for (const mode of IMMERSION_MODES) {
    assert.equal(chooseMarker(mode, false, DEEPSEEK_PROVIDER), null, `${mode} fired with no persona`)
  }
  assert.equal(chooseMarker("off", true, DEEPSEEK_PROVIDER), null)
})

test("isFirstUserTurn ignores assistant turns and tool traffic", () => {
  assert.ok(isFirstUserTurn([]))
  assert.ok(isFirstUserTurn([{ role: "assistant" }, { role: "tool" }]))
  assert.ok(!isFirstUserTurn([{ role: "assistant" }, { role: "user" }]))
})

// The extraction turn is delivered with sendUserMessage() and lands as a user
// message. Without the synthetic flag it consumes the first turn, and the marker
// then attaches to the user's SECOND message — later than the position the whole
// mechanism is documented against.
test("a synthetic user message does not consume the first turn", () => {
  assert.ok(isFirstUserTurn([{ role: "user", synthetic: true }]))
  assert.ok(!isFirstUserTurn([{ role: "user", synthetic: true }, { role: "user" }]))
})

test("the marker lands at the END of the first user message", () => {
  const out = maybeAppendMarker("do the thing", [], "immersion", true, FORGE)
  assert.ok(out.startsWith("do the thing"))
  assert.ok(out.endsWith(IMMERSION_MARKER))
})

test("nothing is appended past the first turn", () => {
  const out = maybeAppendMarker("second", [{ role: "user" }], "immersion", true, FORGE)
  assert.equal(out, "second")
})

// pi checks EXTENSION commands before the input event, but skill commands and
// prompt templates are expanded after it. A marker glued onto `/loop status`
// becomes part of that command's argument string.
test("slash commands are left alone", () => {
  for (const cmd of ["/loop status", "  /skill:foo", "/persona"]) {
    assert.equal(maybeAppendMarker(cmd, [], "immersion", true, FORGE), cmd)
  }
})

test("a non-string prompt passes through untouched", () => {
  const weird = { not: "a string" } as unknown as string
  assert.equal(maybeAppendMarker(weird, [], "immersion", true, FORGE), weird)
})

test("isImmersionMode rejects anything that is not a mode", () => {
  assert.ok(isImmersionMode("auto"))
  assert.ok(isImmersionMode("off"))
  assert.ok(!isImmersionMode("on"))
  assert.ok(!isImmersionMode(""))
})
