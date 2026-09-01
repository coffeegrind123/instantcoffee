// What pi will and will not survive being handed as a tool result.
//
// pi renders a tool result with `getTextOutput`, and the whole of its input
// validation is one line:
//
//     function getTextOutput(result, showImages) {
//       if (!result) return "";
//       let textBlocks = result.content.filter(c => c.type === "text"),
//     ...
//
// (0.84.4, `dist/bundle/chunks/chunk-OMWWHBTG.js:1133`.) The guard covers a
// MISSING result, not a result without content — and every wrong shape a tool
// can return is truthy, so a bare string walks straight past it into
// `"...".content.filter(...)`. That arrives as an `uncaughtException` from a
// render callback and takes the whole session down mid-turn.
//
// The same read appears twice more in `ToolExecutionComponent`, unguarded both
// times: `updateDisplay`'s image sweep and `maybeConvertImagesForKitty`. And
// `getTextOutput`'s own `.filter(c => c.type === "text")` dereferences every
// element, so an array containing `null` is as fatal as no array at all.
//
// THIS IS NOT GOING TO BE FIXED UPSTREAM. It has been reported at least seven
// times (earendil-works/pi #5266, #5588, #5599, #6678, #6788, #7695, #7764) and
// closed `no-action` every time, with the maintainer's position: "this is a
// typescript code base, which does not do any defense checks like you propose,
// because they show up as compile time errors if you use the type system."
// That is true of pi's own tools and untrue of everything else on the surface —
// an MCP adapter's tools, an extension's tools, anything whose return value
// crosses a boundary the compiler cannot see.
//
// It has now cost this stack two sessions, both to `vendor/prinny-channel`
// (2026-08-30 `action:status` hitting its throttle, 2026-09-01 `action:react`
// with no `message_id`), each time from a plain `return "some message"`.
//
// So this module decides, for an arbitrary value, whether pi can render it and
// what to hand over instead when it cannot. It imports nothing — from pi or
// anywhere — so the whole decision is testable under bare node.

/** A content block, as far as pi's renderer cares: an object with a `type`. */
export interface ContentBlock {
  type: string
  [key: string]: unknown
}

export interface Repair {
  /** What to send in place of the original. Always a real array. */
  content: ContentBlock[]
  /** One line for the log and the operator notice. Names the shape, not a guess. */
  reason: string
  /**
   * True when the original text was recoverable — a tool that returned a bare
   * string still said something, and the string is the thing it meant to say.
   * False when the payload is gone and only a placeholder can be substituted.
   */
  recovered: boolean
}

/**
 * The stand-in for a result whose payload cannot be recovered.
 *
 * It has to be honest about three separate things, because the model will act
 * on it: the call HAPPENED, its output is GONE, and retrying is not obviously
 * the right move. A bare empty array says none of that — it reads as "the tool
 * ran and produced nothing", which is a different and usually wrong claim, and
 * some providers reject a tool result with no content outright.
 */
export function placeholderText(toolName: string): string {
  const name = toolName?.trim() || "a tool"
  return (
    `${name} returned a result this harness cannot read, so its output was lost between the tool and you. ` +
    `The call itself completed — treat this as "done, output unknown" rather than as an error to retry blindly. ` +
    `If you need what it said, say so plainly; the tool has a bug worth reporting.`
  )
}

/** Whether pi's renderer can dereference this element without throwing. */
function isRenderable(block: unknown): block is ContentBlock {
  if (typeof block !== "object" || block === null) return false
  const type = (block as { type?: unknown }).type
  if (typeof type !== "string") return false
  // An image block is read as `Buffer.from(block.data, "base64")` by
  // `normalizeToolResultImages` BEFORE any guard, so a non-string `data` throws
  // there instead. That one is caught (`finalizeExecutedToolCall` wraps
  // `afterToolCall`) and degrades to an error result rather than a crash — but
  // an error result is still the wrong answer for a call that worked, so a
  // malformed image block is dropped here with everything else.
  if (type === "image") {
    const { data, mimeType } = block as { data?: unknown; mimeType?: unknown }
    return typeof data === "string" && typeof mimeType === "string"
  }
  return true
}

function describe(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return `an array of ${value.length}`
  return typeof value
}

/**
 * Decide what to do about one tool result's content.
 *
 * Returns `null` when pi can render it as-is — which is the answer on every
 * healthy call, and the reason this costs nothing. A `null` here means the
 * handler returns nothing, `emitToolResult` reports no modification, and pi
 * takes exactly the identity path it took before this package existed.
 *
 * An EMPTY array is renderable and is left alone. `getTextOutput` returns "",
 * `createResultFallback` returns undefined, and the row draws with no output —
 * which is correct for a tool that genuinely produced none.
 */
export function normalizeContent(content: unknown, toolName: string): Repair | null {
  if (typeof content === "string") {
    // The one shape whose payload survives. A tool that did `return "message"`
    // never reaches here — `afterToolCall` is handed the RETURN VALUE and reads
    // `.content` off it, so the string is already lost by then — but a tool or
    // an earlier handler that set `content` to a string does, and that string
    // is the thing it meant to say.
    const text = content
    return {
      content: [{ type: "text", text }],
      reason: `${toolName}: content was a string, not an array of blocks; wrapped as one text block`,
      recovered: true,
    }
  }

  if (Array.isArray(content)) {
    const kept = content.filter(isRenderable)
    if (kept.length === content.length) return null
    const dropped = content.length - kept.length
    if (kept.length > 0) {
      return {
        content: kept,
        reason: `${toolName}: dropped ${dropped} unrenderable content block${dropped === 1 ? "" : "s"}`,
        recovered: true,
      }
    }
    return {
      content: [{ type: "text", text: placeholderText(toolName) }],
      reason: `${toolName}: all ${content.length} content blocks were unrenderable`,
      recovered: false,
    }
  }

  return {
    content: [{ type: "text", text: placeholderText(toolName) }],
    reason: `${toolName}: content was ${describe(content)}, not an array of blocks`,
    recovered: false,
  }
}
