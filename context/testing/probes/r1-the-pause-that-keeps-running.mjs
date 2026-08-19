/**
 * r1 — AE1. "Loop paused (turn aborted). Use /loop resume to continue."
 * FIXED — this probe prints BEFORE and NOW.
 *
 * `pi-loop-mode` has four ways to stop a run short of finishing:
 *
 *     pauseForContextFailure    runToken++ · state.active = false · "paused"
 *     pauseForCheckFailure      runToken++ · state.active = false · "paused"
 *     pauseForProviderFailure   runToken++ · state.active = false · "paused"
 *     the iteration cap                     state.active = false · "paused"
 *     the operator's Esc                                            "paused"   ✘
 *
 * The last one set the status and nothing else, and `state.active` is what all
 * thirteen handlers test at their first line. So the loop went on OWNING the
 * session while telling the operator it had stopped, and the claim was undone by
 * the next `agent_end` from any source at all: the whole ladder ran on somebody
 * else's turn, `iterationCount` advanced, and the fall-through scheduled the
 * next iteration — with no notice, on a run a person had just stopped by hand.
 *
 * The turn that does it is not exotic. `/loop status` is a slash command and
 * produces none, but a question typed into the terminal does; so does a Matrix
 * message (`prinny-channel` → `sendUserMessage` → `prompt()`); so does a
 * background subagent settling (`SpawnCoordinator.emitIndividualNudge` →
 * `sendMessage({triggerTurn: true})`). The likeliest of the three is the
 * operator answering the notice they were just shown.
 *
 * A second, quieter half: `before_agent_start` is gated on `state.active` too,
 * so every operator-typed turn while "paused" was told *"Loop mode is active.
 * Goal: … keep every assistant response under 1,200 characters … never wait for
 * a human"* — an instruction set that is wrong for a person asking a question.
 *
 * The control is a run that was never aborted: the same three events must still
 * advance it, or the fix would read as "the loop stopped working".
 *
 * One process per mode, because the loop's state is module-global.
 *
 *   run: node --experimental-strip-types r1-the-pause-that-keeps-running.mjs aborted
 *        node --experimental-strip-types r1-the-pause-that-keeps-running.mjs control
 */

import { assistant, makeHost, statusLines } from "./_host.mjs";

const MODE = process.argv[2] ?? "aborted";
if (!["aborted", "control"].includes(MODE)) {
  console.error("usage: node r1-the-pause-that-keeps-running.mjs <aborted|control>");
  process.exit(2);
}

const loopMode = (await import("/home/claudeuser/qwen3.8-forge/vendor/pi-loop-mode/extensions/index.ts")).default;

let failures = 0;
const check = (label, ok) => {
  console.log(`   ${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) failures++;
};

const host = makeHost({ percent: 20 });
loopMode(host.pi);
await host.run("start hold the line. Done when: never");

console.log(`\nr1 [${MODE}] — what a paused loop does with the next turn\n`);

// ── 1. the turn that ends the run ────────────────────────────────────────────
const stopReason = MODE === "aborted" ? "aborted" : "stop";
host.notices.length = 0;
host.sent.length = 0;
await host.fire("message_end", { message: assistant("half a sen", stopReason) });
await host.fire("agent_end", { messages: [assistant("half a sen", stopReason)] });

console.log(`   the turn ended with stopReason "${stopReason}"`);
// Captured before `/loop status`, which clears the notice buffer to read its own.
const endNotices = host.notices.join(" | ");
console.log(`   the operator is told       : ${endNotices || "(nothing)"}`);
console.log(`   the loop scheduled         : ${host.sent.map((m) => m.details?.kind).join(",") || "(nothing)"}`);
const paused = await host.run("status");
console.log(statusLines(paused, /^(Active|Status|Iterations)/));

if (MODE === "aborted") {
  check("the operator is told the loop is paused", /Loop paused \(turn aborted\)/.test(endNotices));
  check("BEFORE: `Active: true` here — the loop still owned the session", /Active: false/.test(paused));
  check("nothing is scheduled either way", host.sent.length === 0);
} else {
  check("control: an ordinary turn schedules the next iteration", host.sent.some((m) => m.details?.kind === "continue"));
  check("control: and the loop is still active", /Active: true/.test(paused));
}

// ── 2. the next turn, from whoever produces one ──────────────────────────────
//
// A person answering the notice, a Matrix message, or a background subagent
// settling: all three arrive here as one more `agent_end`.
console.log("\n   …then a turn arrives from somewhere else\n");
host.notices.length = 0;
host.sent.length = 0;
const injected = await host.fire("before_agent_start", {});
await host.fire("message_end", { message: assistant("answered the human's question") });
await host.fire("agent_end", { messages: [assistant("answered the human's question")] });

const injectedRules = injected.filter(Boolean);
console.log(
  `   before_agent_start injected: ${
    injectedRules.length ? JSON.stringify(String(injectedRules[0].message.content).slice(0, 64)) : "(nothing)"
  }`,
);
console.log(`   the loop then scheduled    : ${host.sent.map((m) => m.details?.kind).join(",") || "(nothing)"}`);
console.log(`   the operator is told       : ${host.notices.join(" | ") || "(nothing)"}`);
const after = await host.run("status");
console.log(statusLines(after, /^(Active|Status|Iterations|Last notice)/));
console.log("");

if (MODE === "aborted") {
  check("AE1: nothing is scheduled by a turn the loop did not drive", host.sent.length === 0);
  check("…and the turn is not counted as one of the run's iterations", /Iterations: 0/.test(after));
  check("…and the run is still paused, not silently running again", /Status: paused/.test(after));
  check(
    "…and a person asking a question is not told to keep answers under 1,200 characters",
    injectedRules.length === 0,
  );
} else {
  check("control: the loop keeps driving its own run", host.sent.some((m) => m.details?.kind === "continue"));
  check("control: and it keeps counting iterations", /Iterations: 2/.test(after));
  check("control: and it still tells an operator-typed turn that a loop is running", injectedRules.length === 1);
}

await host.quit();
if (failures > 0) {
  console.log(`   ${failures} expectation(s) failed`);
  process.exit(1);
}
console.log("   all expectations held");
