/**
 * AF3 — five exits of `agent_end` that dropped their own directive.
 *
 * Each one of these is the loop's ANSWER to something it just decided:
 *
 *   improve       LOOP_DONE in endless mode — "open IMPROVEMENTS.md … take the
 *                 TOP open item, implement it now"
 *   unblock       LOOP_BLOCKED — "make the most reasonable assumption, record it
 *                 in ASSUMPTIONS.md, and continue. Never wait for a human"
 *   check_failed  the model claimed done and the check disagrees
 *   regression    the score dropped, with the numbers in the sentence
 *   audit         nothing concrete changed for NO_PROGRESS_WINDOW iterations —
 *                 "produce a tangible artifact this turn"
 *
 * All five sat behind `if (!ctx.hasPendingMessages()) scheduleLoopTurn(…)` with
 * no else, and all five charge their counters ABOVE that guard: `doneSignalCount`,
 * `blockedSignalCount`, `interventionCount`, the operator's notice, and — for
 * `audit` — `lastStateChangeIteration`, which is what stops the same nudge firing
 * again for another eight iterations. So with a message pending the ladder was
 * charged and the sentence it was charged for was never said.
 *
 * V4 (sixth pass) found exactly this in `interveneStuck` and fixed it there,
 * with the argument that names the rule: *the guard is right for every other
 * exit, where the loop only needs A turn to happen; here the loop needs THIS
 * TEXT to reach the model.* Five of the other exits also need THIS TEXT. The
 * sixth — `continue` — really does only need a turn, and still drops.
 *
 * `hasPendingMessages()` is true only when a human typed into a streaming
 * session (AA3), and at `agent_end` that means they typed after the agent loop's
 * last follow-up drain — most plausibly while this handler was awaiting a goal
 * check that may run for `checkTimeoutSeconds`.
 *
 * See AF3 in `context/design/subagents-loop-verifier-omissions.md`.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import loopModeExtension from "../extensions/index.ts";
import { completedCheck, type ExecResult } from "./exec-shapes.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;
type Sent = { message: { customType?: string; content?: string; details?: { kind?: string } }; options?: unknown };

function makeHost(options: { pendingMessages?: boolean; exec?: () => ExecResult } = {}) {
  const handlers = new Map<string, Handler[]>();
  const notices: string[] = [];
  const sent: Sent[] = [];
  let command: ((args: string, ctx: unknown) => Promise<void>) | undefined;

  const pi = {
    on(name: string, fn: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), fn]);
    },
    registerCommand(_name: string, config: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      command = config.handler;
    },
    registerTool() {},
    appendEntry() {},
    sendMessage(message: unknown, opts?: unknown) {
      sent.push({ message: message as Sent["message"], options: opts });
    },
    async exec() {
      return options.exec ? options.exec() : completedCheck(0);
    },
    async setModel() {
      return true;
    },
  };

  const ctx = {
    cwd: process.cwd(),
    mode: "tui",
    hasUI: true,
    ui: {
      notify(message: string) {
        notices.push(String(message));
      },
      setStatus() {},
    },
    sessionManager: { getBranch: () => [], getEntries: () => [] },
    modelRegistry: { find: () => undefined, getAll: () => [] },
    model: { api: "openai-completions", contextWindow: 32_768 },
    isIdle: () => true,
    hasPendingMessages: () => options.pendingMessages === true,
    getContextUsage: () => ({ tokens: 6_554, contextWindow: 32_768, percent: 20 }),
    compact() {},
    abort() {},
    async waitForIdle() {},
  };

  const fire = async (name: string, event: unknown = {}) => {
    for (const fn of handlers.get(name) ?? []) await fn(event, ctx);
  };

  const assistant = (text: string) => ({
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
    usage: { output: 40 },
  });

  return {
    notices,
    sent,
    async start(args: string) {
      loopModeExtension(pi as never);
      notices.length = 0;
      await command!(args, ctx);
    },
    /** One whole turn: an assistant message, optional tool results, then agent_end. */
    async turn(text: string, tools: { tool: string; text: string }[] = []) {
      notices.length = 0;
      sent.length = 0;
      await fire("message_end", { message: assistant(text) });
      for (const call of tools) {
        await fire("tool_result", {
          toolName: call.tool,
          content: [{ type: "text", text: call.text }],
          isError: false,
        });
      }
      await fire("agent_end", { messages: [assistant(text)] });
      return notices.join(" | ");
    },
    async stop() {
      notices.length = 0;
      await command!("stop", ctx);
    },
  };
}

const directives = (sent: Sent[], kind: string) => sent.filter((s) => s.message.details?.kind === kind);

/** What V4 established the queued form has to be — see Z4 for why not `nextTurn`. */
const QUEUED = { triggerTurn: true, deliverAs: "steer" };

describe("AF3 — a directive survives a pending message", () => {
  it("improve — the whole answer to LOOP_DONE in endless mode", async () => {
    const host = makeHost({ pendingMessages: true });
    await host.start("keep the docs in step with the code");
    // Two different done-turns, so the second cannot be read as a repeat and
    // routed to interveneStuck instead.
    await host.turn("LOOP_DONE: the importer now streams and the suite is green.", [{ tool: "bash", text: "ok" }]);
    const notice = await host.turn("LOOP_DONE: split the CSV front end out; nothing else moved.", [
      { tool: "bash", text: "fine" },
    ]);
    await host.stop();

    assert.match(notice, /goal reported done/, "the outcome is still decided and still announced");
    const queued = directives(host.sent, "improve");
    assert.equal(queued.length, 1, "and the improvement directive it announced is actually sent");
    assert.deepEqual(queued[0].options, QUEUED);
    assert.match(String(queued[0].message.content), /IMPROVEMENTS\.md/);
  });

  it("unblock — the whole answer to LOOP_BLOCKED", async () => {
    const host = makeHost({ pendingMessages: true });
    await host.start("wire up the exporter");
    const notice = await host.turn("LOOP_BLOCKED: no credentials for the staging bucket.", [
      { tool: "bash", text: "checked" },
    ]);
    await host.stop();

    assert.match(notice, /blocked reported/);
    const queued = directives(host.sent, "unblock");
    assert.equal(queued.length, 1);
    assert.deepEqual(queued[0].options, QUEUED);
    assert.match(String(queued[0].message.content), /ASSUMPTIONS\.md/);
  });

  it("check_failed — the model claimed done and the check disagrees", async () => {
    const host = makeHost({ pendingMessages: true, exec: () => completedCheck(1, "2 failing") });
    await host.start('make the suite green --until-done --check "npm test"');
    const notice = await host.turn("LOOP_DONE: everything passes now.", [{ tool: "bash", text: "ran" }]);
    await host.stop();

    assert.match(notice, /goal check fails/);
    const queued = directives(host.sent, "check_failed");
    assert.equal(queued.length, 1, "the model has to be told the check disagrees with it");
    assert.deepEqual(queued[0].options, QUEUED);
  });

  it("regression — the score dropped, and the numbers are in the sentence", async () => {
    let score = 90;
    const host = makeHost({ pendingMessages: true, exec: () => completedCheck(1, `SCORE: ${score}`) });
    await host.start('raise the score --check "./check.sh"');
    await host.turn("Tuned the tokenizer.", [{ tool: "edit", text: "written" }]);
    score = 70;
    const notice = await host.turn("Reworked the lexer tables.", [{ tool: "edit", text: "written" }]);
    await host.stop();

    assert.match(notice, /regressed/);
    const queued = directives(host.sent, "regression");
    assert.equal(queued.length, 1);
    assert.deepEqual(queued[0].options, QUEUED);
    assert.match(String(queued[0].message.content), /score dropped to 70/);
  });

  it("audit — and the window it just reset is not spent for nothing", async () => {
    const host = makeHost({ pendingMessages: true });
    await host.start("investigate the flaky test");
    // NO_PROGRESS_WINDOW iterations of analysis with a tool call every turn (so
    // the narration-only rule stays out of it) and nothing that reads as a
    // change. The nudge fires on the eighth, which is also where it resets the
    // window — so that turn is the only one that can be looked at.
    let notice = "";
    for (let i = 0; i < 8; i++) {
      notice = await host.turn(`Looked at hypothesis ${i}; the timing is not it.`, [
        { tool: "bash", text: `sample ${i}` },
      ]);
    }
    await host.stop();

    assert.match(notice, /no concrete progress/i);
    const queued = directives(host.sent, "audit");
    assert.equal(queued.length, 1, "the audit nudge is the only thing that resets the no-progress window");
    assert.deepEqual(queued[0].options, QUEUED);
    assert.match(String(queued[0].message.content), /tangible artifact/);
  });

  it("control — `continue` still drops, because any turn advances the loop", async () => {
    const host = makeHost({ pendingMessages: true });
    await host.start("keep the docs in step with the code");
    await host.turn("Rewrote the install section.", [{ tool: "edit", text: "written" }]);
    const second = await host.turn("Rewrote the configuration section.", [{ tool: "edit", text: "written" }]);
    await host.stop();

    assert.equal(second, "", "an ordinary turn says nothing");
    assert.equal(
      host.sent.length,
      0,
      "the human's own turn is the next turn; 1,200 characters of loop rules must not ride on it",
    );
  });

  it("control — with nothing pending, all five are SCHEDULED as before", async () => {
    const host = makeHost({ pendingMessages: false });
    await host.start("keep the docs in step with the code");
    await host.turn("LOOP_DONE: the importer now streams and the suite is green.", [{ tool: "bash", text: "ok" }]);
    await host.turn("LOOP_DONE: split the CSV front end out; nothing else moved.", [{ tool: "bash", text: "fine" }]);
    await host.stop();

    const queued = directives(host.sent, "improve");
    assert.equal(queued.length, 1, "the directive still arrives");
    assert.deepEqual(
      queued[0].options,
      { triggerTurn: true },
      "…by starting a turn of its own, which is what an unattended loop needs",
    );
  });
});

/**
 * AK5 — what counts as a change, and what only says one happened.
 *
 * `hasStateChange` is named for a change to the project and used to test the
 * WORDS in a tool's output, for every tool. Two consequences, both measured
 * against the shipped predicate:
 *
 *   - a passing test suite reads as progress. `cargo test` prints
 *     "42 passed", jest prints "42 passed, 42 total", pytest prints
 *     "42 passed in 1.83s" — and a `--until-done --check` run re-runs the suite
 *     every iteration, so `lastStateChangeIteration` was pinned to the current
 *     iteration and the audit rung could never fire on the runs it was written
 *     for;
 *   - so does a READER. A `read` of a CHANGELOG, a `grep` that matches
 *     `updated`, an `ls` of a directory holding `created.txt`.
 *
 * The loop's own module state is global, so each case is its own `describe`
 * with its own `start`, exactly as the suite above does it.
 */
describe("what counts as a change (AK5)", () => {
  /**
   * Eight analysis turns whose only tool call is `call(i)`; the notice on the
   * last.
   *
   * The tool output has to differ per turn — three identical results in a row
   * are the stuck ladder's rule 7, which fires first and would make every case
   * below pass for the wrong reason. Varying it is also the honest shape: a
   * test suite prints a different duration every run.
   */
  async function eightTurnsOf(call: (i: number) => { tool: string; text: string }): Promise<string> {
    const host = makeHost({ pendingMessages: true });
    await host.start("investigate the flaky test");
    let notice = "";
    for (let i = 0; i < 8; i++) {
      notice = await host.turn(`Looked at hypothesis ${i}; the timing is not it.`, [call(i)]);
    }
    await host.stop();
    return notice;
  }

  it("a passing test suite is not progress — cargo", async () => {
    assert.match(
      await eightTurnsOf((i) => ({ tool: "bash", text: `test result: ok. 42 passed; 0 failed; finished in 1.${i}s` })),
      /no concrete progress/i,
    );
  });

  it("…nor jest, nor pytest", async () => {
    assert.match(
      await eightTurnsOf((i) => ({ tool: "bash", text: `Tests: 42 passed, 42 total\nTime: 1.${i}s` })),
      /no concrete progress/i,
    );
  });

  it("…nor pytest", async () => {
    assert.match(
      await eightTurnsOf((i) => ({ tool: "bash", text: `===== 42 passed in 1.8${i}s =====` })),
      /no concrete progress/i,
    );
  });

  it("a git log full of the word `fixed` is not progress either", async () => {
    assert.match(
      await eightTurnsOf((i) => ({
        tool: "bash",
        text: `commit 9f2a\n    fixed the parser\n\ncommit 1b3${i}\n    fixed the lexer`,
      })),
      /no concrete progress/i,
    );
  });

  it("a READER cannot have changed anything, whatever its output says", async () => {
    assert.match(
      await eightTurnsOf((i) => ({
        tool: "read",
        text: `CHANGELOG.md\n## 1.2.${i}\n- fixed the parser, updated the docs`,
      })),
      /no concrete progress/i,
    );
  });

  it("…and neither can a grep that happens to match", async () => {
    assert.match(
      await eightTurnsOf((i) => ({ tool: "grep", text: `src/a.ts:1${i}: // updated by the migration` })),
      /no concrete progress/i,
    );
  });

  it("the control: an edit still resets the window", async () => {
    const host = makeHost({ pendingMessages: true });
    await host.start("keep the docs in step with the code");
    let notice = "";
    for (let i = 0; i < 8; i++) {
      notice = await host.turn(`Rewrote section ${i}.`, [{ tool: "edit", text: "written" }]);
    }
    await host.stop();
    assert.doesNotMatch(notice, /no concrete progress/i);
    assert.equal(directives(host.sent, "audit").length, 0);
  });

  it("the control: a bash result that NAMES a change still counts", async () => {
    const host = makeHost({ pendingMessages: true });
    await host.start("land the migration");
    let notice = "";
    for (let i = 0; i < 8; i++) {
      notice = await host.turn(`Batch ${i}.`, [
        { tool: "bash", text: `create mode 100644 src/step-${i}.ts\n 1 file changed, 3 insertions(+)` },
      ]);
    }
    await host.stop();
    assert.doesNotMatch(notice, /no concrete progress/i);
  });

  it("the control: a delegation that says it wrote something still counts", async () => {
    const host = makeHost({ pendingMessages: true });
    await host.start("port the tests");
    let notice = "";
    for (let i = 0; i < 8; i++) {
      notice = await host.turn(`Delegated batch ${i}.`, [
        { tool: "Agent", text: `Created tests/step-${i}.test.ts and updated the index.` },
      ]);
    }
    await host.stop();
    assert.doesNotMatch(notice, /no concrete progress/i);
  });
});
