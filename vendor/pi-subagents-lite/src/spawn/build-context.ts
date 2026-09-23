/**
 * build-context.ts — Forge fork. Whether a subagent being built may delegate,
 * and to what.
 *
 * The runner asks `nestedDepthFor` about the session it is building and, when
 * the answer is a depth, gives that child's resource loader an inline factory
 * that registers `SubAgent` (agent-runner.ts, registration.ts). A child never
 * loads this extension from its path, so nothing in index.ts can decide it.
 *
 * Imports nothing from pi, so tests load it directly (tests/nesting.test.ts).
 */

export interface BuildContext {
  /** Depth of the session being built. Infinity = not a spawn (the judge). */
  depth: number;
  /** Agent type being built — decides what it may spawn in turn. */
  type: string;
}

/** The deepest nesting this fork supports: the operator's children, and theirs. */
export const MAX_SUPPORTED_DEPTH = 2;

/**
 * SUBAGENT_MAX_DEPTH: 1 (default) or 2. Anything else is 1 — a typo must not
 * silently hand every child a spawn tool.
 */
export function maxDepth(env: Record<string, string | undefined> = process.env): number {
  const raw = env.SUBAGENT_MAX_DEPTH;
  if (!raw || !/^[0-9]+$/.test(raw)) {
    return 1;
  }
  const n = Number(raw);
  return n >= 1 && n <= MAX_SUPPORTED_DEPTH ? n : 1;
}

/** The depth of a build that gets `SubAgent`, or null when it gets nothing. */
export function nestedDepthFor(build: BuildContext | null, limit: number): number | null {
  if (!build || build.depth >= limit) {
    return null;
  }
  return build.depth;
}

const WRITE_TOOLS = ["edit", "write"];

/** A declared whitelist with neither edit nor write, or no tools at all. */
export function isReadOnlyTools(tools: true | string[] | false | undefined): boolean {
  if (tools === false) {
    return true;
  }
  return Array.isArray(tools) && !tools.some((t) => WRITE_TOOLS.includes(t));
}

/** Delegation never widens a subtree: a read-only caller spawns read-only types only. */
export function mayNest(
  callerTools: true | string[] | false | undefined,
  targetTools: true | string[] | false | undefined,
): boolean {
  return !isReadOnlyTools(callerTools) || isReadOnlyTools(targetTools);
}

/**
 * The tool list a type actually runs with: its declared `tools` whitelist when
 * there is one, nothing for `tools: false`, otherwise its registered set. The
 * built-in Explore restricts itself through the registered set and leaves
 * `tools` unset, so reading `tools` alone would call it a writer.
 */
export function effectiveTools(
  tools: true | string[] | false | undefined,
  registered: string[],
): string[] {
  if (tools === false) {
    return [];
  }
  return Array.isArray(tools) ? tools : registered;
}
