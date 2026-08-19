/**
 * H4 probe — S4: `state.penaltyTurnsRemaining` is documented as lasting a few
 * iterations, and used to decay on exactly one of the nine ways `agent_end` can
 * leave.
 *
 * `interveneStuck()` sets it to PENALTY_TURNS (3). The only line that decrements
 * it is in the "Normal continue" block at the very bottom of `agent_end`:
 *
 *     if (state.penaltyTurnsRemaining > 0) state.penaltyTurnsRemaining--;
 *
 * Every earlier return — soft stop, context pressure, model error, degenerate
 * abort, operator abort, rescue-turn end, LOOP_DONE, LOOP_BLOCKED, max
 * iterations, score regression, stuck, audit nudge — skips it. So in endless
 * mode, where "LOOP_DONE → continue with improvements" is a normal every-turn
 * outcome, the anti-repetition sampling penalties (frequency 0.5, presence 0.5,
 * temperature +0.2) never expire.
 *
 * This is the same shape as T2 (`toolCallsThisTurn`), which was fixed by moving
 * the reset to the top of the handler. Its sibling three lines away was not part
 * of that change, and is now aged in the same place.
 *
 * The loop's state is module-global, so each scenario runs in its own process:
 *   node --experimental-strip-types h4-penalty-turns-never-decay.mjs control
 *   node --experimental-strip-types h4-penalty-turns-never-decay.mjs done
 *   node --experimental-strip-types h4-penalty-turns-never-decay.mjs blocked
 */

const REPO = "/home/claudeuser/qwen3.8-forge";
const ext = (await import(`${REPO}/vendor/pi-loop-mode/extensions/index.ts`)).default;

const MODE = process.argv[2] ?? "control";

function makeHost(percent) {
  const handlers = new Map();
  const notices = [];
  let cmd;
  const pi = {
    on: (n, f) => handlers.set(n, [...(handlers.get(n) ?? []), f]),
    registerCommand: (_n, c) => { cmd = c.handler; },
    registerTool() {},
    appendEntry() {},
    sendMessage() {},
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
    // The penalty handler only fires on an OpenAI-completions API — which is
    // what llama.cpp presents on this stack.
    model: { api: "openai-completions", contextWindow: 32768 },
    isIdle: () => true,
    hasPendingMessages: () => false,
    getContextUsage: () => ({ tokens: Math.round((32768 * percent) / 100), contextWindow: 32768, percent }),
    compact() {},
    abort() {},
    waitForIdle: async () => {},
  };
  return {
    pi, ctx, notices,
    fire: async (n, e = {}) => {
      const out = [];
      for (const f of handlers.get(n) ?? []) out.push(await f(e, ctx));
      return out;
    },
    run: async (a) => { notices.length = 0; await cmd(a, ctx); return notices.join("\n"); },
  };
}

const assistant = (text, stopReason = "stop") => ({
  role: "assistant",
  content: text ? [{ type: "text", text }] : [],
  stopReason,
  usage: { output: 40 },
});

/** Ask the real before_provider_request handler whether penalties are still on. */
async function penaltiesActive(host) {
  const [result] = await host.fire("before_provider_request", { payload: { temperature: 0.7, messages: [] } });
  return result === undefined
    ? "off (handler stood down)"
    : `ON  freq=${result.frequency_penalty} pres=${result.presence_penalty} temp=${result.temperature.toFixed(2)}`;
}

// 20% context, so interveneStuck takes the prompt-level rung rather than the
// saturated-context shortcut, which is the path that arms the penalties.
const host = makeHost(20);
ext(host.pi);
await host.run("start refactor the parser. Done when: tests pass");

console.log(`--- MODE=${MODE} ---`);
console.log("penalties before any intervention :", await penaltiesActive(host));

// Two identical, substantial responses => "assistant repeated the same response".
const REPEAT = "I will now examine the parser module and consider the various options available before making any change at all.";
for (let i = 0; i < 2; i++) {
  await host.fire("message_end", { message: assistant(REPEAT) });
  await host.fire("tool_result", { toolName: "read", content: [{ type: "text", text: `x${i}` }], isError: false });
  await host.fire("agent_end", { messages: [assistant(REPEAT)] });
}
console.log("stuck intervention fired          :", host.notices.some((n) => /stuck/i.test(n)));
console.log("penalties right after it          :", await penaltiesActive(host));

// Now run turns that leave agent_end by a path other than "Normal continue".
// Genuinely different sentences per turn. They have to be different after
// `stripVolatile()`, which replaces every digit run with "#": a series that
// differs only by an index reads as 100% similar and re-arms the intervention,
// which would make the control test the wrong thing.
const BODIES = [
  "Rewrote the tokenizer to stream, and the suite is green.",
  "Split the CSV front end out of the importer; nothing else moved.",
  "Added a fixture for ragged rows and taught the reader to skip them.",
  "Replaced the buffered read with a chunked one and measured the difference.",
  "Documented the new pipeline stages in the module header.",
  "Deleted the dead compatibility shim nobody calls any more.",
];
const TURNS = BODIES.length;
for (let i = 0; i < TURNS; i++) {
  const text =
    MODE === "done"
      ? `LOOP_DONE: ${BODIES[i]}`
      : MODE === "blocked"
        ? `LOOP_BLOCKED: no credential for the upload step. ${BODIES[i]}`
        : BODIES[i];
  await host.fire("message_end", { message: assistant(text) });
  await host.fire("tool_result", { toolName: "edit", content: [{ type: "text", text: `edited src/file${i}.ts` }], isError: false });
  await host.fire("agent_end", { messages: [assistant(text)] });
  console.log(`after turn ${i + 1} (${MODE.padEnd(7)}) penalties :`, await penaltiesActive(host));
}

console.log(`
"off" = the handler stood down, i.e. penaltyTurnsRemaining reached 0.
"ON"  = the provider payload is still being rewritten.

NOW: all three modes retire the penalties after exactly PENALTY_TURNS (3) turns.
The counter is aged at the top of agent_end, so every exit path ages it.

BEFORE: only "control" retired them. "done" and "blocked" return from the
LOOP_DONE and LOOP_BLOCKED branches, which sit above the old decrement at the
bottom of the handler — and in endless mode those are the loop's own
every-iteration outcomes. Temperature stayed +0.2 with both repetition penalties
at 0.5 for the rest of the session: a deliberate, temporary anti-fixation measure
applied as a permanent sampling change.

"control" is the control in both directions. It passed before the fix and passes
now, so it is what shows the fix did not simply retire the penalties instantly —
they are still applied for the turns they were armed for.
`);
