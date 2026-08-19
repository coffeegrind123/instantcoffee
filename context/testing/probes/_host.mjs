/**
 * _host.mjs — the fake pi/ctx the `i` probes drive the real loop module with.
 *
 * `vendor/pi-loop-mode/extensions/index.ts` imports NOTHING from pi at runtime
 * (its only pi import is an erased `import type`), so the whole extension —
 * every handler, the command, the tool — loads under plain
 * `node --experimental-strip-types` and can be driven directly. That is what
 * makes these probes evidence about the shipped code rather than about a model
 * of it.
 *
 * The loop's state is module-global, so one process = one loop. Every probe that
 * needs two scenarios takes a mode argument and is run once per mode.
 */

export const REPO = "/home/claudeuser/qwen3.8-forge";

const { CHECK_COMPLETION_MARKER } = await import(`${REPO}/vendor/pi-loop-mode/src/goal-check.ts`);

/**
 * What pi's `execCommand` resolves for a goal check that RAN.
 *
 * The default used to be `{ code: 0, stdout: "", stderr: "" }`, which is the
 * eighth pass's lesson repeating itself one field lower down: it is a faithful
 * shape for a check that passed silently AND for a check the OOM killer reaped,
 * because `waitForChildProcess` resolves the exit CODE and drops the signal and
 * `execCommand` does `code: code ?? 0`. A stub that cannot tell those apart
 * cannot fail when the module cannot either — which is AB1.
 *
 * `runGoalCheck` runs the check under a bash EXIT trap, so a run that reached its
 * own exit prints the marker. Leave it out to model a signalled death.
 */
export function execResult({ code = 0, stdout = "", stderr = "", killed = false, completed = true } = {}) {
  return {
    code,
    stdout: completed ? `${stdout}\n${CHECK_COMPLETION_MARKER}:${code}\n` : stdout,
    stderr,
    killed,
  };
}

/**
 * @param opts.percent  context usage the ctx reports (drives the saturation rungs)
 * @param opts.exec     pi.exec implementation (the goal check runs through it)
 * @param opts.idle     what ctx.isIdle() answers
 */
export function makeHost(opts = {}) {
  const percent = opts.percent ?? 20;
  const handlers = new Map();
  const notices = [];
  const sent = [];
  let cmd;
  let tool;

  const pi = {
    on: (n, f) => handlers.set(n, [...(handlers.get(n) ?? []), f]),
    registerCommand: (_n, c) => { cmd = c.handler; },
    registerTool: (t) => { tool = t; },
    appendEntry() {},
    // The options matter now: a loop turn can be sent, scheduled, or QUEUED onto
    // a turn that is already coming (`deliverAs: "nextTurn"`). Attached to the
    // message rather than kept alongside it, so every existing probe's
    // `sent.find(m => m.details.kind === …)` keeps working.
    sendMessage: (m, options) => sent.push(Object.assign(m, { __options: options })),
    exec: opts.exec ?? (async () => execResult()),
    setModel: async () => true,
  };

  const ctx = {
    cwd: process.cwd(),
    mode: "tui",
    hasUI: true,
    ui: { notify: (m) => notices.push(String(m)), setStatus() {} },
    sessionManager: { getBranch: () => [], getEntries: () => [] },
    modelRegistry: { find: () => undefined, getAll: () => [] },
    // llama.cpp presents an OpenAI-completions API; the sampling-penalty handler
    // only fires on one.
    model: { api: "openai-completions", contextWindow: 32768 },
    isIdle: () => opts.idle ?? true,
    hasPendingMessages: () => false,
    getContextUsage: () => ({
      tokens: Math.round((32768 * percent) / 100),
      contextWindow: 32768,
      percent,
    }),
    compact() {},
    abort() { notices.push("(ctx.abort called)"); },
    waitForIdle: async () => {},
  };

  return {
    pi, ctx, notices, sent,
    getTool: () => tool,
    fire: async (name, event = {}) => {
      const out = [];
      for (const f of handlers.get(name) ?? []) out.push(await f(event, ctx));
      // A `message_end` handler that returns a message REPLACES the one pi is
      // holding, in place. See applyMessageEndReplacement.
      if (name === "message_end") applyMessageEndReplacement(event, out);
      return out;
    },
    /** Run a `/loop …` command line; returns everything it notified. */
    run: async (args) => { notices.length = 0; await cmd(args, ctx); return notices.join("\n"); },
    /**
     * Clear any scheduled iteration so the process can exit.
     *
     * A stuck intervention schedules the next turn with an escalating delay —
     * up to 60 s — and node waits for a pending timer. Call this once a probe
     * has printed everything it came for.
     */
    quit: async () => { notices.length = 0; await cmd("stop", ctx); },
    /** One whole turn: N assistant messages, M tool results, then agent_end. */
    turn: async ({ messages, tools = [] }) => {
      notices.length = 0;
      sent.length = 0;
      // ONE object per message, emitted to `message_end` and then handed to
      // `agent_end` — because that is what pi does, and it is load-bearing. This
      // used to build a fresh `assistant(m)` for each event, so a sanitized
      // replacement never reached `agent_end` and the probes could not see the
      // one thing `_replaceMessageInPlace` exists to do.
      const built = messages.map((m) => assistant(m));
      for (const m of built) await ctx0(pi, handlers, ctx, "message_end", { message: m });
      for (const t of tools) await ctx0(pi, handlers, ctx, "tool_result", t);
      await ctx0(pi, handlers, ctx, "agent_end", { messages: built });
      return notices.join(" | ") || "(no notice)";
    },
  };
}

async function ctx0(_pi, handlers, ctx, name, event) {
  const out = [];
  for (const f of handlers.get(name) ?? []) out.push(await f(event, ctx));
  if (name === "message_end") applyMessageEndReplacement(event, out);
}

/**
 * pi replaces a `message_end` handler's message IN PLACE, and the probes have to
 * do the same or they are not evidence.
 *
 * `ExtensionRunner.emitMessageEnd` (runner.js:610) threads each handler's
 * returned message into the next handler and hands the last one back;
 * `AgentSession._emitExtensionEvent` (agent-session.js:481) then calls
 * `_replaceMessageInPlace(event.message, normalized)`, which deletes every key
 * of the object agent-core is holding and copies the replacement over it. Its
 * own comment says why: "Mutating this object in place keeps agent state, later
 * turn/agent events, listeners, and the eventual SessionManager.appendMessage
 * persistence in sync."
 *
 * "Later agent events" includes `agent_end`, whose `messages` are those same
 * objects. So a handler that sanitizes an assistant message has changed what
 * `agent_end` reads — and `pi-loop-mode` has one that truncates degenerate
 * repetition. Without this, every probe showed `detectStuck`'s degenerate rule
 * firing on text that, in a real session, had already been cut. See X5 in
 * `context/design/subagents-loop-verifier-turns.md`.
 */
function applyMessageEndReplacement(event, results) {
  const replacement = [...results].reverse().find((r) => r && r.message)?.message;
  if (!replacement || !event.message || replacement === event.message) return;
  for (const key of Object.keys(event.message)) delete event.message[key];
  Object.assign(event.message, replacement);
}

export const assistant = (text, stopReason = "stop") => ({
  role: "assistant",
  content: text ? [{ type: "text", text }] : [],
  stopReason,
  usage: { output: 40 },
});

export const toolResult = (toolName, text, isError = false) => ({
  toolName,
  content: [{ type: "text", text }],
  isError,
});

/** The lines of `/loop status` a probe cares about. */
export function statusLines(text, pattern) {
  return text.split("\n").filter((l) => pattern.test(l)).map((l) => "  " + l).join("\n");
}
