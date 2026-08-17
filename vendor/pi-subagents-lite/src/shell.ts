/**
 * shell.ts — Composition root shell.
 *
 * Per ADR 0004, the single mutable container for all per-session state,
 * created at session_start, disposed at session_shutdown. Handler modules
 * read via getter functions — no module-level mutable globals.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentManager } from "./agents/agent-manager.js";
import type { AgentWidget } from "./ui/agent-widget.js";
import type { SpawnCoordinator } from "./spawn/spawn-coordinator.js";
import { ConfigStore } from "./config/config-store.js";

// --- Shell type ---

interface Shell {
  pi: ExtensionAPI;
  sessionCtx: ExtensionContext;
  manager: AgentManager | null;
  widget: AgentWidget | null;
  store: ConfigStore;
  coordinator: SpawnCoordinator | null;
}

// --- Mutable module-level shell (populated by index.ts at session_start) ---

const shell: Shell = {
  pi: null!,
  sessionCtx: null!,
  manager: null,
  widget: null,
  store: new ConfigStore(),
  coordinator: null,
};

// --- Getter functions (read current state at call time) ---

/** Set at init time. */
export function getPiInstance(): ExtensionAPI {
  return shell.pi;
}

/** Set at session_start. */
export function getSessionCtx(): ExtensionContext {
  return shell.sessionCtx;
}

/** Null until created at session_start. */
export function getManager(): AgentManager | null {
  return shell.manager;
}

/** Null until created at session_start. */
export function getWidget(): AgentWidget | null {
  return shell.widget;
}

/** Lives for the lifetime of the extension. */
export function getStore(): ConfigStore {
  return shell.store;
}

/** Null until created at session_start. */
export function getCoordinator(): SpawnCoordinator | null {
  return shell.coordinator;
}

// --- Setter functions (called by index.ts to populate the shell) ---

export function setPiInstance(pi: ExtensionAPI): void {
  shell.pi = pi;
}

export function setSessionCtx(ctx: ExtensionContext): void {
  shell.sessionCtx = ctx;
}

export function setManager(m: AgentManager | null): void {
  shell.manager = m;
}

export function setWidget(w: AgentWidget | null): void {
  shell.widget = w;
}

export function setCoordinator(c: SpawnCoordinator | null): void {
  shell.coordinator = c;
}

// --- Subagent spawn context ---

/**
 * Nesting depth of in-flight subagent spawns. Subagent re-loads of this
 * extension would clobber parent-owned shell singletons; the factory checks
 * this flag and stays inert while a subagent is spawning.
 */
let subagentSpawnDepth = 0;

/**
 * Forge fork: the same depth, published where a package that cannot import this
 * one can see it.
 *
 * A subagent's session is created in the parent's process and binds the
 * parent's extensions, and node's module cache means those extensions'
 * module-level state is the SAME state — that is the entire reason
 * `isInsideSubagentSpawn()` works at all, since the child's factory reads a
 * counter the parent incremented. Every other extension in this stack has the
 * same exposure and no way to detect it: `vendor/pi-loop-mode` keeps its whole
 * loop in module scope, and its `session_start` handler clears the pending
 * timer and reloads state from the session's own branch. Fired inside a
 * subagent, that silently killed the operator's running loop.
 *
 * A global rather than an import because vendor packages must not depend on
 * each other — pi-loop-mode is a fork of an upstream package that knows nothing
 * about subagents, and one global read is a smaller wound than a cross-vendor
 * import. Read it as "a subagent session is being built right now"; anything
 * doing session-lifecycle housekeeping should sit that one out.
 */
const SPAWN_DEPTH_GLOBAL = "__PI_SUBAGENT_SPAWN_DEPTH__";

function publishSpawnDepth(): void {
  try {
    (globalThis as unknown as Record<string, unknown>)[SPAWN_DEPTH_GLOBAL] = subagentSpawnDepth;
  } catch {
    // A frozen global is not a reason to fail a spawn.
  }
}

export function enterSubagentSpawn(): void {
  subagentSpawnDepth++;
  publishSpawnDepth();
}

export function exitSubagentSpawn(): void {
  if (subagentSpawnDepth > 0) subagentSpawnDepth--;
  publishSpawnDepth();
}

/** True while a subagent is being spawned (factory/session_start run in subagent context). */
export function isInsideSubagentSpawn(): boolean {
  return subagentSpawnDepth > 0;
}
