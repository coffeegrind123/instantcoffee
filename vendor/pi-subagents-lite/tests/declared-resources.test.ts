/**
 * A hidden agent must load what it declared, not what general-purpose declares.
 *
 * ## The failure this pins
 *
 * `__verifier` is documented and written as "no tools, no extensions, no
 * skills, one turn". It had two extensions, and one of them was
 * `vendor/pi-loop-mode`.
 *
 * The mechanism is a collision between two features that never met in review.
 * `hidden: true` was added to keep `__verifier` out of the `Agent` tool's enum
 * (worth 11 chars of schema on every turn). `findActiveConfig()` in
 * agent-types.ts treats `hidden` as "not a real agent" and substitutes
 * general-purpose, so `getConfig("__verifier").extensions` came back `true`
 * where the agent itself says `false`. `createResourceLoader` read the resolved
 * value, so the `extensions === false ? [] : subagentExtraExtensionPaths()`
 * guard — written specifically to stop this — was unreachable code.
 *
 * Nothing caught it because `tools: false` is read from `getAgentConfig`
 * directly and DID take effect: the judge really had no tools on the wire, which
 * is the property everyone checked.
 *
 * These tests are on the pure rule rather than on the loader, because
 * `agent-runner.ts` imports pi at runtime and cannot be loaded under plain node.
 * The loader's use of it is one destructuring line.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  declaredPromptSources,
  declaredRegisteredTools,
  declaredResources,
  resolveEffectiveSystemPromptMode,
} from "../src/agents/declared-resources.ts";
import { DEFAULT_AGENTS, VERIFIER_AGENT_TYPE } from "../src/agents/default-agents.ts";

/**
 * The shipped values of `DEFAULT_AGENT.includeContextFiles` and
 * `DEFAULT_AGENT.systemPromptMode` (config/config-io.ts), restated rather than
 * imported: that module imports pi's `getAgentDir` and will not load under the
 * plain node this suite runs on. If either default changes, the assertions below
 * are still the ones that matter — they say the judge is unaffected by them.
 */
const SHIPPED_GLOBALS = { includeContextFiles: true, systemPromptMode: "replace" as const };

/** What getConfig() returns for a hidden type: general-purpose's, defaults applied. */
const GENERAL_PURPOSE_RESOLVED = { extensions: true as const, skills: true as const };

describe("declaredResources", () => {
  it("keeps a hidden agent's own refusal to load anything", () => {
    // The exact shape of __verifier's frontmatter.
    const verifier = { extensions: false as const, skills: false as const };

    const out = declaredResources(verifier, GENERAL_PURPOSE_RESOLVED);

    assert.equal(out.extensions, false, "extensions: false must survive the hidden-type fallback");
    assert.equal(out.skills, false, "skills: false must survive it too");
  });

  it("is what makes the additionalExtensionPaths guard reachable", () => {
    // The guard in createResourceLoader is `extensions === false ? [] : …`.
    // Before the fix this predicate saw `true` for every hidden agent, so the
    // subagent extra-extension list (pi-loop-mode, rtk-pi) was always loaded.
    const before = GENERAL_PURPOSE_RESOLVED.extensions === false;
    const after = declaredResources({ extensions: false, skills: false }, GENERAL_PURPOSE_RESOLVED).extensions === false;

    assert.equal(before, false, "control: reading the resolved config never fires the guard");
    assert.equal(after, true, "reading the agent's own declaration does");
  });

  it("falls through to the global default for anything the agent leaves undeclared", () => {
    // An agent file that says nothing about extensions must still follow
    // loadExtensionsImplicitly, which getConfig has already applied.
    const out = declaredResources({}, { extensions: true, skills: false });
    assert.equal(out.extensions, true);
    assert.equal(out.skills, false);

    const off = declaredResources(undefined, { extensions: false, skills: true });
    assert.equal(off.extensions, false, "an unknown type follows the resolved defaults");
    assert.equal(off.skills, true);
  });

  it("changes nothing for a visible agent, because getConfig already carried its declaration", () => {
    // For a non-hidden agent, getConfig returns the agent's own value with
    // applyGlobalDefaults only filling undefined — so both sources agree and the
    // precedence is a no-op. This is the regression guard on the fix itself.
    for (const declared of [true as const, false as const, ["tavily"], undefined]) {
      const resolved = { extensions: declared ?? true, skills: true as const };
      const out = declaredResources({ extensions: declared, skills: undefined }, resolved);
      assert.deepEqual(out.extensions, resolved.extensions);
      assert.equal(out.skills, true);
    }
  });

  it("keeps a whitelist array rather than collapsing it to a boolean", () => {
    const out = declaredResources({ extensions: ["rtk"], skills: ["loop-skill"] }, GENERAL_PURPOSE_RESOLVED);
    assert.deepEqual(out.extensions, ["rtk"]);
    assert.deepEqual(out.skills, ["loop-skill"]);
  });
});

/**
 * The same precedence, for the two switches that decide what a session is TOLD
 * rather than what it can DO.
 *
 * `__verifier` declared tools, extensions, skills, preloadSkills and maxTurns,
 * and left `includeContextFiles` and `includeSystemPrompt` undeclared — so both
 * resolved from global config, and `includeContextFiles` defaults to true. The
 * judge, whose entire design argument is that it is harder to fool BECAUSE IT
 * KNOWS LESS, was handed every AGENTS.md / CLAUDE.md from the cwd up to "/"
 * inside `<project_context>`: 571 → 6,543 chars of system prompt, measured with
 * the real builder, on every verified delegation. A project context file is
 * where house rules live, and house rules are instructions for the WORKER.
 */
describe("declaredPromptSources", () => {
  it("gives the judge nothing it did not ask for, under the shipped defaults", () => {
    const verifier = DEFAULT_AGENTS.get(VERIFIER_AGENT_TYPE);
    assert.ok(verifier, "__verifier must still be a registered default agent");

    const out = declaredPromptSources(verifier, SHIPPED_GLOBALS);

    assert.equal(out.includeContextFiles, false, "the judge must not inherit the project's instructions");
    assert.equal(out.systemPromptMode, "replace", "nor the operator's system prompt");
  });

  it("keeps the judge isolated whatever the operator sets globally", () => {
    // The /agents menu offers all three modes. An operator turning on `inherit`
    // for their subagents must not thereby reconfigure the verifier.
    const verifier = DEFAULT_AGENTS.get(VERIFIER_AGENT_TYPE)!;
    for (const systemPromptMode of ["replace", "inherit", "custom"] as const) {
      const out = declaredPromptSources(verifier, { includeContextFiles: true, systemPromptMode });
      assert.equal(out.systemPromptMode, "replace", `mode ${systemPromptMode} must not reach the judge`);
      assert.equal(out.includeContextFiles, false);
    }
  });

  it("changes nothing for an agent that leaves them undeclared (control)", () => {
    // general-purpose declares neither, and must keep following the global
    // settings — a subagent doing real work in a project SHOULD see AGENTS.md.
    const generalPurpose = DEFAULT_AGENTS.get("general-purpose")!;
    assert.equal(generalPurpose.includeContextFiles, undefined, "control: it declares nothing");

    const out = declaredPromptSources(generalPurpose, SHIPPED_GLOBALS);
    assert.equal(out.includeContextFiles, true);
    assert.equal(out.systemPromptMode, "replace");

    const inherited = declaredPromptSources(generalPurpose, { includeContextFiles: false, systemPromptMode: "inherit" });
    assert.equal(inherited.includeContextFiles, false);
    assert.equal(inherited.systemPromptMode, "inherit");
  });

  it("survives an unknown type", () => {
    const out = declaredPromptSources(undefined, SHIPPED_GLOBALS);
    assert.equal(out.includeContextFiles, true);
    assert.equal(out.systemPromptMode, "replace");
    assert.equal(out.includeEnvironment, true);
  });

  it("lets the judge skip the environment block, and nobody else", () => {
    // Building it costs a `git rev-parse` and a `git branch` per spawn — ~100 ms
    // measured on this box's 9p mount, on the one llama slot the parent's Agent
    // call is blocked on — and the judge has no working tree.
    const verifier = DEFAULT_AGENTS.get(VERIFIER_AGENT_TYPE)!;
    assert.equal(declaredPromptSources(verifier, SHIPPED_GLOBALS).includeEnvironment, false);

    for (const name of ["general-purpose", "Explore"]) {
      const agent = DEFAULT_AGENTS.get(name)!;
      assert.equal(
        declaredPromptSources(agent, SHIPPED_GLOBALS).includeEnvironment,
        true,
        `${name} works in a tree and must still be told where it is`,
      );
    }
  });
});

/**
 * An empty allowlist is a declaration, not an absence.
 *
 * The caller's test was `config?.registeredTools?.length ? … : DEFAULTS`, and
 * `[].length` is 0 — so `registeredTools: []` resolved to the four default tools.
 * `__verifier` declares exactly that and was saved only by `tools: false`, which
 * is honoured first everywhere it matters, so the line read as load-bearing and
 * was inert.
 */
describe("declaredRegisteredTools", () => {
  it("keeps an explicitly empty allowlist empty", () => {
    assert.deepEqual(declaredRegisteredTools({ registeredTools: [] }), []);
  });

  it("is what __verifier's declaration resolves to", () => {
    const verifier = DEFAULT_AGENTS.get(VERIFIER_AGENT_TYPE)!;
    assert.deepEqual(verifier.registeredTools, [], "control: the declaration itself");
    assert.deepEqual(declaredRegisteredTools(verifier), [], "and it must survive the lookup");
  });

  it("reads an undeclared list as absent, so the caller falls back", () => {
    assert.equal(declaredRegisteredTools({}), undefined);
    assert.equal(declaredRegisteredTools(undefined), undefined);
    assert.equal(
      declaredRegisteredTools(DEFAULT_AGENTS.get("general-purpose")!),
      undefined,
      "general-purpose omits it and means 'all available tools'",
    );
  });

  it("reads a boolean as absent rather than throwing", () => {
    // agent-discovery assigns `registeredTools: md.tools`, and `tools` in
    // frontmatter may be true or false. Neither is a list of names, both already
    // meant "not declared" under the old length test, and spreading `true` throws.
    assert.equal(declaredRegisteredTools({ registeredTools: true as never }), undefined);
    assert.equal(declaredRegisteredTools({ registeredTools: false as never }), undefined);
  });

  it("passes a real list through, and copies it (control)", () => {
    const explore = DEFAULT_AGENTS.get("Explore")!;
    const out = declaredRegisteredTools(explore)!;
    assert.deepEqual(out, explore.registeredTools);
    assert.notEqual(out, explore.registeredTools, "a caller must not be able to mutate the registry's array");
  });
});

describe("resolveEffectiveSystemPromptMode", () => {
  it("lets an agent refuse to inherit, whatever the global mode is", () => {
    for (const mode of ["replace", "inherit", "custom"] as const) {
      assert.equal(resolveEffectiveSystemPromptMode(mode, false), "replace");
    }
  });

  it("lets an agent opt in, except that a custom prompt still wins", () => {
    assert.equal(resolveEffectiveSystemPromptMode("replace", true), "inherit");
    assert.equal(resolveEffectiveSystemPromptMode("inherit", true), "inherit");
    assert.equal(resolveEffectiveSystemPromptMode("custom", true), "custom");
  });

  it("follows the global mode when the agent says nothing", () => {
    for (const mode of ["replace", "inherit", "custom"] as const) {
      assert.equal(resolveEffectiveSystemPromptMode(mode, undefined), mode);
    }
  });
});

/**
 * An agent that promises read-only must be read-only in its tool set, not in a
 * paragraph.
 *
 * ## The failure this pins
 *
 * `Explore` opened with "# CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS" and
 * ten prohibitions — no creating files, no modifying files, no deleting, no
 * temporary files anywhere including /tmp, no redirect operators or heredocs, no
 * commands that change system state — and shipped with `bash`. Exactly one of
 * those ten was enforced: `edit` and `write` really were absent. A shell is a
 * superset of both.
 *
 * This repo has already measured what a prompt-level prohibition on tool use is
 * worth against this model. From `.pi/extensions/compaction-guard/src/output-cap.ts`,
 * about a CRITICAL notice that was in context at 84.5% of the window telling the
 * model not to run commands with large output:
 *
 *   "It ran the command regardless. That is not a bug in the notice and not a
 *    threshold that needs tuning: a soft instruction does not bind."
 *
 * `Explore` is one of the two types the `Agent` tool advertises, so it is what a
 * model reaches for when it wants a safe look around — including at a dirty tree,
 * or at another repo through `worktree_path`.
 *
 * ## Control
 *
 * `general-purpose` must still have its shell, so a change that stripped tools
 * everywhere fails here rather than passing.
 */
describe("Explore — the read-only guarantee is the tool set", () => {
  const explore = DEFAULT_AGENTS.get("Explore")!;

  it("has no shell and no writing tools", () => {
    assert.deepEqual(explore.registeredTools, ["read", "grep", "find", "ls"]);
    for (const forbidden of ["bash", "edit", "write"]) {
      assert.equal(
        explore.registeredTools!.includes(forbidden),
        false,
        `${forbidden} is a way to modify files, and this agent's whole claim is that it cannot`,
      );
    }
  });

  it("still has what exploration actually needs", () => {
    for (const needed of ["read", "grep", "find"]) {
      assert.equal(explore.registeredTools!.includes(needed), true);
    }
  });

  it("does not promise anything its tools do not deliver", () => {
    // The old prompt listed capabilities it did not have the means to withhold.
    // The new one describes the tool set, and says where to go for the rest.
    assert.doesNotMatch(explore.systemPrompt, /STRICTLY PROHIBITED/);
    assert.doesNotMatch(explore.systemPrompt, /Use Bash ONLY/);
    assert.match(explore.systemPrompt, /general-purpose/, "say which agent to use when a shell is needed");
  });

  it("control — general-purpose still has a shell", () => {
    const general = DEFAULT_AGENTS.get("general-purpose")!;
    // It declares no registeredTools at all, which means the default active set.
    assert.equal(general.registeredTools, undefined);
    assert.equal(general.tools, undefined);
  });
});
