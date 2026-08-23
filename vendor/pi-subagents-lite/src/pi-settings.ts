/**
 * pi-settings.ts — Read pi's settings.json, decoupling consumers from pi's
 * file format and path.
 */

import * as fs from "node:fs";

import { agentDirFile } from "./agent-dir.ts";

/**
 * Forge fork, twenty-third pass (AN7): through `agent-dir.ts`, which honours
 * `PI_CODING_AGENT_DIR`. This used to be a bare
 * `path.join(os.homedir(), ".pi", "agent", "settings.json")` — the one reader of
 * pi's own directory in this stack that ignored pi's own override for it. See
 * that module for what it cost.
 *
 * `env` is a parameter for the same reason it is one in `verify-log.ts`: a test
 * must be able to ask the question without editing `process.env`.
 */
export function getPiSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return agentDirFile("settings.json", env);
}

export interface PiSettings {
  hideThinkingBlock?: boolean;
}

/** Parse pi's settings.json; undefined if missing or unparseable. */
export function readPiSettings(env: NodeJS.ProcessEnv = process.env): PiSettings | undefined {
  try {
    const content = fs.readFileSync(getPiSettingsPath(env), "utf-8");
    return JSON.parse(content) as PiSettings;
  } catch {
    return undefined;
  }
}

/** True if hideThinkingBlock is set; false if absent or unreadable. */
export function getHideThinkingBlock(env: NodeJS.ProcessEnv = process.env): boolean {
  const settings = readPiSettings(env);
  return settings?.hideThinkingBlock ?? false;
}
