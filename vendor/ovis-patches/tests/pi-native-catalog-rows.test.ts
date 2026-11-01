/**
 * The rows Ovis gets for a pi pane, and every way a catalog file is refused
 * (another pane, a dead pi, another session, another format).
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { piCatalogRows } from "../pi-native-catalog-rows.ts";

const pane = { pane_id: "w1:p1", agent_session: { value: "/s/a.jsonl" } };
const alive = () => true;
const catalog = {
  version: 1,
  pane_id: "w1:p1",
  pid: 42,
  session_file: "/s/a.jsonl",
  commands: [
    { name: "stack", description: "Stack status", source: "extension", path: "/r/.pi/extensions/stack.ts" },
    { name: "loop-examples", description: "", source: "prompt", path: "/r/prompts/loop-examples.md" },
    { name: "skill:browser-tools", description: "Browser", source: "skill" },
    { name: "weird", source: "something-new" },
    { name: "", source: "extension" },
  ],
};

describe("piCatalogRows", () => {
  test("maps pi's sources onto Ovis's, with stable ids", () => {
    assert.deepEqual(piCatalogRows(catalog, pane, alive), [
      { name: "stack", description: "Stack status", source: "plugin", id: "/r/.pi/extensions/stack.ts" },
      { name: "loop-examples", description: "Run /loop-examples", source: "user", id: "/r/prompts/loop-examples.md" },
      { name: "skill:browser-tools", description: "Browser", source: "skill", origin: "user", id: "pi:skill:skill:browser-tools" },
    ]);
  });

  test("a command that draws its own TUI is a terminal command", () => {
    const rows = piCatalogRows({ ...catalog, commands: [{ name: "agents", source: "extension" }] }, pane, alive);
    assert.equal(rows?.[0].visibility, "terminal");
    assert.deepEqual(rows?.[0].forms?.map((f) => f.interaction), ["terminal", "terminal"]);
  });

  test("another pane's file is refused", () => {
    assert.equal(piCatalogRows({ ...catalog, pane_id: "w2:p1" }, pane, alive), null);
  });

  test("a dead pi's file is refused", () => {
    assert.equal(piCatalogRows(catalog, pane, () => false), null);
  });

  test("another session's file is refused", () => {
    assert.equal(piCatalogRows({ ...catalog, session_file: "/s/b.jsonl" }, pane, alive), null);
  });

  test("a pane herdr names no session for still gets its rows", () => {
    assert.equal(piCatalogRows(catalog, { pane_id: "w1:p1" }, alive)?.length, 3);
  });

  test("another format is refused", () => {
    assert.equal(piCatalogRows({ ...catalog, version: 2 }, pane, alive), null);
    assert.equal(piCatalogRows(null, pane, alive), null);
    assert.equal(piCatalogRows({ ...catalog, commands: "x" }, pane, alive), null);
  });
});
