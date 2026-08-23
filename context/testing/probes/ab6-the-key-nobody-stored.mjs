/**
 * ab6 — AO6, the lookups that answered for a key that was never stored.
 *
 * FIXED — both columns are real. The NOW column is the shipped
 * `vendor/prinny-channel/src/access-store.ts` and the staged sidecar's
 * `access.js`; the BEFORE column is the two expressions those files used to
 * hold, evaluated against the same parsed object:
 *
 * ```js
 *   const entry = access.pending[code]                 access-store.ts  pair()
 *   if (!access.pending[code]) return false            access-store.ts  deny()
 *   if (!access.rooms[roomId]) return false            access-store.ts  removeRoom()
 *   if (roomId in access.rooms) return                 server/src/access.ts
 *                                                        assertAllowedRoom()
 * ```
 *
 * Everything here comes out of `JSON.parse`, so it carries `Object.prototype`,
 * and eight inherited names are both `in` it and truthy on it. The same package
 * already writes `Object.prototype.hasOwnProperty.call` over two tables of its
 * own, in `src/command-routing.ts`, against a name that arrives in a Matrix
 * message.
 *
 * Nothing was ever posted through the room gate — none of the eight is a room
 * ID and the homeserver rejects them — so that one is a gate answering a
 * question it was never asked. `pair()` is the one with an effect: it reported
 * a pairing that never existed and pushed `null` into the allowlist.
 *
 *   run: node --experimental-strip-types ab6-the-key-nobody-stored.mjs [pair|rooms|control]
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const REPO = "/home/claudeuser/qwen3.8-forge";
const store = await import(`${REPO}/vendor/prinny-channel/src/access-store.ts`);
const RUNTIME =
  process.env.PRINNY_RUNTIME_DIR ??
  join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "channels", "prinny", "runtime");

const INHERITED = [
  "constructor",
  "toString",
  "valueOf",
  "hasOwnProperty",
  "__proto__",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
];

const MODES = { pair: {}, rooms: {}, control: {} };
const MODE = process.argv[2] ?? "pair";
if (!MODES[MODE]) {
  console.error(`usage: node ab6-…mjs <${Object.keys(MODES).join("|")}>`);
  process.exit(2);
}

let failures = 0;
const check = (label, ok) => {
  console.log(`   ${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) failures++;
};

console.log(`\nab6 [${MODE}] — the key nobody stored (AO6)\n`);

const dir = mkdtempSync(join(tmpdir(), "ab6-prinny-"));
const file = join(dir, "access.json");
try {
  if (MODE === "pair") {
    /** `pair()`, as it was, run against the same file. */
    const beforePair = (code) => {
      const access = JSON.parse(readFileSync(file, "utf8"));
      const entry = access.pending[code];
      if (!entry) return { ok: false };
      if (entry.expiresAt < Date.now()) return { ok: false };
      if (!access.allowFrom.includes(entry.senderId)) access.allowFrom.push(entry.senderId);
      delete access.pending[code];
      writeFileSync(file, JSON.stringify(access, null, 2));
      return { ok: true, senderId: entry.senderId, roomId: entry.roomId };
    };

    store.writeAccess({ ...store.defaultAccess(), allowFrom: ["@real:example.org"] }, file);
    const before = beforePair("constructor");
    const afterBefore = JSON.parse(readFileSync(file, "utf8")).allowFrom;

    store.writeAccess({ ...store.defaultAccess(), allowFrom: ["@real:example.org"] }, file);
    const now = store.pair("constructor", Date.now(), file);
    const afterNow = JSON.parse(readFileSync(file, "utf8")).allowFrom;

    console.log(`   /prinny pair constructor\n`);
    console.log(`     BEFORE  → ${JSON.stringify(before)}`);
    console.log(`               the reply: "paired ${before.senderId}. They can now reach this session."`);
    console.log(`               allowFrom after: ${JSON.stringify(afterBefore)}`);
    console.log(`     NOW     → ${JSON.stringify(now)}`);
    console.log(`               allowFrom after: ${JSON.stringify(afterNow)}\n`);

    check("BEFORE it reported success", before.ok === true);
    check("…for a sender that is undefined", before.senderId === undefined);
    check("…and wrote null into the allowlist", afterBefore.includes(null));
    check("NOW it refuses", now.ok === false);
    check("…and the allowlist is untouched", JSON.stringify(afterNow) === JSON.stringify(["@real:example.org"]));

    console.log("");
    console.log(`   and the same for deny / removeRoom, over all eight inherited names:`);
    store.writeAccess({ ...store.defaultAccess(), rooms: { "!r:example.org": { requireMention: true, allowFrom: [] } } }, file);
    const denyBefore = INHERITED.filter((k) => Boolean(JSON.parse(readFileSync(file, "utf8")).pending[k])).length;
    const denyNow = INHERITED.filter((k) => store.deny(k, file)).length;
    const roomBefore = INHERITED.filter((k) => Boolean(JSON.parse(readFileSync(file, "utf8")).rooms[k])).length;
    const roomNow = INHERITED.filter((k) => store.removeRoom(k, file)).length;
    console.log(`     deny        BEFORE said "discarded" for ${denyBefore}/8   NOW ${denyNow}/8`);
    console.log(`     removeRoom  BEFORE said "disabled"  for ${roomBefore}/8   NOW ${roomNow}/8\n`);
    check("BEFORE both lied about all eight", denyBefore === 8 && roomBefore === 8);
    check("NOW neither does", denyNow === 0 && roomNow === 0);
  } else if (MODE === "rooms") {
    process.env.PRINNY_STATE_DIR = dir;
    store.writeAccess({ ...store.defaultAccess(), rooms: { "!team:example.org": { requireMention: true, allowFrom: [] } } }, file);
    const access = await import(`${join(RUNTIME, "dist", "access.js")}?g=${Math.random()}`);

    const beforeAllowed = (roomId) => roomId in JSON.parse(readFileSync(file, "utf8")).rooms;
    const nowAllowed = (roomId) => {
      try {
        access.assertAllowedRoom(roomId, new Set());
        return true;
      } catch {
        return false;
      }
    };

    console.log(`   assertAllowedRoom — the outbound gate, called with whatever the MODEL passed\n`);
    console.log(`   room name              BEFORE   NOW`);
    for (const key of INHERITED) {
      console.log(`   ${key.padEnd(22)} ${(beforeAllowed(key) ? "ALLOW ✘" : "refuse").padEnd(8)} ${nowAllowed(key) ? "ALLOW" : "refuse"}`);
    }
    console.log(`   ${"!team:example.org".padEnd(22)} ${(beforeAllowed("!team:example.org") ? "allow" : "refuse").padEnd(8)} ${nowAllowed("!team:example.org") ? "allow" : "refuse"}`);
    console.log("");
    check("BEFORE all eight passed the gate", INHERITED.every(beforeAllowed));
    check("NOW none of them does", INHERITED.every((k) => !nowAllowed(k)));
    check("…and the room that really is enabled still passes", nowAllowed("!team:example.org"));
  } else {
    // The control: `Object.entries`, which the sidecar's own pairing loop uses,
    // was always own-keys-only — which is why the symptom only ever showed on
    // the extension side.
    const parsed = JSON.parse('{"abc123":{"senderId":"@sam:example.org"}}');
    console.log(`   a pending block with one real code\n`);
    console.log(`     Object.entries(...)         → ${JSON.stringify(Object.entries(parsed).map(([k]) => k))}`);
    console.log(`     Object.keys(...)            → ${JSON.stringify(Object.keys(parsed))}`);
    console.log(`     'constructor' in ...        → ${"constructor" in parsed}`);
    console.log(`     Boolean(...['constructor']) → ${Boolean(parsed["constructor"])}`);
    console.log(`     hasEntry(..., 'constructor')→ ${store.hasEntry(parsed, "constructor")}\n`);
    check("the enumerating forms were never affected", Object.keys(parsed).length === 1);
    check("the two reaching forms were", "constructor" in parsed && Boolean(parsed["constructor"]));
    check("hasEntry is the one that answers the question that was meant", store.hasEntry(parsed, "abc123") && !store.hasEntry(parsed, "constructor"));
  }
} finally {
  delete process.env.PRINNY_STATE_DIR;
  rmSync(dir, { recursive: true, force: true });
}

console.log("");
process.exit(failures === 0 ? 0 : 1);
