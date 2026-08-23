/**
 * v2 — AI2. The compaction two people asked for, and the one who was told.
 *
 * FIXED — each mode prints what happens now, with BEFORE in the comments.
 *
 * ## The promise
 *
 * A Matrix `/compact` that arrives mid-turn is deferred rather than refused,
 * because "no" is the wrong answer when "in a moment" is available (AD3). The
 * sender is told, in `planCompaction`:
 *
 *   > The session is mid-turn — I will compact as soon as it finishes rather
 *   > than cutting it off.
 *
 * ## Where it is not true
 *
 * `runLocalCommand` parked that promise in one slot:
 *
 *     pendingCompaction = { room, at: Date.now() };
 *
 * under *"One slot, last-write-wins: two senders asking during the same turn
 * want one compaction, and the second is the one whose room is still expecting
 * an answer soonest."* One compaction is right. One REPLY is not — the callbacks
 * answer the room in the slot, so every sender but the last was told something
 * would happen and never heard again. `deliverInbound` sets `answered` on the
 * way past, so the undelivered sweep could not report it either.
 *
 * It is the same premise AF1 is built on: two people messaging in one window is
 * the ordinary case for a channel with two people on it, and pi consumes both in
 * one run. The two are correlated rather than independent — a sender asks for a
 * compaction BECAUSE the bot has gone quiet, and both of them can see that.
 *
 * ## The control, in the same module
 *
 * When the request is served IMMEDIATELY, `startCompaction` reads the lock,
 * finds a holder, and tells the second asker *"A compaction is already
 * running…"*. Two senders were answered correctly on the path that acts and lost
 * on the path that defers.
 *
 * ## And the other way it was lost
 *
 * `stopChannel` denies every pending PERMISSION with a stated reason — "the
 * operator asked to be consulted, and the channel going away is not consent" —
 * and dropped the pending `/compact` in the same function. Mode `stopping`.
 *
 * Driven against the REAL extension, in-process, over the real sidecar protocol.
 * **One process per mode**: `pendingCompaction` and `awaitingReply` are module
 * state and this probe is about what is in them.
 *
 *   run: for m in two-rooms stopping control; do \
 *          node v2-the-compaction-two-people-asked-for.mjs $m; done
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

const MODES = ["two-rooms", "stopping", "control"];
const MODE = process.argv[2] ?? "two-rooms";
if (!MODES.includes(MODE)) {
  console.error(`usage: node v2-…mjs <${MODES.join("|")}>`);
  process.exit(2);
}

console.log(`\nv2 [${MODE}] — the compaction two people asked for\n`);

// ── the promise, read out of the module that makes it ────────────────────────
{
  const request = readFileSync(`${REPO}/vendor/prinny-channel/src/compaction-request.ts`, "utf8");
  check(
    "planCompaction promises the deferred sender a compaction",
    /I will compact as soon as it finishes rather than cutting it off/.test(request),
  );
  check("…and the slot is now plural", /rooms: string\[\]/.test(request));
}

// ── a state dir the extension will accept ────────────────────────────────────
const stateDir = mkdtempSync(join(tmpdir(), "probe-prinny-"));
// AN2: a stand-in runtime with no `.source-stamp` reads as `stale`, and
// `startupBlocker()` refuses to start on it — silently, from here. This probe
// wrote `dist/server.js` alone, which was the whole check before AN2, and has
// been starting a channel that immediately gave up ever since. See _staged.mjs.
const { stageStandIn } = await import("./_staged.mjs");
stageStandIn(stateDir);
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
const notices = [];
const compactions = [];

const pi = {
  on: (name, fn) => handlers.set(name, [...(handlers.get(name) ?? []), fn]),
  registerCommand() {},
  registerTool() {},
  registerEntryRenderer() {},
  appendEntry() {},
  sendUserMessage() {},
};

const ctx = {
  cwd: process.cwd(),
  hasUI: false,
  ui: { notify: (message) => notices.push(String(message)), setStatus() {} },
  getContextUsage: () => ({ tokens: 28_000, contextWindow: 32_768, percent: 85 }),
  compact: (options) => {
    compactions.push(options);
    // Answered on the next tick, as pi's own fire-and-forget wrapper does.
    setTimeout(() => options?.onComplete?.(), 10);
  },
  abort() {},
  isIdle: () => true,
};

prinnyChannel(pi);
const fire = async (name, event = {}) => {
  for (const fn of handlers.get(name) ?? []) await fn(event, ctx);
};
const post = (message) => appendFileSync(inbox, `${JSON.stringify(message)}\n`);
const sent = () =>
  readFileSync(outbox, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.name === "reply")
    .map((entry) => ({ room: entry.arguments?.room_id, text: String(entry.arguments?.text ?? "") }));

const inbound = (room, id, body, user) => ({
  content: body,
  meta: {
    room_id: room,
    chat_id: room,
    message_id: id,
    user,
    user_id: `@${user.toLowerCase()}:example.org`,
    ts: "2026-08-19T00:00:00.000Z",
    is_direct: "true",
  },
});

await fire("session_start", {});
await sleep(1200);

const ROOM_A = "!alice:example.org";
const ROOM_B = "!bob:example.org";

if (MODE === "two-rooms") {
  console.log("\n   two people ask for a compaction while the bot is mid-turn\n");
  await fire("agent_start", {});
  post(inbound(ROOM_A, "$a1", "/compact", "Alice"));
  await sleep(250);
  post(inbound(ROOM_B, "$b1", "/compact", "Bob"));
  await sleep(250);

  const deferred = sent();
  console.log(`   both are told it will happen : ${deferred.filter((e) => /as soon as it finishes/.test(e.text)).length} of 2`);
  check("both senders get the deferral receipt", deferred.filter((e) => /as soon as it finishes/.test(e.text)).length === 2);

  const before = sent().length;
  await fire("agent_end", {
    messages: [{ role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop", usage: { output: 4 } }],
  });
  await fire("agent_settled", {});
  await sleep(400);
  const after = sent().slice(before);

  console.log("\n      BEFORE                                  NOW");
  console.log("      ─────────────────────────────────────   ─────────────────────────────────────");
  console.log(`      1 compaction, 1 room told (Bob)         ${compactions.length} compaction, ${after.length} rooms told`);
  for (const entry of after) console.log(`        ${entry.room}  ${JSON.stringify(entry.text.slice(0, 46))}`);
  console.log("");

  check("still exactly ONE compaction — that was never the defect", compactions.length === 1);
  check("Alice is told it happened", after.some((e) => e.room === ROOM_A && /Compacted/.test(e.text)));
  check("…and so is Bob", after.some((e) => e.room === ROOM_B && /Compacted/.test(e.text)));
  check("nobody is told twice", after.length === 2);
}

if (MODE === "stopping") {
  console.log("\n   one person asks, and the channel stops before the turn ends\n");
  await fire("agent_start", {});
  post(inbound(ROOM_A, "$a2", "/compact", "Alice"));
  await sleep(300);
  check("she is told it will happen", sent().some((e) => /as soon as it finishes/.test(e.text)));

  const before = sent().length;
  // `/prinny stop`, a `/prinny restart`, or pi going away.
  await fire("session_shutdown", {});
  await sleep(500);
  const after = sent().slice(before);

  console.log("\n      BEFORE                                  NOW");
  console.log("      ─────────────────────────────────────   ─────────────────────────────────────");
  console.log(`      nothing — the slot is dropped           ${after.length} message`);
  for (const entry of after) console.log(`        ${entry.room}  ${JSON.stringify(entry.text.slice(0, 56))}`);
  console.log("");

  check("she is told it will not run after all", after.some((e) => /will not run/.test(e.text)));
  check("…and told what to do about it", after.some((e) => /ask again/.test(e.text)));
  check("no compaction was started", compactions.length === 0);
  check(
    "the control in the same function is unchanged: a pending permission is still DENIED",
    readFileSync(`${REPO}/vendor/prinny-channel/extensions/index.ts`, "utf8").includes("pending.resolve('deny')"),
  );
  console.log(`
   The ORDER is the second half of this fix, and it is not decoration:
   \`callSidecar\` goes through \`requireChannel()\`, which reads \`child\` — so the
   abandonment has to happen before \`child = null\`, three lines into
   \`stopChannel\`. Placed after it, the reply throws "the Matrix channel is not
   running" into a \`.catch\` and the sender hears nothing, which is the defect
   with an extra step.
`);
}

if (MODE === "control") {
  console.log("\n   control — one person, one compaction, one reply\n");
  await fire("agent_start", {});
  post(inbound(ROOM_A, "$a3", "/compact", "Alice"));
  await sleep(300);

  const before = sent().length;
  await fire("agent_end", {
    messages: [{ role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop", usage: { output: 4 } }],
  });
  await fire("agent_settled", {});
  await sleep(400);
  const after = sent().slice(before);
  console.log(`   what the room received      : ${JSON.stringify(after.map((e) => e.text))}`);

  check("one compaction", compactions.length === 1);
  check("one reply, to the one room that asked", after.length === 1 && after[0].room === ROOM_A);
  check("…and it says the compaction happened", /Compacted the conversation context\./.test(after[0].text));
}

if (MODE !== "stopping") await fire("session_shutdown", {});
console.log("");
if (failures > 0) {
  console.log(`   ${failures} expectation(s) failed`);
  process.exit(1);
}
console.log("   all expectations held");
process.exit(0);
