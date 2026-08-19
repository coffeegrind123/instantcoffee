/**
 * §11.12, closed — two extensions cannot compact the same session at once.
 *
 * `pi-loop-mode`'s `agent_settled` handler runs FIRST and may ask for an
 * emergency compaction; `prinny-channel`'s runs SECOND and may drain a `/compact`
 * a Matrix sender asked for mid-turn (AD3). pi's `compact()` does not refuse a
 * second call — `await this.abort()` is its first statement and it overwrites
 * `_compactionAbortController` — so the second call cancels the first one's work.
 *
 * Recorded by the fourteenth pass as §11.7 and by the fifteenth as §11.12, closed
 * by neither, because the fix is a flag NEITHER PACKAGE CAN OWN. The protocol is
 * `src/compaction-lock.ts` in each package over one `globalThis` key — the same
 * arrangement `shell.ts` uses to publish `__PI_SUBAGENT_SPAWN_DEPTH__`, and for
 * the same reason: vendor packages must not import each other.
 *
 * This suite therefore does the one thing the shipped code must not: it imports
 * BOTH copies and drives them against each other. Two duplicated
 * implementations are only as good as the assertion that they agree, which is the
 * arrangement `stateDir()` already has in `prinny-channel/src/config.ts` and
 * `server/src/state.ts`.
 *
 * Executed end to end, through both real extensions in one process, in
 * `context/testing/probes/s5-two-extensions-one-compaction.mjs`.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeEach, describe, it } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  COMPACTION_LOCK_KEY,
  LOOP_OWNER,
  STALE_MS,
  beginCompaction,
  compactionInFlight,
  endCompaction,
  resetCompactionLock,
} from "../src/compaction-lock.ts";
import * as prinny from "../../prinny-channel/src/compaction-lock.ts";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

describe("the compaction lock", () => {
  beforeEach(() => {
    resetCompactionLock();
  });

  it("is free to begin with", () => {
    assert.equal(compactionInFlight(), undefined);
  });

  it("hands the lock to the first asker and refuses the second", () => {
    assert.equal(beginCompaction(LOOP_OWNER), true);
    assert.equal(beginCompaction("somebody-else"), false);
    assert.equal(compactionInFlight()?.owner, LOOP_OWNER);
  });

  it("is re-entrant for the same owner", () => {
    // Two call sites in this package ask — the context ladder and the stuck
    // ladder — and they are 450 lines apart. Refusing our own second ask would
    // turn a harmless double request into a stall.
    assert.equal(beginCompaction(LOOP_OWNER), true);
    assert.equal(beginCompaction(LOOP_OWNER), true);
  });

  it("only the owner can release it", () => {
    beginCompaction(LOOP_OWNER);
    endCompaction("somebody-else");
    assert.equal(compactionInFlight()?.owner, LOOP_OWNER, "a non-owner's release must do nothing");
    endCompaction(LOOP_OWNER);
    assert.equal(compactionInFlight(), undefined);
  });

  it("releasing a lock nobody holds is harmless", () => {
    endCompaction(LOOP_OWNER);
    assert.equal(compactionInFlight(), undefined);
  });

  it("expires, so a lost release costs one wait and not the session", () => {
    // pi's ctx.compact always calls back (its wrapper is a try/catch around
    // `this.compact()`), so this is a backstop rather than the expected path —
    // for a process that outlives its session, or a future pi that changes it.
    const t0 = 1_000_000;
    beginCompaction(LOOP_OWNER, t0);
    assert.equal(compactionInFlight(t0 + STALE_MS - 1)?.owner, LOOP_OWNER, "still held just inside the bound");
    assert.equal(compactionInFlight(t0 + STALE_MS), undefined, "and absent at it");
    assert.equal(beginCompaction("somebody-else", t0 + STALE_MS), true, "so somebody else can take it");
  });

  it("ignores a global somebody else wrote", () => {
    // The key is a plain global: anything in the process can write it, and a
    // shape this module does not recognise must read as "free" rather than throw
    // in the middle of a context recovery.
    (globalThis as unknown as Record<string, unknown>)[COMPACTION_LOCK_KEY] = "held";
    assert.equal(compactionInFlight(), undefined);
    (globalThis as unknown as Record<string, unknown>)[COMPACTION_LOCK_KEY] = { owner: 5, at: "now" };
    assert.equal(compactionInFlight(), undefined);
    assert.equal(beginCompaction(LOOP_OWNER), true, "and the lock is still usable afterwards");
  });
});

describe("the two implementations agree", () => {
  beforeEach(() => {
    resetCompactionLock();
  });

  it("on the key and the bound", () => {
    assert.equal(prinny.COMPACTION_LOCK_KEY, COMPACTION_LOCK_KEY);
    assert.equal(prinny.STALE_MS, STALE_MS);
  });

  it("and are genuinely two modules, not one import", () => {
    // If this ever becomes false the duplication has been replaced by a
    // cross-vendor import, which is the thing the protocol exists to avoid.
    const source = readFileSync(join(PACKAGE_ROOT, "src", "compaction-lock.ts"), "utf8");
    assert.doesNotMatch(source, /from ["'].*prinny-channel/, "this package must not import that one");
    assert.notEqual(prinny.LOOP_OWNER, LOOP_OWNER, "the other copy has its own owner name");
    assert.equal(prinny.PRINNY_OWNER, "prinny-channel");
  });

  it("so one package's hold really does refuse the other", () => {
    assert.equal(beginCompaction(LOOP_OWNER), true);
    assert.equal(prinny.beginCompaction(prinny.PRINNY_OWNER), false, "prinny must see our hold");
    assert.equal(prinny.compactionInFlight()?.owner, LOOP_OWNER);
    endCompaction(LOOP_OWNER);
    assert.equal(prinny.beginCompaction(prinny.PRINNY_OWNER), true, "and take it once we release");
    assert.equal(compactionInFlight()?.owner, prinny.PRINNY_OWNER, "which we then see");
    prinny.endCompaction(prinny.PRINNY_OWNER);
  });
});

describe("§11.12 — the wiring", () => {
  const source = readFileSync(join(PACKAGE_ROOT, "extensions", "index.ts"), "utf8");

  it("the context ladder adopts another extension's compaction rather than racing it", () => {
    const fn = source.slice(source.indexOf("function requestEmergencyCompaction"));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    const checked = body.indexOf("const holder = compactionInFlight();");
    const asked = body.indexOf("ctx.compact({");
    assert.ok(checked > 0, "it asks whether somebody is already compacting");
    assert.ok(checked < asked, "…before it asks pi to compact");
    assert.match(body, /finishContextRecovery\(pi, ctx, reason, `\$\{holder\.owner\} was already compacting/);
    assert.match(body, /beginCompaction\(LOOP_OWNER\)/);
    // Released on all three paths pi can take: onComplete, onError, and the
    // synchronous throw out of a stale runtime.
    assert.equal((body.match(/endCompaction\(LOOP_OWNER\)/g) ?? []).length, 3);
  });

  it("the stuck ladder waits for it instead of asking again", () => {
    const fn = source.slice(source.indexOf("async function interveneStuck"));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    const checked = body.indexOf("const holder = compactionInFlight();");
    const asked = body.indexOf("ctx.compact({");
    assert.ok(checked > 0 && checked < asked);
    // The rung wants the WINDOW cleared, and somebody else's compaction clears
    // the same window — so the rung is spent and the turn is still scheduled.
    assert.match(body, /is already compacting — waiting for that instead of asking again/);
    assert.match(body, /scheduleLoopTurn\(pi, "stuck", delayMs\);\s*\n\s*return;/);
    assert.equal((body.match(/endCompaction\(LOOP_OWNER\)/g) ?? []).length, 3);
  });
});
