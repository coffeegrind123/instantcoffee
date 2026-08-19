/**
 * The judge's raw reply, kept — the #1 item on the "still unwatched" list since
 * the fourth pass, closed in the fifteenth.
 *
 * It is not a defect and it never produced a symptom. It is the reason four
 * findings in this series needed a probe before anyone could believe them, and
 * every one of those four is a statement about a string that existed for a few
 * milliseconds inside `verifyAnswer` and was then discarded:
 *
 *   S2  a judge that echoed the prompt's own `VERDICT: ADDRESSED or
 *       NOT_ADDRESSED` menu was read as having CHOSEN `NOT_ADDRESSED`
 *   U4  a judge that echoed the `WHY:` instruction had that instruction quoted
 *       back to the child as the reason its answer was wrong
 *   V5  a repair hard-aborted mid-token reached the judge as an ordinary answer
 *   W5  the note the parent reads said "the 2th attempt"
 *
 * `parseJudgeVerdict` is careful and heavily tested — against replies somebody
 * imagined a 27B writing. The log is how the next finding gets to be about a
 * reply a 27B actually wrote.
 *
 * The two halves are tested separately because they have different failure
 * modes: the FILE must be bounded, private and unable to throw; the WIRING must
 * put the reply and the parse on the same line, since neither alone can show
 * that the parser was wrong.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  MAX_FIELD_CHARS,
  MAX_LINES,
  appendVerifyLog,
  resetVerifyLogCounter,
  verifyLogEnabled,
  verifyLogFile,
} from "../src/agents/verify-log.ts";
import { verifyAnswer, type VerifyDeps, type VerifyLogRecord } from "../src/agents/verify-runner.ts";

const entry = (over: Partial<Parameters<typeof appendVerifyLog>[0]> = {}) => ({
  phase: "judge" as const,
  attempt: 0,
  prompt: "TASK: …",
  reply: "VERDICT: ADDRESSED",
  parsed: { addressed: true, unparsed: false, why: "it lists the call sites" },
  ...over,
});

function tempEnv(): NodeJS.ProcessEnv {
  return { SUBAGENT_VERIFY_LOG_FILE: join(mkdtempSync(join(tmpdir(), "verify-log-")), "v.jsonl") };
}

const lines = (env: NodeJS.ProcessEnv) =>
  readFileSync(verifyLogFile(env), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));

describe("the verification log", () => {
  it("writes one line per call, with the reply and the parse together", () => {
    const env = tempEnv();
    assert.equal(appendVerifyLog(entry(), env), true);
    const [written] = lines(env);

    assert.equal(written.reply, "VERDICT: ADDRESSED");
    assert.deepEqual(written.parsed, { addressed: true, unparsed: false, why: "it lists the call sites" });
    assert.match(written.ts, /^\d{4}-\d{2}-\d{2}T/);
  });

  it("keeps the fields that identify which delegation it was", () => {
    const env = tempEnv();
    appendVerifyLog(entry({ agentId: "1a2b3c4d", agentType: "Explore", attempt: 1, ms: 4_120 }), env);
    const [written] = lines(env);
    assert.equal(written.agentId, "1a2b3c4d");
    assert.equal(written.agentType, "Explore");
    assert.equal(written.attempt, 1);
    assert.equal(written.ms, 4_120);
  });

  it("records a repair by how the RUN ended, which is what the gate reads", () => {
    // V5: the repair used to report only its text, so the structural gate — whose
    // whole job is refusing to judge a run that was cut off — could not see that
    // it had been hard-aborted.
    const env = tempEnv();
    appendVerifyLog(entry({ phase: "repair", reply: "partial answ", runStatus: "aborted", parsed: undefined }), env);
    const [written] = lines(env);
    assert.equal(written.phase, "repair");
    assert.equal(written.runStatus, "aborted");
    assert.equal(written.parsed, undefined, "a repair is not parsed, so it must not claim a verdict");
  });

  it("bounds both fields", () => {
    const env = tempEnv();
    appendVerifyLog(entry({ prompt: "p".repeat(50_000), reply: "r".repeat(50_000) }), env);
    const [written] = lines(env);
    assert.ok(written.prompt.length < MAX_FIELD_CHARS + 100);
    assert.ok(written.reply.length < MAX_FIELD_CHARS + 100);
    assert.match(written.reply, /more chars\]$/, "and says how much it dropped");
  });

  it("bounds the file, keeping the newest lines", () => {
    // An unattended loop verifies every delegation and nothing else would ever
    // remove a line — the same argument MAX_SPILL_FILES exists for.
    const env = tempEnv();
    resetVerifyLogCounter();
    for (let i = 0; i < MAX_LINES + 120; i++) {
      appendVerifyLog(entry({ attempt: i, reply: "x".repeat(300) }), env);
    }
    const written = lines(env);
    assert.ok(written.length <= MAX_LINES + 50, `kept ${written.length} lines`);
    assert.equal(written[written.length - 1].attempt, MAX_LINES + 119, "the newest line survives");
  });

  it("can be switched off", () => {
    const env = { ...tempEnv(), SUBAGENT_VERIFY_LOG: "0" };
    assert.equal(verifyLogEnabled(env), false);
    assert.equal(appendVerifyLog(entry(), env), false);
  });

  it("never throws, whatever the filesystem does", () => {
    // The caller is `verifyAnswer`, whose entire contract is "never throw — an
    // unverified answer is worth more than no answer".
    const file = join(mkdtempSync(join(tmpdir(), "verify-log-")), "as-a-file");
    writeFileSync(file, "");
    const env = { SUBAGENT_VERIFY_LOG_FILE: join(file, "impossible", "v.jsonl") };
    assert.equal(appendVerifyLog(entry(), env), false, "it reports the failure rather than raising it");
  });

  it("defaults to the agent directory, not the working directory", () => {
    // A verification is a fact about this install, not about whatever repository
    // the parent happened to be looping on.
    assert.equal(
      verifyLogFile({ PI_CODING_AGENT_DIR: "/opt/pi" } as NodeJS.ProcessEnv),
      "/opt/pi/subagent-verify.jsonl",
    );
  });
});

describe("the wiring — verifyAnswer logs what it acted on", () => {
  const record = { result: "src/decode.ts:12 calls it", lifecycle: { status: "completed" as const } };
  const brief = "Find every call site of decodeFrame().";

  const run = async (over: Partial<VerifyDeps>, rounds = 1) => {
    const logged: VerifyLogRecord[] = [];
    const deps: VerifyDeps = {
      judge: async () => "VERDICT: ADDRESSED\nWHY: it lists them.",
      repair: async () => ({ text: "corrected", status: "completed" }),
      log: (line) => logged.push(line),
      ...over,
    };
    const outcome = await verifyAnswer(record, brief, deps, { rounds });
    return { logged, outcome };
  };

  it("logs the judge's RAW reply, not the parse of it", async () => {
    const raw = "Hmm. VERDICT: ADDRESSED or NOT_ADDRESSED\nVERDICT: ADDRESSED\nWHY: it lists them.";
    const { logged } = await run({ judge: async () => raw });

    assert.equal(logged.length, 1);
    assert.equal(logged[0].phase, "judge");
    assert.equal(logged[0].reply, raw, "byte for byte — the menu echo is S2, and it has to be visible");
    assert.equal(logged[0].parsed?.addressed, true, "…beside what the parser made of it");
  });

  it("logs the prompt the judge was given", async () => {
    const { logged } = await run({});
    assert.match(logged[0].prompt, /Find every call site of decodeFrame/);
    assert.match(logged[0].prompt, /VERDICT: ADDRESSED or NOT_ADDRESSED/);
  });

  it("logs an unreadable reply as unparsed rather than as a pass", async () => {
    // The stack treats unparsed as ADDRESSED, deliberately. The log is where the
    // difference stays visible.
    const { logged, outcome } = await run({ judge: async () => "I think it's fine?" });
    assert.equal(outcome.status, "unparsed");
    assert.equal(logged[0].parsed?.unparsed, true);
  });

  it("logs a repair with the run's status, and the re-judge after it", async () => {
    const replies = ["VERDICT: NOT_ADDRESSED\nWHY: it names one file.", "VERDICT: ADDRESSED\nWHY: complete now."];
    const { logged, outcome } = await run({
      judge: async () => replies.shift() ?? "VERDICT: ADDRESSED",
      repair: async () => ({ text: "every call site, with lines", status: "completed" }),
    });

    assert.equal(outcome.status, "repaired");
    assert.deepEqual(
      logged.map((line) => line.phase),
      ["judge", "repair", "judge"],
      "the whole round trip, in order",
    );
    assert.equal(logged[1].runStatus, "completed");
    assert.match(logged[1].prompt, /This is the task, in full/);
  });

  it("logs nothing for a structural skip, because no model was called", async () => {
    const empty = { result: "", lifecycle: { status: "completed" as const } };
    const logged: VerifyLogRecord[] = [];
    await verifyAnswer(empty, brief, {
      judge: async () => "unused",
      repair: async () => ({ text: "", status: "completed" }),
      log: (line) => logged.push(line),
    });
    assert.deepEqual(logged, [], "a free check has no reply to keep");
  });

  it("a logger that throws costs a log line, not the verdict", async () => {
    const { outcome } = await run({
      log: () => {
        throw new Error("disk full");
      },
    });
    assert.equal(outcome.status, "passed");
  });

  it("control — no logger at all is still a working verifier", async () => {
    const outcome = await verifyAnswer(record, brief, {
      judge: async () => "VERDICT: ADDRESSED",
      repair: async () => ({ text: "x", status: "completed" }),
    });
    assert.equal(outcome.status, "passed");
  });
});
