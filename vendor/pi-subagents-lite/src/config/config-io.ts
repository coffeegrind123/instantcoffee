/**
 * config-io.ts — Config persistence (read/write) with override layers.
 *
 * Atomic writes: write to .tmp then rename.
 * Loaded at session_start; saved on every /agents menu mutation.
 *
 * Two layers (ADR-0008): the global file ~/.pi/agent/subagents-lite.json and a
 * trusted project's .pi/subagents-lite.json. The project layer may carry only
 * model and concurrency keys; the effective config merges project over global
 * over built-in defaults. Each file stores only its own keys; the merged
 * config is never written back. Unknown project keys are ignored with a
 * warning (and preserved for write-back); a malformed project file is never
 * overwritten. See docs/adr/0008-project-config-as-override-layer.md.
 */
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { SubagentsConfig } from "../models/model-precedence.js";
import { CONFIG_AGENT_NON_MODEL_KEYS } from "./types.js";
import {
  isPlainObject,
  quarantine,
  readJsonObject,
  writeJsonAtomic,
  type LayerStatus,
} from "./json-store.ts";

/** File name of the config in both the global agent dir and a project's .pi dir. */
const CONFIG_FILE_NAME = "subagents-lite.json";
const CONFIG_DIR = getAgentDir();
const CONFIG_PATH = path.join(CONFIG_DIR, CONFIG_FILE_NAME);
/** Path to custom prompt file for subagent system prompts. */
export const CUSTOM_PROMPT_PATH = path.join(CONFIG_DIR, "subagents-lite-prompt.md");
/** Default number of grace turns before an agent is force-stopped. */
export const DEFAULT_GRACE_TURNS = 6;
/** Default watchdog timeout (tool and idle) in minutes. 0 disables a check. */
export const DEFAULT_WATCHDOG_TIMEOUT_MINUTES = 45;
/** Minimum finished retention: 1 second expressed in minutes. */
export const MIN_FINISHED_RETENTION_MINUTES = 1 / 60;

export const VALID_SYSTEM_PROMPT_MODES = new Set<string>(["replace", "inherit", "custom"]);

/**
 * Default concurrency config — the effective default, and what a reset restores.
 *
 * Forge fork: upstream's 4 → 1, for the reasons measured in
 * `agents/agent-manager.ts` — read that comment before changing this number.
 *
 * This is the ONLY place the number lives; the manager's own
 * `DEFAULT_CONCURRENCY_LIMIT` is read from here. That matters because this
 * object is always merged into the loaded config (see `applyDefaults` below) and
 * is always what the manager is constructed with, so a second copy in the
 * manager was silently unreachable: it said 1 while this said 4, and 4 is what
 * every session ran with — four children against PARALLEL_SLOTS=1.
 *
 * Raise both together if PARALLEL_SLOTS goes up. Per-provider overrides
 * (`concurrency.providers.forge`) still apply and need no code change.
 */
export const DEFAULT_CONCURRENCY: SubagentsConfig["concurrency"] = { default: 1 };

/** Default agent settings — merged into loaded config so callers get a complete shape. */
export const DEFAULT_AGENT: SubagentsConfig["agent"] = {
  default: null,
  forceBackground: false,
  graceTurns: DEFAULT_GRACE_TURNS,
  widgetMaxLines: 12,
  toolTimeoutMinutes: DEFAULT_WATCHDOG_TIMEOUT_MINUTES,
  idleTimeoutMinutes: DEFAULT_WATCHDOG_TIMEOUT_MINUTES,

  widgetCompact: false,
  showCompletionCards: true,
  widgetShortcut: false,
  widgetShowModel: true,
  widgetShowThinking: true,
  widgetNavHint: true,
  systemPromptMode: "replace",
  includeContextFiles: true,
  disableDefaultAgents: false,
  agentToolStrictMode: false,
  showTools: false,
  showTurns: true,
  showInput: true,
  showOutput: true,
  showContext: true,
  showCost: false,
  showTime: true,
  outputTranscript: false,
  finishedRetentionMinutes: 1,
  modelDisplayStyle: "name",
  modelThinkingPlacement: "header",
  statusBarFormat: "full",
};

/** A layer a persisted mutation can target. */
export type ConfigTarget = "session" | "global" | "project";

/** State of the project layer for the current IO instance. */
export type ProjectLayerStatus = "untrusted" | "absent" | "loaded" | "malformed";

/** Raw concurrency section as stored in a config file. */
export interface RawConcurrency {
  default?: number;
  providers?: Record<string, number>;
  models?: Record<string, number>;
}

/** Raw config file contents: only the keys that file carries. */
export interface RawConfig {
  agent?: Record<string, unknown>;
  concurrency?: RawConcurrency;
}

/** Result of a load: the two raw layers plus each layer's status. */
export interface LoadedConfig {
  global: RawConfig;
  project: RawConfig | null;
  projectStatus: ProjectLayerStatus;
  /**
   * AN1. `absent` is a fresh install and `malformed` is a file nobody could
   * read — one `catch` used to return `{}` for both, and the next menu toggle
   * wrote that `{}` back over the operator's settings. See `json-store.ts`.
   */
  globalStatus: LayerStatus;
  /** The parser's own words, when the global layer is malformed. */
  globalError?: string;
}

/** Persistence port consumed by ConfigStore. */
export interface ConfigIO {
  load(): LoadedConfig;
  saveGlobal(config: RawConfig): void;
  saveProject(config: RawConfig): void;
}

/** Agent keys a project file may set: the model family plus per-type overrides. */
export const MODEL_FAMILY_KEYS = new Set(["default", "defaultThinking", "defaultMaxTurns"]);

/** True when a project file may carry this agent key (model keys only, ADR-0008). */
export function isProjectAllowedAgentKey(key: string): boolean {
  return MODEL_FAMILY_KEYS.has(key) || !CONFIG_AGENT_NON_MODEL_KEYS.includes(key);
}

/** Read + validate the project file. null = absent, "malformed" = invalid. */
type ProjectRead = { raw: RawConfig; unknownKeys: string[] } | "malformed" | null;

/**
 * Create a ConfigIO. With a trusted project's `.pi` directory the project file
 * (when present and valid) is an override layer over the global file; each
 * save touches only its own layer. A malformed project file is never written;
 * without a project dir the project layer is untrusted and unavailable.
 */
export function createConfigIO(projectDir?: string): ConfigIO {
  const projectPath = projectDir ? path.join(projectDir, CONFIG_FILE_NAME) : null;
  let projectStatus: ProjectLayerStatus = projectDir ? "absent" : "untrusted";
  let projectRaw: RawConfig | null = null;
  let unknownKeysWarned = false;
  /** AN1: what the last load found on disk, which is what a save has to respect. */
  let globalStatus: LayerStatus = "absent";

  return {
    load: () => {
      const globalRead = readGlobalLayer();
      const global = globalRead.raw;
      globalStatus = globalRead.status;
      if (globalStatus === "malformed") {
        console.warn(
          `[subagents] Could not read ${CONFIG_PATH}: ${globalRead.error}. ` +
            "Running on defaults; the file will be moved aside if anything is saved.",
        );
      }
      // Legacy key never written back: drop it from the raw global layer.
      if (global.agent) delete global.agent.finishedEvictTurns;
      if (projectPath) {
        const read = readProjectRaw(projectPath);
        if (read === null) {
          projectRaw = null;
          projectStatus = "absent";
        } else if (read === "malformed") {
          projectRaw = null;
          projectStatus = "malformed";
        } else {
          projectRaw = read.raw;
          projectStatus = "loaded";
          if (read.unknownKeys.length > 0 && !unknownKeysWarned) {
            unknownKeysWarned = true;
            console.warn(
              `[subagents] Ignoring unknown keys in project config ${projectPath}: ${read.unknownKeys.join(", ")}`,
            );
          }
        }
      } else {
        projectRaw = null;
        projectStatus = "untrusted";
      }
      return {
        global,
        project: projectRaw,
        projectStatus,
        globalStatus,
        ...(globalRead.error ? { globalError: globalRead.error } : {}),
      };
    },
    saveGlobal: (config) => {
      // AN1: the bytes nobody could read are moved aside BEFORE they are
      // replaced. Once, because after the rename the file is absent — a state
      // everything here already handles.
      if (globalStatus === "malformed") {
        const moved = quarantine(CONFIG_PATH);
        globalStatus = "absent";
        console.warn(
          moved
            ? `[subagents] ${CONFIG_PATH} could not be parsed; kept it as ${moved} and started fresh.`
            : `[subagents] ${CONFIG_PATH} could not be parsed and could not be moved aside; overwriting it.`,
        );
      }
      const written = writeJsonAtomic(CONFIG_PATH, config);
      if (!written.ok) console.error(`[subagents] Failed to save config: ${written.error}`);
    },
    saveProject: (config) => {
      // Deliberately NOT the quarantine the global layer takes. A project file
      // is shared, checked in and somebody else's to fix; a global one exists
      // only to hold what this operator just typed into a menu. See ADR-0008
      // and `json-store.ts`.
      if (!projectPath || projectStatus === "malformed" || projectStatus === "untrusted") {
        console.warn(`[subagents] Refusing to write project config (${projectStatus}); change not saved`);
        return;
      }
      const written = writeJsonAtomic(projectPath, config);
      if (!written.ok) console.error(`[subagents] Failed to save config: ${written.error}`);
    },
  };
}

/**
 * Read config from disk (global file only). Merges loaded values over
 * defaults so the result is always a complete SubagentsConfig. Used outside
 * the store (events.ts); the store loads both layers via ConfigIO.
 */
export function loadConfig(): SubagentsConfig {
  return mergeDefaults(readGlobalLayer().raw);
}

/**
 * Merge the two raw layers into one raw config: project keys win, absent keys
 * inherit from global. Project agent keys that are not model keys are dropped
 * (they were warned about at load). Concurrency merges per entry: default
 * wins, providers/models combine. Pure — no I/O.
 */
export function mergeLayers(global: RawConfig, project: RawConfig | null): RawConfig {
  const agent = { ...(global.agent ?? {}) };
  if (project?.agent) {
    for (const [key, value] of Object.entries(project.agent)) {
      if (isProjectAllowedAgentKey(key)) agent[key] = value;
    }
  }
  return { agent, concurrency: mergeRawConcurrency(global.concurrency, project?.concurrency) };
}

/**
 * Merge raw concurrency layers, highest priority last. Never emits an explicit
 * undefined default: an explicit `default: undefined` would override the baked
 * default in mergeDefaults' spread.
 */
function mergeRawConcurrency(...layers: Array<RawConcurrency | undefined>): RawConcurrency {
  const out: RawConcurrency = {};
  const providers: Record<string, number> = {};
  const models: Record<string, number> = {};
  for (const layer of layers) {
    if (!layer) continue;
    if (layer.default !== undefined) out.default = layer.default;
    Object.assign(providers, layer.providers ?? {});
    Object.assign(models, layer.models ?? {});
  }
  if (Object.keys(providers).length > 0) out.providers = providers;
  if (Object.keys(models).length > 0) out.models = models;
  return out;
}

/** Bake hardcoded defaults into a raw config; normalize legacy keys on it. */
export function mergeDefaults(raw: RawConfig): SubagentsConfig {
  // Spread form (not an explicit default key) so the loaded value wins
  // without triggering TS2783; identical runtime semantics. Values come from
  // JSON, so the casts are honest at this boundary.
  const concurrency = {
    ...DEFAULT_CONCURRENCY,
    ...(raw.concurrency ?? {}),
  } as SubagentsConfig["concurrency"];
  const agent = { ...DEFAULT_AGENT, ...(raw.agent ?? {}) } as SubagentsConfig["agent"];
  // Legacy pre-ADR-0006 key: normalize without error, touching no other keys (US-15).
  delete agent.finishedEvictTurns;
  return {
    agent,
    concurrency,
  };
}

// ── Load ─────────────────────────────────────────────────────────────

/**
 * Read the global file, saying WHICH kind of nothing it found.
 *
 * AN1: this used to be one `try`/`catch` returning `{}`, so a file with a
 * missing comma in it was indistinguishable from no file at all — and the
 * difference decides whether the next write may replace it. See
 * `json-store.ts` for the measured consequence.
 */
function readGlobalLayer(): { raw: RawConfig; status: LayerStatus; error?: string } {
  const read = readJsonObject(CONFIG_PATH);
  if (read.status !== "loaded") return { raw: {}, status: read.status, error: read.error };
  return { raw: read.value as RawConfig, status: "loaded" };
}

/** Read the project file; missing = absent, unreadable/invalid = malformed + warning. */
function readProjectRaw(projectPath: string): ProjectRead {
  // AN1: the same reader as the global layer, so "absent" and "malformed" are
  // the same two facts on both. The DECISION they feed is what differs.
  const read = readJsonObject(projectPath);
  if (read.status === "absent") return null;
  if (read.status === "malformed") {
    console.warn(`[subagents] Ignoring malformed project config ${projectPath}: ${read.error}`);
    return "malformed";
  }
  const raw = read.value as RawConfig;
  if (raw.agent !== undefined && !isPlainObject(raw.agent)) return malformedSection(projectPath, "agent");
  if (raw.concurrency !== undefined && !isPlainObject(raw.concurrency)) {
    return malformedSection(projectPath, "concurrency");
  }
  if (raw.concurrency?.providers !== undefined && !isPlainObject(raw.concurrency.providers)) {
    return malformedSection(projectPath, "concurrency.providers");
  }
  if (raw.concurrency?.models !== undefined && !isPlainObject(raw.concurrency.models)) {
    return malformedSection(projectPath, "concurrency.models");
  }
  const unknownKeys = Object.keys(raw.agent ?? {}).filter((key) => !isProjectAllowedAgentKey(key));
  return { raw, unknownKeys };
}

function malformedSection(projectPath: string, section: string): "malformed" {
  console.warn(`[subagents] Ignoring malformed project config ${projectPath}: "${section}" is not a JSON object`);
  return "malformed";
}

// ── Save ─────────────────────────────────────────────────────────────
// `writeJsonAtomic` lives in `json-store.ts` with the read and the quarantine,
// because the three are one rule and the rule is what AN1 was about.
