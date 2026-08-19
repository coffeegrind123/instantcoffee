/**
 * n3 — AA3. `ctx.hasPendingMessages()` cannot see a message an extension queued.
 *
 * The loop asks it nine times. Seven of them are `agent_end` exits of the form
 * `if (!ctx.hasPendingMessages()) scheduleLoopTurn(…)` — "a turn is already
 * coming, don't schedule a second one". One is the watchdog's re-arm. The last is
 * the branch V4 added and Z4 repaired, whose comment names the case it exists for:
 *
 *   "with a message pending (the ordinary state while a background subagent's
 *    result is queued)"          extensions/index.ts, interveneStuck
 *
 * pi answers that question from two arrays:
 *
 *   get pendingMessageCount()                 agent-session.js:1151
 *       return this._steeringMessages.length + this._followUpMessages.length;
 *
 * and there are exactly two writers of those arrays — `_queueSteer` (:1016) and
 * `_queueFollowUp` (:1032) — reachable only from `AgentSession.prompt()` while
 * streaming (:836/:839), `AgentSession.steer()`/`.followUp()` (:994/:1011), and
 * `sendUserMessage()`, which is `prompt()` again.
 *
 * `sendCustomMessage` — which is what `pi.sendMessage` calls, and therefore the
 * only route an extension has — goes straight past them to the AGENT's queues:
 *
 *   else if (this.isStreaming && options?.triggerTurn !== false)   :1081
 *       if (deliverAs === "followUp") this.agent.followUp(appMessage);   :1083
 *       else                          this.agent.steer(appMessage);      :1086
 *
 * `agent.steer()` pushes onto `Agent.steeringQueue`, which `pendingMessageCount`
 * does not read. So a background subagent's result — the case the comment
 * names — leaves `hasPendingMessages()` false, and the only thing that can make
 * it true is a HUMAN typing into a session that is already streaming.
 *
 *   node --experimental-strip-types n3-the-pending-messages-nobody-can-see.mjs
 */

import { readFileSync } from "node:fs";

const PI = "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist";
const REPO = "/home/claudeuser/qwen3.8-forge";

// ── part 1: every writer of the two arrays pendingMessageCount reads ─────────

const session = readFileSync(`${PI}/core/agent-session.js`, "utf8").split("\n");

const writers = [];
session.forEach((line, i) => {
  if (/_steeringMessages\.push|_followUpMessages\.push/.test(line)) writers.push({ line: i + 1, text: line.trim() });
});

const callers = [];
session.forEach((line, i) => {
  if (/_queueSteer\(|_queueFollowUp\(/.test(line) && !/async _queue/.test(line)) {
    callers.push({ line: i + 1, text: line.trim() });
  }
});

console.log("=".repeat(80));
console.log("pi 0.84.2 — who can make ctx.hasPendingMessages() true");
console.log("=".repeat(80));
console.log("\n  pendingMessageCount reads two arrays. Every push into them:");
for (const w of writers) console.log(`    agent-session.js:${w.line}  ${w.text}`);
console.log("\n  and every call to the two functions that do those pushes:");
for (const c of callers) console.log(`    agent-session.js:${c.line}  ${c.text}`);

const inSendCustom = session
  .slice(1067, 1096)
  .map((l, i) => `    ${1068 + i}  ${l.replace(/^ {4}/, "")}`)
  .join("\n");
console.log("\n  and what sendCustomMessage — the only route pi.sendMessage has — does:\n");
console.log(inSendCustom);
console.log("\n  agent.steer / agent.followUp are Agent's own queues. Neither array above");
console.log("  is touched, so pendingMessageCount stays 0.\n");

// ── part 2: the loop's nine questions ──────────────────────────────────────

const loop = readFileSync(`${REPO}/vendor/pi-loop-mode/extensions/index.ts`, "utf8").split("\n");
const asks = [];
loop.forEach((line, i) => {
  const text = line.trim();
  if (text.startsWith("//") || text.startsWith("*")) return; // prose, not a call
  if (text.includes("hasPendingMessages()")) asks.push({ line: i + 1, text });
});

console.log("=".repeat(80));
console.log("vendor/pi-loop-mode — where the answer is used");
console.log("=".repeat(80));
for (const a of asks) console.log(`  extensions/index.ts:${String(a.line).padEnd(5)} ${a.text.slice(0, 62)}`);
console.log(`\n  ${asks.length} call sites.\n`);

// ── part 3: the two ways a message can be waiting, side by side ─────────────

/**
 * The three queues and the one counter, as agent-session.js implements them.
 * `sessionSteering`/`sessionFollowUp` are the arrays pendingMessageCount reads;
 * `agentSteering`/`agentFollowUp` are Agent's, which it does not.
 */
function queues() {
  const sessionSteering = [];
  const sessionFollowUp = [];
  const agentSteering = [];
  const agentFollowUp = [];
  return {
    /** AgentSession.prompt() while streaming — a human typing. :836/:839 */
    operatorTypes(text, mode = "steer") {
      (mode === "followUp" ? sessionFollowUp : sessionSteering).push(text); // :1017/:1033
      (mode === "followUp" ? agentFollowUp : agentSteering).push(text); // the agent gets it too
    },
    /** pi.sendMessage → sendCustomMessage while streaming. :1081 */
    extensionSends(text, deliverAs = "steer") {
      (deliverAs === "followUp" ? agentFollowUp : agentSteering).push(text); // :1083/:1086
    },
    hasPendingMessages: () => sessionSteering.length + sessionFollowUp.length > 0, // :1151
    agentHasQueued: () => agentSteering.length + agentFollowUp.length > 0,
  };
}

const rows = [
  ["a human types while the agent is streaming", (q) => q.operatorTypes("what's the status?")],
  ["a background subagent's result is delivered", (q) => q.extensionSends("[Subagent \"Explore\" …]", "steer")],
  ["the loop queues its stuck directive (Z4's fix)", (q) => q.extensionSends("stuck directive", "steer")],
  ["the loop delivers a turn while the parent is busy", (q) => q.extensionSends("loop turn", "followUp")],
];

console.log("=".repeat(80));
console.log("who is actually waiting, and who ctx.hasPendingMessages() says is waiting");
console.log("=".repeat(80));
console.log(`  ${"a message is queued by…".padEnd(48)} agent queue  hasPendingMessages()`);
console.log("  " + "-".repeat(76));
for (const [label, act] of rows) {
  const q = queues();
  act(q);
  console.log(
    `  ${label.padEnd(48)} ${String(q.agentHasQueued()).padEnd(12)} ${q.hasPendingMessages()}`,
  );
}

console.log(`
  Only the first row can answer true, and it is the only row that needs a human.
  Every other row is a real message that will really cause a turn, and the loop
  is told there is nothing pending.

  What that costs is not damage in the unattended case — with the answer always
  false the loop schedules its own turn, which is right — it is that V4's branch
  and Z4's repair of it are both about a state an unattended run cannot enter,
  while the premise written above them names the one delivery that never
  produces it.
`);

process.exit(0);
