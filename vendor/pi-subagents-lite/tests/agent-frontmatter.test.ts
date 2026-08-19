/**
 * What a `tools:` line in an agent .md actually does.
 *
 * ## The failure this pins
 *
 * The frontmatter parser reads scalars as strings, and the three resource keys
 * were read by two different functions:
 *
 *     extensions / skills  ->  parseExtensions()    "false"|"none" -> false
 *                                                   "true"|"all"   -> true
 *                                                   "a, b"         -> ["a","b"]
 *     tools                ->  parseStringArray()   ANY non-empty string is a
 *                                                   comma list
 *
 * So `tools: true` became the one-element allowlist `["true"]`, and that value
 * was used for both halves of tool resolution: the session registry was gated to
 * a tool named `true`, and the visible set was the intersection of that allowlist
 * with the active set, which is empty. The two spellings of "give it everything"
 * produced an agent with nothing, silently — the only signal was a buffered
 * warning naming a tool the author never wrote.
 *
 * `tools: false` and `tools: none` were accidentally correct for the wrong
 * reason (an allowlist of one nonexistent tool is also no tools), which is what
 * kept it quiet: three of the four spellings looked like they worked.
 *
 * This is S9 one field over — there, `registeredTools: []` read as "not declared"
 * and became the default four. Here the word that means "all of them" on two
 * lines of a frontmatter block meant "a tool called true" on the third.
 *
 * ## Loading
 *
 * `agent-discovery.ts` and `agent-types.ts` reach pi's package only through
 * erased `import type`s, but they use `.js` specifiers for files that are `.ts`
 * on disk, which plain node will not resolve. The hook below maps one to the
 * other for relative specifiers only, and only when the `.ts` file is really
 * there — the same trick `context/testing/probes/_ts-hook.mjs` uses.
 */

import assert from "node:assert/strict";
import { register } from "node:module";
import { describe, it } from "node:test";

register(
  `data:text/javascript,
   import { existsSync } from "node:fs";
   import { fileURLToPath } from "node:url";
   export async function resolve(specifier, context, next) {
     if (specifier.startsWith(".") && specifier.endsWith(".js")) {
       try {
         const r = await next(specifier.slice(0, -3) + ".ts", context);
         if (existsSync(fileURLToPath(r.url))) return r;
       } catch {}
     }
     return next(specifier, context);
   }`,
);

const { parseAgentFile, mergeAgents } = await import("../src/agents/agent-discovery.ts");
const AT = await import("../src/agents/agent-types.ts");

/** pi's built-in tool names, as BUILTIN_TOOL_NAMES lists them. */
const BUILTINS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

function resolveFor(line: string) {
  const file = `---\nname: probe\ndescription: a probe agent\n${line}\n---\nDo the thing.`;
  AT.registerAgents(mergeAgents(new Map(), [parseAgentFile(file, "user")], [], []), {});
  const config = AT.getAgentConfig("probe");
  const registry = AT.resolveSessionAllowedTools({
    registeredTools: AT.getToolNamesForType("probe"),
    tools: config?.tools,
  });
  const active = BUILTINS.filter((t) => registry.includes(t));
  const filtered = AT.resolveVisibleTools({
    activeTools: active,
    tools: config?.tools,
    excludeTools: config?.excludeTools,
  });
  return { registry, visible: filtered ?? active };
}

describe("agent frontmatter — tools: accepts the same words as extensions: and skills:", () => {
  for (const line of ["tools: true", "tools: all"]) {
    it(`\`${line}\` gives the agent tools, not an allowlist containing the word`, () => {
      const { registry, visible } = resolveFor(line);
      assert.equal(registry.includes("true"), false);
      assert.equal(registry.includes("all"), false);
      assert.ok(visible.length > 0, "the two spellings of 'everything' must not produce nothing");
      assert.deepEqual(visible, ["read", "bash", "edit", "write"], "the default active set, unfiltered");
    });
  }

  for (const line of ["tools: false", "tools: none"]) {
    it(`\`${line}\` gives the agent no tools, and says so in the registry gate`, () => {
      const { registry, visible } = resolveFor(line);
      assert.deepEqual(registry, [], "not an allowlist of one tool that happens not to exist");
      assert.deepEqual(visible, []);
    });
  }

  it("control — a list is still a list", () => {
    const { registry, visible } = resolveFor("tools: [read, grep]");
    assert.deepEqual(registry.sort(), ["grep", "read"]);
    assert.deepEqual(visible.sort(), ["grep", "read"]);
  });

  it("control — no tools: key at all still means the default active set", () => {
    const { registry, visible } = resolveFor("model: some/model");
    assert.deepEqual(registry.sort(), ["bash", "edit", "read", "write"]);
    assert.deepEqual(visible.sort(), ["bash", "edit", "read", "write"]);
  });

  it("the sibling keys are unchanged, which is the point of the comparison", () => {
    const parse = (line: string) =>
      parseAgentFile(`---\nname: probe\ndescription: d\n${line}\n---\nbody`, "user");
    assert.equal(parse("extensions: true").extensions, true);
    assert.equal(parse("extensions: all").extensions, true);
    assert.equal(parse("extensions: false").extensions, false);
    assert.equal(parse("skills: none").skills, false);
    assert.equal(parse("skills: all").skills, true);
  });

  it("a boolean never leaks into registeredTools, which is a list of names", () => {
    const parse = (line: string) =>
      mergeAgents(new Map(), [parseAgentFile(`---\nname: probe\ndescription: d\n${line}\n---\nbody`, "user")], [], []);
    for (const line of ["tools: true", "tools: false", "tools: all", "tools: none"]) {
      const config = parse(line).get("probe")!;
      assert.equal(Array.isArray(config.registeredTools) || config.registeredTools === undefined, true, line);
    }
  });
});
