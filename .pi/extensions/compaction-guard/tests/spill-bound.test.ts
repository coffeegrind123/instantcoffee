/**
 * The spill directory is bounded.
 *
 * Every file the output cap writes is, by construction, a tool result that did
 * not fit the context — at least `MIN_ALLOWANCE_CHARS` and often tens of
 * kilobytes. Until the eleventh pass nothing ever removed one, and the whole
 * point of this extension is unattended runs: a `/loop` going for days, capping
 * a test runner's output every iteration, writing each one to a `mkdtemp` under
 * `tmpdir()` and forgetting it. On this box that is the container's writable
 * layer, the same disk as everything else.
 *
 * The bound is a COUNT, not a teardown, and the reason is `spillDir` being
 * module-global: a child inherits this extension by discovery
 * (`.pi/extensions/**` is on the child's discovery route) and therefore shares
 * the directory with its parent, so a `session_shutdown` sweep on either side
 * would delete files the other's markers still name. Pruning the oldest has no
 * such coupling — a marker that old left the context several compactions ago.
 *
 * This suite drives the shipped handler, so the assertion is about the directory
 * that really appears on disk rather than about a restatement of the rule.
 *
 * See the note in `context/design/subagents-loop-verifier-signals.md` §9.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

import guard from "../index.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

/** Big enough that the cap always fires: the ceiling is 20,000 chars. */
const HUGE = "x".repeat(40_000);

function makeHost() {
  const handlers = new Map<string, Handler[]>();
  const pi = {
    on(name: string, fn: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), fn]);
    },
  };
  const ctx = {
    ui: { notify() {} },
    model: { contextWindow: 32_768 },
    getContextUsage: () => ({ tokens: 6_554, contextWindow: 32_768, percent: 20 }),
  };
  guard(pi as never);

  return async function toolResult(callId: string, text = HUGE) {
    const event = {
      toolName: "bash",
      toolCallId: callId,
      isError: false,
      content: [{ type: "text", text }],
    };
    let result: unknown;
    for (const fn of handlers.get("tool_result") ?? []) result = await fn(event, ctx);
    return result as { content?: { type: string; text: string }[] } | undefined;
  };
}

/** The directory the marker names, pulled out of the capped text the model sees. */
function spillDirFromMarker(text: string): string | undefined {
  const match = text.match(/(\/[^\s)]*pi-tool-output-[^\s)]*)\//);
  return match ? `${match[1]}` : undefined;
}

describe("the spill directory", () => {
  it("keeps the newest spills and prunes the rest", async () => {
    const toolResult = makeHost();

    // One more than the bound, so exactly one prune has to have happened, and
    // the file written last must be among the survivors.
    let dir: string | undefined;
    for (let i = 0; i < 60; i++) {
      const capped = await toolResult(`call-${String(i).padStart(3, "0")}`);
      const text = capped?.content?.[0]?.text ?? "";
      dir ??= spillDirFromMarker(text);
    }

    assert.ok(dir, "the marker must still name a real directory");
    const files = readdirSync(dir);
    assert.ok(files.length <= 50, `expected at most 50 spills, found ${files.length}`);
    assert.ok(
      files.some((name) => name.includes("call-059")),
      "the newest spill is the one the model was just told to read — it must never be the pruned one"
    );
    assert.ok(
      !files.some((name) => name.includes("call-000")),
      "and the oldest must actually go, or the bound is decoration"
    );
  });

  it("control — the spill it just wrote is still readable in full", async () => {
    const toolResult = makeHost();
    const capped = await toolResult("recoverable", `${HUGE}TAIL`);
    const text = capped?.content?.[0]?.text ?? "";

    const path = text.match(/(\/[^\s)]*pi-tool-output-[^\s)]*\.txt)/)?.[1];
    assert.ok(path, "a cap that does not say where the rest went is a cap that loses it");
    assert.equal(readFileSync(path, "utf8").length, HUGE.length + 4);
  });
});
