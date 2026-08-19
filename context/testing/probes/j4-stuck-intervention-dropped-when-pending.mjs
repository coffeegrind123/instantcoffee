/**
 * j4 — V4. `interveneStuck` charges the whole ladder unconditionally and
 *      delivers its directive only `if (!ctx.hasPendingMessages())`.
 *
 * The last rung — the rotating strategy, which is the ONLY thing a stuck
 * intervention actually is at streaks 1 and 2 — is guarded. The two rungs above
 * it are not:
 *
 *   rescue      streak >= 3   scheduleLoopTurn(pi, "rescue", 0, ctx)    unguarded
 *   compaction  streak >= 5   ctx.compact(... scheduleLoopTurn("stuck")) unguarded
 *   strategy    otherwise     if (!ctx.hasPendingMessages()) schedule…   GUARDED
 *
 * So with messages pending the ladder climbs to a model switch and a compaction
 * without ever having sent the cheap rung once — while each skipped intervention
 * still increments the streak, arms three turns of sampling penalties, and
 * clears `turnsWithoutTools`.
 *
 * FIXED. With a message pending the directive is queued onto the turn that is
 * already coming rather than scheduled as a second one, so the iteration is not
 * double-run and the text still arrives.
 *
 * The MODE it is queued in was wrong until the ninth pass, and this probe could
 * not see that: it asks what `pi.sendMessage` was called with, and the defect was
 * on the other side of that call. `deliverAs: "nextTurn"` is drained only by
 * `AgentSession.prompt()` (`agent-session.js:880`) — the operator-typed path — so
 * in an unattended run the directive was never delivered at all. See `m4`, which
 * models the delivery side, and Z4.
 *
 *   node --experimental-strip-types j4-stuck-intervention-dropped-when-pending.mjs clear
 *   node --experimental-strip-types j4-stuck-intervention-dropped-when-pending.mjs pending
 */
const scheduled = [];
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...rest) => {
  scheduled.push(ms);
  return realSetTimeout(fn, ms, ...rest);
};

const { makeHost, statusLines } = await import("./_host.mjs");
const loopExtension = (await import("../../../vendor/pi-loop-mode/extensions/index.ts")).default;

const pending = process.argv[2] === "pending";
const host = makeHost();
host.ctx.hasPendingMessages = () => pending;
loopExtension(host.pi);

console.log(`=== a repeating model, with ctx.hasPendingMessages() === ${pending} ===`);
console.log("    (true is the ordinary state when a background subagent result is queued)\n");
await host.run("start keep the docs in step with the code");

const SAME = "Everything already looks correct; I will keep monitoring the documentation for drift.";
console.log("  turn  notice                                                       what the next turn gets");
console.log("  " + "-".repeat(94));
for (let i = 1; i <= 4; i++) {
  scheduled.length = 0;
  host.sent.length = 0;
  const notice = await host.turn({ messages: [SAME] });
  const now = host.sent.map((m) => m.details?.kind ?? "?");
  const later = scheduled.filter((ms) => ms > 0);
  const queued = host.sent.filter((m) => m.__options?.deliverAs === "steer");
  const verdict = queued.length
    ? `queued "${queued.map((m) => m.details?.kind ?? "?").join(",")}" onto the pending turn`
    : now.length
      ? `"${now.join(",")}" sent now`
      : later.length
        ? `timer: "stuck" in ${later[0] / 1000}s`
        : "NOTHING — no message, no timer";
  console.log(`  ${String(i).padEnd(5)} ${notice.slice(0, 60).padEnd(61)} ${verdict}`);
}
console.log();
console.log(statusLines(await host.run("status"), /^(Interventions|Last notice)/));
console.log(`
BEFORE the fix

  clear     turn 2  timer: "stuck" in 2s
  pending   turn 2  NOTHING — no message, no timer

  The operator saw the same three "Loop stuck (Nx)" notices and the same
  Interventions count either way. Every rung of the ladder was charged either way
  — the streak, the intervention count, three turns of sampling penalties,
  \`turnsWithoutTools\` back to zero — and the two rungs ABOVE the strategy carry no
  such guard, so the ladder escalated to a rescue-model switch at streak 3 and a
  compaction at streak 5 having never once delivered the cheap rung.

NOW

  clear     unchanged: the escalating delay puts it on a timer, which is right —
            nothing else is going to run a turn.
  pending   the directive is queued onto the turn that is already coming. No
            second turn is scheduled, so the iteration is still not double-run,
            and the escalating delay is given up deliberately: its job is to space
            out turns the loop schedules, and this one is not the loop's.

  \`clear\` is the control in both directions.`);
await host.quit();
process.exit(0);
