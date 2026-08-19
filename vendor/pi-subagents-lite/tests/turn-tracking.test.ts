/**
 * A one-turn budget must not manufacture a second turn.
 *
 * ## The failure this pins
 *
 * `wireTurnTracking` steers "wrap up immediately" when a run reaches its turn
 * ceiling, and hard-aborts `graceTurns` later. That is right for a long run: the
 * steer lands in a loop that was going to keep going anyway, and it turns a
 * severed run into a final answer.
 *
 * With `maxTurns: 1` it is not. pi's agent loop drains the steering queue
 * immediately after `turn_end` (pi-agent-core `agent-loop.js:160`, inside
 * `while (hasMoreToolCalls || pendingMessages.length > 0)`), and
 * `AgentSession._emit` (`agent-session.js:298`) calls subscribers synchronously,
 * so a steer queued from a `turn_end` subscriber is in the queue before the loop
 * decides whether to stop. The run therefore takes a SECOND provider call — and
 * `collectResponseText` resets on the injected user message's `message_start`,
 * so the text handed back is the reply to "wrap up", not the answer.
 *
 * Both of the answer verifier's model calls run with `maxTurns: 1`
 * (`agent-manager.ts` `buildVerifyDeps`). Measured against a loop-faithful stub
 * driving the real `runSessionPrompt`: a judge that replied
 * `VERDICT: NOT_ADDRESSED` had that verdict replaced by "I have already given my
 * final answer above", which `parseJudgeVerdict` reads as unreadable — and the
 * fail-open policy turns unreadable into a pass. So a rejected answer was
 * delivered as unchecked, at twice the cost, on the single llama slot the parent
 * is blocked on.
 *
 * The tests are on `turn-tracking.ts` rather than on `agent-runner.ts` because
 * that file imports pi at runtime and cannot be loaded under the plain node this
 * suite runs on. `runSessionPrompt`'s use of it is one call.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  DEFAULT_MAX_TURNS,
  normalizeMaxTurns,
  shouldSteerAtSoftLimit,
  TURN_LIMIT_STEER,
  wireTurnTracking,
} from "../src/agents/turn-tracking.ts";

/** A session that records what the ceiling did to it. */
function stubSession() {
  const steers: string[] = [];
  let aborts = 0;
  let listener: ((event: { type: string }) => void) | undefined;
  return {
    steers,
    aborted: () => aborts,
    turnEnd() {
      listener?.({ type: "turn_end" });
    },
    session: {
      subscribe(l: (event: { type: string }) => void) {
        listener = l;
        return () => {
          listener = undefined;
        };
      },
      async steer(text: string) {
        steers.push(text);
      },
      async abort() {
        aborts++;
      },
    },
  };
}

describe("normalizeMaxTurns", () => {
  it("gives every subagent a ceiling when nothing set one", () => {
    assert.equal(normalizeMaxTurns(undefined), DEFAULT_MAX_TURNS);
  });

  it("keeps 0 meaning unbounded, for anyone who deliberately wants that", () => {
    assert.equal(normalizeMaxTurns(0), undefined);
  });

  it("floors a negative or fractional budget at one turn", () => {
    assert.equal(normalizeMaxTurns(-5), 1);
  });
});

describe("shouldSteerAtSoftLimit", () => {
  it("is false for a one-turn budget — there is no wrap-up to ask for", () => {
    assert.equal(shouldSteerAtSoftLimit(1), false);
  });

  it("is true for anything longer, where the steer shortens a run in progress", () => {
    assert.equal(shouldSteerAtSoftLimit(2), true);
    assert.equal(shouldSteerAtSoftLimit(DEFAULT_MAX_TURNS), true);
  });
});

describe("wireTurnTracking with maxTurns: 1 (the verifier's judge and repair)", () => {
  it("does not steer, so pi's loop has nothing queued and the run ends on turn one", () => {
    const stub = stubSession();
    wireTurnTracking(stub.session, { maxTurns: 1, graceTurns: 6 });

    stub.turnEnd();

    assert.deepEqual(
      stub.steers,
      [],
      "a steer here is drained by agent-loop.js:160 and buys a second provider call whose reply replaces the answer",
    );
  });

  it("does NOT report turnLimited: reaching a one-turn ceiling is finishing, not being cut short", () => {
    const stub = stubSession();
    const tracking = wireTurnTracking(stub.session, { maxTurns: 1, graceTurns: 2 });

    stub.turnEnd();

    // V6. The flag follows the steer, not the ceiling, and for the same reason:
    // there was no wrap-up to ask for because there was nothing left to wrap up.
    // Its two readers both take it to mean the opposite — `status-note.ts`
    // appends "wrapped up at the turn limit — output may be partial" to the text
    // the parent model reads, and `verify.ts`'s structural gate returns
    // `worthJudging: false, skip: "cutoff"`, so the answer is never checked at
    // all. A deliberately one-turn agent had both, on every answer.
    assert.equal(
      tracking.getTurnLimited(),
      false,
      "a one-turn run that answered in one turn was not cut short of anything",
    );
    assert.equal(tracking.getAborted(), false);
  });

  it("still hard-aborts after the grace turns, so the ceiling is not lost with the flag", () => {
    const stub = stubSession();
    const tracking = wireTurnTracking(stub.session, { maxTurns: 1, graceTurns: 2 });

    // A one-turn run that made tool calls keeps going on pi's side; the ceiling
    // must still end it. `ceilingReached` is what arms this, and it is set
    // whether or not the steer went out.
    stub.turnEnd();
    stub.turnEnd();
    assert.equal(tracking.getAborted(), false, "turn 2 of 1 + 2 grace is still inside the budget");
    stub.turnEnd();
    assert.equal(tracking.getAborted(), true, "turn 3 reaches maxTurns + graceTurns");
    // And `aborted` outranks `turnLimited` in the manager's classification, so
    // the run that really was severed is still reported as severed.
    assert.equal(tracking.getTurnLimited(), false, "it was aborted, which is the truer word for it");
  });
});

/**
 * W4 — V6's repair, undone by a supported setting.
 *
 * V6 split `turnLimited` off the ceiling because "reaching a one-turn ceiling IS
 * finishing" and the flag's two readers take it to mean the opposite. The branch
 * one line above it — `graceTurns <= 0` — was left agreeing with the long case,
 * and it says something stronger: `aborted` outranks `turnLimited` in
 * `classifyRun`, its status note is "hit the turn limit before completion; output
 * may be incomplete", and `structuralVerdict` refuses to judge it.
 *
 * `graceTurns: 0` is reachable — the /agents spawn-options menu takes it with
 * `min: 0` — so an operator who turns grace turns off put every deliberately
 * one-turn agent back in exactly the bucket V6 took it out of.
 *
 * See W4 in context/design/subagents-loop-verifier-readers.md.
 */
describe("wireTurnTracking with maxTurns: 1 and no grace turns", () => {
  it("does not report a run that answered in its one turn as aborted", () => {
    const stub = stubSession();
    const tracking = wireTurnTracking(stub.session, { maxTurns: 1, graceTurns: 0 });

    stub.turnEnd();

    assert.equal(tracking.getAborted(), false, "the ceiling was reached by finishing, not by being cut off");
    assert.equal(tracking.getTurnLimited(), false, "and V6's flag stays off for the same reason");
    assert.equal(stub.aborted(), 0, "nothing to sever — the run is over");
    assert.deepEqual(stub.steers, [], "and still nothing is asked to wrap up a turn it has finished");
  });

  it("still severs a one-turn run that keeps going, on the very next turn", () => {
    // The ceiling is not lost with the label. `ceilingReached` is set either way,
    // so the `else if` fires at maxTurns + 0 — and `aborted` is then true.
    const stub = stubSession();
    const tracking = wireTurnTracking(stub.session, { maxTurns: 1, graceTurns: 0 });

    stub.turnEnd();
    stub.turnEnd();

    assert.equal(tracking.getAborted(), true, "a one-turn run that called tools is still bounded");
    assert.equal(stub.aborted(), 1);
  });

  it("control — a longer budget with no grace is still severed at its ceiling", () => {
    // The distinction is the one-turn shape, not grace turns. A run that reached
    // a ceiling it was never asked to wrap up really was cut off mid-task.
    const stub = stubSession();
    const tracking = wireTurnTracking(stub.session, { maxTurns: 2, graceTurns: 0 });

    stub.turnEnd();
    stub.turnEnd();

    assert.equal(tracking.getAborted(), true);
    assert.equal(stub.aborted(), 1);
  });
});

describe("wireTurnTracking with a real ceiling", () => {
  it("steers exactly once on reaching it, so a long run wraps up instead of being severed", () => {
    const stub = stubSession();
    wireTurnTracking(stub.session, { maxTurns: 3, graceTurns: 6 });

    stub.turnEnd();
    stub.turnEnd();
    assert.deepEqual(stub.steers, [], "nothing before the ceiling");

    stub.turnEnd();
    assert.deepEqual(stub.steers, [TURN_LIMIT_STEER], "the wrap-up, once");

    stub.turnEnd();
    assert.equal(stub.steers.length, 1, "and not again on every later turn");
  });

  it("DOES report turnLimited for a budget with somewhere left to go — the control for V6", () => {
    // The distinguishing property is `shouldSteerAtSoftLimit`: this run was asked
    // to wrap up, so it really was cut short of what it was doing, and both
    // readers of the flag are right about it. This case passes with or without
    // V6's fix, which is what makes it the control.
    const stub = stubSession();
    const tracking = wireTurnTracking(stub.session, { maxTurns: 3, graceTurns: 6 });

    stub.turnEnd();
    stub.turnEnd();
    assert.equal(tracking.getTurnLimited(), false, "nothing before the ceiling");

    stub.turnEnd();
    assert.deepEqual(stub.steers, [TURN_LIMIT_STEER], "asked to wrap up …");
    assert.equal(tracking.getTurnLimited(), true, "… and therefore cut short");
  });

  it("hard-aborts graceTurns after the soft limit", () => {
    const stub = stubSession();
    const tracking = wireTurnTracking(stub.session, { maxTurns: 2, graceTurns: 1 });

    stub.turnEnd();
    stub.turnEnd(); // soft limit
    assert.equal(tracking.getAborted(), false);
    stub.turnEnd(); // 3 >= 2 + 1
    assert.equal(tracking.getAborted(), true);
    assert.equal(stub.aborted(), 1);
  });

  it("takes no grace turn at all when the operator asked for none", () => {
    // The two branches are `if` / `else if`, so the turn that REACHES the
    // ceiling could never also abort on it. With graceTurns: 0 that did not
    // remove the grace turn — the wrap-up steer bought one anyway and the abort
    // landed at the end of it, so a run that produced a complete final answer
    // came back `aborted` ("output may be incomplete") rather than
    // `turn_limited`. The /agents spawn-options menu accepts 0 (`min: 0`), so
    // this is reachable rather than theoretical.
    const stub = stubSession();
    const tracking = wireTurnTracking(stub.session, { maxTurns: 2, graceTurns: 0 });

    stub.turnEnd();
    assert.equal(tracking.getAborted(), false, "not before the ceiling");
    stub.turnEnd(); // the ceiling itself
    assert.equal(tracking.getAborted(), true, "no grace turns means the ceiling is the end");
    assert.equal(stub.aborted(), 1);
    assert.deepEqual(stub.steers, [], "and nothing is asked to wrap up a turn it will not get");
  });

  it("still takes its grace turns when there are some (control)", () => {
    const stub = stubSession();
    const tracking = wireTurnTracking(stub.session, { maxTurns: 2, graceTurns: 1 });

    stub.turnEnd();
    stub.turnEnd();
    assert.equal(tracking.getAborted(), false, "the ceiling is a soft limit when grace is available");
    assert.equal(stub.steers.length, 1, "and the run is asked to wrap up");
  });

  it("never bounds an unbounded run", () => {
    const stub = stubSession();
    const tracking = wireTurnTracking(stub.session, { maxTurns: 0, graceTurns: 1 });

    for (let i = 0; i < 50; i++) stub.turnEnd();

    assert.deepEqual(stub.steers, []);
    assert.equal(tracking.getAborted(), false);
    assert.equal(tracking.getTurnLimited(), false);
  });

  it("counts every turn for the caller, ceiling or not", () => {
    const stub = stubSession();
    const seen: number[] = [];
    wireTurnTracking(stub.session, { maxTurns: 1, graceTurns: 6, onTurnEnd: (n) => seen.push(n) });

    stub.turnEnd();
    stub.turnEnd();

    assert.deepEqual(seen, [1, 2]);
  });
});

/**
 * The three `writeTurnCount` policies in agent-manager.ts, and the one that
 * counted wrong.
 *
 * `runTrackingCallbacks(record, forward, writeTurnCount)` documents the parameter
 * as "the per-path policy — the first run records the absolute count, a
 * continuation adds to the previous total", and the two paths that existed when
 * that was written do exactly that. The verifier's repair was a third caller and
 * read differently: it re-read the field it was writing —
 *
 *     record.stats.turnCount = (record.stats.turnCount ?? 0) + turnCount
 *
 * — and `onTurnEnd` fires once per turn with the RUNNING total (1, then 2, then
 * 3), so it accumulated 1+2+3+… rather than counting turns. A five-turn repair
 * took a record from 5 to 20 instead of 10.
 *
 * A one-turn repair is correct, which is why it stayed invisible. A repair runs
 * more than one turn whenever the child uses a tool before answering: it runs with
 * `maxTurns: 1`, which sends no wrap-up steer (see the one-turn exception above),
 * and pi's loop keeps going while there are tool results.
 *
 * Nothing in control flow reads the field — the ceiling is enforced by this
 * module's own private counter — so the cost was only that three readers (the
 * widget's finished line, the Agent tool's result details, the output
 * transcript's footer) were shown a number that was not the turn count.
 */
describe("turn counting — the repair is a continuation, and must count like one", () => {
  /** Verbatim from agent-manager.ts. */
  const policies = {
    firstRun: (record: { turnCount?: number }) => (turnCount: number) => {
      record.turnCount = turnCount;
    },
    continuation: (record: { turnCount?: number }) => {
      const previousTurns = record.turnCount ?? 0;
      return (turnCount: number) => {
        record.turnCount = previousTurns + turnCount;
      };
    },
    repair: (record: { turnCount?: number }) => {
      const previousTurns = record.turnCount ?? 0;
      return (turnCount: number) => {
        record.turnCount = previousTurns + turnCount;
      };
    },
  };

  const runTurns = (write: (turnCount: number) => void, turns: number) => {
    const stub = stubSession();
    wireTurnTracking(stub.session, { maxTurns: 1, graceTurns: 6, onTurnEnd: write });
    for (let i = 0; i < turns; i++) stub.turnEnd();
  };

  for (const turns of [1, 2, 3, 5]) {
    it(`a ${turns}-turn repair adds ${turns}, not ${(turns * (turns + 1)) / 2}`, () => {
      const record = { turnCount: 5 };
      runTurns(policies.repair(record), turns);
      assert.equal(record.turnCount, 5 + turns);
    });
  }

  it("control — a continuation counts the same way", () => {
    const record = { turnCount: 5 };
    runTurns(policies.continuation(record), 3);
    assert.equal(record.turnCount, 8);
  });

  it("control — a first run records the absolute count, not a sum", () => {
    const record = { turnCount: 5 };
    runTurns(policies.firstRun(record), 3);
    assert.equal(record.turnCount, 3);
  });

  /**
   * The cases above run a COPY of the three policies, because `agent-manager.ts`
   * imports pi and cannot be loaded by this suite. So they document the
   * arithmetic; this one pins the source.
   *
   * The defect has exactly one written form — a callback that re-reads the field
   * it is writing — and it is a form no correct caller needs, because every
   * caller already has the previous total in scope before the run starts.
   */
  it("no turn-count callback in agent-manager re-reads the field it writes", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../src/agents/agent-manager.ts", import.meta.url)),
      "utf8",
    );
    // Comments are stripped first: the fix's own comment quotes the defective
    // form, which is the right thing for a comment to do and the wrong thing for
    // this assertion to match.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    const accumulating = /record\.stats\.turnCount\s*=\s*\(?\s*record\.stats\.turnCount/;
    assert.equal(
      accumulating.test(code),
      false,
      "onTurnEnd fires with the RUNNING total, so adding it each turn counts 1+2+3+…; " +
        "capture the previous total once, before the run, as continueSettledAgent does",
    );
    // And the fixed form really is there, so this cannot pass by the callbacks
    // having been deleted.
    assert.equal((code.match(/const previousTurns = record\.stats\.turnCount \?\? 0;/g) ?? []).length, 2);
  });

  /**
   * V7, pinned the same way and for the same reason.
   *
   * The judge calls `runAgent` directly rather than `this.spawn()`, so there is
   * no AgentRecord and nothing in `dispose()` or `clear()` can ever reach its
   * session — the `finally` in `buildVerifyDeps.judge` IS the whole teardown, and
   * its own comment says so.
   *
   * It used to read the session off the run's result, and `result` is only
   * assigned when the await RESOLVES. `runAgentImpl` creates the session, binds
   * its extensions, and only then prompts, so every rejection after that point
   * dropped the only reference to a live session with its message history and its
   * bound extensions, for the life of the process. A timeout was never the
   * problem: the deadline aborts the signal, `prompt()` resolves, and
   * `assertNotExpired()` throws afterwards.
   *
   * The correct form captures the session at creation, which covers both exits.
   */
  it("the judge disposes the session it captured at creation, not the one on the result", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../src/agents/agent-manager.ts", import.meta.url)),
      "utf8",
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

    assert.equal(
      /result\?\.session\?\.dispose\(\)/.test(code),
      false,
      "`result` is undefined when runAgent rejects, and a rejection after createAgentSession() " +
        "returns is the one case with no other owner — capture the session in onSessionCreated",
    );
    // The fixed form, so this cannot pass by the teardown having been deleted.
    assert.match(code, /onSessionCreated:\s*\(session\)\s*=>\s*\{\s*judgeSession = session;/);
    assert.match(code, /judgeSession\?\.dispose\(\)/);
  });

  /**
   * W6 — and it is V7's other half.
   *
   * V7 moved the judge's capture into `onSessionCreated` on the strength of a
   * claim its own comment makes: that the callback "fires inside
   * `createAndConfigureSession`, before `bindExtensions` returns, so it covers
   * every failure the old form missed". It did not. It was the LAST line of that
   * function, below the bind and below the tool filtering, so the exit the
   * comment names by hand was still the one exit not covered — and the test above
   * cannot see that, because a source pin on the CAPTURE only asks whether it is
   * present.
   *
   * So this one pins the ORDER, in the other file. It is the assertion that would
   * have caught W6.
   */
  it("hands the session over before it is configured, not after", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../src/agents/agent-runner.ts", import.meta.url)),
      "utf8",
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

    const capture = code.indexOf("options.onSessionCreated?.(session)");
    const created = code.indexOf("const session = await initSession(");
    const bind = code.indexOf("await session.bindExtensions(");
    const filter = code.indexOf("session.setActiveToolsByName(");

    assert.ok(created >= 0 && capture >= 0 && bind >= 0 && filter >= 0, "all four sites must exist");
    assert.ok(capture > created, "nothing can be handed over before the session exists");
    assert.ok(
      capture < bind,
      "the capture is the only handle anything outside gets on this session, and both users of it " +
        "are teardown — a throw between createAgentSession() and the capture leaks it with no owner",
    );
    assert.ok(capture < filter, "same argument for the tool filtering, which also rebuilds the prompt");
  });
});
