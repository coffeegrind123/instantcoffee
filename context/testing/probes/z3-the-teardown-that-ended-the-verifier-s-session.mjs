/**
 * z3 — AM3. `AgentManager.dispose()` disposed `execution.session` — the session
 * a REPAIR runs in — and left the verifier running with a handle to it.
 *
 * FIXED — this drives the REAL `teardownRecord` and the REAL `verifyAnswer`, and
 * prints the sentence the parent model receives in each column.
 *
 * ## Why it is not a crash
 *
 * `AgentSession.dispose()` aborts the agent and calls `_disconnectFromAgent()`.
 * A `prompt()` afterwards still reaches the provider; its events reach nobody.
 * So the repair spends a model call on the one llama slot during a session
 * teardown, `collectResponseText` sees no `message_end` at all, and the empty
 * result goes through `structuralVerdict("")` → `ok: false` → the child's
 * ORIGINAL answer is handed back annotated *"checked against the task and did
 * not address it"*.
 *
 * The check being torn down is reported to the parent as the child having
 * failed — the inversion `verifyAnswer`'s "never throws" contract exists to
 * prevent, arriving from the outside.
 *
 * `stopAgent()` has known how to end a verifying record since T5, and its own
 * comment says the abort is for "the operator's Esc, for `StopAgent`, and for
 * anything else that asked". `session_shutdown` is something else that asked.
 *
 *   run: node --experimental-strip-types z3-the-teardown-that-ended-the-verifier-s-session.mjs [order|answer|clear]
 */

const REPO = "/home/claudeuser/qwen3.8-forge";
const { teardownRecord } = await import(`${REPO}/vendor/pi-subagents-lite/src/agents/record-teardown.ts`);
const { verifyAnswer } = await import(`${REPO}/vendor/pi-subagents-lite/src/agents/verify-runner.ts`);

const MODES = {
  /** What is ended, and in what order. */
  order: {},
  /** The sentence the PARENT MODEL is handed, in each column. */
  answer: {},
  /** The control: `clear()` goes through the same teardown, and Y1 still refuses a verifying record. */
  clear: {},
};

const MODE = process.argv[2] ?? "order";
if (!MODES[MODE]) {
  console.error(`usage: node z3-…mjs <${Object.keys(MODES).join("|")}>`);
  process.exit(2);
}

let failures = 0;
const check = (label, ok) => {
  console.log(`   ${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) failures++;
};

const ANSWER = "decodeFrame() is called from src/decode.ts:41 and src/net/frame.ts:88.";
const BRIEF = "List every call site of decodeFrame().";

function makeRecord(ended) {
  return {
    execution: {
      transcript: { dispose: () => ended.push("transcript") },
      verifyAbort: { abort: () => ended.push("verifier") },
      session: { dispose: () => ended.push("session") },
    },
  };
}

/** The teardown as `dispose()` had it: transcript, then session, and nothing else. */
function teardownBefore(record) {
  record.execution.transcript?.dispose();
  record.execution.transcript = undefined;
  record.execution.session?.dispose();
}

console.log(`\nz3 [${MODE}] — the teardown that ended the verifier's session (AM3)\n`);

if (MODE === "order") {
  const columns = { BEFORE: teardownBefore, NOW: teardownRecord };
  const results = {};
  for (const [label, teardown] of Object.entries(columns)) {
    const ended = [];
    const record = makeRecord(ended);
    teardown(record);
    results[label] = { ended, record };
    console.log(`   ${label}`);
    console.log(`     ended, in order          : ${ended.join(" → ")}`);
    console.log(`     verifier stopped         : ${ended.includes("verifier") ? "yes" : "NO"}`);
    console.log(`     session handle dropped   : ${record.execution.session === undefined ? "yes" : "NO"}\n`);
  }
  check("BEFORE the session went and the verifier did not", !results.BEFORE.ended.includes("verifier"));
  check("…and the handle it would prompt was left in place", results.BEFORE.record.execution.session !== undefined);
  check("NOW the verifier is ended", results.NOW.ended.includes("verifier"));
  check(
    "…BEFORE the session it is running in",
    results.NOW.ended.indexOf("verifier") < results.NOW.ended.indexOf("session"),
  );
} else if (MODE === "answer") {
  console.log("   the judge says no, so a repair runs. The two columns differ only in");
  console.log("   whether the verifier was ENDED before its session was.\n");

  const judge = async () => "VERDICT: NOT_ADDRESSED\nWHY: it lists two and there are three.";
  const columns = {
    // A disposed AgentSession still accepts prompt(); nothing streams back.
    BEFORE: async () => ({ text: "", status: "completed" }),
    // An aborted verifier: `assertNotExpired()` throws "the repair was stopped".
    NOW: async () => {
      throw new Error("the repair was stopped");
    },
  };

  const results = {};
  for (const [label, repair] of Object.entries(columns)) {
    const outcome = await verifyAnswer(
      { result: ANSWER, lifecycle: { status: "completed" } },
      BRIEF,
      { judge, repair },
      { rounds: 1 },
    );
    results[label] = outcome;
    const note = outcome.answer.slice(ANSWER.length).trim();
    console.log(`   ${label}`);
    console.log(`     verdict recorded         : ${outcome.status}`);
    console.log(`     the parent model reads   : ${JSON.stringify(note)}\n`);
  }
  check("BEFORE the child's own answer was blamed", results.BEFORE.status === "failed");
  check("…in a sentence about the ANSWER", /did not address it/.test(results.BEFORE.answer));
  check("NOW the verdict says the CHECK did not happen", results.NOW.status === "errored");
  check("…and nothing is said about the answer", !/did not address it/.test(results.NOW.answer));
  check("…which is intact in both columns", results.BEFORE.answer.startsWith(ANSWER) && results.NOW.answer.startsWith(ANSWER));
} else {
  console.log("   the control: `clear()` goes through the same teardown, and Y1's");
  console.log("   refusal — a record whose answer is still being checked cannot be");
  console.log("   cleared — is what keeps a verifying record out of it in the first");
  console.log("   place. The teardown is the backstop, not the gate.\n");
  const ended = [];
  const record = makeRecord(ended);
  teardownRecord(record);
  console.log(`     ended, in order          : ${ended.join(" → ")}\n`);
  check("one teardown for both call sites", ended.length === 3);
  check("verifyAbort itself is left for runVerification's finally", record.execution.verifyAbort !== undefined);
  const nothing = { execution: {} };
  teardownRecord(nothing);
  check("a record with nothing attached is not an error", nothing.execution.session === undefined);
}

console.log(failures === 0 ? "   all expectations held\n" : `   ${failures} expectation(s) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
