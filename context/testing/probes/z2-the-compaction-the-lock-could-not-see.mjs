/**
 * z2 — AM2. Three senders ask "is somebody compacting this session right now?"
 * and all three could only ever see the two EXTENSIONS that compact. The third
 * compactor is pi, and it is the one that compacts most.
 *
 * FIXED — this loads the REAL `.pi/extensions/compaction-guard` and reads the
 * lock through the REAL `vendor/pi-subagents-lite` copy, i.e. through one of the
 * three actual readers.
 *
 * ## The bound this closes
 *
 * The handoff has carried it as open for seven passes:
 *
 *   > the compaction lock can only be read for compactions an *extension* asked
 *   > for. pi emits `compaction_start` internally (`agent-session.js:1370`) but
 *   > not as an `ExtensionEvent`.
 *
 * True about `compaction_start`, and it is the wrong event.
 * `session_before_compact` IS an `ExtensionEvent` and pi emits it from BOTH
 * compaction entry points — `compact()` at `:1389` and `_runAutoCompaction()` at
 * `:1613` — for every reason, whenever any extension has a handler. Two in this
 * stack do.
 *
 * ## The window that matters
 *
 *     _handlePostAgentRun()  :776  _isAgentRunActive TRUE  → a sender QUEUES
 *     prompt()               :865  _isAgentRunActive FALSE → _runAgentPrompt,
 *                                                            which checks nothing
 *
 * `prompt()` is what an operator's typed message reaches and what
 * `prinny-channel`'s `sendUserMessage` reaches. So a Matrix message arriving on
 * a session over the compaction threshold opens a multi-second window in which
 * the session reads as idle and the lock reads as free.
 *
 *   run: node --experimental-strip-types z2-the-compaction-the-lock-could-not-see.mjs [parent|child|extension|release]
 */

const REPO = "/home/claudeuser/qwen3.8-forge";
const guardModule = await import(`${REPO}/.pi/extensions/compaction-guard/index.ts`);
const guard = guardModule.default;
const { resetCompactionLock } = await import(`${REPO}/.pi/extensions/compaction-guard/src/compaction-lock.ts`);
// The READERS, by their own copies — this is what each sender actually calls.
const nudgeReader = await import(`${REPO}/vendor/pi-subagents-lite/src/spawn/compaction-lock.ts`);
const loopReader = await import(`${REPO}/vendor/pi-loop-mode/src/compaction-lock.ts`);
const prinnyReader = await import(`${REPO}/vendor/prinny-channel/src/compaction-lock.ts`);

const MODES = {
  /** The finding: pi's own compaction, in the operator's session. */
  parent: {},
  /** The control that had to be got right: a CHILD's compaction is not the parent's. */
  child: {},
  /** The control: a compaction an extension asked for keeps ITS owner. */
  extension: {},
  /** The control: every rung that ends the hold, including the ones pi never signals. */
  release: {},
};

const MODE = process.argv[2] ?? "parent";
if (!MODES[MODE]) {
  console.error(`usage: node z2-…mjs <${Object.keys(MODES).join("|")}>`);
  process.exit(2);
}

let failures = 0;
const check = (label, ok) => {
  console.log(`   ${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) failures++;
};

const SPAWN_DEPTH = "__PI_SUBAGENT_SPAWN_DEPTH__";

/** The guard, loaded the way pi loads it — with the spawn depth of the session. */
function loadGuard({ inChild = false } = {}) {
  const handlers = new Map();
  const pi = {
    on(name, fn) {
      handlers.set(name, [...(handlers.get(name) ?? []), fn]);
    },
  };
  const window = 32_768;
  const ctx = {
    ui: { notify() {} },
    model: { contextWindow: window },
    getContextUsage: () => ({ tokens: 13_107, contextWindow: window, percent: 40 }),
  };
  if (inChild) globalThis[SPAWN_DEPTH] = 1;
  else delete globalThis[SPAWN_DEPTH];
  guard(pi);
  delete globalThis[SPAWN_DEPTH];
  return {
    async fire(name, event = {}) {
      for (const fn of handlers.get(name) ?? []) await fn(event, ctx);
    },
    registered: () => [...handlers.keys()],
  };
}

/** What each of the three senders would decide, right now. */
function senders() {
  return {
    "subagents nudge": nudgeReader.compactionInFlight()?.owner,
    "loop turn": loopReader.compactionInFlight()?.owner,
    "prinny continuation": prinnyReader.compactionInFlight()?.owner,
  };
}

function report(label, seen) {
  console.log(`   ${label}`);
  for (const [who, owner] of Object.entries(seen)) {
    console.log(`     ${who.padEnd(22)} sees : ${owner ?? "nothing — it will send"}`);
  }
  console.log("");
}

console.log(`\nz2 [${MODE}] — the compaction the lock could not see (AM2)\n`);

if (MODE === "parent") {
  console.log("   pi is about to compact the OPERATOR's session (threshold, or the");
  console.log("   pre-prompt check a typed message triggers).\n");

  resetCompactionLock();
  // BEFORE: nothing took the lock for pi, so `session_before_compact` changed
  // nothing a reader could see.
  const before = senders();
  report("BEFORE", before);

  resetCompactionLock();
  const host = loadGuard();
  await host.fire("session_before_compact", { reason: "threshold", preparation: { previousSummary: "" } });
  const now = senders();
  report("NOW", now);

  check("BEFORE all three would have sent into it", Object.values(before).every((o) => o === undefined));
  check("NOW all three defer", Object.values(now).every((o) => o === "pi"));
  check("…and the holder is named as the host, not as the guard", now["loop turn"] === "pi");
  resetCompactionLock();
} else if (MODE === "child") {
  console.log("   a SUBAGENT compacts its own window. The lock is process-global and");
  console.log("   the question is per-session, so a child taking it would defer the");
  console.log("   PARENT's loop turns and delegation results.\n");

  resetCompactionLock();
  const child = loadGuard({ inChild: true });
  await child.fire("session_before_compact", { reason: "threshold", preparation: { previousSummary: "" } });
  report("a child's compaction", senders());
  check("the child takes nothing", nudgeReader.compactionInFlight() === undefined);

  // And the other half: a child's turn ending must not release the parent's.
  resetCompactionLock();
  const parent = loadGuard();
  await parent.fire("session_before_compact", { reason: "threshold", preparation: { previousSummary: "" } });
  const child2 = loadGuard({ inChild: true });
  await child2.fire("agent_settled");
  await child2.fire("session_compact", { reason: "threshold" });
  report("the parent's, with a child settling under it", senders());
  check("a child's turn ending is not the parent's compaction ending", nudgeReader.compactionInFlight()?.owner === "pi");
  resetCompactionLock();
} else if (MODE === "extension") {
  console.log("   `pi-loop-mode`'s emergency compaction takes the lock and THEN calls");
  console.log("   ctx.compact(), which emits session_before_compact — so the guard's");
  console.log("   handler runs inside somebody else's hold on the ordinary path.\n");

  resetCompactionLock();
  loopReader.beginCompaction(loopReader.LOOP_OWNER);
  const host = loadGuard();
  await host.fire("session_before_compact", { reason: "manual", preparation: { previousSummary: "" } });
  report("while the loop holds it", senders());
  check("the loop still owns its own compaction", nudgeReader.compactionInFlight()?.owner === "pi-loop-mode");

  await host.fire("session_compact", { reason: "manual" });
  await host.fire("agent_settled");
  report("…and after every release the guard has", senders());
  check("only the owner can release it", nudgeReader.compactionInFlight()?.owner === "pi-loop-mode");
  loopReader.endCompaction(loopReader.LOOP_OWNER);
  check("…which it then does", nudgeReader.compactionInFlight() === undefined);
} else {
  console.log("   `session_compact` fires only on the SUCCESS path. A compaction the");
  console.log("   operator cancelled with Esc (interactive-mode.js:2703 →");
  console.log("   session.abortCompaction()) has NO closing extension event at all, so");
  console.log("   one rung would leave the hold to run to STALE_MS — five minutes of an");
  console.log("   unattended loop deferring every turn.\n");

  for (const rung of ["session_compact", "agent_start", "agent_settled", "session_shutdown"]) {
    resetCompactionLock();
    const host = loadGuard();
    await host.fire("session_before_compact", { reason: "threshold", preparation: { previousSummary: "" } });
    const held = nudgeReader.compactionInFlight()?.owner;
    await host.fire(rung, { reason: "threshold" });
    const after = nudgeReader.compactionInFlight()?.owner;
    console.log(`     ${rung.padEnd(20)} held=${held ?? "-"}  after=${after ?? "released"}`);
    check(`${rung} releases pi's hold`, held === "pi" && after === undefined);
  }
  console.log("");
  resetCompactionLock();
}

console.log(failures === 0 ? "   all expectations held\n" : `   ${failures} expectation(s) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
