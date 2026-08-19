/**
 * k4 — W4. V6 split `turnLimited` off the ceiling. The branch above it still
 * reports a one-turn run that FINISHED as `aborted`.
 *
 * `wireTurnTracking`:
 *
 *     if (!ceilingReached && turnCount >= maxTurns) {
 *       ceilingReached = true;
 *       if (graceTurns <= 0) { aborted = true; session.abort(); return; }   <- here
 *       if (shouldSteerAtSoftLimit(maxTurns)) { turnLimited = true; steer(); }
 *     }
 *
 * V6's argument is in that file's own header: "Reaching a one-turn ceiling IS
 * finishing, and the two readers of the flag both take it to mean the opposite."
 * `aborted` has the same two readers and says something stronger — the status note
 * is "hit the turn limit before completion; output may be incomplete", and
 * `structuralVerdict` refuses to judge it (`skip: "cutoff"`).
 *
 * `graceTurns: 0` is reachable: the /agents spawn-options menu accepts it with
 * `min: 0`, and the note beside this branch says so. So an operator who turns
 * grace turns off put every one-turn agent back in exactly the bucket V6 took it
 * out of — and labelled more strongly, because `aborted` outranks `turnLimited`
 * in `classifyRun`.
 *
 * FIXED: the sever is gated on `shouldSteerAtSoftLimit(maxTurns)`, the same
 * predicate V6 used. Nothing loses its ceiling — `ceilingReached` is still set,
 * so a one-turn run that keeps calling tools is severed by the branch below on
 * its very next turn, and reports `aborted`, which is then true.
 *
 *   run:  node --experimental-strip-types k4-grace-zero-reports-a-finished-run-as-aborted.mjs
 */

import { wireTurnTracking } from "/home/claudeuser/qwen3.8-forge/vendor/pi-subagents-lite/src/agents/turn-tracking.ts";
import { structuralVerdict } from "/home/claudeuser/qwen3.8-forge/vendor/pi-subagents-lite/src/agents/verify.ts";
/**
 * STATUS_NOTES, read out of status-note.ts rather than imported: that module
 * pulls in ./ui/format.js, a `.js` specifier for a `.ts` file, which plain node
 * will not resolve. Read from the file so it cannot drift from what ships.
 */
import { readFileSync } from "node:fs";
const NOTE_SRC = readFileSync("/home/claudeuser/qwen3.8-forge/vendor/pi-subagents-lite/src/status-note.ts", "utf8");
const STATUS_NOTES = Object.fromEntries(
  [...NOTE_SRC.slice(NOTE_SRC.indexOf("const STATUS_NOTES"), NOTE_SRC.indexOf("const STOP_NOTES"))
    .matchAll(/^\s*(\w+):\s*"([^"]+)"/gm)].map((m) => [m[1], m[2]]),
);
const getStatusNote = (lifecycle) => (STATUS_NOTES[lifecycle.status] ? ` (${STATUS_NOTES[lifecycle.status]})` : "");

/** The manager's own classification, copied from agent-manager.ts:141. */
const classifyRun = (r) => (r.aborted ? "aborted" : r.modelError ? "error" : r.turnLimited ? "turn_limited" : "completed");

function run({ maxTurns, graceTurns, turns }) {
  const steers = [];
  let aborts = 0;
  const session = {
    subscribe: (fn) => { session._fn = fn; return () => {}; },
    steer: async (t) => { steers.push(t); },
    abort: async () => { aborts++; },
  };
  const t = wireTurnTracking(session, { maxTurns, graceTurns });
  for (let i = 0; i < turns; i++) session._fn({ type: "turn_end" });
  const result = { aborted: t.getAborted(), turnLimited: t.getTurnLimited(), modelError: undefined };
  return { ...result, status: classifyRun(result), steered: steers.length > 0, aborts };
}

const ANSWER = "src/parser.ts:14 — tokenize(input)\nsrc/repl.ts:88 — tokenize(line)";

console.log("\n=== k4 — a one-turn agent that answered, under two grace settings ===\n");
console.log("  BEFORE, with grace turns set to 0:");
console.log("    status  aborted        parent reads  \"…\" (hit the turn limit before completion;");
console.log("                                          output may be incomplete)");
console.log("    verified  NO (cutoff)  — the one distinction the verifier exists to draw\n");
console.log("  NOW, driving the shipped module:\n");
console.log("  grace  turns  wrap-up asked?  status        what the PARENT reads              verified?");
console.log("  " + "-".repeat(96));

for (const { grace, label } of [{ grace: 6, label: "6" }, { grace: 0, label: "0" }]) {
  const r = run({ maxTurns: 1, graceTurns: grace, turns: 1 });
  const gate = structuralVerdict(ANSWER, { status: r.status });
  console.log(
    `  ${label.padEnd(6)} 1      ${(r.steered ? "yes" : "no").padEnd(15)} ${r.status.padEnd(13)} ` +
    `${("\"" + ANSWER.split("\n")[0].slice(0, 12) + "…\"" + getStatusNote({ status: r.status })).padEnd(34)} ` +
    `${gate.worthJudging ? "yes" : "NO  (" + gate.skip + ")"}`,
  );
}

console.log("\n  Same run. One turn, an answer, nothing cut off, no wrap-up ever asked for —");
console.log("  and now the two rows agree. They used to differ on a setting documented as");
console.log("  removing a grace turn this run never used.\n");

console.log("  The controls — a budget with somewhere left to go is unaffected either way,");
console.log("  and the ceiling is not lost with the label:\n");
console.log("  grace  maxTurns  turns  status        wrap-up asked?");
console.log("  " + "-".repeat(52));
for (const [grace, maxTurns, turns] of [[6, 3, 2], [0, 3, 2], [6, 3, 3], [0, 3, 3], [6, 3, 9], [0, 1, 2]]) {
  const r = run({ maxTurns, graceTurns: grace, turns });
  console.log(`  ${String(grace).padEnd(6)} ${String(maxTurns).padEnd(9)} ${String(turns).padEnd(6)} ${r.status.padEnd(13)} ${r.steered ? "yes" : "no"}`);
}
console.log();
