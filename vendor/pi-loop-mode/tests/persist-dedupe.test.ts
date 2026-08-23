/**
 * AN5 — the state written thirty-three times and read once.
 *
 * `persistState` appends a `loop-state` custom entry through `pi.appendEntry`,
 * and `restoreLoopState` reads exactly ONE of them back: the last on the branch.
 * Every other entry exists only to be walked past.
 *
 * Measured on a real session file under `~/.pi/agent/sessions` before the fix:
 *
 * ```
 *   session file                                   948,959 bytes
 *   loop-state entries                          59
 *   bytes they account for                     392,245   41.3% of the file
 *   mean entry                                   6,648
 *   byte-identical to the entry before it           24   41% of the entries
 * ```
 *
 * Two of every five carried no information. `/loop end` writes `defaultState()`
 * however many times it is run; `session_compact`'s handler persists straight
 * after pi finishes compacting, with `contextCompressionLevel = 0` that was
 * already 0; several rungs of `agent_end` set a field and persist next to a rung
 * that just did.
 *
 * ## The trap in the fix, which is what these tests are mostly about
 *
 * The memo is per SESSION and the module is per PROCESS — the same split AM4
 * fell into one field over. A new session starts with an empty branch, so
 * `restoreState` hands back `defaultState()`; if the previous session's last
 * write was also `defaultState()`, the first write in the NEW session would
 * match the memo, be skipped, and leave that session's file with no loop-state
 * entry at all. A later restore would then find nothing and the loop would be
 * gone.
 *
 * So both session transitions drop it, and `session_shutdown`/`session_start`
 * each get a test of their own.
 *
 * ## Control
 *
 * The first test in each pair changes one field and asserts BOTH writes land, so
 * a fix that simply stopped persisting would fail the suite rather than pass it.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";

import loopModeExtension from "../extensions/index.ts";
import { STATE_ENTRY_TYPE } from "../src/loop-state.ts";
import { completedCheck } from "./exec-shapes.ts";

type Handler = (event: any, ctx: any) => Promise<any>;

const handlers = new Map<string, Handler>();
let commandHandler: (args: string, ctx: any) => Promise<void>;

let branch: any[] = [];
/** Every `appendEntry` this session saw, in order. */
let appended: { customType: string; data: any }[] = [];

const pi = {
  on(event: string, handler: Handler) {
    handlers.set(event, handler);
  },
  registerCommand(_name: string, config: { handler: (args: string, ctx: any) => Promise<void> }) {
    commandHandler = config.handler;
  },
  registerTool() {},
  appendEntry(customType: string, data: unknown) {
    appended.push({ customType, data });
    branch.push({ type: "custom", customType, data });
  },
  sendMessage() {},
  async exec() {
    return completedCheck(0);
  },
  async setModel() {
    return true;
  },
};

const ctx = {
  cwd: process.cwd(),
  mode: "tui",
  hasUI: true,
  ui: { notify() {}, setStatus() {} },
  sessionManager: { getBranch: () => branch, getEntries: () => branch },
  modelRegistry: { find: () => undefined, getAll: () => [] },
  model: { api: "openai-completions", contextWindow: 32_768 },
  isIdle: () => true,
  hasPendingMessages: () => false,
  getContextUsage: () => ({ percent: 10, contextWindow: 32_768, tokens: 3_276 }),
  compact() {},
  abort() {},
  async waitForIdle() {},
};

function emit(event: string, payload: unknown = {}): Promise<any> {
  const handler = handlers.get(event);
  assert.ok(handler, `extension registered no ${event} handler`);
  return handler(payload, ctx);
}

/** Only the loop's own entries; nothing else writes any, but the filter states it. */
function stateEntries(): { customType: string; data: any }[] {
  return appended.filter((entry) => entry.customType === STATE_ENTRY_TYPE);
}

loopModeExtension(pi as never);

beforeEach(async () => {
  branch = [{ type: "message" }];
  appended = [];
  // `end` sets `state = defaultState()`, which is the payload two consecutive
  // `end`s both produce and therefore what the dedupe is about. The `start`
  // after it primes the memo with something ELSE, so each test's first write is
  // a real one whether or not the session hooks reset anything — otherwise the
  // memo would carry the previous test's last payload into this one and the
  // suite would be testing its own leftovers.
  await commandHandler("end", ctx);
  await commandHandler("start Prime the memo with a different payload", ctx);
  appended = [];
});

describe("AN5 — an identical loop-state payload is not written twice", () => {
  test("two writes of the same state produce one entry", async () => {
    await commandHandler("end", ctx);
    await commandHandler("end", ctx);
    assert.equal(stateEntries().length, 1, "the second `/loop end` said nothing new");
  });

  test("a write that changes something still lands — the control", async () => {
    await commandHandler("start Improve the site. Done when: the build passes", ctx);
    await commandHandler("end", ctx);
    assert.equal(
      stateEntries().length,
      2,
      "a start and an end are two different states and both have to be written",
    );
  });

  test("the entry that is written carries the state, not a diff", async () => {
    await commandHandler("start Improve the site. Done when: the build passes", ctx);
    const entry = stateEntries().at(-1);
    assert.ok(entry, "the start must have written an entry");
    assert.equal(entry.data.active, true);
    assert.equal(entry.data.description, "Improve the site");
  });
});

describe("AN5 — the memo is per session, not per process", () => {
  test("session_shutdown re-arms the writer", async () => {
    await commandHandler("end", ctx);
    assert.equal(stateEntries().length, 1);

    await emit("session_shutdown", {});
    await commandHandler("end", ctx);

    assert.equal(
      stateEntries().length,
      2,
      "a session that has ended must not suppress the next session's first write",
    );
  });

  test("session_start re-arms the writer", async () => {
    await commandHandler("end", ctx);
    assert.equal(stateEntries().length, 1);

    // A NEW session: an empty branch, which is what `restoreState` reads.
    branch = [{ type: "message" }];
    await emit("session_start", {});
    await commandHandler("end", ctx);

    assert.equal(
      stateEntries().length,
      2,
      "the new session's own file has to get an entry, or a later restore finds nothing",
    );
  });

  test("the new session's entry really is on its own branch", async () => {
    await commandHandler("end", ctx);
    branch = [{ type: "message" }];
    await emit("session_start", {});
    await commandHandler("end", ctx);

    const onBranch = branch.filter((entry) => entry.customType === STATE_ENTRY_TYPE);
    assert.equal(onBranch.length, 1, "restoreLoopState reads the branch, so the branch is what matters");
  });
});
