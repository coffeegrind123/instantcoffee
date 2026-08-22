/**
 * y5 — AL5. The widget's 80 ms refresh started on the first delegation and ran
 * for the rest of the session, sorting a map that only grows, to draw nothing.
 *
 * FIXED — this drives the REAL `AgentWidget` and the REAL `AgentManager`,
 * counts the ticks and the work each tick does, and prints what a session that
 * delegates once an hour actually pays.
 *
 * ## The finding
 *
 * `ensureTimer()` armed a `setInterval` at `WIDGET_REFRESH_INTERVAL`.
 * `SpawnCoordinator.spawn` and the menu wizard call it on every spawn.
 * `dispose()` at `session_shutdown` was the only clear.
 *
 * `update()` had the right test and did the wrong thing with it:
 *
 *     if (!hasActive && !hasFinished) {
 *       if (this.widgetRegistered || this.lastStatusText !== undefined) this.clearWidget();
 *       return;                       // ← returning is not stopping
 *     }
 *
 * So the interval kept firing after the last row aged out of the retention
 * window. Each tick calls `categorizeAgents()` → `listAgents()`, which COPIES
 * and SORTS every record the manager has ever held, and nothing prunes that map:
 * a settled record stays until the operator Clears it or the session ends. An
 * unattended `/loop` that delegates each iteration therefore made the tick more
 * expensive the longer it ran — forever, to draw nothing.
 *
 * It was also the one long-lived INTERVAL in the stack not `unref`'d. The other
 * three each say so out loud ("never hold the process open for a typing
 * indicator", …).
 *
 * The fix has two halves and only one of them is a `stopTimer()`. `update()`
 * can only stop if something is guaranteed to start it again, and the hook that
 * does — `AgentManager.onStart`, which `startAgent` has called since the package
 * was written — **was a constructor parameter with no setter, constructed with
 * `undefined`**. It was wired to nothing. Stopping the timer is what made that
 * visible.
 *
 *   run: node y5-the-eighty-millisecond-poll-nobody-stopped.mjs [idle|active|continuation]
 */

import { createJiti } from "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";
const PI = "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
const NM = "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules";
// The widget imports pi-tui directly, and pi keeps its scoped packages under its
// own node_modules rather than at the top level. h6 never needed this because
// the manager does not draw anything.
const jiti = createJiti(`file://${PI}`, {
  interopDefault: true,
  alias: {
    "@earendil-works/pi-coding-agent": PI,
    "@earendil-works/pi-tui": `${NM}/@earendil-works/pi-tui`,
  },
});
const R = "/home/claudeuser/qwen3.8-forge/vendor/pi-subagents-lite/src";

const { AgentManager } = await jiti.import(`${R}/agents/agent-manager.ts`);
const { AgentWidget } = await jiti.import(`${R}/ui/agent-widget.ts`);

const MODES = {
  /** The finding: delegations that have all finished and aged out. */
  idle: {},
  /** A delegation still running — the timer must stay armed. */
  active: {},
  /** A settled record put back to running: the one route that is not a spawn. */
  continuation: {},
};

const MODE = process.argv[2] ?? "idle";
if (!MODES[MODE]) {
  console.error(`usage: node y5-…mjs <${Object.keys(MODES).join("|")}>`);
  process.exit(2);
}

let failures = 0;
const check = (label, ok) => {
  console.log(`   ${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) failures++;
};

const HOUR = 3_600_000;

/** A record in the state a settled delegation leaves one in. */
function record(id, status, completedAt) {
  return {
    id,
    lifecycle: { status, startedAt: completedAt - 1000, completedAt, started: true },
    display: { type: "general-purpose", description: `job ${id}` },
    execution: { modelKey: "forge/qwen3.8-27b", holdsSlot: false, settled: true, settlementCount: 1 },
    stats: { lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 }, toolUses: 0, turnCount: 1, compactionCount: 0 },
    result: "done",
  };
}

const manager = new AgentManager();
const widget = new AgentWidget(manager, () => undefined);

/** Count what one tick of the poll costs, without waiting for wall-clock time. */
let sorts = 0;
const realList = manager.listAgents.bind(manager);
manager.listAgents = () => {
  sorts++;
  return realList();
};

// A UI context the widget will accept, recording nothing.
widget.setUICtx({
  setStatus() {},
  setWidget() {},
  clearWidget() {},
  requestRender() {},
  notify() {},
});

const now = Date.now();
// Fifty finished delegations, all of them older than the retention window —
// an unattended run's afternoon.
const stale = now - 60 * HOUR;
for (let i = 0; i < 50; i++) manager.agents.set(`agent-${i}`, record(`agent-${i}`, "completed", stale + i));
if (MODE === "active") manager.agents.set("agent-live", record("agent-live", "running", now));

console.log(`\ny5 [${MODE}] — the 80 ms poll nobody stopped (AL5)\n`);
console.log(`   records the manager is holding : ${manager.agents.size}`);
console.log(`   of them, inside the retention window : ${MODE === "active" ? 1 : 0}\n`);

widget.ensureTimer();
const armedAfterSpawn = Boolean(widget.widgetInterval);
widget.update();
const armedAfterUpdate = Boolean(widget.widgetInterval);

console.log("   BEFORE");
console.log("     update() returned early and left the interval running.");
console.log(`     one tick sorts ${manager.agents.size} records; an hour is 45,000 ticks,`);
console.log("     and the record count only ever goes up.\n");

console.log("   NOW");
console.log(`     armed by the spawn        : ${armedAfterSpawn}`);
console.log(`     still armed after update(): ${armedAfterUpdate}`);
console.log(`     listAgents() calls so far : ${sorts}\n`);

check("a spawn arms the poll", armedAfterSpawn === true);

if (MODE === "active") {
  check("a running delegation keeps it armed", armedAfterUpdate === true);
  console.log("   the control: there is something to draw, so the poll must not stop.\n");
} else if (MODE === "continuation") {
  // The route back into "there is something to show" that is NOT a spawn.
  check("with nothing to draw, the poll stops", armedAfterUpdate === false);
  let started = 0;
  manager.setOnStart(() => {
    started++;
    widget.ensureTimer();
  });
  manager.agents.get("agent-0").lifecycle.status = "running";
  manager.onStart?.(manager.agents.get("agent-0"));
  console.log(`   a settled record goes back to running: onStart fired ${started} time(s)`);
  console.log(`   re-armed: ${Boolean(widget.widgetInterval)}\n`);
  console.log("   BEFORE, `onStart` had no setter at all and was constructed with");
  console.log("   `undefined` — the hook `startAgent` has always called was wired");
  console.log("   to nothing. Stopping the timer is what made that visible.\n");
  check("the manager exposes the hook", typeof manager.setOnStart === "function");
  check("a continuation announces itself", started === 1);
  check("…and the poll comes back", Boolean(widget.widgetInterval) === true);
} else {
  check("with nothing to draw, the poll stops", armedAfterUpdate === false);
  const before = sorts;
  widget.update();
  console.log(`   a further update() costs ${sorts - before} more sort(s) and re-arms nothing.\n`);
}

widget.dispose();
console.log(failures === 0 ? "   all expectations held\n" : `   ${failures} expectation(s) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
