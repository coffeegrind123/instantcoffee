/**
 * AL1 — a continuation's transcript, and where it starts reading.
 *
 * `AgentOutputLog` attaches once, at `onSessionCreated`, to a session holding
 * exactly one message: the prompt it has already written as its own opening
 * line. `writtenCount = 1` was therefore correct for every attach this file had
 * for the life of the package.
 *
 * The twentieth pass added a second kind of attach. `continueSettledAgent`
 * builds a FRESH `AgentTranscript` for a follow-up — deliberately, so the
 * follow-up is recorded rather than silently absent — and subscribes it to the
 * child's EXISTING session, which by then holds every message of the run that
 * has already settled. A subscription anchored at 1 replays all of them on its
 * first flush.
 *
 * The bound is what made it invisible. `MAX_LINES` keeps the first 120 lines of
 * what it is handed, so the entry labelled *turn 1* of the follow-up held the
 * BEGINNING of the previous run and `dropped` counted the rest — including the
 * answer the follow-up was actually about. It reads exactly like a truncated
 * answer, which is why nothing about it looks like a replay.
 *
 * Every case here is paired with the control that decides whether the fix is
 * worth having: the FIRST attach must still emit the child's own first turn,
 * and the compaction re-anchor must still re-read a rebuilt array from the top.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AgentTranscript, MAX_LINES, type SubagentEntry } from "../src/agents/transcript-entry.ts";
import { streamAgentOutput } from "../src/agents/output-file.ts";

function recorder() {
  const entries: SubagentEntry[] = [];
  return {
    entries,
    pi: {
      appendEntry<T>(_customType: string, data: T) {
        entries.push(data as unknown as SubagentEntry);
      },
    },
  };
}

/** The two events `streamAgentOutput` keys on, over a fake session. */
function fakeSession(messages: Array<Record<string, unknown>>) {
  const listeners: Array<(event: Record<string, unknown>) => void> = [];
  return {
    messages,
    subscribe(listener: (event: Record<string, unknown>) => void) {
      listeners.push(listener);
      return () => listeners.splice(listeners.indexOf(listener), 1);
    },
    turnEnd() {
      for (const listener of [...listeners]) listener({ type: "turn_end" });
    },
    compactionEnd(result: unknown = { summary: "…" }) {
      for (const listener of [...listeners]) listener({ type: "compaction_end", aborted: false, result });
    },
  };
}

const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });

/** A settled run: the brief, then eight turns of work, then the answer. */
function settledRun() {
  return [
    { role: "user", content: "map every call site of resolveWorktree" },
    ...Array.from({ length: 8 }, (_, i) => assistant(`step ${i}: read a file and grep for the symbol`)),
    assistant("ANSWER: eleven call sites, listed by file."),
  ];
}

describe("AL1 — a continuation reads from where the settled run ended", () => {
  it("the follow-up's first entry holds the follow-up, not the run before it", () => {
    const { pi, entries } = recorder();
    const session = fakeSession(settledRun());
    const anchor = session.messages.length;

    const transcript = new AgentTranscript(pi, "abcdef1234", "explore");
    transcript.brief("now also list the tests that cover them");
    transcript.setCleanup(
      streamAgentOutput(session as never, transcript.sink, undefined, 0, transcript.endTurn, anchor),
    );

    session.messages.push({ role: "user", content: "now also list the tests that cover them" });
    session.messages.push(assistant("FOLLOW-UP: four tests, in two files."));
    session.turnEnd();

    const turn = entries.find((entry) => entry.phase === "turn");
    assert.ok(turn, "the follow-up turn should have produced an entry");
    const text = turn.lines.join("\n");
    assert.match(text, /FOLLOW-UP: four tests/);
    assert.doesNotMatch(text, /step 0:/, "the settled run must not be replayed");
    assert.doesNotMatch(text, /ANSWER: eleven call sites/);
  });

  it("control — the FIRST attach still records the child's own first turn", () => {
    const { pi, entries } = recorder();
    // What `onSessionCreated` sees: the prompt, and nothing else yet.
    const session = fakeSession([{ role: "user", content: "map every call site" }]);

    const transcript = new AgentTranscript(pi, "abcdef1234", "explore");
    transcript.setCleanup(
      streamAgentOutput(session as never, transcript.sink, undefined, 0, transcript.endTurn),
    );
    session.messages.push(assistant("step 0: read the file"));
    session.turnEnd();

    const turn = entries.find((entry) => entry.phase === "turn");
    assert.ok(turn);
    assert.match(turn.lines.join("\n"), /step 0: read the file/);
    // …and the prompt itself is still not repeated: index 0 is the caller's own
    // opening line, which is exactly what the default of 1 is for.
    assert.doesNotMatch(turn.lines.join("\n"), /map every call site/);
  });

  it("the defect, reproduced: anchoring at 1 on a settled session replays it", () => {
    const { pi, entries } = recorder();
    const session = fakeSession(settledRun());

    const transcript = new AgentTranscript(pi, "abcdef1234", "explore");
    // No anchor — the shape `continueSettledAgent` used to have.
    transcript.setCleanup(
      streamAgentOutput(session as never, transcript.sink, undefined, 0, transcript.endTurn),
    );
    session.messages.push(assistant("FOLLOW-UP: four tests, in two files."));
    session.turnEnd();

    const turn = entries.find((entry) => entry.phase === "turn");
    assert.ok(turn);
    assert.match(
      turn.lines.join("\n"),
      /step 0:/,
      "this is the behaviour AL1 is about; if it stops holding, the anchor default has changed",
    );
  });

  it("a long settled run pushes the follow-up out of the entry entirely", () => {
    const { pi, entries } = recorder();
    // Long enough that the bound alone decides what survives.
    const session = fakeSession([
      { role: "user", content: "the brief" },
      ...Array.from({ length: MAX_LINES + 20 }, (_, i) => assistant(`old line ${i}`)),
    ]);

    const unanchored = recorder();
    const bad = new AgentTranscript(unanchored.pi, "abcdef1234", "explore");
    bad.setCleanup(streamAgentOutput(session as never, bad.sink, undefined, 0, bad.endTurn));
    const anchored = new AgentTranscript(pi, "abcdef1234", "explore");
    anchored.setCleanup(
      streamAgentOutput(session as never, anchored.sink, undefined, 0, anchored.endTurn, session.messages.length),
    );

    session.messages.push(assistant("FOLLOW-UP: the thing that was actually asked."));
    session.turnEnd();

    const badTurn = unanchored.entries.find((entry) => entry.phase === "turn");
    const goodTurn = entries.find((entry) => entry.phase === "turn");
    assert.ok(badTurn && goodTurn);
    assert.doesNotMatch(
      badTurn.lines.join("\n"),
      /FOLLOW-UP/,
      "the bound keeps the head, so the replay evicts the new answer",
    );
    assert.ok((badTurn.dropped ?? 0) > 0, "and reports it as lines cut, which is how it hides");
    assert.match(goodTurn.lines.join("\n"), /FOLLOW-UP/);
  });

  it("control — the compaction re-anchor still re-reads a rebuilt array", async () => {
    const { pi, entries } = recorder();
    const session = fakeSession(settledRun());
    const transcript = new AgentTranscript(pi, "abcdef1234", "explore");
    transcript.setCleanup(
      streamAgentOutput(session as never, transcript.sink, undefined, 0, transcript.endTurn, session.messages.length),
    );

    // pi rebuilds `messages` on a compaction: index 0 is the new summary.
    session.compactionEnd();
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    session.messages.length = 0;
    session.messages.push({ role: "user", content: "[summary of the work so far]" });
    session.messages.push(assistant("post-compaction: carried on from the summary"));
    session.turnEnd();

    const turn = entries.find((entry) => entry.phase === "turn");
    assert.ok(turn, "a post-compaction turn must still be recorded");
    assert.match(turn.lines.join("\n"), /post-compaction: carried on/);
  });
});
