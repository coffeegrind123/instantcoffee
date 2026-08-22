/**
 * y8 — AL8. `/loop end` deletes the loop and left its pill in pi's footer.
 *
 * FIXED — this drives the REAL loop module through a run and every way of
 * ending one, and prints what the footer says after each, next to what
 * `/loop status` says at the same moment.
 *
 * ## The finding
 *
 * `ctx.ui.setStatus("loop", …)` appears thirty times in
 * `vendor/pi-loop-mode/extensions/index.ts`. `setStatus("loop", undefined)` —
 * the call that takes a pill OUT of the footer — appeared none. So nothing this
 * extension does has ever removed one; the only thing that ever did was the
 * host, at `resetExtensionUI()`, which runs when the session is replaced.
 *
 * Twenty-nine of the thirty are right as they stand. "Loop paused (max
 * iterations)", "Loop stopped", "Loop completed (check passed)" all describe a
 * loop that still EXISTS: it is in `.pi-loop-state.json`, `/loop status`
 * reports it, and `/loop resume` acts on it. A footer that keeps saying so is
 * telling the truth, and is the point of a footer.
 *
 * `end` is the exception and the only one. Its whole meaning is that there is no
 * loop any more — the statement above the notice is `state = defaultState()` —
 * so the pill was left naming something that had been deleted one line earlier,
 * for the rest of the session. The footer and `/loop status` then disagreed, and
 * the footer is the one nobody has to ask.
 *
 *   run: node --experimental-strip-types y8-the-footer-that-outlived-the-loop.mjs [end|clear|stop|finish]
 */

import { REPO, makeHost } from "./_host.mjs";

const loopMode = (await import(`${REPO}/vendor/pi-loop-mode/extensions/index.ts`)).default;

const MODES = {
  end: { command: "end", clears: true },
  clear: { command: "clear", clears: true },
  stop: { command: "stop", clears: false },
  finish: { command: "finish", clears: false },
};

const MODE = process.argv[2] ?? "end";
if (!MODES[MODE]) {
  console.error(`usage: node y8-…mjs <${Object.keys(MODES).join("|")}>`);
  process.exit(2);
}
const spec = MODES[MODE];

let failures = 0;
const check = (label, ok) => {
  console.log(`   ${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) failures++;
};

const host = makeHost({ percent: 20 });
/** Every ("loop", text) the run puts in the footer. `null` is a clear. */
const pills = [];
host.ctx.ui.setStatus = (key, text) => {
  if (key === "loop") pills.push(text === undefined ? null : text);
};
const footer = () => (pills.length === 0 ? "(never set)" : pills[pills.length - 1]);

loopMode(host.pi);

console.log(`\ny8 [${MODE}] — the footer that outlived the loop (AL8)\n`);

await host.run("start improve the parser");
await host.turn({ messages: ["Rewrote the tokenizer to stream; the suite is green."] });
console.log(`   while running   footer: ${JSON.stringify(footer())}`);

const notice = await host.run(spec.command);
const status = await host.run("status");

console.log(`   after /loop ${spec.command}`);
console.log(`     the loop said : ${notice}`);
console.log(`     BEFORE footer : ${JSON.stringify(spec.clears ? "Loop ended" : footer())}`);
console.log(`     NOW    footer : ${footer() === null ? "(cleared)" : JSON.stringify(footer())}`);
console.log(`     /loop status  : ${status.split("\n").filter((l) => /Active|Goal|Status/.test(l)).map((l) => l.trim()).join(" · ") || status.trim()}\n`);

if (spec.clears) {
  console.log("   `state = defaultState()` runs one line above the notice, so by");
  console.log("   the time the footer was set there was no loop for it to name.\n");
  check("the footer is cleared", footer() === null);
  check("…and the operator was still told what happened", /ended and state cleared/i.test(notice));
} else {
  console.log("   the control: this loop still exists and is resumable, so the");
  console.log("   footer should go on saying so.\n");
  check("the footer still names the loop", typeof footer() === "string" && footer().length > 0);
  check("…and was not cleared", footer() !== null);
}

await host.quit();
console.log(failures === 0 ? "   all expectations held\n" : `   ${failures} expectation(s) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
