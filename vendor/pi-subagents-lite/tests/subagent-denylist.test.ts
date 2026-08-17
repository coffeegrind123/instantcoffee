/**
 * What a subagent is not allowed to load.
 *
 * The rule under test is "a subagent cannot reach Matrix". It is enforced on
 * path rather than on name because, measured against this checkout, the name is
 * not usable: `vendor/prinny-channel/extensions/index.ts`,
 * `vendor/pi-loop-mode/extensions/index.ts` and
 * `vendor/rtk-pi/extensions/index.ts` all reduce to the name `index`, and
 * prinny's `pi.extensions` manifest names a directory so the package-name
 * fallback returns undefined.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  subagentExtraExtensionPaths,
  isDeniedExtensionPath,
  isDeniedSkillName,
  withExtensionDenial,
  withSkillDenial,
} from "../src/agents/subagent-denylist.ts";

const PRINNY = "/home/claudeuser/qwen3.8-forge/vendor/prinny-channel/extensions/index.ts";
const LOOP = "/home/claudeuser/qwen3.8-forge/vendor/pi-loop-mode/extensions/index.ts";
const RTK = "/home/claudeuser/qwen3.8-forge/vendor/rtk-pi/extensions/index.ts";
const GUARD = "/home/claudeuser/qwen3.8-forge/.pi/extensions/compaction-guard/index.ts";

describe("isDeniedExtensionPath", () => {
  it("denies the Matrix channel", () => {
    assert.equal(isDeniedExtensionPath(PRINNY), true);
  });

  it("keeps the extensions that share its derived name", () => {
    // The control. If these were denied too, the filter would be matching
    // `index` — which is exactly the mistake this file exists to avoid.
    assert.equal(isDeniedExtensionPath(LOOP), false);
    assert.equal(isDeniedExtensionPath(RTK), false);
  });

  it("keeps the compaction guard, which a subagent needs in its own window", () => {
    assert.equal(isDeniedExtensionPath(GUARD), false);
  });

  it("is not defeated by separator or case", () => {
    assert.equal(isDeniedExtensionPath(PRINNY.replace(/\//g, "\\")), true);
    assert.equal(isDeniedExtensionPath(PRINNY.toUpperCase()), true);
  });

  it("survives a missing path rather than throwing during a spawn", () => {
    assert.equal(isDeniedExtensionPath(undefined as unknown as string), false);
  });
});

describe("isDeniedSkillName", () => {
  it("denies the operator-facing channel skills", () => {
    assert.equal(isDeniedSkillName("prinny-access"), true);
    assert.equal(isDeniedSkillName("prinny-configure"), true);
    assert.equal(isDeniedSkillName("  Prinny-Access  "), true);
  });

  it("keeps everything else", () => {
    assert.equal(isDeniedSkillName("mcp-scripting"), false);
    assert.equal(isDeniedSkillName("browser-tools"), false);
    assert.equal(isDeniedSkillName(undefined), false);
  });
});

describe("withExtensionDenial", () => {
  const base = { extensions: [{ path: PRINNY }, { path: LOOP }, { path: GUARD }] };

  it("removes the denied extension when no inner filter is set", () => {
    const out = withExtensionDenial(undefined)(base);
    assert.deepEqual(
      out.extensions.map((e) => e.path),
      [LOOP, GUARD],
    );
  });

  it("runs after the agent's own filter, and the agent cannot widen it back", () => {
    // An agent file asking for everything still does not get prinny.
    const inner = (b: typeof base) => b;
    const out = withExtensionDenial(inner)(base);
    assert.ok(!out.extensions.some((e) => e.path === PRINNY));
  });

  it("lets the agent's own filter narrow further", () => {
    const inner = (b: typeof base) => ({ extensions: b.extensions.filter((e) => e.path === GUARD) });
    const out = withExtensionDenial(inner)(base);
    assert.deepEqual(
      out.extensions.map((e) => e.path),
      [GUARD],
    );
  });

  it("returns the same object when nothing was denied, so nothing is rebuilt", () => {
    const clean = { extensions: [{ path: LOOP }, { path: GUARD }] };
    assert.equal(withExtensionDenial(undefined)(clean), clean);
  });
});

describe("withSkillDenial", () => {
  it("drops the channel skills and keeps the rest", () => {
    const base = {
      skills: [{ name: "prinny-access" }, { name: "mcp-scripting" }, { name: "prinny-configure" }],
    };
    const out = withSkillDenial(undefined)(base);
    assert.deepEqual(
      out.skills.map((s) => s.name),
      ["mcp-scripting"],
    );
  });
});

describe("subagentExtraExtensionPaths", () => {
  const always = () => true;

  it("gives a child loop and rtk by default — it cannot inherit either", () => {
    const out = subagentExtraExtensionPaths({} as NodeJS.ProcessEnv, always);
    assert.equal(out.length, 2);
    assert.ok(out.some((p) => p.includes("/vendor/pi-loop-mode/")), "loop must be there");
    assert.ok(out.some((p) => p.includes("/vendor/rtk-pi/")), "rtk must be there");
    assert.ok(out.every((p) => p.startsWith("/")), "paths must be absolute for pi's loader");
  });

  it("never includes the Matrix channel in the default set", () => {
    const out = subagentExtraExtensionPaths({} as NodeJS.ProcessEnv, always);
    assert.ok(!out.some((p) => p.includes("prinny")));
  });

  it("drops a default whose file is not there, rather than passing a dead path", () => {
    assert.deepEqual(subagentExtraExtensionPaths({} as NodeJS.ProcessEnv, () => false), []);
  });

  it("is replaced wholesale by the env var, comma or colon separated", () => {
    assert.deepEqual(
      subagentExtraExtensionPaths({ SUBAGENT_EXTRA_EXTENSIONS: `${LOOP},${RTK}` } as NodeJS.ProcessEnv, always),
      [LOOP, RTK],
    );
    assert.deepEqual(
      subagentExtraExtensionPaths({ SUBAGENT_EXTRA_EXTENSIONS: `${LOOP}:${RTK}` } as NodeJS.ProcessEnv, always),
      [LOOP, RTK],
    );
  });

  it("takes an empty env var as an explicit none, not as unset", () => {
    assert.deepEqual(subagentExtraExtensionPaths({ SUBAGENT_EXTRA_EXTENSIONS: "" } as NodeJS.ProcessEnv, always), []);
  });

  it("cannot be used to smuggle back a denied extension", () => {
    assert.deepEqual(
      subagentExtraExtensionPaths({ SUBAGENT_EXTRA_EXTENSIONS: `${PRINNY},${LOOP}` } as NodeJS.ProcessEnv, always),
      [LOOP],
    );
  });
});
