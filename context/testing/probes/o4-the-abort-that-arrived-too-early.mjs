/**
 * o4 — AB4. `addEventListener("abort")` on a signal that has already fired never
 * runs, so a stop that lands during a subagent's SETUP is a stop nobody hears.
 *
 * `AbortSignal` dispatches `abort` exactly once. A consumer therefore has two
 * cases, and only one of them looks like work:
 *
 *   if (signal.aborted) …                  ← the abort that has already happened
 *   signal.addEventListener("abort", …)    ← the abort that has not
 *
 * `forwardAbortSignal` (`src/agents/agent-runner.ts`) had only the second, and it
 * runs at the TOP of `runTurnLoop` — after `reloadAndMap()` has called every
 * extension factory, after `createAgentSession()`, `bindExtensions()` and
 * `setActiveToolsByName()`. That window is seconds on a 9p mount, and one of the
 * factories in it (`vendor/rtk-pi`) shells out to a subprocess.
 *
 * Two things ride on that signal, and both lost the same race:
 *
 *   · `stopAgent()` on a RUNNING record does nothing else — its whole effect is
 *     `record.execution.abortController?.abort()` — so stopping a subagent during
 *     its build did not stop it.
 *   · T5, closed in the tenth pass so a verification could be interrupted, hands
 *     `startDeadline`'s composed signal to `runAgent`. `startDeadline` handles
 *     the already-aborted case correctly; the hand-off then dropped it.
 *
 *   node --experimental-strip-types o4-the-abort-that-arrived-too-early.mjs
 */

import { readFileSync } from "node:fs";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = new URL("../../../vendor/pi-subagents-lite/src/", import.meta.url).pathname;

let failures = 0;
const expect = (ok, what) => {
  if (!ok) {
    failures++;
    console.log(`  !! ${what}`);
  }
};

// ── part 1: the JS fact, executed ──────────────────────────────────────────

async function listenerHeard(abortFirst) {
  const controller = new AbortController();
  if (abortFirst) controller.abort();
  let heard = false;
  controller.signal.addEventListener("abort", () => {
    heard = true;
  }, { once: true });
  if (!abortFirst) controller.abort();
  await new Promise((resolve) => setTimeout(resolve, 10));
  return heard;
}

const beforeAttach = await listenerHeard(true);
const afterAttach = await listenerHeard(false);

console.log("=".repeat(88));
console.log("1. what a listener hears, by when it was attached");
console.log("=".repeat(88));
console.log(`
  abort()  THEN  addEventListener   → listener fired: ${beforeAttach}   signal.aborted: true
  addEventListener  THEN  abort()   → listener fired: ${afterAttach}   signal.aborted: true

  Both signals are aborted. Only one of them ever says so out loud.
`);
expect(beforeAttach === false, "an already-aborted signal now fires late listeners; re-read this finding");
expect(afterAttach === true, "the control failed — a listener attached first must hear the abort");

// ── part 2: why the obvious fix is not the fix ─────────────────────────────

let prompted = 0;
const session = {
  aborted: false,
  async abort() {
    this.aborted = true;
  },
  async prompt() {
    prompted++;
  },
};
await session.abort();
await session.prompt();

console.log("=".repeat(88));
console.log("2. why forwardAbortSignal cannot just abort when it finds `.aborted`");
console.log("=".repeat(88));
console.log(`
  session.abort()  then  session.prompt()   → aborted: ${session.aborted}, prompts run: ${prompted}

  pi's abort tears down what is running NOW; a prompt issued afterwards is a new
  run. Aborting here would spend the operator's stop and let the run go ahead —
  worse than doing nothing, because it would look handled. \`runTurnLoop\` refuses
  to start the prompt instead.
`);
expect(prompted === 1, "the control failed — an abort before prompt() was expected to be a no-op");

// ── part 3: the guard, and the invariant ──────────────────────────────────

const runner = readFileSync(join(SRC, "agents/agent-runner.ts"), "utf8");
const manager = readFileSync(join(SRC, "agents/agent-manager.ts"), "utf8");

const guardAt = runner.indexOf("if (options.signal?.aborted) throw new Error(ABORTED_BEFORE_START)");
const promptAt = runner.indexOf("await session.prompt(prompt)");

console.log("=".repeat(88));
console.log("3. every abort listener in vendor/pi-subagents-lite, and its pair");
console.log("=".repeat(88));

function everyTs(dir, found = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) everyTs(full, found);
    else if (name.endsWith(".ts")) found.push(full);
  }
  return found;
}

const rows = [];
for (const file of everyTs(SRC)) {
  const text = readFileSync(file, "utf8");
  text.split("\n").forEach((line, i) => {
    // Code only: this file's own prose names the call, and so does
    // forwardAbortSignal's header.
    const code = line.trim();
    if (code.startsWith("*") || code.startsWith("//")) return;
    if (!code.includes('addEventListener("abort"')) return;
    const near = text.split("\n").slice(Math.max(0, i - 12), i + 12).join("\n");
    rows.push({
      where: `${file.slice(SRC.length)}:${i + 1}`,
      paired: near.includes(".aborted") ? "adjacent" : "elsewhere",
    });
  });
}

console.log(`  ${"site".padEnd(44)} `.concat("`.aborted` pair"));
console.log("  " + "-".repeat(70));
for (const row of rows) console.log(`  ${row.where.padEnd(44)} ${row.paired}`);
console.log(`
  agents/agent-manager.ts   startDeadline   \`if (stopSignal.aborted) controller.abort()\`
  agents/agent-manager.ts   spawn           \`if (options.signal.aborted) { stopAgent(…); return }\`
  agents/agent-runner.ts    forwardAbortSignal — its pair is in runTurnLoop, which
                            refuses to prompt at all:

    guard at char ${guardAt}, prompt at char ${promptAt}   → ${guardAt >= 0 && guardAt < promptAt ? "guard first ✔" : "MISSING or after the prompt ✘"}
`);

expect(guardAt >= 0, "runTurnLoop no longer tests `.aborted` before prompting (AB4 has come back)");
expect(guardAt < promptAt, "the guard is after the prompt, which is no guard at all");
expect(/if \(stopSignal\.aborted\) controller\.abort\(\);/.test(manager), "startDeadline stopped composing an already-aborted stop");
expect(rows.length === 3, `expected 3 abort listeners, found ${rows.length} — classify the new one`);

console.log(`
  BEFORE   stop during the build → the child ran its whole prompt, and its answer
           went to the parent through the completion gate; Esc during the judge's
           build bought one full model call on the single llama slot.
  NOW      the run refuses to start, and the throw lands where a stop is already
           handled: attachSettlementChain's .catch leaves a "stopped" status
           alone, and verifyAnswer's catch keeps the child's answer.
`);

if (failures) {
  console.log(`FAILED: ${failures} expectation(s).`);
  process.exit(1);
}
console.log("ok — every expectation held.");
