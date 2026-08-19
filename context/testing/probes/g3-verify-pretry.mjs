/**
 * G3 probe — verifyAnswer() is documented "Never throws. A verifier that fails
 * takes the answer with it otherwise". Its try/catch starts AFTER the structural
 * gate, the brief check and clampRounds (verify-runner.ts:182-200), and
 * runVerification() wraps it in try/FINALLY with no catch
 * (agent-manager.ts:487-499). So anything that throws in that prologue reaches
 * attachSettlementChain's .catch, which sets `record.result = undefined` and
 * `status = "error"` (agent-manager.ts:605-615) — the child's finished answer is
 * discarded and the run is reported as a failure.
 *
 * Also measures what a verification actually costs in model calls once G1
 * (maxTurns:1 -> two turns per call) is accounted for.
 */
const R = "/home/claudeuser/qwen3.8-forge/vendor/pi-subagents-lite";
const { verifyAnswer } = await import(`${R}/src/agents/verify-runner.ts`);

// --- 1. the prologue is outside the guard ---------------------------------
const hostile = {
  result: "a perfectly good answer",
  // A lifecycle whose `status` getter throws stands in for any future throw in
  // the prologue; the point is the region, not this particular trigger.
  lifecycle: new Proxy({}, { get(_t, p) { if (p === "status") throw new Error("prologue boom"); } }),
};
try {
  const out = await verifyAnswer(hostile, "the task", { judge: async () => "VERDICT: ADDRESSED", repair: async () => "" });
  console.log("prologue throw was contained  :", JSON.stringify(out));
} catch (e) {
  console.log("prologue throw ESCAPED verifyAnswer:", e.message);
  console.log("  -> reaches attachSettlementChain's .catch: record.result = undefined, status = 'error'");
}

// --- control: the same throw from inside the judge IS contained ------------
const ok = { result: "a perfectly good answer", lifecycle: { status: "completed" } };
const contained = await verifyAnswer(ok, "the task", {
  judge: async () => { throw new Error("judge boom"); },
  repair: async () => "",
});
console.log("control, throw from the judge :", JSON.stringify(contained.status), "answer kept:", contained.answer.startsWith("a perfectly good answer"));

// --- 2. what a verification costs, in provider calls ----------------------
let judgeCalls = 0, repairCalls = 0;
const verdicts = ["VERDICT: NOT_ADDRESSED\nWHY: wrong file.", "VERDICT: ADDRESSED\nWHY: fine."];
const res = await verifyAnswer(
  { result: "first answer", lifecycle: { status: "completed" } },
  "the task",
  {
    judge: async () => verdicts[judgeCalls++] ?? "VERDICT: ADDRESSED",
    repair: async () => { repairCalls++; return "second answer"; },
  },
  { rounds: 1 },
);
const TURNS_PER_CALL = 2; // proven in g1-judge-double-turn.mjs
console.log("");
console.log(`one repair round: judge x${judgeCalls}, repair x${repairCalls}  -> status ${res.status}`);
console.log(`  documented cost : ${judgeCalls + repairCalls} model calls`);
console.log(`  actual cost     : ${(judgeCalls + repairCalls) * TURNS_PER_CALL} model calls (each maxTurns:1 run takes two turns)`);
