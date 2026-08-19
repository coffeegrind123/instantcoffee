/**
 * declared-resources.ts — Forge fork. Which `extensions` / `skills` declaration
 * actually governs a spawn.
 *
 * ## The bug this exists for
 *
 * `runAgentImpl` holds two views of an agent, and they are not interchangeable:
 *
 * - `getAgentConfig(type)` — the agent's OWN frontmatter, verbatim.
 * - `getConfig(type, …)`   — the RESOLVED config, with the global implicit-load
 *   defaults filled in for anything the agent left undeclared.
 *
 * The resolved one is the right thing to read, except that `getConfig` resolves
 * through `findActiveConfig()` (`agent-types.ts`), which substitutes
 * **general-purpose** for any agent marked `hidden`. That flag means "do not
 * offer this type to the model" — it exists here so `__verifier` stays out of
 * the `Agent` tool's enum, worth 11 chars of schema — and it was never meant to
 * change what the agent loads. It did:
 *
 *     getAgentConfig("__verifier").extensions  →  false     (as declared)
 *     getConfig("__verifier").extensions       →  true      (general-purpose's)
 *
 * So the one agent in the tree documented as "no tools, no extensions, no
 * skills" was built with general-purpose's declarations, and
 * `createResourceLoader`'s `extensions === false ? [] : subagentExtraExtensionPaths()`
 * — written specifically to stop this — could never fire. Every judge call
 * therefore loaded and bound `vendor/pi-loop-mode` and `vendor/rtk-pi`, the
 * second of which runs `rtk --version` as a subprocess on load, on the one llama
 * slot the parent is blocked on. `tools: false` was unaffected, because that is
 * read from `getAgentConfig` directly, which is why the judge genuinely had no
 * tools and the problem stayed invisible.
 *
 * ## The rule
 *
 * The agent's own declaration wins; the resolved config supplies the global
 * default for anything it does not declare. For every non-hidden agent this is
 * exactly what `getConfig` already returned — `applyGlobalDefaults` only fills
 * `undefined` — so this changes nothing for them. For a hidden agent it is the
 * difference between running as declared and running as something else.
 */

import type { AgentConfig, SystemPromptMode } from "./types.js";

/** The two resource switches, after precedence is applied. */
export interface DeclaredResources {
  extensions: true | string[] | false;
  skills: true | string[] | false;
}

/** Shape of the resolved config this needs; narrower than ResolvedAgentConfig on purpose. */
export interface ResolvedResourceDefaults {
  extensions: true | string[] | false;
  skills: true | string[] | false;
}

/**
 * Resolve `extensions` / `skills` for a spawn.
 *
 * `agentConfig` is the agent's own frontmatter (may be undefined for an unknown
 * type); `resolved` is `getConfig()`'s output, which already carries the global
 * implicit-load defaults.
 */
export function declaredResources(
  agentConfig: Pick<AgentConfig, "extensions" | "skills"> | undefined,
  resolved: ResolvedResourceDefaults,
): DeclaredResources {
  return {
    extensions: agentConfig?.extensions ?? resolved.extensions,
    skills: agentConfig?.skills ?? resolved.skills,
  };
}

/**
 * The registered-tool list an agent declared, or undefined when it declared none.
 *
 * Forge fork: the caller's test was `config?.registeredTools?.length ? … :
 * defaults`, and `[].length` is 0 — so an agent that explicitly declared an
 * EMPTY allowlist got the four default tools, the opposite of what it asked for.
 * `__verifier` declares `registeredTools: []` and was saved only by `tools:
 * false`, which is honoured first everywhere it matters; the declaration a
 * reader takes as load-bearing was inert.
 *
 * `Array.isArray` rather than truthiness, because the field is not always an
 * array. `agent-discovery.ts` assigns `registeredTools: md.tools`, and `tools` in
 * frontmatter may be `true` or `false`. Neither is a list of names, spreading
 * `true` throws, and both already meant "not declared" under the old test — so
 * this preserves every existing outcome and only stops `[]` reading as absence.
 */
export function declaredRegisteredTools(
  agentConfig: Pick<AgentConfig, "registeredTools"> | undefined,
): string[] | undefined {
  const declared = agentConfig?.registeredTools as unknown;
  return Array.isArray(declared) ? [...(declared as string[])] : undefined;
}

// ── The same rule, for the two switches that decide the system PROMPT ────────
//
// `extensions` and `skills` decide what a session can DO; `includeContextFiles`
// and `includeSystemPrompt` decide what it is TOLD. They follow the identical
// precedence — the agent's own declaration wins, the global default fills what
// it leaves undeclared — and they lived in `agent-runner.ts`, which imports pi
// and therefore cannot be loaded by the test suite. That is why nobody noticed
// that `__verifier`, the one agent whose entire design argument is "it is harder
// to fool because it knows less", declared five switches and silently inherited
// these two. `includeContextFiles` defaults to TRUE, so the judge was handed
// every AGENTS.md / CLAUDE.md from cwd up to "/" inside `<project_context>` —
// 571 → 6,543 chars of system prompt, measured with the real builder.
//
// Moved here so the rule sits in one place and is testable without pi. This is
// the same move `turn-tracking.ts` made for the turn ceiling, for the same
// reason.

/** The prompt-composition switches, after precedence is applied. */
export interface DeclaredPromptSources {
  /** Whether AGENTS.md / CLAUDE.md from the cwd's ancestry go into the prompt. */
  includeContextFiles: boolean;
  /** Which system prompt the agent runs on. */
  systemPromptMode: SystemPromptMode;
  /**
   * Whether to build and include the "# Environment" block. Agent-only — there
   * is no global setting, because every agent that touches a working tree wants
   * it and the one that does not says so.
   */
  includeEnvironment: boolean;
}

/** The global settings these fall back to, from `store.agent`. */
export interface ResolvedPromptDefaults {
  includeContextFiles: boolean;
  systemPromptMode: SystemPromptMode;
}

/**
 * Effective system prompt mode for an agent: the global mode overridden by the
 * agent's `include_system_prompt` frontmatter field.
 *
 * - false → replace (never inherit or custom)
 * - true → inherit, except when the global mode is custom (custom wins)
 * - undefined → the global mode
 */
export function resolveEffectiveSystemPromptMode(
  globalMode: SystemPromptMode,
  includeSystemPrompt: boolean | undefined,
): SystemPromptMode {
  if (includeSystemPrompt === false) return "replace";
  if (includeSystemPrompt === true && globalMode !== "custom") return "inherit";
  return globalMode;
}

/**
 * Resolve the prompt sources for a spawn.
 *
 * `agentConfig` is the agent's own frontmatter (may be undefined for an unknown
 * type); `globals` is `store.agent`'s pair.
 */
export function declaredPromptSources(
  agentConfig: Pick<AgentConfig, "includeContextFiles" | "includeSystemPrompt" | "includeEnvironment"> | undefined,
  globals: ResolvedPromptDefaults,
): DeclaredPromptSources {
  return {
    includeContextFiles: agentConfig?.includeContextFiles ?? globals.includeContextFiles,
    systemPromptMode: resolveEffectiveSystemPromptMode(globals.systemPromptMode, agentConfig?.includeSystemPrompt),
    includeEnvironment: agentConfig?.includeEnvironment ?? true,
  };
}
