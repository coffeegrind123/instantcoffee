/**
 * agent-dir.ts — Forge fork, twenty-third pass (AN7). Where pi keeps its own
 * files, for the modules that must not import pi to ask.
 *
 * ## Why a second answer exists at all
 *
 * `config/config-io.ts` calls pi's real `getAgentDir()`, and that is the right
 * thing wherever a module already imports pi. Two modules deliberately do not:
 *
 * ```
 *   agents/verify-log.ts   the judge's raw reply, appended from inside
 *                          `verifyAnswer`, whose contract is "never throw"
 *   pi-settings.ts         pi's own settings.json, read for hideThinkingBlock
 * ```
 *
 * Both are loaded by the suite under bare `node --experimental-strip-types
 * --test`, where `@earendil-works/pi-coding-agent` does not resolve. So they
 * answer the question themselves — and until this pass they answered it
 * differently:
 *
 * ```
 *   verify-log.ts    env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent")
 *   pi-settings.ts   join(os.homedir(), ".pi", "agent")            ← the env var
 *                                                                   ignored
 * ```
 *
 * `scripts/pi-local.sh` honours `PI_CODING_AGENT_DIR` in two places, pi's own
 * `getAgentDir()` honours it, `vendor/prinny-channel/src/config.ts` honours it,
 * and `server/src/state.ts` honours it with a comment saying why — *"a pi
 * installation that has been relocated takes the channel's state with it rather
 * than leaving it behind in a directory nothing else uses."* One reader in the
 * stack did not, and it is the one whose whole job is to read a file pi wrote.
 *
 * The consequence is small and exact: on a relocated install
 * `getHideThinkingBlock()` reads a path pi does not use, finds nothing, and
 * returns `false` — so the conversation viewer opens with thinking blocks shown
 * to an operator who turned them off. Small, and it is the same class of mistake
 * as every other entry on this pass's ledger: two readers of one fact, one of
 * them from a different place.
 *
 * ## The rule, written once
 *
 * `PI_CODING_AGENT_DIR`, else `~/.pi/agent`. The variable name is pi's own
 * `ENV_AGENT_DIR`, built as `` `${APP_NAME.toUpperCase()}_CODING_AGENT_DIR` ``
 * (`dist/config.js`), and `tests/agent-dir.test.ts` reads that file so a rename
 * upstream is a failing test rather than a silent divergence.
 *
 * A leading `~` is expanded, because pi's `getAgentDir()` runs the value through
 * `expandTildePath` and a value that works for pi has to work here.
 */

import { homedir } from "node:os";
import { join } from "node:path";

/** pi's override for its own agent directory. Must match pi's `ENV_AGENT_DIR`. */
export const ENV_AGENT_DIR = "PI_CODING_AGENT_DIR";

/**
 * `~` and `~/…` expanded the way pi's `expandTildePath` does; anything else
 * untouched.
 *
 * Read out of `dist/utils/paths.js` (`normalizePath`, which is all
 * `expandTildePath` is) rather than guessed, down to the backslash form being
 * win32-only:
 *
 * ```js
 *   if (normalized === "~") return home;
 *   if (normalized.startsWith("~/") ||
 *       (process.platform === "win32" && normalized.startsWith("~\\"))) { … }
 * ```
 */
function expandTilde(path: string): string {
  if (path === "~") return homedir();
  const separated = path.startsWith("~/") || (process.platform === "win32" && path.startsWith("~\\"));
  return separated ? join(homedir(), path.slice(2)) : path;
}

/**
 * Where pi keeps `settings.json`, `sessions/`, `channels/` and the rest.
 *
 * The guard is pi's own, character for character:
 *
 * ```js
 *   const envDir = process.env[ENV_AGENT_DIR];
 *   if (envDir) return expandTildePath(envDir);
 *   return join(homedir(), CONFIG_DIR_NAME, "agent");
 * ```
 *
 * AO7 (twenty-fourth pass): it used to be `override && override.trim() !== ""`,
 * which is a better rule and a DIFFERENT one — a value of `"  "` is a relative
 * directory to pi and "unset" here, and the whole promise of this module is
 * that it answers the way pi answers. Where the two disagree, pi is right by
 * definition, because pi is the one that writes the files.
 */
export function agentDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[ENV_AGENT_DIR];
  if (override) return expandTilde(override);
  return join(homedir(), ".pi", "agent");
}

/** A file inside it. One join, so no caller has to remember the layout. */
export function agentDirFile(name: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(agentDir(env), name);
}
