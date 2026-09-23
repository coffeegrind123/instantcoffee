/**
 * mode-seed.ts — Forge fork. The session layer a launcher mode starts from.
 *
 * `SUBAGENT_MODE_CONFIG` names a JSON file the launcher writes for this launch:
 *
 *   { "model": "deepseek/deepseek-flash",
 *     "concurrency": { "providers": { "deepseek": 15, "forge": 1 } } }
 *
 * `model` becomes the session default model (precedence rung 2, above every
 * file and frontmatter), and `concurrency` the session concurrency layer. The
 * store resets its session layer to THIS rather than to empty, so neither
 * session_start nor a "clear" in /agents can drop children onto the parent's
 * model mid-run. Nothing here is ever written to disk.
 *
 * Imports nothing from pi, so tests load it directly (tests/mode-seed.test.ts).
 */
import { readFileSync } from "node:fs";
import type { SessionModelOverrides } from "../models/model-precedence.js";
import type { RawConcurrency } from "./config-io.ts";

export const MODE_CONFIG_ENV = "SUBAGENT_MODE_CONFIG";

export interface ModeSeed {
  overrides: SessionModelOverrides;
  concurrency: RawConcurrency;
  /** Why the named file was refused. Set only when a file was named. */
  error?: string;
}

const TOP_KEYS = new Set(["model", "concurrency"]);
const CAP_MAPS = ["providers", "models"] as const;

/** `provider/model-id`, the form pi's registry and resolveModel both key on. */
const MODEL_REF = /^[^/\s]+\/\S+$/;

function empty(error?: string): ModeSeed {
  return { overrides: { default: null }, concurrency: {}, ...(error ? { error } : {}) };
}

function isCap(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate a parsed file. Returns the problem, or undefined when it is usable whole. */
function problemWith(data: unknown): string | undefined {
  if (!isPlainObject(data)) {
    return "not a JSON object";
  }

  const unknown = Object.keys(data).filter((k) => !TOP_KEYS.has(k));
  if (unknown.length > 0) {
    return `unknown key(s): ${unknown.join(", ")}`;
  }

  if (data.model !== undefined && (typeof data.model !== "string" || !MODEL_REF.test(data.model))) {
    return `model must be "provider/model-id", got ${JSON.stringify(data.model)}`;
  }

  if (data.concurrency === undefined) {
    return undefined;
  }
  if (!isPlainObject(data.concurrency)) {
    return "concurrency is not an object";
  }
  const c = data.concurrency;
  if (c.default !== undefined && !isCap(c.default)) {
    return `concurrency.default must be an integer >= 1, got ${JSON.stringify(c.default)}`;
  }
  for (const key of CAP_MAPS) {
    const map = c[key];
    if (map === undefined) {
      continue;
    }
    if (!isPlainObject(map)) {
      return `concurrency.${key} is not an object`;
    }
    for (const [name, cap] of Object.entries(map)) {
      if (!isCap(cap)) {
        return `concurrency.${key}.${name} must be an integer >= 1, got ${JSON.stringify(cap)}`;
      }
    }
  }
  return undefined;
}

/**
 * The seed for this launch, freshly built on every call so no caller can edit
 * the next reset. A named file that cannot be used is refused WHOLE, with the
 * reason in `error`: half a seed looks configured and is not.
 */
export function readModeSeed(env: Record<string, string | undefined> = process.env): ModeSeed {
  // Spelled out, not env[MODE_CONFIG_ENV]: tests/env-switches.test.ts finds the
  // switches the launcher must forward by this literal form.
  const path = env.SUBAGENT_MODE_CONFIG;
  if (!path) {
    return empty();
  }

  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    return empty(`${MODE_CONFIG_ENV}=${path}: ${(err as Error).message}`);
  }

  const problem = problemWith(data);
  if (problem) {
    return empty(`${MODE_CONFIG_ENV}=${path}: ${problem}`);
  }

  const d = data as { model?: string; concurrency?: RawConcurrency };
  return {
    overrides: { default: d.model ?? null },
    concurrency: d.concurrency ? structuredClone(d.concurrency) : {},
  };
}

/**
 * `overrides` with `type` cleared: back to the seed's value for that key when
 * the seed has one, removed otherwise. Returns a new object.
 */
export function withoutOverride(
  overrides: SessionModelOverrides,
  type: string,
  seed: SessionModelOverrides,
): SessionModelOverrides {
  const next: SessionModelOverrides = { ...overrides };
  if (seed[type] !== undefined) {
    next[type] = seed[type];
  } else if (type === "default") {
    next.default = null;
  } else {
    delete next[type];
  }
  return next;
}
