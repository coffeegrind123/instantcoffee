/**
 * Z1 — what a subagent hands back is the RUN's answer, not its last message.
 *
 * `runTurnLoop` returns `collector.getText().trim() || <the fallback>`, and
 * `collectResponseText` reset its single buffer on every `message_start`. pi
 * emits one of those for every message it drains out of the steering queue
 * (pi-agent-core `agent-loop.js`, inside `while (hasMoreToolCalls ||
 * pendingMessages.length > 0)`), and this package injects two kinds: the
 * turn-limit steer, whose reply IS the answer, and the task ANCHOR, whose reply
 * is not. So a child that answered and was then compacted handed its parent
 * "Understood — nothing further to add."
 *
 * The fallback did not save it, and could not: it was
 * `getLastAssistantText(session, messageStart)` with `messageStart` taken as
 * `session.messages.length` before the prompt. pi does not splice that array on
 * a compaction, it REPLACES it (`agent-session.js:1435`, `:1673`) with a shorter
 * one rebuilt from the compacted branch — so the index pointed past the end and
 * the fallback returned `""`, which the verifier's structural gate reports to
 * the parent as "The agent returned no answer at all."
 *
 * The eighth pass's §2.2 listed this reader as taking the turn's ANSWER,
 * "correct by construction". It took the last message.
 *
 * One entry per message, last non-empty wins — the same repair `turnAnswerTexts`
 * is in `vendor/pi-loop-mode`, and the same one W1/X1 made there.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { collectResponseText } from "../src/agents/run-answer.ts";

const ANSWER = "src/parser.ts:41 and src/lexer.ts:9 both call tokenize() directly.";

function fakeSession() {
  const subs = new Set<(event: unknown) => void>();
  return {
    session: { subscribe: (fn: (event: unknown) => void) => (subs.add(fn), () => subs.delete(fn)) },
    emit: (event: unknown) => {
      for (const fn of [...subs]) fn(event);
    },
  };
}

/** One assistant message that streams `text`, then finalizes. */
function streamed(emit: (event: unknown) => void, text: string) {
  emit({ type: "message_start", message: { role: "assistant" } });
  if (text) emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } });
  emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }] } });
}

/** A reasoning-only message: thinking deltas are not text deltas, so nothing streams. */
function reasoningOnly(emit: (event: unknown) => void, thought: string) {
  emit({ type: "message_start", message: { role: "assistant" } });
  emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: thought } });
  emit({ type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: thought }] } });
}

describe("Z1 — the run's answer, not its last message", () => {
  it("an injected instruction and its reply do not replace the answer", () => {
    const { session, emit } = fakeSession();
    const collector = collectResponseText(session);

    streamed(emit, ANSWER);
    // The task anchor, drained out of the steering queue as a user message.
    emit({ type: "message_start", message: { role: "user" } });
    // …and a reply that says nothing new. Before the fix this WAS the answer.
    streamed(emit, "");

    collector.unsubscribe();
    assert.equal(collector.getText(), ANSWER);
  });

  it("a reasoning-only final message leaves the answer standing", () => {
    const { session, emit } = fakeSession();
    const collector = collectResponseText(session);

    streamed(emit, ANSWER);
    reasoningOnly(emit, "already answered above; nothing to do");

    collector.unsubscribe();
    assert.equal(collector.getText(), ANSWER);
  });

  it("control — the last message IS the answer when the run ends on one", () => {
    const { session, emit } = fakeSession();
    const collector = collectResponseText(session);

    streamed(emit, "a first pass at it");
    // The turn-limit steer: here the reply to the injected message is the answer,
    // and it must still win. That is the case V6 is about.
    emit({ type: "message_start", message: { role: "user" } });
    streamed(emit, ANSWER);

    collector.unsubscribe();
    assert.equal(collector.getText(), ANSWER);
  });

  it("control — a run that said nothing at all returns nothing", () => {
    const { session, emit } = fakeSession();
    const collector = collectResponseText(session);
    reasoningOnly(emit, "thinking, and nothing else");
    collector.unsubscribe();
    assert.equal(collector.getText(), "");
  });

  it("onTextDelta still reports the message being streamed, live", () => {
    const { session, emit } = fakeSession();
    const seen: string[] = [];
    const collector = collectResponseText(session, (_delta, full) => seen.push(full));

    emit({ type: "message_start", message: { role: "assistant" } });
    emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "part " } });
    emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "two" } });
    collector.unsubscribe();

    assert.deepEqual(seen, ["part ", "part two"], "the live view still sees one message at a time");
  });
});

describe("Z1 — the fallback is scoped by identity, not by an index", () => {
  it("survives the array pi builds on a compaction", () => {
    const { session, emit } = fakeSession();
    const collector = collectResponseText(session);

    // Nothing streams — the provider delivered the message without text deltas.
    emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: ANSWER }] } });
    // pi compacts: `this.agent.state.messages = sessionContext.messages`. The old
    // fallback indexed into that array and came back empty.
    emit({ type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: "…" }] } });

    collector.unsubscribe();
    assert.equal(collector.getText(), "", "the stream really was empty");
    assert.equal(collector.getLastMessageText(), ANSWER, "and the fallback finds the answer anyway");
  });

  it("control — the fallback sees only THIS run's messages", () => {
    const { session, emit } = fakeSession();
    // A session that already holds an earlier run's answer: the collector never
    // saw those message_end events, so it cannot resurrect them.
    const collector = collectResponseText(session);
    collector.unsubscribe();
    assert.equal(collector.getLastMessageText(), "");
    void emit;
  });
});
