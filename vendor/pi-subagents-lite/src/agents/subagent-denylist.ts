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
 * ## The two routes, and which one this file governs
 *
 * A child inherits none of the parent's `-e` flags. It builds its own
 * `DefaultResourceLoader`, and extensions reach it by exactly two routes:
 *
 *   route A — DISCOVERY.  `~/.pi/agent/extensions/**` and `<cwd>/.pi/extensions/**`,
 *             when the project is trusted. Everything in this repo's own
 *             `.pi/extensions/` therefore reaches a subagent for free, and
 *             nothing in this file can stop it arriving — the denial below can
 *             only filter it back out after the loader has found it.
 *   route B — `additionalExtensionPaths`, i.e. `subagentExtraExtensionPaths()`
 *             below. Everything under `vendor/` is invisible to a child unless
 *             it is named there.
 *
 * The ledger below is entirely about route B, and that is the file's blind spot:
 * it prices `pi-loop-mode`'s `loop` tool at ~177 tokens/turn of a child's window
 * and removes it, while `.pi/extensions/stack.ts` was arriving by route A with
 * `stack_status` at ~173 tokens/turn and nobody had counted it (U9's sibling,
 * U7). The repair there was a factory guard in `stack.ts` itself — the same
 * `__PI_SUBAGENT_SPAWN_DEPTH__` check this package's own factory uses — because
 * a guard at the source cannot be defeated by a path that moves, and because a
 * path fragment naming this checkout's layout is exactly the mistake the prinny
 * pattern above was rewritten to stop making.
 *
 * `tests/subagent-denylist.test.ts` carries the standing check: every entry point
 * under `.pi/extensions/` that registers a model-visible tool must guard itself.
 *
 * ## What is deliberately NOT denied
 *
 * `compaction-guard` stays, and reaches the child by route A — a live run showed
 * it capping the *child's* own `read` result at 9,778 → 8,176 chars inside the
 * child session. A child that blows its own window is a child that returns
 * nothing. `browser-guard` stays for the same reason: it registers no tools and
 * only ever rewrites the text of a browser call that already failed.
 *
 * `rtk-pi` is not denied either; it is the opposite problem. A child cannot see
 * it at all, because this stack loads it by `-e` from `vendor/` and a child
 * discovers rather than inherits. It is put back deliberately — see
 * `defaultExtraExtensionPaths` below.
 *
 * `pi-loop-mode` was put back the same way and no longer is, for a reason that
 * is neither denial nor discovery: its state is module-global, so a child's copy
 * drove the operator's loop. `defaultExtraExtensionPaths` has the measurements.
 * What keeps a looping child safe, if one is ever loaded again, is the turn
 * bound in `turn-tracking.ts` — see DEFAULT_MAX_TURNS there, and `StopAgent` for
 * the parent's kill switch.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Directory names that disqualify an extension from loading in a subagent.
 *
 * Keyed on the PACKAGE directory, not on where this checkout happens to keep it.
 * The rule used to be the literal fragment `/vendor/prinny-channel/`, which is
 * only true while the package sits in this tree's `vendor/`. Move it and the
 * denial matches nothing, silently in both directions — no warning that it
 * matched nothing, and no signal in the child that it now has Matrix. Two moves
 * are entirely ordinary:
 *
 *   - `npm i` puts it at `node_modules/pi-prinny-channel/…` (that IS the
 *     package's name — see its package.json), which the old fragment misses and
 *     a bare `prinny-channel/` fragment would also miss, because the segment is
 *     prefixed;
 *   - dropping it in `~/.pi/agent/extensions/prinny-channel/` is worse, because
 *     that is a DISCOVERY directory: a child picks it up on its own initiative,
 *     and this denial is the only thing between a subagent and posting to a room.
 *
 * So the match is on a path SEGMENT that is `prinny-channel` with an optional
 * package prefix (`pi-`, a scope directory, …), which covers every layout above
 * and still does not fire on an unrelated `my-prinny-channel-notes/`.
 */
const DENIED_EXTENSION_DIR_PATTERNS = [/(?:^|\/)(?:[a-z0-9._@-]*-)?prinny-channel\//];

/** Skill names a subagent never sees, matched case-insensitively. */
const DENIED_SKILL_NAMES = new Set(["prinny-access", "prinny-configure"]);

function normalize(p: string): string {
  // Windows separators too, so a denial cannot be defeated by path shape alone.
  return p.replace(/\\/g, "/").toLowerCase();
}

/** True when this extension path is denied to subagents. */
export function isDeniedExtensionPath(extPath: string): boolean {
  const p = normalize(String(extPath ?? ""));
  return DENIED_EXTENSION_DIR_PATTERNS.some((pattern) => pattern.test(p));
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
 * rather than the only thing between a subagent and Matrix.
 *
 * So this list puts back what a child should have had — `rtk-pi`, and see
 * `defaultExtraExtensionPaths` for why that one and why `pi-loop-mode` is no
 * longer with it. `SUBAGENT_EXTRA_EXTENSIONS` replaces the list entirely — comma
 * or colon separated absolute paths, or the empty string for none. It is not
 * free: an extension costs schema in the child's window, and a bigger child
 * prefix is precisely what evicts the parent's from the one slot.
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
 * - **rtk-pi.** Measured absent and it should not be: a subagent handed `bash`
 *   ran `git status --short` unrewritten, so its output reached the child's
 *   window uncompressed. The child is the session that can least afford it —
 *   its whole value is coming back with a small answer. It has no module-level
 *   state, so a second instance in a child is genuinely independent.
 *
 * **`pi-loop-mode` used to be here, and was removed.** The intent was right — a
 * bounded loop belongs in a window that is not the operator's — but that package
 * keeps its entire loop in module scope, and a child binds *the same module*
 * with its own event bus. So every one of its thirteen handlers ran a second
 * time per delegation against the operator's single `LoopState`. Measured: the
 * child's system prompt gained the operator's goal and "never stop on your own",
 * the child's `agent_end` drove the operator's iteration ladder and had the
 * operator's next loop turn delivered into the child, and a child that compacted
 * had its conversation replaced by the operator's loop handoff summary. See that
 * package's factory guard and FORK.md.
 *
 * Removing it is not only a safety fix: the `loop` tool costs a child ~177
 * tokens of schema on every turn, which is the child's window, and no subagent
 * was ever observed calling it.
 *
 * It goes back the moment `pi-loop-mode` keys its state by session instead of by
 * module. Its factory guard makes it inert in a child until then, so naming it
 * in `SUBAGENT_EXTRA_EXTENSIONS` is safe — it just does nothing.
 *
 * `vendor/prinny-channel` is deliberately not here, and could not be added if
 * someone tried: the denial above filters this list too.
 */
function defaultExtraExtensionPaths(): string[] {
  // vendor/pi-subagents-lite/src/agents → up four is the repo root.
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
  return [path.join(repoRoot, "vendor", "rtk-pi", "extensions", "index.ts")];
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
