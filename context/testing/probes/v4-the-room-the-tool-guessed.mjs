/**
 * v4 — AI4. The room the tool guessed, where the forwarder refuses to.
 *
 * FIXED — each mode prints what happens now, with BEFORE in the comments.
 *
 * ## The promise
 *
 * `forwardToMatrix` will not send when more than one room is live, and says why:
 *
 *   > Only when exactly one room is waiting. With two, there is no way to tell
 *   > whose answer this is, and guessing would send one person's conversation to
 *   > another — worse than silence, and not undoable.
 *
 * The `prinny` TOOL reaches the same sidecar `reply`, and its own comment makes
 * a second promise about the same identifier:
 *
 *   > `room_id` is omitted from every entry on purpose: the extension fills it
 *   > from `lastInbound`, so it is neither in the schema nor something the model
 *   > can get wrong.
 *
 * ## Where it is not true
 *
 * `lastInbound` is one slot, written by `deliverInbound` on every arrival, under
 * *"Last-write-wins is the right rule: actions with no explicit room are about
 * the message being answered now, and that is the most recent one delivered."*
 * That premise holds for one sender and fails for two — and two is AF1's own
 * ordinary case: pi drains its follow-up queue inside one run, so two messages
 * that arrive while it is busy are consumed by ONE run and both rooms go live.
 * The model sees two `[matrix]` blocks, answers the first, calls
 * `prinny(action:"reply")` — and the second sender receives it.
 *
 * The model cannot fix it by naming the room either: `renderInboundMessage`
 * DROPS `room_id` from what the model sees, deliberately. The one parameter that
 * would disambiguate is the one thing it was never given. `history` and `search`
 * leak the other way — a stranger's conversation read INTO the context.
 *
 * Driven against the REAL extension and the REAL registered tool, in-process,
 * over the real sidecar protocol. **One process per mode**: `awaitingReply` and
 * `lastInbound` are module state and this probe is about what is in them.
 *
 *   run: for m in two-rooms one-room explicit; do \
 *          node v4-the-room-the-tool-guessed.mjs $m; done
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

const MODES = ["two-rooms", "one-room", "explicit"];
const MODE = process.argv[2] ?? "two-rooms";
if (!MODES.includes(MODE)) {
  console.error(`usage: node v4-…mjs <${MODES.join("|")}>`);
  process.exit(2);
}

console.log(`\nv4 [${MODE}] — which room a prinny(…) call is about\n`);

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

// ── the host, keeping the tool this time ─────────────────────────────────────
const handlers = new Map();
const notices = [];
const tools = new Map();

const pi = {
  on: (name, fn) => handlers.set(name, [...(handlers.get(name) ?? []), fn]),
  registerCommand() {},
  registerTool: (spec) => tools.set(spec.name, spec),
  registerEntryRenderer() {},
  appendEntry() {},
  sendUserMessage() {},
};

const ctx = {
  cwd: process.cwd(),
  hasUI: false,
  ui: { notify: (message) => notices.push(String(message)), setStatus() {} },
  getContextUsage: () => ({ tokens: 8_000, contextWindow: 32_768, percent: 24 }),
  compact: (options) => options?.onComplete?.(),
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

let handed = [];
pi.sendUserMessage = (content) => handed.push(String(content));
async function deliver(room, id, body, user) {
  const mark = handed.length;
  post(inbound(room, id, body, user));
  await sleep(250);
  return handed[mark];
}
const echo = (text) => fire("message_end", { message: { role: "user", content: [{ type: "text", text }] } });

await fire("session_start", {});
await sleep(1200);
const prinny = tools.get("prinny");
check("the real prinny tool is registered", Boolean(prinny?.execute));

const ROOM_A = "!alice:example.org";
const ROOM_B = "!bob:example.org";

if (MODE === "two-rooms") {
  console.log("\n   two people, one run, and a tool reply that belongs to one of them\n");

  const askedA = await deliver(ROOM_A, "$a1", "did the nightly build finish?", "Alice");
  const askedB = await deliver(ROOM_B, "$b1", "can you summarise the incident?", "Bob");
  await fire("agent_start", {});
  await echo(askedA);
  await echo(askedB);

  // The premise: neither block carries a room id, so the model has nothing to
  // pass even if it wanted to.
  check("the model is never shown a room id", !askedA.includes(ROOM_A) && !askedB.includes(ROOM_B));
  console.log(`   what the model sees         : ${JSON.stringify(askedA.slice(0, 58))}`);

  const before = sent().length;
  const answer = "The nightly build finished at 03:12 and it is green.";
  const result = await prinny.execute("call-1", { action: "reply", args: { text: answer } });
  await sleep(300);
  const after = sent().slice(before);

  console.log("\n      BEFORE                                     NOW");
  console.log("      ────────────────────────────────────────   ────────────────────────────────────────");
  console.log(`      sent to ${ROOM_B} (lastInbound)   nothing sent; the call is refused`);
  console.log(`      — Bob receives Alice's answer              ${JSON.stringify(String(result).slice(0, 40))}…`);
  console.log("");

  check("nothing is sent", after.length === 0);
  check("the model is told why, in a sentence it can act on", /cannot tell which one/.test(String(result)));
  check("…and told not to retry, because AF1's notice is about to tell both", /do not retry/.test(String(result)));
  check("…and told the parameter that WOULD work if it ever has one", /room_id/.test(String(result)));

  // What `lastInbound` actually held, shown rather than asserted: once the run
  // settles both rooms are retired, so nothing is live and the tool falls back
  // to exactly the value the old code always used.
  await fire("agent_end", {
    messages: [{ role: "assistant", content: [{ type: "text", text: answer }], stopReason: "stop", usage: { output: 20 } }],
  });
  await fire("agent_settled", {});
  await sleep(400);
  const mark = sent().length;
  await prinny.execute("call-2", { action: "reply", args: { text: "(what lastInbound points at)" } });
  await sleep(300);
  const fallback = sent().slice(mark);
  console.log(`   lastInbound points at       : ${fallback[0]?.room}`);
  check(
    "…which is Bob's room — the sender who asked SECOND, not the one being answered",
    fallback[0]?.room === ROOM_B,
  );

  console.log(`
   That last line is the whole finding. The answer above is about Alice's
   question; the slot the tool read points at Bob. \`forwardToMatrix\` refuses in
   exactly this state and calls the alternative "worse than silence, and not
   undoable" — and the tool is the second route into the same \`reply\`.
`);
}

if (MODE === "one-room") {
  console.log("\n   control — one room live, which is the ordinary case\n");
  const asked = await deliver(ROOM_A, "$a2", "did you push the fix?", "Alice");
  await fire("agent_start", {});
  await echo(asked);

  const before = sent().length;
  await prinny.execute("call-1", { action: "reply", args: { text: "Pushed as 4f2a1c." } });
  await sleep(300);
  const after = sent().slice(before);
  console.log(`   what the room received      : ${JSON.stringify(after.map((e) => `${e.room} ${e.text}`))}`);

  check("the reply goes out, unchanged", after.length === 1 && after[0].room === ROOM_A);
  check("…and is marked as sent, so the forwarder does not repeat it", /Pushed as 4f2a1c/.test(after[0].text));
}

if (MODE === "explicit") {
  console.log("\n   control — an explicit room_id still wins, with two rooms live\n");
  const askedA = await deliver(ROOM_A, "$a3", "status?", "Alice");
  const askedB = await deliver(ROOM_B, "$b3", "and mine?", "Bob");
  await fire("agent_start", {});
  await echo(askedA);
  await echo(askedB);

  const before = sent().length;
  await prinny.execute("call-1", { action: "reply", room_id: ROOM_A, args: { text: "Green." } });
  await sleep(300);
  const after = sent().slice(before);
  console.log(`   what was sent               : ${JSON.stringify(after.map((e) => `${e.room} ${e.text}`))}`);

  check("the named room gets it", after.length === 1 && after[0].room === ROOM_A);
  check("…and the other one does not", !after.some((e) => e.room === ROOM_B));
  console.log(`
   That is the case the refusal must not break: acting on a NAMED room stays
   possible, which is what \`history\`/\`search\` on some other room need. The
   refusal is only for the guess.
`);
}

await fire("session_shutdown", {});
console.log("");
if (failures > 0) {
  console.log(`   ${failures} expectation(s) failed`);
  process.exit(1);
}
console.log("   all expectations held");
process.exit(0);
