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

import type { AgentConfig } from "./types.js";

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
