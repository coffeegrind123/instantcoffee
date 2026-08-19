/**
 * n4 — AA4. The background result's `deliverAs` was chosen by a ternary whose
 * other arm pi never reads.
 *
 * `SpawnCoordinator.emitIndividualNudge` used to pick the mode like this:
 *
 *   // - steer: queues while running, delivers before next LLM call
 *   // - followUp: waits for agent to finish, then delivers
 *   const parentIdle = ctx?.isIdle?.() ?? true;
 *   const deliverAs = parentIdle ? "followUp" : "steer";
 *   pi.sendMessage({…}, { deliverAs, triggerTurn: true });
 *
 * and `sendCustomMessage` reads `deliverAs` in exactly one branch:
 *
 *   if (deliverAs === "nextTurn")                       :1078   ← not us
 *   else if (this.isStreaming && triggerTurn !== false) :1081   ← reads it
 *   else if (triggerTurn) await _runAgentPrompt(msg)    :1089   ← ignores it
 *
 * `isStreaming` is `_isAgentRunActive`, and `isIdle` is `!_isAgentRunActive`
 * (agent-session.js:588 and :599) — exact complements. So `parentIdle === true`
 * is precisely the case that falls to :1089, where `deliverAs` is dropped on the
 * floor, and `parentIdle === false` is precisely the case that reads it, where
 * the ternary has already committed to `"steer"`.
 *
 * The mode was therefore not chosen. It was always `steer` when it was read at
 * all, and `steer` lands the result INSIDE the parent's running turn.
 *
 * Now that it is a real choice, it is made: `followUp`. Both queues drain inside
 * the SAME agent run and the same `agent_end` — `runLoop`'s outer while feeds
 * follow-ups back into the inner loop — so this does not change the turn shape
 * that W1, X1, X2 and X3 were each written to repair. It changes where in the
 * run the result lands: a steer is drained by the inner while, before the next
 * assistant response and therefore possibly mid-tool-chain; a follow-up by the
 * outer while, once the model has stopped calling tools.
 *
 *   node --experimental-strip-types n4-the-delivery-mode-that-is-never-read.mjs
 */

import { readFileSync } from "node:fs";

const PI = "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist";
const REPO = "/home/claudeuser/qwen3.8-forge";

// ── part 1: isIdle and isStreaming, out of pi ───────────────────────────────

const session = readFileSync(`${PI}/core/agent-session.js`, "utf8").split("\n");
const show = (needle, span = 3) => {
  const i = session.findIndex((l) => l.includes(needle));
  return session.slice(i, i + span).map((l, k) => `    ${i + 1 + k}  ${l.replace(/^ {4}/, "")}`).join("\n");
};

console.log("=".repeat(80));
console.log("pi 0.84.2 — isStreaming and isIdle are the same bit");
console.log("=".repeat(80));
console.log(show("get isStreaming()"));
console.log(show("get isIdle()"));

// ── part 2: the coordinator's choice, out of the tree ───────────────────────

const coord = readFileSync(`${REPO}/vendor/pi-subagents-lite/src/spawn/spawn-coordinator.ts`, "utf8").split("\n");
const start = coord.findIndex((l) => l.includes("const deliverAs ="));
console.log("\n" + "=".repeat(80));
console.log("vendor/pi-subagents-lite — what the mode is now");
console.log("=".repeat(80));
console.log(coord.slice(start, start + 2).map((l, k) => `  ${start + 1 + k}  ${l.trim()}`).join("\n"));

// ── part 3: the truth table ─────────────────────────────────────────────────

/** sendCustomMessage's routing, verbatim from :1078–:1091. */
function route(isStreaming, options) {
  if (options.deliverAs === "nextTurn") return { queue: "_pendingNextTurnMessages", usedDeliverAs: true };
  if (isStreaming && options.triggerTurn !== false) {
    return options.deliverAs === "followUp"
      ? { queue: "agent.followUpQueue", usedDeliverAs: true }
      : { queue: "agent.steeringQueue  (INSIDE the running turn)", usedDeliverAs: true };
  }
  if (options.triggerTurn) return { queue: "_runAgentPrompt  (a whole new run)", usedDeliverAs: false };
  return { queue: "appended, no turn", usedDeliverAs: false };
}

console.log("\n" + "=".repeat(80));
console.log("what the coordinator asks for, and where the message actually goes");
console.log("=".repeat(80));
console.log(`  ${"".padEnd(7)} ${"parent".padEnd(6)} ${"deliverAs".padEnd(10)} ${"where it lands".padEnd(40)} read?`);
console.log("  " + "-".repeat(78));
for (const parentIdle of [true, false]) {
  for (const [label, deliverAs] of [["BEFORE", parentIdle ? "followUp" : "steer"], ["NOW", "followUp"]]) {
    const landed = route(!parentIdle, { deliverAs, triggerTurn: true });
    console.log(
      `  ${label.padEnd(7)} ${(parentIdle ? "idle" : "busy").padEnd(6)} ${deliverAs.padEnd(10)} ` +
        `${landed.queue.padEnd(40)} ${landed.usedDeliverAs ? "yes" : "NO"}`,
    );
  }
}

console.log(
  [
    "",
    '  BEFORE, the "followUp" arm existed only for the state in which pi does not',
    "  look at it, so every delivery pi DID look at was a steer — the ternary could",
    "  not produce its own other branch.",
    "",
    "  NOW the busy row lands on the follow-up queue, which the agent loop drains in",
    "  its OUTER while: after the model has stopped calling tools, rather than before",
    "  its next assistant response. The idle row is unchanged and always was —",
    "  _runAgentPrompt discards the value either way.",
    "",
    "  What this does NOT do is retire the two-message turn. Both queues drain inside",
    "  the same agent run and the same agent_end (pi-agent-core agent-loop.js: the",
    "  outer while sets follow-ups as pendingMessages and continues), so W1, X1, X2",
    "  and X3 are all still load-bearing. What it changes is the injection POINT: a",
    "  background result no longer interrupts a tool chain the parent is halfway",
    "  through, for at most one turn of latency on a result the parent chose not to",
    "  block on.",
    "",
  ].join("\n"),
);

process.exit(0);
