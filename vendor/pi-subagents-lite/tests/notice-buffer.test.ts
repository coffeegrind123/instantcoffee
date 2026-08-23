/**
 * AN6 — the setup warnings a failed spawn threw away.
 *
 * `runAgentImpl` buffers five kinds of warning during setup rather than
 * notifying, and its own comment says why: a notification between `tool_use` and
 * `tool_result` in the session tree is a 400. Every one of them is a sentence
 * about the agent file the operator just edited — two `tools`/`exclude_tools`
 * conflicts, a custom prompt file that is not there, an extension name that
 * matched nothing, a tool name that matched nothing.
 *
 * They were lost two ways, and both are what this file pins:
 *
 *   1. **The run threw.** The flush was a bare loop after the `await`, with no
 *      `finally`, so `ABORTED_BEFORE_START`, a provider fault on the first call
 *      or a session that would not bind took the whole buffer with it. The run
 *      most likely to have been *caused* by a misconfiguration was the one whose
 *      misconfiguration warning was dropped.
 *   2. **There was no UI.** It read `if (ctx.ui?.notify) … else console.warn(…)`,
 *      and pi's `noOpUIContext.notify` is `() => {}` — a real function — so the
 *      `else` was unreachable and the warnings went nowhere under `pi -p`, a
 *      cron run or an unattended `/loop`. `reportDrop` in
 *      `spawn/spawn-coordinator.ts` gets this right thirty lines away: console
 *      first, unconditionally, then the UI.
 *
 * The module is driven directly. `agent-runner.ts` imports pi and the suite
 * cannot load it, which is the whole reason the buffer is a module now; the
 * wiring is pinned by `agent-runner-flush.test.ts`.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { NoticeBuffer, NOTICE_PREFIX } from "../src/agents/notice-buffer.ts";

/** A target with a UI that records, like a TUI. */
function withUI() {
  const notified: { message: string; level: string }[] = [];
  return {
    target: { ui: { notify: (message: string, level: string) => notified.push({ message, level }) } },
    notified,
  };
}

describe("NoticeBuffer", () => {
  it("holds what it is given, in order, without saying it", () => {
    const buffer = new NoticeBuffer();
    const { target, notified } = withUI();
    buffer.add("first");
    buffer.add("second");
    assert.deepEqual([...buffer.pending], ["first", "second"]);
    assert.deepEqual(notified, [], "nothing may reach the UI before the flush");
    void target;
  });

  it("releases on BOTH channels, prefixed", () => {
    const buffer = new NoticeBuffer();
    const { target, notified } = withUI();
    const logged: string[] = [];
    buffer.add("agent \"X\": both tools and exclude_tools set");
    buffer.flush(target, (line) => logged.push(line));
    assert.deepEqual(logged, [`${NOTICE_PREFIX} agent "X": both tools and exclude_tools set`]);
    assert.deepEqual(notified, [
      { message: `${NOTICE_PREFIX} agent "X": both tools and exclude_tools set`, level: "warning" },
    ]);
  });

  it("still speaks when there is no UI at all — the headless case", () => {
    const buffer = new NoticeBuffer();
    const logged: string[] = [];
    buffer.add("extension \"Y\" not found in loaded extensions");
    buffer.flush(undefined, (line) => logged.push(line));
    assert.equal(logged.length, 1, "console.warn is the channel that exists headless");
  });

  it("still speaks when the UI is pi's no-op — which is a real function", () => {
    // `noOpUIContext.notify` is `() => {}`, so a `ctx.ui?.notify ? … : console`
    // ternary picks the branch that says nothing. Both channels, always.
    const buffer = new NoticeBuffer();
    const logged: string[] = [];
    buffer.add("Custom prompt file not found");
    buffer.flush({ ui: { notify: () => {} } }, (line) => logged.push(line));
    assert.equal(logged.length, 1);
  });

  it("is idempotent: a second flush has nothing left to say", () => {
    const buffer = new NoticeBuffer();
    const logged: string[] = [];
    buffer.add("once");
    buffer.flush(undefined, (line) => logged.push(line));
    buffer.flush(undefined, (line) => logged.push(line));
    assert.deepEqual(logged, [`${NOTICE_PREFIX} once`], "a finally and a normal-path call must not double-report");
  });

  it("a throwing UI does not cost the console line, or the notices after it", () => {
    const buffer = new NoticeBuffer();
    const logged: string[] = [];
    buffer.add("one");
    buffer.add("two");
    buffer.flush({ ui: { notify: () => { throw new Error("session is going away"); } } }, (line) =>
      logged.push(line),
    );
    assert.deepEqual(logged, [`${NOTICE_PREFIX} one`, `${NOTICE_PREFIX} two`]);
  });

  it("a throwing console does not cost the UI line", () => {
    const buffer = new NoticeBuffer();
    const { target, notified } = withUI();
    buffer.add("one");
    buffer.flush(target, () => {
      throw new Error("stdout is gone");
    });
    assert.equal(notified.length, 1);
  });

  it("`add` survives being handed on as a bare function", () => {
    // All five writers take it as `(msg: string) => void` and call it detached.
    const buffer = new NoticeBuffer();
    const handOn = (notify: (msg: string) => void) => notify("from a callee");
    handOn(buffer.add);
    assert.deepEqual([...buffer.pending], ["from a callee"]);
  });
});
