/**
 * AH1 — the third sender reads the lock too.
 *
 * The fifteenth pass built `__PI_COMPACTION_IN_FLIGHT__` because two extensions
 * could call `ctx.compact()` on one `agent_settled`. The sixteenth found that the
 * same flag answers a different question for a different party — *may I start a
 * turn right now* — and wired it into `pi-loop-mode`'s `sendLoopTurn` (AG2) and
 * `prinny-channel`'s empty-turn continuation (AG3), leaving the residue it
 * recorded in its own handoff:
 *
 *   > `compactionInFlight()` now has four readers, and there is no test that a
 *   > fifth would be noticed. … "who else should be asking this" is exactly the
 *   > question that produced AG2 and AG3, and it will produce another one the
 *   > next time a sender is added.
 *
 * There was no next time: the third sender already existed.
 * `SpawnCoordinator.emitIndividualNudge` delivers a finished BACKGROUND
 * subagent's answer with `pi.sendMessage(…, { triggerTurn: true })`, which is
 * `sendCustomMessage`, whose `triggerTurn` branch is `_runAgentPrompt` and checks
 * nothing. It is also the sender with the least to fall back on: the loop
 * reschedules the same iteration and prinny tells the sender to ask again, while
 * this one runs ONCE per record, on a record that has already settled.
 *
 * Two things are asserted here, and the second is the one that would catch a
 * fourth sender: the three copies of the protocol agree, and the coordinator asks
 * before it sends.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeEach, describe, it } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { COMPACTION_LOCK_KEY, STALE_MS, compactionInFlight } from "../src/spawn/compaction-lock.ts";
import { describeNudgeHold } from "../src/spawn/nudge-drop.ts";
import * as loop from "../../pi-loop-mode/src/compaction-lock.ts";
import * as prinny from "../../prinny-channel/src/compaction-lock.ts";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

describe("the compaction lock, read from this package", () => {
  beforeEach(() => {
    loop.resetCompactionLock();
  });

  it("is free to begin with", () => {
    assert.equal(compactionInFlight(), undefined);
  });

  it("sees a hold taken by either of the other two, and names the holder", () => {
    loop.beginCompaction(loop.LOOP_OWNER);
    assert.equal(compactionInFlight()?.owner, "pi-loop-mode");
    loop.endCompaction(loop.LOOP_OWNER);
    assert.equal(compactionInFlight(), undefined);

    prinny.beginCompaction(prinny.PRINNY_OWNER);
    assert.equal(compactionInFlight()?.owner, "prinny-channel");
    prinny.endCompaction(prinny.PRINNY_OWNER);
    assert.equal(compactionInFlight(), undefined);
  });

  it("expires on the same bound, so a lost release costs one wait and not the answer", () => {
    const t0 = 1_000_000;
    loop.beginCompaction(loop.LOOP_OWNER, t0);
    assert.equal(compactionInFlight(t0 + STALE_MS - 1)?.owner, "pi-loop-mode");
    assert.equal(compactionInFlight(t0 + STALE_MS), undefined);
  });

  it("reads a global of an unknown shape as FREE rather than throwing", () => {
    // A malformed global must not be the reason a finished delegation's answer is
    // never delivered — this runs on the one path that has no second attempt.
    (globalThis as unknown as Record<string, unknown>)[COMPACTION_LOCK_KEY] = "held";
    assert.equal(compactionInFlight(), undefined);
    (globalThis as unknown as Record<string, unknown>)[COMPACTION_LOCK_KEY] = { owner: 5, at: "now" };
    assert.equal(compactionInFlight(), undefined);
  });
});

describe("the three implementations agree", () => {
  it("on the key and the bound", () => {
    assert.equal(loop.COMPACTION_LOCK_KEY, COMPACTION_LOCK_KEY);
    assert.equal(prinny.COMPACTION_LOCK_KEY, COMPACTION_LOCK_KEY);
    assert.equal(loop.STALE_MS, STALE_MS);
    assert.equal(prinny.STALE_MS, STALE_MS);
  });

  it("and this one is genuinely a third module, not a cross-vendor import", () => {
    const source = readFileSync(join(PACKAGE_ROOT, "src", "spawn", "compaction-lock.ts"), "utf8");
    assert.doesNotMatch(source, /from ["'].*pi-loop-mode/, "this package must not import that one");
    assert.doesNotMatch(source, /from ["'].*prinny-channel/, "nor that one");
  });

  it("and this copy is read-only, because nothing here compacts", () => {
    // Shipping begin/end would invite a caller to take a lock this package has
    // no compaction to release, and a latched lock holds every later answer.
    const source = readFileSync(join(PACKAGE_ROOT, "src", "spawn", "compaction-lock.ts"), "utf8");
    assert.doesNotMatch(source, /export function beginCompaction/);
    assert.doesNotMatch(source, /export function endCompaction/);
    const pkg = readFileSync(join(PACKAGE_ROOT, "src", "spawn", "spawn-coordinator.ts"), "utf8");
    assert.doesNotMatch(pkg, /beginCompaction|endCompaction/);
  });
});

describe("AH1 — the wiring", () => {
  const source = readFileSync(join(PACKAGE_ROOT, "src", "spawn", "spawn-coordinator.ts"), "utf8");
  const fn = source.slice(source.indexOf("private emitIndividualNudge"));
  const body = fn.slice(0, fn.indexOf("\n  }\n"));

  it("asks who is compacting before it sends", () => {
    const asked = body.indexOf("const holder = compactionInFlight();");
    const sent = body.indexOf("pi.sendMessage(");
    assert.ok(asked > 0, "emitIndividualNudge must read the lock");
    assert.ok(sent > 0, "…and this is still the function that sends");
    assert.ok(asked < sent, "the read must come first");
  });

  it("asks before it CAPS, because the cap is sized against the window", () => {
    // `capBackgroundResult` reads `ctx.getContextUsage()`, which during a
    // compaction still reports the pre-compaction window. Waiting first also
    // measures the context the result will actually land in.
    const asked = body.indexOf("const holder = compactionInFlight();");
    const capped = body.indexOf("capBackgroundResult(");
    assert.ok(capped > 0);
    assert.ok(asked < capped);
  });

  it("defers rather than dropping — the answer is not lost, it is late", () => {
    assert.match(body, /this\.scheduleNudgeIn\(agentId, COMPACTION_WAIT_MS\);\s*\n\s*return;/);
    // And a drop would have gone through reportDrop, which says the opposite.
    const held = body.slice(body.indexOf("const holder = compactionInFlight();"));
    const untilReturn = held.slice(0, held.indexOf("return;"));
    assert.doesNotMatch(untilReturn, /reportDrop/, "a held result must not be reported as a dropped one");
  });

  it("says who is holding it, once, whether or not there is a UI", () => {
    assert.match(body, /console\.warn/);
    assert.match(body, /this\.heldForCompaction\.has\(agentId\)/);
    assert.match(body, /this\.heldForCompaction\.delete\(agentId\)/);
  });
});

describe("describeNudgeHold", () => {
  it("reads as held, not as dropped, and names the holder", () => {
    const hold = describeNudgeHold("pi-loop-mode", "abc12345", "Explore");
    assert.match(hold.log, /holding the result/);
    assert.match(hold.log, /pi-loop-mode is compacting/);
    assert.match(hold.notice, /result held/);
    assert.match(hold.notice, /pi-loop-mode/);
    assert.match(hold.notice, /will be delivered/);
    // The drop sentences tell an operator where to go and read an answer that is
    // not coming. This one must not, because it IS coming.
    assert.doesNotMatch(hold.notice, /NOT delivered/);
    assert.doesNotMatch(hold.notice, /View result/);
  });

  it("survives a record with no type, like the drop sentences do", () => {
    assert.match(describeNudgeHold("prinny-channel", "abc12345").notice, /\[Subagent abc12345\]/);
  });
});
