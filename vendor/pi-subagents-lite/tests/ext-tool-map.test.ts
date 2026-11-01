/**
 * buildExtToolMap merges the tools of extensions that resolve to one name.
 *
 * All three vendored extensions here load from `extensions/index.ts`, so the
 * path-derived name of each is `index`, and the map kept only the last one's
 * tools: an agent allow-listing one of them by name could get another's tools
 * or none. Latent today (only .pi/extensions/stack.ts registers a tool, and it
 * guards itself in children). Upstream 1.17.1 keys by package name where there
 * is one and merges what still collides.
 *
 * A source pin, because the function is private to agent-runner.ts, which
 * imports pi; making it testable by running it would widen its visibility.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

describe("buildExtToolMap", () => {
  const code = readFileSync(new URL("../src/agents/agent-runner.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  const body = code.slice(code.indexOf("function buildExtToolMap("), code.indexOf("function filterExtensions("));

  it("keys by package name first", () => {
    assert.match(body, /extensionPackageName\(ext\.path\) \?\? extractExtensionName\(ext\.path\)/);
  });

  it("merges instead of overwriting", () => {
    assert.match(body, /map\.set\(name, \[\.\.\.new Set\(\[\.\.\.\(map\.get\(name\) \?\? \[\]\), \.\.\.tools\]\)\]\)/);
    assert.doesNotMatch(body, /map\.set\(name, tools\)/);
  });
});
