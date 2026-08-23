import { getStatusNote, formatStopReason } from "../status-note.js";
/**
 * tool-execution.ts — Agent tool execution handlers.
 *
 * Contains the execute callbacks registered for the Agent tool.
 * Spawn coordination, nudge scheduling, and live-view tracking have moved
 * to spawn-coordinator.ts. buildAgentDetails stays here as a pure helper.
 */

import { getAgentDir, type ExtensionContext, type ToolCallEvent } from "@earendil-works/pi-coding-agent";

import type { AgentRecord } from "../types.js";
import { SHORT_ID_LENGTH } from "../types.js";
import { ambiguousAgentIdMessage } from "./agent-id.ts";
import { resolveType, getAgentConfig, discoverNewAgents, type TypeResolution } from "./agent-types.js";
import { getSessionContextPercent } from "./usage.js";
import { validateWorktreePath } from "../spawn/worktree-validator.js";
import { resolveSubagentTrust, createSubagentTrustDeps, untrustedProjectWarning } from "../spawn/project-trust.js";

import { isBusyRecord, isVerifyingRecord } from "./record-activity.ts";
import { parseModelKey, findModelInRegistry, parseThinkingLevel } from "../utils.js";
import { getPiInstance, getSessionCtx, getStore, getCoordinator, getManager } from "../shell.js";

// --- Tool result helpers ---

function successResult(text: string, details?: Record<string, unknown>) {
  return { content: [{ type: "text", text }], details };
}

function errorResult(text: string, details?: Record<string, unknown>) {
  return { content: [{ type: "text", text }], isError: true as const, details };
}

/**
 * Build a details record from an AgentRecord. Always includes type and
 * description; includeStatus adds status/outputFile/stopReason, includeStats
 * adds turn/token/cost/context/compaction/model fields.
 */
export function buildAgentDetails(
  record: AgentRecord,
  opts?: { includeStats?: boolean; includeStatus?: boolean },
): Record<string, unknown> {
  const details: Record<string, unknown> = {
    type: record.display.type,
    description: record.display.description,
  };

  if (record.display.worktreePath) {
    details.worktreePath = record.display.worktreePath;
  }

  // Forge fork: whether the answer was checked, and what came back. A passing
  // check is deliberately invisible in the answer text — a passing answer must
  // not be decorated — which left no way to tell "checked and fine" from "never
  // checked", including for the operator reading a transcript. It is one field.
  if (record.verification) {
    details.verification = record.verification;
  }

  // Forge fork: what the check itself cost, when it cost anything. The judge
  // runs in a session of its own, so before this it was spent on the parent's
  // one slot and reported by nothing at all — the answer's own numbers describe
  // only the child's session. Absent when the verifier made no model call
  // (skipped, or off), which keeps "checked, cheap" distinguishable from
  // "never checked".
  if (record.stats.verifyUsage) {
    details.verifyInput = record.stats.verifyUsage.input;
    details.verifyOutput = record.stats.verifyUsage.output;
    if (record.stats.verifyUsage.cost > 0) details.verifyCost = record.stats.verifyUsage.cost;
  }

  if (opts?.includeStatus) {
    details.status = record.lifecycle.status;
    details.outputFile = record.display.outputFile;
    const stopReason = formatStopReason(record.lifecycle);
    if (stopReason) details.stopReason = stopReason;
  }

  if (opts?.includeStats) {
    const elapsedMs = record.lifecycle.completedAt ? record.lifecycle.completedAt - record.lifecycle.startedAt : 0;

    details.turnCount = record.stats.turnCount;
    details.maxTurns = record.stats.maxTurns;
    details.toolUses = record.stats.toolUses;
    details.input = record.stats.lifetimeUsage.input;
    details.output = record.stats.lifetimeUsage.output;
    details.contextPercent = getSessionContextPercent(record.execution.session);
    details.durationMs = elapsedMs;
    details.compactions = record.stats.compactionCount;
    details.modelName = record.execution.session?.model?.name ?? record.display.invocation?.modelName;
    details.modelId = record.execution.session?.model?.id ?? record.display.invocation?.modelName;
    details.thinkingLevel = record.execution.session?.thinkingLevel ?? record.display.invocation?.thinkingLevel;
    details.cost = record.stats.lifetimeUsage.cost;
  }

  return details;
}

/**
 * Result text plus status note, for display. For error status, appends the
 * recorded error message so the nudge explains the failure.
 *
 * Shared by the foreground tool result and the subagent-result nudge so both
 * callers stay in sync on the nullish default and separator handling — they
 * have diverged before. getStatusNote owns the leading separator.
 */
export function formatResultContent(record: AgentRecord): string {
  // Only the nudge path formats error-status records as text: the foreground
  // handler intercepts error status earlier and returns an errorResult instead.
  const errorNote = record.lifecycle.status === "error" && record.error ? `\n\nError: ${record.error}` : "";
  return (record.result ?? "") + errorNote + getStatusNote(record.lifecycle);
}

// --- Tool execute handlers ---

/**
 * Validate worktree_path and gate cross-repo trust, surfacing warnings via
 * ctx.ui. Errors are LLM-facing and self-correctable.
 */
async function resolveWorktree(
  ctx: ExtensionContext,
  rawWorktreePath: string | undefined,
): Promise<
  { ok: true; resolvedPath?: string; worktreeLabel?: string; projectTrusted: boolean } | { ok: false; error: string }
> {
  // Empty/whitespace → omitted: nothing to validate, nothing to gate.
  if (!rawWorktreePath || rawWorktreePath.trim() === "") {
    return { ok: true, projectTrusted: true };
  }
  try {
    const parentCwd = getSessionCtx()?.cwd ?? ctx.cwd;
    const warnings: string[] = [];
    const onWarning = (msg: string) => {
      warnings.push(msg);
    };
    const validation = await validateWorktreePath(getPiInstance(), rawWorktreePath, parentCwd, onWarning);
    if (!validation.ok) {
      for (const msg of warnings) {
        if (ctx.ui?.notify) ctx.ui.notify(`[pi-subagents-lite] ${msg}`, "warning");
      }
      return { ok: false, error: validation.error };
    }

    const resolvedPath = validation.resolvedPath!; // non-empty paths always resolve

    // Cross-repo targets are gated by pi's trust framework. Same-repo paths
    // are never gated; an untrusted target still spawns but with its project
    // resources ignored and a warning surfaced.
    const projectTrusted = resolveSubagentTrust({
      targetPath: resolvedPath,
      sameRepo: validation.sameRepo === true,
      deps: createSubagentTrustDeps(getAgentDir(), parentCwd),
    });
    if (!projectTrusted && ctx.ui?.notify) {
      ctx.ui.notify(`[pi-subagents-lite] ${untrustedProjectWarning(resolvedPath)}`, "warning");
    }
    return {
      ok: true,
      resolvedPath,
      worktreeLabel: validation.label,
      projectTrusted,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `worktree_path validation failed: ${msg}` };
  }
}

/**
 * Resolve a type name, refreshing the registry from the scan dirs when it is not
 * found. Agents added to the filesystem after startup, or to a worktree's
 * .pi/agents/ directory, become resolvable on the retry.
 */
async function resolveTypeWithDiscovery(type: string, worktreeAgentsDir: string | undefined): Promise<TypeResolution> {
  let resolution = resolveType(type);
  if (resolution.kind === "not-found") {
    await discoverNewAgents(worktreeAgentsDir);
    resolution = resolveType(type);
  }
  return resolution;
}

/**
 * Forge fork, fourteenth pass (AE6): one resolver, called from both ends.
 *
 * `toolCallListener` and `executeAgentTool` both have to answer "what model does
 * this spawn run on", and after AD1 made the listener's answer the one the spawn
 * obeys, the two were resolving it against different keys:
 *
 *   the listener  `input.agent` verbatim — the name the MODEL typed — against
 *                 the registry as it stands when the tool call is announced.
 *   the tool      `resolveTypeWithDiscovery(...)` — the CANONICAL registered
 *                 name, after a filesystem re-scan that can register agents the
 *                 listener could not see.
 *
 * Both differences are reachable and both were measured (see
 * `context/testing/probes/r2-the-name-the-override-is-keyed-on.mjs`):
 *
 *   · `resolveType` is deliberately case-insensitive, so `agent: "explore"`
 *     spawns the registered `Explore` — but `resolveModel` looks its per-type
 *     override up as `config.agent["explore"]` and `sessionOverrides["explore"]`,
 *     and `/agents` → models writes those keys from `getAllTypes()`, i.e. under
 *     `Explore`. So an operator's pin was silently skipped for a spawn that
 *     differed from the menu only in case — and `renderAgentToolCall` printed the
 *     unpinned model beside the call, so the display agreed with the miss.
 *   · An agent that only becomes resolvable on the discovery retry — one added to
 *     the filesystem after startup, or living in a worktree's `.pi/agents/`,
 *     which is the case that retry exists for — has no config at listener time.
 *     `resolveModel` then falls past its frontmatter rung to `parentModelId`,
 *     the tool honours that, and `agent-runner`'s own
 *     `options.model ?? findModelInRegistry(agentConfig?.model, …)` fallback
 *     cannot rescue it because the tool always supplies the left side. That is
 *     AD1's damage exactly — the child on the parent's model, holding the
 *     parent's concurrency slot — restored for one class of agent.
 *
 * So the question has one implementation, it takes the type it is asked about,
 * and the caller is responsible for asking about the right one. The listener
 * canonicalises what it can; the tool asks again with what discovery found.
 */
function canonicalAgentType(requested: string): string | undefined {
  const resolution = resolveType(requested);
  return resolution.kind === "resolved" ? resolution.key : undefined;
}

/** The six-level precedence, for one canonical type. See canonicalAgentType. */
function resolveSpawnModel(canonicalType: string, ctx: ExtensionContext): string {
  const parentModelId = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "";
  return getStore().modelFor(canonicalType, parentModelId, getAgentConfig(canonicalType));
}

/** Thinking level for one canonical type: the agent's frontmatter, else the operator's default. */
function resolveSpawnThinking(canonicalType: string) {
  return getAgentConfig(canonicalType)?.thinkingLevel ?? getStore().agent.defaultThinking;
}

export async function executeAgentTool(
  _toolCallId: string,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
  _onUpdate: ((update: any) => void) | undefined,
  ctx: ExtensionContext,
): Promise<any> {
  // Validate worktree_path early — needed for on-demand agent discovery
  const rawWorktreePath = params.worktree_path as string | undefined;
  const resolved = await resolveWorktree(ctx, rawWorktreePath);
  if (!resolved.ok) return errorResult(resolved.error);
  const validatedWorktreePath = resolved.resolvedPath;
  const worktreeLabel = resolved.worktreeLabel;
  const projectTrusted = resolved.projectTrusted;

  const type = (params.agent as string) || "general-purpose";
  // When worktree_path is set, also scan the target's .pi/agents/ directory, unless
  // the target is an untrusted cross-repo project (its agent types stay hidden).
  const targetAgentsDir = projectTrusted && validatedWorktreePath ? `${validatedWorktreePath}/.pi/agents` : undefined;
  const resolution = await resolveTypeWithDiscovery(type, targetAgentsDir);
  if (resolution.kind === "ambiguous") {
    // Two or more registered types differ only by case — never a silent pick.
    return errorResult(
      `Ambiguous agent type: ${type}. Candidates: ${resolution.candidates.join(", ")}. Use the exact registered name.`,
    );
  }
  if (resolution.kind === "not-found") {
    return errorResult(`Unknown agent type: ${type}`);
  }
  const resolvedType = resolution.key;

  // Forge fork: `hidden` means not offered AND not callable here.
  //
  // `hidden: true` keeps a type out of `getAvailableTypes()`, which is what
  // builds the `agent` parameter's description — so the model is never told
  // `__verifier` exists. The parameter is a plain `Type.String()`, though, not an
  // enum, so nothing stopped the model naming it anyway, and `resolveType` was
  // deliberately open to hidden names ("they can still be called by name").
  //
  // Both intents are kept by gating the MODEL-FACING surface only: the judge
  // reaches `__verifier` through `runAgent`/`getAgentConfig`, and the /agents
  // wizard through the coordinator, neither of which comes through here. What is
  // closed is a parent model spawning the verifier with an arbitrary prompt — one
  // wasted call on the single llama slot, and a record labelled "verify" in
  // /agents doing something that is not a verification.
  if (getAgentConfig(resolvedType)?.hidden === true) {
    return errorResult(`Unknown agent type: ${type}`);
  }

  const prompt = params.prompt as string;
  const description =
    (params.description as string | undefined) || prompt.split("\n")[0].slice(0, 80) || prompt.slice(0, 80);
  const runInBackground = params.run_in_background as boolean | undefined;
  // Forge fork: `max_turns` is not read off `params`.
  //
  // The tool declares five parameters — prompt, description, agent,
  // run_in_background, worktree_path — with `additionalProperties: false`
  // (registration.ts), so the model cannot send it and the read was always
  // undefined. It is an upstream vestige from a schema that had it. Keeping a
  // read that the declaration forbids is S1's shape: the artefact a reader
  // checks is not what runs. The precedence below is the real one.
  //
  // Adding it back to the schema was considered and rejected: `max_turns` is
  // the ceiling that stops an unbounded child stalling the one-slot machine
  // (turn-tracking.ts), and it belongs to the agent's own .md or the operator's
  // config, not to the caller that is about to be blocked on it.
  const maxTurns = getAgentConfig(resolvedType)?.maxTurns ?? getStore().agent.defaultMaxTurns;

  // Forge fork, thirteenth pass (AD1): `params.model` IS read, and the twelfth
  // pass's reasoning for dropping it applied to the wrong sender.
  //
  // `model` was removed alongside `max_turns` under one argument — "the schema
  // is `additionalProperties: false`, so the model cannot send either key and
  // these reads were always undefined". True of the MODEL, and beside the point:
  // nothing here came from the model. `toolCallListener` below is a `tool_call`
  // handler, it runs after validation, and pi hands the SAME object to the
  // handler and to this function — `prepareToolCall` builds `validatedArgs`,
  // passes it as `args` to `beforeToolCall`, then calls
  // `tool.execute(id, prepared.args, …)` with that reference
  // (pi-agent-core/dist/agent-loop.js:404-443). The listener writes
  // `input.model = getStore().modelFor(...)` onto it, and `input.thinking` too —
  // which is why `parseThinkingLevel(params.thinking)` three lines below works.
  //
  // With the read gone, `findModelInRegistry(undefined, …)` returned `ctx.model`
  // unconditionally, so EVERY layer of the documented precedence above the
  // parent — session per-type, session default, config per-type, config default,
  // and the agent .md's own `model:` — was resolved, injected, rendered next to
  // the call by `renderAgentToolCall`, listed as the "effective model" in
  // `/agents` → models, and then discarded. `agent-runner.ts`'s own fallback
  // (`options.model ?? findModelInRegistry(agentConfig?.model, …)`) could not
  // rescue it either, because this always passed a model. The menu wizard was
  // never changed and still resolves it, so the same delegation ran on a
  // different model depending on who started it.
  //
  // Measured: `context/testing/probes/q1-the-model-override-nobody-applies.mjs`.
  //
  // Forge fork, fourteenth pass (AE6): the injected values are used exactly when
  // the listener resolved the SAME agent this function is about to spawn.
  //
  // `_resolvedAgent` is the canonical name `toolCallListener` keyed its
  // resolution on, and it is absent when the listener could not resolve the name
  // at all — which is the discovery case. When it matches, the injected values
  // are the answer and are read here, which is AD1 and stays. When it does not,
  // they were resolved against a different key or against a registry that did
  // not yet contain the agent, and the answer is re-derived from the type that is
  // actually being spawned. See canonicalAgentType above for both cases.
  const listenerResolvedThisType = params._resolvedAgent === resolvedType;
  const modelSpec = listenerResolvedThisType
    ? (params.model as string | undefined)
    : resolveSpawnModel(resolvedType, ctx);
  const model = findModelInRegistry(modelSpec, ctx.modelRegistry, ctx.model);
  const modelKey = model ? `${model.provider}/${model.id}` : undefined;

  // Determine modelName for invocation (always capture for display)
  const modelName = model?.id;

  // Resolve thinking: the listener's injected value when it is about this type,
  // then the agent's own frontmatter, then the operator's default. Same rule as
  // the model above and for the same reason — a `thinking` injected against a
  // type the listener could not see is the store's DEFAULT, and it would shadow
  // the frontmatter the discovery retry has just made readable.
  const thinkingLevel = listenerResolvedThisType
    ? (parseThinkingLevel(params.thinking as string | undefined) ?? resolveSpawnThinking(resolvedType))
    : resolveSpawnThinking(resolvedType);

  const coordinator = getCoordinator()!;
  // Background spawns (explicit or forceBackground) never bind to the parent
  // run's interrupt signal — only foreground spawns can be interrupted.
  const isBackground = runInBackground || getStore().agent.forceBackground;

  const result = await coordinator.spawn(getPiInstance(), ctx, {
    type: resolvedType,
    prompt,
    description,
    model,
    modelKey,
    maxTurns,
    thinkingLevel,
    graceTurns: getStore().agent.graceTurns,
    worktreePath: validatedWorktreePath,
    worktreeLabel,
    projectTrusted,
    invocation: { modelName, thinkingLevel, maxTurns },
    runInBackground: isBackground,
    signal: isBackground ? undefined : signal,
  });

  const { agentId, record } = result;

  if (isBackground) {
    const suffix = `Success! You delegated to an agent. A notification will arrive when done - USER: do not poll, don't check status and don't duplicate the delegated work!\n\nAgent ID: ${agentId}`;
    const label = record.lifecycle.status === "queued" ? "Agent queued" : "Agent running";
    const details = buildAgentDetails(record);
    // Forge fork: say it in the details rather than leaving the renderer to
    // infer it from the text. It inferred it by looking for "running in
    // background", which this message has never said, so a background spawn
    // rendered with the same green tick as a finished one — at the moment it
    // started, with no result behind it.
    details.background = true;
    return successResult(`[${label}] ${suffix}`, details);
  }

  // Foreground: record.execution.promise is already awaited by coordinator.spawn()
  const details = buildAgentDetails(record, { includeStats: true });

  if (record.lifecycle.status === "error") {
    return errorResult(`Agent failed: ${record.error || "unknown error"}`, details);
  }

  return successResult(formatResultContent(record), details);
}

// --- Running agents list helper (used by executeStopAgentTool) ---

/**
 * Build a compact list of agents that are still busy.
 * Format: "short_id (type), short_id (type)" — one line, easy for LLM to parse.
 *
 * Forge fork, thirteenth pass (AD2): `isBusyRecord`, not a status test. A record
 * whose VERIFIER is still running has a terminal `lifecycle.status` — the
 * settlement chain classifies the child's run and only then awaits
 * `runVerification` — so a status filter drops the one agent that is holding the
 * llama slot. `record-activity.ts` exists so this question has one answer; this
 * was its fourth reader and the one that still had its own.
 */
function formatRunningAgents(): string {
  const agents = getManager()!.listAgents().filter(isBusyRecord);

  if (agents.length === 0) return "none";

  return agents.map((a) => `${a.id.slice(0, SHORT_ID_LENGTH)} (${a.display.type})`).join(", ");
}

// --- StopAgent execute handler ---

export async function executeStopAgentTool(
  _toolCallId: string,
  params: Record<string, unknown>,
  _signal: AbortSignal | undefined,
  _onUpdate: ((update: any) => void) | undefined,
  _ctx: ExtensionContext,
): Promise<any> {
  const requestedId = params.agent_id as string | undefined;

  if (!requestedId) {
    return errorResult("agent_id is required");
  }

  // Forge fork, twenty-fourth pass (AO1). Not `getRecord(requestedId)`, which is
  // an exact `Map` lookup on the full seventeen-character id — while every
  // model-facing surface in this package publishes the first eight, including
  // the "Running agents:" list in the refusal below. The model was handed a
  // spelling this call rejected, and told to try again with it. See
  // `agent-id.ts` for the ladder, which is `resolveType`'s one field over.
  const resolution = getManager()!.resolveId(requestedId);

  if (resolution.kind === "ambiguous") {
    return errorResult(ambiguousAgentIdMessage(requestedId, resolution.candidates, SHORT_ID_LENGTH));
  }
  if (resolution.kind === "not-found") {
    return errorResult(`Agent ${requestedId} not found. Running agents: ${formatRunningAgents()}`);
  }

  const agentId = resolution.id;
  const record = getManager()!.getRecord(agentId)!;

  // Forge fork, thirteenth pass (AD2): a record whose ANSWER is still being
  // checked is stoppable, and this precondition was what made it unreachable.
  //
  // T5 was closed in `AgentManager.stopAgent()`, which tests `isVerifyingRecord`
  // before it tests `status === "running"`, and its comment says the fix is for
  // "the operator's Esc, for `StopAgent`, and for anything else that asked". It
  // was not for `StopAgent`: this function has its own status guard one layer up
  // and returns on it, so the manager was never asked. Meanwhile the model was
  // told the agent was "already completed" while a judge and up to three repairs
  // held the single llama slot its own next call was queued behind — and the
  // answer it was waiting for had not been decided yet.
  //
  // `isBusyRecord` is the same predicate the widget and the `/agents` menu use
  // (`record-activity.ts`), and the sentence names which run is being stopped,
  // for the same reason the menu's label does: the child's own run really has
  // finished, and "Stopped agent X" alone would be a claim about that one.
  //
  // Measured: `context/testing/probes/q2-the-stop-the-tool-cannot-reach.mjs`.
  // AO1: the SHORT id here too. Every sentence this tool writes now names an
  // agent in the one spelling every other surface publishes and this call
  // accepts — a reply that identifies a record in a form the next call rejects
  // is what the finding was.
  const shortId = agentId.slice(0, SHORT_ID_LENGTH);

  if (!isBusyRecord(record)) {
    return successResult(
      `Agent ${shortId} is already ${record.lifecycle.status}. Running agents: ${formatRunningAgents()}`,
    );
  }

  const verifying = isVerifyingRecord(record);

  if (getManager()!.abort(agentId, "agent")) {
    return successResult(
      verifying
        ? `Stopped the answer check on agent ${shortId}. Its own run had already finished; the answer goes back unchecked.`
        : `Stopped agent ${shortId}`,
    );
  }

  return errorResult(`Failed to stop agent ${shortId}`);
}

// --- Tool_call listener — inject model into Agent tool calls ---

export async function toolCallListener(event: ToolCallEvent, ctx: ExtensionContext): Promise<void> {
  if (event.toolName !== "Agent") return;

  const input = event.input;
  const requestedType = (input.agent as string | undefined) ?? "general-purpose";

  // Forge fork, fourteenth pass (AE6): the CANONICAL registered name, not the
  // one the model typed.
  //
  // `resolveModel` looks a per-type override up as `config.agent[type]` and
  // `sessionOverrides[type]`, and `/agents` → models writes both from
  // `getAllTypes()` — the canonical names. `resolveType` is deliberately
  // case-insensitive, so `agent: "explore"` is a perfectly good spawn of
  // `Explore` whose operator pin this used to miss, silently, while
  // `renderAgentToolCall` printed the unpinned model beside the call.
  //
  // `undefined` when the name resolves to nothing — a worktree-local agent, or
  // one added to the filesystem since startup. Nothing is injected then, and the
  // stamp below says so, because `executeAgentTool` retries the resolution after
  // a discovery scan and is the only one of the two that can answer.
  const canonicalType = canonicalAgentType(requestedType);
  if (!canonicalType) return;

  // The key everything below was resolved against. `executeAgentTool` reads the
  // injected values only while this still names the type it is spawning.
  input._resolvedAgent = canonicalType;

  const effectiveModel = resolveSpawnModel(canonicalType, ctx);

  if (effectiveModel) {
    input.model = effectiveModel;
    // Always inject _modelOverride for renderCall
    const parsed = parseModelKey(effectiveModel);
    if (parsed) {
      input._modelOverride = parsed.modelId;
    }
  }

  // Inject thinking if not explicitly passed: agent frontmatter > spawn options default
  if (input.thinking === undefined) {
    input.thinking = resolveSpawnThinking(canonicalType);
  }
}
