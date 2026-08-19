/**
 * H6 probe — S6: does changing concurrency from the /agents menu make the
 * currently running subagent invisible to the limit?
 *
 * `getSlot()` caches an auto-created slot under the model key when nothing more
 * specific exists, and a starting run increments `running` on that object.
 * `setConcurrency()` then deletes every model slot whose key is absent from the
 * new `config.models` — which is every auto-created one — and the next
 * `getSlot()` builds a fresh slot with `running: 0`.
 *
 * The deletion is not optional: a stale auto-created per-model slot would shadow
 * a per-provider limit the operator has just added. What was missing is putting
 * the running counts back afterwards. `setConcurrency()` now calls
 * `recountRunningSlots()`, which re-derives every count from the records that
 * hold a slot (`execution.holdsSlot`), and `releaseSlot()` looks the slot up
 * rather than using one captured at reservation time — so an agent that started
 * under a per-model slot and finishes under a per-provider one is counted and
 * released in the same place.
 *
 * The record below is registered through the manager's own map and reserved
 * through the manager's own SlotTable, which is exactly what `startAgent()` does
 * with it, so the bookkeeping under test is entirely the real thing.
 *
 * Run: node h6-concurrency-slot-orphaned.mjs
 */

import { createJiti } from "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";
const PI = "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
const jiti = createJiti(`file://${PI}`, { interopDefault: true, alias: { "@earendil-works/pi-coding-agent": PI } });
const R = "/home/claudeuser/qwen3.8-forge/vendor/pi-subagents-lite/src";

const am = await jiti.import(`${R}/agents/agent-manager.ts`);
const io = await jiti.import(`${R}/config/config-io.ts`);

const KEY = "forge/qwen3.8-27b";

/** A record in exactly the state startAgent leaves one in: holding a slot. */
function runningRecord(id, modelKey) {
  return {
    id,
    lifecycle: { status: "running", startedAt: Date.now(), started: true },
    display: { type: "general-purpose" },
    execution: { modelKey, holdsSlot: true, settled: false, settlementCount: 0 },
    stats: { lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 }, toolUses: 0, turnCount: 1, compactionCount: 0 },
  };
}

/**
 * Slots are live objects and every step below mutates them, so each observation
 * is snapshotted at the moment it is taken. Reading the reference at the end
 * reports the last state three times over — which is how the first version of
 * this probe managed to show the fix failing.
 */
const snap = (mgr) => {
  const slot = mgr.getSlot(KEY);
  return { limit: slot.limit, running: slot.running, queues: slot.running >= slot.limit };
};
const show = (s) => `{"limit":${s.limit},"running":${s.running}} -> a second spawn ${s.queues ? "QUEUES" : "STARTS"}`;

function scenario(label, newConfig) {
  const mgr = new am.AgentManager(undefined, { ...io.DEFAULT_CONCURRENCY });

  // A subagent starts: the manager caches a slot for its model key and takes it.
  const record = runningRecord("a1", KEY);
  mgr.agents.set(record.id, record);
  mgr.slots.reserve(record);
  const before = snap(mgr);

  mgr.setConcurrency(newConfig);
  const after = snap(mgr);

  // And the agent finishes, on whatever slot now serves its model key.
  mgr.slots.release(record);
  const released = snap(mgr);

  console.log(`\n--- ${label} ---`);
  console.log("  config applied              :", JSON.stringify(newConfig));
  console.log("  slot while it runs          :", show(before));
  console.log("  slot after the config change:", show(after));
  console.log("  the running agent is still counted :", after.running > 0);
  console.log("  after it settles            :", `running ${released.running}`, released.running === 0 ? "(clean)" : "** LEAKED **");
  if (!after.queues && after.running === 0) {
    console.log("  ** the in-flight subagent is invisible to the limit **");
  }
  mgr.agents.clear();
  mgr.dispose();
}

console.log("=== H6: what a concurrency change does to an already-running subagent ===");
console.log("(DEFAULT_CONCURRENCY = " + JSON.stringify(io.DEFAULT_CONCURRENCY) + ")");

scenario("operator raises the default to 2 from the /agents menu", { default: 2 });
scenario("operator RE-CONFIRMS the same default of 1", { default: 1 });
scenario("operator sets a per-provider limit of 1", { default: 1, providers: { forge: 1 } });
scenario("control — a per-MODEL entry always kept its slot alive", { default: 1, models: { [KEY]: 1 } });

console.log(`
Before the fix, the first three printed "the in-flight subagent is invisible to
the limit": a fresh slot with running: 0 while the child was still on the
provider. The second is the sharp one — setting the limit to the value it
already had was enough, because the deletion loop keys on presence in
config.models, not on any change, and every concurrency write in the /agents
menu comes through setConcurrency().

The "after it settles" line is the other half: the release has to find the slot
the count was rebuilt onto, or the fix would trade an undercount for a leak.
`);
