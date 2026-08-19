/**
 * AA2 — a goal check that was killed did not run, and must not read as one that
 * passed.
 *
 * ## What pi actually returns
 *
 * `ExtensionAPI.exec` (`loader.js:287`) is `execCommand` (`core/exec.js`), and
 * its body is a `new Promise((resolve) => …)` with **no `reject`**:
 *
 *   timeout       → `killProcess()` → SIGTERM → the child exits with a SIGNAL and
 *                   `code === null` → `waitForChildProcess` resolves `null` →
 *                   `resolve({…, code: null ?? 0, killed: true})`
 *   spawn error   → `waitForChildProcess` rejects → `.catch` → `resolve({…, code: 1})`
 *   non-zero exit → `resolve({…, code: n})`
 *
 * So U3's `execFailed` — wired to a `catch` — was unreachable, and the timeout
 * case arrived as **exit code 0**, which `runGoalCheck` read as `passed: true`.
 * In `--until-done` mode `lastCheckPassed === true` is the run's only
 * terminating condition.
 *
 * These tests drive the shipped loop with an `exec` stub that returns exactly
 * what pi's `execCommand` returns for each case — the shapes are taken from
 * `context/testing/probes/n2-…`, which calls the real `execCommand`.
 *
 * See AA2 in `context/design/subagents-loop-verifier-hosts.md`.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";

import loopModeExtension from "../extensions/index.ts";
import { CHECK_COMPLETION_MARKER, readCheckCompletion, wrapCheckCommand } from "../src/goal-check.ts";
import { completedCheck, signalledCheck, timedOutCheck, type ExecResult } from "./exec-shapes.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

/**
 * What pi's real execCommand resolves for each way a check can go wrong.
 *
 * Built through `tests/exec-shapes.ts` since the eleventh pass, so a case that
 * REACHED bash's own exit carries the completion marker and a case that was
 * signalled does not. Before AB1 every entry here was written by hand without
 * one, which made `passed` and `killedBySignal` the same object — see that
 * module's header.
 */
const EXEC_RESULTS = {
  /** `bash -lc "sleep 5"` with timeout 1s. Verified against the real execCommand. */
  killedByTimeout: timedOutCheck(),
  /** A check that ran and failed. */
  failed: completedCheck(1, "", "tests: 3 failed"),
  /** A check whose script is missing: the shell's own 127. */
  missingScript: completedCheck(127, "", "./check.sh: No such file or directory"),
  /** A check that ran and passed. */
  passed: completedCheck(0, "SCORE: 90\nall green"),
  /** AB1: `bash -lc "…"` reaped by the OOM killer. pi calls this exit code 0. */
  killedBySignal: signalledCheck(),
  /** AB1: the same, after the check had printed something. */
  killedBySignalMidway: signalledCheck("running 412 tests"),
} satisfies Record<string, ExecResult>;

function makeHost(exec: () => Promise<ExecResult>) {
  const handlers = new Map<string, Handler[]>();
  const notices: string[] = [];
  const sent: unknown[] = [];
  /** Every argv the loop handed pi.exec, so a test can assert on the SCRIPT it ran. */
  const execArgs: string[][] = [];
  let command: ((args: string, ctx: unknown) => Promise<void>) | undefined;

  const pi = {
    on(name: string, fn: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), fn]);
    },
    registerCommand(_n: string, config: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      command = config.handler;
    },
    registerTool() {},
    appendEntry() {},
    sendMessage(m: unknown) {
      sent.push(m);
    },
    exec(_cmd: string, args: string[]) {
      execArgs.push(args);
      return exec();
    },
    async setModel() {
      return true;
    },
  };

  const ctx = {
    cwd: process.cwd(),
    mode: "tui",
    hasUI: true,
    ui: { notify: (m: string) => notices.push(String(m)), setStatus() {} },
    sessionManager: { getBranch: () => [], getEntries: () => [] },
    modelRegistry: { find: () => undefined, getAll: () => [] },
    model: { api: "openai-completions", contextWindow: 32_768 },
    isIdle: () => true,
    hasPendingMessages: () => false,
    getContextUsage: () => ({ tokens: 6_554, contextWindow: 32_768, percent: 20 }),
    compact() {},
    abort() {},
    async waitForIdle() {},
  };

  loopModeExtension(pi as never);

  return {
    notices,
    sent,
    execArgs,
    async run(args: string) {
      notices.length = 0;
      await command!(args, ctx);
      return notices.join("\n");
    },
    /** One turn: one assistant message, one tool call, then agent_end. */
    async turn(text: string) {
      const message = { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", usage: { output: 60 } };
      notices.length = 0;
      sent.length = 0;
      await fire("message_end", { message });
      await fire("tool_result", { toolName: "edit", content: [{ type: "text", text: "written" }] });
      await fire("agent_end", { messages: [message] });
      return notices.join(" | ");
    },
  };

  async function fire(name: string, event: unknown) {
    for (const fn of handlers.get(name) ?? []) await fn(event, ctx);
  }
}

describe("AA2 — a killed check is a check that did not run", () => {
  it("does not complete an --until-done run on a check that timed out", async () => {
    const host = makeHost(async () => EXEC_RESULTS.killedByTimeout);
    await host.run('start ship it --check "sleep 5" --check-timeout 1 --until-done');

    // The model says it is finished. Only the check may agree.
    await host.turn("LOOP_DONE: shipped it");

    const status = await host.run("status");
    assert.match(status, /Active: true/, "a check that never ran must not be allowed to end the run");
    assert.doesNotMatch(status, /Status: completed/);
    await host.run("end");
  });

  it("reports the check as unrunnable rather than as passing", async () => {
    const host = makeHost(async () => EXEC_RESULTS.killedByTimeout);
    await host.run('start ship it --check "sleep 5" --check-timeout 1 --until-done');
    await host.turn("did a batch");

    const status = await host.run("status");
    assert.match(status, /COULD NOT RUN|could not run|not run/i);
    assert.doesNotMatch(status, /Check status: passing/);
    await host.run("end");
  });

  it("escalates to a pause after MAX_CHECK_ERRORS killed checks", async () => {
    const host = makeHost(async () => EXEC_RESULTS.killedByTimeout);
    await host.run('start ship it --check "sleep 5" --check-timeout 1 --until-done');

    let paused = "";
    for (let i = 0; i < 3; i++) paused = await host.turn(`batch ${i + 1}`);

    assert.match(paused, /check/i);
    const status = await host.run("status");
    assert.match(status, /Status: (paused|stopped)/, "three checks that cannot run must stop an unattended run");
    await host.run("end");
  });

  it("control — a check that RAN and failed is still a failing check", async () => {
    const host = makeHost(async () => EXEC_RESULTS.failed);
    await host.run('start ship it --check "npm test" --until-done');
    await host.turn("did a batch");

    const status = await host.run("status");
    assert.match(status, /Check status: failing/);
    assert.doesNotMatch(status, /COULD NOT RUN/i);
    await host.run("end");
  });

  it("control — a check that RAN and passed still completes an --until-done run", async () => {
    const host = makeHost(async () => EXEC_RESULTS.passed);
    await host.run('start ship it --check "npm test" --until-done');
    await host.turn("did a batch");

    const status = await host.run("status");
    assert.match(status, /Check status: passing/);
    assert.match(status, /Status: completed/, "a check that really passed must still end an --until-done run");
  });

  it("control — exit 127 is left as a failing check, not a broken harness", async () => {
    // Deliberate: the shell's "command not found" usually IS a broken check, but a
    // check script may exit 127 for its own reasons, and misreading a real failure
    // as an unrunnable harness would pause a run that should keep working.
    // `killed` is unambiguous; 127 is a guess. See runGoalCheck's header.
    const host = makeHost(async () => EXEC_RESULTS.missingScript);
    await host.run('start ship it --check "./check.sh" --until-done');
    await host.turn("did a batch");

    const status = await host.run("status");
    assert.match(status, /Check status: failing/);
    await host.run("end");
  });
});

/**
 * AB1 — `killed` is pi's own kill, and nothing else.
 *
 * `execCommand` sets `killed` inside `killProcess()`, and `killProcess` has
 * exactly two callers: the `options.timeout` timer and the `options.signal`
 * listener. So the field answers "did pi stop this", not "did this finish". Every
 * other death — the OOM killer, an operator's `pkill`, the container going down —
 * arrives as a signalled exit, which Node reports as `code === null`,
 * `waitForChildProcess` resolves as `null`, and `execCommand` turns into
 * `code: 0, killed: false`. That is the shape of a check that PASSED.
 *
 * pi has no field that says otherwise, so the evidence comes from inside the
 * child: `runGoalCheck` wraps the command in a bash `EXIT` trap and reads the
 * marker's presence. bash runs an EXIT trap on a normal exit, on `exit N`, and on
 * a SIGTERM — and cannot run one at all when SIGKILLed.
 *
 * See AB1 in `context/design/subagents-loop-verifier-signals.md`, and
 * `context/testing/probes/o1-…` for the same cases against the real execCommand.
 */
describe("AB1 — a check killed by something other than pi is still a check that did not run", () => {
  it("runs the check under a completion marker rather than bare", async () => {
    const host = makeHost(async () => EXEC_RESULTS.passed);
    await host.run('start ship it --check "npm test" --until-done');
    await host.turn("did a batch");

    const script = host.execArgs.at(-1)?.at(-1) ?? "";
    assert.match(script, /^trap /, "the check must run under an EXIT trap, or a signalled death is invisible");
    assert.match(script, new RegExp(CHECK_COMPLETION_MARKER));
    // AC3 (twelfth pass): in a subshell, on its own line, and otherwise
    // untouched — a trap set by the check itself replaces ours if they share a
    // shell, and `exec` discards it. See wrapCheckCommand.
    assert.match(script, /\n\(\nnpm test\n\)$/, "the operator's command must run in its own shell, untouched");
    await host.run("end");
  });

  it("does not complete an --until-done run on a check the OOM killer reaped", async () => {
    const host = makeHost(async () => EXEC_RESULTS.killedBySignal);
    await host.run('start ship it --check "cargo test" --until-done');

    await host.turn("LOOP_DONE: shipped it");

    const status = await host.run("status");
    assert.match(status, /Active: true/, "exit code 0 from a signalled child must not end the run");
    assert.doesNotMatch(status, /Status: completed/);
    await host.run("end");
  });

  it("reports it as unrunnable, and says a signal is why", async () => {
    const host = makeHost(async () => EXEC_RESULTS.killedBySignal);
    await host.run('start ship it --check "cargo test" --until-done');
    const notice = await host.turn("did a batch");

    assert.match(notice, /could not run/i);
    assert.match(notice, /signal|out-of-memory/i, "the operator needs to know it was killed, not that it failed");
    const status = await host.run("status");
    assert.doesNotMatch(status, /Check status: passing/);
    await host.run("end");
  });

  it("escalates to a pause after MAX_CHECK_ERRORS of them", async () => {
    const host = makeHost(async () => EXEC_RESULTS.killedBySignalMidway);
    await host.run('start ship it --check "cargo test" --until-done');

    for (let i = 0; i < 3; i++) await host.turn(`batch ${i + 1}`);

    const status = await host.run("status");
    assert.match(status, /Status: (paused|stopped)/, "a check that keeps dying must stop an unattended run");
    await host.run("end");
  });

  it("keeps whatever the check printed before it died", async () => {
    const host = makeHost(async () => EXEC_RESULTS.killedBySignalMidway);
    await host.run('start ship it --check "cargo test" --until-done');
    const notice = await host.turn("did a batch");

    assert.match(notice, /running 412 tests/, "the partial output is the only clue to where it died");
    await host.run("end");
  });

  it("control — the marker never reaches the operator or the model", async () => {
    const host = makeHost(async () => EXEC_RESULTS.failed);
    await host.run('start ship it --check "npm test" --until-done');
    const notice = await host.turn("did a batch");
    const status = await host.run("status");

    assert.doesNotMatch(notice, new RegExp(CHECK_COMPLETION_MARKER));
    assert.doesNotMatch(status, new RegExp(CHECK_COMPLETION_MARKER));
    assert.match(status, /Check status: failing/, "a check that ran and failed is unchanged by the wrapper");
    await host.run("end");
  });

  it("control — a SCORE is still read out of a wrapped check's output", async () => {
    const host = makeHost(async () => EXEC_RESULTS.passed);
    await host.run('start ship it --check "npm test"');
    await host.turn("did a batch");

    const status = await host.run("status");
    assert.match(status, /90/, "the marker must not displace the score the loop reads");
    await host.run("end");
  });
});

/**
 * AC2 — a verdict from a run that has already ENDED, and a streak that outlives
 * the pause it caused. Twelfth pass.
 *
 * `/loop resume` deliberately does not reset the check's state: a resumed run IS
 * the same run, and V3's `resetCheckState` is on `/loop run` for exactly that
 * distinction. But two of those fields are not "state of this run" at all:
 *
 *   `lastCheckPassed`  in `--until-done` a `true` can only exist for the instant
 *                      before the run completes, because the completion branch
 *                      fires on the same condition. So the only way to observe
 *                      one is to resume a run that already finished — and then
 *                      the FIRST `LOOP_DONE:` completes the new run on a verdict
 *                      the check has not given since, which is precisely what
 *                      the `lastCheckPassed !== true` guard exists to refuse.
 *
 *   `checkErrorStreak` `pauseForCheckFailure` stops the run at MAX_CHECK_ERRORS
 *                      and tells the operator to fix the check and resume. The
 *                      streak that stopped them was handed back, so the next
 *                      unrunnable check was the fourth — "could not run (4/3)",
 *                      a counter past its own maximum — and re-paused at once.
 *                      `providerErrorStreak` is cleared on resume for this exact
 *                      reason, with the reason written next to it; this one was
 *                      left out.
 *
 * See AC2 in `context/design/subagents-loop-verifier-deliveries.md`.
 */
describe("AC2 — a check verdict does not outlive the run that earned it", () => {
  /** A host whose check can be switched between runs, the way a real one breaks. */
  function switchableHost() {
    let state: "passes" | "killed" = "passes";
    const host = makeHost(async () =>
      state === "passes" ? EXEC_RESULTS.passed : EXEC_RESULTS.killedBySignal,
    );
    return { host, break: () => { state = "killed"; } };
  }

  it("does not complete a RESUMED until-done run on a stale passing verdict", async () => {
    const { host, break: breakCheck } = switchableHost();
    await host.run('start ship it --check "cargo test" --until-done');
    await host.turn("did a batch");
    assert.match(await host.run("status"), /Status: completed/, "premise: the check passed and ended run 1");

    breakCheck();
    await host.run("resume");
    await host.turn("LOOP_DONE: shipped it");

    const status = await host.run("status");
    assert.match(status, /Active: true/, "a verdict from the previous run cannot end this one");
    assert.doesNotMatch(status, /Status: completed/);
    await host.run("end");
  });

  it("tells the model the CHECK is the work, not that the goal is met", async () => {
    const { host, break: breakCheck } = switchableHost();
    await host.run('start ship it --check "cargo test" --until-done');
    await host.turn("did a batch");
    breakCheck();
    await host.run("resume");

    const notice = await host.turn("LOOP_DONE: shipped it");
    assert.match(notice, /could not be run/i);
    await host.run("end");
  });

  it("clears the check-error streak on resume, like the provider streak", async () => {
    const host = makeHost(async () => EXEC_RESULTS.killedBySignal);
    await host.run('start ship it --check "cargo test" --until-done');
    for (let i = 0; i < 3; i++) await host.turn(`batch ${i + 1}`);
    assert.match(await host.run("status"), /Status: paused/, "premise: MAX_CHECK_ERRORS stopped it");

    await host.run("resume");
    const notice = await host.turn("batch 4");

    assert.match(notice, /\(1\/3\)/, "the operator fixed the check; the count that stopped them must not be handed back");
    assert.doesNotMatch(notice, /\(4\/3\)/);
    const status = await host.run("status");
    assert.doesNotMatch(status, /Status: paused/, "one hiccup after a resume must not re-pause the run");
    await host.run("end");
  });

  it("control — a check that RUNS and passes still completes a resumed run", async () => {
    const host = makeHost(async () => EXEC_RESULTS.passed);
    await host.run('start ship it --check "cargo test" --until-done');
    await host.turn("did a batch");
    await host.run("resume");
    await host.turn("more work");

    assert.match(await host.run("status"), /Status: completed/, "the check is still what decides");
  });

  it("control — /loop run still resets the whole check state (V3)", async () => {
    const { host, break: breakCheck } = switchableHost();
    await host.run('start ship it --check "cargo test" --until-done');
    await host.turn("did a batch");
    breakCheck();
    await host.run("run");
    await host.turn("LOOP_DONE: shipped it");

    const status = await host.run("status");
    assert.match(status, /Active: true/);
    assert.doesNotMatch(status, /passing/, "resetCheckState drops the verdict outright on this path");
    await host.run("end");
  });
});

/**
 * AC3 — the EXIT trap is one slot, and a check command can take it. Twelfth pass.
 *
 * AB1's evidence is "bash reached its own exit", printed by a `trap … EXIT`. Two
 * ordinary things a check does destroy that trap without destroying the check:
 * a second `trap … EXIT` REPLACES the first (traps are a slot, not a stack), and
 * `exec` discards them. Both produce a marker-less run that finished perfectly —
 * which the loop reads as "the check process died before it finished — killed by
 * a signal rather than by its own exit (an out-of-memory kill looks like this)",
 * and three of those pause an unattended run.
 *
 * `trap 'docker compose down' EXIT; docker compose run tests` is the shape of
 * every cleanup one-liner, and `/loop prepare` asks a model to write the check.
 *
 * These run REAL bash rather than a stub, because the fact under test is bash's
 * trap semantics and a stub of it would be the thing being questioned. They are
 * the unit-level half of `context/testing/probes/p3-…`, which drives the same
 * cases through pi's real `execCommand`.
 */
describe("AC3 — a check that sets its own EXIT trap still counts as one that ran", () => {
  /** Run a wrapped check through real bash and answer the two questions runGoalCheck asks. */
  function runWrapped(command: string): { code: number; completed: boolean; text: string } {
    const script = wrapCheckCommand(command);
    const result = spawnSync("bash", ["-lc", script], { encoding: "utf8" });
    const combined = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
    const { completed, text } = readCheckCompletion(combined);
    return { code: result.status ?? 0, completed, text };
  }

  it("a check with its own EXIT trap is a check that ran", () => {
    const out = runWrapped("trap 'echo cleaning up' EXIT; true");
    assert.equal(out.completed, true, "the wrapper's trap must survive one the check installs");
    assert.equal(out.code, 0);
    assert.match(out.text, /cleaning up/, "and the check's own cleanup must still happen");
  });

  it("…and its exit code is still the check's answer", () => {
    const out = runWrapped("trap 'echo cleaning up' EXIT; exit 2");
    assert.equal(out.completed, true);
    assert.equal(out.code, 2, "a failing check under its own trap is a FAILING check, not an absent one");
  });

  it("a check that execs is a check that ran", () => {
    const out = runWrapped("exec true");
    assert.equal(out.completed, true, "exec discards traps in the shell it replaces — not in ours");
  });

  it("control — a SIGKILLed check is still unrunnable, which is the case AB1 is for", () => {
    const out = runWrapped("kill -9 $$");
    assert.equal(out.completed, false, "the subshell must not become a way to survive a signal");
  });

  it("control — an ordinary check is unchanged in every readable way", () => {
    const passed = runWrapped("echo 'SCORE: 90'");
    assert.equal(passed.completed, true);
    assert.equal(passed.code, 0);
    assert.equal(passed.text, "SCORE: 90", "the marker must not displace what the loop parses");

    const failed = runWrapped("echo 'boom' >&2; exit 1");
    assert.equal(failed.completed, true);
    assert.equal(failed.code, 1);
    assert.match(failed.text, /boom/);

    const multi = runWrapped("echo one\necho two");
    assert.equal(multi.completed, true);
    assert.equal(multi.text, "one\ntwo");
  });

  it("control — a syntax error is still a syntax error", () => {
    const out = runWrapped("echo 'oops");
    assert.notEqual(out.code, 0, "the wrapper must not turn a broken command into a passing check");
  });
});
