/**
 * The browser server registration: the URL follows the environment pi-local.sh
 * exports, the browse loop is direct, everything else is deferred, and a pi
 * without built-in MCP is told so instead of throwing.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import browserMcp, { BROWSER_SERVER, DIRECT_TOOLS, browserServerConfig } from "../browser-mcp.ts";

describe("browser MCP registration", () => {
  test("the URL comes from BROWSER_MCP_HOST / BROWSER_MCP_PORT", () => {
    assert.equal(browserServerConfig({ BROWSER_MCP_HOST: "10.0.0.5", BROWSER_MCP_PORT: "9999" }).url, "http://10.0.0.5:9999/mcp");
    assert.equal(browserServerConfig({}).url, "http://127.0.0.1:8931/mcp", "browser.sh's defaults");
  });

  test("the five browse-loop tools are direct and the rest codemode-only", () => {
    const config = browserServerConfig({});
    // Not "deferred": tool_search DECLARES what it loads, and a changed tool list
    // re-prefills the whole prompt on this template (measured: 10,397 tokens).
    assert.equal(config.exposure, "codemode");
    assert.deepEqual(Object.keys(config.toolExposure).sort(), [...DIRECT_TOOLS].sort());
    assert.ok(Object.values(config.toolExposure).every((e) => e === "direct"));
    assert.ok(!("start_browser" in config.toolExposure), "~2.3 KB of schema for a tool the server makes unnecessary");
  });

  test("registers under the name browser-guard.ts matches (mcp__browser__*)", () => {
    const calls: Array<[string, unknown]> = [];
    browserMcp({ registerMcpServer: (name, config) => calls.push([name, config]) });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], BROWSER_SERVER);
    assert.equal(BROWSER_SERVER, "browser");
  });

  test("a pi without built-in MCP warns and registers nothing", () => {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (m: unknown) => warnings.push(String(m));
    try {
      assert.doesNotThrow(() => browserMcp({}));
    } finally {
      console.warn = original;
    }
    assert.match(warnings.join("\n"), /needs >= 0\.99/);
  });
});
