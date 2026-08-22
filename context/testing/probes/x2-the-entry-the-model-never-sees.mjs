/**
 * x2 — the property the whole transcript design rests on, measured.
 *
 * The operator asked for a subagent's turns to be in the session transcript the
 * rest of the session goes into. Putting a child's whole reasoning into the
 * PARENT's session is only affordable if it costs the parent's context nothing,
 * and the nineteenth pass's handoff wrote the reading down and then said, in as
 * many words:
 *
 *   > The one thing to measure before building it — this repo's own rule: write
 *   > a single `appendEntry` from inside a spawn, run a delegation, then compact
 *   > the parent twice and re-read the session file. The reading above says the
 *   > entry survives and never costs a token; confirm it on a real session
 *   > before designing around it, because everything else here depends on that
 *   > one property.
 *
 * This is that measurement, against pi 0.84.2's own `SessionManager` — the
 * class that writes the file and the class that builds what goes to the model —
 * rather than against a reading of it. It writes a real session file in a temp
 * directory, appends the same `type: "custom"` entries `AgentTranscript` writes,
 * compacts twice, and reports three things separately:
 *
 *   1. what the model is sent            buildSessionContext().messages
 *   2. what the transcript renders       getEntries()
 *   3. what survived on disk             the JSONL, re-read from scratch
 *
 * The interesting failure is (1) being non-empty: that would mean every
 * delegation's reasoning is charged to the parent's window, on a 32k box, and
 * the design is wrong rather than merely unproven.
 *
 *   run: node x2-the-entry-the-model-never-sees.mjs
 */

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PI_DIST = "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist";
const REPO = "/home/claudeuser/qwen3.8-forge";

let failures = 0;
const check = (label, ok) => {
  console.log(`   ${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) failures++;
};

console.log("\nx2 — what a subagent's transcript entry costs the parent's context\n");

const { SessionManager } = await import(`${PI_DIST}/index.js`);
const { SUBAGENT_ENTRY_TYPE } = await import(`${REPO}/vendor/pi-subagents-lite/src/agents/transcript-entry.ts`);

const dir = mkdtempSync(join(tmpdir(), "probe-transcript-"));
const session = SessionManager.create(dir, dir);

const userMessage = (text) => ({ role: "user", content: [{ type: "text", text }] });
const assistantMessage = (text) => ({ role: "assistant", content: [{ type: "text", text }] });

// ── one ordinary turn, one delegation, one more ordinary turn ────────────────
session.appendMessage(userMessage("find every call site of foo()"));
session.appendMessage(assistantMessage("I will delegate that."));

const CHILD_LINES = [
  "2026-08-22T10:00:00.000Z [USER] find every call site of foo()",
  "2026-08-22T10:00:01.000Z [THINKING] I should grep for it rather than read every file.",
  "2026-08-22T10:00:02.000Z [TOOL] bash(grep -rn 'foo(' src)",
  "2026-08-22T10:00:03.000Z [ASSISTANT] Three: src/a.ts:12, src/b.ts:40, src/c.ts:7.",
];
const entryIds = [];
entryIds.push(
  session.appendCustomEntry(SUBAGENT_ENTRY_TYPE, {
    agentId: "abcdef1234",
    shortId: "abcdef",
    agentType: "explore",
    phase: "brief",
    description: "find call sites of foo()",
    lines: ["find every call site of foo()"],
  }),
);
entryIds.push(
  session.appendCustomEntry(SUBAGENT_ENTRY_TYPE, {
    agentId: "abcdef1234",
    shortId: "abcdef",
    agentType: "explore",
    phase: "turn",
    turn: 1,
    lines: CHILD_LINES,
  }),
);
entryIds.push(
  session.appendCustomEntry(SUBAGENT_ENTRY_TYPE, {
    agentId: "abcdef1234",
    shortId: "abcdef",
    agentType: "explore",
    phase: "done",
    lines: ["explore completed: 1 turn(s), 1 tool use(s), 812 token(s), check passed"],
  }),
);
session.appendMessage(assistantMessage("Three call sites: a.ts, b.ts, c.ts."));

const before = session.buildSessionContext();
const childText = CHILD_LINES.join("\n");
const asText = (messages) => JSON.stringify(messages);

console.log("   the parent's context, with the delegation's transcript in the session:");
for (const message of before.messages) {
  const text = (message.content ?? [])
    .map((part) => part.text ?? "")
    .join(" ")
    .slice(0, 60);
  console.log(`     ${String(message.role).padEnd(10)} ${text}`);
}
console.log();

check(
  "the child's turn is NOT a context message",
  !asText(before.messages).includes("I should grep for it rather than read every file"),
);
check(
  "…nor is the brief, nor the closing line",
  !asText(before.messages).includes("explore completed") &&
    !asText(before.messages).includes("find call sites of foo()"),
);
check(
  "the parent's own turns are all still there",
  before.messages.length === 3 &&
    asText(before.messages).includes("find every call site of foo()") &&
    asText(before.messages).includes("Three call sites"),
);
check("the entries exist in the transcript", session.getEntries().filter((e) => e.type === "custom").length === 3);

// ── compact twice, which is the case the handoff asked about ────────────────
const keepFrom = session.getEntries().find((entry) => entry.type === "message")?.id;
session.appendCompaction("summary one", keepFrom, 20_000, undefined, false);
session.appendMessage(assistantMessage("after the first compaction"));
session.appendCompaction("summary two", keepFrom, 21_000, undefined, false);
session.appendMessage(assistantMessage("after the second compaction"));

const after = session.buildSessionContext();
check(
  "after two compactions the child's reasoning is still not context",
  !asText(after.messages).includes("I should grep for it rather than read every file"),
);
check(
  "…and the entries are still in the session's own entry list",
  session.getEntries().filter((entry) => entry.type === "custom").length === 3,
);

// ── and on disk, read back with nothing in memory ────────────────────────────
const file = session.getSessionFile();
const raw = readFileSync(file, "utf8");
const lines = raw.split("\n").filter(Boolean).map((line) => JSON.parse(line));
const persisted = lines.filter((entry) => entry.type === "custom" && entry.customType === SUBAGENT_ENTRY_TYPE);
check("all three entries are on disk", persisted.length === 3);
check("…with the child's own lines intact", JSON.stringify(persisted).includes(childText.split("\n")[1]));
check(
  "…and each one names the agent it came from",
  persisted.every((entry) => entry.data?.agentId === "abcdef1234" && entry.data?.shortId === "abcdef"),
);

const reopened = SessionManager.open(file, dir);
check(
  "a session re-opened from that file still shows them",
  reopened.getEntries().filter((entry) => entry.type === "custom").length === 3,
);
check(
  "…and still sends the model none of them",
  !asText(reopened.buildSessionContext().messages).includes("I should grep for it"),
);

console.log(`\n   session file: ${file}`);
console.log(`   ${lines.length} entries on disk, ${persisted.length} of them a subagent's turns\n`);
console.log(
  failures === 0
    ? "   all expectations held — a custom entry persists, renders, and is never context\n"
    : `   ${failures} expectation(s) FAILED\n`,
);
process.exit(failures === 0 ? 0 : 1);
