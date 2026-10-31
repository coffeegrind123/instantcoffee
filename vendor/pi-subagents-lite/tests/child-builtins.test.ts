/**
 * pi's built-in mcp + tool-search for a child, and only when the browser is
 * native. See src/agents/child-builtins.ts.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { childBuiltinExtensions } from "../src/agents/child-builtins.ts";
import { PI_ROOT } from "./pi-install.ts";

const sdk = {
  createMcpExtension: () => "mcp-factory",
  createToolSearchExtension: () => "tool-search-factory",
  createCodemodeExtension: () => "codemode-factory",
};

describe("childBuiltinExtensions", () => {
  it("hands mcp and codemode, marked builtin, when the browser is native", () => {
    const out = childBuiltinExtensions(sdk, { BROWSER_MCP_NATIVE: "1" });
    assert.deepEqual(out.map((f) => [f.name, f.factory, f.builtin, f.replaceable]), [
      ["mcp", "mcp-factory", true, true],
      ["codemode", "codemode-factory", true, true],
    ]);
  });

  it("never tool-search: what it loads it declares, and a changed tool list re-prefills the prompt", () => {
    const out = childBuiltinExtensions(sdk, { BROWSER_MCP_NATIVE: "1" });
    assert.ok(!out.some((f) => f.name === "tool-search"));
  });

  it("nothing when the browser is not native", () => {
    assert.deepEqual(childBuiltinExtensions(sdk, {}), []);
    assert.deepEqual(childBuiltinExtensions(sdk, { BROWSER_MCP_NATIVE: "0" }), []);
  });

  it("a pi without the creators (< 0.99) gets nothing, not a throw", () => {
    assert.deepEqual(childBuiltinExtensions({}, { BROWSER_MCP_NATIVE: "1" }), []);
  });
});

/**
 * Measured live on pi 1.4.0: a child's first request declared tool_search and
 * none of the five direct browser tools. The child's session allowlist is fixed
 * at creation from the tools known then, and MCP tools register later, when the
 * server connects — so the browse loop was filtered out and the child had to
 * tool_search for `navigate`'s neighbours (it opened the page with new_tab).
 */
describe("childBrowserToolNames", () => {
  it("names codemode and every browser tool, by pattern", async () => {
    const { childBrowserToolNames } = await import("../src/agents/child-builtins.ts");
    assert.deepEqual(childBrowserToolNames({ BROWSER_MCP_NATIVE: "1" }), ["codemode", "mcp__browser__*"]);
  });

  it("nothing when the browser is not native", async () => {
    const { childBrowserToolNames } = await import("../src/agents/child-builtins.ts");
    assert.deepEqual(childBrowserToolNames({}), []);
  });

  /**
   * Measured live in the TUI: with the five direct names listed, a child's
   * codemode said `tools.mcp__browser__execute_js does not exist`. pi turns MCP
   * filtering ON as soon as any allowlist entry starts with `mcp__`
   * (agent-session.js `_allowlistFiltersMcp`), so five exact names cut the
   * other 93 off. Driven through pi's own matcher and the same rule.
   */
  it("against pi's own matcher: every browser tool allowed, other servers not", async () => {
    const MCP = `${PI_ROOT}/dist/core/mcp-servers.js`;
    const { existsSync } = await import("node:fs");
    if (!existsSync(MCP)) return;
    const { createToolNameMatcher, isMcpToolName } = await import(MCP);
    const { childBrowserToolNames } = await import("../src/agents/child-builtins.ts");
    const allow = ["read", "bash", ...childBrowserToolNames({ BROWSER_MCP_NATIVE: "1" })];
    const matches = createToolNameMatcher(allow);
    const filtersMcp = allow.some((e: string) => e.startsWith("mcp__"));
    const isAllowed = (n: string) => matches(n) || (!filtersMcp && isMcpToolName(n));
    for (const n of ["mcp__browser__navigate", "mcp__browser__execute_js", "mcp__browser__get_cookies", "codemode"]) {
      assert.equal(isAllowed(n), true, n);
    }
    assert.equal(isAllowed("mcp__other__thing"), false, "a child reaches the browser, not every MCP server");
  });

  it("is added to the allowlist only for agents that do not declare their own tools", async () => {
    const { readFileSync } = await import("node:fs");
    const code = readFileSync(new URL("../src/agents/agent-runner.ts", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    assert.match(code, /Array\.isArray\(agentConfig\?\.tools\) \|\| agentConfig\?\.tools === false \? \[\] : childBrowserToolNames\(\)/);
  });
});
