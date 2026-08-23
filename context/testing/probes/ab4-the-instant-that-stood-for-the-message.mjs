/**
 * ab4 — AO4, the watermark that answered "which message" with "which instant".
 *
 * FIXED — both columns are real and both run the SHIPPED sidecar module, from
 * the staged runtime the sidecar actually boots (`~/.pi/agent/channels/prinny/
 * runtime/dist/queue.js`). The BEFORE column is `message.ts <= watermark.ts`,
 * the expression `enqueue` used to hold, evaluated against the same watermark
 * the NOW column reads. Both share one temporary state directory per case, so
 * the queue file, the watermark file and the ageing rule are the real ones.
 *
 * `origin_server_ts` is set by the SENDER's homeserver. Two homeservers are two
 * clocks, federation delivers out of order, and two events can share a
 * millisecond — so "stamped no later than something I answered" is not
 * "something I answered". `handleInbound` reads `enqueue`'s false as *"Already
 * delivered on an earlier run"* and returns, after the message has already been
 * acknowledged with a reaction: the bot reacts and then never answers.
 *
 *   run: node --experimental-strip-types ab4-the-instant-that-stood-for-the-message.mjs [skew|twin|ancient|redelivery]
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homedir } from "node:os";

const REPO = "/home/claudeuser/qwen3.8-forge";
const RUNTIME =
  process.env.PRINNY_RUNTIME_DIR ??
  join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "channels", "prinny", "runtime");

const MODES = { skew: {}, twin: {}, ancient: {}, redelivery: {} };
const MODE = process.argv[2] ?? "skew";
if (!MODES[MODE]) {
  console.error(`usage: node ab4-…mjs <${Object.keys(MODES).join("|")}>`);
  process.exit(2);
}

let failures = 0;
const check = (label, ok) => {
  console.log(`   ${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) failures++;
};

const NOW = Date.now();
const at = (offset) => NOW + offset;
const message = (id, ts) => ({ id, ts, content: `msg ${id}`, meta: { room_id: "!r:example.org", message_id: id } });

async function loadQueue(stateDir) {
  process.env.PRINNY_STATE_DIR = stateDir;
  // A fresh URL per load: the module captures STATE_DIR at import.
  return import(`${join(RUNTIME, "dist", "queue.js")}?g=${Math.random()}`);
}

console.log(`\nab4 [${MODE}] — the instant that stood for the message (AO4)\n`);
console.log(`   runtime: ${RUNTIME}\n`);

const dir = mkdtempSync(join(tmpdir(), "ab4-prinny-"));
try {
  const q = await loadQueue(dir);
  /** The test `enqueue` used to make, evaluated against the same watermark. */
  const beforeSaysDelivered = (msg) => msg.ts <= q.readWatermark().ts;

  if (MODE === "skew") {
    // Alice's homeserver is 4 seconds behind ours; her message arrives after
    // Bob's has been answered.
    q.writeWatermark(at(-3000), "$bob");
    const alice = message("$alice", at(-4000));
    const before = !beforeSaysDelivered(alice);
    const now = q.enqueue(alice);
    console.log(`   watermark        ts=${at(-3000) - NOW}ms  ids=["$bob"]`);
    console.log(`   alice's message  ts=${at(-4000) - NOW}ms  id="$alice"  — never delivered to anything`);
    console.log("");
    console.log(`     BEFORE  enqueue → ${before}   ${before ? "" : "✘  dropped as 'already delivered'"}`);
    console.log(`     NOW     enqueue → ${now}\n`);
    check("BEFORE a message nobody had ever seen was dropped", before === false);
    check("NOW it is queued", now === true);
    check("…and it is in the queue file, not merely accepted", q.readQueue().some((m) => m.id === "$alice"));
  } else if (MODE === "twin") {
    // Two events in the same millisecond, which one homeserver produces freely.
    q.writeWatermark(at(-3000), "$first");
    const twin = message("$second", at(-3000));
    const before = !beforeSaysDelivered(twin);
    const now = q.enqueue(twin);
    console.log(`   both stamped ${at(-3000) - NOW}ms; one of them has been delivered\n`);
    console.log(`     BEFORE  enqueue → ${before}   ${before ? "" : "✘"}`);
    console.log(`     NOW     enqueue → ${now}\n`);
    check("BEFORE equality was fatal", before === false);
    check("NOW the second one is queued", now === true);
  } else if (MODE === "ancient") {
    // The control. History from before the horizon is still old news, which is
    // the job the watermark was written for.
    q.writeWatermark(at(-3000), "$recent");
    const old = message("$ancient", at(-3000) - q.CLOCK_SKEW_MS - 1);
    const before = !beforeSaysDelivered(old);
    const now = q.enqueue(old);
    console.log(`   horizon = ${q.CLOCK_SKEW_MS / 1000}s; the message is ${((NOW - old.ts) / 1000).toFixed(0)}s old\n`);
    console.log(`     BEFORE  enqueue → ${before}`);
    console.log(`     NOW     enqueue → ${now}\n`);
    check("BEFORE it was refused", before === false);
    check("NOW it is still refused — the catch-up bound is intact", now === false);
  } else {
    // The other control: the thing the watermark exists for still holds.
    q.enqueue(message("$a", at(-3000)));
    await q.flush(async () => undefined);
    const mark = q.readWatermark();
    const again = q.enqueue(message("$a", at(-3000)));
    console.log(`   after delivering $a:  ts=${mark.ts - NOW}ms  ids=${JSON.stringify(mark.ids)}\n`);
    console.log(`     re-offering $a → ${again}\n`);
    check("a delivered message is refused by its id", again === false);
    check("…and the id is what the file remembers", mark.ids.includes("$a"));
    check("…as well as the timestamp", mark.ts === at(-3000));
  }
} finally {
  delete process.env.PRINNY_STATE_DIR;
  rmSync(dir, { recursive: true, force: true });
}

console.log("");
process.exit(failures === 0 ? 0 : 1);
