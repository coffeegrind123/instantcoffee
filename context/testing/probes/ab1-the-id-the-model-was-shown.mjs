/**
 * ab1 — AO1, the identifier every surface publishes and the one the tool accepts.
 *
 * FIXED — both columns are real, and neither is a fixture.
 *
 *   NOW     `resolveAgentId` from `vendor/pi-subagents-lite/src/agents/agent-id.ts`,
 *           which is what `AgentManager.resolveId` calls and what
 *           `executeStopAgentTool` now asks.
 *   BEFORE  `new Map(ids.map(id => [id, record])).get(requested)` — literally
 *           `AgentManager.getRecord`, which is `this.agents.get(id)`, and which
 *           is what `executeStopAgentTool` used to call.
 *
 * `tool-execution.ts` and `agent-manager.ts` both import pi, so neither loads
 * under `node --experimental-strip-types`. What this probe drives instead is the
 * two expressions those files actually contain, quoted below, plus the real
 * resolution module and the real `SHORT_ID_LENGTH`. Ids are minted exactly as
 * `AgentManager.spawn` mints them.
 *
 * The published spellings, all four from the shipped sources:
 *
 * ```
 *   agent-status.ts:33        record.id.slice(0, SHORT_ID_LENGTH)
 *   tool-execution.ts:425     a.id.slice(0, SHORT_ID_LENGTH)        ← the list
 *                                                                     inside the
 *                                                                     REFUSAL
 *   spawn-coordinator.ts:493  record.id.slice(0, SHORT_ID_LENGTH)   ← the
 *                                                                     background
 *                                                                     result
 *   agent-manager.ts:849      record.id.slice(0, SHORT_ID_LENGTH)
 * ```
 *
 *   run: node --experimental-strip-types ab1-the-id-the-model-was-shown.mjs [published|ambiguous|full]
 */

import { randomUUID } from "node:crypto";

const REPO = "/home/claudeuser/qwen3.8-forge";
const SRC = `${REPO}/vendor/pi-subagents-lite/src`;
const { resolveAgentId, ambiguousAgentIdMessage } = await import(`${SRC}/agents/agent-id.ts`);
const { SHORT_ID_LENGTH } = await import(`${SRC}/types.ts`);

/** `agent-manager.ts:49` and `:297`, verbatim. */
const AGENT_ID_PREFIX_LENGTH = 17;
const mintId = () => randomUUID().slice(0, AGENT_ID_PREFIX_LENGTH);

/** What every model-facing surface prints. */
const published = (id) => id.slice(0, SHORT_ID_LENGTH);

/** `AgentManager.getRecord` — the BEFORE column. */
const beforeLookup = (requested, ids) => new Map(ids.map((id) => [id, id])).get(requested);

const MODES = { published: {}, ambiguous: {}, full: {} };
const MODE = process.argv[2] ?? "published";
if (!MODES[MODE]) {
  console.error(`usage: node ab1-…mjs <${Object.keys(MODES).join("|")}>`);
  process.exit(2);
}

let failures = 0;
const check = (label, ok) => {
  console.log(`   ${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) failures++;
};

console.log(`\nab1 [${MODE}] — the id the model was shown, and the id the tool took (AO1)\n`);

if (MODE === "published") {
  const ids = Array.from({ length: 200 }, mintId);
  const one = ids[0];

  console.log(`   an agent id                       ${one}   (${one.length} chars)`);
  console.log(`   what AgentStatus prints for it    ${published(one)}   (${published(one).length} chars)`);
  console.log(`   what the background result names  [Subagent "explore" ${published(one)} completed]`);
  console.log("");

  const beforeHits = ids.filter((id) => beforeLookup(published(id), ids) !== undefined).length;
  const nowHits = ids.filter((id) => resolveAgentId(published(id), ids).kind === "resolved").length;

  console.log(`   over ${ids.length} freshly minted ids, asked with the form that was PUBLISHED:`);
  console.log(`     BEFORE  agents.get(short)      resolved ${beforeHits}/${ids.length}`);
  console.log(`     NOW     resolveAgentId(short)  resolved ${nowHits}/${ids.length}`);
  console.log("");
  console.log(`   and the refusal the model got back, verbatim:`);
  console.log(`     "Agent ${published(one)} not found. Running agents: ${published(ids[1])} (explore), ${published(ids[2])} (general-purpose)"`);
  console.log(`     — three ids in that sentence, none of which the next call would accept.\n`);

  check("BEFORE the published form resolved nothing at all", beforeHits === 0);
  check("NOW every published form resolves to its own record", nowHits === ids.length);
  check(
    "…and to the RIGHT record, not merely to one",
    ids.every((id) => resolveAgentId(published(id), ids).id === id),
  );
} else if (MODE === "ambiguous") {
  // Two records that genuinely share the eight characters the model was shown.
  // Never a silent pick — `resolveType`'s rule, one field over.
  const stem = "abcdefgh";
  const ids = [`${stem}-1111-aaa`, `${stem}-2222-bbb`, mintId()];
  const resolved = resolveAgentId(stem, ids);

  console.log(`   two records share the published form ${stem}`);
  console.log(`     BEFORE  agents.get("${stem}")  → ${String(beforeLookup(stem, ids))}`);
  console.log(`     NOW     resolveAgentId(…)      → ${resolved.kind}`);
  console.log(`   the sentence the model is handed:`);
  console.log(`     "${ambiguousAgentIdMessage(stem, resolved.candidates ?? [], SHORT_ID_LENGTH)}"\n`);

  check("BEFORE it was not-found, same as every other short id", beforeLookup(stem, ids) === undefined);
  check("NOW it is reported as ambiguous rather than picked", resolved.kind === "ambiguous");
  check("…naming both candidates", (resolved.candidates ?? []).length === 2);
} else {
  // The control: the one surface that ever published the full id —
  // `tool-execution.ts:385`, `Agent ID: ${agentId}` — always worked, and still does.
  const ids = Array.from({ length: 50 }, mintId);
  const beforeHits = ids.filter((id) => beforeLookup(id, ids) !== undefined).length;
  const nowHits = ids.filter((id) => resolveAgentId(id, ids).kind === "resolved").length;

  console.log(`   asked with the FULL id, which only the background spawn's own`);
  console.log(`   success message ever published ("Agent ID: <id>"):`);
  console.log(`     BEFORE  ${beforeHits}/${ids.length}`);
  console.log(`     NOW     ${nowHits}/${ids.length}\n`);

  check("the full id worked before", beforeHits === ids.length);
  check("…and still does — the exact rung runs first", nowHits === ids.length);
  check(
    "which is why this survived twenty-three passes: the one path with the full id was fine",
    beforeHits === nowHits,
  );
}

console.log("");
process.exit(failures === 0 ? 0 : 1);
