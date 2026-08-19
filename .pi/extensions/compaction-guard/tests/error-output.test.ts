/**
 * AF6 — the output the cap was exempting is the output it was built for.
 *
 * The `tool_result` handler began with:
 *
 *     // An error is short and is the one thing worth reading in full.
 *     if ((event as { isError?: boolean }).isError) return undefined;
 *
 * That is a claim about pi's bash tool, and pi's bash tool says otherwise
 * (`dist/core/tools/bash.js:346-349`):
 *
 *     const { text: outputText, details } = formatOutput(snapshot);
 *     if (exitCode !== 0 && exitCode !== null) {
 *         throw new Error(appendStatus(outputText, `Command exited with code ${exitCode}`));
 *     }
 *
 * The throw carries the WHOLE captured output — bash's own bound is 2,000 lines
 * or 50 KB — and `executePreparedToolCall` turns it into
 * `createErrorToolResult(error.message)`: one text block, `isError: true`. So on
 * this stack `isError` means "the command failed", not "the message is short",
 * and up to ~12,500 tokens of a 32,768-token window arrived exempt from the one
 * mechanism that bounds a tool result.
 *
 * It is the ordinary case, not an edge one. The runs this extension exists for
 * are unattended `/loop`s fixing a failing test suite; every run of that suite
 * while it is still failing is an error result.
 *
 * The suite drives the SHIPPED handler, so this is about the extension rather
 * than about a restatement of it.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import guard from "../index.ts";
import { MAX_ALLOWANCE_CHARS } from "../src/output-cap.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;

/** A failing test suite's output, as pi's bash tool hands it over. */
const FAILING_SUITE =
  `${"FAIL tests/thing.test.ts — expected 3, got 4\n".repeat(1_200)}` +
  "\nCommand exited with code 1";

function makeHost(percent = 20) {
  const handlers = new Map<string, Handler[]>();
  const notices: string[] = [];
  const pi = {
    on(name: string, fn: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), fn]);
    },
  };
  const window = 32_768;
  const ctx = {
    ui: {
      notify(message: string) {
        notices.push(message);
      },
    },
    model: { contextWindow: window },
    getContextUsage: () => ({ tokens: Math.round((window * percent) / 100), contextWindow: window, percent }),
  };
  guard(pi as never);

  return {
    notices,
    async toolResult(opts: { text: string; isError: boolean; callId?: string }) {
      const event = {
        toolName: "bash",
        toolCallId: opts.callId ?? "call-1",
        isError: opts.isError,
        content: [{ type: "text", text: opts.text }],
      };
      let result: unknown;
      for (const fn of handlers.get("tool_result") ?? []) result = await fn(event, ctx);
      return result as { content?: { type: string; text: string }[] } | undefined;
    },
  };
}

describe("AF6 — a failing command's output is capped like any other", () => {
  it("caps an isError result", async () => {
    const host = makeHost(84.5);
    const capped = await host.toolResult({ text: FAILING_SUITE, isError: true });
    const text = capped?.content?.[0]?.text;

    assert.ok(text, "an error result this size must not pass through untouched");
    assert.ok(
      text.length < FAILING_SUITE.length,
      `expected the cap to shrink ${FAILING_SUITE.length} chars, kept ${text.length}`,
    );
    assert.match(text, /\[output capped at 85% context: \d+ chars/);
  });

  it("keeps the end, which is where an error says what went wrong", async () => {
    const host = makeHost(84.5);
    const text = (await host.toolResult({ text: FAILING_SUITE, isError: true }))?.content?.[0]?.text ?? "";

    assert.match(text, /Command exited with code 1$/, "the status line is the last thing bash appends");
    assert.match(text, /^FAIL tests\/thing\.test\.ts/, "and the head is still the start of the run");
    assert.match(text, /Full output: \S+pi-tool-output-\S+\.txt/, "the rest is recoverable, not lost");
  });

  it("the operator is told, in the same sentence as any other cap", async () => {
    const host = makeHost(84.5);
    await host.toolResult({ text: FAILING_SUITE, isError: true });
    assert.ok(
      host.notices.some((line) => /capped bash output \d+ -> \d+ chars/.test(line)),
      "a cap the operator cannot see is a cap nobody can account for",
    );
  });

  it("control — a short error is still handed over in full", async () => {
    const host = makeHost(84.5);
    const short = "ENOENT: no such file or directory, open 'nope.txt'\nCommand exited with code 1";
    const capped = await host.toolResult({ text: short, isError: true, callId: "call-short" });
    assert.equal(capped, undefined, "under the allowance nothing is rewritten, error or not");
  });

  it("control — the same output as a SUCCESS is capped exactly the same way", async () => {
    const failed = makeHost(84.5);
    const passed = makeHost(84.5);
    const a = (await failed.toolResult({ text: FAILING_SUITE, isError: true, callId: "x" }))?.content?.[0]?.text ?? "";
    const b = (await passed.toolResult({ text: FAILING_SUITE, isError: false, callId: "x" }))?.content?.[0]?.text ?? "";

    // The spill path differs (a fresh mkdtemp per host), so compare the shape
    // rather than the bytes: same length class, same head, same tail.
    assert.equal(a.slice(0, 200), b.slice(0, 200));
    assert.equal(a.slice(-200), b.slice(-200));
  });

  it("bounds it against the REMAINING window, not a fixed number", async () => {
    // The whole design of the cap: at 20% used there is room, at 84.5% there is
    // not, and the same output is treated differently.
    const roomy = makeHost(20);
    const tight = makeHost(84.5);
    const big = "y".repeat(120_000);
    const a = (await roomy.toolResult({ text: big, isError: true, callId: "r" }))?.content?.[0]?.text ?? "";
    const b = (await tight.toolResult({ text: big, isError: true, callId: "t" }))?.content?.[0]?.text ?? "";

    assert.ok(a.length > b.length, "an emptier context keeps more of the same error");
    assert.ok(a.length <= MAX_ALLOWANCE_CHARS + 500, "and the ceiling still applies");
  });
});
