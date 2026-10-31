/**
 * The Agent tool's result mark comes from pi's render CONTEXT.
 *
 * pi calls a tool's `renderResult` with `{ content, details }` only — 0.87.1 and
 * 1.4.0 alike (`components/tool-execution.js`: `resultRenderer({ content:
 * this.result.content, details: this.result.details }, …, theme,
 * this.getRenderContext())`) — and carries `isError` in the fourth argument. The
 * renderer read `result.isError`, which pi never sets, so a failed delegation
 * was drawn with ✓.
 *
 * Driven through pi's own jiti against the installed pi, the way
 * `background-delivery.test.ts` loads pi-importing modules, so it runs the
 * registered function rather than reading its text.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const PI = "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent";
const PI_ENTRY = `${PI}/dist/index.js`;
const JITI = `${PI}/node_modules/jiti/lib/jiti.mjs`;
const DEPS = `${PI}/node_modules`;
const SRC = fileURLToPath(new URL("../src", import.meta.url));

const piAi = existsSync(`${DEPS}/@earendil-works/pi-ai/dist/compat.js`)
  ? `${DEPS}/@earendil-works/pi-ai/dist/compat.js`
  : `${DEPS}/@earendil-works/pi-ai/dist/index.js`;

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

async function registeredAgentTool() {
  const { createJiti } = await import(JITI);
  const jiti = createJiti(`file://${PI_ENTRY}`, {
    interopDefault: true,
    alias: {
      "@earendil-works/pi-coding-agent": PI_ENTRY,
      "@earendil-works/pi-tui": `${DEPS}/@earendil-works/pi-tui/dist/index.js`,
      "@earendil-works/pi-ai": piAi,
      typebox: `${DEPS}/typebox/build/index.mjs`,
    },
  });
  const { registerAgentTool } = await jiti.import(`${SRC}/registration.ts`);
  const tools: Array<{ name: string; renderResult: (...args: unknown[]) => { render(width: number): string[] } }> = [];
  registerAgentTool({ registerTool: (tool: never) => tools.push(tool) });
  const tool = tools.find((t) => t.name === "Agent");
  assert.ok(tool, "registerAgentTool registered no Agent tool");
  return tool;
}

function drawn(tool: Awaited<ReturnType<typeof registeredAgentTool>>, isError: boolean): string {
  const result = { content: [{ type: "text", text: "the answer" }], details: { description: "read the parser" } };
  const component = tool.renderResult(result, { expanded: false, isPartial: false }, theme, { isError });
  return component.render(120).join("\n");
}

describe("Agent renderResult reads isError from pi's render context", { skip: !existsSync(JITI) && "pi is not installed globally" }, () => {
  it("draws ✗ for a failed delegation", async () => {
    const tool = await registeredAgentTool();
    assert.match(drawn(tool, true), /✗/);
    assert.doesNotMatch(drawn(tool, true), /✓/);
  });

  it("control — draws ✓ for a successful one", async () => {
    const tool = await registeredAgentTool();
    assert.match(drawn(tool, false), /✓/);
  });
});

/**
 * A source pin, not a drive: `handleAgentBriefing` is module-private and only
 * reachable through a TUI select list. A busy session rejects a
 * `sendUserMessage()` with no `deliverAs` ("Agent is already processing",
 * agent-session.js `prompt()`), after the menu has already said "sent".
 */
describe("the debug briefing names a delivery mode", () => {
  it("passes deliverAs to sendUserMessage", async () => {
    const { readFileSync } = await import("node:fs");
    const code = readFileSync(`${SRC}/ui/menu/menu-debug.ts`, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    const calls = code.match(/sendUserMessage\([^;]*\);/g) ?? [];
    assert.ok(calls.length > 0, "control: the call is still there");
    for (const call of calls) {
      assert.match(call, /deliverAs:\s*"followUp"/, call);
    }
  });
});

/**
 * A reload while a child is still in setup (creating its session, binding its
 * extensions) left a run nobody owned. `dispose()` ended each record's SESSION,
 * and a record in setup has none yet, so its run went on to prompt the one llama
 * slot with no parent to deliver to. Aborting the record's controller is what
 * stops it: `runTurnLoop` throws ABORTED_BEFORE_START on an aborted signal
 * before `prompt()` (AB4). A session created after dispose is ended rather than
 * attached to a record that is gone.
 */
describe("dispose() stops a child that is still in setup", { skip: !existsSync(JITI) && "pi is not installed globally" }, () => {
  it("aborts the run of a record that has no session yet", async () => {
    const { createJiti } = await import(JITI);
    const jiti = createJiti(`file://${PI_ENTRY}`, {
      interopDefault: true,
      alias: {
        "@earendil-works/pi-coding-agent": PI_ENTRY,
        "@earendil-works/pi-tui": `${DEPS}/@earendil-works/pi-tui/dist/index.js`,
        "@earendil-works/pi-ai": piAi,
        typebox: `${DEPS}/typebox/build/index.mjs`,
      },
    });
    const { AgentManager } = await jiti.import(`${SRC}/agents/agent-manager.ts`);
    const manager = new AgentManager();
    const abortController = new AbortController();
    (manager as unknown as { agents: Map<string, unknown> }).agents.set("agent-setup", {
      id: "agent-setup",
      lifecycle: { status: "running", startedAt: Date.now(), started: true },
      execution: { abortController },
      stats: {},
      display: {},
    });

    manager.dispose();
    assert.equal(abortController.signal.aborted, true, "the setup-phase run would go on to prompt the slot");
  });

  it("a session created after dispose is ended, not attached", async () => {
    const { readFileSync } = await import("node:fs");
    const code = readFileSync(`${SRC}/agents/agent-manager.ts`, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    assert.match(
      code,
      /onSessionCreated: \(session\) => \{\s*if \(this\.disposed\) \{\s*void endChildSession\(session\);\s*return;\s*\}\s*record\.execution\.session = session;/,
    );
  });
});

/** pi's write tool takes `path` (0.87.1 and 1.4.0); the summary read `file_path` and showed `("")`. */
describe("summarizeToolArgs names the file a write went to", { skip: !existsSync(JITI) && "pi is not installed globally" }, () => {
  it("reads write's `path`", async () => {
    const { createJiti } = await import(JITI);
    const jiti = createJiti(`file://${PI_ENTRY}`, { interopDefault: true, alias: { "@earendil-works/pi-coding-agent": PI_ENTRY } });
    const { summarizeToolArgs } = await jiti.import(`${SRC}/utils.ts`);
    assert.equal(summarizeToolArgs("write", { path: "/src/a.ts", content: "abc" }), '("/src/a.ts", 3 chars)');
    // control: read already used `path`
    assert.equal(summarizeToolArgs("read", { path: "/src/a.ts" }), '("/src/a.ts")');
  });
});

/**
 * `getSessionStats()` walks every session entry and then calls
 * `getContextUsage()` for this one field (agent-session.js, 0.87.1 and 1.4.0);
 * the widget asks on every frame.
 */
describe("getSessionContextPercent reads getContextUsage directly", { skip: !existsSync(JITI) && "pi is not installed globally" }, () => {
  it("prefers getContextUsage and falls back to the stats", async () => {
    const { createJiti } = await import(JITI);
    const jiti = createJiti(`file://${PI_ENTRY}`, { interopDefault: true, alias: { "@earendil-works/pi-coding-agent": PI_ENTRY } });
    const { getSessionContextPercent } = await jiti.import(`${SRC}/agents/usage.ts`);
    let walked = 0;
    const stats = () => {
      walked++;
      return { tokens: { input: 0, output: 0, cacheWrite: 0 }, contextUsage: { percent: 40 } };
    };
    assert.equal(getSessionContextPercent({ getSessionStats: stats, getContextUsage: () => ({ percent: 41 }) }), 41);
    assert.equal(walked, 0, "the full entry walk ran for one field");
    assert.equal(getSessionContextPercent({ getSessionStats: stats }), 40, "control: a session without it still answers");
    assert.equal(getSessionContextPercent({ getSessionStats: stats, getContextUsage: () => undefined }), null);
  });
});
