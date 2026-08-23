/**
 * aa6 — AN6, the setup warnings a failed spawn threw away.
 *
 * FIXED — the NOW column drives the REAL `NoticeBuffer` from
 * `vendor/pi-subagents-lite/src/agents/notice-buffer.ts` inside the REAL shape
 * of `runAgentImpl`'s try/finally. The BEFORE column is the six lines it
 * replaced, quoted:
 *
 * ```js
 *   const warnings: string[] = [];
 *   const bufferNotify = (msg) => { warnings.push(msg); };
 *   …
 *   const result = await runSessionPrompt(session, prompt, {…});
 *   for (const msg of warnings) {
 *     if (ctx.ui?.notify) ctx.ui.notify(`[pi-subagents-lite] ${msg}`, "warning");
 *     else console.warn(`[pi-subagents-lite] ${msg}`);
 *   }
 *   return result;
 * ```
 *
 * Two things are wrong with it and both are visible here: no `finally`, so a
 * run that throws takes the buffer with it; and `ctx.ui?.notify` is a real
 * function even headless (`noOpUIContext.notify` is `() => {}`), so the
 * `console.warn` arm is unreachable and an unattended run hears nothing.
 *
 *   run: node --experimental-strip-types aa6-the-warnings-a-failed-spawn-threw-away.mjs [abort|headless|clean]
 */

const REPO = "/home/claudeuser/qwen3.8-forge";
const { NoticeBuffer } = await import(`${REPO}/vendor/pi-subagents-lite/src/agents/notice-buffer.ts`);

const MODES = {
  /** The run throws: a parent signal already aborted before it started. */
  abort: {},
  /** There is a UI object, and its notify is pi's no-op. `pi -p`, cron, /loop. */
  headless: {},
  /** The control: a run that succeeds, in a TUI. */
  clean: {},
};

const MODE = process.argv[2] ?? "abort";
if (!MODES[MODE]) {
  console.error(`usage: node aa6-…mjs <${Object.keys(MODES).join("|")}>`);
  process.exit(2);
}

let failures = 0;
const check = (label, ok) => {
  console.log(`   ${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) failures++;
};

/** The five sentences the setup can produce. Every one is about an agent file. */
const SETUP_WARNINGS = [
  'agent "reviewer": both tools and exclude_tools set — tools (whitelist) wins',
  "Custom prompt file not found: ~/.pi/agent/subagents-lite-prompt.md. Falling back to replace mode.",
  'extension "rtk-pi" not found in loaded extensions',
];

/** What a run does. `abort` is `ABORTED_BEFORE_START`, thrown by `runTurnLoop`. */
async function runSessionPrompt(throws) {
  if (throws) throw new Error("The subagent was stopped before it started.");
  return { responseText: "done" };
}

console.log(`\naa6 [${MODE}] — the warnings a failed spawn threw away (AN6)\n`);

const throws = MODE === "abort";
const headless = MODE === "headless";

const results = {};

for (const label of ["BEFORE", "NOW"]) {
  const logged = [];
  const notified = [];
  // A TUI notifies; pi's headless context has a notify that is `() => {}`.
  const ctx = { ui: { notify: headless ? () => {} : (message) => notified.push(message) } };
  const log = (line) => logged.push(line);

  let threw;
  if (label === "BEFORE") {
    const warnings = [];
    const bufferNotify = (msg) => warnings.push(msg);
    for (const warning of SETUP_WARNINGS) bufferNotify(warning);
    try {
      await runSessionPrompt(throws);
      // The flush, exactly as it was: after the await, and one channel or the
      // other.
      for (const msg of warnings) {
        if (ctx.ui?.notify) ctx.ui.notify(`[pi-subagents-lite] ${msg}`, "warning");
        else log(`[pi-subagents-lite] ${msg}`);
      }
    } catch (error) {
      threw = error;
    }
  } else {
    const warnings = new NoticeBuffer();
    for (const warning of SETUP_WARNINGS) warnings.add(warning);
    try {
      await runSessionPrompt(throws);
    } catch (error) {
      threw = error;
    } finally {
      warnings.flush(ctx, log);
    }
  }

  results[label] = { logged, notified, threw };
  console.log(`   ${label}`);
  console.log(`     the run                     : ${threw ? "threw" : "returned"}`);
  console.log(`     reached the UI              : ${notified.length} of ${SETUP_WARNINGS.length}`);
  console.log(`     reached the console         : ${logged.length} of ${SETUP_WARNINGS.length}`);
  console.log(`     said anywhere at all        : ${notified.length + logged.length > 0 ? "yes" : "NO"}`);
  console.log("");
}

if (MODE === "abort") {
  check("BEFORE a throwing run said nothing", results.BEFORE.notified.length === 0 && results.BEFORE.logged.length === 0);
  check("NOW every warning still lands", results.NOW.logged.length === SETUP_WARNINGS.length);
  check("…on the UI too", results.NOW.notified.length === SETUP_WARNINGS.length);
  check("…and the throw is not swallowed", results.NOW.threw !== undefined);
} else if (MODE === "headless") {
  check("BEFORE the console arm was unreachable", results.BEFORE.logged.length === 0);
  check("…because pi's no-op notify is a real function", results.BEFORE.notified.length === 0);
  check("…so an unattended run heard nothing at all", results.BEFORE.logged.length + results.BEFORE.notified.length === 0);
  check("NOW the console always gets them", results.NOW.logged.length === SETUP_WARNINGS.length);
} else {
  check("BEFORE a clean run in a TUI did report them", results.BEFORE.notified.length === SETUP_WARNINGS.length);
  check("NOW it still does", results.NOW.notified.length === SETUP_WARNINGS.length);
  check("…and the console has them too, which is new and cheap", results.NOW.logged.length === SETUP_WARNINGS.length);
}

console.log("");
process.exit(failures === 0 ? 0 : 1);
