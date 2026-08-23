/**
 * AN1 — the read that could not parse, and the write that finished it off.
 *
 * `readGlobalRaw()` was one `try`/`catch` returning `{}`, so **absent** (a fresh
 * install) and **malformed** (a hand-edit with a missing comma) were the same
 * answer. The first is right; the second says the operator has no settings when
 * what is true is that nobody could read them — and then `saveGlobal` writes
 * that `{}` plus one changed key over the only copy of the file.
 *
 * Driven through the real `ConfigStore` before the fix, with one comma removed:
 *
 * ```
 *   on disk BEFORE                       277 bytes, 6 agent keys, 2 concurrency
 *   effective default model after load   null            (was forge/qwen3.8-27b)
 *   effective concurrency after load     {"default":1}   (was 2, providers too)
 *   on disk AFTER one widget toggle      { "agent": { "showCompletionCards": false } }
 * ```
 *
 * The controls are both in this tree: the PROJECT layer of this same file
 * refuses to write a malformed file (ADR-0008, and `config-io.ts`'s header says
 * so out loud), and `prinny-channel/server/src/access.ts` quarantines
 * `access.json` — *"it may be a hand-edit the user wants back, and starting from
 * defaults beats refusing to run."*
 *
 * The global layer quarantines rather than refusing, and the reason is in
 * `json-store.ts`: a file that exists only to hold what the operator just typed
 * into a menu must not answer a toggle by silently doing nothing.
 *
 * `config-io.ts` imports pi's `getAgentDir`, so the suite cannot load it — which
 * is why the rule is a module. The wiring is pinned by source text at the bottom,
 * the way six suites in `vendor/prinny-channel/tests` do it.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  isPlainObject,
  quarantine,
  quarantineName,
  readJsonObject,
  writeJsonAtomic,
} from "../src/config/json-store.ts";

const SOURCE = readFileSync(new URL("../src/config/config-io.ts", import.meta.url), "utf8");

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "an1-subagents-"));
}

describe("readJsonObject — absent and malformed are two facts", () => {
  it("a file that is not there is absent", () => {
    assert.deepEqual(readJsonObject(join(scratch(), "nope.json")), { status: "absent" });
  });

  it("an empty file is absent, not malformed", () => {
    // A truncated write leaves nothing to keep; quarantining zero bytes only
    // makes a second file for the operator to delete.
    const file = join(scratch(), "empty.json");
    writeFileSync(file, "   \n");
    assert.equal(readJsonObject(file).status, "absent");
  });

  it("a syntax error is malformed, and says what the parser said", () => {
    const file = join(scratch(), "broken.json");
    writeFileSync(file, '{ "agent": { "graceTurns": 3 "widgetMaxLines": 20 } }');
    const read = readJsonObject(file);
    assert.equal(read.status, "malformed");
    assert.match(read.error ?? "", /Expected|JSON/i);
  });

  it("a top-level array is malformed", () => {
    const file = join(scratch(), "array.json");
    writeFileSync(file, "[1, 2, 3]");
    assert.deepEqual(readJsonObject(file), { status: "malformed", error: "not a JSON object" });
  });

  it("a valid object loads, with its value", () => {
    const file = join(scratch(), "ok.json");
    writeFileSync(file, '{ "agent": { "graceTurns": 3 } }');
    const read = readJsonObject(file);
    assert.equal(read.status, "loaded");
    assert.deepEqual(read.value, { agent: { graceTurns: 3 } });
  });

  it("a directory is malformed rather than absent — it is not nothing", () => {
    const dir = scratch();
    assert.equal(readJsonObject(dir).status, "malformed");
  });
});

describe("quarantine — the bytes survive", () => {
  it("renames to a timestamped sibling and returns the name", () => {
    const dir = scratch();
    const file = join(dir, "subagents-lite.json");
    writeFileSync(file, "{ broken");
    const moved = quarantine(file, Date.parse("2026-08-23T06:40:50.341Z"));
    assert.equal(moved, `${file}.corrupt-2026-08-23T06-40-50-341Z`);
    assert.equal(readFileSync(moved!, "utf8"), "{ broken", "the operator's bytes, unchanged");
    assert.equal(existsSync(file), false, "…and out of the way");
  });

  it("the name has no characters a shell or a filesystem argues with", () => {
    const name = quarantineName("/tmp/x.json", Date.parse("2026-08-23T06:40:50.341Z"));
    assert.doesNotMatch(name.slice("/tmp/x.json".length), /[:]/, "colons are not portable in a filename");
  });

  it("returns undefined when there is nothing to move", () => {
    assert.equal(quarantine(join(scratch(), "nope.json")), undefined);
  });
});

describe("writeJsonAtomic", () => {
  it("writes through a tmp file and leaves none behind", () => {
    const dir = scratch();
    const file = join(dir, "sub", "config.json");
    assert.deepEqual(writeJsonAtomic(file, { a: 1 }), { ok: true });
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { a: 1 });
    assert.deepEqual(
      readdirSync(join(dir, "sub")).filter((name) => name.endsWith(".tmp")),
      [],
    );
  });

  it("reports rather than throws when it cannot write", () => {
    // A FILE where a directory would have to be: ENOTDIR, immediately. (Not a
    // path under /proc — `mkdirSync(recursive)` does not return there in this
    // container, and a test that hangs is worse than one that is imprecise.)
    const dir = scratch();
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "not a directory");
    const written = writeJsonAtomic(join(blocker, "config.json"), { a: 1 });
    assert.equal(written.ok, false);
  });
});

describe("isPlainObject", () => {
  it("is about objects, not about truthiness", () => {
    assert.equal(isPlainObject({}), true);
    assert.equal(isPlainObject([]), false);
    assert.equal(isPlainObject(null), false);
    assert.equal(isPlainObject("{}"), false);
  });
});

describe("AN1 — config-io's wiring", () => {
  it("the global save quarantines before it replaces", () => {
    const save = SOURCE.slice(SOURCE.indexOf("saveGlobal: (config)"), SOURCE.indexOf("saveProject: (config)"));
    assert.match(save, /globalStatus === "malformed"/, "the save has to know what the read found");
    const quarantineAt = save.indexOf("quarantine(CONFIG_PATH)");
    const writeAt = save.indexOf("writeJsonAtomic(CONFIG_PATH");
    assert.ok(quarantineAt >= 0 && writeAt > quarantineAt, "move the bytes aside BEFORE writing over them");
  });

  it("the project save still refuses instead — the deliberate asymmetry", () => {
    const save = SOURCE.slice(SOURCE.indexOf("saveProject: (config)"));
    assert.match(save, /Refusing to write project config/, "ADR-0008: a malformed project file is never written");
  });

  it("the load reports the global layer's status to the store", () => {
    assert.match(SOURCE, /globalStatus: LayerStatus/);
    assert.match(SOURCE, /globalStatus,/, "…and hands it back in LoadedConfig");
  });

  it("both layers go through one reader", () => {
    assert.equal(SOURCE.split("readJsonObject(").length - 1, 2, "the global layer and the project layer");
  });
});
