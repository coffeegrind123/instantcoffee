/**
 * ab7 — AO7, the agent directory a third reader hardcoded and four spelled
 * differently.
 *
 * FIXED — both columns are real:
 *
 *   NOW     `agentDir()` from `vendor/pi-subagents-lite/src/agent-dir.ts`, which
 *           is what `prompt/skill-loader.ts` now asks; and `stateDir()` from
 *           `vendor/prinny-channel/server/bin/agent-dir.mjs`, which is what the
 *           extension, the bootstrap and the test harness now ask.
 *   BEFORE  the two expressions those files used to hold, written out here.
 *
 * Two halves.
 *
 *   1. `skill-loader.ts` passed `loadSkills({ agentDir: join(homedir(), ".pi",
 *      "agent") })` — the third instance of AN7 in the same package, and the one
 *      that decides which skills a SUBAGENT is given.
 *   2. All four readers of `PI_CODING_AGENT_DIR` in `prinny-channel` wrote
 *      `env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent')`, and pi's
 *      own `getAgentDir()` runs the value through `expandTildePath` first.
 *
 *   run: node --experimental-strip-types ab7-the-directory-two-packages-disagreed-about.mjs [skills|tilde|agree|live]
 */

import { homedir } from "node:os";
import { join } from "node:path";

const REPO = "/home/claudeuser/qwen3.8-forge";
const { agentDir, ENV_AGENT_DIR } = await import(`${REPO}/vendor/pi-subagents-lite/src/agent-dir.ts`);
const prinny = await import(`${REPO}/vendor/prinny-channel/server/bin/agent-dir.mjs`);

/** What `skill-loader.ts` and prinny's four readers used to compute. */
const beforeAgentDir = () => join(homedir(), ".pi", "agent");
const beforePrinnyStateDir = (env) =>
  env.PRINNY_STATE_DIR ?? join(env[ENV_AGENT_DIR] ?? join(homedir(), ".pi", "agent"), "channels", "prinny");

const MODES = { skills: {}, tilde: {}, agree: {}, live: {} };
const MODE = process.argv[2] ?? "skills";
if (!MODES[MODE]) {
  console.error(`usage: node ab7-…mjs <${Object.keys(MODES).join("|")}>`);
  process.exit(2);
}

let failures = 0;
const check = (label, ok) => {
  console.log(`   ${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) failures++;
};

console.log(`\nab7 [${MODE}] — the directory two packages disagreed about (AO7)\n`);

if (MODE === "skills") {
  const env = { [ENV_AGENT_DIR]: "/srv/pi-relocated" };
  console.log(`   PI_CODING_AGENT_DIR=/srv/pi-relocated  — a relocated install\n`);
  console.log(`   pi keeps the operator's skills in   ${join(agentDir(env), "skills")}`);
  console.log("");
  console.log(`   loadSkills({ agentDir: … }) for a SUBAGENT:`);
  console.log(`     BEFORE  ${beforeAgentDir()}`);
  console.log(`     NOW     ${agentDir(env)}\n`);
  check("BEFORE the child looked where pi does not write", beforeAgentDir() !== agentDir(env));
  check("NOW it looks where pi writes", agentDir(env) === "/srv/pi-relocated");
  check(
    "and with the override unset the two agree — which is why it went unnoticed",
    beforeAgentDir() === agentDir({}),
  );
} else if (MODE === "tilde") {
  const env = { [ENV_AGENT_DIR]: "~/pi-work" };
  console.log(`   PI_CODING_AGENT_DIR=~/pi-work  — read out of an .env, so no shell expanded it\n`);
  console.log(`   pi's own getAgentDir()   ${join(homedir(), "pi-work")}`);
  console.log("");
  console.log(`   the channel's state directory:`);
  console.log(`     BEFORE  ${beforePrinnyStateDir(env)}`);
  console.log(`     NOW     ${prinny.stateDir(env)}\n`);
  console.log(`   …which is where the allowlist, the credentials and the Olm store live.\n`);
  check("BEFORE it was a directory literally named ~, relative to the cwd", beforePrinnyStateDir(env).startsWith("~/"));
  check("NOW it is under the home directory, as pi means it", prinny.stateDir(env) === join(homedir(), "pi-work", "channels", "prinny"));
  check("a tilde that is not a home reference is still left alone", prinny.stateDir({ [ENV_AGENT_DIR]: "/tmp/~backup" }) === "/tmp/~backup/channels/prinny");
} else if (MODE === "agree") {
  const cases = ["~/pi-work", "~", "/opt/pi", "/tmp/~backup", "relative/dir", ""];
  console.log(`   value                  subagents-lite            prinny-channel`);
  let disagreements = 0;
  for (const value of cases) {
    const env = value === "" ? {} : { [ENV_AGENT_DIR]: value };
    const a = agentDir(env);
    const b = prinny.agentDir(env);
    if (a !== b) disagreements++;
    console.log(`   ${(value || "(unset)").padEnd(22)} ${a.padEnd(25)} ${b}${a === b ? "" : "   ✘"}`);
  }
  console.log("");
  check("the two packages give one answer for every case", disagreements === 0);
} else {
  const env = { ...process.env };
  console.log(`   PI_CODING_AGENT_DIR  ${env[ENV_AGENT_DIR] ?? "(unset)"}`);
  console.log(`   agentDir()           ${agentDir(env)}`);
  console.log(`   prinny stateDir()    ${prinny.stateDir(env)}`);
  console.log(`   subagent skill root  ${join(agentDir(env), "skills")}\n`);
  check("the two packages agree on this box", agentDir(env) === prinny.agentDir(env));
  check("…and the channel state is under it", prinny.stateDir(env).startsWith(agentDir(env)) || env.PRINNY_STATE_DIR !== undefined);
}

console.log("");
process.exit(failures === 0 ? 0 : 1);
