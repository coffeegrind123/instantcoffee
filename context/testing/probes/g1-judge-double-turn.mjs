/**
 * G1 probe — does maxTurns:1 make the judge run a second model call, and is the
 * verdict then read from the WRONG message?
 *
 * Code under test: the real `continueAgentSession` from
 * vendor/pi-subagents-lite/src/agents/agent-runner.ts (which is exactly what
 * runAgent's runSessionPrompt does, minus session construction).
 *
 * The fake session mirrors pi-agent-core's agent-loop.js lines 83-170 verbatim
 * in shape:
 *   83   pendingMessages = await getSteeringMessages()
 *   88   while (hasMoreToolCalls || pendingMessages.length > 0)
 *   95-102  inject pending messages: emit message_start / message_end each
 *   105  stream the assistant response
 *   131  emit turn_end
 *   160  pendingMessages = await getSteeringMessages()      <-- drains the steer
 * and agent-session.js:298 `_emit` calls every subscriber SYNCHRONOUSLY, so a
 * steer queued from a turn_end subscriber is in the queue by line 160.
 */

import { createJiti } from "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";

const PI = "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
const jiti = createJiti(`file://${PI}`, {
  interopDefault: true,
  alias: { "@earendil-works/pi-coding-agent": PI },
});

const REPO = "/home/claudeuser/qwen3.8-forge";
const runner = await jiti.import(`${REPO}/vendor/pi-subagents-lite/src/agents/agent-runner.ts`);
const verify = await jiti.import(`${REPO}/vendor/pi-subagents-lite/src/agents/verify.ts`);

/** A session that replays pi's agent loop faithfully enough for turn accounting. */
function makeSession(scriptedAssistantTexts) {
  const listeners = [];
  const steeringQueue = [];
  const messages = [];
  const calls = [];

  const emit = async (event) => {
    for (const l of listeners) l(event); // agent-session.js:298 — synchronous
  };

  return {
    messages,
    calls,
    isStreaming: false,
    model: { provider: "forge", id: "qwen3.8-27b" },
    subscribe(listener) {
      listeners.push(listener);
      return () => {
        const i = listeners.indexOf(listener);
        if (i !== -1) listeners.splice(i, 1);
      };
    },
    async steer(text) {
      steeringQueue.push(text); // AgentSession._queueSteer -> agent.steer, synchronous push
    },
    async abort() {},
    getSessionStats() {
      return { tokens: { input: 0, output: 0, cacheWrite: 0 }, contextUsage: { percent: 10 } };
    },
    async prompt(text) {
      // The user prompt itself
      messages.push({ role: "user", content: [{ type: "text", text }] });

      let pending = steeringQueue.splice(0);
      let hasMoreToolCalls = true;
      for (;;) {
        while (hasMoreToolCalls || pending.length > 0) {
          for (const m of pending) {
            const msg = { role: "user", content: [{ type: "text", text: m }] };
            await emit({ type: "message_start", message: msg });
            await emit({ type: "message_end", message: msg });
            messages.push(msg);
          }
          pending = [];

          // --- stream one assistant response ---
          const body = scriptedAssistantTexts[calls.length] ?? "(no script left)";
          calls.push(body);
          const assistant = { role: "assistant", content: [{ type: "text", text: body }], stopReason: "stop" };
          await emit({ type: "message_start", message: assistant });
          await emit({
            type: "message_update",
            message: assistant,
            assistantMessageEvent: { type: "text_delta", delta: body },
          });
          await emit({ type: "message_end", message: assistant });
          messages.push(assistant);

          hasMoreToolCalls = false; // the judge has no tools
          await emit({ type: "turn_end", message: assistant, toolResults: [] });
          pending = steeringQueue.splice(0); // agent-loop.js:160
        }
        break; // no follow-up queue in this probe
      }
      await emit({ type: "agent_end", messages });
    },
  };
}

// --- The judge, exactly as buildVerifyDeps configures it -------------------
const JUDGE_TURN_1 = "VERDICT: NOT_ADDRESSED\nWHY: the answer summarises a different file.";
const JUDGE_TURN_2 = "I have already given my final answer above.";

const session = makeSession([JUDGE_TURN_1, JUDGE_TURN_2]);
const result = await runner.continueAgentSession(session, "…judge prompt…", { maxTurns: 1 });

console.log("model calls made by a maxTurns:1 run :", session.calls.length);
console.log("responseText handed back            :", JSON.stringify(result.responseText));
console.log("turnLimited                         :", result.turnLimited);
console.log("the steer pi injected               :",
  JSON.stringify(session.messages.filter((m) => m.role === "user").map((m) => m.content[0].text)));

const verdict = verify.parseJudgeVerdict(result.responseText);
console.log("parseJudgeVerdict(responseText)     :", JSON.stringify(verdict));
console.log("parseJudgeVerdict(turn 1, the real one):", JSON.stringify(verify.parseJudgeVerdict(JUDGE_TURN_1)));

console.log("");
console.log("EXPECTED IF THE BUG IS REAL: 2 calls, responseText = turn 2,");
console.log("verdict addressed=true unparsed=true  (a NOT_ADDRESSED verdict read as a pass).");

// --- Control: maxTurns 0 (unlimited) must NOT produce the extra turn -------
const control = makeSession([JUDGE_TURN_1, JUDGE_TURN_2]);
const controlResult = await runner.continueAgentSession(control, "…judge prompt…", { maxTurns: 0 });
console.log("");
console.log("CONTROL (maxTurns:0, no soft-limit steer):");
console.log("  model calls  :", control.calls.length);
console.log("  responseText :", JSON.stringify(controlResult.responseText));
