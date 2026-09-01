// The guard, driven through its real handler, against pi's own merge.
//
// pi is STUBBED here (see harness.ts) so this suite runs on every box. The bug
// this package exists for is a session that exits; a suite that skips itself
// when pi is absent is no use against it.
//
// The assertions are about `piWouldRender`, not about the handler's return
// value. What the handler returns is not the claim worth pinning — the claim is
// that pi, given that return value, stops crashing, and that runs through three
// functions this package does not own. Every case therefore includes the
// control: the SAME result with no guard loaded, which must crash.

import assert from "node:assert/strict"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"

import { FakeApi, FakeCtx, hookStubPi, piWouldRender } from "./harness.ts"

const EXTENSION = join(dirname(dirname(fileURLToPath(import.meta.url))), "extensions", "index.ts")

async function load(): Promise<FakeApi> {
  hookStubPi()
  const mod = (await import(`${EXTENSION}?t=${Math.random()}`)) as {
    default: (pi: unknown) => void | Promise<void>
  }
  const api = new FakeApi()
  await mod.default(api)
  return api
}

/** A session with no guard loaded — the control for every case below. */
function unguarded(): FakeApi {
  return new FakeApi()
}

test("it subscribes to tool_result and nothing else", async () => {
  const api = await load()
  assert.deepEqual([...api.handlers.keys()], ["tool_result"])
  // A registered tool costs its schema on EVERY request whether or not it is
  // ever called. This package must not be a standing charge.
  assert.deepEqual(api.tools, [])
  assert.deepEqual(api.commands, [])
})

// The control. Without the guard this is the uncaughtException that ends the
// session; if this ever stops crashing, pi fixed it and this package can go.
test("CONTROL: a result with no content crashes pi's renderer", async () => {
  const before = await piWouldRender(unguarded(), new FakeCtx(), "prinny", { details: {} })
  assert.equal(before.crashed, true, "the bug this package exists for is gone — re-check pi")
})

test("a result with no content renders instead of ending the session", async () => {
  const api = await load()
  const ctx = new FakeCtx()
  const after = await piWouldRender(api, ctx, "prinny", { details: { tool: "prinny" } })
  assert.equal(after.crashed, false)
  assert.ok(after.text.includes("prinny returned a result this harness cannot read"))
  assert.ok(after.text.includes("The call itself completed"))
})

// The exact call that ended the session on 2026-09-01: prinny(action:react)
// with no message_id, whose early return was a bare string.
test("the prinny react crash of 2026-09-01 no longer ends the session", async () => {
  const api = await load()
  // The tool did `return "prinny(react) needs a message_id …"`. `afterToolCall`
  // is handed that RETURN VALUE and reads `.content` off it, so what arrives is
  // a string with no `.content` — the message is already unrecoverable, and the
  // most the guard can do is keep the session alive and say so.
  const returned = "prinny(react) needs a message_id and none is known for this turn."
  assert.equal((await piWouldRender(unguarded(), new FakeCtx(), "prinny", returned)).crashed, true)
  const after = await piWouldRender(api, new FakeCtx(), "prinny", returned)
  assert.equal(after.crashed, false)
  assert.ok(after.text.includes("output was lost"))
  assert.ok(!after.text.includes("message_id"), "the payload really is gone by this point")
})

// The property that makes this free: a healthy result must come out the far
// side as the SAME array, by reference. Anything else means the guard is
// rewriting every tool result in the session.
test("a healthy result passes through untouched, by reference", async () => {
  const api = await load()
  const content = [{ type: "text", text: "hello" }]
  const after = await piWouldRender(api, new FakeCtx(), "bash", { content })
  assert.equal(after.crashed, false)
  assert.equal(after.content, content, "the guard must not clone a result it has no business touching")
  assert.equal(after.text, "hello")
})

test("an empty array is left alone rather than replaced with a placeholder", async () => {
  const api = await load()
  const content: unknown[] = []
  const after = await piWouldRender(api, new FakeCtx(), "bash", { content })
  assert.equal(after.content, content)
  assert.equal(after.text, "")
})

test("a string content is recovered rather than replaced", async () => {
  const api = await load()
  assert.equal((await piWouldRender(unguarded(), new FakeCtx(), "x", { content: "the message" })).crashed, true)
  const after = await piWouldRender(api, new FakeCtx(), "x", { content: "the message" })
  assert.equal(after.crashed, false)
  assert.equal(after.text, "the message")
})

test("one bad element does not take the whole result with it", async () => {
  const api = await load()
  const content = [{ type: "text", text: "kept" }, null]
  assert.equal((await piWouldRender(unguarded(), new FakeCtx(), "x", { content })).crashed, true)
  const after = await piWouldRender(api, new FakeCtx(), "x", { content })
  assert.equal(after.crashed, false)
  assert.equal(after.text, "kept")
})

// Silence would be the wrong kind of success: the session survives and the
// operator never learns a tool is broken, so it never gets fixed and the guard
// becomes load-bearing.
test("the operator is told once per tool, not once per call", async () => {
  const api = await load()
  const ctx = new FakeCtx()
  for (let i = 0; i < 3; i++) await piWouldRender(api, ctx, "prinny", {})
  await piWouldRender(api, ctx, "other", {})
  assert.equal(ctx.notifications.length, 2)
  assert.ok(ctx.notifications[0]!.text.startsWith("prinny returned a tool result pi cannot render"))
  assert.ok(ctx.notifications[0]!.text.includes("the session would have exited here"))
  assert.equal(ctx.notifications[0]!.type, "error", "an unrecoverable payload is an error")
  assert.ok(ctx.notifications[1]!.text.startsWith("other returned"))
})

test("a recovered payload is reported as a warning, not an error", async () => {
  const api = await load()
  const ctx = new FakeCtx()
  await piWouldRender(api, ctx, "x", { content: "recoverable" })
  assert.equal(ctx.notifications[0]!.type, "warning")
})

test("with no UI the guard still repairs and says so on the log, not a dialog", async () => {
  const api = await load()
  const ctx = new FakeCtx({ hasUI: false })
  const after = await piWouldRender(api, ctx, "prinny", {})
  assert.equal(after.crashed, false)
  assert.deepEqual(ctx.notifications, [])
})

// A guard that throws is worse than no guard: emitToolResult catches it, the
// result is left alone, and it reaches the renderer exactly as it would have.
test("a ctx that throws does not stop the repair", async () => {
  const api = await load()
  const hostile = {
    hasUI: true,
    ui: {
      notify() {
        throw new Error("no ui for you")
      },
    },
  }
  const after = await piWouldRender(api, hostile as unknown as FakeCtx, "prinny", {})
  assert.equal(after.crashed, false)
})

test("a tool with no name still gets a truthful placeholder", async () => {
  const api = await load()
  const [out] = await api.fire("tool_result", { content: undefined }, new FakeCtx())
  const blocks = (out as { content: Array<{ text: string }> }).content
  assert.ok(blocks[0]!.text.startsWith("a tool returned"))
})
