/**
 * y1 — AL1. A continuation's transcript began at message 1 of a session that
 * already held a finished run, so the follow-up's first entry was the previous
 * run — and the bound then ate the answer.
 *
 * FIXED — this drives the REAL `streamAgentOutput` and the REAL
 * `AgentTranscript` over a settled run plus a follow-up, at both anchors, and
 * prints the entry the operator would read in each column.
 *
 * ## The finding
 *
 * `AgentOutputLog` attaches once, at `onSessionCreated`, to a session holding
 * exactly one message — the prompt it has already written as its opening line.
 * `writtenCount = 1` was right for every attach the file had, for the life of
 * the package.
 *
 * The twentieth pass added a second kind of attach. `continueSettledAgent`
 * builds a FRESH `AgentTranscript` for a follow-up — deliberately, so the
 * follow-up is recorded rather than silently absent — and subscribes it to the
 * child's EXISTING session, which by then holds every message of the run that
 * has already settled.
 *
 * **The bound is what hid it.** `MAX_LINES` keeps the first 120 lines of what an
 * entry is handed and counts the rest as `dropped`. So the entry labelled
 * *turn 1* of the follow-up held the BEGINNING of the previous run, and what
 * fell off the end was the answer the follow-up was about. On screen that is
 * indistinguishable from a long answer that was truncated, which is why nothing
 * about the symptom points at a replay.
 *
 * The compaction re-anchor is the control and is unchanged: `compaction_end`
 * still resets to 1, and correctly — pi REBUILDS the array, so index 0 is the
 * new summary and everything after it is new.
 *
 *   run: node --experimental-strip-types y1-the-follow-up-that-replayed-the-run-before-it.mjs [followup|first|compaction]
 */

const REPO = "/home/claudeuser/qwen3.8-forge";
const { AgentTranscript, MAX_LINES } = await import(`${REPO}/vendor/pi-subagents-lite/src/agents/transcript-entry.ts`);
const { streamAgentOutput } = await import(`${REPO}/vendor/pi-subagents-lite/src/agents/output-file.ts`);

const MODES = {
  /** The finding: a second attach to a session that already holds a run. */
  followup: {},
  /** The first attach, which is what the default of 1 was written for. */
  first: {},
  /** A compaction mid-run: pi rebuilds the array, so 1 is right again. */
  compaction: {},
};

const MODE = process.argv[2] ?? "followup";
if (!MODES[MODE]) {
  console.error(`usage: node y1-…mjs <${Object.keys(MODES).join("|")}>`);
  process.exit(2);
}

let failures = 0;
const check = (label, ok) => {
  console.log(`   ${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) failures++;
};

const assistant = (text) => ({ role: "assistant", content: [{ type: "text", text }] });

/** A settled run long enough that the answer falls off the end of one entry. */
function settledRun() {
  return [
    { role: "user", content: "map every call site of resolveWorktree" },
    ...Array.from({ length: MAX_LINES + 20 }, (_, i) => assistant(`step ${i}: read a file and grep for the symbol`)),
    assistant("ANSWER: eleven call sites, listed by file."),
  ];
}

function fakeSession(messages) {
  const listeners = [];
  return {
    messages,
    subscribe(listener) {
      listeners.push(listener);
      return () => listeners.splice(listeners.indexOf(listener), 1);
    },
    turnEnd: () => [...listeners].forEach((l) => l({ type: "turn_end" })),
    compactionEnd: () => [...listeners].forEach((l) => l({ type: "compaction_end", aborted: false, result: { summary: "…" } })),
  };
}

/** One column: attach a transcript at `anchor` and record what it writes. */
function column(anchor) {
  const entries = [];
  const pi = { appendEntry: (_type, data) => entries.push(data) };
  const messages = settledRun();
  const session = fakeSession(messages);

  const transcript = new AgentTranscript(pi, "abcdef1234", "explore");
  transcript.brief("now list the three that pass a relative path", "follow-up");
  const stop = streamAgentOutput(session, transcript.sink, undefined, 0, transcript.endTurn, anchor);

  if (MODE === "compaction") {
    // pi rebuilds `messages`: index 0 becomes the summary.
    messages.length = 0;
    messages.push({ role: "user", content: "[summary of the run so far]" });
    session.compactionEnd();
    // A microtask, because the re-anchor is deferred by one.
    return { entries, stop, session, messages, transcript, deferred: true };
  }

  messages.push(assistant("Three of them: parseArgs, loadConfig, resolveMain."));
  session.turnEnd();
  stop();
  return { entries, transcript };
}

async function finishCompaction(state) {
  await Promise.resolve();
  state.messages.push(assistant("Three of them: parseArgs, loadConfig, resolveMain."));
  state.session.turnEnd();
  state.stop();
  return state;
}

console.log(`\ny1 [${MODE}] — the follow-up that replayed the run before it (AL1)\n`);
console.log(`   the child's session already holds : ${settledRun().length} messages`);
console.log(`   MAX_LINES per entry               : ${MAX_LINES}\n`);

const anchors = MODE === "first" ? { BEFORE: 1, NOW: 1 } : { BEFORE: 1, NOW: settledRun().length };

const results = {};
for (const [label, anchor] of Object.entries(anchors)) {
  let state = column(anchor);
  if (state.deferred) state = await finishCompaction(state);
  const turn = state.entries.find((e) => e.phase === "turn");
  results[label] = { anchor, turn, entries: state.entries };

  console.log(`   ${label}  (subscription anchored at message ${anchor})`);
  if (!turn) {
    console.log("     no turn entry at all\n");
    continue;
  }
  console.log(`     entry "turn ${turn.turn}" opens with : ${JSON.stringify(turn.lines[0])}`);
  console.log(`     …and ends with                : ${JSON.stringify(turn.lines[turn.lines.length - 1])}`);
  console.log(`     lines kept / dropped          : ${turn.lines.length} / ${turn.dropped ?? 0}`);
  const holdsFollowUp = turn.lines.some((l) => /parseArgs, loadConfig, resolveMain/.test(l));
  console.log(`     holds the follow-up's answer  : ${holdsFollowUp ? "yes" : "NO"}\n`);
}

if (MODE === "followup") {
  console.log("   the entry the operator reads is labelled `turn 1` of the follow-up.");
  console.log("   BEFORE it was the first 120 lines of the run that had already");
  console.log("   finished, and the answer they asked the follow-up for was in the");
  console.log("   `dropped` count — which reads as a truncated answer, not a replay.\n");
  check(
    "BEFORE replayed the settled run",
    /step 0:/.test(results.BEFORE.turn.lines.join("\n")),
  );
  check("…and dropped the follow-up's answer", (results.BEFORE.turn.dropped ?? 0) > 0);
  check(
    "NOW the entry holds the follow-up's answer",
    results.NOW.turn.lines.some((l) => /parseArgs, loadConfig, resolveMain/.test(l)),
  );
  check("…and nothing is dropped", !results.NOW.turn.dropped);
} else if (MODE === "first") {
  console.log("   the control: at the FIRST attach index 0 is the prompt the log has");
  console.log("   already written as its own opening line, so 1 is right — and the");
  console.log("   fix must not move it.\n");
  check("the first attach still records the child's work", results.NOW.turn.lines.length > 0);
  check("and skips the prompt it already wrote", !results.NOW.turn.lines.some((l) => /\[USER\].*map every call site/.test(l)));
} else {
  console.log("   the control: pi REBUILDS `session.messages` on a compaction, so");
  console.log("   index 0 is the new summary and 1 is right again. The re-anchor");
  console.log("   inside `streamAgentOutput` is untouched by the fix.\n");
  check("the post-compaction turn is recorded", Boolean(results.NOW.turn));
  check(
    "…and holds what happened after the compaction",
    results.NOW.turn.lines.some((l) => /parseArgs, loadConfig, resolveMain/.test(l)),
  );
}

console.log(failures === 0 ? "   all expectations held\n" : `   ${failures} expectation(s) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
