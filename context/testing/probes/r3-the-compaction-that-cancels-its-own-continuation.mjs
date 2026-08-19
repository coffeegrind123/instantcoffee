/**
 * r3 — AE2, AE3 and AE4. What `agent_settled` does, in the order it does it,
 * and what the room it is answering believes while it does it.
 * FIXED — each mode prints what happens now, with BEFORE in the comments.
 *
 * AD3 (thirteenth pass) found that a Matrix `/compact` cancelled the turn in
 * flight, because pi's `AgentSession.compact()` begins `await this.abort()`. The
 * fix defers the request to `agent_settled`, and its module header states the
 * premise in one sentence:
 *
 *   > by then aborting costs nothing because the run is over.
 *
 * True of the run that just ended. The handler is:
 *
 *   agentRunning = false
 *   stopTyping()
 *   await forwardResult()        ← can START A NEW RUN
 *   drainPendingCompaction()     ← aborts it
 *
 * `forwardResult` is where the empty-turn continuation lives (AB2's sibling,
 * `../../../vendor/prinny-channel/src/continuation.ts`), and its own comment
 * carries the same premise from the other side — "a follow-up, not a steer:
 * nothing is in flight at agent_settled". Two modules asserting one fact about a
 * moment, and the first of them falsifies it for the second, one line up.
 *
 * The two conditions are not independent, which is what makes this worth a
 * probe rather than a note: the sender asks for a compaction BECAUSE the bot has
 * gone slow or quiet, and an empty ending is what "quiet" looks like from
 * inside. `describeEmptyEnding`'s own `context` reason is a window at 87%+ — the
 * state a compaction is for.
 *
 * **AE3** is the room's own entry, and it is what makes the deferral above cost
 * an answer rather than a moment. `awaitingReply` is a `Map` keyed by ROOM and
 * holds ONE entry, and `deliverInbound` used to `set()` a fresh one for every
 * inbound message — including the ones this extension answers ITSELF. `live` is
 * evidence about the room, not a property of a message, and `forwardToMatrix`
 * filters on it; clearing it did not delay the answer to the question already in
 * flight, it deleted it. Nothing could restore it either: a locally-performed
 * command produces no user message for `markLive` to match. Mode `same-room`.
 *
 * **AE4** is the third, and it is why the first two are worth more than a lost
 * turn between them. `retrying` is set on the strength of having CALLED
 * `sendUserMessage`:
 *
 *   retrying = true;
 *   try { api.sendUserMessage(nudge, …) } catch (err) { retrying = false }
 *
 * The `catch` sees one thing, a synchronous stale-runtime throw. Everything else
 * — `prompt()` refusing during a compaction, no model, no provider auth —
 * rejects a promise pi `.catch`es into `emitError`, whose listener set is empty
 * outside a TUI (`delivery.ts` documents this for the inbound direction; it is
 * the same call). And `retrying` is what suppresses the retirement of every LIVE
 * room at the bottom of `forwardResult`. So a continuation that never happened
 * leaves the sender's room live, unanswered and never swept — and the next
 * unrelated turn's answer is forwarded to it. That is the exact leak `markLive`
 * exists to prevent, arriving from the other side.
 *
 * Driven against the REAL extension, in-process, with the real sidecar protocol
 * (`_sidecar.mjs`) — so `deliverInbound`, `classifyMatrixCommand`,
 * `planCompaction`, `markLive`, `forwardResult` and `drainPendingCompaction` are
 * all the shipped ones. The control in each block is the same run with the other
 * condition removed.
 *
 * **One process per scenario, and that is not cosmetic.** `awaitingReply` is
 * module state, and `forwardToMatrix` refuses to send when more than one room is
 * live — correctly, because with two there is no way to tell whose answer this
 * is. So a leftover live room from an earlier scenario SUPPRESSES the leak the
 * next one is about, and a single-process probe would report it fixed. The
 * scenarios therefore run one to a process, the way `g2`, `h4` and `i1` do for
 * the loop's module-global state.
 *
 *   run: for m in same-room settling-together never-taken control; do \
 *          node r3-the-compaction-that-cancels-its-own-continuation.mjs $m; done
 */

import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = "/home/claudeuser/qwen3.8-forge";
const PI_DIST = "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist";

let failures = 0;
const check = (label, ok) => {
  console.log(`   ${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const MODES = ["same-room", "settling-together", "never-taken", "control"];
const MODE = process.argv[2] ?? "same-room";
if (!MODES.includes(MODE)) {
  console.error(`usage: node r3-…mjs <${MODES.join("|")}>`);
  process.exit(2);
}

// ── pi's own compact(), pinned ───────────────────────────────────────────────
console.log(`\nr3 [${MODE}] — a deferred /compact, and the run agent_settled starts itself\n`);
{
  const session = readFileSync(`${PI_DIST}/core/agent-session.js`, "utf8");
  const at = session.indexOf("async compact(customInstructions)");
  const body = session.slice(at, at + 160).split("\n").slice(0, 3);
  console.log(body.map((line) => "   " + line.trim()).join("\n"));
  check("pi's compact() still begins by aborting the session", /await this\.abort\(\)/.test(body.join(" ")));
}

// ── a state dir the extension will accept ────────────────────────────────────
const stateDir = mkdtempSync(join(tmpdir(), "probe-prinny-"));
mkdirSync(join(stateDir, "runtime", "dist"), { recursive: true });
writeFileSync(join(stateDir, "runtime", "dist", "server.js"), "// stand-in for the built Matrix runtime\n");
writeFileSync(
  join(stateDir, ".env"),
  "PRINNY_HOMESERVER=https://example.org\nPRINNY_USER_ID=@bot:example.org\nPRINNY_PASSWORD=x\n",
  { mode: 0o600 },
);
const inbox = join(stateDir, "inbox.jsonl");
const outbox = join(stateDir, "outbox.jsonl");
writeFileSync(inbox, "");
writeFileSync(outbox, "");
process.env.PRINNY_STATE_DIR = stateDir;
process.env.PRINNY_SIDECAR_ENTRY = join(REPO, "context", "testing", "probes", "_sidecar.mjs");
process.env.PROBE_INBOX = inbox;
process.env.PROBE_OUTBOX = outbox;

const { createJiti } = await import(
  "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs"
);
const NM = `${PI_DIST}/../node_modules/@earendil-works`;
const NMR = `${PI_DIST}/../node_modules`;
const jiti = createJiti(`file://${PI_DIST}/index.js`, {
  interopDefault: true,
  alias: {
    "@earendil-works/pi-coding-agent": `${PI_DIST}/index.js`,
    "@earendil-works/pi-tui": `${NM}/pi-tui`,
    "@earendil-works/pi-ai": `${NM}/pi-ai`,
    typebox: `${NMR}/typebox/build/index.mjs`,
  },
});
const prinnyChannel = (await jiti.import(`${REPO}/vendor/prinny-channel/extensions/index.ts`)).default;

// ── the host ─────────────────────────────────────────────────────────────────
const handlers = new Map();
/** Everything the extension did, in order. This ordering IS the finding. */
const trace = [];
/** Set when the host is pretending pi refused the nudge (AE3). */
let refuseUserMessages = false;

const pi = {
  on: (name, fn) => handlers.set(name, [...(handlers.get(name) ?? []), fn]),
  registerCommand() {},
  registerTool() {},
  registerEntryRenderer() {},
  appendEntry() {},
  // pi's binding is `this.sendUserMessage(...).catch(err => runner.emitError(...))`
  // — it returns void and the rejection lands in a listener set that is empty
  // outside a TUI. So "pi refused it" is, from here, indistinguishable from
  // "pi took it": nothing is thrown and nothing is returned.
  sendUserMessage: (content, options) => {
    trace.push({
      step: refuseUserMessages ? "sendUserMessage (pi will reject it, silently)" : "sendUserMessage",
      text: String(content).slice(0, 48),
      // Kept whole so the probe can echo it back the way pi does. `markLive`
      // matches the injected string exactly, and after AE4 the nudge IS the
      // room's marker.
      full: String(content),
      deliverAs: options?.deliverAs,
    });
  },
};

const ctx = {
  cwd: process.cwd(),
  hasUI: false,
  ui: { notify: (message) => trace.push({ step: "notify", text: String(message).slice(0, 64) }), setStatus() {} },
  getContextUsage: () => ({ tokens: 31_000, contextWindow: 32_768, percent: 95 }),
  // The whole of what pi's ctx.compact does that matters here, in the order it
  // does it (agent-session.js: `compact()` → `await this.abort()`; the ctx
  // wrapper is a fire-and-forget async IIFE that reports through the callbacks).
  compact: (options) => {
    trace.push({ step: "ctx.compact() → pi aborts the session first" });
    options?.onComplete?.();
  },
  abort: () => trace.push({ step: "ctx.abort" }),
  isIdle: () => true,
};

prinnyChannel(pi);
const fire = async (name, event = {}) => {
  for (const fn of handlers.get(name) ?? []) await fn(event, ctx);
};
const post = (message) => appendFileSync(inbox, `${JSON.stringify(message)}\n`);
const replies = () =>
  readFileSync(outbox, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.name === "reply");

const inbound = (room, id, body) => ({
  content: body,
  meta: {
    room_id: room,
    chat_id: room,
    message_id: id,
    user: "Bob",
    user_id: "@bob:example.org",
    ts: "2026-08-18T00:00:00.000Z",
    is_direct: "true",
  },
});

const EMPTY_TURN = { messages: [{ role: "assistant", content: [], stopReason: "stop", usage: { output: 0 } }] };
const ANSWERED = (text) => ({
  messages: [{ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", usage: { output: 20 } }],
});

/** Deliver one Matrix message and return exactly what pi was handed. */
async function deliver(room, id, body) {
  const mark = trace.length;
  post(inbound(room, id, body));
  await sleep(250);
  return trace.slice(mark).find((entry) => entry.step.startsWith("sendUserMessage"))?.text;
}

/** pi echoing a message back as a user turn — the evidence `markLive` waits for. */
const echo = (text) => fire("message_end", { message: { role: "user", content: [{ type: "text", text }] } });

await fire("session_start", {});
await sleep(1200);
check("the channel is up and the sidecar reported a Matrix login", trace.some((e) => /connected as/.test(e.text ?? "")));

if (MODE === "same-room") {
// ── AE3 — a second message from the same room replaces the first ────────────
//
// `awaitingReply` is a Map keyed by ROOM, and `deliverInbound` does `set()`
// unconditionally. So an inbound message this extension answers ITSELF — a
// refused command, an allowed one, or `/compact` — overwrites the entry for the
// question the model is still working on, with `live: false` (nothing will mark
// it live: a local command produces no user message) and `answered: true`
// (which is what exempts it from the undelivered sweep).
console.log("\n   AE3 — a /compact sent while the model is answering the same room\n");
const ROOM_A = "!a:example.org";
trace.length = 0;
const askedA = await deliver(ROOM_A, "$a1", "what is the status of the build?");
console.log(`   pi was handed              : ${JSON.stringify(askedA)}`);
await fire("agent_start", {});
await echo(askedA);

await deliver(ROOM_A, "$a2", "/compact");
const deferReply = replies().at(-1)?.arguments?.text ?? "";
console.log(`   the sender is told         : ${JSON.stringify(deferReply.slice(0, 68))}`);
check("AD3 holds: a mid-turn /compact is deferred rather than run", /mid-turn/.test(deferReply));

const beforeAnswer = replies().length;
await fire("agent_end", ANSWERED("The build is green — 874 tests, 0 failures."));
await fire("agent_settled", {});
const sentAfter = replies().slice(beforeAnswer).map((entry) => entry.arguments?.text ?? "");
console.log(`   what the room received     : ${JSON.stringify(sentAfter)}`);
check(
  "AE3 fixed: the answer still reaches the room the /compact came from",
  sentAfter.some((text) => /874 tests/.test(text)),
);
// BEFORE: this list was empty. `deliverInbound` replaced the room's entry with
// one for the /compact, `live: false`, and nothing could ever set it again — a
// locally-performed command produces no user message for `markLive` to match —
// so `forwardToMatrix` found no live room and dropped the answer. `answered:
// true`, set by the local branch on the way past, then kept the undelivered
// sweep quiet about it too.
check(
  "…and it is not ALSO reported as undeliverable",
  !sentAfter.some((text) => /could not hand that/.test(text)),
);

}

if (MODE === "settling-together") {
// ── AE2 — the compaction and the continuation, in the same handler ──────────
//
// Same machine, with the `/compact` sent from a DIFFERENT room so the question's
// entry survives to be the thing `forwardResult` acts on. That is not a
// contrivance: it is one person on their phone and another in a group room, and
// it is also what a single sender gets the moment AE3 is fixed.
console.log("\n   AE2 — an empty turn and a deferred /compact settling together\n");
const ROOM_B = "!b:example.org";
const ROOM_C = "!c:example.org";
trace.length = 0;
const askedB = await deliver(ROOM_B, "$b1", "did the tests pass?");
await fire("agent_start", {});
await echo(askedB);
await deliver(ROOM_C, "$c1", "/compact");

trace.length = 0;
await fire("agent_end", EMPTY_TURN);
await fire("agent_settled", {});

console.log("   what agent_settled did, in order:\n");
for (const [index, entry] of trace.entries()) {
  console.log(`     ${index + 1}. ${entry.step}${entry.text ? ` — ${JSON.stringify(entry.text)}` : ""}`);
}
console.log("");

const nudgeAt = trace.findIndex((e) => e.step.startsWith("sendUserMessage"));
const compactAt = trace.findIndex((e) => e.step.startsWith("ctx.compact"));
check("forwardResult started a continuation to get the sender an answer", nudgeAt >= 0);
// BEFORE: the trace was 4 entries and ended `ctx.compact() → pi aborts the
// session first` — i.e. the handler aborted the run it had started two lines
// earlier. pi's `prompt()` also throws "Cannot submit a prompt while compaction
// is in progress" on the other side of the same race, and that rejection goes to
// `emitError`, which has no listeners headless.
check("AE2 fixed: the compaction stands aside rather than aborting it", compactAt < 0);

// It is a stand-aside, not a refusal: the sender was told "as soon as it
// finishes", and it must still finish. The continuation runs, and ITS
// settlement is where nothing is in flight.
const nudgeText = trace[nudgeAt]?.full;
trace.length = 0;
await fire("agent_start", {});
await echo(nudgeText);
await fire("agent_end", ANSWERED("Yes — 874 passed."));
await fire("agent_settled", {});
console.log("   after the continuation settles:\n");
for (const [index, entry] of trace.entries()) {
  console.log(`     ${index + 1}. ${entry.step}${entry.text ? ` — ${JSON.stringify(entry.text)}` : ""}`);
}
console.log("");
check(
  "…and runs on the settlement after it, where the run really is over",
  trace.some((e) => e.step.startsWith("ctx.compact")),
);
check(
  "the sender got the continuation's answer, because pi really did take the nudge",
  replies().some((entry) => /874 passed/.test(String(entry.arguments?.text ?? ""))),
);

}

if (MODE === "never-taken") {
// ── AE4 — `retrying` is a claim about a call ────────────────────────────────
//
// Nothing here throws, because nothing in pi's binding can: `sendUserMessage`
// returns void and the rejection lands in `emitError`, whose listener set is
// empty outside a TUI. So "pi refused it" and "pi took it" look identical from
// this side — and `retrying` is what suppresses the retirement of every LIVE
// room at the bottom of `forwardResult`.
console.log("   AE4 — the continuation pi never took, and what the room gets instead\n");
const ROOM_D = "!d:example.org";
refuseUserMessages = true;
trace.length = 0;
const askedD = await deliver(ROOM_D, "$d1", "how is the deploy going?");
await fire("agent_start", {});
await echo(askedD);
await fire("agent_end", EMPTY_TURN);
trace.length = 0;
await fire("agent_settled", {});
check("the extension believes a continuation is coming", trace.some((e) => e.step.startsWith("sendUserMessage")));
const afterGiveUp = replies().at(-1)?.arguments?.text ?? "";
check("so the sender is told nothing — no answer, and no apology either", !/could not answer that/.test(afterGiveUp));

// The continuation never runs. Later the OPERATOR asks something in the terminal.
refuseUserMessages = false;
const beforeLeak = replies().length;
await fire("agent_start", {});
await echo("what is in ~/.ssh/config?");
await fire("agent_end", ANSWERED("Host prod / HostName 10.0.0.4 / User deploy"));
await fire("agent_settled", {});
const leaked = replies().slice(beforeLeak).map((entry) => entry.arguments?.text ?? "");
console.log(`   what ${ROOM_D} received  : ${JSON.stringify(leaked)}`);
// BEFORE: this was `["Host prod / HostName 10.0.0.4 / User deploy"]`. The room
// stayed LIVE because `retrying` was true, so the operator's own answer — to a
// question typed in the terminal, about their own machine — was forwarded to
// whoever had messaged. That is the leak the whole `markLive` mechanism exists
// to prevent, reached from the other side.
check("AE4 fixed: the operator's private answer is NOT forwarded to Matrix", !leaked.some((t) => /HostName/.test(t)));
check(
  "…and nothing else was sent to that room either",
  leaked.length === 0,
);

// And the failure is now VISIBLE rather than silent: the entry is not live, not
// answered, and past the grace on an idle session, which is exactly what
// `sweepUndelivered` reports. The grace is a minute and the sweep runs every
// thirty seconds, so this is only checked in the slow mode.
if (process.env.PROBE_SLOW === "1") {
  console.log("   waiting out DELIVERY_GRACE_MS to see the sweep …");
  await sleep(95_000);
  const swept = replies().at(-1)?.arguments?.text ?? "";
  console.log(`   the sweep told the sender  : ${JSON.stringify(String(swept).slice(0, 60))}`);
  check("the sender is told the message never reached the session", /could not hand that/.test(swept));
} else {
  console.log("   (set PROBE_SLOW=1 to wait out the 60s grace and watch the sweep report it)");
}

}

if (MODE === "control") {
// ── control — an ordinary exchange, and the turn after it ───────────────────
console.log("\n   control — one question, one answer, and the next turn goes nowhere\n");
const ROOM_E = "!e:example.org";
trace.length = 0;
const askedE = await deliver(ROOM_E, "$e1", "and the linter?");
await fire("agent_start", {});
await echo(askedE);
await fire("agent_end", ANSWERED("The linter is clean."));
await fire("agent_settled", {});
check("the answer reached the room", /linter is clean/.test(String(replies().at(-1)?.arguments?.text ?? "")));

const before = replies().length;
await fire("agent_start", {});
await echo("and my private note?");
await fire("agent_end", ANSWERED("Your private note says: nothing to see."));
await fire("agent_settled", {});
check("and the NEXT, unrelated turn is not forwarded anywhere", replies().length === before);

}

await fire("session_shutdown", {});
console.log("");
if (failures > 0) {
  console.log(`   ${failures} expectation(s) failed`);
  process.exit(1);
}
console.log("   all expectations held");
process.exit(0);
