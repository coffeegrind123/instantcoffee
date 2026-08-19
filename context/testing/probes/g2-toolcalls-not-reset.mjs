/**
 * G2 probe — `state.toolCallsThisTurn` is a per-turn counter that only the happy
 * path resets (extensions/index.ts:1699). Every early return above it — soft
 * stop, context pressure, model error, degenerate abort, operator abort — leaves
 * it holding the previous turn's count.
 *
 * `emptyResponse` (index.ts:1606) requires `state.toolCallsThisTurn === 0`, and
 * `isContextPressure`'s `starvedTurn` rung (context-recovery.ts:159-160) requires
 * `emptyResponse`. So a stale count switches OFF the 87%-cliff detection for the
 * turn right after an errored one — which is the turn most likely to be starved,
 * because it is the retry of a turn that already failed.
 *
 * The loop's state is module-global, so each scenario runs in its own process:
 *   node --experimental-strip-types g2-toolcalls-not-reset.mjs control
 *   node --experimental-strip-types g2-toolcalls-not-reset.mjs stale
 */

const REPO = "/home/claudeuser/qwen3.8-forge";
const ext = (await import(`${REPO}/vendor/pi-loop-mode/extensions/index.ts`)).default;

const MODE = process.argv[2] ?? "control";

function makeHost(percent) {
  const handlers = new Map();
  const notices = [];
  const sent = [];
  let cmd;
  const pi = {
    on: (n, f) => handlers.set(n, [...(handlers.get(n) ?? []), f]),
    registerCommand: (_n, c) => { cmd = c.handler; },
    registerTool() {},
    appendEntry() {},
    sendMessage: (m) => sent.push(m),
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
    setModel: async () => true,
  };
  const ctx = {
    cwd: process.cwd(),
    mode: "tui",
    hasUI: true,
    ui: { notify: (m) => notices.push(String(m)), setStatus() {} },
    sessionManager: { getBranch: () => [], getEntries: () => [] },
    modelRegistry: { find: () => undefined, getAll: () => [] },
    model: { api: "openai-completions", contextWindow: 32768 },
    isIdle: () => true,
    hasPendingMessages: () => false,
    getContextUsage: () => ({ tokens: Math.round((32768 * percent) / 100), contextWindow: 32768, percent }),
    compact() {},
    abort() {},
    waitForIdle: async () => {},
  };
  return {
    pi, ctx, notices, sent,
    fire: async (n, e = {}) => {
      const out = [];
      for (const f of handlers.get(n) ?? []) out.push(await f(e, ctx));
      return out;
    },
    run: async (a) => { notices.length = 0; await cmd(a, ctx); return notices.join("\n"); },
  };
}

const assistant = (text, stopReason = "stop", errorMessage) => ({
  role: "assistant",
  content: text ? [{ type: "text", text }] : [],
  stopReason,
  errorMessage,
  usage: { output: text ? 40 : 1 },
});

const host = makeHost(90); // 90% full — well past the 80% starvation line
ext(host.pi);
await host.run("start refactor the parser. Done when: tests pass");

if (MODE === "stale") {
  // A turn that used two tools and then died on a provider error.
  await host.fire("tool_result", { toolName: "read", content: [{ type: "text", text: "x" }], isError: false });
  await host.fire("tool_result", { toolName: "read", content: [{ type: "text", text: "y" }], isError: false });
  await host.fire("agent_end", { messages: [assistant("", "error", "boom")] });
}

host.notices.length = 0;
host.sent.length = 0;
// The starved turn: clean "stop", nothing said, nothing thought, no tool call, 90% full.
await host.fire("agent_end", { messages: [assistant("", "stop")] });

const said = host.notices.join(" | ");
const status = await host.run("status");

console.log(`--- MODE=${MODE} ---`);
console.log("notices after the starved turn :", said || "(none)");
console.log("routed to context recovery     :", /context pressure/i.test(said));
console.log("loop status line               :", status.split("\n").find((l) => l.startsWith("Status:")));
console.log("iterations                     :", status.split("\n").find((l) => l.startsWith("Iterations:")));
console.log("last notice                    :", status.split("\n").find((l) => l.startsWith("Last notice:")));
