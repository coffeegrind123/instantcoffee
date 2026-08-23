/**
 * ab3 — AO3, the room pi consumed, identified by a string two rooms can produce.
 *
 * FIXED — the BEFORE column is `renderInboundMessage(message)`, which is what
 * `deliverInbound` used to store as `injected`; the NOW column is
 * `uniqueInjection(message, outstanding)`, which is what it stores now. Both are
 * the shipped `vendor/prinny-channel/src/inbound.ts`. `blockMatches` is the
 * shipped `src/forwarding.ts`, unchanged by this pass.
 *
 * `markLive` and `liveRooms` live in `extensions/index.ts`, which imports pi and
 * typebox and cannot be loaded here. They are eight lines between them and are
 * reproduced verbatim below, marked, so what this probe drives is the rule and
 * not a paraphrase of it:
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
 *   run: node --experimental-strip-types ab3-two-rooms-one-sentence.mjs [collision|distinct|silenced]
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

const MODES = { collision: {}, distinct: {}, silenced: {} };
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
} else {
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

console.log("");
process.exit(failures === 0 ? 0 : 1);
