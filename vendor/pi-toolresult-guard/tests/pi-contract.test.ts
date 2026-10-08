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
import { basename, dirname, join } from "node:path"
import { describe, test } from "node:test"

import { findPiIndex } from "./harness.ts"

const PI_INDEX = findPiIndex()

/**
 * EVERY js file under pi's dist, concatenated — found BY CONTENT, not by name.
 *
 * Not by name: the chunk is `chunk-OMWWHBTG.js` on 0.84.4 and that hash changes
 * with every build. Not by a fixed path either — the `pi` binary resolves to
 * `dist/bundle/cli.js` on this stack's image and to `dist/cli.js` elsewhere, so
 * `chunks/` sits one directory up or down depending on the install.
 *
 * ALL of them, not the first one that matches. That distinction is the whole
 * reason this function has a history:
 *
 *   - First outing: it looked only under `<dir>/bundle/chunks`, found nothing on
 *     the real container, and the describe below skipped SILENTLY while
 *     reporting a green suite. Hence `SKIP` distinguishing "pi is absent" from
 *     "pi is here and the search failed".
 *   - Second outing: it returned the first file containing
 *     `function getTextOutput(`, which was right while pi shipped one bundle
 *     chunk. pi 1.1.0 SPLIT the path — `getTextOutput` into
 *     `core/tools/render-utils.js`, `normalizeToolResultImages` into
 *     `utils/tool-result-images.js` and `core/agent-session.js` — so five of the
 *     six shapes below were searched for in a file that never held them, and the
 *     suite went red on CI with "this package is obsolete" against logic that
 *     had not changed at all. A layout change must not read as a logic change;
 *     that is exactly what the whitespace-insensitive match above is for.
 *
 * So the haystack is the union. The cost is that a shape could in principle be
 * satisfied by an unrelated file; the alternative is a canary that cries wolf.
 */
function findBundleSource(): string | null {
  if (!PI_INDEX) return null
  const dir = dirname(PI_INDEX)
  const roots = [join(dir, "chunks"), join(dir, "bundle", "chunks"), dir]
  // `dist/bundle/cli.js` is the image's layout, and it would otherwise hide the
  // unbundled `dist/core` and `dist/utils` trees — which is exactly where 1.1.0
  // moved two of the six shapes. The chunks carry the same code, so this is
  // belt and braces, but the alternative is another search that cannot see.
  if (basename(dir) === "bundle") roots.push(dirname(dir))

  const parts: string[] = []
  const seen = new Set<string>()
  const walk = (entry: string): void => {
    let entries: string[]
    try {
      entries = readdirSync(entry)
    } catch {
      return
    }
    for (const name of entries) {
      if (name === "node_modules") continue
      const full = join(entry, name)
      if (seen.has(full)) continue
      seen.add(full)
      if (name.endsWith(".js")) {
        try {
          parts.push(readFileSync(full, "utf8"))
        } catch {
          // An unreadable file is not a contract change.
        }
      } else if (!name.includes(".")) {
        walk(full)
      }
    }
  }

  for (const root of roots) {
    if (existsSync(root)) walk(root)
  }

  const all = parts.join("\n")
  return all.includes("function getTextOutput(") ? all : null
}

const SRC = findBundleSource()
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

/**
 * The same match, but blind to what the minifier called a local variable.
 *
 * `has()` compares flattened text, which stops whitespace and line-wrapping from
 * reading as a change — but not a renamed identifier. pi 1.1.0 renamed
 * `prepared.toolCall` to `toolCall` in the `tool_execution_update` emit, and the
 * literal needle below went red against a byte-identical emit. That is the
 * failure this file's header explicitly swears off ("a re-minify with different
 * variable names must not fail this, only a change to the LOGIC should"), so
 * the assertions that pin a *receiver expression* use this instead.
 *
 * Deliberately still narrow: field names, their order, and the shape of the
 * surrounding expression all stay pinned, so dropping a field, reordering them,
 * or removing the emit still fails.
 */
function hasRe(pattern: RegExp): boolean {
  return pattern.test((SRC ?? "").replace(/\s+/g, ""))
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
    // Tolerant of identifier names and of ADDED fields: 1.1.0 inserted
    // `structuredContent` between `details` and `isError`. That is additive and,
    // if anything, an improvement — the hook's structuredContent now
    // round-trips through the merge in shape 5 instead of being dropped.
    assert.ok(
      hasRe(
        /if\(modified\)return\{content:[A-Za-z_$][\w$]*\.content,details:[A-Za-z_$][\w$]*\.details,[^}]*isError:[A-Za-z_$][\w$]*\.isError,usage:[A-Za-z_$][\w$]*\.usage\}/,
      ),
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
      hasRe(
        /emit\(\{type:"tool_execution_update",toolCallId:[A-Za-z_$][\w$.]*\.id,toolName:[A-Za-z_$][\w$.]*\.name,args:[A-Za-z_$][\w$.]*\.arguments,partialResult/,
      ),
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
