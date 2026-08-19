/**
 * j6 — V6. `shouldSteerAtSoftLimit(1)` is false because a one-turn budget has no
 *      wrap-up to ask for (T1). `softLimitReached` is set anyway, and it is what
 *      `getTurnLimited()` returns.
 *
 * So a `max_turns: 1` agent that answers completely in one turn is reported
 * `turn_limited`, and that status means two things downstream:
 *
 *   status-note.ts   " (wrapped up at the turn limit — output may be partial)"
 *                    appended to the text the PARENT MODEL reads
 *   verify.ts        worthJudging: false, skip: "cutoff"
 *                    -> the answer is never checked, badge "⊘ unchecked (cut off)"
 *
 * Reachable three ways: `max_turns: 1` in an agent .md, "Max turns" in the
 * /agents spawn wizard, and `defaultMaxTurns` in the model-family config.
 * `__verifier` itself declares `maxTurns: 1`; its status is not read, so the
 * judge is unaffected.
 *
 * FIXED. `turnLimited` now follows the steer rather than the ceiling — the same
 * condition, for the same reason. `ceilingReached` is kept separate and still
 * arms the grace-turn abort, so a one-turn run that keeps calling tools is still
 * hard-aborted and still reports `aborted`, which is true.
 *
 *   node --experimental-strip-types j6-one-turn-budget-reads-as-turn-limited.mjs
 */
import { wireTurnTracking, shouldSteerAtSoftLimit } from "../../../vendor/pi-subagents-lite/src/agents/turn-tracking.ts";

function fakeSession() {
  let listener;
  const log = [];
  const session = {
    log,
    subscribe(l) { listener = l; return () => {}; },
    steer(t) { log.push(`steer("${t.slice(0, 18)}…")`); return Promise.resolve(); },
    abort() { log.push("abort()"); return Promise.resolve(); },
    turn() { listener({ type: "turn_end" }); },
  };
  return session;
}

function run(maxTurns, graceTurns, turns) {
  const s = fakeSession();
  const t = wireTurnTracking(s, { maxTurns, graceTurns });
  for (let i = 0; i < turns; i++) s.turn();
  return { turnLimited: t.getTurnLimited(), aborted: t.getAborted(), log: s.log };
}

const rows = [
  ["max_turns: 1  agent answers in one turn", 1, 6, 1],
  ["max_turns: 1  agent read a file first", 1, 6, 3],
  ["max_turns: 3  agent answers on turn 2", 3, 6, 2],
  ["max_turns: 3  agent reaches turn 3", 3, 6, 3],
  ["max_turns: 40 agent answers on turn 5", 40, 6, 5],
  ["max_turns: 40 agent reaches turn 40", 40, 6, 40],
];

console.log("=== what a finished run reports, through the real wireTurnTracking ===\n");
console.log("  scenario                                  turnLimited  aborted  wrap-up asked for?");
console.log("  " + "-".repeat(84));
for (const [label, m, g, n] of rows) {
  const r = run(m, g, n);
  console.log(
    `  ${label.padEnd(41)} ${String(r.turnLimited).padEnd(12)} ${String(r.aborted).padEnd(8)} ${r.log.length ? r.log.join(",") : "no"}`,
  );
}
console.log(`
  shouldSteerAtSoftLimit(1) = ${shouldSteerAtSoftLimit(1)}

BEFORE the fix

  max_turns: 1  agent answers in one turn   turnLimited TRUE
  max_turns: 1  agent read a file first     turnLimited TRUE

  Every OTHER row reporting turnLimited was ASKED TO WRAP UP — the flag and the
  steer agreed that the run had been cut short of what it was doing. The two
  one-turn rows were the only ones where the run reached its ceiling by
  FINISHING, and they were reported identically. Downstream that meant two
  things, both wrong:

    status-note.ts   " (wrapped up at the turn limit — output may be partial)"
                     appended to the text the PARENT MODEL reads
    verify.ts        worthJudging: false, skip: "cutoff"
                     -> the answer was never checked, badge "⊘ unchecked (cut off)"

NOW

  turnLimited is set exactly where the wrap-up steer is sent. The four rows that
  do not involve a one-turn budget are the control: they behaved correctly before
  and are unchanged. And the hard abort is unaffected — a one-turn run that keeps
  calling tools is still severed at maxTurns + graceTurns and reports \`aborted\`,
  which the gate refuses to judge for the right reason.`);
