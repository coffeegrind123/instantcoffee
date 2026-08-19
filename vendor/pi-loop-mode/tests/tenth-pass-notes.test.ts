/**
 * The tenth pass's smaller repairs, each of which had been carried as a note
 * across several audits without anyone deciding it.
 *
 * They are grouped by what they are about rather than by file, because that is
 * how they were found: reading pi's implementation of what the loop calls, and
 * then reading the loop's own notes with that in hand.
 *
 *  1. `detectStuck` rule 6 was the one rule not gated on the current turn's
 *     text — so a turn that committed nothing could re-fire a verdict about the
 *     PREVIOUS turn, and charge the whole escalation ladder again for it.
 *  2. `degenerateAbortPending` survived every `agent_end` exit above the branch
 *     that reads it, so an abort on a turn that ended in a provider error made
 *     the operator's NEXT Esc read as a degenerate abort.
 *  3. The provider-error retry shared `consecutiveErrorCount` with context
 *     pressure and had no terminal state at all.
 *  4. `--goal-file=X` was not accepted, only `--goal-file X`.
 *  5. `DEGENERATE_REPEATS` was declared in two files.
 *  6. A context layer's shortening marker leaked into the tool fingerprint that
 *     `detectStuck` rule 7 compares.
 *
 * See §9 of `context/design/subagents-loop-verifier-hosts.md`.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import loopModeExtension from "../extensions/index.ts";
import { parseStartArgs } from "../src/arguments.ts";
import { DEGENERATE_REPEATS, fingerprint, stripShorteningMarkers } from "../src/repetition.ts";
import { defaultState } from "../src/loop-state.ts";

type Handler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

function makeHost(opts: { hasUI?: boolean } = {}) {
  const handlers = new Map<string, Handler[]>();
  const notices: string[] = [];
  const sent: unknown[] = [];
  let command: ((args: string, ctx: unknown) => Promise<void>) | undefined;

  const pi = {
    on(name: string, fn: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), fn]);
    },
    registerCommand(_n: string, config: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      command = config.handler;
    },
    registerTool() {},
    appendEntry() {},
    sendMessage(m: unknown) {
      sent.push(m);
    },
    async exec() {
      return { code: 0, stdout: "", stderr: "", killed: false };
    },
    async setModel() {
      return true;
    },
  };

  const ctx = {
    cwd: process.cwd(),
    mode: "tui",
    hasUI: opts.hasUI ?? true,
    ui: { notify: (m: string) => notices.push(String(m)), setStatus() {} },
    sessionManager: { getBranch: () => [], getEntries: () => [] },
    modelRegistry: { find: () => undefined, getAll: () => [] },
    model: { api: "openai-completions", contextWindow: 32_768 },
    isIdle: () => true,
    hasPendingMessages: () => false,
    getContextUsage: () => ({ tokens: 6_554, contextWindow: 32_768, percent: 20 }),
    compact() {},
    abort() {},
    async waitForIdle() {},
  };

  loopModeExtension(pi as never);

  const fire = async (name: string, event: unknown = {}) => {
    for (const fn of handlers.get(name) ?? []) await fn(event, ctx);
  };

  return {
    notices,
    sent,
    async run(args: string) {
      notices.length = 0;
      await command!(args, ctx);
      return notices.join("\n");
    },
    /** One turn: N assistant messages, M tool results, then agent_end. */
    async turn(messages: { text?: string; thinking?: string; stopReason?: string }[], tools: string[] = []) {
      const built = messages.map((m) => ({
        role: "assistant",
        content: [
          ...(m.text ? [{ type: "text", text: m.text }] : []),
          ...(m.thinking ? [{ type: "thinking", thinking: m.thinking }] : []),
        ],
        stopReason: m.stopReason ?? "stop",
        usage: { output: 60 },
      }));
      notices.length = 0;
      for (const m of built) await fire("message_end", { message: m });
      for (const t of tools) await fire("tool_result", { toolName: "bash", content: [{ type: "text", text: t }] });
      await fire("agent_end", { messages: built });
      return notices.join(" | ");
    },
    fire,
  };
}

const ANSWER = "Read src/parser.ts and fixed the off-by-one in tokenize(); the failing case now passes and I moved on to the next file in the list.";

describe("rule 6 asks about the turn, not only about the window", () => {
  it("does not re-fire on a turn that committed no text at all", async () => {
    const host = makeHost();
    await host.run("start ship it --max 40");

    // Three identical answers fill the window and trip the repeat rules.
    let last = "";
    for (let i = 0; i < 3; i++) last = await host.turn([{ text: ANSWER }], ["ok"]);
    assert.match(last, /stuck/i, "the setup must actually reach a stuck verdict");

    // Now a turn that produced NOTHING but a tool call — which is exactly what
    // the HARD RESET directive asks for ("a tool call with zero preamble text").
    const quiet = await host.turn([{ text: "" }], ["ok"]);
    assert.doesNotMatch(
      quiet,
      /same response repeated/,
      "the window's last fingerprint belongs to the PREVIOUS turn; this turn committed nothing",
    );

    await host.run("end");
  });

  it("control — a turn that DID repeat itself is still caught", async () => {
    const host = makeHost();
    await host.run("start ship it --max 40");
    let last = "";
    for (let i = 0; i < 3; i++) last = await host.turn([{ text: ANSWER }], ["ok"]);
    assert.match(last, /stuck/i);
    await host.run("end");
  });
});

describe("the provider-error ladder has its own counter and a terminal state", () => {
  it("counts provider errors separately from context pressure", () => {
    const s = defaultState();
    assert.equal(s.providerErrorStreak, 0, "the field exists and starts at zero");
    assert.ok("consecutiveErrorCount" in s, "the context ladder keeps its own");
  });

  it("stops after MAX_PROVIDER_ERRORS rather than retrying forever", async () => {
    const host = makeHost();
    await host.run("start ship it --max 400");

    let last = "";
    for (let i = 0; i < 12; i++) {
      last = await host.turn([{ text: "", stopReason: "error" }]);
      if (/paused/i.test(last)) break;
    }
    assert.match(last, /paused/i, "an unattended run must not retry a dead provider forever");
    assert.match(last, /provider|model/i);

    const status = await host.run("status");
    assert.match(status, /Active: false/);
    await host.run("end");
  });

  it("control — a handful of provider errors still just retries", async () => {
    const host = makeHost();
    await host.run("start ship it --max 400");
    const first = await host.turn([{ text: "", stopReason: "error" }]);
    assert.match(first, /retrying/i);
    assert.doesNotMatch(first, /paused/i);
    await host.run("end");
  });

  it("/loop resume clears the provider streak, or a resume re-pauses immediately", async () => {
    const host = makeHost();
    await host.run("start ship it --max 400");
    for (let i = 0; i < 12; i++) {
      const line = await host.turn([{ text: "", stopReason: "error" }]);
      if (/paused/i.test(line)) break;
    }
    await host.run("resume");
    const status = await host.run("status");
    assert.match(status, /Active: true/);
    assert.match(status, /0 consecutive/, "the streak that stopped the run must not survive the resume");
    await host.run("end");
  });
});

describe("--goal-file accepts both forms", () => {
  it("reads the = form", () => {
    const parsed = parseStartArgs("ship the parser --goal-file=SPEC.md");
    assert.equal(parsed.goalFile, "SPEC.md");
    assert.equal(parsed.description, "ship the parser", "the flag must not survive in the goal text");
  });

  it("control — the space form and --file= still work", () => {
    assert.equal(parseStartArgs("ship it --goal-file SPEC.md").goalFile, "SPEC.md");
    assert.equal(parseStartArgs("ship it --file=SPEC.md").goalFile, "SPEC.md");
    assert.equal(parseStartArgs("ship it --file SPEC.md").goalFile, "SPEC.md");
  });
});

describe("DEGENERATE_REPEATS has one declaration", () => {
  it("is exported by repetition.ts and not re-declared in the extension", () => {
    assert.equal(DEGENERATE_REPEATS, 4);
    const ext = readFileSync(fileURLToPath(new URL("../extensions/index.ts", import.meta.url)), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    assert.doesNotMatch(
      ext,
      /const DEGENERATE_REPEATS\s*=/,
      "X5's argument rests on the sanitizer and rule 1 sharing THE constant, not the same number twice",
    );
  });
});

describe("a shortening marker is not part of what the tool said", () => {
  const raw = "line one\nline two\nline three";
  const cappedA =
    "line one\n\n[output capped at 86% context: 17790 chars, kept about 2034. " +
    "Full output: /tmp/pi-tool-output-ab12/bash-call_7f3.txt. Prefer a narrower command.]\n\nline three";
  const cappedB =
    "line one\n\n[output capped at 91% context: 17790 chars, kept about 1500. " +
    "Full output: /tmp/pi-tool-output-ab12/bash-call_9z1.txt. Prefer a narrower command.]\n\nline three";

  it("two identical outputs capped on different turns fingerprint the same", () => {
    // The marker names a spill file keyed by the TOOL-CALL ID, so without this
    // rule 7 ("last three TURN tool signatures equal") could never match on a
    // saturated context — which is where the cap fires and where the model is
    // most likely to be stuck.
    assert.notEqual(fingerprint(cappedA), fingerprint(cappedB), "unstripped, they differ — that is the defect");
    assert.equal(fingerprint(stripShorteningMarkers(cappedA)), fingerprint(stripShorteningMarkers(cappedB)));
  });

  it("control — an uncapped result is untouched", () => {
    assert.equal(stripShorteningMarkers(raw), raw);
  });

  it("this module's own truncation marker is stripped too", () => {
    assert.equal(stripShorteningMarkers("hello\n\n[… truncated: repeated 9 times …]"), "hello");
  });

  it("control — a bracket that is not a marker survives", () => {
    const text = "result: [1, 2, 3] and [a] done";
    assert.equal(stripShorteningMarkers(text), text);
  });
});
