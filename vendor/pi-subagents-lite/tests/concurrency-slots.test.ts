/**
 * A concurrency change must not lose the agents that are already running.
 *
 * ## The failure this pins
 *
 * `slotFor()` caches an auto-created slot under a model key when nothing more
 * specific is configured, and a starting run increments `running` on that
 * object. `setLimits()` has to DELETE the slots the new config no longer names —
 * a stale auto-created per-model slot would otherwise shadow a per-provider
 * limit the operator has just added — and it used to throw the running counts
 * away with them. The in-flight agent kept a reference to the dropped object and
 * decremented it where nothing reads it, while a fresh slot reported
 * `running: 0` and let a second subagent start.
 *
 * On this stack that is two children in flight against `PARALLEL_SLOTS=1`, which
 * is the state `default: 1` was measured into existence to prevent.
 *
 * It did not need an actual change to fire: the deletion keys on presence in
 * `config.models`, not on any difference, so re-confirming the limit the
 * operator already had was enough — and every concurrency write in the `/agents`
 * menu comes through here.
 *
 * ## Controls
 *
 * Every case below is paired with the thing the deletion exists for (a
 * per-provider limit taking over from an auto-created per-model slot) and with a
 * release, because a fix that kept the count but released it somewhere else
 * would trade an undercount for a permanent leak.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SlotTable, type SlotHolder } from "../src/agents/concurrency-slots.ts";

const KEY = "forge/qwen3.8-27b";
const OTHER = "forge/qwen3.8-8b";

/** A record in exactly the shape the manager reserves and releases. */
const holder = (modelKey?: string): SlotHolder => ({ execution: { modelKey } });

/** A table with one agent already running on KEY. */
function running(config: { default: number } & Record<string, unknown> = { default: 1 }) {
  const table = new SlotTable(config as never, 1);
  const agent = holder(KEY);
  const all = [agent];
  table.reserve(agent);
  return { table, agent, all };
}

describe("SlotTable — a config change keeps the in-flight agents", () => {
  it("counts a running agent before anything changes (control)", () => {
    const { table } = running();
    assert.deepEqual(table.slotFor(KEY), { limit: 1, running: 1 });
    assert.equal(table.isFull(KEY), true);
  });

  it("keeps counting it when the default is raised", () => {
    const { table, all } = running();
    table.setLimits({ default: 2 }, all);
    assert.equal(table.slotFor(KEY).running, 1, "the agent is still on the provider");
    assert.equal(table.slotFor(KEY).limit, 2, "and the operator's new limit applies");
    assert.equal(table.isFull(KEY), false, "1 of 2 is room for one more, which is what was asked for");
  });

  it("keeps counting it when the limit is re-confirmed unchanged", () => {
    // The sharp one: no change at all, and the old code still dropped the slot.
    const { table, all } = running();
    table.setLimits({ default: 1 }, all);
    assert.equal(table.slotFor(KEY).running, 1);
    assert.equal(table.isFull(KEY), true, "a second spawn must still queue");
  });

  it("keeps counting it when a per-provider limit takes over", () => {
    const { table, all } = running();
    table.setLimits({ default: 1, providers: { forge: 1 } }, all);
    assert.equal(table.slotFor(KEY).running, 1, "the count follows the agent to its new pool");
    assert.equal(table.isFull(KEY), true);
  });

  it("still lets a per-provider limit take over from an auto-created slot (control)", () => {
    // This is what the deletion is FOR. With no running agent, a provider limit
    // of 2 must beat the cached per-model slot at the default of 1.
    const table = new SlotTable({ default: 1 }, 1);
    table.slotFor(KEY); // auto-create and cache
    table.setLimits({ default: 1, providers: { forge: 2 } }, []);
    assert.equal(table.slotFor(KEY).limit, 2, "the stale per-model slot must not shadow the provider limit");
  });

  it("pools two models of one provider onto the provider's count", () => {
    const table = new SlotTable({ default: 1 }, 1);
    const a = holder(KEY);
    const b = holder(OTHER);
    table.reserve(a);
    table.reserve(b);
    assert.equal(table.slotFor(KEY).running, 1, "separate per-model slots before the change");
    assert.equal(table.slotFor(OTHER).running, 1);

    table.setLimits({ default: 1, providers: { forge: 3 } }, [a, b]);
    assert.equal(table.slotFor(KEY), table.slotFor(OTHER), "one shared pool now");
    assert.equal(table.slotFor(KEY).running, 2, "and both agents are in it");
  });
});

describe("SlotTable — release finds the slot the count is on", () => {
  it("releases cleanly after a config change", () => {
    const { table, agent, all } = running();
    table.setLimits({ default: 1, providers: { forge: 1 } }, all);
    table.release(agent);
    assert.equal(table.slotFor(KEY).running, 0, "a release that missed would leave the pool full forever");
    assert.equal(table.isFull(KEY), false);
  });

  it("releases cleanly with no config change (control)", () => {
    const { table, agent } = running();
    table.release(agent);
    assert.equal(table.slotFor(KEY).running, 0);
  });

  it("is idempotent, so a double settle cannot drive the count negative", () => {
    const { table, agent } = running();
    table.release(agent);
    table.release(agent);
    assert.equal(table.slotFor(KEY).running, 0);
    assert.equal(agent.execution.holdsSlot, false);
  });

  it("ignores a holder with no model key at both ends", () => {
    const table = new SlotTable({ default: 1 }, 1);
    const none = holder(undefined);
    table.reserve(none);
    assert.equal(none.execution.holdsSlot, undefined, "nothing was taken, so nothing is held");
    table.release(none);
    assert.equal(table.slotFor(KEY).running, 0);
  });
});

describe("SlotTable — precedence and limits", () => {
  it("prefers per-model over per-provider over the default", () => {
    const table = new SlotTable({ default: 1, providers: { forge: 2 }, models: { [KEY]: 3 } }, 1);
    assert.equal(table.slotFor(KEY).limit, 3, "per-model wins");
    assert.equal(table.slotFor(OTHER).limit, 2, "then per-provider");
    assert.equal(table.slotFor("other/model").limit, 1, "then the default");
  });

  it("shares one object across a provider's models, and not across providers", () => {
    const table = new SlotTable({ default: 1, providers: { forge: 2 } }, 1);
    assert.equal(table.slotFor(KEY), table.slotFor(OTHER));
    assert.notEqual(table.slotFor(KEY), table.slotFor("anthropic/x"));
  });

  it("never allows a limit below one", () => {
    const table = new SlotTable({ default: 0, providers: { forge: 0 } }, 1);
    assert.equal(table.slotFor(KEY).limit, 1, "a zero limit would stall every spawn forever");
  });

  it("falls back to the caller's default when given no config at all", () => {
    assert.equal(new SlotTable(undefined, 1).slotFor(KEY).limit, 1);
  });

  it("an unreadable default keeps the limit already in force, rather than removing it", () => {
    // `this.defaultLimit = config.default` with no guard, then
    // `Math.max(1, undefined)` = NaN, then `running >= NaN` is FALSE for every
    // running count — so an unreadable limit does not become large, it stops
    // existing, and every spawn starts immediately on a one-slot server.
    const table = new SlotTable({ default: 1 }, 1);
    table.setLimits({ default: undefined as unknown as number }, []);
    const slot = table.slotFor(KEY);
    assert.ok(Number.isFinite(slot.limit), "a NaN limit bounds nothing");
    assert.equal(slot.limit, 1);

    const a = holder(KEY);
    table.reserve(a);
    assert.equal(table.isFull(KEY), true, "the bound must still be a bound after a partial config");
  });

  it("an unreadable per-model limit keeps the one already in force", () => {
    const table = new SlotTable({ default: 1, models: { [KEY]: 3 } }, 1);
    table.setLimits({ default: 1, models: { [KEY]: Number.NaN } }, []);
    assert.equal(table.slotFor(KEY).limit, 3);
  });

  it("a per-model limit of 0 is clamped to 1 and KEPT, not deleted", () => {
    // The deletion loop tested truthiness, and `!0` is true — so a limit the
    // operator wrote to mean "stop this model spawning" was applied, clamped to
    // 1, and then deleted in the next loop, falling back to the default.
    const table = new SlotTable({ default: 9 }, 1);
    table.setLimits({ default: 9, models: { [KEY]: 0 } }, []);
    assert.equal(table.slotFor(KEY).limit, 1, "0 clamps to 1 and stays a per-model entry");
  });

  it("control — a model no longer named IS deleted", () => {
    const table = new SlotTable({ default: 9, models: { [KEY]: 2 } }, 1);
    table.setLimits({ default: 9 }, []);
    assert.equal(table.slotFor(KEY).limit, 9, "an entry the new config does not name must go");
  });

  it("control — a readable limit is still applied", () => {
    const table = new SlotTable({ default: 1 }, 1);
    table.setLimits({ default: 5 }, []);
    assert.equal(table.slotFor(KEY).limit, 5);
  });

  it("recounts from the holders, not from whatever the slots said", () => {
    const table = new SlotTable({ default: 4 }, 1);
    const a = holder(KEY);
    const b = holder(KEY);
    table.reserve(a);
    table.reserve(b);
    table.release(b);
    // A hand-corrupted count is repaired by the rebuild, which is the property
    // setLimits depends on.
    table.slotFor(KEY).running = 99;
    table.recount([a, b]);
    assert.equal(table.slotFor(KEY).running, 1, "only the holder that still holds one counts");
  });
});
