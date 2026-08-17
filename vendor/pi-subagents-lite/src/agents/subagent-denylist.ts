/**
 * subagent-denylist.ts — Forge fork. What a subagent is never allowed to load.
 *
 * ## Why this is not upstream's `excludeExtensions`
 *
 * Upstream can already exclude an extension, but only **by name**, and in this
 * checkout the names do not distinguish the things that matter. Verified rather
 * than assumed, against this exact tree:
 *
 * - `extractExtensionName()` derives the name from the path. For
 *   `vendor/prinny-channel/extensions/index.ts` the segment after `extensions`
 *   is `index.ts`, so it takes the basename and the name is **`index`** —
 *   identical to `vendor/pi-loop-mode/extensions/index.ts` and
 *   `vendor/rtk-pi/extensions/index.ts`. Excluding `index` would remove all
 *   three; excluding `prinny` would match nothing.
 * - `resolvePackageShortName()` would give a real name, but only when the
 *   package's `pi.extensions` manifest lists the entry file. prinny's says
 *   `["extensions"]` — the directory — so the resolve fails and returns
 *   undefined. `pi-prinny-channel` is therefore not a name anything can match.
 *
 * So the denial is keyed on **path**, which is the thing that is actually
 * unambiguous here.
 *
 * ## Why it is unconditional
 *
 * `excludeExtensions` lives in an agent's own `.md` frontmatter, which means a
 * new agent file silently opts back in. "A subagent can send Matrix messages"
 * is not a per-agent preference to get wrong once: the `prinny` tool posts to a
 * room, and a subagent is a thing the model spawns on its own initiative with a
 * prompt the operator never sees. This list applies to every subagent of every
 * type, before any agent config is consulted.
 *
 * The skills go with it for a plainer reason: `prinny-access` and
 * `prinny-configure` document how to approve senders and set channel policy.
 * They are instructions for the operator's session, they cost context in a
 * window that is not the operator's, and they describe a tool the child does
 * not have.
 *
 * ## What is deliberately NOT denied
 *
 * `compaction-guard` stays, and reaches the child on its own because it lives
 * under `.pi/extensions/` — a live run showed it capping the *child's* own
 * `read` result at 9,778 → 8,176 chars inside the child session. A child that
 * blows its own window is a child that returns nothing.
 *
 * `pi-loop-mode` and `rtk-pi` are not denied either; they are the opposite
 * problem. A child cannot see them at all, because this stack loads them by
 * `-e` from `vendor/` and a child discovers rather than inherits. They are put
 * back deliberately — see `defaultExtraExtensionPaths` below. What keeps a
 * looping child safe is the turn bound in `agent-runner.ts`, not exclusion:
 * see DEFAULT_MAX_TURNS there, and `StopAgent` for the parent's kill switch.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Path fragments that disqualify an extension from loading in a subagent. */
const DENIED_EXTENSION_PATH_FRAGMENTS = ["/vendor/prinny-channel/"];

/** Skill names a subagent never sees, matched case-insensitively. */
const DENIED_SKILL_NAMES = new Set(["prinny-access", "prinny-configure"]);

function normalize(p: string): string {
  // Windows separators too, so a denial cannot be defeated by path shape alone.
  return p.replace(/\\/g, "/").toLowerCase();
}

/** True when this extension path is denied to subagents. */
export function isDeniedExtensionPath(extPath: string): boolean {
  const p = normalize(String(extPath ?? ""));
  return DENIED_EXTENSION_PATH_FRAGMENTS.some((fragment) => p.includes(fragment));
}

/** True when this skill is denied to subagents. */
export function isDeniedSkillName(name: unknown): boolean {
  return typeof name === "string" && DENIED_SKILL_NAMES.has(name.trim().toLowerCase());
}

/**
 * Extensions to hand a subagent that it would not otherwise get.
 *
 * A child does not inherit the parent's `-e` flags. It builds its own
 * `DefaultResourceLoader`, which *discovers* extensions — so everything under
 * `.pi/extensions/` reaches a subagent (that is why the compaction guard is
 * active in the child) and everything under `vendor/`, which this stack loads
 * by absolute path, does not. Measured: a subagent reported 12 tools and one
 * skill, none of them from `vendor/`.
 *
 * That is the right default, and it is why the denial above is belt-and-braces
 * rather than the only thing between a subagent and Matrix. But it also means
 * `/loop` is unavailable to a child, and a bounded loop in a window that is not
 * the parent's is worth having: `AgentSession.prompt()` expands commands, so a
 * child handed `/loop <goal>` would run a real one.
 *
 * So this list puts back what a child should have had. It defaults to
 * `pi-loop-mode` and `rtk-pi` (see `defaultExtraExtensionPaths` for why each),
 * and `SUBAGENT_EXTRA_EXTENSIONS` replaces it entirely — comma or colon
 * separated absolute paths, or the empty string for none. It is not free: an
 * extension costs schema in the child's window, and a bigger child prefix is
 * precisely what evicts the parent's from the one slot.
 *
 * Denied paths are filtered out of this list too, so it cannot be used to give
 * back what the denial above just took away.
 */
export function subagentExtraExtensionPaths(
  env: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = fs.existsSync,
): string[] {
  const raw = env.SUBAGENT_EXTRA_EXTENSIONS;
  const requested =
    typeof raw === "string"
      ? raw.split(/[,:]/).map((entry) => entry.trim()).filter((entry) => entry !== "")
      : defaultExtraExtensionPaths();

  return requested.filter((entry) => {
    if (isDeniedExtensionPath(entry)) return false;
    // A path that is not there is a silent no-op inside pi's loader. Say it
    // once, here, rather than leaving someone to wonder why a subagent has no
    // /loop — this list is normally right and wrong loudly.
    if (!exists(entry)) {
      console.warn(`[pi-subagents-lite] subagent extension not found, skipping: ${entry}`);
      return false;
    }
    return true;
  });
}

/**
 * What a subagent gets by default, resolved relative to this checkout.
 *
 * Both are things the parent has and a child has no way to inherit, and both
 * were asked for by name:
 *
 * - **pi-loop-mode.** A subagent is where a loop belongs — it grinds in a window
 *   that is not the operator's, and `DEFAULT_MAX_TURNS` in agent-runner.ts stops
 *   it whether or not the goal is met.
 * - **rtk-pi.** Measured absent and it should not be: a subagent handed `bash`
 *   ran `git status --short` unrewritten, so its output reached the child's
 *   window uncompressed. The child is the session that can least afford it —
 *   its whole value is coming back with a small answer.
 *
 * `vendor/prinny-channel` is deliberately not here, and could not be added if
 * someone tried: the denial above filters this list too.
 */
function defaultExtraExtensionPaths(): string[] {
  // vendor/pi-subagents-lite/src/agents → up four is the repo root.
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
  return [
    path.join(repoRoot, "vendor", "pi-loop-mode", "extensions", "index.ts"),
    path.join(repoRoot, "vendor", "rtk-pi", "extensions", "index.ts"),
  ];
}

/**
 * Wrap an extensions override so the denial always runs, and runs last.
 *
 * `inner` is whatever the agent's own config asked for (a whitelist, an
 * exclude list, or nothing). Composing rather than replacing means an agent
 * file can still narrow its extensions; it just cannot widen them back to
 * include a denied one.
 */
export function withExtensionDenial<T extends { extensions: Array<{ path: string }> }>(
  inner: ((base: T) => T) | undefined,
): (base: T) => T {
  return (base: T) => {
    const afterInner = inner ? inner(base) : base;
    const kept = afterInner.extensions.filter((ext) => !isDeniedExtensionPath(ext.path));
    if (kept.length === afterInner.extensions.length) return afterInner;
    return { ...afterInner, extensions: kept };
  };
}

/** Same, for skills. */
export function withSkillDenial<T extends { skills: Array<{ name?: unknown }> }>(
  inner: ((base: T) => T) | undefined,
): (base: T) => T {
  return (base: T) => {
    const afterInner = inner ? inner(base) : base;
    const kept = afterInner.skills.filter((skill) => !isDeniedSkillName(skill?.name));
    if (kept.length === afterInner.skills.length) return afterInner;
    return { ...afterInner, skills: kept };
  };
}
