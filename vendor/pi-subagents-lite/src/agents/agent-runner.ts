/**
 * Core execution engine: creates sessions, runs agents, collects results.
 *
 * Tool visibility policy is owned by agent-types.ts (resolveVisibleTools).
 */

import fs from "node:fs";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  getAgentDir,
  loadProjectContextFiles,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  getAgentConfig,
  getConfig,
  getToolNamesForType,
  resolveSessionAllowedTools,
  resolveVisibleTools,
} from "./agent-types.js";
import type { AgentUsage } from "./usage.js";
import { findModelInRegistry, GIT_EXEC_TIMEOUT_MS } from "../utils.js";
import { DEFAULT_AGENTS } from "./default-agents.js";
import { buildAgentPrompt, type PromptExtras } from "../prompt/prompts.js";
import { preloadSkills, loadSkillMeta } from "../prompt/skill-loader.js";
import { type EnvInfo, type RunCallbacks, type RunTunables, SHORT_ID_LENGTH } from "../types.js";
import type { SubagentType, SystemPromptMode } from "./types.js";
import { getStore, enterSubagentSpawn, exitSubagentSpawn } from "../shell.js";
import { DEFAULT_GRACE_TURNS, CUSTOM_PROMPT_PATH } from "../config/config-io.js";
import { patchRetryClassifier } from "./stream-retry.js";
import { subagentExtraExtensionPaths, withExtensionDenial, withSkillDenial } from "./subagent-denylist.js";
import { classifyGitFailure } from "../spawn/git-failure.ts";
import { declaredPromptSources, declaredResources } from "./declared-resources.ts";
import { collectResponseText } from "./run-answer.ts";
import { wireTurnTracking } from "./turn-tracking.ts";

// Cache: extension path → unscoped package name (lowercased), or undefined if not found
const packageNameCache = new Map<string, string | undefined>();

function extensionPackageName(extPath: string): string | undefined {
  // Presence check distinguishes a cached undefined (not-found) from a miss,
  // so each path's package.json is read at most once per process.
  if (packageNameCache.has(extPath)) return packageNameCache.get(extPath);
  const result = resolvePackageShortName(extPath);
  packageNameCache.set(extPath, result);
  return result;
}

/**
 * The unscoped, lowercased npm short name of the pi package that declares
 * `extPath` as an extension entry — or undefined if the entry doesn't belong
 * to such a package.
 *
 * Climbs from the entry's directory looking for package.json, stopping at
 * node_modules boundaries. The name is taken only when that package's
 * `pi.extensions` manifest actually lists this entry. Returns at the first
 * package.json (whether or not it declares the entry) so a loose extension
 * is never misattributed to a co-located project's name.
 */
function resolvePackageShortName(extPath: string): string | undefined {
  const entry = path.resolve(extPath);
  let dir = path.dirname(entry);

  for (;;) {
    // Climbing into node_modules means we've left the owning package's tree.
    if (path.basename(dir) === "node_modules") return undefined;

    let pkg: { name?: unknown; pi?: { extensions?: unknown } };
    try {
      pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf-8"));
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) return undefined; // walked to the filesystem root
      dir = parent;
      continue;
    }

    // First package.json found — it's the package root; decide here.
    const entries = pkg.pi?.extensions;
    if (
      typeof pkg.name === "string" &&
      Array.isArray(entries) &&
      entries.some((e) => typeof e === "string" && path.resolve(dir, e) === entry)
    ) {
      const short = pkg.name.startsWith("@") ? pkg.name.slice(pkg.name.indexOf("/") + 1) : pkg.name;
      return short.toLowerCase();
    }
    return undefined;
  }
}

/** Clear the package name cache. Exposed for test isolation. */
export function resetPackageNameCache() {
  packageNameCache.clear();
}

// The turn ceiling and the soft-limit steer live in `turn-tracking.ts`, which
// imports nothing and is therefore testable under the plain node the suite runs
// on. An agent file can still raise the ceiling, and `max_turns: 0` still means
// unbounded for anyone who deliberately wants that.
export { DEFAULT_MAX_TURNS } from "./turn-tracking.ts";

interface RunOptions extends RunTunables, RunCallbacks {
  /** ExtensionAPI instance — used for pi.exec() for git detection. */
  pi: ExtensionAPI;
  /** Manager-assigned id; suffixes session name to disambiguate parallel spawns (e.g. `Explore#a1b2c3d4`). */
  agentId?: string;
  cwd?: string;
  /**
   * Trust state for the target project. False = ignore the target's project
   * resources (untrusted cross-repo target). Absent/true = load them.
   */
  projectTrusted?: boolean;
  /** Parent abort signal — when aborted, the subagent is also stopped. */
  signal?: AbortSignal;
}

export interface RunResult {
  responseText: string;
  session: AgentSession;
  /** True if the agent was hard-aborted (max_turns + grace exceeded). */
  aborted: boolean;
  /** True if the agent hit the soft turn limit and wrapped up within grace turns. */
  turnLimited: boolean;
  /**
   * Provider error message when the run ended in a model error: the final
   * assistant message has stopReason "error". Absent for normal, aborted,
   * and turn-limited runs, and for transient errors superseded by a later turn.
   */
  modelError?: string;
}

/**
 * Options for prompting a session, whether first run or continuation.
 * Carries the callbacks the manager wires for record tracking and live-view
 * updates; the session itself is reused by continuations.
 */
export interface SessionPromptOptions extends RunCallbacks {
  maxTurns?: number;
  graceTurns?: number;
  /** Abort signal forwarded to session.abort() while the prompt runs. */
  signal?: AbortSignal;
}

/**
 * The provider error message when the run ended in a model error: the final
 * assistant message has stopReason "error". Returns undefined when the final
 * assistant message ended normally (or was aborted), so a transient error
 * followed by a successful turn never fails the run.
 */
/**
 * The provider error the run ended on, or undefined when it did not end on one.
 *
 * Forge fork: a `stopReason: "error"` with an EMPTY `errorMessage` used to
 * return undefined — which `classifyRun` reads as "no model error", so a run
 * that died on the provider was classified `completed` and its (empty) text went
 * to the parent and to the verifier as an answer. The structural gate exists to
 * refuse exactly that run (`worthJudging: false`, `skip: "error"`) and could not
 * see it.
 *
 * `errorMessage` is not guaranteed: pi sets `stopReason` from the stream and the
 * message only when the provider supplied one. The stopReason is the fact; the
 * text is decoration. So the fallback is a stated one rather than silence.
 */
const UNDESCRIBED_MODEL_ERROR = "the provider ended the turn with an error and no message";

/**
 * What a run says when it was stopped during its own setup, before there was a
 * prompt to abort. Exported so the suite asserts on the sentence rather than on
 * a substring of it. See AB4, and `runTurnLoop`.
 */
export const ABORTED_BEFORE_START = "the subagent was stopped before its run started";

function getFinalModelError(session: AgentSession): string | undefined {
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const msg = session.messages[i];
    if (msg.role !== "assistant") continue;
    if (msg.stopReason !== "error") return undefined;
    return msg.errorMessage && msg.errorMessage.trim() ? msg.errorMessage : UNDESCRIBED_MODEL_ERROR;
  }
  return undefined;
}

/**
 * Forward an abort into the child's session for the duration of a run.
 *
 * **This covers aborts that arrive from HERE ON.** `addEventListener("abort")`
 * on a signal that has ALREADY aborted never fires — the event was dispatched
 * once, at abort time — so a signal that fired before this line is silently
 * unwatched. That is not a hypothetical: this function runs at the top of
 * `runTurnLoop`, and everything before it in `runAgentImpl` — `reloadAndMap()`
 * calling every extension factory, `createAgentSession()`, `bindExtensions()`,
 * `setActiveToolsByName()` — is seconds of work on a 9p mount, with one factory
 * (`vendor/rtk-pi`) shelling out to a subprocess inside it.
 *
 * Aborting the session here instead would be worse than doing nothing: the
 * `abort()` would be consumed before `session.prompt()` was ever called, and the
 * run would go ahead anyway with the operator's stop spent. `runTurnLoop` refuses
 * to start the prompt instead. See AB4 in
 * `context/design/subagents-loop-verifier-signals.md`.
 */
function forwardAbortSignal(session: AgentSession, signal?: AbortSignal): () => void {
  if (!signal) return () => {};
  // abort() returns a promise and this fires from an event listener, so a
  // rejection escapes the run rather than failing it. Node re-throws a
  // listener's returned rejected promise as an uncaught exception, and the
  // parent is already going down when this runs.
  const onAbort = () => {
    void session.abort().catch(() => {});
  };
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

/**
 * Extract a LifetimeUsage from a runtime assistant message_end event.
 * pi-ai attaches `usage: { input, output, cacheWrite, cost: { total } }` to
 * assistant messages at runtime, but this shape isn't reflected in the
 * AgentSessionEvent public types.
 */
function usageFromAssistantMessage(msg: Record<string, unknown>): AgentUsage | undefined {
  const usage = msg.usage as Record<string, unknown> | undefined;
  if (!usage) return undefined;
  return {
    input: (usage.input as number) ?? 0,
    output: (usage.output as number) ?? 0,
    cacheWrite: (usage.cacheWrite as number) ?? 0,
    cacheRead: (usage.cacheRead as number) ?? 0,
    cost: ((usage.cost as Record<string, unknown>)?.total as number) ?? 0,
  };
}

export function subscribeToSessionEvents(
  session: AgentSession,
  options: Pick<RunOptions, "onToolActivity" | "onAssistantUsage" | "onCompaction">,
): () => void {
  if (!options.onToolActivity && !options.onAssistantUsage && !options.onCompaction) {
    return () => {};
  }
  /**
   * The agent loop of the run in flight has emitted `agent_end`.
   *
   * Forge fork: pi auto-compacts from `_handlePostAgentRun()` — after
   * `agent.prompt()` resolves — and from `prompt()`, before the next run starts.
   * A subscriber cannot otherwise tell those apart, and the difference decides
   * whether a steer sent from `onCompaction` joins a turn that was already
   * coming or manufactures one. `agent_start` resets it because each
   * `agent.continue()` runs a whole new agent loop. See CompactionInfo.afterRun
   * and Z2.
   */
  let afterRun = false;
  return session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "agent_start") {
      afterRun = false;
    }
    if (event.type === "agent_end") {
      afterRun = true;
    }
    if (event.type === "tool_execution_start") {
      options.onToolActivity?.({ type: "start", toolName: event.toolName, toolCallId: event.toolCallId });
    }
    if (event.type === "tool_execution_end") {
      options.onToolActivity?.({ type: "end", toolName: event.toolName, toolCallId: event.toolCallId });
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      const msg = event.message as unknown as Record<string, unknown>;
      const usage = usageFromAssistantMessage(msg);
      if (usage) {
        options.onAssistantUsage?.(usage);
      }
    }
    if (event.type === "compaction_end" && !event.aborted && event.result) {
      options.onCompaction?.({
        reason: event.reason,
        tokensBefore: event.result.tokensBefore,
        afterRun,
        willRetry: (event as unknown as { willRetry?: boolean }).willRetry === true,
      });
    }
  });
}

/** Extension name from its install path (git/npm/local/direct); independent of dist/lib/src internals. */
function extractExtensionName(extPath: string): string {
  const parts = extPath.split(path.sep);

  // 1. Git package: .../git/github.com/<user>/<pkg>/...
  //    Package name is 3 dirs after 'git' (github.com/user/pkg)
  const gitIdx = parts.indexOf("git");
  if (gitIdx !== -1 && gitIdx + 3 < parts.length) {
    return parts[gitIdx + 3];
  }

  // 2. npm package: .../node_modules/[...]pkg/...
  const nmIdx = parts.lastIndexOf("node_modules");
  if (nmIdx !== -1 && nmIdx + 1 < parts.length) {
    const next = parts[nmIdx + 1];
    if (next.startsWith("@") && nmIdx + 2 < parts.length) {
      return parts[nmIdx + 2]; // @scope/pkg → pkg
    }
    return next;
  }

  // 3. Local extension: .../extensions/<name>/... or .../extensions/<name>.ts
  const extIdx = parts.lastIndexOf("extensions");
  if (extIdx !== -1 && extIdx + 1 < parts.length) {
    const afterExt = parts[extIdx + 1];
    // Subdirectory: extensions/tavily/index.ts → tavily
    if (afterExt && !afterExt.includes(".")) {
      return afterExt;
    }
    // Direct file: extensions/review.ts → review
    const file = parts[parts.length - 1];
    return path.basename(file, path.extname(file));
  }

  // Fallback: parent dir name
  return path.basename(path.dirname(extPath));
}

/**
 * One git probe for the child's environment block.
 *
 * Forge fork, seventeenth pass (AH3): the verdict goes through
 * `classifyGitFailure`, not through `result.code`.
 *
 * `pi.exec` is `execCommand` (pi `core/exec.js`), which never rejects and which
 * resolves a child it killed on the timeout with `code: code ?? 0` — a signalled
 * child exits with a signal and no code. So `result.code === 0` is TRUE for a
 * wedged git, and this returned `""` rather than `null`: `detectEnv` below then
 * told the child it was not in a git repository and gave it no branch, on a
 * host where git is fine and merely slow. `GIT_EXEC_TIMEOUT_MS` against a 9p
 * mount is not a hypothetical.
 *
 * `git-failure.ts` states the rule with the measured table behind it, and its
 * header says it is "AA2 one package over". This was one of the three call sites
 * in this package that the extraction did not reach.
 */
async function execGit(pi: ExtensionAPI, args: string[], cwd: string): Promise<string | null> {
  try {
    const result = await pi.exec("git", args, { cwd, timeout: GIT_EXEC_TIMEOUT_MS });
    return classifyGitFailure(result) ? null : result.stdout.trim();
  } catch {
    return null;
  }
}

/** Inline replacement for upstream's detectEnv — uses pi.exec for git detection. */
async function detectEnv(pi: ExtensionAPI, cwd: string): Promise<EnvInfo> {
  const gitRoot = await execGit(pi, ["rev-parse", "--is-inside-work-tree"], cwd);
  const isGitRepo = gitRoot === "true";
  const branch = isGitRepo ? await execGit(pi, ["branch", "--show-current"], cwd) : null;

  return {
    isGitRepo,
    branch,
    platform: process.platform,
  };
}

// ── runAgent phases ────────────────────────────────────────────────

// The rule lives in declared-resources.ts, next to the identical one for
// `extensions`/`skills`, because it is the same rule and because that module
// imports nothing and can therefore be tested. Re-exported so callers and probes
// keep the name they had.
export { resolveEffectiveSystemPromptMode } from "./declared-resources.ts";

function resolveSystemPromptSources(
  ctx: ExtensionContext,
  cwd: string,
  notify: (msg: string) => void,
  agentConfig: ReturnType<typeof getAgentConfig>,
): {
  mode: SystemPromptMode;
  includeEnvironment: boolean;
  extras: Pick<PromptExtras, "parentSystemPrompt" | "customSystemPrompt" | "contextFiles">;
} {
  const store = getStore();
  // Per-agent frontmatter overrides win; unset fields follow the global config.
  // Same precedence as createResourceLoader's extensions/skills, and resolved by
  // the same module — see declared-resources.ts for why the two belong together.
  const { systemPromptMode: mode, includeContextFiles, includeEnvironment } = declaredPromptSources(agentConfig, {
    includeContextFiles: store.agent.includeContextFiles,
    systemPromptMode: store.agent.systemPromptMode,
  });
  const extras: Pick<PromptExtras, "parentSystemPrompt" | "customSystemPrompt" | "contextFiles"> = {};

  if (mode === "inherit") {
    try {
      extras.parentSystemPrompt = ctx.getSystemPrompt();
    } catch (err) {
      notify(`Failed to get parent system prompt: ${err}. Falling back to replace mode.`);
    }
  }

  if (mode === "custom") {
    try {
      const content = fs.readFileSync(CUSTOM_PROMPT_PATH, "utf-8").trim();
      if (content) {
        extras.customSystemPrompt = content;
      } else {
        notify(`Custom prompt file is empty: ${CUSTOM_PROMPT_PATH}. Falling back to replace mode.`);
      }
    } catch (err: any) {
      if (err.code === "ENOENT") {
        notify(`Custom prompt file not found: ${CUSTOM_PROMPT_PATH}. Falling back to replace mode.`);
      } else {
        notify(`Failed to read custom prompt file: ${err.message}. Falling back to replace mode.`);
      }
    }
  }

  if (includeContextFiles) {
    try {
      extras.contextFiles = loadProjectContextFiles({ cwd, agentDir: getAgentDir() });
    } catch {
      // Non-fatal: context files are supplementary
    }
  }

  return { mode, includeEnvironment, extras };
}

function buildPrompt(
  type: SubagentType,
  agentConfig: ReturnType<typeof getAgentConfig>,
  config: ReturnType<typeof getConfig>,
  cwd: string,
  env: EnvInfo | undefined,
  systemPromptMode: SystemPromptMode = "replace",
  resolverExtras: Pick<PromptExtras, "parentSystemPrompt" | "customSystemPrompt" | "contextFiles"> = {},
): string {
  const extras: PromptExtras = { ...resolverExtras };
  if (Array.isArray(agentConfig?.preloadSkills)) {
    extras.skillBlocks = preloadSkills(agentConfig.preloadSkills, cwd);
  }
  // Same precedence as createResourceLoader: the agent's own `skills` wins over
  // getConfig()'s, which substitutes general-purpose's for a hidden type.
  const { skills } = declaredResources(agentConfig, config);
  if (Array.isArray(skills)) {
    extras.skillMetas = loadSkillMeta(skills, cwd);
  }
  if (agentConfig) {
    return buildAgentPrompt(agentConfig, cwd, env, extras, systemPromptMode);
  }
  const fallback = DEFAULT_AGENTS.get("general-purpose");
  if (!fallback) throw new Error(`No fallback config available for unknown type "${type}"`);
  return buildAgentPrompt({ ...fallback, name: type }, cwd, env, extras, systemPromptMode);
}

function buildExtToolMap(extensions: Array<{ path: string; tools: Map<string, unknown> }>) {
  const map = new Map<string, string[]>();
  for (const ext of extensions) {
    const name = extractExtensionName(ext.path);
    const tools = [...ext.tools.keys()];
    if (tools.length > 0) map.set(name, tools);
  }
  return map;
}

/** Filter extensions by name; invert=true removes matches (blacklist), false keeps them (whitelist). */
function filterExtensions(
  extensions: Array<{ path: string }>,
  names: Set<string>,
  invert: boolean,
): { filtered: Array<{ path: string }>; matched: Set<string> } {
  const matched = new Set<string>();
  const filtered = extensions.filter((ext) => {
    const pathName = extractExtensionName(ext.path).toLowerCase();
    const pkgName = extensionPackageName(ext.path);
    const hit = names.has(pathName) || (pkgName !== undefined && names.has(pkgName));
    if (hit) {
      matched.add(pathName);
      if (pkgName) matched.add(pkgName);
    }
    return hit !== invert;
  });
  return { filtered, matched };
}

/** Extension filter override; warns for requested names that matched nothing. */
function filterOverride(names: Set<string>, invert: boolean, notify?: (msg: string) => void) {
  return (result: any) => {
    const { filtered, matched } = filterExtensions(result.extensions, names, invert);
    for (const name of names) {
      if (!matched.has(name)) {
        notify?.(`extension "${name}" not found in loaded extensions`);
      }
    }
    return { ...result, extensions: filtered };
  };
}

export function buildExtOverride(
  extensions: true | string[] | false | undefined,
  /** `true` means "exclude every extension" — the `all`/`true` spelling of `exclude_extensions:`. */
  excludeExtensions?: true | string[],
  notify?: (msg: string) => void,
) {
  if (Array.isArray(extensions)) {
    // Whitelist entries may carry a /tool suffix; match on the extension name only.
    const allowedNames = new Set(
      extensions.map((ext) => {
        const slashIdx = ext.indexOf("/");
        return (slashIdx !== -1 ? ext.slice(0, slashIdx) : ext).toLowerCase();
      }),
    );
    return filterOverride(allowedNames, false, notify);
  }

  if (excludeExtensions) {
    // `exclude_extensions: all` — the same thing `extensions: false` says. An
    // empty allowlist is the shape that means "nothing"; see parseExcludeList.
    if (excludeExtensions === true) return filterOverride(new Set<string>(), false, notify);
    const excludeSet = new Set(excludeExtensions.map((n) => n.toLowerCase()));
    return filterOverride(excludeSet, true, notify);
  }

  return undefined;
}

function createResourceLoader(
  config: ReturnType<typeof getConfig>,
  agentConfig: ReturnType<typeof getAgentConfig>,
  cwd: string,
  systemPrompt: string,
  settingsManager: SettingsManager,
  notify?: (msg: string) => void,
) {
  // Forge fork: the agent's OWN declaration, not getConfig()'s — see
  // declared-resources.ts. getConfig routes a `hidden` type through
  // general-purpose, so `__verifier`'s `extensions: false` never arrived here
  // and the `extensions === false` branch below was unreachable code.
  const { extensions, skills } = declaredResources(agentConfig, config);
  const noSkills = skills === false || Array.isArray(skills) || Array.isArray(agentConfig?.preloadSkills);
  const agentDir = getAgentDir();
  const loaderOpts: ConstructorParameters<typeof DefaultResourceLoader>[0] = {
    cwd,
    agentDir,
    settingsManager,
    noExtensions: extensions === false,
    noSkills,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => systemPrompt,
    appendSystemPromptOverride: () => [],
    // Forge fork: the agent's own filter runs first, then the denial, which
    // cannot be opted out of by an agent file. See subagent-denylist.ts for why
    // it is keyed on path and not on the name upstream would use.
    extensionsOverride: withExtensionDenial(
      buildExtOverride(extensions, agentConfig?.excludeExtensions, notify),
    ),
    skillsOverride: withSkillDenial(undefined),
    // A child discovers its own extensions and never sees the parent's `-e`
    // flags, so anything under vendor/ is absent unless named here. Empty
    // unless SUBAGENT_EXTRA_EXTENSIONS says otherwise.
    //
    // `extensions: false` has to suppress these too, and that is not what the
    // loader does on its own: `noExtensions` only drops *discovered* paths —
    // `resource-loader.js:315` reads `noExtensions ? cliEnabledExtensions :
    // merge(...)`, and the additional paths ARE the cli set. So an agent that
    // declares no extensions (the `__verifier` judge does) still loaded and
    // bound every path in this list. That is not free: rtk's factory runs
    // `rtk --version` as a subprocess on load, so a judge call — one per
    // verified answer, on the slot the parent is waiting on — was paying for a
    // process spawn and a fistful of event handlers it can never use. Worse,
    // one of those paths is `vendor/pi-loop-mode`, whose handlers run against
    // the OPERATOR's loop state (see that package's FORK.md) — so a judge was
    // driving the operator's loop as well as costing a subprocess.
    //
    // `extensions` above is the agent's own declaration for exactly this
    // reason; reading it from `getConfig()` made this branch unreachable for
    // every hidden agent, which is all of them that set it.
    additionalExtensionPaths: extensions === false ? [] : subagentExtraExtensionPaths(),
  };
  const loader = new DefaultResourceLoader(loaderOpts);
  return {
    loader,
    reloadAndMap: async () => {
      await loader.reload();
      const extResult = loader.getExtensions();
      return { extResult, extToolMap: buildExtToolMap(extResult.extensions) };
    },
  };
}

async function initSession(
  ctx: ExtensionContext,
  options: RunOptions,
  agentConfig: ReturnType<typeof getAgentConfig>,
  type: SubagentType,
  cwd: string,
  loader: DefaultResourceLoader,
  extToolMap: Map<string, string[]>,
  settingsManager: SettingsManager,
): Promise<AgentSession> {
  const model = options.model ?? findModelInRegistry(agentConfig?.model, ctx.modelRegistry, ctx.model);
  const thinkingLevel = options.thinkingLevel ?? agentConfig?.thinkingLevel;
  const agentDir = getAgentDir();
  const sessionOpts: Parameters<typeof createAgentSession>[0] = {
    cwd,
    agentDir,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager,
    model,
    tools: resolveSessionAllowedTools({
      registeredTools: getToolNamesForType(type),
      tools: agentConfig?.tools,
      extToolMap,
    }),
    resourceLoader: loader,
  };
  if (thinkingLevel) sessionOpts.thinkingLevel = thinkingLevel;
  const result = await createAgentSession(sessionOpts);
  const session = result.session;
  patchRetryClassifier(session);

  // Inject max_tokens into provider payloads; spawn-time value wins over agent config.
  const maxTokens = options.maxTokens ?? agentConfig?.maxTokens;
  if (maxTokens != null && maxTokens > 0 && model) {
    const field = (model.compat as any)?.maxTokensField ?? "max_tokens";
    const origOnPayload = session.agent.onPayload;
    session.agent.onPayload = async (payload, m) => {
      const applied = origOnPayload ? ((await origOnPayload(payload, m)) ?? payload) : payload;
      const obj = typeof applied === "object" && applied && !Array.isArray(applied) ? applied : {};
      return { ...obj, [field]: maxTokens };
    };
  }

  return session;
}

async function createAndConfigureSession(
  ctx: ExtensionContext,
  options: RunOptions,
  agentConfig: ReturnType<typeof getAgentConfig>,
  type: SubagentType,
  cwd: string,
  loader: DefaultResourceLoader,
  extToolMap: Map<string, string[]>,
  settingsManager: SettingsManager,
  notify: (msg: string) => void,
): Promise<AgentSession> {
  const session = await initSession(ctx, options, agentConfig, type, cwd, loader, extToolMap, settingsManager);
  // Forge fork: handed over the moment it EXISTS, not once it is configured.
  //
  // This callback is the only handle anything outside gets on the session, and
  // both of its users are teardown: the manager assigns `record.execution.session`
  // (which `dispose()` / `removeRecord()` reach) and the verifier's judge captures
  // it for the `finally` that disposes it — the judge goes around `spawn()`, so
  // that `finally` is its whole cleanup.
  //
  // It used to be the LAST line of this function, below `bindExtensions` and the
  // tool filtering. V7 moved the judge's capture here from `result?.session` on
  // the strength of a claim that this fires "before bindExtensions returns"; it
  // did not, so the exit that claim names was still uncovered, and V7's
  // regression test is a source pin that asserts the capture is PRESENT and
  // cannot see where it sits. Now the claim is true. See W6 in
  // `context/design/subagents-loop-verifier-readers.md`.
  //
  // Nothing downstream of the callback reads the session's tools or name, and
  // attaching the output log earlier only means it captures more.
  options.onSessionCreated?.(session);
  const baseName = agentConfig?.name ?? type;
  session.setSessionName(options.agentId ? `${baseName}#${options.agentId.slice(0, SHORT_ID_LENGTH)}` : baseName);
  await session.bindExtensions({
    onError: (err) =>
      options.onToolActivity?.({
        type: "end",
        toolName: `extension-error:${err.extensionPath}`,
      }),
  });

  const filteredTools = resolveVisibleTools({
    activeTools: session.getActiveToolNames(),
    tools: agentConfig?.tools,
    excludeTools: agentConfig?.excludeTools,
    extToolMap,
    notify,
  });
  if (filteredTools) session.setActiveToolsByName(filteredTools);
  return session;
}

async function runTurnLoop(
  session: AgentSession,
  prompt: string,
  options: { signal?: AbortSignal } & RunCallbacks,
  unsubTurns: () => void,
) {
  const unsubEvents = subscribeToSessionEvents(session, options);
  const collector = collectResponseText(session, options.onTextDelta);
  const cleanupAbort = forwardAbortSignal(session, options.signal);
  try {
    // AB4. The forward above can only see aborts that have not happened yet, so
    // this is the half of the same question it cannot answer: was the run
    // already stopped before it got here? Throwing rather than aborting, because
    // `session.abort()` before `prompt()` is consumed by nothing and the prompt
    // would run regardless. The throw lands where a stop is already handled:
    // `attachSettlementChain`'s `.catch` (which leaves a "stopped" status alone),
    // and `verifyAnswer`'s catch, which is this layer's "the check did not
    // happen" path and keeps the child's answer.
    if (options.signal?.aborted) throw new Error(ABORTED_BEFORE_START);
    await session.prompt(prompt);
  } finally {
    unsubTurns();
    unsubEvents();
    collector.unsubscribe();
    cleanupAbort();
  }
  // Both sides are scoped to THIS run by the collector's own buffers, so
  // neither can surface an earlier run's text and neither depends on an index
  // into an array pi replaces on every compaction. See collectResponseText.
  return collector.getText().trim() || collector.getLastMessageText();
}

/**
 * Run a single prompt against a session: wire turn tracking, event
 * subscription, response collection, and abort forwarding, prompt, then
 * assemble the RunResult. Shared by the first run (runAgentImpl) and
 * continuations (continueAgentSession) so the two paths cannot drift.
 */
async function runSessionPrompt(
  session: AgentSession,
  prompt: string,
  options: SessionPromptOptions,
): Promise<RunResult> {
  const { unsubscribe: unsubTurns, getAborted, getTurnLimited } = wireTurnTracking(session, {
    maxTurns: options.maxTurns,
    // Resolved here rather than inside turn-tracking.ts: that module imports
    // nothing, and the default lives in config-io.ts, which imports pi.
    graceTurns: options.graceTurns ?? DEFAULT_GRACE_TURNS,
    onTurnEnd: options.onTurnEnd,
  });
  const responseText = await runTurnLoop(session, prompt, options, unsubTurns);
  return {
    responseText,
    session,
    aborted: getAborted(),
    turnLimited: getTurnLimited(),
    modelError: getFinalModelError(session),
  };
}

/**
 * Prompt an existing session after its original run settled (the fork's
 * continueAgentSession() shape).
 *
 * Unlike runAgent, the session already exists: onSessionCreated is never
 * called, and there is no session setup (model resolution, resource loader,
 * tool filtering). The result keeps the runAgent shape (including
 * modelError) so the manager classifies the continuation exactly like the
 * first run.
 */
export async function continueAgentSession(
  session: AgentSession,
  prompt: string,
  options: SessionPromptOptions = {},
): Promise<RunResult> {
  return runSessionPrompt(session, prompt, options);
}

// ── main entry ─────────────────────────────────────────────────────

export async function runAgent(
  ctx: ExtensionContext,
  type: SubagentType,
  prompt: string,
  options: RunOptions,
): Promise<RunResult> {
  // The spawn bracket is NOT here. See buildSubagentSession() below: it covers
  // extension loading and binding only, not the child's run.
  return runAgentImpl(ctx, type, prompt, options);
}

/**
 * Build a subagent's session inside the spawn bracket.
 *
 * The bracket exists so an extension factory re-loaded for a child can tell it
 * is being loaded into a subagent (`isInsideSubagentSpawn()`, published to other
 * packages as `__PI_SUBAGENT_SPAWN_DEPTH__`). Both things that need it happen
 * here: `reloadAndMap()` calls each extension's factory
 * (`resource-loader.js` → `loadFinalExtensionSet` → `loader.js:409 factory(api)`),
 * and `bindExtensions()` inside `createAndConfigureSession` registers the
 * handlers and emits `session_start`.
 *
 * Forge fork: it used to wrap the whole of `runAgentImpl`, which meant the depth
 * stayed above zero for the entire child run — minutes, for a background agent.
 * Anything that loaded an extension in that window was misread as a subagent:
 * an operator `/reload` (or any `session_start` with reason `reload`) while a
 * background subagent was in flight made THIS extension's own factory return
 * early, so the operator lost the Agent/StopAgent/AgentStatus tools and the
 * widget — and `vendor/pi-loop-mode` captured the flag permanently, so the
 * operator's loop never did its session housekeeping again. The flag answers
 * "is a subagent session being built right now", and the build is over once the
 * extensions are bound.
 */
async function buildSubagentSession(
  reloadAndMap: () => Promise<{ extToolMap: Map<string, string[]> }>,
  create: (extToolMap: Map<string, string[]>) => Promise<AgentSession>,
): Promise<AgentSession> {
  enterSubagentSpawn();
  try {
    const { extToolMap } = await reloadAndMap();
    return await create(extToolMap);
  } finally {
    exitSubagentSpawn();
  }
}

async function runAgentImpl(
  ctx: ExtensionContext,
  type: SubagentType,
  prompt: string,
  options: RunOptions,
): Promise<RunResult> {
  const store = getStore();
  const config = getConfig(type, store.agent.loadSkillsImplicitly, store.agent.loadExtensionsImplicitly);
  const agentConfig = getAgentConfig(type);

  // Buffer warnings during setup to avoid inserting custom_message entries
  // between tool_use and tool_result in the session tree (causes Anthropic 400).
  // Flushed after runTurnLoop completes.
  const warnings: string[] = [];
  const bufferNotify = (msg: string) => {
    warnings.push(msg);
  };
  if (agentConfig?.excludeTools && Array.isArray(agentConfig.tools)) {
    bufferNotify(`agent "${type}": both tools and exclude_tools set — tools (whitelist) wins`);
  }
  if (agentConfig?.excludeExtensions && Array.isArray(agentConfig.extensions)) {
    bufferNotify(`agent "${type}": both extensions and exclude_extensions set — extensions (whitelist) wins`);
  }

  const effectiveCwd = options.cwd ?? ctx.cwd;

  // One SettingsManager for the whole spawn: its trust state gates both the
  // resource loader (project extensions/skills/prompts/themes/system prompt
  // files) and the session context (ctx.isProjectTrusted).
  const settingsManager = SettingsManager.create(effectiveCwd, getAgentDir(), {
    projectTrusted: options.projectTrusted !== false,
  });

  const { mode, includeEnvironment, extras: promptExtras } = resolveSystemPromptSources(
    ctx,
    effectiveCwd,
    bufferNotify,
    agentConfig,
  );

  // Two git subprocesses, ~100 ms on this box's 9p mount, per spawn — and the
  // verifier's judge, which runs once per verified delegation on the slot the
  // parent is blocked on, has no working tree to describe. Detected only when
  // the prompt is actually going to say so.
  const env = includeEnvironment ? await detectEnv(options.pi, effectiveCwd) : undefined;

  const systemPrompt = buildPrompt(type, agentConfig, config, effectiveCwd, env, mode, promptExtras);
  const { loader, reloadAndMap } = createResourceLoader(
    config,
    agentConfig,
    effectiveCwd,
    systemPrompt,
    settingsManager,
    bufferNotify,
  );
  const session = await buildSubagentSession(reloadAndMap, (extToolMap) =>
    createAndConfigureSession(
      ctx,
      options,
      agentConfig,
      type,
      effectiveCwd,
      loader,
      extToolMap,
      settingsManager,
      bufferNotify,
    ),
  );
  const result = await runSessionPrompt(session, prompt, {
    ...options,
    maxTurns: options.maxTurns ?? agentConfig?.maxTurns,
  });

  // Flush buffered warnings now that tool_result is in the session tree.
  for (const msg of warnings) {
    if (ctx.ui?.notify) ctx.ui.notify(`[pi-subagents-lite] ${msg}`, "warning");
    else console.warn(`[pi-subagents-lite] ${msg}`);
  }

  return result;
}
