/**
 * y2 — AL2. The rescue turn switched the whole session's model, and one rung of
 * an eighteen-rung ladder switched it back.
 *
 * FIXED — this drives the REAL loop module all the way to a rescue turn, then
 * ends that turn the way each rung ends it, and prints the model the session is
 * left on together with the sentence the loop actually said.
 *
 * ## The finding
 *
 * After three consecutive stuck interventions `interveneStuck` calls
 * `pi.setModel(rescueModel)`. There is no narrower scope than the session, so
 * the switch is a global fact about the operator's next turn too — for what the
 * notice calls a *rescue TURN*, singular.
 *
 * The undo lived in exactly one place: the `state.rescueActive` block in
 * `agent_end`, which is rung 7 of eighteen. Five rungs return above it and three
 * commands never reach it:
 *
 *     rung 1  softStopRequested   → finalizeSoftStop           return
 *     rung 2  context pressure    → pauseForContextFailure     return
 *     rung 3  provider error      → backoff, retry, and at
 *                                   MAX_PROVIDER_ERRORS pause  return
 *     rung 5  operator abort      → paused                     return
 *     ─────── rung 7 is here, and it was the only stand-down ───────
 *     /loop stop    /loop end    /loop finish (idle branch)
 *
 * **Rung 3 is the one that costs most, and it is the likeliest.** A rescue model
 * is named on the command line and unused until the third consecutive stuck
 * intervention, so the first time anybody discovers it is not loaded in
 * llama-server is the turn it takes over. `switchModel` has already returned
 * true by then — it only fails on "no API key" — so the failure arrives as an
 * empty turn, rung 3 catches it, and the loop retries ON THE RESCUE MODEL, ten
 * times, against an escalating backoff, before pausing on it.
 *
 * **`/loop end` is the one that cannot be repaired afterwards.** It runs
 * `state = defaultState()`, which destroys `rescueReturnModel` — the only record
 * of what the session was on before.
 *
 * The whole ladder above rung 7 has to be climbed for this to be evidence, which
 * is x6's lesson: a probe that reaches its rung by a shortcut is a probe about
 * the shortcut. `intoRescue` below drives four real turns of fixated output
 * through `detectStuck` to get there, and asserts it arrived.
 *
 *   run: for m in rung3 rung3-ten rung5 rung1 stop end control; do \
 *          node --experimental-strip-types y2-the-rescue-turn-that-never-ended.mjs $m; done
 */

import { REPO, makeHost } from "./_host.mjs";

const loopMode = (await import(`${REPO}/vendor/pi-loop-mode/extensions/index.ts`)).default;

const SMALL = { provider: "local", id: "small", api: "openai-completions", contextWindow: 32_768 };
const BIG = { provider: "local", id: "big", api: "openai-completions", contextWindow: 32_768 };

const MODES = {
  "rung3": { how: "a rescue turn that produced no assistant message" },
  "rung3-ten": { how: "ten of them — the whole provider-error budget" },
  "rung5": { how: "the operator pressed Esc during the rescue turn" },
  "rung1": { how: "/loop finish during the rescue turn" },
  "stop": { how: "/loop stop during the rescue turn" },
  "end": { how: "/loop end during the rescue turn" },
  "control": { how: "an ordinary rescue turn that answered (rung 7)" },
};

const MODE = process.argv[2] ?? "rung3";
if (!MODES[MODE]) {
  console.error(`usage: node y2-…mjs <${Object.keys(MODES).join("|")}>`);
  process.exit(2);
}

let failures = 0;
const check = (label, ok) => {
  console.log(`   ${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) failures++;
};

/**
 * A host whose model really changes when `setModel` is called, because that is
 * the fact this probe is about. `_host.mjs`'s stub always answers true and
 * reports a fixed model.
 */
function makeRescueHost() {
  const base = makeHost({ percent: 20 });
  const setModels = [];
  let current = SMALL;
  base.pi.setModel = async (model) => {
    setModels.push(`${model.provider}/${model.id}`);
    current = model.id === "big" ? BIG : SMALL;
    return true;
  };
  base.ctx.modelRegistry = {
    find: (provider, id) => [SMALL, BIG].find((m) => m.provider === provider && m.id === id),
    getAll: () => [SMALL, BIG],
  };
  Object.defineProperty(base.ctx, "model", { get: () => current, configurable: true });
  return { ...base, setModels, model: () => `${current.provider}/${current.id}` };
}

/** Four identical tool-free turns: one to establish, three interventions. */
const REPEATED = "The core goal looks complete: the parser handles every fixture and the tests are green.";

const host = makeRescueHost();
loopMode(host.pi);

console.log(`\ny2 [${MODE}] — the rescue turn that never ended (AL2)\n`);
console.log(`   how the rescue turn ends here: ${MODES[MODE].how}\n`);

await host.run("start improve the parser --rescue-model big");
let last = "";
for (let i = 0; i < 4; i++) last = await host.turn({ messages: [REPEATED] });

console.log("   climbing the ladder to the rescue turn:");
console.log(`     the loop said        : ${last}`);
console.log(`     the session is now on: ${host.model()}\n`);
check("the run really reached a rescue turn", /rescue turn with big/.test(last));
check("…and the session really is on the rescue model", host.model() === "local/big");

host.setModels.length = 0;
let ending = "";
switch (MODE) {
  case "rung3":
    ending = await host.turn({ messages: [] });
    break;
  case "rung3-ten":
    for (let i = 0; i < 10; i++) ending = await host.turn({ messages: [] });
    break;
  case "rung5":
    ending = await host.turn({ messages: ["half a sen"], stopReason: "aborted" });
    break;
  case "rung1":
    ending = await host.run("finish");
    break;
  case "stop":
    ending = await host.run("stop");
    break;
  case "end":
    ending = await host.run("end");
    break;
  default:
    ending = await host.turn({ messages: ["Rewrote the tokenizer to stream; the suite is green."] });
}

console.log("   ending the rescue turn:");
console.log(`     the loop said        : ${ending || "(nothing)"}`);
console.log(`     BEFORE, the session stayed on : local/big`);
console.log(`     NOW,   the session is on      : ${host.model()}`);
console.log(`     models asked for since       : ${host.setModels.length ? host.setModels.join(", ") : "(none)"}\n`);

check("the session is back on the loop's own model", host.model() === "local/small");
check("nothing re-took the rescue model", !host.setModels.includes("local/big"));

if (MODE === "rung3" || MODE === "rung3-ten") {
  console.log("   this is the shape that costs most: a rescue model that is not");
  console.log("   loaded in llama-server answers with an empty turn, and rung 3");
  console.log("   answers an empty turn by retrying. BEFORE, every one of those");
  console.log("   retries was spent on the model that could not answer.\n");
  check("the loop treated it as a provider error", /model error, retrying|provider/i.test(ending));
}
if (MODE === "end") {
  console.log("   `/loop end` is the irreparable one: `state = defaultState()` on");
  console.log("   the next line destroys `rescueReturnModel`, so the stand-down");
  console.log("   has to happen above it or never.\n");
}
if (MODE === "control") {
  console.log("   rung 7 is the path that always worked, and it is the control:");
  console.log("   the fix must not change it.\n");
}

// Leave no scheduled iteration behind.
if (MODE !== "end" && MODE !== "stop") await host.run("stop");

console.log(failures === 0 ? "   all expectations held\n" : `   ${failures} expectation(s) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
