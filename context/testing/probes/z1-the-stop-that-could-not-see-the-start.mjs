/**
 * z1 — AM1. `stopChannel` read `child`, which is null for the whole of a
 * start's handshake, so a stop that landed in that window did nothing and the
 * sidecar it could not see published itself afterwards.
 *
 * FIXED — this drives the REAL `ChannelLifecycle` from
 * `vendor/prinny-channel/src/channel-lifecycle.ts` with a fake sidecar that
 * records whether it was stopped, in both columns.
 *
 * ## The window
 *
 * Not microseconds. `startChannel`'s `open` is a fresh node importing
 * matrix-js-sdk plus its Rust crypto WASM; `src/config.ts` measures the import
 * at **27.5 s in this container** and sets `connectTimeoutSeconds` to **120**
 * because of it. Four callers land in it — `/prinny stop`, `/prinny restart`,
 * `/prinny configure`, and `session_shutdown`.
 *
 * ## Why a disowned sidecar is not harmless
 *
 * It goes on to log into Matrix and open the Olm crypto store, and
 * `server/src/state.ts` says that store
 *
 *   > must never be shared between two running bots
 *
 * — so the version of `/prinny restart` that appeared to do nothing was in fact
 * the one that produced two.
 *
 *   run: node --experimental-strip-types z1-the-stop-that-could-not-see-the-start.mjs [stop|restart|clean|fail]
 */

const REPO = "/home/claudeuser/qwen3.8-forge";
const { ChannelLifecycle } = await import(`${REPO}/vendor/prinny-channel/src/channel-lifecycle.ts`);

const MODES = {
  /** The finding: a stop lands during the handshake. */
  stop: {},
  /** `/prinny restart` — stop, then start, while the first is still handshaking. */
  restart: {},
  /** The control: nothing stops it, so it publishes. */
  clean: {},
  /** The control: a genuine handshake failure is still reported as a failure. */
  fail: {},
};

const MODE = process.argv[2] ?? "stop";
if (!MODES[MODE]) {
  console.error(`usage: node z1-…mjs <${Object.keys(MODES).join("|")}>`);
  process.exit(2);
}

let failures = 0;
const check = (label, ok) => {
  console.log(`   ${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) failures++;
};

/**
 * A sidecar stand-in.
 *
 * `stop()` is idempotent, exactly as `McpChild.stop()` is — and it FAILS the
 * in-flight handshake, which is the property the fix leans on: `stop()` ends
 * with `this.failPending(new Error('channel stopped'))`, so the start's own
 * `catch` runs at once instead of sitting out its 120 s timeout.
 */
function fakeSidecar(id, gate) {
  let closed = false;
  return {
    id,
    gate,
    stops: 0,
    matrixLogins: 0,
    async stop() {
      if (closed) return;
      closed = true;
      this.stops += 1;
      gate.fail(new Error("channel stopped"));
    },
    /** What a published sidecar goes on to do: log in and open the crypto store. */
    login() {
      if (closed) return;
      this.matrixLogins += 1;
    },
  };
}

/** A handshake the probe controls: released, or failed by a stop. */
function makeGate() {
  let release;
  let fail;
  const promise = new Promise((resolve, reject) => {
    release = resolve;
    fail = reject;
  });
  // Nothing awaits this before it is settled; the rejection is delivered to
  // `open`'s awaiter, which is `ChannelLifecycle`.
  promise.catch(() => undefined);
  return { promise, release, fail };
}

/**
 * One column.
 *
 * `disown` is what the fix contributes; `false` reproduces the shipped code
 * before it — a stop that could reach neither the instance nor the token, so it
 * returned having done nothing while the handshake carried on.
 */
async function column(disown) {
  const built = [];
  const published = [];
  const failed = [];
  const gates = [];
  const lifecycle = new ChannelLifecycle();

  const hooks = () => ({
    build: () => {
      const gate = makeGate();
      gates.push(gate);
      const instance = fakeSidecar(built.length + 1, gate);
      built.push(instance);
      return instance;
    },
    open: async (instance) => {
      await instance.gate.promise;
      if (MODE === "fail") throw new Error("initialize timed out after 120s");
    },
    publish: (instance) => {
      published.push(instance);
      instance.login();
    },
    fail: (instance, error) => failed.push({ instance, error }),
    disowned: () => {},
  });

  const started = lifecycle.start(hooks());

  // The stop lands while the handshake is in flight. BEFORE it is a no-op,
  // because `child` is null and there is nothing else it can reach.
  const cancelling = MODE === "stop" || MODE === "restart" ? (disown ? lifecycle.cancel() : Promise.resolve()) : Promise.resolve();
  await cancelling;

  // The second half of `/prinny restart`, issued while the first start is still
  // handshaking — which is the whole point. BEFORE it JOINS that start and
  // reports its outcome as its own; NOW the cancel above has ended it, so this
  // really does build a second sidecar.
  const restarted = MODE === "restart" ? lifecycle.start(hooks()) : undefined;

  for (const gate of gates) gate.release();
  await started;
  if (restarted) await restarted;

  return { built, published, failed };
}

console.log(`\nz1 [${MODE}] — the stop that could not see the start (AM1)\n`);
console.log("   the handshake is a node process importing matrix-js-sdk + Rust crypto WASM;");
console.log("   measured at 27.5 s here, budgeted at connectTimeoutSeconds = 120.\n");

const results = {};
for (const [label, disown] of Object.entries({ BEFORE: false, NOW: true })) {
  const state = await column(disown);
  results[label] = state;
  const live = state.published.filter((s) => s.stops === 0);
  console.log(`   ${label}`);
  console.log(`     sidecars built                : ${state.built.length}`);
  console.log(`     sidecars published as child   : ${state.published.length}`);
  console.log(`     …still running afterwards     : ${live.length}`);
  console.log(`     Matrix logins on the store    : ${state.built.reduce((n, s) => n + s.matrixLogins, 0)}`);
  console.log(`     reported as a start FAILURE   : ${state.failed.length}\n`);
}

if (MODE === "stop") {
  console.log("   the operator asked for the channel to stop, and was told it had.\n");
  check("BEFORE the stopped channel came up anyway", results.BEFORE.published.length === 1);
  check("…and logged into Matrix for a session that had ended", results.BEFORE.built[0].matrixLogins === 1);
  check("NOW nothing is published", results.NOW.published.length === 0);
  check("…and the sidecar it could not see was stopped", results.NOW.built[0].stops === 1);
} else if (MODE === "restart") {
  console.log("   `/prinny restart` is `await stopChannel(); await startChannel();`.");
  console.log("   BEFORE, the stop did nothing and the start was handed the FIRST");
  console.log("   start's promise — so it reported that one's outcome as its own,");
  console.log("   and two sidecars ended up on one Olm crypto store.\n");
  check("BEFORE built one sidecar and restarted nothing", results.BEFORE.built.length === 1);
  check("…and left it live on the crypto store", results.BEFORE.built[0].matrixLogins === 1);
  check("NOW a second sidecar is built", results.NOW.built.length === 2);
  check("…the first is stopped", results.NOW.built[0].stops === 1);
  check("…and only the second holds the store", results.NOW.built[1].matrixLogins === 1);
} else if (MODE === "clean") {
  console.log("   the control: nothing stopped it, so it publishes exactly as before.\n");
  check("BEFORE published", results.BEFORE.published.length === 1);
  check("NOW publishes too", results.NOW.published.length === 1);
  check("…and nothing was stopped", results.NOW.built[0].stops === 0);
} else {
  console.log("   the control: a real handshake timeout is still a FAILURE, which is");
  console.log("   what sets `lastError` and what `/prinny status` repeats.\n");
  check("BEFORE reported a failure", results.BEFORE.failed.length === 1);
  check("NOW reports a failure too", results.NOW.failed.length === 1);
  check("…and the half-built sidecar is stopped either way", results.NOW.built[0].stops === 1);
}

console.log(failures === 0 ? "   all expectations held\n" : `   ${failures} expectation(s) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
