# pi-toolresult-guard

A malformed tool result must not kill the session.

## The bug

pi renders a tool result with `getTextOutput`, and the whole of its input
validation is one line:

```js
function getTextOutput(result, showImages) {
  if (!result) return "";
  let textBlocks = result.content.filter(c => c.type === "text"),
  ...
```

That guard covers a **missing** result, not a result **without content** — and
every wrong shape a tool can return is truthy, so a plain `return "message"`
walks straight past it into `"...".content.filter(...)`:

```
TypeError: Cannot read properties of undefined (reading 'filter')
    at getTextOutput
    at ToolExecutionComponent.createResultFallback
    at ToolExecutionComponent.updateDisplay
    at ToolExecutionComponent.updateResult
    at _InteractiveMode.handleEvent
```

It arrives from a render callback as an `uncaughtException` and takes the whole
session down mid-turn. The same read appears twice more in
`ToolExecutionComponent`, unguarded both times, and `getTextOutput`'s own
`.filter(c => c.type === "text")` dereferences every element — so one `null`
inside an otherwise fine array is as fatal as no array at all.

**The stored transcript hides it.** pi's session writer normalises while the UI
event does not, so the saved record reads `content: []` and does not contain
the string that caused the crash. Read the stack trace, not the session file.

**It is not going to be fixed upstream.** Reported at least seven times
(earendil-works/pi #5266, #5588, #5599, #6678, #6788, #7695, #7764), closed
`no-action` every time, with the maintainer's position: *"this is a typescript
code base, which does not do any defense checks like you propose, because they
show up as compile time errors if you use the type system."* That is true of
pi's own tools and untrue of everything else on the surface — an MCP adapter's
tools, an extension's tools, anything whose return value crosses a boundary the
compiler cannot see.

## Why a `tool_result` handler is the fix

This is not a wrapper hoping to land near the problem. It is the one place a
tool result can still be corrected, and it works by flipping a branch pi
already has. From the 0.84.4 bundle:

```js
// AgentSession, wiring the agent's afterToolCall to the extension runner
const hookResult = runner.hasHandlers("tool_result")
  ? await runner.emitToolResult({ …, content: result.content, … })
  : undefined
const content = hookResult?.content ?? result.content ?? []
const normalizedContent = await normalizeToolResultImages(content, …)
if (!(!hookResult && normalizedContent === content))
  return { content: normalizedContent, … }
```

**pi already computes the repair** — `result.content ?? []`. It just does not
return it. With no `tool_result` handler registered anywhere, `hookResult` is
undefined; `normalizeToolResultImages` returns its argument *by reference* when
no block is an image, so `normalizedContent === content` holds, the condition is
false, and the repair is thrown away.

`ExtensionRunner.emitToolResult` returns a value **only** when some handler
returned a non-undefined field (`if (modified) return {…}`). So one handler that
returns `{ content }` makes `hookResult` truthy, makes the condition true, and
makes pi hand over the content it had already worked out.
`finalizeExecutedToolCall` then merges it: `content: afterResult.content ??
result.content` — an empty array is not nullish, so the repaired array wins.

The consequence worth stating plainly: **returning nothing from this handler is
not the same as not having the handler.** With nothing to repair the handler
returns `undefined`, `modified` stays false, and pi takes byte-for-byte the path
it took before this package existed.

`tests/pi-contract.test.ts` pins all five of those shapes against the installed
pi, so an upgrade that changes any of them fails a test with a message saying
what to re-check — including "if pi now guards `content`, delete this package".

## What it does

| the result's `content` | what happens |
| --- | --- |
| a well-formed array | **nothing** — passed through by reference |
| `[]` | nothing — an empty result is legal and renders as no output |
| missing, `null`, a number, an object | one text block saying the call completed and its output was lost |
| a **string** | wrapped as one text block — the payload survives |
| an array with bad elements | the bad ones are dropped, the rest survives |
| an array with nothing renderable | the placeholder |

The placeholder is not an empty array on purpose. `[]` renders, but it claims
the tool ran and produced nothing — a different and usually wrong claim — and
some providers reject a tool result with no content outright. What the model
gets instead says the call happened, its output is gone, and retrying blindly is
not the move.

**The operator is told once per tool per session.** Silence would be the wrong
kind of success: the session survives, nobody learns a tool is broken, it never
gets fixed, and the guard quietly becomes load-bearing.

## Cost

Zero tokens. No tool is registered (a tool costs its schema on every request
whether or not it is ever called), no command, no system-prompt text. One
function call per tool result. The only thing that ever reaches the model is the
replacement block on a result that would otherwise have ended the session.

## What it does not cover

`tool_execution_update`. A streaming tool's `onUpdate(partialResult)` is emitted
straight to the UI and never passes through `afterToolCall`, so a partial
without `content` still crashes and nothing here can reach it. No tool in this
stack streams updates; a test pins that path so the gap stays visible.

## Install

```bash
pi install git:github.com/coffeegrind123/pi-toolresult-guard
```

Load it **first**, before any other extension. `emitToolResult` runs handlers in
extension order and each sees the previous one's edits, so going first means
every other `tool_result` handler in the session reads a content array that has
already been made safe.

Nothing to install alongside it. It imports nothing from pi at runtime — its
only imports from the package are `import type`, which are erased before the
file runs. Node 22.6+.

## Tests

```bash
npm run lint && npm test
```

Every repair case includes its **control**: the same result with no guard
loaded, asserted to crash. A test that only shows the fixed path proves nothing
about the bug. `tests/harness.ts` transcribes pi's own merge —
`emitToolResult` → `afterToolCall` → `finalizeExecutedToolCall` →
`getTextOutput` — so the assertions are about what pi does with the handler's
return value rather than about the return value itself.

pi is stubbed rather than required, so the suite runs on every box: the symptom
here is a session that exits, and a suite that skips itself when pi is absent is
no use against it. `tests/pi-contract.test.ts` is the half that does need the
real pi, and it skips with a reason when there is none.
