/**
 * The loop, as a tool the model can call itself.
 *
 * Upstream exposes loop control only as `/loop`. A model cannot type a slash
 * command — it can only call tools — so upstream's loop is something a human
 * starts and a human stops. That is the wrong shape here: the model is the one
 * that knows it has a goal and a way to check it, and a subagent running a
 * bounded loop in its own window is the best version of delegation on a stack
 * with one llama slot.
 *
 * What is asserted here is the part a guard would silently skip: that the tool
 * is registered at all, that it drives the same code path as the command, that
 * it hands the model back the text the command would only have shown the
 * operator, and that `stop` does not abort the very turn that called it.
 */

import assert from "node:assert/strict";
import { before, beforeEach, describe, it } from "node:test";

import loopModeExtension from "../extensions/index.ts";
import { parseStartArgs } from "../src/arguments.ts";

type ToolDef = {
  name: string;
  description?: string;
  parameters: Record<string, any>;
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: unknown,
  ) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>;
};

const notifications: { message: string; level: string }[] = [];
let aborts = 0;
let tool: ToolDef | undefined;
let commandHandler: ((args: string, ctx: any) => Promise<void>) | undefined;

const pi = {
  on() {},
  registerCommand(_name: string, config: { handler: (args: string, ctx: any) => Promise<void> }) {
    commandHandler = config.handler;
  },
  registerTool(def: ToolDef) {
    tool = def;
  },
  appendEntry() {},
  sendMessage() {},
  async exec() {
    return { code: 0, stdout: "", stderr: "" };
  },
  async setModel() {
    return true;
  },
};

const ctx = {
  cwd: process.cwd(),
  mode: "tui",
  hasUI: true,
  ui: {
    notify(message: string, level = "info") {
      notifications.push({ message, level });
    },
    setStatus() {},
  },
  sessionManager: { getBranch: () => [], getEntries: () => [] },
  modelRegistry: { find: () => undefined, getAll: () => [] },
  model: undefined,
  // The state that matters for the abort assertion: the agent is streaming,
  // because a tool only ever runs mid-turn.
  isIdle: () => false,
  hasPendingMessages: () => false,
  getContextUsage: () => undefined,
  compact() {},
  abort() {
    aborts++;
  },
  async waitForIdle() {},
};

const call = (params: Record<string, unknown>) => tool!.execute("id", params, undefined, undefined, ctx);

before(() => {
  loopModeExtension(pi as any);
});

beforeEach(() => {
  notifications.length = 0;
  aborts = 0;
});

describe("loop tool registration", () => {
  it("is registered alongside the command, not instead of it", () => {
    assert.ok(tool, "no loop tool was registered");
    assert.ok(commandHandler, "the /loop command must still exist");
    assert.equal(tool!.name, "loop");
  });

  it("asks for an action and nothing else, so the schema stays cheap", () => {
    assert.deepEqual(tool!.parameters.required, ["action"]);
    assert.equal(tool!.parameters.additionalProperties, false);
    assert.deepEqual(Object.keys(tool!.parameters.properties).sort(), [
      "action",
      "check",
      "goal",
      "max",
      "until_done",
    ]);
  });

  it("describes itself in a way that says when NOT to use it", () => {
    // A local model reaches for whatever is in front of it. The description is
    // the only thing standing between "iterate toward a goal" and "answer a
    // question in a loop".
    assert.match(tool!.description ?? "", /not for a single answer/i);
  });
});

describe("loop tool behaviour", () => {
  it("refuses to start without a goal, and says what a goal looks like", () => {
    return call({ action: "start" }).then((result) => {
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /Done when/);
    });
  });

  it("refuses a goal that is only whitespace", async () => {
    const result = await call({ action: "start", goal: "   " });
    assert.equal(result.isError, true);
  });

  it("returns the text the command would only have shown the operator", async () => {
    const result = await call({ action: "status" });
    assert.equal(result.isError, undefined);
    assert.ok(result.content[0].text.length > 0, "a tool that reports nothing is useless to the model");
    // Same text, both ways out: whatever notify() said is what the model gets.
    assert.ok(
      notifications.some((n) => result.content[0].text.includes(n.message)),
      "the tool result must carry the notice, not a paraphrase of it",
    );
  });

  it("does not abort the turn that called it when stopping", async () => {
    // The command aborts the in-flight turn to drop queued loop follow-ups.
    // Called from a tool, the in-flight turn IS this one — aborting it throws
    // away the tool result and leaves the model unable to tell whether the stop
    // took. ctx.isIdle() is false here, so an unguarded abort would fire.
    await call({ action: "start", goal: "keep going. Done when: never" });
    notifications.length = 0;
    const result = await call({ action: "stop" });
    assert.equal(aborts, 0, "the tool path must not abort its own turn");
    assert.match(result.content[0].text, /stopped/i);
  });

  it("still stops the loop despite not aborting", async () => {
    await call({ action: "start", goal: "keep going. Done when: never" });
    await call({ action: "stop" });
    const status = await call({ action: "status" });
    assert.match(status.content[0].text, /stopped/i);
  });

  it("survives an unknown action rather than throwing into the turn", async () => {
    const result = await call({ action: "wibble" });
    assert.ok(typeof result.content[0].text === "string");
  });

  it("refuses an unknown action instead of looping on it", async () => {
    // This is the sharp edge the assertion above used to walk straight past.
    // `loopCommand`'s last branch is the `/loop <goal>` convenience: anything it
    // does not recognise becomes a GOAL. Right for a human typing a command,
    // a trap for a model guessing a verb — `action: "pause"` started an endless
    // loop whose goal was the word "pause", and endless is the default.
    await call({ action: "end" });
    const result = await call({ action: "pause" });
    assert.equal(result.isError, true, "an unknown action is an error, not a goal");
    assert.match(result.content[0].text, /unknown action/i);
    assert.match(result.content[0].text, /start/, "it must say what the valid actions are");

    const status = await call({ action: "status" });
    assert.match(status.content[0].text, /Active: false/, "nothing may have been started");
    assert.doesNotMatch(status.content[0].text, /Goal: pause/);
  });
});

/**
 * The tool builds a `/loop` argument string and hands it to the same parser the
 * slash command uses, so the round-trip has to survive whatever the model puts
 * in a check command.
 */
describe("loop tool — the --check round-trip", () => {
  it("keeps a check command that contains double quotes", () => {
    // argsForLoopTool builds this with JSON.stringify, so a command with a
    // quote in it arrives escaped. The old `"([^"]*)"` stopped at the first
    // backslash-quote and configured the loop with `grep \` — which runs, fails,
    // and is reported as a failing goal check rather than as a broken config.
    const command = 'grep -q "all tests passed" out.log';
    const parsed = parseStartArgs(`start build it. Done when: green --check ${JSON.stringify(command)}`);
    assert.equal(parsed.checkCommand, command);
  });

  it("leaves backslashes that are not escapes alone", () => {
    // A Windows path is the case a general unescape would break.
    const parsed = parseStartArgs(String.raw`goal --check "C:\bin\test.exe"`);
    assert.equal(parsed.checkCommand, String.raw`C:\bin\test.exe`);
  });

  it("still handles the plain and single-quoted forms a human types", () => {
    assert.equal(parseStartArgs('goal --check "npm test"').checkCommand, "npm test");
    assert.equal(parseStartArgs("goal --check 'npm test'").checkCommand, "npm test");
    assert.equal(parseStartArgs("goal --check npm-test").checkCommand, "npm-test");
    assert.equal(parseStartArgs('goal --check="npm test"').checkCommand, "npm test");
  });

  it("does not leave the check flag behind in the goal text", () => {
    const parsed = parseStartArgs('ship the parser. Done when: green --check "npm test"');
    assert.equal(parsed.description, "ship the parser");
    assert.equal(parsed.criteria, "green");
  });
});
