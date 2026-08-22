/**
 * y4 — AL4. The delivery sweep armed on every arrival and disarmed on a
 * different question.
 *
 * FIXED — this drives the REAL `undeliveredRooms`/`sweepHasWork` over a simulated
 * session of thirty-second ticks and counts how many wake-ups each column costs,
 * with the shipped disarm test reconstructed beside the new one.
 *
 * ## The finding
 *
 * `armDeliverySweep()` starts a 30 s interval on the arrival of ANY inbound
 * message. Stopping it was `sweepUndelivered`'s own job:
 *
 *     if (rooms.length === 0) {
 *       if (deliveryTimer && ![...awaitingReply.values()].some((e) => !e.live)) {
 *         clearInterval(deliveryTimer);
 *       }
 *       return;
 *     }
 *
 * Two questions, not one. The arm is "a message arrived"; the disarm is "nothing
 * is reportable right now AND no entry has `live === false`". Nothing retires a
 * dead entry — `forwardResult` deletes only the LIVE ones, and the sweep
 * deliberately leaves a reported entry in place so a late `markLive` can still
 * deliver the answer — so the moment the sweep reported one message, that entry
 * sat in the map with `live: false, undeliveredReported: true` for good. The
 * first half of the disarm passed forever and the second half could never pass
 * again.
 *
 * It needs no failure at all to reproduce: a Matrix `/loop status` arms the
 * sweep on arrival and is marked `answered`, which is `live: false` for good.
 * One command is enough.
 *
 * The interval is `unref`'d, so this never held a process open. What makes it
 * worth fixing is the shape: **an ending whose condition can no longer be
 * reached is not an ending.**
 *
 * The control lives thirty lines up in the same file: `applyTyping` arms and
 * disarms the typing interval on one predicate, `typingRooms.size`, in one
 * place. Two intervals, one file, one of them symmetric.
 *
 *   run: node --experimental-strip-types y4-the-sweep-that-could-not-stop.mjs [undelivered|command|answered]
 */

const REPO = "/home/claudeuser/qwen3.8-forge";
const { DELIVERY_GRACE_MS, sweepHasWork, undeliveredRooms } = await import(
  `${REPO}/vendor/prinny-channel/src/delivery.ts`
);

/** How long the probe runs the session for, in sweeps. */
const SWEEP_MS = 30_000;
const TICKS = 120; // one hour of session

const MODES = {
  /** pi refused one message: the sweep reports it and the entry stays. */
  undelivered: { answered: false, reports: 1, stopsAt: 2, beforeStops: false },
  /** `/loop status` from Matrix: performed here, never handed to pi. */
  command: { answered: true, reports: 0, stopsAt: 1, beforeStops: false },
  /** pi took the message and the answer went out — the control, in both columns. */
  answered: { answered: false, live: true, reports: 0, stopsAt: 1, beforeStops: true },
};

const MODE = process.argv[2] ?? "undelivered";
if (!MODES[MODE]) {
  console.error(`usage: node y4-…mjs <${Object.keys(MODES).join("|")}>`);
  process.exit(2);
}
const spec = MODES[MODE];

let failures = 0;
const check = (label, ok) => {
  console.log(`   ${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) failures++;
};

/** The disarm test as it shipped. */
const beforeDisarm = (entries) => ![...entries.values()].some((entry) => !entry.live);
/** The disarm test now: the arm test, asked without the clock. */
const nowDisarm = (entries) => !sweepHasWork(entries.entries());

/**
 * One session: a message arrives at t=0, the sweep runs every 30 s, and the
 * timer stops when the column's own disarm says so.
 */
function runSession(disarm) {
  const at = 0;
  const map = new Map([
    ["!room:example.org", { at, live: spec.live ?? false, answered: spec.answered }],
  ]);
  let armed = true;
  let sweeps = 0;
  let reported = 0;
  let stoppedAt;

  for (let tick = 1; tick <= TICKS && armed; tick++) {
    const now = at + tick * SWEEP_MS;
    sweeps++;
    for (const room of undeliveredRooms(map.entries(), now, false)) {
      const entry = map.get(room);
      entry.undeliveredReported = true;
      reported++;
    }
    if (disarm(map)) {
      armed = false;
      stoppedAt = tick;
    }
  }
  return { sweeps, reported, armed, stoppedAt };
}

console.log(`\ny4 [${MODE}] — the sweep that could not stop (AL4)\n`);
console.log(`   the entry:            ${JSON.stringify({ live: spec.live ?? false, answered: spec.answered })}`);
console.log(`   grace before a verdict: ${DELIVERY_GRACE_MS / 1000}s`);
console.log(`   sweep period:          ${SWEEP_MS / 1000}s, watched for ${(TICKS * SWEEP_MS) / 60000} minutes\n`);

const before = runSession(beforeDisarm);
const now = runSession(nowDisarm);

const column = (label, r) => {
  console.log(`   ${label}`);
  console.log(`     messages reported     : ${r.reported}`);
  console.log(`     sweeps run            : ${r.sweeps}`);
  console.log(`     interval still armed  : ${r.armed ? "yes — for the rest of the session" : `no, stopped at sweep ${r.stoppedAt}`}\n`);
};

column("BEFORE", before);
column("NOW   ", now);

check("the verdict is unchanged — the report still happens, once", now.reported === spec.reports && before.reported === spec.reports);
check("the interval stops", now.armed === false);
check(
  "on the sweep that finished the work, not the one after",
  now.stoppedAt === spec.stopsAt,
);
if (spec.beforeStops) {
  console.log("   this mode is the control: a room pi TOOK the message from goes");
  console.log("   live, and `!entry.live` was false for it — so the shipped disarm");
  console.log("   worked here, and only here.\n");
  check("BEFORE stopped too, which is why the defect was invisible", before.armed === false);
} else {
  check("BEFORE it never did", before.armed === true);
}

console.log("   an hour of session is 120 wake-ups over a map that only grows;");
console.log("   a day is 2,880. Unref'd throughout, so nothing was held open.\n");

console.log(failures === 0 ? "   all expectations held\n" : `   ${failures} expectation(s) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
