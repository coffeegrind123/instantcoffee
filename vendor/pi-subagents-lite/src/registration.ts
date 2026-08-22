// Forge fork: upstream imports `@sinclair/typebox`, which does not resolve in
// this pi install. pi 0.84.2 bundles `typebox` 1.3.7 (the successor package) and
// resolves the bare specifier for extensions; `@sinclair/typebox` is absent
// entirely, so the unmodified import fails at load. `Type` and `TSchema` are
// both exported from the 1.x root, and the produced JSON Schema is identical —
// verified against pi's own copy. vendor/prinny-channel imports it the same way.
import { Type, type TSchema } from "typebox";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getAvailableTypes } from "./agents/agent-types.js";
import { executeAgentTool, executeStopAgentTool } from "./agents/tool-execution.js";
import { executeAgentStatusTool } from "./agents/agent-status.js";
import { renderAgentToolCall, renderAgentToolResult, renderSubagentResult } from "./ui/renderer.js";
import { showAgentsMainMenu } from "./ui/menu/menus.js";
import { getStore } from "./shell.js";
import { SUBAGENT_ENTRY_TYPE, type SubagentEntry } from "./agents/transcript-entry.ts";
import { renderSubagentEntry } from "./ui/renderer.js";

// Provider-side json_schema enforcement; "prefer" falls back gracefully on
// providers without strict mode (e.g. local Ollama).
const CONSTRAINED_SAMPLING = { type: "json_schema", strict: "prefer" };

// --- Agent tool registration — dynamic enum for agent types ---

/**
 * Register (or re-register) the Agent tool with current agent types.
 * Call again from session_start after user/project agents load.
 */
export function registerAgentTool(pi: ExtensionAPI): void {
  const types = getAvailableTypes();
  const useConstrained = getStore().agent.agentToolStrictMode;

  // Plain string (not anyOf) keeps the prompt concise; types listed in description for discoverability.
  const agentType = types.length > 0 ? Type.String({ description: types.join(",") }) : Type.String();

  // Constrained sampling (strict mode) requires every property in `required`,
  // so optional fields become nullable unions instead of Type.Optional.
  const optional = <T extends TSchema>(base: T) =>
    useConstrained ? Type.Union([base, Type.Null()]) : Type.Optional(base);

  const params = Type.Object(
    {
      prompt: Type.String(),
      description: optional(Type.String()),
      agent: optional(agentType),
      run_in_background: optional(Type.Boolean()),
      worktree_path: optional(Type.String()),
    },
    useConstrained
      ? {
          additionalProperties: false,
          required: ["prompt", "description", "agent", "run_in_background", "worktree_path"],
        }
      : { additionalProperties: false },
  );

  const tool = {
    name: "Agent",
    label: "Agent",
    parameters: params,
    execute: executeAgentTool,
    ...(useConstrained ? { constrainedSampling: CONSTRAINED_SAMPLING } : {}),

    renderCall: (args: Record<string, unknown>, theme: any) => renderAgentToolCall(args, theme),

    renderResult: (
      result: { content: Array<{ type: string; text?: string }>; details?: Record<string, unknown>; isError?: boolean },
      options: { expanded?: boolean },
      theme: any,
    ) => {
      const store = getStore();
      return renderAgentToolResult(result, options, theme, store.agent.showCost, store.agent.modelDisplayStyle);
    },
  };
  // @ts-expect-error — description removed to save prompt tokens
  pi.registerTool(tool);
}

// --- Tool/Command/Message registration ---

export function registerTools(pi: ExtensionAPI): void {
  registerAgentTool(pi);

  const stopAgentTool = {
    name: "StopAgent",
    label: "StopAgent",
    parameters: Type.Object(
      {
        agent_id: Type.String(),
      },
      { additionalProperties: false },
    ),
    execute: executeStopAgentTool,
    constrainedSampling: CONSTRAINED_SAMPLING,
  };
  // @ts-expect-error — description removed to save prompt tokens
  pi.registerTool(stopAgentTool);

  const agentStatusTool = {
    name: "AgentStatus",
    label: "AgentStatus",
    parameters: Type.Object({}, { additionalProperties: false }),
    execute: executeAgentStatusTool,
    constrainedSampling: CONSTRAINED_SAMPLING,
  };
  // @ts-expect-error — description removed to save prompt tokens
  pi.registerTool(agentStatusTool);

  /**
   * Entry renderer — a subagent's own turns, in the operator's transcript.
   *
   * Forge fork, twentieth pass. A `type: "custom"` entry is written to the
   * session file and rendered here, and `sessionEntryToContextMessages` returns
   * `[]` for it — so this costs the model nothing on any turn, ever, which is
   * the property that makes putting a child's whole reasoning in the parent's
   * session affordable on a 32k window. See `agents/transcript-entry.ts`.
   */
  pi.registerEntryRenderer<SubagentEntry>(SUBAGENT_ENTRY_TYPE, (entry, options, theme) =>
    renderSubagentEntry(entry.data, options as { expanded?: boolean }, theme),
  );

  // Message renderer — subagent-result (background agent completion)
  pi.registerMessageRenderer("subagent-result", (message, options, theme) => {
    const store = getStore();
    return renderSubagentResult(
      message as { content?: string; details?: Record<string, unknown> },
      options as { expanded?: boolean },
      theme,
      store.agent.showCost,
      store.agent.modelDisplayStyle,
      !store.agent.showCompletionCards,
    );
  });

  pi.registerCommand("agents", {
    description: "Manage subagents: agent briefing, model settings, concurrency, running agents, agent types",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      // ctx.scopedModels added in pi 0.83.0 — session-scoped model list from --models / enabledModels.
      // Empty array means no scoping (all models usable). Undefined on pi < 0.83.
      const scoped = (ctx as any).scopedModels as
        ReadonlyArray<{ model: { provider: string; id: string } }> | undefined;
      const modelOptions = scoped?.length
        ? scoped.map((s) => `${s.model.provider}/${s.model.id}`)
        : ctx.modelRegistry.getAvailable().map((m) => `${m.provider}/${m.id}`);
      await showAgentsMainMenu(ctx, modelOptions);
    },
  });
}
