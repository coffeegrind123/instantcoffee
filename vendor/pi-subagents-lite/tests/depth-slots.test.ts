/**
 * Nested spawns get their own concurrency pool per depth.
 *
 * With SUBAGENT_MAX_DEPTH=2 a child can spawn grandchildren, and it WAITS for
 * them: the child's tool is foreground-only, so the child's run — and the slot
 * it holds — stays open until its grandchildren answer. If grandchildren drew
 * from the same pool, a full pool of waiting children would queue every
 * grandchild behind slots that only free when those grandchildren finish. That
 * is a deadlock, not a slowdown, and it needs nothing more exotic than every
 * child delegating at once.
 *
 * A pool per depth cannot deadlock: the deepest agents never wait on anything,
 * so their pool always drains, and each shallower pool drains behind it.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DepthSlotTables, SlotTable, type SlotHolder } from "../src/agents/concurrency-slots.ts";

const KEY = "deepseek/deepseek-flash";
const CONFIG = { default: 1, providers: { deepseek: 2 } };

function holder(depth?: number): SlotHolder {
  return { execution: { modelKey: KEY, ...(depth === undefined ? {} : { depth }) } };
}

describe("DepthSlotTables", () => {
  it("control — one shared pool deadlocks: two waiting children leave no room for a grandchild", () => {
    const shared = new SlotTable(CONFIG, 1);
    shared.reserve(holder(1));
    shared.reserve(holder(1));
    assert.equal(shared.isFull(KEY), true, "the grandchild would queue behind its own waiting parents");
  });

  it("gives depth 2 its own pool with the same limits", () => {
    const pools = new DepthSlotTables(CONFIG, 1);
    pools.reserve(holder(1));
    pools.reserve(holder(1));
    assert.equal(pools.isFull(KEY, 1), true);
    assert.equal(pools.isFull(KEY, 2), false);
    assert.equal(pools.slotFor(KEY, 2).limit, 2);
  });

  it("releases into the pool the holder was counted in", () => {
    const pools = new DepthSlotTables(CONFIG, 1);
    const grandchild = holder(2);
    pools.reserve(grandchild);
    pools.reserve(holder(2));
    assert.equal(pools.isFull(KEY, 2), true);
    pools.release(grandchild);
    assert.equal(pools.isFull(KEY, 2), false);
    assert.equal(pools.slotFor(KEY, 1).running, 0, "depth 1 was never touched");
  });

  it("treats a holder with no depth as depth 1 — every record from before this change", () => {
    const pools = new DepthSlotTables(CONFIG, 1);
    pools.reserve(holder());
    assert.equal(pools.slotFor(KEY, 1).running, 1);
    assert.equal(pools.slotFor(KEY, 2).running, 0);
  });

  it("applies a new config to every depth, and recounts each from its own holders", () => {
    const pools = new DepthSlotTables(CONFIG, 1);
    const a = holder(1);
    const b = holder(2);
    pools.reserve(a);
    pools.reserve(b);
    pools.setLimits({ default: 1, providers: { deepseek: 5 } }, [a, b]);
    assert.equal(pools.slotFor(KEY, 1).limit, 5);
    assert.equal(pools.slotFor(KEY, 2).limit, 5);
    assert.equal(pools.slotFor(KEY, 1).running, 1);
    assert.equal(pools.slotFor(KEY, 2).running, 1);
  });

  it("a depth first seen after a config change starts with that change", () => {
    const pools = new DepthSlotTables(CONFIG, 1);
    pools.setLimits({ default: 1, providers: { deepseek: 7 } }, []);
    assert.equal(pools.slotFor(KEY, 2).limit, 7);
  });
});
