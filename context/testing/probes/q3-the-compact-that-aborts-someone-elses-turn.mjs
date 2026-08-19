/**
 * q3 — AD3. `/compact` from Matrix aborted the turn that was in flight, and
 * paused an unattended `/loop` run under somebody else's name.
 * FIXED — the request waits for `agent_settled` now. Section 3 below is the
 * damage, and it is UNCHANGED on purpose: an aborted turn still pauses a loop,
 * because that branch is right. What changed is who can cause one.
 *
 * AC5 (twelfth pass) made `/compact` from Matrix real. It had been inert — pi's
 * `prompt()` dispatches EXTENSION commands only, so the text reached the model —
 * and `prinny-channel` now performs it itself through
 * `ExtensionContext.compact({onComplete,onError})`.
 *
 * That call is not additive. pi's own implementation begins:
 *
 *     async compact(customInstructions) {
 *         await this.abort();                       // agent-session.js:1367
 *
 * So the first thing a remote `/compact` does is cancel whatever the session was
 * doing. Nothing on the prinny side asks whether the session is busy —
 * `runLocalCommand` has no `agentRunning` test and no `ctx.isIdle()` test — and
 * `/compact` is advertised in the Matrix client's command menu
 * (`advertisedCommands()`), so it is one tap away from any allow-listed sender.
 *
 * The extension is otherwise built entirely around NOT doing this: inbound text
 * is delivered `deliverAs: "followUp"` by default, with a comment saying "a
 * message arriving mid-turn joins the queue rather than interrupting work the
 * user asked for in the terminal". One command routes around that.
 *
 * Downstream, in `vendor/pi-loop-mode`, an aborted turn is not a neutral event.
 * `agent_end`'s ladder has a branch for it, one rung below the degenerate-abort
 * rung, and it PAUSES the run — with a notice naming the operator. Everything
 * below is the shipped loop module, driven directly.
 *
 *   run: node --experimental-strip-types q3-the-compact-that-aborts-someone-elses-turn.mjs
 */

import { readFileSync } from "node:fs";

import { assistant, makeHost, REPO, statusLines } from "./_host.mjs";

const loop = await import(`${REPO}/vendor/pi-loop-mode/extensions/index.ts`);
const routing = await import(`${REPO}/vendor/prinny-channel/src/command-routing.ts`);
const { planCompaction } = await import(`${REPO}/vendor/prinny-channel/src/compaction-request.ts`);

let failures = 0;
const check = (label, ok) => {
  console.log(`   ${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) failures++;
};

console.log("\nq3 — a Matrix /compact, and what it cancels\n");

// ── 1. pi's own compact, pinned where it is written ──────────────────────────
//
// A source pin and not an execution, deliberately: running it needs a real
// provider, and the claim is about the first statement of the function rather
// than about anything it computes. The alternative — asserting that a stub
// aborts — would be a claim about the stub.
{
  const PI = "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js";
  const src = readFileSync(PI, "utf8");
  const body = src.slice(src.indexOf("async compact(customInstructions)"));
  const firstStatements = body.split("\n").slice(1, 4).map((l) => l.trim());
  console.log("   pi's AgentSession.compact() begins:");
  for (const line of firstStatements) console.log(`       ${line}`);
  check("pi's compact() aborts the session first", firstStatements[0] === "await this.abort();");

  const ext = src.slice(src.indexOf("compact: (options) => {"));
  check(
    "and ctx.compact() is that same method, with the callbacks wrapped round it",
    /await this\.compact\(options\?\.customInstructions\)/.test(ext.slice(0, 400)),
  );
}

// ── 2. What prinny does with it now, BEFORE and NOW ──────────────────────────
//
// BEFORE the rule was "call `uiCtx.compact()`", with nothing between the inbound
// message and the abort. NOW it is `planCompaction`, which lives in `src/` so it
// can be executed here rather than described — the same move `delivery.ts` and
// `record-activity.ts` made, for the same reason.
{
  const classified = routing.classifyMatrixCommand("/compact");
  console.log("");
  console.log(`   /compact is offered in the client menu      : ${routing.advertisedCommands().some((c) => c.command === "compact")}`);
  console.log(`   classifyMatrixCommand("/compact")           : ${classified.kind}`);
  check("the command is advertised to every allow-listed sender", routing.advertisedCommands().some((c) => c.command === "compact"));
  check("and it routes to the local handler", classified.kind === "local");

  console.log("");
  console.log("                                          BEFORE                       NOW");
  for (const [label, input] of [
    ["a turn is in flight", { hasSession: true, agentRunning: true }],
    ["the session is idle", { hasSession: true, agentRunning: false }],
    ["no session yet     ", { hasSession: false, agentRunning: false }],
  ]) {
    const before = input.hasSession ? "compact() → abort()" : "told: no session open";
    const now = planCompaction(input).action;
    console.log(`   ${label}                    ${before.padEnd(29)}${now}`);
  }
  console.log("");
  check(
    "AD3: a request that lands mid-turn now waits instead of cancelling",
    planCompaction({ hasSession: true, agentRunning: true }).action === "defer",
  );
  check(
    "control: an idle session still compacts immediately",
    planCompaction({ hasSession: true, agentRunning: false }).action === "now",
  );
  check(
    "control: no session is still its own answer",
    planCompaction({ hasSession: false, agentRunning: true }).action === "unavailable",
  );

  // And the wiring, which the rule needs and which cannot be executed here.
  const src = readFileSync(`${REPO}/vendor/prinny-channel/extensions/index.ts`, "utf8");
  const settled = src.slice(src.indexOf("pi.on('agent_settled'"));
  check(
    "AD3: the deferred request is drained when the run settles",
    /drainPendingCompaction\(\);/.test(settled.slice(0, settled.indexOf("});"))),
  );
}

// ── 3. What the abort does to an unattended run — the shipped loop module ────
{
  const host = makeHost({ percent: 30 });
  loop.default(host.pi);
  await host.fire("session_start", {});

  await host.run('start ship the parser --max 0');
  await host.turn({ messages: ["Added tokenize() and its tests."] });
  const before = await host.run("status");
  console.log("");
  console.log("   an ordinary iteration, then:");
  console.log(statusLines(before, /^(Status|Iteration)/));

  // The turn pi was running when the compaction arrived. `AgentSession.abort()`
  // ends it, and the assistant message it leaves behind carries stopReason
  // "aborted" — the same shape the operator's Esc produces, because it is the
  // same call.
  host.notices.length = 0;
  const cut = assistant("a partial answer, cut off mid-", "aborted");
  await host.fire("message_end", { message: cut });
  await host.fire("agent_end", { messages: [cut] });
  const notice = host.notices.join(" | ") || "(no notice)";
  const after = await host.run("status");
  console.log("");
  console.log(`   the loop's notice                          : ${notice}`);
  console.log(statusLines(after, /^(Status|Last notice)/));
  console.log("");

  check("the loop still pauses on an aborted turn — that branch is correct", /Status:\s*paused/.test(after));
  check(
    "and it records the operator as the cause — which is why AD3 mattered",
    /aborted by operator/i.test(after) || /aborted by operator/i.test(notice),
  );
  check("nothing in the notice could have named the real cause", !/compact/i.test(notice));

  await host.quit();
}

// ── 4. The control: the same turn, ending normally ───────────────────────────
//
// One process per loop (the module's state is global), so this is a second host
// — which is also the honest control, because it shows the ladder taking the
// ordinary branch from the same starting state.
{
  const host = makeHost({ percent: 30 });
  loop.default(host.pi);
  await host.fire("session_start", {});
  await host.run("start ship the parser --max 0");
  await host.turn({ messages: ["Added tokenize() and its tests."] });
  await host.turn({ messages: ["Added parse() and its tests."] });
  const status = await host.run("status");
  console.log("   control — the same run with no abort:");
  console.log(statusLines(status, /^(Status|Iteration)/));
  check("control: an unaborted run keeps going", /Status:\s*running/.test(status));
  await host.quit();
}

console.log(`\n${failures === 0 ? "q3: every expectation held" : `q3: ${failures} FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
