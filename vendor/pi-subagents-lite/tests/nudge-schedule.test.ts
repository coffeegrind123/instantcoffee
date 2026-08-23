/**
 * AM5 and AM6 — who is owed a nudge, and when the batch fires.
 *
 * ## AM5 — the one-shot `dispose()` cleared
 *
 * `session_shutdown` runs the coordinator's teardown BEFORE the manager's, and
 * the manager's is what actually ends the runs:
 *
 * ```
 *   getCoordinator()?.dispose();   ← cleared backgroundAgentIds
 *   …
 *   await mgr.dispose();           ← disposes every child session
 *     → each run's .finally → onAgentComplete → the set is empty
 *       and settlementCount is 1  → nothing scheduled, nothing reported
 * ```
 *
 * The eighteenth pass (AI1) fixed the ids that were ALREADY queued and wrote
 * down, correctly, that the `session-replaced` guard "can only fire for a record
 * that settles AFTER the dispose". Those records are what the guard is for, and
 * the clear was the reason none of them could reach it. Every one is a finished
 * delegation whose answer went nowhere with nothing said about it — AC1's rule,
 * inverted:
 *
 * > A delivery that did not happen is the loudest thing this class can report;
 * > it must not be the quietest.
 *
 * ## AM6 — one timer, two deadlines
 *
 * Since AH1 there are two delays through one timer slot: 200 ms to coalesce
 * completions, and 5,000 ms to re-ask after a nudge was held for somebody else's
 * compaction. `if (this.nudgeTimer) return` gave the whole batch whichever
 * arrived first, so a delegation that settled during a hold waited out the
 * remainder of a wait that was not about it.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { NudgeSchedule } from "../src/spawn/nudge-schedule.ts";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** The two delays the coordinator actually uses. */
const NUDGE_DELAY_MS = 200;
const COMPACTION_WAIT_MS = 5_000;

describe("AM5 — a background delegation that settles after the session has gone", () => {
  it("still owes a nudge, so the drop can be reported", () => {
    const nudges = new NudgeSchedule();
    nudges.markBackground("a1");

    // session_shutdown: the coordinator retires before the manager ends the runs.
    nudges.retire();

    // …and the run settles into onAgentComplete afterwards.
    assert.equal(nudges.owes("a1", 1), true, "the one-shot must survive a teardown");
  });

  it("retire() drops the BATCH, which the caller reports itself", () => {
    const nudges = new NudgeSchedule();
    nudges.add("queued-1", NUDGE_DELAY_MS, 1_000);
    nudges.add("queued-2", NUDGE_DELAY_MS, 1_000);

    // AI1: these are reported by `reportDrop("session-ending", …)`.
    assert.deepEqual(nudges.retire().sort(), ["queued-1", "queued-2"]);
    assert.deepEqual(nudges.queued(), [], "and the batch is empty afterwards");
  });

  it("is still a ONE-shot: a second settlement of the same record does not owe twice", () => {
    const nudges = new NudgeSchedule();
    nudges.markBackground("a1");
    assert.equal(nudges.owes("a1", 1), true);
    assert.equal(nudges.owes("a1", 1), false, "the first settlement consumed it");
  });

  it("a foreground record's first settlement owes nothing — the tool result IS the answer", () => {
    const nudges = new NudgeSchedule();
    assert.equal(nudges.owes("f1", 1), false);
  });

  it("every continuation settlement owes one, for both spawn classes", () => {
    const nudges = new NudgeSchedule();
    assert.equal(nudges.owes("f1", 2), true, "the coordinator never observes the steer that caused it");
    assert.equal(nudges.owes("f1", 3), true);
  });

  it("dispose() no longer clears the one-shot", () => {
    const source = readFileSync(join(PACKAGE_ROOT, "src", "spawn", "spawn-coordinator.ts"), "utf8");
    const dispose = source.slice(source.indexOf("  dispose(): void {"));
    const body = dispose.slice(0, dispose.indexOf("\n  }"));
    assert.doesNotMatch(body, /markBackground|\.background\b/, "the background gate is not the batch");
    assert.match(body, /this\.nudges\.retire\(\)/);
  });
});

describe("AM6 — the earliest due time wins", () => {
  it("arms for the first request", () => {
    const nudges = new NudgeSchedule();
    assert.deepEqual(nudges.add("a1", NUDGE_DELAY_MS, 1_000), { armInMs: NUDGE_DELAY_MS });
  });

  it("rides an armed timer that is already due sooner", () => {
    const nudges = new NudgeSchedule();
    nudges.add("a1", NUDGE_DELAY_MS, 1_000);
    // A re-ask 5 s out, while a 200 ms batch is armed: firing early costs one
    // map read and defers again. That direction is deliberately left alone.
    assert.deepEqual(nudges.add("a2", COMPACTION_WAIT_MS, 1_050), { armInMs: null });
  });

  it("re-arms when a SHORTER delay arrives — the finding", () => {
    const nudges = new NudgeSchedule();
    // A record held for somebody else's compaction.
    nudges.add("held", COMPACTION_WAIT_MS, 1_000);
    // A delegation settles 100 ms later. Nothing is holding IT back.
    assert.deepEqual(
      nudges.add("fresh", NUDGE_DELAY_MS, 1_100),
      { armInMs: NUDGE_DELAY_MS },
      "its answer must not wait out the remainder of an unrelated hold",
    );
  });

  it("both ids are still in the same batch", () => {
    const nudges = new NudgeSchedule();
    nudges.add("held", COMPACTION_WAIT_MS, 1_000);
    nudges.add("fresh", NUDGE_DELAY_MS, 1_100);
    assert.deepEqual(nudges.drain().sort(), ["fresh", "held"]);
  });

  it("draining disarms, so the next request arms again", () => {
    const nudges = new NudgeSchedule();
    nudges.add("a1", NUDGE_DELAY_MS, 1_000);
    nudges.drain();
    assert.deepEqual(nudges.add("a2", COMPACTION_WAIT_MS, 1_500), { armInMs: COMPACTION_WAIT_MS });
  });

  it("an id queued twice is queued once", () => {
    const nudges = new NudgeSchedule();
    nudges.add("a1", NUDGE_DELAY_MS, 1_000);
    nudges.add("a1", NUDGE_DELAY_MS, 1_010);
    assert.deepEqual(nudges.drain(), ["a1"]);
  });

  it("the coordinator clears the old timer before arming a shorter one", () => {
    const source = readFileSync(join(PACKAGE_ROOT, "src", "spawn", "spawn-coordinator.ts"), "utf8");
    const fn = source.slice(source.indexOf("private scheduleNudgeIn("));
    const body = fn.slice(0, fn.indexOf("\n  }"));
    // Two timers on one slot would be worse than one late one: the batch would
    // drain twice and the second drain would be empty.
    assert.match(body, /if \(plan\.armInMs === null\) return;/);
    assert.match(body, /if \(this\.nudgeTimer\) clearTimeout\(this\.nudgeTimer\);/);
  });
});
