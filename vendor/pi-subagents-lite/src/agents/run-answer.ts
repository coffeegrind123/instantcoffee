/**
 * run-answer.ts — Forge fork. What a subagent RUN said, as opposed to what its
 * last message said.
 *
 * Lifted out of `agent-runner.ts` for the reason `turn-tracking.ts`,
 * `record-activity.ts` and `verify.ts` were: that file imports
 * `@earendil-works/pi-coding-agent`, which does not resolve under the plain
 * `node --experimental-strip-types --test` the suite runs on, so nothing in it
 * could be tested. This module imports one thing — the content extractor the
 * rest of the package already uses, by its `.ts` specifier — and duck-types the
 * session.
 */

import { extractText } from "../prompt/context.ts";

/** The slice of AgentSession this needs. Duck-typed so the module stays loadable. */
export interface AnswerTrackedSession {
  subscribe(listener: (event: AnswerEvent) => void): () => void;
}

/** The slice of AgentSessionEvent this reads. */
export type AnswerEvent =
  | { type: "message_start" }
  | { type: "message_update"; assistantMessageEvent: { type: string; delta?: string } }
  | { type: "message_end"; message: { role: string; content: unknown } }
  | { type: string };

/**
 * What this run said, per MESSAGE, in order.
 *
 * Forge fork: this used to keep ONE string, reset on every `message_start`, and
 * `runTurnLoop` returned it — so what the parent, the verifier and the
 * completion gate all received was the LAST MESSAGE of the run rather than its
 * ANSWER. That is W1's distinction, on this side of the fence, in the reader the
 * eighth pass's write-up listed as "correct by construction" on the strength of
 * a fallback that only runs when this comes back empty.
 *
 * `message_start` fires for INJECTED user messages too — pi emits one for every
 * message it drains out of the steering queue (pi-agent-core `agent-loop.js`,
 * inside `while (hasMoreToolCalls || pendingMessages.length > 0)`) — and this
 * package injects two of them: the turn-limit steer, whose reply IS the answer,
 * and the task ANCHOR, whose reply is not. Measured against the shipped
 * `runSessionPrompt`: a child that answered and was then compacted handed its
 * parent "Understood — nothing further to add."
 *
 * Keeping one entry per message and taking the last non-empty one is the same
 * repair `turnAnswerTexts` is in `vendor/pi-loop-mode`, and it makes the empty
 * tail harmless: a reasoning-only final message contributes nothing and the
 * answer before it still wins. See Z1 in
 * `context/design/subagents-loop-verifier-answers.md`.
 */
export function collectResponseText(
  session: AnswerTrackedSession,
  onTextDelta?: (delta: string, fullText: string) => void,
) {
  /** Every message of THIS run that streamed text, in order. */
  const answers: string[] = [];
  /** The message being streamed right now. `onTextDelta` reports this one, live. */
  let text = "";
  /**
   * Every assistant message of THIS run, as pi finalized it.
   *
   * Forge fork: the fallback used to be `getLastAssistantText(session, index)`,
   * where `index` was `session.messages.length` taken before the prompt. pi does
   * not splice that array on a compaction, it REPLACES it
   * (`agent-session.js:1435` and `:1673`, `this.agent.state.messages =
   * sessionContext.messages`) with a shorter one rebuilt from the compacted
   * branch — so after a compaction the index points past the end and the
   * fallback returned "". Measured: a settled child whose final message was
   * reasoning-only came back as `""` and was reported to its parent as "The
   * agent returned no answer at all." Holding the messages themselves cannot
   * drift, and it scopes the fallback to this run by construction rather than by
   * arithmetic. See Z1.
   */
  const messages: { role: string; content: unknown }[] = [];
  const flush = () => {
    if (text.trim()) answers.push(text);
    text = "";
  };
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "message_start") {
      flush();
    }
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      const delta = String(event.assistantMessageEvent.delta ?? "");
      text += delta;
      onTextDelta?.(delta, text);
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      messages.push(event.message);
    }
  });
  return {
    /** The run's ANSWER: the last message of it that said anything. */
    getText: () => {
      flush();
      return answers.length > 0 ? answers[answers.length - 1] : "";
    },
    /** The same question against the finalized messages, for a run that streamed nothing. */
    getLastMessageText: () => {
      for (let i = messages.length - 1; i >= 0; i--) {
        const text = extractText(messages[i].content as unknown[]).trim();
        if (text) return text;
      }
      return "";
    },
    unsubscribe,
  };
}

