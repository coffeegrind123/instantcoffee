/**
 * The stuck ladder: what reaches it, and in what unit its memory is counted.
 *
 * Two defects, one handler, and they compound — which is why they are pinned in
 * one file.
 *
 * ## U1 — the completion markers returned above every stuck check
 *
 * `agent_end`'s success path tests `LOOP_DONE:` third and `LOOP_BLOCKED:` fourth,
 * and both `return`. `detectStuck()` — degenerate repetition, the narration-only
 * counter, both identical-response tests, the near-duplicate test, the
 * repeated-tool-signature test, the repeated-question test — was seventh. So no
 * response carrying either marker could be detected as stuck.
 *
 * That is the steady state, not an edge case: this is ENDLESS mode by default and
 * `loopInstructions()` asks the model for `LOOP_DONE:` by name, then answers each
 * one with the `improve` directive, which invites another. Measured before the
 * fix: the same byte-identical, tool-free response eight times produced seven
 * interventions plain and ZERO with the marker, while `turnsWithoutTools` climbed
 * to nine unread.
 *
 * ## U2 — the windows counted messages and tool calls, the rules count turns
 *
 * `message_end` fires once per assistant MESSAGE and a tool-using turn produces
 * several; `tool_result` fires once per CALL. Both used to push straight into the
 * rolling windows, which `detectStuck` reads once per TURN and reports in turns.
 * Measured before the fix, in both directions:
 *
 *   - four turns with a byte-identical final answer were caught on turn 2 when
 *     each turn was one message, and NEVER caught when each turn was five;
 *   - one productive turn — edit a file, then three greps confirming nothing
 *     references it — was reported stuck, and was not when the greps came first.
 *
 * ## Controls
 *
 * Every case here is paired: the plain form of the same run must still behave the
 * way it always did, and the genuine cross-turn repetitions must still be caught.
 * A fix that simply stopped intervening would pass half of this file and fail the
 * other half.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import loopModeExtension from "../extensions/index.ts";
import { completedCheck } from "./exec-shapes.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

function makeHost(options: { pendingMessages?: boolean } = {}) {
  const handlers = new Map<string, Handler[]>();
  const notices: string[] = [];
  const sent: { message: unknown; options?: unknown }[] = [];
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
    sendMessage(message: unknown, options?: unknown) {
      sent.push({ message, options });
    },
    async exec() {
      // Faithful to what pi resolves for a check that reached its own exit; see
      // tests/exec-shapes.ts for why a bare `{ code: 0 }` is not (AB1).
      return completedCheck(0);
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
    // 20%: well below every saturation rung, so interveneStuck takes the
    // prompt-level path rather than the compaction shortcut.
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
    pi,
    notices,
    sent,
    async start(args: string) {
      loopModeExtension(pi as never);
      notices.length = 0;
      await command!(args, ctx);
    },
    /** One whole turn: N assistant messages, then M tool results, then agent_end. */
    async turn(messages: string[], tools: { tool: string; text: string; isError?: boolean }[] = []) {
      notices.length = 0;
      sent.length = 0;
      for (const text of messages) await fire("message_end", { message: assistant(text) });
      for (const call of tools) {
        await fire("tool_result", {
          toolName: call.tool,
          content: [{ type: "text", text: call.text }],
          isError: call.isError === true,
        });
      }
      await fire("agent_end", { messages: messages.map(assistant) });
      return notices.join(" | ");
    },
    /** The `/loop status` block. */
    async status() {
      notices.length = 0;
      await command!("status", ctx);
      return notices.join("\n");
    },
    /** Clears the scheduled iteration so the test process is not held open. */
    async stop() {
      notices.length = 0;
      await command!("stop", ctx);
    },
  };
}

const REPEATED = "The core goal looks complete: the parser handles every fixture in the suite and the tests are green.";

const isStuck = (notice: string) => /stuck|repeat|narration|degenerat/i.test(notice);

describe("U1 — the completion markers do not bypass the stuck ladder", () => {
  for (const [label, prefix] of [
    ["plain (control)", ""],
    ["LOOP_DONE:", "LOOP_DONE: "],
    ["LOOP_BLOCKED:", "LOOP_BLOCKED: "],
  ] as const) {
    it(`intervenes on a repeated, tool-free response — ${label}`, async () => {
      const host = makeHost();
      await host.start("improve the parser");
      const seen: boolean[] = [];
      for (let i = 0; i < 4; i++) seen.push(isStuck(await host.turn([prefix + REPEATED])));
      await host.stop();

      assert.equal(seen[0], false, "the first turn has nothing to repeat");
      assert.deepEqual(
        seen.slice(1),
        [true, true, true],
        `every repeat after the first must intervene (${label})`,
      );
    });
  }

  it("a marker turn that is NOT repeating still gets its own directive", async () => {
    const host = makeHost();
    await host.start("improve the parser");
    const first = await host.turn(["LOOP_DONE: rewrote the tokenizer to stream, and the suite is green."]);
    const second = await host.turn(["LOOP_DONE: split the CSV front end out of the importer; nothing else moved."]);
    await host.stop();

    assert.match(first, /continuing with improvement work/);
    assert.match(second, /continuing with improvement work/);
    assert.equal(isStuck(second), false, "different work each turn is not fixation");
  });

  it("clears the stuck streak on a healthy marker turn", async () => {
    const host = makeHost();
    await host.start("improve the parser");
    // Two identical turns arm the streak.
    await host.turn([REPEATED]);
    assert.match(await host.turn([REPEATED]), /stuck \(1x\)/);
    assert.match(await host.status(), /stuck streak: 1/);

    // A healthy LOOP_DONE turn must retire it. The streak is the number every
    // rung of interveneStuck's ladder spends — the rescue model at 3, the
    // compaction at 5, the HARD RESET block at 3 — and it is documented as "in a
    // row". It used to be cleared on two of this handler's eighteen exits, so a
    // good marker turn between two bad ones left it standing.
    await host.turn(["LOOP_DONE: added a fixture for ragged rows and taught the reader to skip them."]);
    const after = await host.status();
    await host.stop();

    assert.match(after, /stuck streak: 0/, "a healthy marker turn ends the run of stuck turns");
  });
});

describe("U2 — the repetition windows count turns, not messages", () => {
  const FINAL = "Nothing further to change here; the importer already handles every case in the fixture set.";
  const intermediates = (i: number) => [
    `Reading the importer entry point to see how stage ${"abcd"[i]} is wired.`,
    `Grepping for the ragged-row handler in the reader package under src/${"wxyz"[i]}.`,
    `Checking whether the ${["alpha", "beta", "gamma", "delta"][i]} fixture still applies.`,
    `Running the focused suite for the ${["one", "two", "three", "four"][i]} case.`,
  ];
  const edits = (i: number) =>
    [0, 1, 2, 3].map((k) => ({ tool: "edit", text: `edited src/stage-${i}-${k}.ts` }));

  it("catches a repeated final answer whether the turn is one message or five", async () => {
    for (const multi of [false, true]) {
      const host = makeHost();
      await host.start("tidy the importer");
      const seen: boolean[] = [];
      for (let i = 0; i < 3; i++) {
        const messages = multi ? [...intermediates(i), FINAL] : [FINAL];
        seen.push(isStuck(await host.turn(messages, edits(i))));
      }
      await host.stop();
      assert.deepEqual(
        seen,
        [false, true, true],
        multi
          ? "five messages per turn must not flush the previous turn's answer out of the window"
          : "control: one message per turn was always caught",
      );
    }
  });

  it("does not call one productive turn stuck, whichever order it worked in", async () => {
    const nomatch = { tool: "grep", text: "No matches found." };
    const edit = { tool: "edit", text: "edited src/importer.ts" };
    for (const [label, order] of [
      ["confirmation last", [edit, nomatch, nomatch, nomatch]],
      ["confirmation first", [nomatch, nomatch, nomatch, edit]],
    ] as const) {
      const host = makeHost();
      await host.start("tidy the importer");
      const notice = await host.turn(
        ["Removing the shim, and confirming nothing still references it.", "Done — the shim is gone."],
        order as { tool: string; text: string }[],
      );
      await host.stop();
      assert.equal(isStuck(notice), false, `one turn must not read as repetition (${label})`);
    }
  });

  it("still catches the same calls returning the same thing three turns running", async () => {
    const host = makeHost();
    await host.start("tidy the importer");
    // Deliberately different prose each turn, so ONLY the tool rule can fire.
    const bodies = [
      "Checked the reader once more; nothing to change yet.",
      "Had another look at the front end, still no work to do here.",
      "Went over the fixtures again and found nothing that needs an edit.",
      "Took one more pass through the module header without changing it.",
    ];
    const seen: boolean[] = [];
    for (const body of bodies) {
      seen.push(isStuck(await host.turn([body], [{ tool: "grep", text: "No matches found." }])));
    }
    await host.stop();
    assert.equal(seen[2] || seen[3], true, "three identical turn signatures must still be caught");
  });
});

/**
 * V4 — the intervention's directive is the intervention, and it has to arrive.
 *
 * `interveneStuck` charges the whole ladder unconditionally: the streak, the
 * intervention count, three turns of sampling penalties, `turnsWithoutTools` back
 * to zero, and the operator's "injecting new strategy" notice. The directive
 * itself sat behind `if (!ctx.hasPendingMessages())` with no else.
 *
 * That guard is right for every OTHER exit of `agent_end`, where the loop only
 * needs *a* turn to happen and a pending message will cause one. Here the loop
 * needs THIS TEXT to reach the model. And the two rungs above carry no such guard
 * — the rescue-model switch at streak 3 and the compaction at streak 5 both
 * schedule unconditionally — so with a message pending (the ordinary state while
 * a background subagent's result is queued) the ladder escalated to a model swap
 * having never once sent the cheap rung.
 *
 * The fix queues it onto that turn instead of scheduling a second one.
 *
 * ## Z4 — and the mode it was queued in is drained only by the OPERATOR
 *
 * V4 chose `deliverAs: "nextTurn"`. pi 0.84.2 has exactly one drain for
 * `_pendingNextTurnMessages` and it is inside `AgentSession.prompt()`
 * (`agent-session.js:880`) — the operator-typed path, which builds a user
 * message and injects the queue alongside it. Nothing the loop itself does
 * reaches it: not `sendCustomMessage`'s `triggerTurn` branch (`:1088` →
 * `_runAgentPrompt`), not `_handlePostAgentRun` (`:779` → `agent.continue()`),
 * not `Agent.continue()`, which drains the STEERING queue (`agent.js:236`). So
 * in an unattended run the directive was never delivered — to the model or to
 * the operator, since a queued message is not appended to the transcript until
 * it is drained — while every rung of the ladder was charged for it.
 *
 * `steer` is what "onto the turn that is already coming" actually means:
 * `agent_end` runs while `_isAgentRunActive` is still true (cleared in
 * `_emitAgentSettled`, `:327`), so the message joins the steering queue and
 * `Agent.continue()` drains the whole queue as one prompt — the pending message
 * and this directive on the same turn. `triggerTurn: true` is the backstop for
 * the case where nothing was going to run a turn after all.
 */
describe("V4 — a stuck directive survives a pending message", () => {
  const stuckSends = (sent: { message: unknown; options?: unknown }[]) =>
    sent.filter((s) => (s.message as { details?: { kind?: string } }).details?.kind === "stuck");

  it("queues the directive onto the turn that is already coming", async () => {
    const host = makeHost({ pendingMessages: true });
    await host.start("keep the docs in step with the code");

    await host.turn([REPEATED]);
    const second = await host.turn([REPEATED]);
    await host.stop();

    assert.ok(isStuck(second), "the intervention still fires");
    const queued = stuckSends(host.sent);
    assert.equal(queued.length, 1, "and the strategy it says it is injecting is actually sent");
    assert.deepEqual(
      queued[0].options,
      { triggerTurn: true, deliverAs: "steer" },
      "queued onto the pending turn in a mode pi drains without an operator prompt — see Z4",
    );
    assert.notEqual(
      (queued[0].options as { deliverAs?: string }).deliverAs,
      "nextTurn",
      "`nextTurn` is drained only by AgentSession.prompt(), which an unattended loop never calls",
    );
    assert.match(
      String((queued[0].message as { content?: string }).content),
      /Stuck intervention/,
      "and it is the stuck directive, not a plain continue",
    );
  });

  it("schedules it as its own turn when nothing is pending — the control", async () => {
    const host = makeHost();
    await host.start("keep the docs in step with the code");

    await host.turn([REPEATED]);
    const second = await host.turn([REPEATED]);
    await host.stop();

    assert.ok(isStuck(second));
    // Nothing is sent synchronously here: the escalating delay puts it on a
    // timer, which is the behaviour that was already correct and must not change.
    assert.equal(stuckSends(host.sent).length, 0, "delivery is deferred to the escalating delay");
  });
});
