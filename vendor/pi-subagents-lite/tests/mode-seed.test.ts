/**
 * The mode seed — a launcher-chosen session layer that every reset returns to.
 *
 * Orchestrator mode (`ORCHESTRATOR=1` in `.env`) runs the parent on the local
 * model and every child on a remote one, with a per-provider concurrency cap.
 * Those two settings cannot go in the global `subagents-lite.json` (the
 * operator's own file, shared with every other mode) or in a project's
 * `.pi/subagents-lite.json` (pi's cwd is whatever project is being worked on,
 * not this repo). They belong to the SESSION: in force for this launch, never
 * written anywhere.
 *
 * The store already has a session layer, and it resets it to EMPTY in five
 * places — `reload()` at every session_start, and four "clear" actions in
 * `/agents`. An empty session layer in orchestrator mode means the next child
 * silently runs on the parent's local model, on the one llama slot, which is
 * the failure this mode exists to avoid. So every reset returns to the seed.
 *
 * `mode-seed.ts` imports nothing from pi, so the logic is tested directly; the
 * store imports pi, so its wiring is pinned from source, as `json-store.test.ts`
 * does for `config-io.ts`.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { MODE_CONFIG_ENV, readModeSeed, withoutOverride } from "../src/config/mode-seed.ts";

function seedFile(body: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "mode-seed-"));
  const path = join(dir, "mode.json");
  writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body));
  return path;
}

const VALID = {
  model: "deepseek/deepseek-flash",
  concurrency: { providers: { deepseek: 15, forge: 1 } },
};

describe("readModeSeed", () => {
  it("is empty when no mode file is named, which is every mode but this one", () => {
    const seed = readModeSeed({});
    assert.deepEqual(seed.overrides, { default: null });
    assert.deepEqual(seed.concurrency, {});
    assert.equal(seed.error, undefined);
  });

  it("puts the mode's model in the session default and its caps in the session concurrency", () => {
    const seed = readModeSeed({ [MODE_CONFIG_ENV]: seedFile(VALID) });
    assert.equal(seed.error, undefined);
    assert.deepEqual(seed.overrides, { default: "deepseek/deepseek-flash" });
    assert.deepEqual(seed.concurrency, { providers: { deepseek: 15, forge: 1 } });
  });

  it("returns fresh objects, so a store mutating one cannot edit the next reset", () => {
    const path = seedFile(VALID);
    const first = readModeSeed({ [MODE_CONFIG_ENV]: path });
    first.overrides.default = "forge/qwen";
    first.concurrency.providers!.deepseek = 1;
    const second = readModeSeed({ [MODE_CONFIG_ENV]: path });
    assert.equal(second.overrides.default, "deepseek/deepseek-flash");
    assert.equal(second.concurrency.providers!.deepseek, 15);
  });

  // Each refusal is loud and applies NOTHING. Half a seed — the model without
  // its cap, or the reverse — is worse than none, because it looks configured.
  const REFUSED: Array<[string, unknown]> = [
    ["a file that is not JSON", "{not json"],
    ["a JSON value that is not an object", ["deepseek/deepseek-flash"]],
    ["a model with no provider", { model: "deepseek-flash" }],
    ["a model that is not a string", { model: 7 }],
    ["a cap that is not an integer", { concurrency: { providers: { deepseek: 1.5 } } }],
    ["a cap below one", { concurrency: { providers: { deepseek: 0 } } }],
    ["a cap map that is not an object", { concurrency: { providers: 15 } }],
    ["an unknown top-level key", { model: "deepseek/deepseek-flash", modle: "x" }],
  ];
  for (const [label, body] of REFUSED) {
    it(`refuses ${label}, whole`, () => {
      const seed = readModeSeed({ [MODE_CONFIG_ENV]: seedFile(body) });
      assert.ok(seed.error, `no error for ${label}`);
      assert.deepEqual(seed.overrides, { default: null });
      assert.deepEqual(seed.concurrency, {});
    });
  }

  it("says which file it could not read, rather than failing silently", () => {
    const seed = readModeSeed({ [MODE_CONFIG_ENV]: "/nonexistent/mode.json" });
    assert.match(seed.error ?? "", /\/nonexistent\/mode\.json/);
  });
});

describe("withoutOverride", () => {
  const seed = { default: "deepseek/deepseek-flash" };

  it("clearing the session default falls back to the mode's, not to the parent's model", () => {
    const next = withoutOverride({ default: "forge/other" }, "default", seed);
    assert.equal(next.default, "deepseek/deepseek-flash");
  });

  it("clearing a per-type override removes it when the mode has none for that type", () => {
    const next = withoutOverride({ default: "deepseek/deepseek-flash", Explore: "forge/x" }, "Explore", seed);
    assert.equal(next.Explore, undefined);
    assert.equal(next.default, "deepseek/deepseek-flash");
  });

  it("does not mutate what it was given", () => {
    const current = { default: "forge/other" };
    withoutOverride(current, "default", seed);
    assert.equal(current.default, "forge/other");
  });
});

describe("the store's resets go through the seed", () => {
  const STORE = readFileSync(new URL("../src/config/config-store.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");

  it("no reset writes an empty session layer any more", () => {
    assert.doesNotMatch(STORE, /sessionOverrides(\s*:\s*\w+)?\s*=\s*\{\s*default:\s*null\s*\}/);
    assert.doesNotMatch(STORE, /sessionConcurrencyLayer(\s*:\s*\w+)?\s*=\s*\{\s*\}/);
  });

  it("control — the resets are still there, and read the seed", () => {
    // Five model resets (reload, clearAllModelOverrides, session.clearAll, and
    // the two field initialisers) and three concurrency ones (reload,
    // concurrency clearAll, initialiser). Fewer means a reset was deleted rather
    // than redirected, which would pass the check above for the wrong reason.
    assert.ok((STORE.match(/sessionOverrides(\s*:\s*\w+)?\s*=\s*[^;]*seed[^;]*\.overrides/gi) ?? []).length >= 4);
    assert.ok((STORE.match(/sessionConcurrencyLayer(\s*:\s*\w+)?\s*=\s*[^;]*seed[^;]*\.concurrency/gi) ?? []).length >= 3);
  });

  it("clearing one override goes through withoutOverride", () => {
    assert.ok((STORE.match(/withoutOverride\(/g) ?? []).length >= 2);
  });
});
