/**
 * r2 — AE6. The subagent model override, and the two names it is keyed on.
 * FIXED — this probe prints BEFORE and NOW side by side.
 *
 * AD1 (thirteenth pass) made `executeAgentTool` read the model
 * `toolCallListener` injects, which closed a six-level precedence that was being
 * resolved and discarded. That fix is correct and it is also a new mechanism:
 * the listener's answer is now the one the spawn OBEYS, so the key the listener
 * resolves it against is the key the whole precedence hangs on.
 *
 * The two ends were keyed differently:
 *
 *   toolCallListener   `input.agent` verbatim — the string the MODEL wrote —
 *                      against the registry as it stands when the call is
 *                      announced.
 *   executeAgentTool   `resolveTypeWithDiscovery()` — the CANONICAL registered
 *                      name, after a filesystem re-scan that can register agents
 *                      the listener could not see.
 *
 * Both differences are reachable:
 *
 *   1. `resolveType` is deliberately case-insensitive — it exists so a spawn by
 *      a slightly-wrong name still works — but `resolveModel` reads a per-type
 *      override as `sessionOverrides[type]` / `config.agent[type]`, and
 *      `/agents` → models writes those keys from `getAllTypes()`, i.e. under the
 *      canonical name. So `agent: "explore"` spawned the right agent on the
 *      wrong model, and `renderAgentToolCall` printed the wrong one beside the
 *      call — the display agreed with the miss, which is why it would not have
 *      been noticed.
 *
 *   2. An agent that only becomes resolvable on the DISCOVERY retry — added to
 *      the filesystem after startup, or living in a worktree's `.pi/agents/`,
 *      which is the case that retry exists for — has no config at listener time.
 *      `resolveModel` falls past its frontmatter rung to `parentModelId`, the
 *      tool honours that, and `agent-runner`'s own
 *      `options.model ?? findModelInRegistry(agentConfig?.model, …)` cannot
 *      rescue it because the tool always supplies the left side. That is AD1's
 *      damage exactly — the child on the parent's model, holding the parent's
 *      concurrency slot — restored for one class of agent.
 *
 * The control in both blocks is the same delegation by its exact registered
 * name, which must be unaffected in either column.
 *
 *   run: node r2-the-name-the-override-is-keyed-on.mjs
 */

import { createJiti } from "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";

const PI = "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
const NM = "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works";
const jiti = createJiti(`file://${PI}`, {
  interopDefault: true,
  alias: { "@earendil-works/pi-coding-agent": PI, "@earendil-works/pi-tui": `${NM}/pi-tui` },
});
const R = "/home/claudeuser/qwen3.8-forge/vendor/pi-subagents-lite/src";

const shell = await jiti.import(`${R}/shell.ts`);
const { executeAgentTool, toolCallListener } = await jiti.import(`${R}/agents/tool-execution.ts`);
const agentTypes = await jiti.import(`${R}/agents/agent-types.ts`);
const { renderAgentToolCall } = await jiti.import(`${R}/ui/renderer.ts`);

let failures = 0;
const check = (label, ok) => {
  console.log(`   ${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) failures++;
};

const PARENT = { provider: "forge", id: "qwen3.8-27b", name: "qwen3.8-27b", contextWindow: 32768 };
const SMALL = { provider: "forge", id: "qwen3-4b", name: "qwen3-4b", contextWindow: 32768 };
const registry = { find: (provider, id) => [PARENT, SMALL].find((m) => m.provider === provider && m.id === id) };
const theme = { fg: (_k, s) => s, bold: (s) => s };

/** The Explore agent as an author would ship it: a small model in its frontmatter. */
const EXPLORE = new Map([
  [
    "Explore",
    { name: "Explore", description: "read-only search", model: "forge/qwen3-4b", thinkingLevel: "high", prompt: "e" },
  ],
]);

function harness() {
  const spawned = [];
  shell.setPiInstance({ sendMessage() {}, exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }) });
  // The store is a module singleton, so the session layer outlives a harness.
  shell.getStore().mutate.session.clearAll();
  shell.setCoordinator({
    spawn: async (_pi, _ctx, intent) => {
      spawned.push(intent);
      return {
        agentId: "agent-0123456789ab",
        record: {
          id: "agent-0123456789ab",
          result: "done",
          lifecycle: { status: "completed", startedAt: 1, completedAt: 2, started: true },
          display: { type: intent.type, description: intent.description, invocation: intent.invocation },
          execution: {},
          stats: {
            lifetimeUsage: { input: 1, output: 1, cacheWrite: 0, cost: 0 },
            toolUses: 0,
            turnCount: 1,
            compactionCount: 0,
            maxTurns: intent.maxTurns,
          },
        },
      };
    },
  });
  const ctx = {
    cwd: "/home/claudeuser/qwen3.8-forge",
    model: PARENT,
    modelRegistry: registry,
    ui: { notify() {} },
    isIdle: () => true,
    getContextUsage: () => ({ tokens: 100, contextWindow: 32768, percent: 1 }),
  };
  shell.setSessionCtx(ctx);
  return { ctx, spawned, store: shell.getStore() };
}

/**
 * One delegation, through the REAL listener and the REAL tool.
 *
 * `column === "BEFORE"` reproduces the thirteenth pass's pair exactly: the
 * listener keyed on the raw `input.agent`, and the tool read whatever it found on
 * `params.model` with no question about what it had been resolved against. Both
 * are re-created here by editing the args between the two calls, so the shipped
 * functions run in both columns.
 */
async function delegate(column, agentName, { pin, hideUntilDiscovery } = {}) {
  const { ctx, spawned, store } = harness();
  agentTypes.registerAgents(hideUntilDiscovery ? new Map() : EXPLORE, { disableDefaultAgents: true });
  if (pin) store.mutate.session.setOverride("Explore", "forge/qwen3.8-27b");

  // What the OLD listener would have injected, computed here because here is
  // when it ran: the RAW name the model wrote, against the registry as it stands
  // before `executeAgentTool`'s discovery retry.
  const oldConfig = agentTypes.getAgentConfig(agentName);
  const oldModel = store.modelFor(agentName, `${PARENT.provider}/${PARENT.id}`, oldConfig) || undefined;
  const oldThinking = oldConfig?.thinkingLevel ?? store.agent.defaultThinking;

  const params = { prompt: "map the parser", description: "map", agent: agentName, run_in_background: false };
  await toolCallListener({ toolName: "Agent", toolCallId: "call-1", input: params }, ctx);
  let rendered = params._modelOverride;

  if (column === "BEFORE") {
    params.model = oldModel;
    params.thinking = oldThinking;
    // AD1's tool read `params.model` unconditionally, with no question about the
    // key it had been resolved against. In the shipped code that is exactly the
    // branch taken when the stamp names the type being spawned, so setting it is
    // how the old tool is reproduced without a second copy of the function.
    params._resolvedAgent = "Explore";
    rendered = oldModel ? oldModel.slice(oldModel.indexOf("/") + 1) : undefined;
  }

  // Discovery: the retry inside executeAgentTool re-scans and finds the agent.
  // Modelled by registering it between the two calls, which is what a re-scan
  // does to this module's registry.
  if (hideUntilDiscovery) agentTypes.registerAgents(EXPLORE, { disableDefaultAgents: true });

  await executeAgentTool("call-1", params, undefined, undefined, ctx);
  const intent = spawned[0];
  return {
    rendered,
    ran: intent?.model ? `${intent.model.provider}/${intent.model.id}` : "(none)",
    slot: intent?.modelKey,
    thinking: intent?.thinkingLevel,
    type: intent?.type,
  };
}

const row = (label, before, now) => console.log(`   ${label.padEnd(40)}${String(before).padEnd(22)}${now}`);

console.log("\nr2 — the name the subagent model override is keyed on\n");

// ── 1. The two ends, and which key each uses ─────────────────────────────────
{
  harness();
  agentTypes.registerAgents(EXPLORE, { disableDefaultAgents: true });
  console.log("   resolveType('explore')                     :", JSON.stringify(agentTypes.resolveType("explore")));
  console.log(
    "   getAllTypes() — what /agents writes keys as:",
    JSON.stringify(agentTypes.getAllTypes()),
  );
  check(
    "a lower-cased name spawns the canonical agent — that is the point of resolveType",
    agentTypes.resolveType("explore").key === "Explore",
  );
}

// ── 2. An operator pin, and a spawn that differs from the menu only in case ──
{
  console.log("\n   an operator pins Explore to the big model in /agents → models\n");
  console.log("                                           BEFORE                NOW");
  const beforeExact = await delegate("BEFORE", "Explore", { pin: true });
  const nowExact = await delegate("NOW", "Explore", { pin: true });
  row("control — agent:'Explore' runs on", beforeExact.ran, nowExact.ran);

  const before = await delegate("BEFORE", "explore", { pin: true });
  const now = await delegate("NOW", "explore", { pin: true });
  row("agent:'explore' runs on", before.ran, now.ran);
  row("…and holds the slot", before.slot, now.slot);
  row("…and the TUI printed", `▸ Explore (${before.rendered})`, `▸ Explore (${now.rendered})`);
  console.log("");

  check("control: the exact name obeyed the pin in both columns", beforeExact.ran === nowExact.ran);
  check("BEFORE: the pin was skipped for a case-different name", before.ran === "forge/qwen3-4b");
  check("NOW: the pin is obeyed", now.ran === "forge/qwen3.8-27b");
  check("NOW: and the call line says the same thing the spawn did", now.rendered === "qwen3.8-27b");
  check("BEFORE: the call line agreed with the miss, which is why nobody saw it", before.rendered === "qwen3-4b");
}

// ── 3. An agent the listener cannot see, found by the discovery retry ────────
{
  console.log("   an agent that only the discovery retry can resolve\n");
  console.log("                                           BEFORE                NOW");
  const before = await delegate("BEFORE", "Explore", { hideUntilDiscovery: true });
  const now = await delegate("NOW", "Explore", { hideUntilDiscovery: true });
  row("the child runs on", before.ran, now.ran);
  row("…and holds the slot", before.slot, now.slot);
  row("…and thinks at", before.thinking, now.thinking);
  console.log("");

  check("BEFORE: the agent's own model: frontmatter was dropped for the parent's", before.ran === "forge/qwen3.8-27b");
  check("NOW: the frontmatter is honoured", now.ran === "forge/qwen3-4b");
  check("NOW: and it holds a slot of its own", now.slot === "forge/qwen3-4b");
  check("thinking survived in both columns here (no operator default is set)", before.thinking === "high");
}

// ── 4. The control that matters most: nothing changed for the ordinary spawn ─
{
  const before = await delegate("BEFORE", "Explore");
  const now = await delegate("NOW", "Explore");
  console.log(`   control — a plain delegation by its exact name: BEFORE ${before.ran}, NOW ${now.ran}`);
  check("the common path is byte-identical in both columns", before.ran === now.ran && before.ran === "forge/qwen3-4b");
  check("…and it is still the frontmatter override, not the parent's model", now.ran !== "forge/qwen3.8-27b");
}

// ── 5. AD1's own control, still true: the listener's write reaches params ────
{
  const { ctx, spawned } = harness();
  agentTypes.registerAgents(EXPLORE, { disableDefaultAgents: true });
  const params = { prompt: "p", description: "d", agent: "Explore", run_in_background: false };
  await toolCallListener({ toolName: "Agent", toolCallId: "call-9", input: params }, ctx);
  console.log(`\n   the listener stamps the key it resolved on: _resolvedAgent = ${params._resolvedAgent}`);
  console.log(`   renderAgentToolCall(input)                 : ${renderAgentToolCall(params, theme).text ?? ""}`);
  await executeAgentTool("call-9", params, undefined, undefined, ctx);
  check("the stamp names the canonical type", params._resolvedAgent === "Explore");
  check(
    "and the injected model is what the spawn used, unchanged from AD1",
    spawned[0]?.model?.id === "qwen3-4b",
  );
}

console.log("");
if (failures > 0) {
  console.log(`   ${failures} expectation(s) failed`);
  process.exit(1);
}
console.log("   all expectations held");
