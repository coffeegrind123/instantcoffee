/**
 * y6 — AL6. The channel stopped and every room went on being told the bot was
 * typing.
 *
 * FIXED — the plan half is EXECUTED through the real `src/typing.ts`; the order
 * half is read out of `extensions/index.ts`, because that file imports pi and
 * typebox and cannot be loaded under `node --test`. Both halves are printed.
 *
 * ## The finding
 *
 * `planStopAll`'s own docstring names its callers:
 *
 *   > Every active room, for the end of a turn **or a shutdown** —
 *   > state-independent on purpose.
 *
 * Two of `stopTyping`'s three callers were the end of a turn. The shutdown was
 * not one of them.
 *
 * `stopChannel` runs on `session_shutdown`, on `/prinny stop`, and on both arms
 * of a restart. It clears the delivery sweep's interval, and says why:
 *
 *   > Nothing can be reported to a room once the sidecar is gone, and the
 *   > sweep's only action is a reply. Cleared here so a stopped channel does not
 *   > keep an interval alive to discover that.
 *
 * Every word of that is true of the typing interval as well, thirty lines up in
 * the same file, and it was not cleared. Two intervals, one file, one of them
 * stopped.
 *
 * What a person sees is the second half: nobody was ever sent `typing: false`,
 * so every room the bot was composing in kept the indicator up until Matrix's
 * own 20 s timeout expired it. The last thing a Matrix user sees of a session
 * that has ended is a bot that appears to still be writing.
 *
 * Ordering is the rest of it. `stopTyping()`'s whole body is outbound calls, and
 * `callSidecar` goes through `requireChannel()`, which reads `child`. So it has
 * to run BEFORE `child = null` — which is exactly the argument AI2 wrote one
 * line above it for `abandonPendingCompaction`.
 *
 *   run: node --experimental-strip-types y6-the-indicator-a-stopped-channel-left-up.mjs
 */

import { readFileSync } from "node:fs";

const REPO = "/home/claudeuser/qwen3.8-forge";
const { planStopAll, planTyping } = await import(`${REPO}/vendor/prinny-channel/src/typing.ts`);

const TYPING_TIMEOUT_MS = 20_000;
const TYPING_REFRESH_MS = 8_000;

let failures = 0;
const check = (label, ok) => {
  console.log(`   ${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) failures++;
};

console.log("\ny6 — the indicator a stopped channel left up (AL6)\n");

// ── 1. what the rooms are told, executed ─────────────────────────────────────
const WAITING = ["!alice:example.org", "!bob:example.org", "!team:example.org"];
const active = new Set(WAITING);

// The refresh, as it runs every 8 s while the model is working.
const refresh = planTyping(WAITING, active);
console.log(`   three rooms waiting; every ${TYPING_REFRESH_MS / 1000}s the channel re-asserts:`);
console.log(`     start: ${refresh.start.length}   stop: ${refresh.stop.length}\n`);

// BEFORE: the channel stops and nothing is planned at all.
const before = { start: [], stop: [] };
// NOW: `stopTyping()` runs, which is `planStopAll(typingRooms)`.
const now = planStopAll(active);

const column = (label, plan) => {
  console.log(`   ${label}`);
  console.log(`     rooms sent "typing: false" : ${plan.stop.length}`);
  console.log(
    `     what each room shows next  : ${
      plan.stop.length === active.size
        ? "nothing — the indicator goes immediately"
        : `a bot still composing, for up to ${TYPING_TIMEOUT_MS / 1000}s`
    }\n`,
  );
};
column("BEFORE (nothing ran)", before);
column("NOW    (stopTyping)  ", now);

check("every room that was told the bot was typing is told it stopped", now.stop.length === WAITING.length);
check("and nothing is started on the way out", now.start.length === 0);
check("BEFORE, no room was told anything", before.stop.length === 0);

// ── 2. where it runs, read from the source ───────────────────────────────────
console.log("   `stopChannel`, in order:\n");
const source = readFileSync(`${REPO}/vendor/prinny-channel/extensions/index.ts`, "utf8");
const start = source.indexOf("async function stopChannel");
const body = source.slice(start, source.indexOf("\n}\n", start));

const marks = [
  ["abandonPendingCompaction()", "abandonPendingCompaction();"],
  ["stopTyping()", "stopTyping();"],
  ["child = null", "child = null;"],
  ["deny every pending permission", "pending.resolve('deny')"],
  ["clearInterval(deliveryTimer)", "clearInterval(deliveryTimer);"],
  ["instance.stop()", "await instance.stop()"],
];
const found = marks
  .map(([label, needle]) => [label, body.indexOf(needle)])
  .filter(([, at]) => at >= 0)
  .sort((a, b) => a[1] - b[1]);
for (const [label] of found) console.log(`     ${label}`);
console.log();

const at = (label) => found.findIndex(([l]) => l === label);
check("the indicator is cleared while the sidecar is still reachable", at("stopTyping()") >= 0 && at("stopTyping()") < at("child = null"));
check(
  "both of this file's intervals are stopped here",
  at("stopTyping()") >= 0 && at("clearInterval(deliveryTimer)") >= 0,
);
check(
  "and it is next to the other call that has to happen while the channel is up",
  Math.abs(at("stopTyping()") - at("abandonPendingCompaction()")) === 1,
);

console.log(failures === 0 ? "   all expectations held\n" : `   ${failures} expectation(s) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
