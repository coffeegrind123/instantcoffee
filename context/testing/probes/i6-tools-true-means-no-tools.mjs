/**
 * I6 probe — U6 (**FIXED**): in an agent .md file, `tools: true` and `tools: all`
 * used to produce an agent with NO tools, while the adjacent keys `extensions:`
 * and `skills:` accepted exactly those words and meant "all of them".
 *
 * The frontmatter parser is deliberately loose — it reads scalars as strings —
 * and the three keys are then read by two different functions:
 *
 *     extensions / skills  ->  parseExtensions()   "false"|"none" -> false
 *                                                  "true"|"all"   -> true
 *                                                  "a, b"         -> ["a","b"]
 *     tools                ->  parseStringArray()  any non-empty string is a
 *                                                  COMMA LIST
 *
 * So `tools: true` became the one-element allowlist `["true"]`, which was then
 * used for both halves of tool resolution: `resolveSessionAllowedTools` gated the
 * session registry to a tool named "true", and `resolveVisibleTools` showed the
 * model the intersection of that allowlist with the active set, which is empty.
 * The agent ran with a system prompt, no tools, and one buffered warning:
 * `tool "true" not found in any loaded extension`.
 *
 * `tools: false` and `tools: none` landed on the same path and happened to be
 * right for the wrong reason — an allowlist of one nonexistent tool is also no
 * tools. That is what kept it quiet: three of the four spellings looked like they
 * worked.
 *
 * `tools` now goes through `parseExtensions` like its two siblings, and a boolean
 * no longer leaks into `registeredTools`, which is a list of names.
 *
 * This is S9 one field over. There, `registeredTools: []` read as "not declared"
 * and silently became the default four; here the word that means "everything"
 * on two lines of a frontmatter block means "a tool called true" on the third.
 *
 * Loading `agent-discovery.ts` under plain node needs the `.js` specifiers in
 * `src/` mapped to the `.ts` files that are actually there, which is what
 * `_ts-hook.mjs` does. Run it as:
 *
 *   node --experimental-strip-types --import ./_register.mjs i6-tools-true-means-no-tools.mjs
 *
 * or just `node --experimental-strip-types i6-tools-true-means-no-tools.mjs`,
 * which registers the hook itself.
 */

import { register } from "node:module";
register(new URL("./_ts-hook.mjs", import.meta.url));

import { REPO } from "./_host.mjs";

const { parseAgentFile, mergeAgents } = await import(`${REPO}/vendor/pi-subagents-lite/src/agents/agent-discovery.ts`);
const AT = await import(`${REPO}/vendor/pi-subagents-lite/src/agents/agent-types.ts`);

/** pi's built-in tool names, as BUILTIN_TOOL_NAMES lists them. */
const ACTIVE = ["read", "bash", "edit", "write", "grep", "find", "ls"];

const agentFile = (line) => `---\nname: probe\ndescription: a probe agent\n${line}\n---\nDo the thing.`;

const CASES = [
  ["tools: true", "the model gets everything"],
  ["tools: all", "the model gets everything"],
  ["tools: false", "the model gets nothing"],
  ["tools: none", "the model gets nothing"],
  ["tools: [read, grep]", "the model gets read and grep"],
  ["model: some/model", "(no tools: key at all)"],
];

console.log("=== I6 · what a `tools:` line in an agent .md actually does ===\n");
console.log(
  "  " + "written in the .md".padEnd(22) +
  "| " + "what the author means".padEnd(28) +
  "| " + "registry gate".padEnd(34) +
  "| visible to the model",
);
console.log("  " + "-".repeat(22) + "+-" + "-".repeat(28) + "+-" + "-".repeat(34) + "+-" + "-".repeat(24));

for (const [line, intent] of CASES) {
  const md = parseAgentFile(agentFile(line), "user");
  AT.registerAgents(mergeAgents(new Map(), [md], [], []), {});
  const config = AT.getAgentConfig("probe");
  const registry = AT.resolveSessionAllowedTools({
    registeredTools: AT.getToolNamesForType("probe"),
    tools: config?.tools,
  });
  const visible = AT.resolveVisibleTools({ activeTools: ACTIVE, tools: config?.tools, excludeTools: config?.excludeTools });
  console.log(
    "  " + (line === "model: some/model" ? "(nothing)" : line).padEnd(22) +
    "| " + intent.padEnd(28) +
    "| " + JSON.stringify(registry).padEnd(34) +
    "| " + (visible === null ? "all of them (no filter)" : JSON.stringify(visible)),
  );
}

console.log("\n  The same three words, on the sibling keys:\n");
for (const line of ["extensions: true", "extensions: all", "extensions: false", "skills: none", "skills: all"]) {
  const md = parseAgentFile(agentFile(line), "user");
  const key = line.split(":")[0];
  console.log(`    ${line.padEnd(20)} -> ${key} = ${JSON.stringify(md[key])}`);
}

console.log(`
NOW

  true / all    the default active set, unfiltered — the same as omitting the key,
                which is what "all" has always meant for the sibling keys.
  false / none  nothing, and the registry gate says so: \`[]\`, not an allowlist
                of one tool that happens not to exist.
  a list        unchanged, and it is the control.

BEFORE

  written in the .md     registry gate    visible to the model
  ---------------------  ---------------  --------------------
  tools: true            ["true"]         []
  tools: all             ["all"]          []
  tools: false           ["false"]        []
  tools: none            ["none"]         []
  tools: [read, grep]    ["read","grep"]  ["read","grep"]

  The two spellings of "give it everything" handed the agent an allowlist
  containing one tool that does not exist, and it ran with none. The failure was
  silent apart from a buffered warning naming a tool the author never wrote — and
  three of the four spellings produced the right outcome anyway, which is why
  nobody found it by using it.

This is S9 one field over. There, \`registeredTools: []\` read as "not declared"
and silently became the default four; here the word that means "everything" on
two lines of a frontmatter block meant "a tool called true" on the third.
`);
