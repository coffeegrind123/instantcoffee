/**
 * l5 — X4. The per-turn tool counter was reset in one place, and it was not one
 * of the places a turn can end.
 *
 * T2 established that `state.toolCallsThisTurn` outliving its turn switches off
 * the starvation rung: `emptyResponse` requires the count to be zero and
 * `isContextPressure`'s starvation rung requires `emptyResponse`. Its fix moved
 * the reset to the TOP of `agent_end`, above every early return in that handler.
 *
 * Every early return in that handler. `/loop stop` sets `state.active = false`,
 * and `agent_end`'s FIRST line returns when the loop is not active — so a loop
 * stopped in the middle of a tool-using turn keeps the count, and `/loop resume`
 * does not clear it either. The stop is the advertised operator action ("Loop
 * stopped. Use /loop resume to continue"), and the `loop` tool gives the model
 * the same verb.
 *
 * The module-global buffers next to it — `turnAssistantTexts`, `turnToolCalls`,
 * `turnAnswerTexts` — were already dropped by `/loop stop`, `/loop end`,
 * `runLoop`, `finalizeSoftStop`, `session_start` and `session_shutdown`, through
 * `resetTurnBuffers()`. The counter is the same per-turn state and was not in it.
 *
 * FIXED: it is in `resetTurnBuffers()`, so there is one call site to find; and
 * `session_start` now calls that AFTER `restoreState`, because a persist taken
 * mid-turn carries the count into the next session.
 *
 *   run: node --experimental-strip-types l5-tool-counter-survives-a-stop.mjs
 */

import { makeHost } from "./_host.mjs";
import loopMode from "/home/claudeuser/qwen3.8-forge/vendor/pi-loop-mode/extensions/index.ts";

const thought = (t) => ({ role: "assistant", content: [{ type: "thinking", thinking: t }], stopReason: "stop", usage: { output: 126 } });

// 90%: above CONTEXT_STARVATION_PERCENT, which is where the rung lives.
const host = makeHost({ percent: 90 });
loopMode(host.pi);

async function starvedTurn() {
  const messages = [thought("I am not sure what to do here and the window is nearly full")];
  host.notices.length = 0;
  for (const m of messages) await host.fire("message_end", { message: m });
  await host.fire("agent_end", { messages });
  const notice = host.notices.join(" | ") || "(no notice)";
  const status = await host.run("status");
  const line = (re) => (status.split("\n").find((l) => re.test(l)) ?? "").trim();
  return `${notice}\n      ${line(/^Iterations:/)}   ${line(/^Status:/)}`;
}

console.log(`
=== l5 — a stop mid-turn used to leave the next turn's tool count non-zero ===

BEFORE, after /loop stop with two calls counted and /loop resume:
    notice  : (no notice)
    Iterations: 1/∞   Status: running
  — a starved turn at 90% counted as a successful iteration, which also resets
    consecutiveErrorCount, contextCooldownCount and contextCompressionLevel, and
    scheduled another turn into the same saturated context.

NOW — driving the shipped module:
`);

await host.run("start ship the feature");
console.log(`  control — a starved turn on a fresh counter
      ${await starvedTurn()}
`);

await host.run("stop");
await host.run("start ship the feature, again");
await host.fire("tool_result", { toolName: "read", content: "a file", isError: false });
await host.fire("tool_result", { toolName: "grep", content: "some matches", isError: false });
await host.run("stop");
await host.run("resume");
console.log(`  the same turn after a stop/resume that interrupted a two-call turn
      ${await starvedTurn()}
`);

await host.run("stop");
await host.run("start ship the feature, once more");
host.notices.length = 0;
const messages = [thought("thinking about the next step")];
for (const m of messages) await host.fire("message_end", { message: m });
await host.fire("tool_result", { toolName: "read", content: "a file", isError: false });
await host.fire("agent_end", { messages });
console.log(`  control — a turn that really did call a tool is not starved
      ${host.notices.join(" | ") || "(no notice)"}
`);

await host.quit();
console.log(`  The second control is the one that could fail: the fix must not make every
  turn look toolless. It clears the counter with the turn, not before one.
`);
