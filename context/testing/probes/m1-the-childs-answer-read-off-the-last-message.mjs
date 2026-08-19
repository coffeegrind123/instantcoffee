/**
 * m1 — Z1. What a subagent hands back is the LAST message it streamed, not the
 * turn's answer.
 *
 * `runTurnLoop` (agent-runner.ts:652) returns
 *
 *     collector.getText().trim() || getLastAssistantText(session, messageStart)
 *
 * and `collectResponseText` resets its buffer on EVERY `message_start`,
 * including the one belonging to a user message injected mid-run. The eighth
 * pass's §2.2 lists this reader as taking the turn's ANSWER, "correct by
 * construction", on the strength of the fallback walking back to text. The
 * fallback only runs when the collector came back EMPTY.
 *
 * Two things inject a user message into a child's own run:
 *
 *   · the task ANCHOR — `AgentManager.runTrackingCallbacks.onCompaction` calls
 *     `session.steer(buildAnchorMessage(brief))` on every compaction, and pi's
 *     loop drains a queued steer and keeps going (the same mechanism
 *     turn-tracking.ts's header measured for the turn-limit steer);
 *   · the turn-limit steer itself.
 *
 * So a child that answers and is then compacted hands its parent the reply to
 * the anchor. This drives the REAL `continueAgentSession` — the shipped
 * `runSessionPrompt` / `runTurnLoop` — with a session stub that emits the event
 * sequence pi emits.
 *
 *   run: node m1-the-childs-answer-read-off-the-last-message.mjs
 */

import { createJiti } from "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";
const PI = "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
const jiti = createJiti(`file://${PI}`, { interopDefault: true, alias: { "@earendil-works/pi-coding-agent": PI } });
const R = "/home/claudeuser/qwen3.8-forge/vendor/pi-subagents-lite/src";

const { continueAgentSession } = await jiti.import(`${R}/agents/agent-runner.ts`);

const ANSWER = "src/parser.ts:41 and src/lexer.ts:9 both call tokenize() directly.";
const ANCHOR_REPLY = "Understood — nothing further to add.";

const text = (t) => ({ role: "assistant", content: [{ type: "text", text: t }], stopReason: "stop" });
const thinking = (t) => ({ role: "assistant", content: [{ type: "thinking", thinking: t }], stopReason: "stop" });
const user = (t) => ({ role: "user", content: [{ type: "text", text: t }] });

/**
 * A session that behaves the way pi's does for the three things this reader
 * touches: message_start resets the stream buffer, `messages` is REPLACED (not
 * spliced) by a compaction, and a queued steer keeps the agent loop going.
 *
 * @param opts.priorMessages  what the session already held before this prompt
 * @param opts.compact        replay a compaction after the answer
 * @param opts.tail           "anchor-reply" | "reasoning-only" | "none"
 */
function makeSession({ priorMessages = 0, compact = false, tail = "none" }) {
  const subs = new Set();
  const emit = (event) => { for (const fn of [...subs]) fn(event); };
  const session = {
    messages: Array.from({ length: priorMessages }, (_, i) => text(`older run message ${i + 1}`)),
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    async steer() {},
    async abort() {},
    async prompt(prompt) {
      session.messages.push(user(prompt));
      emit({ type: "message_start", message: { role: "user" } });

      // --- the child answers, streamed ---
      emit({ type: "message_start", message: { role: "assistant" } });
      for (const delta of [ANSWER.slice(0, 20), ANSWER.slice(20)]) {
        emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta } });
      }
      const answer = text(ANSWER);
      session.messages.push(answer);
      emit({ type: "message_end", message: answer });
      emit({ type: "turn_end" });

      if (compact) {
        // pi: `this.agent.state.messages = sessionContext.messages` — a NEW,
        // shorter array built from the compacted branch (agent-session.js:1435
        // and :1673). Every index taken before it now means something else.
        session.messages = [user("[summary of the conversation so far]"), answer];
        // …and the manager steers the task anchor in from onCompaction.
      }

      if (tail === "none") return;

      // The anchor arrives as a USER message: the collector resets here.
      emit({ type: "message_start", message: { role: "user" } });
      session.messages.push(user("[task anchor — the context was just compacted…]"));

      emit({ type: "message_start", message: { role: "assistant" } });
      if (tail === "anchor-reply") {
        emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: ANCHOR_REPLY } });
        session.messages.push(text(ANCHOR_REPLY));
      } else {
        // reasoning-only: no text_delta at all (forge_reasoning_passthrough.py,
        // 2026-08-17 — the shape V1/W1/X1 are all downstream of).
        session.messages.push(thinking("already answered above; nothing to do"));
      }
      emit({ type: "message_end", message: session.messages[session.messages.length - 1] });
      emit({ type: "turn_end" });
    },
  };
  return session;
}

async function run(label, opts) {
  const session = makeSession(opts);
  const result = await continueAgentSession(session, "List every caller of tokenize().", {
    maxTurns: 40,
    graceTurns: 2,
  });
  const got = result.responseText;
  const verdict = got === ANSWER ? "the ANSWER" : got === "" ? "NOTHING" : "NOT the answer";
  console.log(`  ${label.padEnd(52)} ${verdict}`);
  console.log(`      -> ${JSON.stringify(got.slice(0, 70))}`);
}

console.log("what the parent, the verifier and the completion gate receive:\n");
console.log("control — the child answers and stops");
await run("no compaction, no injected message", { priorMessages: 6 });

console.log("\nan injected message and a reply to it — this is what Z2 removes, not Z1");
await run("the child acknowledges the anchor", { priorMessages: 6, compact: true, tail: "anchor-reply" });

console.log("\nZ1 — the same turn with a reasoning-only reply, so the FALLBACK runs");
await run("compaction shrank session.messages", { priorMessages: 6, compact: true, tail: "reasoning-only" });
await run("control — same turn, no compaction", { priorMessages: 6, compact: false, tail: "reasoning-only" });
await run("control — first run (messageStart = 0)", { priorMessages: 0, compact: true, tail: "reasoning-only" });

console.log(`
BEFORE   row 2  "Understood — nothing further to add."   ← the reply to the anchor
         row 3  ""                                       ← messageStart indexed
                                                            into an array pi had
                                                            replaced, so the
                                                            fallback found nothing
         row 3 is what the verifier's structural gate reports to the parent as
         "The agent returned no answer at all."

NOW      rows 3, 4 and 5 all return the answer: one entry per message, last
         non-empty wins, and the fallback holds the messages themselves rather
         than an index into a list pi rebuilds on every compaction.

         Row 2 is deliberately still wrong here, and it is the control for the
         OTHER half: no reader can tell an acknowledgement from an answer. It is
         fixed at the writer — the anchor no longer manufactures that turn. See
         m2 and Z2.`);
