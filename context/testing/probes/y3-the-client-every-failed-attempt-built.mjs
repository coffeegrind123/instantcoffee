/**
 * y3 — AL3. The Matrix client every failed connection attempt built, and
 * nothing ever stopped.
 *
 * FIXED — this drives the REAL `connectWithRetry` for a hundred failed attempts
 * and counts what is still alive, with the shipped loop reconstructed beside it
 * so BEFORE is a measurement rather than a memory.
 *
 * ## The finding
 *
 * `startMatrix` retries the homeserver forever, on purpose, and says why:
 * *"a homeserver that comes back should not need the user to restart pi"*. The
 * loop it was written as constructed a client per attempt:
 *
 *     for (let attempt = 1; ; attempt += 1) {
 *       try {
 *         const next = buildBot(await resolveDeviceId());   // ← a NEW client
 *         registerHandlers(next);
 *         await next.setMyCommands(COMMANDS);
 *         await next.start();                               // ← throws here
 *         bot = next;                                       // ← the only handle
 *         return;
 *       } catch (err) {
 *         if (shuttingDown) return;
 *         await sleep(Math.min(1000 * attempt, 30_000));
 *       }
 *     }
 *
 * `bot` is assigned only on the success path, and `shutdown()` stops `bot`. So
 * every failed attempt's client was unreachable and running.
 *
 * It is not only memory. `buildBot` hands each one `storePath:
 * CRYPTO_STORE_PATH`, and the header of the file that defines that constant
 * says:
 *
 *   > including the crypto store, **which must never be shared between two
 *   > running bots**.
 *
 * `start()` is where the login happens, so a wrong password, an expired token,
 * a 502 from a reverse proxy and an unreachable host all arrive after
 * construction — which is the only point at which there is something to leak.
 * The backoff caps at thirty seconds, so an overnight outage is of the order of
 * a thousand of them.
 *
 * The control is one package away and gets it right: the extension's
 * `startChannel` catch is `await instance.stop().catch(() => undefined)`. Same
 * repository, same week; the difference is that `startChannel` runs once and
 * this loop runs forever.
 *
 *   run: node --experimental-strip-types y3-the-client-every-failed-attempt-built.mjs [outage|recovered|shutdown]
 */

import { connectWithRetry } from "/home/claudeuser/qwen3.8-forge/vendor/prinny-channel/server/src/connect.ts";

const MODES = {
  /** The homeserver is down and stays down for a hundred attempts. */
  outage: { succeedOn: Infinity, attempts: 100, stopAfter: 100 },
  /** Down for twenty attempts, then back — the case the retry exists for. */
  recovered: { succeedOn: 20, attempts: Infinity, stopAfter: undefined },
  /** pi quits while an attempt is in flight. */
  shutdown: { succeedOn: Infinity, attempts: Infinity, stopAfter: 3 },
};

const MODE = process.argv[2] ?? "outage";
if (!MODES[MODE]) {
  console.error(`usage: node y3-…mjs <${Object.keys(MODES).join("|")}>`);
  process.exit(2);
}
const spec = MODES[MODE];

let failures = 0;
const check = (label, ok) => {
  console.log(`   ${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) failures++;
};

/** A stand-in for `Bot`: it knows only whether anybody stopped it. */
function makeClients() {
  const built = [];
  return {
    built,
    build: () => {
      const client = { id: built.length + 1, running: true };
      built.push(client);
      return client;
    },
    alive: () => built.filter((c) => c.running).length,
  };
}

/**
 * The loop as it shipped, reconstructed for the BEFORE column.
 *
 * Byte-comparable to the source above except for the injected hooks — no
 * `discard`, and `shuttingDown` tested before anything else in the catch.
 */
async function beforeLoop(hooks) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const candidate = await hooks.build(attempt);
      await hooks.start(candidate, attempt);
      return candidate;
    } catch {
      if (hooks.stopping()) return undefined;
      await hooks.sleep(hooks.delayMs(attempt));
    }
  }
}

function hooksFor(clients, onDiscard) {
  let attempts = 0;
  return {
    build: (attempt) => {
      attempts = attempt;
      return clients.build();
    },
    start: async (client, attempt) => {
      if (attempt < spec.succeedOn) throw new Error(`login refused (attempt ${attempt})`);
    },
    discard: async (client) => {
      client.running = false;
      onDiscard?.(client);
    },
    delayMs: (attempt) => Math.min(1000 * attempt, 30_000),
    sleep: async () => {},
    onError: () => {},
    stopping: () => spec.stopAfter !== undefined && attempts >= spec.stopAfter,
  };
}

console.log(`\ny3 [${MODE}] — the client every failed attempt built (AL3)\n`);
console.log(`   attempts before the homeserver answers : ${spec.succeedOn === Infinity ? "never" : spec.succeedOn}`);
console.log(`   shutdown arrives at attempt            : ${spec.stopAfter ?? "not at all"}\n`);

const beforeClients = makeClients();
const beforeResult = await beforeLoop(hooksFor(beforeClients));

const nowClients = makeClients();
const nowResult = await connectWithRetry(hooksFor(nowClients));

const column = (label, clients, result) => {
  console.log(`   ${label}`);
  console.log(`     clients constructed        : ${clients.built.length}`);
  console.log(`     still running afterwards   : ${clients.alive()}`);
  console.log(`     published to the sidecar   : ${result ? `#${result.id}` : "none"}`);
  const orphans = clients.built.filter((c) => c.running && c !== result).length;
  console.log(`     holding the crypto store   : ${orphans} unreachable client(s)\n`);
  return orphans;
};

const beforeOrphans = column("BEFORE", beforeClients, beforeResult);
const nowOrphans = column("NOW   ", nowClients, nowResult);

if (MODE === "recovered") {
  console.log("   the retry did its job in both columns — the difference is what");
  console.log("   it left behind while doing it.\n");
  check("the connection is established either way", Boolean(beforeResult && nowResult));
  check("the published client is not stopped", nowResult?.running === true);
  check("nothing else is left running", nowOrphans === 0);
  check("BEFORE left one per failed attempt", beforeOrphans === spec.succeedOn - 1);
} else if (MODE === "shutdown") {
  console.log("   `shutdown()` waits five seconds for `bot.stop()` because losing the");
  console.log("   last minutes of Olm state forces every peer to re-key. The client");
  console.log("   of the attempt that was in flight was never in `bot`.\n");
  check("the loop gives up when the process is going away", nowResult === undefined);
  check("and the in-flight client is stopped on the way out", nowOrphans === 0);
  check("BEFORE abandoned it", beforeOrphans > 0);
} else {
  console.log("   an overnight outage against a 30 s cap is of this order, per night.\n");
  check("nothing is left running after a hundred failures", nowOrphans === 0);
  check("BEFORE left one hundred", beforeOrphans === 100);
  check("the same number of attempts were made either way", beforeClients.built.length === nowClients.built.length);
}

console.log(failures === 0 ? "   all expectations held\n" : `   ${failures} expectation(s) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
