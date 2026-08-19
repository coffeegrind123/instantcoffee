/**
 * I5 probe — U5 (**FIXED**): `loop(action: "start", …)` used to silently replace
 * a loop that was already running, and the replacement was endless.
 *
 * The tool's action set is closed on purpose. The comment above it says why:
 *
 *     "the command's final branch treats anything it does not recognise as a
 *      goal to start looping on, which is a sensible convenience for a person
 *      and a live grenade for a model that invents a verb."
 *
 * The same argument applies to `start` when a loop is already active, and it was
 * not carried across. `/loop run` and `/loop goal` both refuse while a loop is
 * running ("Loop is already running", "Use /loop stop first"); `start` does not,
 * because for a HUMAN typing `/loop start` replacement is the intent — the stop
 * notice literally advertises it: "/loop start to replace".
 *
 * Through the tool it is a different act by a different party. `applyGoalConfig()`
 * spreads `defaultState()`, so the operator's goal, criteria, iteration count,
 * error counters, check command and iteration CAP were all discarded, and
 * `startArgsFromToolParams` supplies `maxIterations: 0` for any call that omits
 * `max` — which is endless, the mode whose own rule is "Never stop on your own."
 * `state.active` never went false across the swap, so nothing watching for a stop
 * saw one, and the operator's only signal was one info notice naming the new
 * goal.
 *
 * Run one path per process:
 *   node --experimental-strip-types i5-loop-tool-start-replaces-a-running-loop.mjs tool
 *   node --experimental-strip-types i5-loop-tool-start-replaces-a-running-loop.mjs command
 */

import { REPO, makeHost, toolResult, statusLines } from "./_host.mjs";

const ext = (await import(`${REPO}/vendor/pi-loop-mode/extensions/index.ts`)).default;
const VIA = process.argv[2] ?? "tool";

const host = makeHost({ percent: 20, idle: false });
ext(host.pi);

// The operator starts a long, bounded, unattended run and it gets five iterations in.
await host.run(
  "start migrate every callsite of the legacy importer to the new API, in small commits. " +
    "Done when: the build is green and no callsite remains --max 500",
);
for (let i = 0; i < 5; i++) {
  await host.turn({
    messages: [`Converted callsite ${"abcde"[i]} and committed.`],
    tools: [toolResult("edit", `edited src/site-${i}.ts`)],
  });
}

const FIELDS = /^Active|^Goal:|^Criteria|^Mode|^Iterations/;
console.log("=== I5 · the operator's loop, five iterations in ===");
console.log(statusLines(await host.run("status"), FIELDS));

console.log(`\n=== the model now runs loop start (via: ${VIA}) ===`);
if (VIA === "tool") {
  const tool = host.getTool();
  host.notices.length = 0;
  const result = await tool.execute(
    "call-1",
    { action: "start", goal: "summarise the file I just read. Done when: there is a summary" },
    undefined,
    undefined,
    host.ctx,
  );
  console.log("  isError      :", result.isError ?? false);
  console.log("  tool returned:", JSON.stringify(result.content[0].text));
} else {
  console.log("  notify:", await host.run("start summarise the file I just read. Done when: there is a summary"));
}

console.log("\n=== the operator's loop, afterwards ===");
console.log(statusLines(await host.run("status"), FIELDS));

await host.quit();

console.log(`
NOW (via: tool)

  The call comes back \`isError: true\` with the running goal and its iteration
  count in the text, and the loop is untouched — same goal, same criteria, same
  500-iteration cap, same count. The model can read the refusal and decide what
  to do; \`stop\` then \`start\` still works, deliberately.

NOW (via: command)

  Unchanged, and deliberately so. For a human typing \`/loop start\` replacement IS
  the intent — the stop notice advertises it, "/loop start to replace" — so the
  slash command still replaces. That asymmetry is the whole finding: the guard is
  for the caller that cannot be asked whether it meant to.

BEFORE (both paths)

  Goal replaced, criteria replaced, \`Iterations: 0/∞\` where a 500-iteration cap
  had been, and the tool reported success. \`Active\` never went false. The tool's
  own result text could not say a loop had been replaced, because by the time it
  was built the previous goal no longer existed.
`);
