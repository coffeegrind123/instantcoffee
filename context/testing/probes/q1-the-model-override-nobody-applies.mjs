/**
 * q1 — AD1. The subagent model override that was computed, injected, rendered,
 * and then thrown away.  FIXED — this probe shows both columns.
 *
 * Three components agree on one number and the fourth ignores it:
 *
 *   config-store.modelFor()      six-level precedence — session per-type,
 *                                session default, config per-type, config
 *                                default, the agent .md's frontmatter, and
 *                                only then the parent's model
 *   toolCallListener()           runs on `tool_call`, writes the answer into
 *                                `event.input.model` and a display copy into
 *                                `event.input._modelOverride`
 *   renderAgentToolCall()        prints `▸ Explore (qwen3-4b)` from that copy
 *   executeAgentTool()           `findModelInRegistry(undefined, …)`  ← AD1
 *
 * pi passes ONE object: `prepareToolCall` builds `validatedArgs`, hands it to
 * `beforeToolCall` as `args`, and then calls `tool.execute(id, prepared.args,…)`
 * with the same reference (pi-agent-core/dist/agent-loop.js:404-443). So the
 * listener's write really does arrive as `params.model` — which the function
 * three lines below proves, because it reads `params.thinking`, written by the
 * same listener on the same object, and honours it.
 *
 * The comment that removed the read says the model "cannot send either key"
 * because the schema is `additionalProperties: false`. That is true and beside
 * the point: nothing here came from the model.
 *
 * The menu path was not changed and still resolves the override
 * (`menu-spawn-wizard.ts:222`), so the same delegation gets a different model
 * depending on whether a human or the model started it.
 *
 *   run: node q1-the-model-override-nobody-applies.mjs
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

/** Two models in the registry, so "which one was picked" is answerable. */
const PARENT = { provider: "forge", id: "qwen3.8-27b", name: "qwen3.8-27b", contextWindow: 32768 };
const SMALL = { provider: "forge", id: "qwen3-4b", name: "qwen3-4b", contextWindow: 32768 };
const registry = {
  find: (provider, id) => [PARENT, SMALL].find((m) => m.provider === provider && m.id === id),
};

/**
 * The Explore agent, with a model in its FRONTMATTER — the fifth rung of
 * `resolveModel`'s precedence and the one an agent author controls.
 */
agentTypes.registerAgents(
  new Map([
    ["Explore", { name: "Explore", description: "read-only search", model: "forge/qwen3-4b", prompt: "explore" }],
  ]),
  { disableDefaultAgents: true },
);

function harness() {
  const spawned = [];
  shell.setPiInstance({ sendMessage() {}, exec: async () => ({ code: 0, stdout: "", stderr: "", killed: false }) });
  // The store is created by the shell itself and lives for the extension's
  // lifetime; there is no setter, and none is needed — the default layers are
  // exactly the "no operator override configured" case this probe is about.
  const store = shell.getStore();
  shell.setCoordinator({
    spawn: async (_pi, _ctx, intent) => {
      spawned.push(intent);
      return {
        agentId: "agent-0123456789ab",
        record: {
          id: "agent-0123456789ab",
          result: "done",
          lifecycle: { status: "completed", startedAt: Date.now(), completedAt: Date.now(), started: true },
          display: { type: intent.type, description: intent.description, invocation: intent.invocation },
          execution: { session: undefined },
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
  return { ctx, spawned, store };
}

const theme = {
  fg: (_k, s) => s,
  bold: (s) => s,
};

console.log("\nq1 — the subagent model override, from the store to the spawn\n");

// ── 1. What every other reader in the package says the model is ──────────────
{
  const { store } = harness();
  const effective = store.modelFor("Explore", "forge/qwen3.8-27b", agentTypes.getAgentConfig("Explore"));
  console.log(`   config-store.modelFor("Explore")           : ${effective}`);
  check("the store resolves the frontmatter override", effective === "forge/qwen3-4b");
}

// ── 2. The listener writes it onto the object pi will execute with ───────────
{
  const { ctx } = harness();
  const input = { prompt: "map the parser", description: "map", agent: "Explore", run_in_background: false };
  const event = { toolName: "Agent", toolCallId: "call-1", input };
  await toolCallListener(event, ctx);
  console.log(`   after tool_call, input.model               : ${input.model}`);
  console.log(`   after tool_call, input._modelOverride      : ${input._modelOverride}`);
  console.log(`   renderAgentToolCall(input)                 : ${renderAgentToolCall(input, theme).text ?? renderAgentToolCall(input, theme)}`);
  check("the listener injects the override onto the args object", input.model === "forge/qwen3-4b");
  check("the UI renders the override next to the call", input._modelOverride === "qwen3-4b");
}

// ── 3. What the spawn is actually given, BEFORE and NOW ─────────────────────
//
// BEFORE is `findModelInRegistry(undefined, …)` reproduced exactly: the twelfth
// pass's line ignored whatever the listener had written, which is the same thing
// as running the fixed line against args the listener never touched. So the left
// column deletes the injected key and the right column keeps it, and both run
// the shipped function.
{
  const results = {};
  for (const column of ["BEFORE", "NOW"]) {
    const { ctx, spawned } = harness();
    // Exactly the object pi hands on: the validated args, mutated in place by
    // the tool_call handler, passed by reference to execute().
    const params = { prompt: "map the parser", description: "map", agent: "Explore", run_in_background: false };
    await toolCallListener({ toolName: "Agent", toolCallId: "call-2", input: params }, ctx);
    if (column === "BEFORE") delete params.model;
    await executeAgentTool("call-2", params, undefined, undefined, ctx);
    const intent = spawned[0];
    results[column] = {
      model: intent?.model ? `${intent.model.provider}/${intent.model.id}` : "(none)",
      modelKey: intent?.modelKey,
    };
  }
  console.log("");
  console.log("                                                BEFORE                NOW");
  console.log(`   the model the child runs on             : ${results.BEFORE.model.padEnd(22)}${results.NOW.model}`);
  console.log(`   the key its concurrency slot is keyed on: ${String(results.BEFORE.modelKey).padEnd(22)}${results.NOW.modelKey}`);
  console.log("");
  check("BEFORE: the resolved override was dropped and the parent's model used", results.BEFORE.model === "forge/qwen3.8-27b");
  check("NOW: the child runs on the model every other reader already reported", results.NOW.model === "forge/qwen3-4b");
  check("NOW: and holds a slot of its own rather than the parent's", results.NOW.modelKey === "forge/qwen3-4b");
}

// ── 4. The control: the same object's `thinking`, written by the same listener ─
//
// This is the whole argument. If a tool_call handler's write could not reach
// `params`, this one would not either — and it does.
{
  const { ctx, spawned } = harness();
  const params = { prompt: "map the parser", description: "map", agent: "Explore", run_in_background: false };
  params.thinking = "high";
  // Fourteenth pass (AE6): the injected values are read while the stamp says
  // they were resolved for the type being spawned. The listener writes it; this
  // block writes it by hand because the point here is `params`, not the
  // listener. Without it the tool re-resolves from the canonical type instead —
  // which is AE6's repair, and is exercised in `r2`.
  params._resolvedAgent = "Explore";
  delete params.model;
  await executeAgentTool("call-3", params, undefined, undefined, ctx);
  console.log(`   control — params.thinking reached the spawn: ${spawned[0]?.thinkingLevel}`);
  check("control: a value on the same object IS read three lines below", spawned[0]?.thinkingLevel === "high");
}

// ── 5. The other rung: runAgent's own fallback, shadowed by the same line ─────
//
// `agent-runner.ts:587` is `options.model ?? findModelInRegistry(agentConfig?.model, …)`,
// so an agent .md's `model:` is honoured for any caller that passes no model.
// `executeAgentTool` always passes one, so the fallback is unreachable from the
// tool — which is why the frontmatter override in step 1 changes nothing.
{
  const runner = await import(
    "/home/claudeuser/qwen3.8-forge/vendor/pi-subagents-lite/src/agents/agent-runner.ts"
  ).then(
    () => "loaded",
    () => "not loaded (imports pi)",
  );
  const source = await import("node:fs").then((fs) =>
    fs.readFileSync("/home/claudeuser/qwen3.8-forge/vendor/pi-subagents-lite/src/agents/agent-runner.ts", "utf8"),
  );
  const line = source.split("\n").find((l) => l.includes("options.model ??"));
  console.log(`   agent-runner's own fallback               : ${line?.trim()}`);
  console.log(`   (${runner})`);
  check(
    "runAgent would honour the frontmatter — if the tool did not always pass a model",
    Boolean(line && line.includes("agentConfig?.model")),
  );
}

console.log(`\n${failures === 0 ? "q1: every expectation held" : `q1: ${failures} FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
