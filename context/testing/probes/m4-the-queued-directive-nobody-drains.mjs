/**
 * m4 — Z4. The stuck directive V4 queues is delivered only when the OPERATOR
 * types something.
 *
 * V4's fix: with a message already pending, `interveneStuck` queues the rotating
 * strategy with `deliverAs: "nextTurn"` instead of scheduling a second turn.
 * `j4` and `stuck-ladder.test.ts` both assert that, and both stop at the
 * `pi.sendMessage` boundary.
 *
 * On the far side of it, pi 0.84.2 has exactly ONE drain for
 * `_pendingNextTurnMessages`:
 *
 *   AgentSession.prompt()            agent-session.js:880   ← operator-typed
 *       messages.push({role:"user", …})
 *       for (const msg of this._pendingNextTurnMessages) messages.push(msg)
 *
 * and the three routes the loop itself can take are not it:
 *
 *   sendCustomMessage  :1079  deliverAs "nextTurn"  → push, no turn, no drain
 *                      :1089  triggerTurn           → _runAgentPrompt, no drain
 *   _handlePostAgentRun :781  hasQueuedMessages()   → agent.continue()
 *   Agent.continue     agent.js:236  drains the STEERING queue, not this one
 *
 * So this probe models the delivery side the way pi implements it and asks the
 * only question that matters: did the model ever see the directive?
 *
 *   node --experimental-strip-types m4-the-queued-directive-nobody-drains.mjs
 */

const { makeHost } = await import("./_host.mjs");
const loopExtension = (await import("../../../vendor/pi-loop-mode/extensions/index.ts")).default;

/**
 * pi's three delivery queues and their drain sites, as `sendCustomMessage`
 * implements them. Only `operatorTypes()` drains the nextTurn queue, because
 * only `AgentSession.prompt()` does.
 */
function deliveryModel() {
  const nextTurn = [];
  const steering = [];
  const followUp = [];
  const delivered = [];
  return {
    send(message, options = {}) {
      if (options.deliverAs === "nextTurn") return void nextTurn.push(message);
      // agent_end runs while _isAgentRunActive is still true, so this is the
      // streaming branch: the message goes to a queue, not to a turn.
      if (options.deliverAs === "followUp") return void followUp.push(message);
      if (options.deliverAs === "steer") return void steering.push(message);
      if (options.triggerTurn) return void delivered.push(message);
    },
    /** _handlePostAgentRun → agent.continue(): drains steering, then follow-ups. */
    endOfRun() {
      if (steering.length === 0 && followUp.length === 0) return;
      delivered.push(...steering.splice(0), ...followUp.splice(0));
    },
    operatorTypes() {
      delivered.push(...nextTurn.splice(0));
    },
    queued: () => nextTurn.length,
    kinds: () => delivered.map((m) => m.details?.kind ?? "?"),
  };
}

const pi = deliveryModel();
const host = makeHost();
// The ordinary state while a background subagent's result is queued — which is
// the shape V4 exists for.
host.ctx.hasPendingMessages = () => true;
const realSend = host.pi.sendMessage;
host.pi.sendMessage = (message, options) => {
  realSend(message, options);
  pi.send(message, options);
};
loopExtension(host.pi);

await host.run("start keep the docs in step with the code");
pi.endOfRun();

const SAME = "Everything already looks correct; I will keep monitoring the documentation for drift.";
console.log("a repeating model, with a message already pending on every turn\n");
console.log("  turn  notice                                                    the model received");
console.log("  " + "-".repeat(92));
for (let i = 1; i <= 3; i++) {
  const before = pi.kinds().length;
  const notice = await host.turn({ messages: [SAME] });
  pi.endOfRun();
  const got = pi.kinds().slice(before);
  console.log(`  ${String(i).padEnd(5)} ${notice.slice(0, 57).padEnd(58)} ${got.length ? got.join(",") : "NOTHING"}`);
}
await host.quit();

console.log(`
  still queued for an operator prompt : ${pi.queued()}`);
console.log(`  everything the model ever received : ${pi.kinds().join(", ") || "(nothing)"}`);
console.log(`
BEFORE   turn 2  "Loop stuck (1x): assistant repeated…"        NOTHING
         turn 3  "Loop stuck (2x): assistant repeated…"        NOTHING
         still queued for an operator prompt : 2

         Every rung was charged — the streak, the intervention count, three turns
         of sampling penalties, turnsWithoutTools back to zero — and the operator
         was told "injecting new strategy" twice. An unattended loop never types
         anything, so the directives sat in _pendingNextTurnMessages for the rest
         of the session, invisible to the model AND to the operator.

NOW      the directive is queued as a steer, which _handlePostAgentRun drains
         onto the same turn as the message that was already pending.`);
