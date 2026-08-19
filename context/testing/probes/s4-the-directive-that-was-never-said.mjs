/**
 * s4 — AF3. Five exits of the loop's `agent_end` that charged the ladder and
 * then dropped the sentence they charged it for.
 * FIXED — this probe prints BEFORE and NOW side by side.
 *
 * Each of these is the loop's ANSWER to something it has just decided:
 *
 *     improve       LOOP_DONE in endless mode  → work the IMPROVEMENTS.md backlog
 *     unblock       LOOP_BLOCKED               → assume, record it, never wait
 *     check_failed  the check disagrees with the model's claim
 *     regression    the score dropped, with the numbers
 *     audit         nothing concrete for eight iterations → produce an artefact
 *
 * All five were
 *
 *     if (!ctx.hasPendingMessages()) scheduleLoopTurn(pi, KIND, delay, ctx);
 *     return;
 *
 * and all five charge their counters ABOVE that line — `doneSignalCount`,
 * `blockedSignalCount`, `interventionCount`, the operator's notice, and for
 * `audit` the reset of `lastStateChangeIteration`, which is what stops the same
 * nudge firing again for another eight iterations.
 *
 * V4 (sixth pass) found exactly this in `interveneStuck` and fixed it there,
 * with the sentence that names the rule: *the guard is right for every OTHER
 * exit of agent_end, where the loop only needs A turn to happen and a pending
 * message will cause one; here the loop needs THIS TEXT to reach the model.*
 * Five of the "other" exits also need THIS TEXT. The sixth, `continue`, does
 * not, and still drops — putting 1,200 characters of loop rules onto a turn the
 * operator typed for their own reasons would be the other kind of mistake.
 *
 * `ctx.hasPendingMessages()` is true only when a human typed into a streaming
 * session (AA3: the two arrays it counts are written by `_queueSteer` /
 * `_queueFollowUp`, which nothing an extension calls ever reaches). At
 * `agent_end` that means they typed after the agent loop's last follow-up drain
 * — most plausibly while this very handler was awaiting a goal check, which may
 * run for `checkTimeoutSeconds` (120 s by default).
 *
 * Driven against the SHIPPED loop module through `_host.mjs`.
 *
 *   run: for m in pending idle; do node s4-the-directive-that-was-never-said.mjs $m; done
 */

import { makeHost, REPO, execResult } from "./_host.mjs";

const MODES = ["pending", "idle"];
const MODE = process.argv[2] ?? "pending";
if (!MODES.includes(MODE)) {
  console.error(`usage: node s4-…mjs <${MODES.join("|")}>`);
  process.exit(2);
}

let failures = 0;
const check = (label, ok) => {
  console.log(`   ${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) failures++;
};

const loopMode = (await import(`${REPO}/vendor/pi-loop-mode/extensions/index.ts`)).default;

console.log(`\ns4 [${MODE}] — the five directives, with a message pending\n`);

const pending = MODE === "pending";
let checkCode = 0;
let score;
const host = makeHost({
  exec: async () => execResult({ code: checkCode, stdout: score === undefined ? "" : `SCORE: ${score}` }),
});
// `_host.mjs` answers `false` by default; this is the whole condition.
host.ctx.hasPendingMessages = () => pending;

loopMode(host.pi);
await host.fire("session_start", {});

const turn = async (text, tools = [{ toolName: "bash", content: [{ type: "text", text: "ran" }] }]) =>
  host.turn({ messages: [text], tools });

/** Every loop message sent during the last turn, as `kind/deliverAs`. */
const sends = () =>
  host.sent.map((m) => `${m.details?.kind ?? "?"}/${m.__options?.deliverAs ?? "(own turn)"}`);

const rows = [];
const record = async (label, expected, run) => {
  await run();
  const got = sends();
  rows.push([label, got.join(", ") || "(nothing)"]);
  check(`${label} — the directive is ${expected}`, got.some((entry) => entry.startsWith(expected)));
};

// improve — two different done-turns, so the second is not read as a repeat.
await host.run("start keep the docs in step with the code");
await turn("LOOP_DONE: the importer now streams and the suite is green.");
await record("improve     ", "improve", () =>
  turn("LOOP_DONE: split the CSV front end out of the importer; nothing else moved."));

// unblock
await host.run("start wire up the exporter");
await record("unblock     ", "unblock", () => turn("LOOP_BLOCKED: no credentials for the staging bucket."));

// check_failed — until-done with a check that fails
checkCode = 1;
await host.run('start make the suite green --until-done --check "npm test"');
await record("check_failed", "check_failed", () => turn("LOOP_DONE: everything passes now."));

// regression — a score that drops
checkCode = 1;
score = 90;
await host.run('start raise the score --check "./check.sh"');
await turn("Tuned the tokenizer.", [{ toolName: "edit", content: [{ type: "text", text: "written" }] }]);
score = 70;
await record("regression  ", "regression", () =>
  turn("Reworked the lexer tables.", [{ toolName: "edit", content: [{ type: "text", text: "written" }] }]));

// audit — eight iterations with nothing that reads as a change
checkCode = 0;
score = undefined;
await host.run("start investigate the flaky test");
let auditRun;
for (let i = 0; i < 8; i++) {
  // A different tool result each turn: three identical ones in a row is the
  // repeated-signature rule, and a stuck verdict outranks the audit.
  auditRun = () =>
    turn(`Looked at hypothesis ${i}; the timing is not it.`, [
      { toolName: "bash", content: [{ type: "text", text: `sample ${i}` }] },
    ]);
  if (i < 7) await auditRun();
}
await record("audit       ", "audit", auditRun);

// continue — the control, and the one that still drops
await host.run("start keep the docs in step with the code");
await turn("Rewrote the install section.", [{ toolName: "edit", content: [{ type: "text", text: "written" }] }]);
await turn("Rewrote the configuration section.", [{ toolName: "edit", content: [{ type: "text", text: "written" }] }]);
rows.push(["continue    ", sends().join(", ") || "(nothing)"]);

console.log("");
for (const [label, got] of rows) console.log(`     ${label}  ${got}`);
if (pending) {
  console.log(`
     BEFORE: every row above read "(nothing)" — the counters were charged, the
     operator was told what the loop was about to say, and the model was never
     told it. Only \`continue\` is supposed to read that way.
`);
} else {
  console.log("\n     (the control: with nothing pending, all six start a turn of their own)\n");
}

if (pending) {
  check("continue still drops — any turn advances an endless loop", rows[5][1] === "(nothing)");
} else {
  check("with nothing pending, every directive starts its own turn", rows.every(([, got]) => got !== "(nothing)"));
}

await host.quit();
console.log("");
if (failures > 0) {
  console.log(`   ${failures} expectation(s) failed`);
  process.exit(1);
}
console.log("   all expectations held");
process.exit(0);
