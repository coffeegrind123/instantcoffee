/**
 * j8 — V8. `applyGoalConfig` preserves `preparedAt` across a re-issued goal and
 *      resets `goalFile` — the flag that says a spec exists survives, the field
 *      that says WHERE does not.
 *
 *     const preservedPreparedAt = state.description === parsed.description ? state.preparedAt : 0;
 *     state = { ...defaultState(), … goalFile: parsed.goalFile || "GOAL.md", preparedAt: preservedPreparedAt };
 *
 * The comment on that line — "Re-issuing the same goal (e.g. to tweak flags
 * after /loop prepare) keeps the prepared spec" — is the intent. Every flag the
 * re-issue omits is reset, and `--file` is one of them, so the loop then tells
 * the model to read a file nobody wrote.
 *
 * FIXED. The pair is preserved together: a same-goal re-issue keeps `goalFile`
 * when `preparedAt` survives. An explicit `--file` still wins, and an unprepared
 * re-issue still defaults to GOAL.md.
 *
 *   node --experimental-strip-types j8-prepared-spec-file-lost-on-restart.mjs
 */
import { makeHost, statusLines } from "./_host.mjs";
import loopExtension from "../../../vendor/pi-loop-mode/extensions/index.ts";

const host = makeHost();
loopExtension(host.pi);
const GOAL = "port the renderer to the new API";

console.log("=== /loop goal --file SPEC.md → /loop prepare → /loop start <same goal> ===\n");
await host.run(`goal ${GOAL} --file SPEC.md`);
console.log(statusLines(await host.run("status"), /^Goal file/));

await host.run("prepare");
await host.fire("agent_end", {
  messages: [{ role: "assistant", content: [{ type: "text", text: "GOAL_READY: spec written to SPEC.md" }], stopReason: "stop" }],
});
console.log(statusLines(await host.run("status"), /^Goal file/));

console.log("\n  --- /loop start <the same goal>, with no --file ---\n");
await host.run(`start ${GOAL}`);
console.log(statusLines(await host.run("status"), /^Goal file/));

const start = host.sent.find((m) => m.details?.kind === "start");
const lines = (start?.content ?? "").split("\n");
console.log("\n  the first turn the loop sends:");
console.log("    " + lines[0]);
console.log("    " + lines.find((l) => l.startsWith("Specification:")));
console.log(`
BEFORE the fix

  Goal file: GOAL.md (prepared)
    Start loop mode. First read GOAL.md to load the full specification, …
    Specification: GOAL.md — read it whenever you lose track of the plan.

  The spec was on disk at SPEC.md. Both lines pointed at GOAL.md, which does not
  exist — and both lines are only there BECAUSE preparedAt was preserved.

NOW

  Both point at the spec that exists. The two lines before the re-issue are the
  control, and \`tests/run-restart.test.ts\` adds three more: an explicit --file
  still wins, a DIFFERENT goal drops both the flag and the file, and an
  unprepared re-issue still defaults to GOAL.md.`);
await host.quit();
process.exit(0);
