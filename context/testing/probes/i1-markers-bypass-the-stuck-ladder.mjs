/**
 * I1 probe — U1 (**FIXED**): `LOOP_DONE:` and `LOOP_BLOCKED:` used to leave
 * `agent_end` above every stuck check, so a run carrying either marker could not
 * be detected as stuck at all.
 *
 * The guards on `agent_end`'s success path, in order: rescue-turn end → goal
 * check → **LOOP_DONE** → **LOOP_BLOCKED** → max iterations → score regression →
 * `detectStuck()` → no-progress audit → normal continue. The markers are the
 * third and fourth; `detectStuck()` was the seventh, and both markers `return`.
 * The verdict is now computed above them and consulted by them: completion still
 * wins, and CONTINUING with a marker no longer does.
 *
 * So every check that `detectStuck` owns — degenerate repetition, the
 * narration-only counter (`MAX_TOOLLESS_TURNS`), the identical-response tests,
 * the near-duplicate test, the repeated-tool-result test — is unreachable for
 * any response containing one of the two markers.
 *
 * That would be a narrow edge if the markers were rare. They are not: this is
 * ENDLESS mode, and the loop's own `loopInstructions()` tells the model
 *
 *     "Endless mode: if the core goal appears complete, say
 *      \"LOOP_DONE: <one-line summary>\" — the loop will then continue with
 *      improvement work … Never stop on your own."
 *
 * and then answers each one with the `improve` directive, which is a standing
 * invitation to say it again. The loop hands the model the exact token that
 * switches off the loop's own fixation detector.
 *
 * Run one mode per process — the loop's state is module-global:
 *   node --experimental-strip-types i1-markers-bypass-the-stuck-ladder.mjs done
 *   node --experimental-strip-types i1-markers-bypass-the-stuck-ladder.mjs blocked
 *   node --experimental-strip-types i1-markers-bypass-the-stuck-ladder.mjs plain   (control)
 */

import { REPO, makeHost, statusLines } from "./_host.mjs";

const ext = (await import(`${REPO}/vendor/pi-loop-mode/extensions/index.ts`)).default;
const MODE = process.argv[2] ?? "done";
const TURNS = 8;

const BODY =
  "The core goal looks complete: the parser handles every fixture in the suite and the tests are green.";
const PREFIX = { done: "LOOP_DONE: ", blocked: "LOOP_BLOCKED: ", plain: "" }[MODE] ?? "";

const host = makeHost({ percent: 20 });
ext(host.pi);
await host.run("improve the parser");

console.log(`=== I1 · MODE=${MODE} ===`);
console.log(`The same byte-identical, narration-only response ${TURNS} times.`);
console.log(`Response: "${PREFIX}${BODY.slice(0, 60)}…"\n`);

for (let i = 0; i < TURNS; i++) {
  const notice = await host.turn({ messages: [PREFIX + BODY], tools: [] });
  console.log(`  turn ${String(i + 1).padStart(2)}: ${notice}`);
}

const status = await host.run("status");
console.log("\n" + statusLines(status, /Iterations|Interventions|Done signals|Last notice/));

// One plain turn at the end shows the state the markers were hiding: the
// narration-only counter has been climbing the whole time, unread.
if (MODE !== "plain") {
  console.log("\nNow one turn WITHOUT the marker, same text:");
  console.log("  ", await host.turn({ messages: [BODY], tools: [] }));
}

await host.quit();

console.log(`
NOW: all three modes intervene from the second repeat and escalate identically —
the stuck verdict is computed above the marker branches, and a marker turn that
is repeating itself is treated as a repeating turn. The signal is still counted
and still logged; what it no longer buys is a way past the ladder.

BEFORE: "plain" produced seven interventions and reached the compaction rung at
five. "done" and "blocked" produced ZERO, because \`agent_end\` tests LOOP_DONE
third and LOOP_BLOCKED fourth and both \`return\`, while \`detectStuck()\` was
seventh. Every fixation check the loop has — degenerate repetition, the
narration-only counter, both identical-response tests, the near-duplicate test,
the repeated-tool-signature test, the repeated-question test — was unreachable
for any response carrying either marker.

That was the steady state rather than an edge case. This is ENDLESS mode by
default, and \`loopInstructions()\` asks the model for the marker by name — "if
the core goal appears complete, say LOOP_DONE: <one-line summary>" — then answers
each one with the improve directive, which invites another.

The last line used to be the sharpest evidence. Before the fix the eight marker
turns produced no intervention at all, and then a single turn with the marker
removed reported "no tool usage for 9 turns" — \`state.turnsWithoutTools\` is
incremented above the marker branches and read only below them, so nine turns of
evidence had been sitting there unread. Now it never gets that far: the second
marker turn intervenes, \`interveneStuck\` zeroes the counter, and the final plain
turn is caught by the near-duplicate rule instead. The counter was never the
problem; the branch that returned past it was.

"plain" is the control in both directions: it passed before the fix and passes
now, so it is what shows the fix did not simply make everything intervene.
`);
