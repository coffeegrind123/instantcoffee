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
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

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

  it("is not defeated by moving the package out of vendor/", () => {
    // The fragment used to be `/vendor/prinny-channel/`, which is only true
    // while this checkout keeps it there. The second path below is the one that
    // matters: `~/.pi/agent/extensions/*` is a DISCOVERY directory, so a child
    // picks anything there up on its own — the denial is the only thing between
    // a subagent and Matrix, and it was keyed on an install location.
    // `pi-prinny-channel` is the package's actual npm name, so this is where an
    // `npm i` puts it — and a bare `prinny-channel/` fragment misses it too.
    assert.equal(isDeniedExtensionPath("/proj/node_modules/pi-prinny-channel/extensions/index.ts"), true);
    assert.equal(isDeniedExtensionPath("/proj/node_modules/prinny-channel/extensions/index.ts"), true);
    assert.equal(isDeniedExtensionPath("/home/u/.pi/agent/extensions/prinny-channel/index.ts"), true);
    assert.equal(isDeniedExtensionPath("/somewhere/else/prinny-channel/dist/index.js"), true);
    assert.equal(isDeniedExtensionPath("C:\\src\\node_modules\\pi-prinny-channel\\extensions\\index.ts"), true);
  });

  it("does not deny an unrelated directory that merely contains the words", () => {
    // The control on the widened match: it is a path SEGMENT with an optional
    // package prefix, not a substring search.
    assert.equal(isDeniedExtensionPath("/proj/my-prinny-channel-notes/extensions/index.ts"), false);
    assert.equal(isDeniedExtensionPath("/proj/notes/prinny-channel.md"), false, "a file, not a package directory");
    assert.equal(isDeniedExtensionPath("/proj/channel/extensions/index.ts"), false);
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

  it("gives a child rtk by default — it cannot inherit it", () => {
    const out = subagentExtraExtensionPaths({} as NodeJS.ProcessEnv, always);
    assert.equal(out.length, 1);
    assert.ok(out.some((p) => p.includes("/vendor/rtk-pi/")), "rtk must be there");
    assert.ok(out.every((p) => p.startsWith("/")), "paths must be absolute for pi's loader");
  });

  it("does NOT hand a child pi-loop-mode", () => {
    // It was in this list, and it is the one package here whose state is
    // module-global — so a child's copy of its handlers ran against the
    // operator's single LoopState: the child's system prompt gained the
    // operator's goal, the child's agent_end drove the operator's iteration
    // ladder and received its next loop turn, and a child that compacted had its
    // conversation replaced by the operator's loop handoff. See that package's
    // factory guard. It goes back when its state is per-session.
    const out = subagentExtraExtensionPaths({} as NodeJS.ProcessEnv, always);
    assert.ok(!out.some((p) => p.includes("/vendor/pi-loop-mode/")), "loop must not be handed to a child");
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

/**
 * The route this file does NOT govern.
 *
 * A child inherits none of the parent's `-e` flags, and extensions reach it by
 * exactly two routes: `additionalExtensionPaths` (route B — `vendor/`, which this
 * file's list controls) and DISCOVERY (route A — `~/.pi/agent/extensions/**` and
 * `<cwd>/.pi/extensions/**`, which nothing here can stop arriving).
 *
 * The ledger above is entirely about route B. It prices `pi-loop-mode`'s `loop`
 * tool at ~177 tokens/turn of a child's window and removes it — while
 * `.pi/extensions/stack.ts` was arriving by route A with `stack_status` at ~173
 * tokens/turn, measured, and nobody had counted it. `stack_status` is read-only
 * and not dangerous; the route is the finding, because the next extension dropped
 * into that directory inherits the same free pass.
 *
 * The repair was a factory guard in `stack.ts` itself — the same
 * `__PI_SUBAGENT_SPAWN_DEPTH__` check this package's own factory and
 * `pi-loop-mode`'s use — rather than a path fragment naming this checkout's
 * layout, which is exactly the mistake the prinny pattern above was rewritten to
 * stop making.
 *
 * This is the standing check, and it is deliberately about the CLASS rather than
 * about `stack.ts`: any extension a child discovers that registers a
 * model-visible tool must either be wanted in a child or guard itself. It skips
 * silently when the directory is not there, so the package still works outside
 * this repo.
 */
describe("what a subagent discovers — .pi/extensions must guard its tools", () => {
  const extensionsDir = fileURLToPath(new URL("../../../.pi/extensions/", import.meta.url));

  /** Every entry point pi's discovery would load from `.pi/extensions/`. */
  function entryPoints(): { name: string; file: string }[] {
    if (!existsSync(extensionsDir)) return [];
    const out: { name: string; file: string }[] = [];
    for (const name of readdirSync(extensionsDir)) {
      const full = join(extensionsDir, name);
      if (statSync(full).isDirectory()) {
        for (const candidate of ["index.ts", "index.js"]) {
          if (existsSync(join(full, candidate))) {
            out.push({ name, file: join(full, candidate) });
            break;
          }
        }
      } else if (name.endsWith(".ts")) {
        out.push({ name: name.replace(/\.ts$/, ""), file: full });
      }
    }
    return out;
  }

  it("every discovered extension that registers a tool is inert in a subagent", () => {
    const entries = entryPoints();
    if (entries.length === 0) return; // not this repo; nothing to check
    const offenders: string[] = [];
    for (const entry of entries) {
      const source = readFileSync(entry.file, "utf8");
      if (!/pi\.registerTool\s*\(/.test(source)) continue; // hooks only: costs a child nothing
      if (source.includes("__PI_SUBAGENT_SPAWN_DEPTH__")) continue;
      offenders.push(entry.name);
    }
    assert.deepEqual(
      offenders,
      [],
      `these are discovered by every subagent and put a tool in its window: ${offenders.join(", ")}. ` +
        "Either guard the factory with __PI_SUBAGENT_SPAWN_DEPTH__ or say here why a child should have it.",
    );
  });

  it("control — the check can see the directory and finds a tool-registering extension in it", () => {
    const entries = entryPoints();
    if (entries.length === 0) return;
    const withTools = entries.filter((entry) => /pi\.registerTool\s*\(/.test(readFileSync(entry.file, "utf8")));
    assert.ok(
      withTools.length > 0,
      "if nothing here registers a tool any more, the assertion above has stopped testing anything",
    );
  });
});
