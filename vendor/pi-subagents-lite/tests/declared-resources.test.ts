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

import { declaredResources } from "../src/agents/declared-resources.ts";

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
