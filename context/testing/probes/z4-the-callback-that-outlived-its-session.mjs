/**
 * z4 — AM4. `runToken` is bumped by every LOOP transition and by neither SESSION
 * transition, so the one continuation that survives a session swap acted on the
 * newly restored run with the previous session's handles.
 *
 * FIXED — this drives the REAL `vendor/pi-loop-mode` extension through a real
 * context-pressure cycle, holds the `ctx.compact()` callbacks pi would hold, and
 * fires them after a swap.
 *
 * ## Why exactly one continuation survives
 *
 * `session_start` clears `pendingTimer` and drops the turn buffers, so timers
 * and per-turn state are already covered. A `ctx.compact()` callback is not
 * reachable from the extension at all — pi holds it inside
 *
 *     compact: (options) => { void (async () => {
 *         try { const r = await this.compact(...); options?.onComplete?.(r); }
 *         catch (e) { options?.onError?.(e); }
 *     })(); },                                     agent-session.js:1911
 *
 * and there are two of them: `requestEmergencyCompaction`, and `interveneStuck`'s
 * compaction rung.
 *
 * ## And the swap is what makes it fire
 *
 * `AgentSession.dispose()` calls `abortCompaction()`, so replacing the session
 * aborts an in-flight compaction and pi throws `"Compaction cancelled"` — which
 * `isBenignCompactionError` correctly does NOT swallow. The callback then ran
 * `enterContextCooldown(pi, ctx, …)`: it charged the NEW run's cooldown ladder
 * for the OLD run's compaction, and called `persistState(pi)` on a `pi` whose
 * `appendEntry` is `runtime.assertActive(); …` — a throw out of a callback pi
 * invokes from a `void`ed async IIFE, i.e. an unhandled rejection rather than a
 * caught error.
 *
 *   run: node --experimental-strip-types z4-the-callback-that-outlived-its-session.mjs [swap|shutdown|live]
 */

const REPO = "/home/claudeuser/qwen3.8-forge";
const loopExtension = (await import(`${REPO}/vendor/pi-loop-mode/extensions/index.ts`)).default;
const { resetCompactionLock } = await import(`${REPO}/vendor/pi-loop-mode/src/compaction-lock.ts`);

const MODES = {
  /** The finding: shutdown + start, then the callback fires. */
  swap: {},
  /** The callback may land between the two halves of a swap. */
  shutdown: {},
  /** The control: nothing moved, so the callback is this run's and still acts. */
  live: {},
};

const MODE = process.argv[2] ?? "swap";
if (!MODES[MODE]) {
  console.error(`usage: node z4-…mjs <${Object.keys(MODES).join("|")}>`);
  process.exit(2);
}

let failures = 0;
const check = (label, ok) => {
  console.log(`   ${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) failures++;
};

/**
 * One column, in its own extension instance.
 *
 * `bumpOnSessionEvents` is the fix: `false` reproduces the shipped code before
 * it, where a session transition left `runToken` where it was.
 */
async function column(extension) {
  const handlers = new Map();
  const notices = [];
  const sent = [];
  const compactRequests = [];
  let branch = [{ type: "message" }];
  let piIsStale = false;
  let appendThrew = 0;
  let command;

  const pi = {
    on(name, fn) {
      handlers.set(name, fn);
    },
    registerCommand(_name, config) {
      command = config.handler;
    },
    registerTool() {},
    appendEntry(customType, data) {
      // Faithful to pi's binding: `runtime.assertActive()` THROWS on a stale one.
      if (piIsStale) {
        appendThrew += 1;
        throw new Error("This extension ctx is stale after session replacement or reload.");
      }
      branch.push({ type: "custom", customType, data });
    },
    sendMessage(message, options) {
      sent.push({ message, options });
    },
    async exec() {
      return { code: 0, stdout: "__loop_check_completed__", stderr: "", killed: false };
    },
    async setModel() {
      return true;
    },
  };

  const ctx = {
    cwd: process.cwd(),
    mode: "tui",
    hasUI: true,
    ui: {
      notify(message, level = "info") {
        notices.push({ message: String(message), level });
      },
      setStatus() {},
    },
    sessionManager: { getBranch: () => branch, getEntries: () => branch },
    modelRegistry: { find: () => undefined, getAll: () => [] },
    model: { api: "openai-completions", contextWindow: 32_768 },
    isIdle: () => true,
    hasPendingMessages: () => false,
    getContextUsage: () => ({ percent: 100, contextWindow: 32_768, tokens: 32_768 }),
    compact(options) {
      compactRequests.push(options);
    },
    abort() {},
    async waitForIdle() {},
  };

  resetCompactionLock();
  extension(pi);
  const emit = async (name, payload = {}) => {
    const handler = handlers.get(name);
    if (handler) await handler(payload, ctx);
  };

  await command("end", ctx);
  branch = [{ type: "message" }];
  await command("start Improve the site. Done when: the build passes", ctx);

  // One context-pressure cycle: the turn overflows, pi declines to recover, the
  // loop asks for an emergency compaction and pi holds the callbacks.
  await emit("agent_end", {
    messages: [
      { role: "assistant", content: [], stopReason: "error", errorMessage: "Backend returned 400", usage: { output: 0 } },
    ],
  });
  await emit("agent_settled", {});
  if (compactRequests.length !== 1) throw new Error(`expected one compaction request, got ${compactRequests.length}`);

  // The swap. BEFORE, neither half moved the token.
  if (MODE !== "live") {
    await emit("session_shutdown", {});
    if (MODE === "swap") await emit("session_start", {});
    piIsStale = true;
  }

  notices.length = 0;
  sent.length = 0;
  // pi calls this from `void (async () => { … catch (e) { onError(e) } })()`, so
  // a throw here is an UNHANDLED REJECTION rather than an error anything sees.
  // Caught only so the probe can report it.
  let escaped;
  try {
    await compactRequests[0].onError(new Error("Compaction cancelled"));
  } catch (error) {
    escaped = error;
  }

  return { notices, sent, appendThrew, escaped };
}

/**
 * The BEFORE column, produced by patching the two lines back out.
 *
 * A probe that reproduces a fix's absence by re-implementing it is a probe about
 * the re-implementation. This loads the module twice with the source edited, so
 * both columns are the real extension.
 */
async function withoutTheFix(run) {
  const { readFileSync, writeFileSync } = await import("node:fs");
  const path = `${REPO}/vendor/pi-loop-mode/extensions/index.ts`;
  const original = readFileSync(path, "utf8");

  // AM4's two lines, addressed by the SHAPE that identifies them rather than by
  // a copy of their surroundings. The first draft quoted four consecutive lines
  // of each handler; AN5 then inserted `resetPersistMemo()` between two of them,
  // and this probe could no longer build its BEFORE column at all — loudly,
  // which is the only reason that was cheap rather than a wrong answer.
  // `resetPersistMemo()` is called from exactly the two lifecycle handlers AM4
  // is about, so "a `runToken++; clearPendingTimer();` pair in a handler that
  // also drops the persist memo" identifies them without quoting anything the
  // next pass is likely to move.
  const SITE = "    runToken++;\n    clearPendingTimer();\n";
  const sites = [...original.matchAll(/ {4}runToken\+\+;\n {4}clearPendingTimer\(\);\n/g)].filter((match) =>
    original.slice(match.index, match.index + 400).includes("resetPersistMemo();"),
  );
  if (sites.length !== 2) {
    throw new Error(
      `expected AM4's two session-transition sites, found ${sites.length} — the source has moved. ` +
        "Re-read `session_start` and `session_shutdown` in vendor/pi-loop-mode/extensions/index.ts " +
        "before trusting either column.",
    );
  }
  let patched = original;
  for (const match of [...sites].reverse()) {
    patched = patched.slice(0, match.index) + "    clearPendingTimer();\n" + patched.slice(match.index + SITE.length);
  }
  if (patched === original) throw new Error("could not remove the fix — the source has moved");
  const tmp = `${REPO}/vendor/pi-loop-mode/extensions/.z4-before.ts`;
  writeFileSync(tmp, patched);
  try {
    const before = (await import(tmp)).default;
    return await run(before);
  } finally {
    const { rmSync } = await import("node:fs");
    rmSync(tmp, { force: true });
  }
}

console.log(`\nz4 [${MODE}] — the callback that outlived its session (AM4)\n`);
console.log("   the loop asks pi to compact; pi holds onComplete/onError; the session");
console.log("   is replaced, which ABORTS the compaction and fires onError.\n");

const results = {};

// BEFORE: the same extension, loaded from a copy with the two `runToken++`
// lines removed. NOW: the shipped one.
results.BEFORE = await withoutTheFix((beforeExtension) => column(beforeExtension));
results.NOW = await column(loopExtension);

for (const [label, state] of Object.entries(results)) {
  const cooldown = state.notices.filter((n) => /cooling down|context recovery stalled/i.test(n.message));
  const recovered = state.notices.filter((n) => /context recovered/i.test(n.message));
  console.log(`   ${label}`);
  // `enterContextCooldown` increments the cooldown counter and tightens the
  // summary budget BEFORE it persists, so reaching `persistState` at all is the
  // evidence that the new run's ladder was charged — and on a stale `pi` that
  // is also where it throws.
  const reached = state.appendThrew > 0 || cooldown.length + recovered.length > 0;
  console.log(`     reached the new run's ladder : ${reached ? "yes" : "no"}`);
  console.log(`     cooldown notices           : ${cooldown.length}`);
  console.log(`     turns scheduled            : ${state.sent.length}`);
  console.log(`     persistState threw on stale pi : ${state.appendThrew}`);
  console.log(`     escaped the callback       : ${state.escaped ? `yes — ${state.escaped.message.slice(0, 46)}…` : "no"}\n`);
}

if (MODE === "live") {
  check("BEFORE the live callback acted", results.BEFORE.notices.length > 0);
  check("NOW the live callback still acts", results.NOW.notices.length > 0);
  check("…and nothing threw", results.NOW.appendThrew === 0);
} else {
  check(
    "BEFORE the dead session's callback charged this run's ladder",
    results.BEFORE.appendThrew > 0 || results.BEFORE.notices.length > 0,
  );
  check("…and threw out of a callback pi invokes from a void'ed IIFE", Boolean(results.BEFORE.escaped));
  check("NOW it does nothing at all", results.NOW.notices.length === 0);
  check("…and schedules nothing", results.NOW.sent.length === 0);
  check("…and never reaches the stale pi", results.NOW.appendThrew === 0 && !results.NOW.escaped);
}

console.log(failures === 0 ? "   all expectations held\n" : `   ${failures} expectation(s) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
