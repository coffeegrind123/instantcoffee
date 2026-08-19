/**
 * I9 probe — U9 (**FIXED**): the `Explore` agent's read-only guarantee used to be
 * a paragraph rather than a tool set — it shipped with a live `bash`.
 *
 * Its system prompt opened
 *
 *     # CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS
 *     … You do NOT have access to file editing tools.
 *     You are STRICTLY PROHIBITED from: Creating new files · Modifying existing
 *     files · Deleting files · … · Using redirect operators (>, >>, |) or
 *     heredocs to write to files · Running ANY commands that change system state
 *
 * with `registeredTools: ["read", "bash", "grep", "find"]`. The first sentence
 * was true — `edit` and `write` really were absent. The rest was enforced by the
 * same mechanism as every other instruction, on a model this repo has already
 * measured ignoring a CRITICAL instruction about tool use:
 *
 *     .pi/extensions/compaction-guard/src/output-cap.ts
 *       "The notice was in front of the model, saying 'Do not read whole files
 *        or run commands with large output this turn', at 84.5% of the window.
 *        It ran the command regardless. That is not a bug in the notice … a
 *        soft instruction does not bind."
 *
 * That paragraph is the argument for this finding, written in this repo, about
 * this model, on the same subject: a prompt-level prohibition on tool use.
 * `Explore` rested on a longer, louder version of the notice that was watched
 * failing — and it is one of the two types the `Agent` tool advertises, so it is
 * what a model reaches for when it wants a safe look around, including at a dirty
 * tree or at another repo through `worktree_path`.
 *
 * `bash` is gone. `ls` is in, so directory listing still works, and the prompt now
 * describes the tool set and names `general-purpose` as the agent for anything
 * that needs a shell. The cost is real and is stated: no `git log`, no `git diff`.
 *
 *   node --experimental-strip-types i9-explore-read-only-is-a-prompt.mjs
 */

import { register } from "node:module";
register(new URL("./_ts-hook.mjs", import.meta.url));

import { REPO } from "./_host.mjs";

const AT = await import(`${REPO}/vendor/pi-subagents-lite/src/agents/agent-types.ts`);
const { DEFAULT_AGENTS } = await import(`${REPO}/vendor/pi-subagents-lite/src/agents/default-agents.ts`);

AT.registerAgents(new Map(), {});

/** pi's built-in tool names. */
const ACTIVE = ["read", "bash", "edit", "write", "grep", "find", "ls"];

console.log("=== I9 · Explore, as declared and as resolved ===\n");

for (const type of ["Explore", "general-purpose", "__verifier"]) {
  const config = AT.getAgentConfig(type);
  const registry = AT.resolveSessionAllowedTools({
    registeredTools: AT.getToolNamesForType(type),
    tools: config?.tools,
  });
  // The session's active set is what the registry gate let through; the
  // visibility filter then runs over that, not over pi's whole builtin list.
  const activeTools = ACTIVE.filter((t) => registry.includes(t));
  const filtered = AT.resolveVisibleTools({
    activeTools,
    tools: config?.tools,
    excludeTools: config?.excludeTools,
  });
  const visible = filtered ?? activeTools;
  console.log(`  ${type}`);
  console.log(`    registry gate : ${JSON.stringify(registry)}`);
  console.log(`    visible       : ${JSON.stringify(visible)}`);
  console.log(`    has bash      : ${visible.includes("bash") ? "YES" : "no"}`);
}

const explore = DEFAULT_AGENTS.get("Explore");
console.log("\n  What its system prompt promises, verbatim:\n");
for (const line of explore.systemPrompt.split("\n").slice(0, 12)) console.log("    " + line);

console.log(`
NOW: the header is true, and it is true because of the four names above it rather
than because of the ten sentences below it. \`__verifier\` is the control at the
other end — an agent in the same file that really has nothing — and
\`general-purpose\` is the control in the middle: it still has its shell, so a
change that stripped tools everywhere would show here.

BEFORE

  Explore
    registry gate : ["read","bash","grep","find"]
    has bash      : YES

  \`edit\` and \`write\` were genuinely gone. \`bash\` was not, and a shell is a
  superset of both: \`sed -i\`, \`tee\`, \`git checkout\`, \`> file\`, \`rm\`. Nine of
  the prompt's ten prohibitions had no mechanism behind them, eight described
  things a shell does in one token, and the ninth — "Running ANY commands that
  change system state" — is the whole of what \`bash\` is for.

The trade-off is real and was made deliberately: \`Explore\` can no longer run
\`git log\` or \`git diff\`, which its old prompt recommended by name. Reverting is
one line in default-agents.ts, and the reasoning for choosing the guarantee over
the capability is recorded there and in
context/design/subagents-loop-verifier-units.md (U9).
`);
