/**
 * j5 — V5. `buildVerifyDeps.repair` reads one of its RunResult's five fields.
 *      The structural gate that exists to refuse judging a cut-off run is
 *      therefore applied to the child's first run and to nothing else.
 *
 *   agent-manager.ts, the repair:
 *     const result = await continueAgentSession(session, prompt, {...});
 *     deadline.assertNotExpired();
 *     return result.responseText;         // aborted, turnLimited, modelError dropped
 *
 *   attachSettlementChain, the first run:
 *     status = aborted ? "aborted" : modelError ? "error"
 *            : turnLimited ? "turn_limited" : "completed"
 *
 * A repair runs `maxTurns: 1, graceTurns: DEFAULT_GRACE_TURNS`, so a child that
 * uses tools before answering is hard-aborted at turn 7 with whatever text had
 * streamed. That text is then judged, and can go back to the parent labelled
 * "✎ repaired … it was re-checked".
 *
 * FIXED. `repair` returns `{ text, status }`, classified by the same
 * `classifyRun()` the settlement chain uses on the child's own run, and the round
 * loop puts it through `structuralVerdict` before judging it.
 *
 *   node --experimental-strip-types j5-repair-runresult-discarded.mjs
 */
import { verifyAnswer } from "../../../vendor/pi-subagents-lite/src/agents/verify-runner.ts";
import { structuralVerdict } from "../../../vendor/pi-subagents-lite/src/agents/verify.ts";
import { wireTurnTracking } from "../../../vendor/pi-subagents-lite/src/agents/turn-tracking.ts";

const BRIEF = "List every call site of tokenize() in src/, with file and line.";
const ORIGINAL = "tokenize() is the entry point of the lexer. It takes a string and returns tokens.";
const TRUNCATED_REPAIR = "src/parser.ts:14 — tokenize(input)\nsrc/repl.ts:88 — tokenize(line)\nsrc/lint";

console.log("=== the repair's own RunResult, from the real wireTurnTracking ===\n");
let listener;
const session = {
  subscribe(l) { listener = l; return () => {}; },
  steer() { return Promise.resolve(); },
  abort() { return Promise.resolve(); },
};
const tracked = wireTurnTracking(session, { maxTurns: 1, graceTurns: 6 });
for (let i = 0; i < 7; i++) listener({ type: "turn_end" }); // a repair that read two files first

console.log(`  aborted      : ${tracked.getAborted()}      <- hard abort at maxTurns + graceTurns`);
console.log(`  turnLimited  : ${tracked.getTurnLimited()}      <- false since V6: this run was severed, not asked to wrap up`);
console.log(`  modelError   : whatever getFinalModelError(session) found`);
console.log(`  responseText : …${JSON.stringify(TRUNCATED_REPAIR.slice(-20))}`);

console.log("\n=== the real verifyAnswer, given exactly that repair ===\n");

const judge = async (prompt) =>
  (prompt.split("ANSWER:")[1] ?? "").includes("src/parser.ts")
    ? "VERDICT: ADDRESSED\nWHY: it lists the call sites with file and line."
    : "VERDICT: NOT_ADDRESSED\nWHY: it describes the function instead of listing its callers.";

for (const status of ["aborted", "completed"]) {
  const outcome = await verifyAnswer(
    { result: ORIGINAL, lifecycle: { status: "completed" } },
    BRIEF,
    {
      judge,
      repair: async () => ({ text: TRUNCATED_REPAIR, status }),
      notify: () => {},
    },
    { rounds: 1 },
  );
  console.log(`  the repair reports status ${JSON.stringify(status)}`);
  console.log(`    verdict : ${outcome.status}`);
  console.log(`    answer  : ${JSON.stringify(outcome.answer.slice(0, 96))}…\n`);
}

console.log("\n=== what the gate says about a run of that shape ===\n");
for (const status of ["completed", "aborted", "turn_limited", "error"]) {
  const v = structuralVerdict(TRUNCATED_REPAIR, { status });
  console.log(`  status ${status.padEnd(13)} -> worthJudging: ${String(v.worthJudging).padEnd(5)}  skip: ${v.skip ?? "-"}`);
}
console.log(`
BEFORE the fix

  The repair returned \`result.responseText\` and nothing else, so BOTH rows above
  came back \`repaired\` — the fragment ending "src/lint" went to the parent under
  "this is the corrected one, and it was re-checked", with a \`✎ repaired\` badge.
  Nothing anywhere recorded that the run producing it had been hard-aborted
  mid-token: the manager did not classify it, and record.lifecycle.status was
  still "completed" from before verification began.

NOW

  The two rows differ on one field and the verdict follows it. \`completed\` is the
  control: a repair that finished is still accepted, so the gate has not simply
  made the verifier refuse repairs.

  verify.ts's own argument for the gate: "An empty answer, or a run that ended at
  the turn ceiling / by watchdog / by a stop, is objectively suspect and needs no
  judgement. This is most of what actually goes wrong." A repair is a run of the
  same kind, from the same function, with the same five-field result — and now its
  lifecycle crosses back with it.`);
