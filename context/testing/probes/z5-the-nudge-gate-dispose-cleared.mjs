/**
 * z5 — AM5 and AM6, the two rules in `NudgeSchedule`.
 *
 * FIXED — this drives the REAL
 * `vendor/pi-subagents-lite/src/spawn/nudge-schedule.ts` in both columns.
 *
 * ## AM5 — the one-shot `dispose()` cleared
 *
 * `session_shutdown` runs the coordinator's teardown BEFORE the manager's, and
 * the manager's is what actually ends the runs:
 *
 *     getCoordinator()?.dispose();   ← cleared backgroundAgentIds
 *     …
 *     await mgr.dispose();           ← disposes every child session
 *       → each run's .finally → onAgentComplete
 *         → the set is empty and settlementCount is 1 → nothing scheduled,
 *           and therefore nothing REPORTED either
 *
 * AI1 (eighteenth pass) fixed the ids that were already queued and wrote down,
 * correctly, that the `session-replaced` guard "can only fire for a record that
 * settles AFTER the dispose". Those records are what the guard is FOR, and the
 * clear one statement above was the reason none of them could reach it. Each is
 * a finished delegation whose answer went nowhere with nothing said — AC1's rule
 * inverted:
 *
 *   > A delivery that did not happen is the loudest thing this class can report;
 *   > it must not be the quietest.
 *
 * ## AM6 — one timer, two deadlines
 *
 * Since AH1 there are two delays through one timer slot: 200 ms to coalesce
 * completions, and 5,000 ms to re-ask after a nudge was held for somebody else's
 * compaction. `if (this.nudgeTimer) return` gave the whole batch whichever
 * arrived first, so a delegation that settled during a hold waited out the
 * remainder of a wait that was not about it — 25× its own delay, for nothing.
 *
 *   run: node --experimental-strip-types z5-the-nudge-gate-dispose-cleared.mjs [gate|deadlines|oneshot]
 */

const REPO = "/home/claudeuser/qwen3.8-forge";
const { NudgeSchedule } = await import(`${REPO}/vendor/pi-subagents-lite/src/spawn/nudge-schedule.ts`);

const MODES = {
  /** AM5: a background delegation that settles after the teardown. */
  gate: {},
  /** AM6: a fresh completion arriving while a held record's 5 s re-ask is armed. */
  deadlines: {},
  /** The control: it is still a ONE-shot, and a foreground record owes nothing. */
  oneshot: {},
};

const MODE = process.argv[2] ?? "gate";
if (!MODES[MODE]) {
  console.error(`usage: node z5-…mjs <${Object.keys(MODES).join("|")}>`);
  process.exit(2);
}

let failures = 0;
const check = (label, ok) => {
  console.log(`   ${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) failures++;
};

const NUDGE_DELAY_MS = 200;
const COMPACTION_WAIT_MS = 5_000;

/** The teardown as `dispose()` had it: the batch AND the one-shot. */
function retireBefore(schedule) {
  const undelivered = schedule.drain();
  // `backgroundAgentIds.clear()` — the line the fix removes.
  for (const id of ["bg-1", "bg-2", "bg-3"]) schedule.owes(id, 1);
  return undelivered;
}

console.log(`\nz5 [${MODE}] — the nudge gate dispose() cleared, and one timer for two deadlines (AM5, AM6)\n`);

if (MODE === "gate") {
  console.log("   two background delegations are still RUNNING when the session ends.");
  console.log("   The coordinator retires first; the manager ends their runs after it.\n");

  const results = {};
  for (const [label, retire] of Object.entries({ BEFORE: retireBefore, NOW: (s) => s.retire() })) {
    const schedule = new NudgeSchedule();
    schedule.markBackground("bg-1");
    schedule.markBackground("bg-2");
    // One of them had already settled and was queued for the batch.
    schedule.add("bg-3", NUDGE_DELAY_MS, 1_000);
    schedule.markBackground("bg-3");
    schedule.owes("bg-3", 1);

    const queued = retire(schedule);
    // …and now the manager disposes, and the two running runs settle.
    const owed = ["bg-1", "bg-2"].filter((id) => schedule.owes(id, 1));

    results[label] = { queued, owed };
    console.log(`   ${label}`);
    console.log(`     already queued, reported as session-ending : ${queued.length}`);
    console.log(`     settling AFTER the teardown, still owed    : ${owed.length}`);
    console.log(`     …so answers dropped in silence             : ${2 - owed.length}\n`);
  }

  check("BEFORE the queued ones were reported (AI1's half)", results.BEFORE.queued.length === 1);
  check("…and the ones that settled after it were not", results.BEFORE.owed.length === 0);
  check("NOW the queued ones are still reported", results.NOW.queued.length === 1);
  check("…and the late ones reach the session-replaced report too", results.NOW.owed.length === 2);
} else if (MODE === "deadlines") {
  console.log("   a delegation is held for somebody else's compaction and re-asks in");
  console.log("   5 s. A second one settles 100 ms later; nothing is holding IT back.\n");

  const results = {};
  for (const label of ["BEFORE", "NOW"]) {
    const schedule = new NudgeSchedule();
    const held = schedule.add("held", COMPACTION_WAIT_MS, 1_000);
    const fresh = schedule.add("fresh", NUDGE_DELAY_MS, 1_100);
    // BEFORE: `if (this.nudgeTimer) return` — the armed timer always wins.
    const armed = label === "BEFORE" ? null : fresh.armInMs;
    const waitMs = armed === null ? COMPACTION_WAIT_MS - 100 : armed;
    results[label] = { held, armed, waitMs };
    console.log(`   ${label}`);
    console.log(`     timer armed by the held record : ${held.armInMs} ms`);
    console.log(`     re-armed for the fresh one     : ${armed === null ? "no" : `${armed} ms`}`);
    console.log(`     the fresh answer waits         : ${waitMs} ms\n`);
  }

  check("BEFORE a finished delegation waited out an unrelated hold", results.BEFORE.waitMs === 4_900);
  check("NOW it waits its own delay", results.NOW.waitMs === NUDGE_DELAY_MS);
  check("…which is 24.5× less", results.BEFORE.waitMs / results.NOW.waitMs > 24);

  // And the other direction is deliberately unchanged.
  const schedule = new NudgeSchedule();
  schedule.add("fresh", NUDGE_DELAY_MS, 1_000);
  const later = schedule.add("held", COMPACTION_WAIT_MS, 1_050);
  console.log("   the other direction: a re-ask that fires early asks the lock again");
  console.log("   and defers again, which costs one map read.\n");
  check("a longer delay rides the armed timer", later.armInMs === null);
} else {
  const schedule = new NudgeSchedule();
  schedule.markBackground("bg-1");
  console.log("   the control: the gate is a ONE-shot, and a foreground record's first");
  console.log("   settlement owes nothing — the tool result IS its answer.\n");
  check("a background record's first settlement owes a nudge", schedule.owes("bg-1", 1) === true);
  check("…and its second does not", schedule.owes("bg-1", 1) === false);
  check("a foreground record's first settlement owes nothing", schedule.owes("fg-1", 1) === false);
  check("every continuation owes one, for both classes", schedule.owes("fg-1", 2) === true);
  const survived = new NudgeSchedule();
  survived.markBackground("bg-2");
  survived.retire();
  survived.retire();
  check("…and retiring twice does not consume the one-shot", survived.owes("bg-2", 1) === true);
}

console.log(failures === 0 ? "   all expectations held\n" : `   ${failures} expectation(s) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
