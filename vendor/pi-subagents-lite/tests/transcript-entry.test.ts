/**
 * A subagent's own turns, in the operator's session transcript.
 *
 * ## What this is for
 *
 * The operator asked for it in as many words on 2026-08-19: *"subagents are not
 * logged into the session transcripts and they should be — in the same session
 * transcript that the main stuff goes into, just marked as a subagent."*
 *
 * Before this, one delegation put exactly two things in the parent's session
 * file: the `Agent` tool call and its result, or the `subagent-result` message.
 * The child's own turns were in three other places — an in-memory session that
 * is thrown away, a `/tmp` log that is OFF by default, and the verifier's
 * JSONL — so the evidence for one delegation was spread across three files,
 * two of them outside the session, and by default two of the three did not
 * exist.
 *
 * ## What is asserted here, and what is asserted elsewhere
 *
 * Here: the bounds, the attribution, and that nothing can throw. Those are the
 * three properties an unattended `/loop` delegating for days depends on, and
 * all three are testable without pi.
 *
 * Elsewhere: that a `type: "custom"` entry is written to the session file,
 * rendered, and never sent to the model. That is a fact about pi, not about
 * this module, and `context/testing/probes/x2-…` measures it against a real
 * session rather than restating it.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AgentTranscript,
  MAX_ENTRIES,
  MAX_ENTRY_CHARS,
  MAX_LINES,
  SUBAGENT_ENTRY_TYPE,
  TRUNCATION_MARK,
  transcriptEnabled,
  type SubagentEntry,
} from "../src/agents/transcript-entry.ts";
import { streamAgentOutput } from "../src/agents/output-file.ts";

function recorder() {
  const entries: SubagentEntry[] = [];
  return {
    entries,
    pi: {
      appendEntry<T>(customType: string, data: T) {
        assert.equal(customType, SUBAGENT_ENTRY_TYPE);
        entries.push(data as unknown as SubagentEntry);
      },
    },
  };
}

describe("the transcript switch", () => {
  it("is on by default — a record of what happened should not need predicting", () => {
    assert.equal(transcriptEnabled({}), true);
  });

  it("is off for SUBAGENT_TRANSCRIPT=0, the way SUBAGENT_VERIFY_LOG=0 works", () => {
    assert.equal(transcriptEnabled({ SUBAGENT_TRANSCRIPT: "0" }), false);
    // Anything else is on: a switch that treats "false" and "no" as off would
    // be a fourth spelling convention in one package.
    assert.equal(transcriptEnabled({ SUBAGENT_TRANSCRIPT: "1" }), true);
  });
});

describe("attribution", () => {
  it("names the agent on every entry, because three settle interleaved", () => {
    const { pi, entries } = recorder();
    const transcript = new AgentTranscript(pi, "abcdef1234", "code-reviewer");
    transcript.brief("review src/a.ts", "review a.ts");
    transcript.verify("verify", "TASK: …", "VERDICT: ADDRESSED");
    transcript.finalize("code-reviewer completed: 3 turn(s)");

    assert.equal(entries.length, 3);
    for (const entry of entries) {
      assert.equal(entry.agentId, "abcdef1234");
      assert.equal(entry.agentType, "code-reviewer");
      assert.ok(entry.shortId.length > 0);
      assert.ok(entry.agentId.startsWith(entry.shortId));
    }
    assert.deepEqual(
      entries.map((entry) => entry.phase),
      ["brief", "verify", "done"],
    );
    assert.equal(entries[0].description, "review a.ts");
  });

  it("puts the judge's question and its answer in one entry", () => {
    const { pi, entries } = recorder();
    const transcript = new AgentTranscript(pi, "abcdef1234", "explore");
    transcript.verify("repair", "Your answer did not address the task", "here is the answer");
    const text = entries[0].lines.join("\n");
    assert.match(text, /PROMPT: Your answer did not address the task/);
    assert.match(text, /REPLY: here is the answer/);
  });
});

describe("bounds, because an unattended run delegates for days", () => {
  it("caps the characters in one entry", () => {
    const { pi, entries } = recorder();
    const transcript = new AgentTranscript(pi, "abcdef1234", "explore");
    transcript.brief("x".repeat(MAX_ENTRY_CHARS * 3));
    const chars = entries[0].lines.join("").length;
    assert.ok(chars <= MAX_ENTRY_CHARS, `${chars} > ${MAX_ENTRY_CHARS}`);
    // Twenty-first pass, §11.10 of `…-lifetimes.md`. The assertion above is
    // satisfied by an entry
    // holding NOTHING, and for one pass that is what it was measuring: a single
    // line longer than the budget made `kept` empty on the first iteration, so
    // a brief written as one long paragraph became `lines: []` with
    // `dropped: 1`. `chars <= MAX_ENTRY_CHARS` is a bound on the wrong side.
    assert.ok(chars > 0, "a capped entry must still hold what it could fit");
  });

  it("truncates the line it cannot fit rather than deleting it", () => {
    const { pi, entries } = recorder();
    const transcript = new AgentTranscript(pi, "abcdef1234", "explore");
    // One line, no newline in it — a brief written as a paragraph, or a model
    // that answers without a line break.
    transcript.brief(`OPENING WORDS ${"x".repeat(MAX_ENTRY_CHARS * 2)} CLOSING WORDS`);

    const [entry] = entries;
    assert.equal(entry.lines.length, 1);
    assert.match(entry.lines[0], /^OPENING WORDS /, "the head is what a reader needs");
    assert.ok(entry.lines[0].endsWith(TRUNCATION_MARK), "and it says it was cut");
    assert.ok(entry.lines[0].length <= MAX_ENTRY_CHARS);
  });

  it("a long line in the MIDDLE does not take the lines above it with it", () => {
    const { pi, entries } = recorder();
    const transcript = new AgentTranscript(pi, "abcdef1234", "explore");
    transcript.brief(["first", "second", "x".repeat(MAX_ENTRY_CHARS * 2), "never reached"].join("\n"));

    const [entry] = entries;
    assert.deepEqual(entry.lines.slice(0, 2), ["first", "second"]);
    assert.equal(entry.lines.length, 3, "the third is the truncated one");
    assert.equal(entry.dropped, 1, "and the fourth is genuinely dropped");
  });

  it("caps the lines in one entry, and says how many it cut", () => {
    const { pi, entries } = recorder();
    const transcript = new AgentTranscript(pi, "abcdef1234", "explore");
    transcript.brief(Array.from({ length: MAX_LINES * 2 }, (_, i) => `line ${i}`).join("\n"));
    assert.equal(entries[0].lines.length, MAX_LINES);
    assert.equal(entries[0].dropped, MAX_LINES);
  });

  it("caps the entries per agent, and the closing entry still gets through", () => {
    const { pi, entries } = recorder();
    const transcript = new AgentTranscript(pi, "abcdef1234", "explore");
    for (let i = 0; i < MAX_ENTRIES + 15; i++) transcript.verify("verify", `p${i}`, `r${i}`);
    transcript.finalize("explore completed");

    // MAX_ENTRIES ordinary entries, plus the closing one, and nothing else.
    assert.equal(entries.length, MAX_ENTRIES + 1);
    const last = entries[entries.length - 1];
    assert.equal(last.phase, "done");
    // …and it says what was left out, so a capped transcript does not read as
    // one that simply stopped.
    assert.match(last.lines.join("\n"), /15 further turn\(s\) were not written/);
    assert.match(last.lines.join("\n"), new RegExp(`${MAX_ENTRIES}-entry transcript cap`));
  });
});

describe("never throws", () => {
  it("swallows a writer that is gone — a stale runtime is the ordinary case", () => {
    const transcript = new AgentTranscript(
      {
        appendEntry() {
          throw new Error("This extension ctx is stale after session replacement");
        },
      },
      "abcdef1234",
      "explore",
    );
    assert.doesNotThrow(() => transcript.brief("do the thing"));
    assert.doesNotThrow(() => transcript.verify("verify", "p", "r"));
    assert.doesNotThrow(() => transcript.finalize("stopped"));
  });

  it("finalize is once, so a second settlement cannot write a second ending", () => {
    const { pi, entries } = recorder();
    const transcript = new AgentTranscript(pi, "abcdef1234", "explore");
    transcript.finalize("completed");
    transcript.finalize("completed again");
    assert.equal(entries.filter((entry) => entry.phase === "done").length, 1);
  });

  it("writes nothing at all when the switch is off", () => {
    const before = process.env.SUBAGENT_TRANSCRIPT;
    process.env.SUBAGENT_TRANSCRIPT = "0";
    try {
      const { pi, entries } = recorder();
      const transcript = new AgentTranscript(pi, "abcdef1234", "explore");
      transcript.brief("do the thing");
      transcript.finalize("completed");
      assert.equal(entries.length, 0);
    } finally {
      if (before === undefined) delete process.env.SUBAGENT_TRANSCRIPT;
      else process.env.SUBAGENT_TRANSCRIPT = before;
    }
  });
});

describe("the stream, driven the way a real turn drives it", () => {
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
    };
  }

  it("closes one entry per TURN, not one per line", () => {
    const { pi, entries } = recorder();
    const transcript = new AgentTranscript(pi, "abcdef1234", "explore");
    const session = fakeSession([
      { role: "user", content: "find the call sites" },
      { role: "assistant", content: [{ type: "text", text: "line one\nline two\nline three" }] },
    ]);
    transcript.setCleanup(
      streamAgentOutput(session as never, transcript.sink, undefined, 0, transcript.endTurn),
    );
    session.turnEnd();
    session.messages.push({ role: "assistant", content: [{ type: "text", text: "and the answer" }] });
    session.turnEnd();
    transcript.finalize("explore completed");

    const turns = entries.filter((entry) => entry.phase === "turn");
    assert.equal(turns.length, 2);
    assert.deepEqual(
      turns.map((entry) => entry.turn),
      [1, 2],
    );
    // Three formatted lines from one message, in ONE entry.
    assert.equal(turns[0].lines.length, 3);
    assert.ok(turns[0].lines.every((line) => line.includes("[ASSISTANT]")));
    assert.match(turns[1].lines.join("\n"), /and the answer/);
  });

  it("a turn that produced nothing writes no entry", () => {
    const { pi, entries } = recorder();
    const transcript = new AgentTranscript(pi, "abcdef1234", "explore");
    const session = fakeSession([{ role: "user", content: "x" }]);
    transcript.setCleanup(
      streamAgentOutput(session as never, transcript.sink, undefined, 0, transcript.endTurn),
    );
    session.turnEnd();
    assert.equal(entries.filter((entry) => entry.phase === "turn").length, 0);
  });

  it("dispose drops the subscription without writing an ending", () => {
    const { pi, entries } = recorder();
    const transcript = new AgentTranscript(pi, "abcdef1234", "explore");
    const session = fakeSession([
      { role: "assistant", content: [{ type: "text", text: "half a thought" }] },
    ]);
    transcript.setCleanup(
      streamAgentOutput(session as never, transcript.sink, undefined, 0, transcript.endTurn),
    );
    transcript.dispose();
    session.turnEnd();
    assert.equal(entries.length, 0);
  });
});
