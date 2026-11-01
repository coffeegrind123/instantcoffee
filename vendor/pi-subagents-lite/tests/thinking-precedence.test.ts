/**
 * Which thinking level a spawned agent runs with, and the `parent` choice.
 *
 * The chain (ported from upstream 1.17.1's thinking-resolution.ts):
 *
 *   explicit spawn choice > agent frontmatter > pi per-model level
 *     > subagents defaultThinking > pi's own default
 *
 * Any configurable position may hold `parent`: the parent session's current
 * level (`ctx.thinkingLevel`, pi 1.4 runner.js createContext()). With no parent
 * level available, that position reads as unwritten and the chain walks on.
 *
 * The defect: `toolCallListener` and `executeAgentTool` folded `defaultThinking`
 * into the EXPLICIT spawn param (`frontmatter ?? defaultThinking`), and pi's
 * createAgentSession consults `modelThinkingLevels` only when no explicit level
 * is passed (sdk.js: `thinkingLevel = options.thinkingLevel` first). So a
 * subagent default silently beat the operator's per-model choice.
 *
 * Driven through pi's own jiti against the installed pi, so the listener runs.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { PI_ROOT } from "./pi-install.ts";

const PI_ENTRY = `${PI_ROOT}/dist/index.js`;
const JITI = `${PI_ROOT}/node_modules/jiti/lib/jiti.mjs`;
const DEPS = `${PI_ROOT}/node_modules`;
const SRC = fileURLToPath(new URL("../src", import.meta.url));
const SKIP = !existsSync(JITI) && "pi is not installed globally";

async function load() {
  const { createJiti } = await import(JITI);
  const jiti = createJiti(`file://${PI_ENTRY}`, {
    interopDefault: true,
    alias: {
      "@earendil-works/pi-coding-agent": PI_ENTRY,
      "@earendil-works/pi-tui": `${DEPS}/@earendil-works/pi-tui/dist/index.js`,
      typebox: `${DEPS}/typebox/build/index.mjs`,
    },
  });
  // Getters, so a test fails on its own assertion rather than on a module
  // another test needs.
  return {
    jiti,
    get resolution() {
      return jiti.import(`${SRC}/models/thinking-resolution.ts`);
    },
    get discovery() {
      return jiti.import(`${SRC}/agents/agent-discovery.ts`);
    },
    get types() {
      return jiti.import(`${SRC}/agents/agent-types.ts`);
    },
    get shell() {
      return jiti.import(`${SRC}/shell.ts`);
    },
    get execution() {
      return jiti.import(`${SRC}/agents/tool-execution.ts`);
    },
  };
}

describe("resolveThinkingLevel — the precedence chain", { skip: SKIP }, () => {
  it("explicit > frontmatter > per-model > defaultThinking", async () => {
    const { resolveThinkingLevel } = await (await load()).resolution;
    const all = { explicit: "xhigh", frontmatter: "high", perModel: "low", defaultThinking: "minimal" };
    assert.equal(resolveThinkingLevel(all), "xhigh");
    assert.equal(resolveThinkingLevel({ ...all, explicit: undefined }), "high");
    assert.equal(resolveThinkingLevel({ ...all, explicit: undefined, frontmatter: undefined }), "low");
    assert.equal(
      resolveThinkingLevel({ defaultThinking: "minimal" }),
      "minimal",
      "defaultThinking applies only when pi has no per-model level",
    );
  });

  it("per-model beats the subagent default", async () => {
    const { resolveThinkingLevel } = await (await load()).resolution;
    assert.equal(resolveThinkingLevel({ perModel: "low", defaultThinking: "high" }), "low");
  });

  it("nothing set leaves the level to pi", async () => {
    const { resolveThinkingLevel } = await (await load()).resolution;
    assert.equal(resolveThinkingLevel({}), undefined);
  });

  it("`parent` resolves to the parent's level, at any position", async () => {
    const { resolveThinkingLevel } = await (await load()).resolution;
    assert.equal(resolveThinkingLevel({ explicit: "parent", parentLevel: "high" }), "high");
    assert.equal(resolveThinkingLevel({ frontmatter: "parent", perModel: "low", parentLevel: "high" }), "high");
    assert.equal(resolveThinkingLevel({ defaultThinking: "parent", parentLevel: "minimal" }), "minimal");
  });

  it("`parent` with no parent level reads as unwritten", async () => {
    const { resolveThinkingLevel } = await (await load()).resolution;
    assert.equal(resolveThinkingLevel({ frontmatter: "parent", perModel: "low" }), "low");
    assert.equal(resolveThinkingLevel({ defaultThinking: "parent" }), undefined);
  });

  it("parseThinkingChoice accepts the levels and `parent`, nothing else", async () => {
    const { parseThinkingChoice } = await (await load()).resolution;
    assert.equal(parseThinkingChoice("high"), "high");
    assert.equal(parseThinkingChoice("parent"), "parent");
    assert.equal(parseThinkingChoice("inherit"), undefined);
    assert.equal(parseThinkingChoice(undefined), undefined);
  });
});

describe("agent frontmatter `thinking: parent`", { skip: SKIP }, () => {
  it("is kept, not dropped as an unknown level", async () => {
    const { parseAgentFile } = await (await load()).discovery;
    const md = parseAgentFile("---\nname: probe\ndescription: p\nthinking: parent\n---\nbody", "user");
    assert.equal(md.thinking, "parent");
  });

  it("control — a level still parses and garbage still does not", async () => {
    const { parseAgentFile } = await (await load()).discovery;
    assert.equal(parseAgentFile("---\nname: p\ndescription: p\nthinking: high\n---\nb", "user").thinking, "high");
    assert.equal(parseAgentFile("---\nname: p\ndescription: p\nthinking: loud\n---\nb", "user").thinking, undefined);
  });
});

describe("toolCallListener — what it injects as the explicit thinking", { skip: SKIP }, () => {
  /** Register one agent, pin the store's defaultThinking, and run the listener once. */
  async function inject(opts: { frontmatter?: string; defaultThinking?: string; parentLevel?: string }) {
    const loaded = await load();
    // Sequential: concurrent first imports can hand back two copies of
    // agent-types, and the registry written would not be the one read.
    const execution = await loaded.execution;
    const types = await loaded.types;
    const shell = await loaded.shell;
    types.registerAgents(
      new Map([
        ["Probe", { name: "Probe", description: "p", systemPrompt: "", thinkingLevel: opts.frontmatter }],
      ]),
      { disableDefaultAgents: true },
    );
    const store = shell.getStore();
    const real = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(store), "agent")!.get!.call(store);
    Object.defineProperty(store, "agent", {
      configurable: true,
      get: () => ({ ...real, defaultThinking: opts.defaultThinking }),
    });
    const input: Record<string, unknown> = { agent: "Probe", prompt: "x" };
    try {
      await execution.toolCallListener(
        { toolName: "Agent", input },
        { model: undefined, thinkingLevel: opts.parentLevel },
      );
    } finally {
      delete (store as Record<string, unknown>).agent;
    }
    return input;
  }

  it("does not turn defaultThinking into an explicit level that shadows pi's per-model one", async () => {
    const input = await inject({ defaultThinking: "high" });
    assert.equal(input._resolvedAgent, "Probe", "control — the listener resolved the type");
    assert.equal(input.thinking, undefined);
  });

  it("resolves frontmatter `parent` to the parent session's level", async () => {
    assert.equal((await inject({ frontmatter: "parent", parentLevel: "low" })).thinking, "low");
  });

  it("frontmatter `parent` with no parent level injects nothing", async () => {
    assert.equal((await inject({ frontmatter: "parent" })).thinking, undefined);
  });

  it("control — a concrete frontmatter level is still injected", async () => {
    assert.equal((await inject({ frontmatter: "minimal", defaultThinking: "high" })).thinking, "minimal");
  });
});

/**
 * `initSession` is module-private and builds a real pi session, so the runner
 * half is a pin plus a control on pi: the runner must take per-model from the
 * spawn's own (trust-gated) SettingsManager and run the whole chain, and pi 1.4
 * must still expose the per-model read it calls.
 */
describe("the runner resolves the rest of the chain", { skip: SKIP }, () => {
  const code = (rel: string) =>
    readFileSync(new URL(rel, import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");

  it("passes explicit, frontmatter, per-model, defaultThinking and the parent's level", () => {
    const runner = code("../src/agents/agent-runner.ts");
    const body = runner.slice(runner.indexOf("async function initSession("));
    const call = body.slice(body.indexOf("resolveThinkingLevel({"), body.indexOf("});") + 3);
    assert.match(call, /explicit: options\.thinkingLevel/);
    assert.match(call, /frontmatter: agentConfig\?\.thinkingLevel/);
    assert.match(call, /perModel: model \? settingsManager\.getModelThinkingLevel\(model\.provider, model\.id\) : undefined/);
    assert.match(call, /defaultThinking: getStore\(\)\.agent\.defaultThinking/);
    assert.match(call, /parentLevel: ctx\.thinkingLevel/);
  });

  it("control — pi's SettingsManager answers the per-model read", async () => {
    const { jiti } = await load();
    const { SettingsManager } = await jiti.import(PI_ENTRY);
    const sm = SettingsManager.inMemory({ modelThinkingLevels: { "prov/m": "low" } });
    assert.equal(sm.getModelThinkingLevel("prov", "m"), "low");
    assert.equal(sm.getModelThinkingLevel("prov", "other"), undefined);
  });
});

/**
 * The menus. Both are TUI closures reachable only through a select list, so
 * these are source pins: the /agents wizard hands its level to the spawn as the
 * EXPLICIT one, so seeding it with defaultThinking shadowed per-model exactly as
 * the listener did; and every picker that offers a level offers `parent`,
 * resolved before it reaches the spawn.
 */
describe("the thinking pickers", () => {
  const code = (rel: string) =>
    readFileSync(new URL(rel, import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
  const wizard = code("../src/ui/menu/menu-spawn-wizard.ts");
  const options = code("../src/ui/menu/menu-spawn-options.ts");

  it("the wizard does not seed its explicit level with defaultThinking", () => {
    assert.match(wizard, /let currentThinking: ThinkingChoice \| undefined = agentConfig\.thinkingLevel;/);
    assert.doesNotMatch(wizard, /store\.agent\.defaultThinking/);
  });

  it("the wizard offers `parent` and resolves it against the parent session at spawn", () => {
    assert.match(wizard, /value: PARENT_THINKING_CHOICE/);
    assert.match(wizard, /resolveThinkingLevel\(\{ explicit: currentThinking, parentLevel: session\?\.thinkingLevel \}\)/);
  });

  it("the default-thinking picker offers `parent`", () => {
    assert.match(options, /\[\.\.\.VALID_THINKING_LEVELS, PARENT_THINKING_CHOICE, "inherit"\]/);
  });
});
