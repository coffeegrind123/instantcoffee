/**
 * The `exclude_*` keys read the same four words as their whitelist twins.
 *
 * U6 was `tools: true` becoming the one-element allowlist `["true"]`, because
 * `tools` went through `parseStringArray` (any non-empty scalar is a comma list)
 * while `extensions:` and `skills:` on the next lines went through
 * `parseExtensions`, which understands `true|all|false|none`.
 *
 * `exclude_tools:` and `exclude_extensions:` were the two keys that fix did not
 * reach. `exclude_tools: none` — the natural way to write "exclude nothing" —
 * became the one-element exclusion `["none"]`, a phantom tool nobody has; and
 * `exclude_tools: all` became `["all"]`, which excludes nothing at all, i.e. the
 * exact opposite of the word.
 *
 *   false | "false" | "none"  →  undefined   exclude nothing
 *   true  | "true"  | "all"   →  true        exclude everything
 *   "a, b" | ["a","b"]        →  ["a","b"]
 *
 * See §9 of `context/design/subagents-loop-verifier-hosts.md`.
 */

import assert from "node:assert/strict";
import { register } from "node:module";
import { describe, it } from "node:test";

// agent-discovery.ts and agent-types.ts use `.js` specifiers for files that are
// `.ts` on disk. Same inline hook as agent-frontmatter.test.ts.
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

const { parseExcludeList } = await import("../src/agents/agent-discovery.ts");
const { resolveVisibleTools } = await import("../src/agents/agent-types.ts");

describe("parseExcludeList — the four words, on the two keys U6 did not reach", () => {
  it('"none" and false mean exclude nothing', () => {
    assert.equal(parseExcludeList("none"), undefined);
    assert.equal(parseExcludeList("false"), undefined);
    assert.equal(parseExcludeList(false), undefined);
  });

  it('"all" and true mean exclude everything', () => {
    assert.equal(parseExcludeList("all"), true);
    assert.equal(parseExcludeList("true"), true);
    assert.equal(parseExcludeList(true), true);
  });

  it("control — a real list is still a list", () => {
    assert.deepEqual(parseExcludeList("bash, write"), ["bash", "write"]);
    assert.deepEqual(parseExcludeList(["bash", "write"]), ["bash", "write"]);
  });

  it("control — an absent key is absent", () => {
    assert.equal(parseExcludeList(undefined), undefined);
    assert.equal(parseExcludeList(""), undefined);
  });
});

describe("resolveVisibleTools honours the `all` spelling", () => {
  const activeTools = ["read", "write", "bash", "grep"];

  it("excludeTools: true leaves the agent with no tools", () => {
    assert.deepEqual(resolveVisibleTools({ activeTools, excludeTools: true }), []);
  });

  it("control — a real exclusion still removes only what it names", () => {
    assert.deepEqual(resolveVisibleTools({ activeTools, excludeTools: ["bash"] }), ["read", "write", "grep"]);
  });

  it('control — "none" reaches this as undefined, so nothing is excluded', () => {
    // The whole point of the parse fix: `exclude_tools: none` must not become an
    // exclusion of a tool called "none". `null` means "no change" here.
    assert.equal(resolveVisibleTools({ activeTools, excludeTools: parseExcludeList("none") }), null);
  });

  it("control — a whitelist still wins over an exclusion", () => {
    assert.deepEqual(resolveVisibleTools({ activeTools, tools: ["read"], excludeTools: true }), ["read"]);
  });
});
