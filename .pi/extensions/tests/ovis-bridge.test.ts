/**
 * .pi/extensions/ovis-bridge.ts against a fake pi: the catalog file, the notices,
 * the status line and the effort, and that it stays inert outside a herdr pane.
 * The real round trip (Ovis listing the commands, showing the notices) is checked
 * live; see context/HANDOFF.md part 22.
 */

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const BRIDGE = join(dirname(dirname(fileURLToPath(import.meta.url))), "ovis-bridge.ts");
const ENV_KEYS = ["HERDR_ENV", "HERDR_PANE_ID", "OVIS_PI_CATALOG_DIR", "OVIS_PI_PREVIEW_DIR", "HERDR_BIN_PATH", "OVIS_REASONING_EFFORT"];
const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

function harness(opts: { appendThrows?: boolean; sessionFile?: string } = {}) {
  const handlers = new Map<string, Handler[]>();
  const entries: { type: string; data: unknown }[] = [];
  const shown: { message: string; type?: string }[] = [];
  const statusesShown: [string, string | undefined][] = [];
  const pi = {
    on(name: string, fn: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), fn]);
    },
    getCommands: () => [
      { name: "stack", description: "Stack status", source: "extension", sourceInfo: { path: "/r/.pi/extensions/stack.ts" } },
      { name: "loop-examples", description: "Loop examples", source: "prompt", sourceInfo: { path: "/r/prompts/loop-examples.md" } },
      { name: "skill:browser-tools", description: "Browser", source: "skill", sourceInfo: { path: "/r/skills/browser-tools/SKILL.md" } },
    ],
    appendEntry(type: string, data: unknown) {
      if (opts.appendThrows) throw new Error("session closed");
      entries.push({ type, data });
    },
  };
  // ONE ui object, shared, as pi's runner hands every extension the same one
  const ui = {
    notify(message: string, type?: string) {
      shown.push({ message, type });
    },
    setStatus(key: string, text: string | undefined) {
      statusesShown.push([key, text]);
    },
  };
  const sessionManager = {
    getSessionFile: () => opts.sessionFile ?? "/s/session.jsonl",
    getHeader: () => ({ type: "session", id: "abc" }),
    getEntries: () => entries.map((e) => ({ type: "custom", customType: e.type, data: e.data })),
  };
  const ctx = { ui, sessionManager };
  const fire = async (name: string) => {
    for (const fn of handlers.get(name) ?? []) await fn({ type: name, reason: "startup" }, ctx);
  };
  return { pi, ui, ctx, fire, entries, shown, statusesShown, handlers };
}

async function load(pi: unknown) {
  const mod = await import(`${BRIDGE}?t=${Math.random()}`);
  mod.default(pi);
  return mod;
}

function pane(dir: string, extra: Record<string, string> = {}) {
  process.env.HERDR_ENV = "1";
  process.env.HERDR_PANE_ID = "w1:p1";
  process.env.OVIS_PI_CATALOG_DIR = dir;
  process.env.OVIS_PI_PREVIEW_DIR = join(dir, "preview");
  for (const [key, value] of Object.entries(extra)) process.env[key] = value;
}

describe("ovis-bridge", () => {
  test("is inert outside a herdr pane", async () => {
    delete process.env.HERDR_ENV;
    const h = harness();
    await load(h.pi);
    assert.equal(h.handlers.size, 0);
  });

  test("control: it registers inside one", async () => {
    pane(mkdtempSync(join(tmpdir(), "ovis-cat-")));
    const h = harness();
    await load(h.pi);
    assert.ok(h.handlers.has("session_start"));
  });

  test("writes the live command list for this pane, bound to pid and session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ovis-cat-"));
    pane(dir);
    const h = harness();
    await load(h.pi);
    await h.fire("session_start");
    const catalog = JSON.parse(readFileSync(join(dir, "w1:p1.json"), "utf8"));
    assert.equal(catalog.version, 1);
    assert.equal(catalog.pane_id, "w1:p1");
    assert.equal(catalog.pid, process.pid);
    assert.equal(catalog.session_file, "/s/session.jsonl");
    assert.deepEqual(catalog.commands.map((c: { name: string }) => c.name), ["stack", "loop-examples", "skill:browser-tools"]);
    assert.equal(catalog.commands[0].path, "/r/.pi/extensions/stack.ts");
  });

  test("every extension's notify is shown AND saved as an ovis-notice", async () => {
    pane(mkdtempSync(join(tmpdir(), "ovis-cat-")));
    const h = harness();
    await load(h.pi);
    await h.fire("session_start");
    h.ui.notify("Stack: forge up", "warning");   // as another extension would call it
    assert.deepEqual(h.shown, [{ message: "Stack: forge up", type: "warning" }]);
    assert.deepEqual(h.entries.filter((e) => e.type === "ovis-notice"),
      [{ type: "ovis-notice", data: { message: "Stack: forge up", level: "warning" } }]);
  });

  test("wraps once, however many sessions and turns start", async () => {
    pane(mkdtempSync(join(tmpdir(), "ovis-cat-")));
    const h = harness();
    await load(h.pi);
    await h.fire("session_start");
    await h.fire("agent_start");
    await h.fire("session_start");
    h.ui.notify("once");
    assert.equal(h.entries.filter((e) => e.type === "ovis-notice").length, 1);
    assert.equal(h.shown.length, 1);
  });

  test("a notice that cannot be saved still shows", async () => {
    pane(mkdtempSync(join(tmpdir(), "ovis-cat-")));
    const h = harness({ appendThrows: true });
    await load(h.pi);
    await h.fire("session_start");
    h.ui.notify("still here");
    assert.deepEqual(h.shown, [{ message: "still here", type: undefined }]);
  });

  test("records the stack's reasoning effort once per session start", async () => {
    pane(mkdtempSync(join(tmpdir(), "ovis-cat-")), { OVIS_REASONING_EFFORT: "medium" });
    const h = harness();
    await load(h.pi);
    await h.fire("session_start");
    assert.deepEqual(h.entries.filter((e) => e.type === "ovis-meta"), [{ type: "ovis-meta", data: { reasoningEffort: "medium" } }]);
  });

  test("a session pi has not written yet is previewed outside its sessions dir, then dropped", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ovis-cat-"));
    pane(dir);
    const sessionFile = join(dir, "sessions", "2026_x.jsonl");
    const h = harness({ sessionFile });
    await load(h.pi);
    await h.fire("session_start");
    h.ui.notify("Stack: ok");
    const preview = join(dir, "preview", "2026_x.jsonl");
    const lines = readFileSync(preview, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(lines[0], { type: "session", id: "abc" });
    assert.ok(lines.some((l) => l.customType === "ovis-notice" && l.data.message === "Stack: ok"));
    mkdirSync(join(dir, "sessions"));
    writeFileSync(sessionFile, "{}\n");            // pi wrote its file
    h.ui.notify("again");
    assert.equal(existsSync(preview), false, "the preview must go once pi has written the session");
  });

  test("an unchanged session leaves the preview file alone", async () => {
    // Rewritten every second, it got a new inode every second; Ovis then
    // reloaded the chat each time and an opened notice snapped shut (2026-11-01).
    const dir = mkdtempSync(join(tmpdir(), "ovis-cat-"));
    pane(dir);
    const h = harness({ sessionFile: join(dir, "sessions", "s.jsonl") });
    await load(h.pi);
    await h.fire("session_start");
    const preview = join(dir, "preview", "s.jsonl");
    const before = statSync(preview).ino;
    await new Promise((resolve) => setTimeout(resolve, 2300));   // two refresh ticks
    assert.equal(statSync(preview).ino, before, "the preview was rewritten without a change");
    h.ui.notify("something new");
    assert.notEqual(statSync(preview).ino, before, "control: a change must still be written");
  });

  test("ending the session removes its preview", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ovis-cat-"));
    pane(dir);
    const h = harness({ sessionFile: join(dir, "sessions", "s.jsonl") });
    await load(h.pi);
    await h.fire("session_start");
    assert.ok(existsSync(join(dir, "preview", "s.jsonl")));
    await h.fire("session_shutdown");
    assert.equal(existsSync(join(dir, "preview", "s.jsonl")), false);
  });

  test("statuses reach the catalog and herdr's display_agent line", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ovis-cat-"));
    const calls = join(dir, "herdr-calls");
    const herdr = join(dir, "herdr");
    writeFileSync(herdr, `#!/bin/sh\nprintf '%s\\n' "$@" > "${calls}"\n`);
    chmodSync(herdr, 0o755);
    pane(dir, { HERDR_BIN_PATH: herdr });
    const h = harness();
    await load(h.pi);
    await h.fire("session_start");
    h.ui.setStatus("loop", "Loop 3/50");
    h.ui.setStatus("observe", "observe on");
    assert.deepEqual(h.statusesShown, [["loop", "Loop 3/50"], ["observe", "observe on"]]);
    const catalog = JSON.parse(readFileSync(join(dir, "w1:p1.json"), "utf8"));
    assert.deepEqual(catalog.statuses, { loop: "Loop 3/50", observe: "observe on" });
    await new Promise((resolve) => setTimeout(resolve, 1400));
    assert.ok(existsSync(calls), "herdr was not called");
    const args = readFileSync(calls, "utf8").trim().split("\n");
    assert.deepEqual(args, ["pane", "report-metadata", "w1:p1", "--source", "instantcoffee", "--display-agent", "pi · Loop 3/50 · observe on"]);
  });
});
