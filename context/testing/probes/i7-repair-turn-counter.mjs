/**
 * I7 probe — U8 (**FIXED**): the verifier's repair added a CUMULATIVE turn number
 * on every turn, so a multi-turn repair inflated the record's turn count
 * triangularly.
 *
 * `runTrackingCallbacks(record, forward, writeTurnCount)` documents
 * `writeTurnCount` as "the per-path policy — the first run records the absolute
 * count, a continuation adds to the previous total", and the two paths that
 * existed when that was written do exactly that:
 *
 *     startAgent            (turnCount) => record.stats.turnCount = turnCount
 *     continueSettledAgent  (turnCount) => record.stats.turnCount = previousTurns + turnCount
 *                                          ^ previousTurns is captured ONCE, before the run
 *
 * The verifier's repair was a third caller and read differently:
 *
 *     buildVerifyDeps.repair (turnCount) => record.stats.turnCount =
 *                                             (record.stats.turnCount ?? 0) + turnCount
 *                                          ^ re-read the field it was writing
 *
 * `onTurnEnd` fires once per turn with the RUNNING total (1, then 2, then 3), so
 * adding it each time accumulates 1+2+3+… rather than counting turns. It now
 * captures `previousTurns` once, before the run, exactly as `continueSettledAgent`
 * does — and `tests/turn-tracking.test.ts` pins the source against the
 * accumulating form, which is the only shape this defect has.
 *
 * A one-turn repair is correct, which is why this is invisible in the common
 * case. The repair is run with `maxTurns: 1`, and `shouldSteerAtSoftLimit(1)` is
 * false, so no wrap-up steer is sent — but pi's loop keeps going while there are
 * tool results, and the child still has its tools. A repair that reads two files
 * before answering is three turns and reports six.
 *
 *   node --experimental-strip-types i7-repair-turn-counter.mjs
 */

import { REPO } from "./_host.mjs";

const { wireTurnTracking } = await import(`${REPO}/vendor/pi-subagents-lite/src/agents/turn-tracking.ts`);

/** The three `writeTurnCount` policies in agent-manager.ts, verbatim. */
const POLICIES = {
  "startAgent (first run)": (record) => (turnCount) => { record.turnCount = turnCount; },
  "continueSettledAgent (steer)": (record) => {
    const previousTurns = record.turnCount ?? 0;
    return (turnCount) => { record.turnCount = previousTurns + turnCount; };
  },
  "buildVerifyDeps.repair — BEFORE": (record) => (turnCount) => {
    record.turnCount = (record.turnCount ?? 0) + turnCount;
  },
  "buildVerifyDeps.repair — NOW": (record) => {
    const previousTurns = record.turnCount ?? 0;
    return (turnCount) => {
      record.turnCount = previousTurns + turnCount;
    };
  },
};

function fakeSession() {
  let listener;
  return {
    subscribe(l) { listener = l; return () => {}; },
    steer: async () => {},
    abort: async () => {},
    emitTurns(n) { for (let i = 0; i < n; i++) listener({ type: "turn_end" }); },
  };
}

const START = 5; // five turns already on the record when the repair begins

console.log("=== I7 · a record showing turnCount = 5, then a repair of N turns ===\n");
console.log("  " + "policy".padEnd(34) + "|  1 turn |  2 turns |  3 turns |  5 turns");
console.log("  " + "-".repeat(34) + "+---------+----------+----------+---------");

for (const [label, make] of Object.entries(POLICIES)) {
  const cells = [1, 2, 3, 5].map((turns) => {
    const record = { turnCount: START };
    const session = fakeSession();
    wireTurnTracking(session, { maxTurns: 1, graceTurns: 6, onTurnEnd: make(record) });
    session.emitTurns(turns);
    return String(record.turnCount).padStart(7);
  });
  console.log("  " + label.padEnd(34) + "| " + cells.join(" | "));
}

console.log("\n  " + "what a continuation must read".padEnd(34) + "| " + [6, 7, 8, 10].map((n) => String(n).padStart(7)).join(" | "));

console.log(`
NOW: the repair counts like the continuation it is. A five-turn repair takes a
record from 5 to 10.

BEFORE: 1+2+3+… — five turns took it from 5 to 20. A ONE-turn repair was correct,
which is why it stayed invisible; a repair runs more than one turn whenever the
child uses a tool before answering, because \`maxTurns: 1\` sends no wrap-up steer
(T1) and pi's loop keeps going while there are tool results.

The first row is the other control: a first run records the absolute count, and
must not start summing.

It surfaced in three places at once, because all three read the same field: the
widget's finished line, the \`turnCount\` in the Agent tool's result details, and
the \`turnCount\` written into the output transcript's footer. None of them is
load-bearing for control flow — the ceiling is enforced by \`wireTurnTracking\`'s
own private counter, not by this field — which is why the only cost was that the
number was wrong.
`);
