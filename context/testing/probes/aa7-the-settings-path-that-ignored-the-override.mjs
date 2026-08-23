/**
 * aa7 — AN7, the one reader of pi's own directory that ignored pi's own override.
 *
 * FIXED — both columns are real. The NOW column is `getPiSettingsPath` and
 * `verifyLogFile` from `vendor/pi-subagents-lite`, both through `agent-dir.ts`;
 * the BEFORE column is the expression `pi-settings.ts` used to hold:
 *
 * ```js
 *   path.join(os.homedir(), ".pi", "agent", "settings.json")
 * ```
 *
 * `PI_CODING_AGENT_DIR` is pi's `ENV_AGENT_DIR`. Everything else in this stack
 * honours it — pi's `getAgentDir()`, `scripts/pi-local.sh` in two places,
 * `prinny-channel/src/config.ts`, `server/src/state.ts`, and this package's own
 * `verify-log.ts`. On a relocated install the one that did not reads a path pi
 * never writes, finds nothing, and answers `hideThinkingBlock: false` — so the
 * conversation viewer opens with thinking blocks shown to an operator who turned
 * them off.
 *
 *   run: node --experimental-strip-types aa7-the-settings-path-that-ignored-the-override.mjs [relocated|default|live]
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const REPO = "/home/claudeuser/qwen3.8-forge";
const SRC = `${REPO}/vendor/pi-subagents-lite/src`;
const { agentDir, ENV_AGENT_DIR } = await import(`${SRC}/agent-dir.ts`);
const { getPiSettingsPath, getHideThinkingBlock } = await import(`${SRC}/pi-settings.ts`);
const { verifyLogFile } = await import(`${SRC}/agents/verify-log.ts`);

const MODES = {
  /** PI_CODING_AGENT_DIR set, which is what a relocated install looks like. */
  relocated: {},
  /** The control: unset, where the two answers always agreed. */
  default: {},
  /** This box, as it stands. */
  live: {},
};

const MODE = process.argv[2] ?? "relocated";
if (!MODES[MODE]) {
  console.error(`usage: node aa7-…mjs <${Object.keys(MODES).join("|")}>`);
  process.exit(2);
}

let failures = 0;
const check = (label, ok) => {
  console.log(`   ${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) failures++;
};

/** The expression `pi-settings.ts` used to hold. */
const beforePath = () => join(homedir(), ".pi", "agent", "settings.json");

console.log(`\naa7 [${MODE}] — the settings path that ignored the override (AN7)\n`);

if (MODE === "live") {
  const env = { ...process.env };
  console.log(`   PI_CODING_AGENT_DIR : ${env[ENV_AGENT_DIR] ?? "(unset)"}`);
  console.log(`   agentDir()          : ${agentDir(env)}`);
  console.log("");
  console.log(`   BEFORE  ${beforePath()}`);
  console.log(`   NOW     ${getPiSettingsPath(env)}`);
  console.log(`   verify log (control) ${verifyLogFile(env)}\n`);
  check("the two readers agree on this box", getPiSettingsPath(env).startsWith(agentDir(env)));
  check("…and the control always did", verifyLogFile(env).startsWith(agentDir(env)));
} else {
  const relocated = MODE === "relocated";
  const dir = relocated ? mkdtempSync(join(tmpdir(), "aa7-agent-")) : undefined;
  const env = relocated ? { [ENV_AGENT_DIR]: dir } : {};

  // pi's settings.json, where pi would actually put it, saying the operator
  // turned thinking blocks off.
  if (relocated) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ hideThinkingBlock: true }));
  }

  const before = beforePath();
  const now = getPiSettingsPath(env);

  console.log(`   PI_CODING_AGENT_DIR : ${env[ENV_AGENT_DIR] ?? "(unset)"}`);
  console.log(`   pi writes settings   : ${join(agentDir(env), "settings.json")}\n`);
  console.log(`   BEFORE reads         : ${before}`);
  console.log(`   NOW reads            : ${now}`);
  console.log(`   verify log (control) : ${verifyLogFile(env)}\n`);

  if (relocated) {
    console.log(`   hideThinkingBlock, as each reader answers it:`);
    console.log(`     BEFORE : ${getHideThinkingBlock({}) ? "true" : "false"}   ← the file says true`);
    console.log(`     NOW    : ${getHideThinkingBlock(env) ? "true" : "false"}\n`);
    check("BEFORE the reader looked in the wrong place", before !== join(dir, "settings.json"));
    check("NOW it looks where pi writes", now === join(dir, "settings.json"));
    check("BEFORE the answer was the default, not the operator's", getHideThinkingBlock({}) === false);
    check("NOW the operator's setting is what comes back", getHideThinkingBlock(env) === true);
    check("the verify log always honoured it — the control", verifyLogFile(env) === join(dir, "subagent-verify.jsonl"));
  } else {
    check("with the override unset the two answers are the same", before === now);
    check("…which is why this went twenty-two passes unnoticed", before === now);
  }
}

console.log("");
process.exit(failures === 0 ? 0 : 1);
