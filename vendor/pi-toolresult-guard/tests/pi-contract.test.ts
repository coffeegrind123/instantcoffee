// The pi internals this package is built on, pinned against the INSTALLED pi.
//
// This guard is not a defensive wrapper that works whatever pi does. It works
// because of four specific shapes in pi's bundle, and if any of them changes
// the package is either unnecessary or silently ineffective — both of which
// should be a failing test rather than a discovery made during an outage.
//
// Read off the installed bundle rather than a vendored copy, and skipped when
// pi is absent: a claim about the pi on this box is worth nothing anywhere else.
// The whitespace-insensitive match is deliberate — a re-minify with different
// variable names must not fail this, only a change to the LOGIC should.

import assert from "node:assert/strict"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { describe, test } from "node:test"

import { findPiIndex } from "./harness.ts"

const PI_INDEX = findPiIndex()

/**
 * The bundle chunk holding the tool-result path, found BY CONTENT.
 *
 * Not by name: the chunk is `chunk-OMWWHBTG.js` on 0.84.4 and that hash changes
 * with every build. Not by a fixed path either — the `pi` binary resolves to
 * `dist/bundle/cli.js` on this stack's image and to `dist/cli.js` elsewhere, so
 * `chunks/` sits one directory up or down depending on the install. Both
 * candidates are tried, plus the bundle roots themselves for a build that is
 * not split into chunks at all.
 *
 * This search was wrong on its first outing — it looked only under
 * `<dir>/bundle/chunks`, found nothing on the real container, and the whole
 * describe below skipped SILENTLY while reporting a green suite. A contract
 * test that cannot find the thing it pins is worse than no contract test, so
 * `SKIP` distinguishes "pi is absent" from "pi is here and the search failed".
 */
function findChunk(): string | null {
  if (!PI_INDEX) return null
  const dir = dirname(PI_INDEX)
  const roots = [join(dir, "chunks"), join(dir, "bundle", "chunks"), dir]
  for (const root of roots) {
    if (!existsSync(root)) continue
    for (const name of readdirSync(root)) {
      if (!name.endsWith(".js")) continue
      let src: string
      try {
        src = readFileSync(join(root, name), "utf8")
      } catch {
        continue
      }
      if (src.includes("function getTextOutput(")) return src
    }
  }
  return null
}

const SRC = findChunk()
const SKIP = PI_INDEX
  ? SRC
    ? false
    : "pi is installed but getTextOutput was not found in its bundle"
  : "pi is not installed on PATH"

/** Collapse whitespace so a re-minify does not read as a logic change. */
function has(needle: string): boolean {
  const flat = (s: string) => s.replace(/\s+/g, "")
  return flat(SRC ?? "").includes(flat(needle))
}

describe("the pi contract this guard depends on", { skip: SKIP }, () => {
  // 1. THE BUG. If this ever gains a guard, this package is obsolete — delete
  //    it rather than carrying a workaround for something that was fixed.
  test("getTextOutput still reads result.content behind only a !result guard", () => {
    assert.ok(
      has('function getTextOutput(result,showImages){if(!result)return"";let textBlocks=result.content.filter('),
      "getTextOutput changed. If it now guards `content`, DELETE this package — " +
        "it exists only because that read is unguarded.",
    )
  })

  // 2. THE LEVER. One handler returning a field is what makes hookResult
  //    truthy. Without this, returning `{content}` changes nothing.
  test("emitToolResult still returns a value only when a handler modified one", () => {
    assert.ok(
      has("if(modified)return{content:currentEvent.content,details:currentEvent.details,isError:currentEvent.isError,usage:currentEvent.usage}"),
      "ExtensionRunner.emitToolResult changed. The guard works by setting `modified`; " +
        "re-read extensions/index.ts's header against the new code.",
    )
  })

  // 3. WHY PI DOES NOT ALREADY FIX IT. pi computes `result.content ?? []` and
  //    then discards it when no handler modified anything, because
  //    normalizeToolResultImages returned the same array by reference.
  test("afterToolCall still discards its own repair when nothing modified the result", () => {
    assert.ok(
      has("content=hookResult?.content??result.content??[]"),
      "afterToolCall no longer computes the repair this guard exists to release.",
    )
    assert.ok(
      has("if(!(!hookResult&&normalizedContent===content))"),
      "the discard branch changed — pi may now return the repair on its own, " +
        "in which case this package is obsolete.",
    )
  })

  // 4. THE REFERENCE IDENTITY that makes branch 3 fire. If this ever returns a
  //    copy, `normalizedContent !== content` and pi repairs contentless results
  //    without any help.
  test("normalizeToolResultImages still returns its argument by reference", () => {
    assert.ok(
      has('async function normalizeToolResultImages(content,options){if(!content.some(block=>block.type==="image"))return content;'),
      "normalizeToolResultImages changed. If it now returns a copy, pi repairs " +
        "contentless results on its own and this package is obsolete.",
    )
  })

  // 5. THE MERGE. An empty array is not nullish, so a repaired array wins.
  test("finalizeExecutedToolCall still lets the hook's content win", () => {
    assert.ok(
      has("result={...result,content:afterResult.content??result.content"),
      "the merge changed — a repaired content may no longer reach the renderer.",
    )
  })

  // 6. THE HOLE, stated as a test so it is not forgotten. A streaming tool's
  //    partial never passes through afterToolCall, so nothing here can reach it.
  test("tool_execution_update still bypasses the hook (the one case not covered)", () => {
    assert.ok(
      has('emit({type:"tool_execution_update",toolCallId:prepared.toolCall.id,toolName:prepared.toolCall.name,args:prepared.toolCall.arguments,partialResult})'),
      "the partial-result path changed; re-check whether it now passes through afterToolCall.",
    )
  })
})

describe("source guarantees", () => {
  const source = readFileSync(
    join(dirname(dirname(new URL(import.meta.url).pathname)), "extensions", "index.ts"),
    "utf8",
  )

  test("nothing here registers a tool or a command", () => {
    assert.ok(!source.includes("pi.registerTool("), "a tool would cost its schema every request")
    assert.ok(!source.includes("pi.registerCommand("))
  })

  test("the handler fails open", () => {
    assert.ok(source.includes("catch (err)"), "a guard that throws leaves the result unrepaired anyway")
    assert.ok(source.includes("return undefined"), "no repair must mean no modification")
  })

  test("only content is returned, never details or isError", () => {
    assert.ok(source.includes("return { content: repair.content as never }"))
    assert.ok(!/return \{[^}]*isError/.test(source))
  })
})
