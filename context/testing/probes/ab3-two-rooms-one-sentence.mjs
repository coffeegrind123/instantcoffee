/**
 * ab3 — AO3, the room pi consumed, identified by a string two rooms can produce.
 *
 * FIXED — the BEFORE column is `renderInboundMessage(message)`, which is what
 * `deliverInbound` used to store as `injected`; the NOW column is
 * `uniqueInjection(message, outstanding)`, which is what it stores now. Both are
 * the shipped `vendor/prinny-channel/src/inbound.ts`. `blockMatches` is the
 * shipped `src/forwarding.ts`, unchanged by this pass.
 *
 * ## Two layers, and the second one arrived late
 *
 * `collision`, `distinct` and `silenced` drive the RULE — `uniqueInjection`
 * against `renderInboundMessage`, both shipped, with `markLive` and `liveRooms`
 * reproduced verbatim below. `wired-now` and `wired-before` drive the WIRING:
 * the shipped `deliverInbound` calling the shipped `outstandingInjections` and
 * `uniqueInjection`, the shipped `markLive` matching a real echo, and the
 * shipped `forwardToMatrix` deciding what Matrix receives. Nothing is
 * reproduced there.
 *
 * The wired modes exist because of AO9 and `ab11`: this header's own reason for
 * reproducing the rule — *"`extensions/index.ts` imports pi and cannot be loaded
 * here"* — was the SUITE's constraint, and seventeen probes in this directory
 * have loaded that same file through pi's jiti since the fourteenth pass. Until
 * the wired modes, nothing anywhere proved `deliverInbound` calls
 * `uniqueInjection` at all, which is the exact gap `ab11` was written for one
 * package over: **a test that checks the rule cannot tell a call from a use.**
 *
 * The BEFORE column is one operator swapped, on the module the extension is
 * about to import: `uniqueInjection` replaced by `renderInboundMessage`, which
 * is what `deliverInbound` used to store. The extension, `deliverInbound`,
 * `markLive`, `liveRooms` and `forwardToMatrix` are all the shipped ones in both
 * columns. What Matrix receives:
 *
 * ```
 *   wired-now      !bob    "The nightly build finished at 03:12."
 *   wired-before   !alice  "Someone else was being answered in the same turn…"
 *                  !bob    "Someone else was being answered in the same turn…"
 * ```
 *
 * Bob is the only person pi ever read. Before AO3 his answer was not sent, and
 * Alice — whose message pi never took — was told someone else was being
 * answered.
 *
 * ## What running the wired modes found: nine probes that had stopped starting
 *
 * The first wired run delivered nothing at all. The cause is not in this file:
 * **AN2 (twenty-third pass) changed what "the runtime is ready" means**, and
 * every probe that fakes a `PRINNY_STATE_DIR` had been starting a channel that
 * immediately refused, ever since. See `_staged.mjs`, which now holds the one
 * line they all needed. Ten of eighteen probes that load the prinny extension
 * were failing when this was written; the box's own runtime was `current`
 * throughout, so it was never an unprepared checkout.
 *
 * `markLive` and `liveRooms` live in `extensions/index.ts`. For the rule modes
 * they are eight lines between them and are reproduced verbatim below, marked,
 * so what those modes drive is the rule and not a paraphrase of it:
 *
 * ```js
 *   function markLive(userMessageText) {
 *     for (const [room, entry] of awaitingReply) {
 *       if (entry.live) continue;
 *       if (blockMatches(userMessageText, { roomId: room, messageId: entry.messageId,
 *                                           injected: entry.injected })) entry.live = true;
 *     }
 *   }
 *   const liveRooms = () => [...awaitingReply].filter(([, e]) => e.live).map(([r]) => r);
 * ```
 *
 * and `forwardToMatrix` sends only when `liveRooms().length === 1`.
 *
 * **One process per wired mode.** `awaitingReply` is module state, and the
 * BEFORE column is a module patch that has to be in place before the extension
 * is imported.
 *
 *   run: for m in collision distinct silenced wired-now wired-before; do \
 *          node --experimental-strip-types ab3-two-rooms-one-sentence.mjs $m; done
 */

const REPO = "/home/claudeuser/qwen3.8-forge";
const SRC = `${REPO}/vendor/prinny-channel/src`;
const { renderInboundMessage, uniqueInjection } = await import(`${SRC}/inbound.ts`);
const { blockMatches } = await import(`${SRC}/forwarding.ts`);

const dm = (who, body) => ({
  content: body,
  meta: {
    room_id: `!${who}:example.org`,
    message_id: `$ev-${who}`,
    user: who,
    user_id: `@${who}:example.org`,
    is_direct: "true",
  },
});

/** `markLive`, verbatim. */
function markLive(awaitingReply, userMessageText) {
  for (const [room, entry] of awaitingReply) {
    if (entry.live) continue;
    if (blockMatches(userMessageText, { roomId: room, messageId: entry.messageId, injected: entry.injected })) {
      entry.live = true;
    }
  }
}
const liveRooms = (awaitingReply) => [...awaitingReply].filter(([, e]) => e.live).map(([r]) => r);

/** Build the map the way `deliverInbound` does, under one of the two renderers. */
function deliver(messages, render) {
  const awaitingReply = new Map();
  for (const message of messages) {
    const room = message.meta.room_id;
    const outstanding = [...awaitingReply]
      .filter(([r, e]) => r !== room && !e.live)
      .map(([, e]) => e.injected)
      .filter(Boolean);
    awaitingReply.set(room, {
      messageId: message.meta.message_id,
      injected: render(message, outstanding),
      live: false,
    });
  }
  return awaitingReply;
}

const BEFORE = (message) => renderInboundMessage(message);
const NOW = (message, outstanding) => uniqueInjection(message, outstanding);

const MODES = { collision: {}, distinct: {}, silenced: {}, "wired-now": {}, "wired-before": {} };
const MODE = process.argv[2] ?? "collision";
if (!MODES[MODE]) {
  console.error(`usage: node ab3-…mjs <${Object.keys(MODES).join("|")}>`);
  process.exit(2);
}

let failures = 0;
const check = (label, ok) => {
  console.log(`   ${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) failures++;
};

console.log(`\nab3 [${MODE}] — two rooms, one sentence, one echo (AO3)\n`);

if (MODE === "collision") {
  const messages = [dm("alice", "hi"), dm("bob", "hi")];
  for (const [label, render] of [["BEFORE", BEFORE], ["NOW", NOW]]) {
    const map = deliver(messages, render);
    console.log(`   ${label}`);
    for (const [room, entry] of map) console.log(`     ${room.padEnd(22)} injected ${JSON.stringify(entry.injected)}`);
    const distinct = new Set([...map.values()].map((e) => e.injected)).size;
    console.log(`     distinct injected texts: ${distinct} of ${map.size}\n`);
  }
  const before = deliver(messages, BEFORE);
  const now = deliver(messages, NOW);
  check("BEFORE the two rooms were indistinguishable", new Set([...before.values()].map((e) => e.injected)).size === 1);
  check("NOW they are not", new Set([...now.values()].map((e) => e.injected)).size === 2);
} else if (MODE === "distinct") {
  // The control: two rooms whose words differ were never a problem, and the
  // widening must not fire for them.
  const messages = [dm("alice", "how is the build"), dm("bob", "any news")];
  const before = deliver(messages, BEFORE);
  const now = deliver(messages, NOW);
  for (const [room, entry] of now) console.log(`   ${room.padEnd(22)} ${JSON.stringify(entry.injected)}`);
  console.log("");
  check(
    "the ordinary case renders exactly as it did — no tokens spent",
    [...now.values()].every((e, i) => e.injected === [...before.values()][i].injected),
  );
  check("and both are distinct", new Set([...now.values()].map((e) => e.injected)).size === 2);
} else if (MODE === "silenced") {
  // The damage. Alice's message is not taken (a compaction was in flight —
  // `delivery.ts` is entirely about that being unobservable). Bob's IS taken,
  // and pi echoes it once.
  const messages = [dm("alice", "hi"), dm("bob", "hi")];
  for (const [label, render] of [["BEFORE", BEFORE], ["NOW", NOW]]) {
    const map = deliver(messages, render);
    const echo = map.get("!bob:example.org").injected; // the one pi actually took
    markLive(map, echo);
    const live = liveRooms(map);
    const verdict =
      live.length === 1
        ? `answer goes to ${live[0]}`
        : live.length === 0
          ? "nothing is live; nobody is answered"
          : `forwardToMatrix REFUSES (${live.length} live) — Bob's answer is not sent, and both are told ` +
            `"someone else was being answered"`;
    console.log(`   ${label}: pi echoed ${JSON.stringify(echo)}`);
    console.log(`     live rooms after markLive: ${live.length === 0 ? "(none)" : live.join(", ")}`);
    console.log(`     ${verdict}\n`);
  }
  const before = deliver(messages, BEFORE);
  markLive(before, before.get("!bob:example.org").injected);
  const now = deliver(messages, NOW);
  markLive(now, now.get("!bob:example.org").injected);

  check("BEFORE Alice's room went live off Bob's echo — pi never took her message", liveRooms(before).length === 2);
  check("…so Bob, who did ask and was taken, got no answer", liveRooms(before).length !== 1);
  check("NOW exactly the room pi consumed is live", liveRooms(now).length === 1);
  check("…and it is Bob's", liveRooms(now)[0] === "!bob:example.org");
}

// ── wired — the SHIPPED extension, end to end ────────────────────────────────
//
// Everything above drives the rule. This drives the WIRING: the real
// `deliverInbound` calling the real `uniqueInjection` with the real
// `outstandingInjections`, the real `markLive` matching the real echo, and the
// real `forwardToMatrix` deciding what Matrix receives. Nothing here is
// reproduced.
//
// One process per column, because `awaitingReply` is module state and the
// BEFORE column is a module patch that has to be in place before the extension
// is imported.
if (MODE === "wired-now" || MODE === "wired-before") {
  const { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const PI_DIST = "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist";
  const stateDir = mkdtempSync(join(tmpdir(), "ab3-prinny-"));
  // `_staged.mjs`, not a hand-written stand-in: since AN2 a runtime with no
  // `.source-stamp` reads as `stale` and `startupBlocker()` refuses to start,
  // which is silent from here. See that file's header.
  const { prepareStateDir } = await import("./_staged.mjs");
  const staged = prepareStateDir(stateDir);
  const inboxPath = staged.inbox;
  const outboxPath = staged.outbox;
  check("control: the extension will accept the staged runtime (AN2)", staged.state === "current");
  process.env.PRINNY_STATE_DIR = stateDir;
  process.env.PRINNY_SIDECAR_ENTRY = join(REPO, "context", "testing", "probes", "_sidecar.mjs");
  process.env.PROBE_INBOX = inboxPath;
  process.env.PROBE_OUTBOX = outboxPath;

  const { createJiti } = await import(`${PI_DIST}/../node_modules/jiti/lib/jiti.mjs`);
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

  // THE ONE OPERATOR, swapped on the module the extension is about to import.
  // jiti compiles TypeScript to CJS, so `uniqueInjection(…)` in the extension is
  // a property read on this namespace at call time — which is what makes the
  // BEFORE column the shipped `deliverInbound` calling the expression it used to
  // call, rather than a second copy of `deliverInbound`.
  const INBOUND = `${REPO}/vendor/prinny-channel/src/inbound.ts`;
  const inboundModule = await jiti.import(INBOUND);
  const shippedUnique = inboundModule.uniqueInjection;
  const plainRender = inboundModule.renderInboundMessage;
  if (MODE === "wired-before") {
    inboundModule.uniqueInjection = (message) => plainRender(message);
  }

  // The control has to read the LIVE binding, not the wrapper it was written
  // through. `jiti.import()` hands back a fresh object each call, built from the
  // module's CJS exports: a write goes THROUGH to the module — which is what
  // makes the patch reach the extension — but a read from the same wrapper
  // returns the value it was constructed with. Measured, not assumed:
  //
  //   ns.uniqueInjection = f
  //   ns.uniqueInjection === f            false   ← the wrapper is stale
  //   jiti(path).uniqueInjection === f    true    ← the module really is patched
  //
  // Asserting on `ns` would have reported "not patched" for a run whose whole
  // output shows it patched, which is a control that lies in the safe direction
  // and is worth exactly as little as one that lies in the other.
  const live = () => jiti(INBOUND).uniqueInjection;
  const patched = live() !== shippedUnique;
  console.log(`   uniqueInjection, live binding         : ${patched ? "PATCHED to the pre-AO3 expression" : "the shipped one"}`);
  check(
    MODE === "wired-before"
      ? "control: the patch is in place — the extension will call the pre-AO3 expression"
      : "control: nothing is patched — the extension calls the shipped uniqueInjection",
    patched === (MODE === "wired-before"),
  );

  const prinnyChannel = (await jiti.import(`${REPO}/vendor/prinny-channel/extensions/index.ts`)).default;

  const handlers = new Map();
  const notices = [];
  const handed = [];
  const pi = {
    on: (name, fn) => handlers.set(name, [...(handlers.get(name) ?? []), fn]),
    registerCommand() {},
    registerTool() {},
    registerEntryRenderer() {},
    appendEntry() {},
    sendUserMessage: (content) => handed.push(String(content)),
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
  const post = (message) => appendFileSync(inboxPath, `${JSON.stringify(message)}\n`);
  const sent = () =>
    readFileSync(outboxPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.name === "reply")
      .map((entry) => ({ room: entry.arguments?.room_id, text: String(entry.arguments?.text ?? "") }));

  const inboundMsg = (who, body) => ({
    content: body,
    meta: {
      room_id: `!${who}:example.org`,
      chat_id: `!${who}:example.org`,
      message_id: `$ev-${who}`,
      user: who[0].toUpperCase() + who.slice(1),
      user_id: `@${who}:example.org`,
      ts: "2026-08-23T00:00:00.000Z",
      is_direct: "true",
    },
  });
  // The sidecar polls the inbox, so a delivery is not instant. Wait for the
  // message rather than for a duration: a fixed 250 ms was enough on one run and
  // not on the next, and a probe whose fixture half-arrives reports a finding
  // about the code.
  const deliverReal = async (who, body) => {
    const mark = handed.length;
    post(inboundMsg(who, body));
    for (let i = 0; i < 60 && handed.length === mark; i++) await sleep(50);
    return handed[mark];
  };

  await fire("session_start", {});
  await sleep(1200);

  // Two DMs, same words. `renderInboundMessage` drops the sender for a DM, so
  // before AO3 both rooms rendered identically.
  const askedAlice = await deliverReal("alice", "hi");
  const askedBob = await deliverReal("bob", "hi");
  console.log(`   what the extension injected for Alice : ${JSON.stringify(askedAlice)}`);
  console.log(`   what the extension injected for Bob   : ${JSON.stringify(askedBob)}`);
  console.log("");
  // Before anything is concluded from them: both messages actually reached pi.
  // Without this, "the two injections were identical" passes on two `undefined`s
  // — a fixture that never arrived reading as the defect it was meant to show.
  check(
    "control: the channel started and handed pi both messages",
    typeof askedAlice === "string" && typeof askedBob === "string",
  );

  // Alice's message was never taken — a delivery that threw under a compaction
  // in flight is the ordinary way that happens, and `src/delivery.ts` exists
  // because it cannot be observed. Bob's WAS taken, and pi echoes it once.
  await fire("agent_start", {});
  await fire("message_end", { message: { role: "user", content: [{ type: "text", text: askedBob }] } });

  const before = sent().length;
  await fire("agent_end", {
    messages: [
      { role: "assistant", content: [{ type: "text", text: "The nightly build finished at 03:12." }], stopReason: "stop", usage: { output: 20 } },
    ],
  });
  await fire("agent_settled", {});
  // The replies go out over the sidecar transport, so they arrive a tick later.
  for (let i = 0; i < 40 && sent().length === before; i++) await sleep(50);
  await sleep(150);
  const after = sent().slice(before);
  console.log(`   what Matrix received:`);
  for (const entry of after) console.log(`     ${String(entry.room).padEnd(22)} ${JSON.stringify(entry.text.slice(0, 70))}`);
  if (after.length === 0) console.log("     (nothing)");
  console.log("");

  const answered = after.filter((entry) => /03:12/.test(entry.text));
  const toBob = answered.some((entry) => entry.room === "!bob:example.org");

  if (MODE === "wired-now") {
    check("the two injections differ, so one echo can only mean one room", askedAlice !== askedBob);
    check("Bob — the only person pi actually read — is sent the answer", toBob);
    check("…and exactly one room is", answered.length === 1);
    check("Alice, whose message pi never took, is sent no answer", !answered.some((e) => e.room === "!alice:example.org"));
  } else {
    check("BEFORE the two injections were identical", askedAlice === askedBob);
    // Both entries match the single echo, `markLive` marks both, and
    // `forwardToMatrix`'s two-live-rooms guard refuses. Correct refusal,
    // wrong premise: only one room was ever read.
    check("BEFORE nobody is sent the answer — the guard refuses on two live rooms", answered.length === 0);
    check("…so Bob, who did ask and was taken, is not answered", !toBob);
    check(
      "…and the operator is told it could not be attributed, which is the only trace",
      notices.some((line) => /could not be attributed/i.test(line)) || after.some((e) => /ask again/i.test(e.text)),
    );
  }
  console.log("");
  console.log("   Nothing above is a reproduction: deliverInbound, outstandingInjections,");
  console.log("   markLive, liveRooms and forwardToMatrix are all the shipped ones.\n");
}

console.log("");
process.exit(failures === 0 ? 0 : 1);
