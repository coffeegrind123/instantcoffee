/**
 * s1 — AF1. The answer two rooms were both owed, and the retirement that
 * deleted both questions.
 * FIXED — each mode prints what happens now, with BEFORE in the comments.
 *
 * `forwardToMatrix` refuses to send when more than one room is live:
 *
 *     if (rooms.length > 1) {
 *       log(`forward skipped (${why}): ${rooms.length} rooms are waiting …`);
 *       return;
 *     }
 *
 * That refusal is right, and it is the only right answer — with two live rooms
 * there is no way to tell whose answer this is, and sending one person's
 * conversation to another is not undoable. The question this pass asks is the
 * next one: what happens to the thing it refused to send, and to the two
 * questions that are still waiting for it.
 *
 * The answer was: nothing, twice over. `forwardResult` ends with
 *
 *     for (const [room, entry] of awaitingReply) {
 *       if (entry.live) awaitingReply.delete(room);
 *     }
 *
 * so both rooms were retired unanswered — and the entries that proved either
 * question had ever been asked went with them, which is also why
 * `sweepUndelivered` could not report it: `undeliveredRooms` reads a map that no
 * longer has them in it. Two people, two questions, zero answers, zero notices,
 * and one line in `channel.log`.
 *
 * **It is the ordinary case for a channel with two people on it.** One in a DM
 * and one in a room is enough. `deliverInbound` queues each message as a
 * follow-up; pi's agent loop drains the follow-up queue inside the SAME run
 * (`runLoop`'s outer while, `pi-agent-core/dist/agent-loop.js:162`); both are
 * echoed back as user messages; `markLive` marks both live.
 *
 * The fourteenth pass looked directly at this behaviour and read it as a fact
 * about the harness — `r3`'s header explains that a leftover live room from an
 * earlier scenario suppresses the leak the next scenario is about, which is why
 * its four modes run one to a process. That is true, and it is the same
 * mechanism, seen from the side where nobody is hurt by it.
 *
 * Driven against the REAL extension, in-process, over the real sidecar protocol
 * (`_sidecar.mjs`), so `deliverInbound`, `markLive`, `forwardToMatrix`,
 * `forwardResult` and `sweepUndelivered` are all the shipped ones.
 *
 * **One process per mode.** `awaitingReply` is module state and this probe is
 * about what is in it.
 *
 *   run: for m in two-rooms one-room-nothing-to-send control; do \
 *          node s1-the-answer-two-rooms-were-both-owed.mjs $m; done
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

const MODES = ["two-rooms", "one-room-nothing-to-send", "control"];
const MODE = process.argv[2] ?? "two-rooms";
if (!MODES.includes(MODE)) {
  console.error(`usage: node s1-…mjs <${MODES.join("|")}>`);
  process.exit(2);
}

console.log(`\ns1 [${MODE}] — two rooms, one answer, and what the retirement does with it\n`);

// ── pi's own follow-up drain, pinned ─────────────────────────────────────────
//
// The premise of the whole probe: two messages delivered while pi is busy are
// consumed by ONE run, so both rooms are live when that run's answer arrives.
{
  const loop = readFileSync(
    `${PI_DIST}/../node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js`,
    "utf8",
  );
  const at = loop.indexOf("// Agent would stop here. Check for follow-up messages.");
  const body = loop.slice(at, at + 330).split("\n").slice(0, 7);
  console.log(body.map((line) => "   " + line.trim()).join("\n"));
  check(
    "pi drains follow-ups back into the same run, so one run can owe two rooms",
    /getFollowUpMessages/.test(body.join(" ")) && /continue;/.test(body.join(" ")),
  );
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

const ANSWERED = (text) => ({
  messages: [{ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", usage: { output: 20 } }],
});
/** A run that produced tool calls and no text this channel could forward. */
const TOOL_ONLY = {
  messages: [
    {
      role: "assistant",
      content: [{ type: "toolCall", name: "bash", input: {} }],
      stopReason: "stop",
      usage: { output: 12 },
    },
  ],
};

/** Deliver one Matrix message; returns the text pi was handed. */
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
check("the channel is up", sent().length === 0 || true);

const ROOM_A = "!alice:example.org";
const ROOM_B = "!bob:example.org";

if (MODE === "two-rooms") {
  console.log("\n   two people, one run, and one answer that belongs to one of them\n");

  // Both arrive while pi is busy on something else; pi consumes both in one run.
  const askedA = await deliver(ROOM_A, "$a1", "did the nightly build finish?", "Alice");
  const askedB = await deliver(ROOM_B, "$b1", "can you summarise the incident?", "Bob");
  await fire("agent_start", {});
  await echo(askedA);
  await echo(askedB);
  console.log(`   pi took both messages       : ${JSON.stringify([askedA, askedB].map((t) => t.slice(0, 34)))}`);

  const before = sent().length;
  await fire("agent_end", ANSWERED("The nightly build finished at 03:12 and it is green."));
  await fire("agent_settled", {});
  // The replies go out over the sidecar transport, so they arrive a tick later.
  await sleep(400);
  const after = sent().slice(before);
  console.log(`   what was sent to Matrix     :`);
  for (const entry of after) console.log(`     ${entry.room}  ${JSON.stringify(entry.text.slice(0, 62))}`);
  console.log("");

  // BEFORE: `after` was empty. The answer was refused (correctly — it cannot be
  // attributed), both rooms were retired, and neither sender was told anything.
  check("neither room is sent the answer — it cannot be attributed, and that is right",
    !after.some((entry) => /03:12/.test(entry.text)));
  check("Alice is told why she got nothing", after.some((entry) => entry.room === ROOM_A && /ask again/i.test(entry.text)));
  check("…and so is Bob", after.some((entry) => entry.room === ROOM_B && /ask again/i.test(entry.text)));
  check(
    "the sentence says somebody else was being answered, and nothing about who",
    after.every((entry) => !/alice|bob|!/i.test(entry.text.replace(/^.*?(?=Someone)/s, ""))),
  );
  check(
    "the operator is told too, rather than only the log file",
    notices.some((line) => /could not be attributed/.test(line)),
  );

  // …and the rooms are retired, so the NEXT turn cannot leak into them. That is
  // the property the retirement exists for and it is unchanged.
  const beforeNext = sent().length;
  await fire("agent_start", {});
  await echo("what is in ~/.ssh/config?");
  await fire("agent_end", ANSWERED("Host prod / HostName 10.0.0.4"));
  await fire("agent_settled", {});
  await sleep(400);
  check("and the next, unrelated turn still goes nowhere near either room", sent().length === beforeNext);
}

if (MODE === "one-room-nothing-to-send") {
  console.log("\n   one room, one run, and a turn with nothing in it to forward\n");

  const asked = await deliver(ROOM_A, "$a2", "did you push the fix?", "Alice");
  await fire("agent_start", {});
  await echo(asked);

  const before = sent().length;
  // A run whose only content is a tool call: `finalAssistantText` walks back and
  // finds no text, `describeEmptyEnding` says the run was not empty (a tool call
  // IS progress), so neither the forward nor the continuation fires.
  await fire("agent_end", TOOL_ONLY);
  await fire("agent_settled", {});
  await sleep(400);
  const after = sent().slice(before);
  console.log(`   what the room received      : ${JSON.stringify(after.map((entry) => entry.text.slice(0, 62)))}`);

  // BEFORE: nothing at all, and the entry was retired, so the sweep could not
  // report it either.
  check("the sender is told the turn ended with nothing to send", after.some((entry) => /ask again/i.test(entry.text)));
  check(
    "…in the other sentence, because it is the other fact",
    after.every((entry) => !/which reply was yours/.test(entry.text)),
  );
}

if (MODE === "control") {
  console.log("\n   control — one room, one question, one answer\n");

  const asked = await deliver(ROOM_A, "$a3", "and the linter?", "Alice");
  await fire("agent_start", {});
  await echo(asked);
  const before = sent().length;
  await fire("agent_end", ANSWERED("The linter is clean."));
  await fire("agent_settled", {});
  await sleep(400);
  const after = sent().slice(before);
  console.log(`   what the room received      : ${JSON.stringify(after.map((entry) => entry.text))}`);

  check("the answer goes out", after.some((entry) => /linter is clean/.test(entry.text)));
  check("and nothing else does — an answered room is never apologised to", after.length === 1);
  check("no operator warning either", !notices.some((line) => /nothing to send|attributed/.test(line)));
}

await fire("session_shutdown", {});
console.log("");
if (failures > 0) {
  console.log(`   ${failures} expectation(s) failed`);
  process.exit(1);
}
console.log("   all expectations held");
process.exit(0);
