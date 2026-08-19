/**
 * j1 — V1. A reasoning-only turn stopped being "empty" when forge stopped
 *      destroying the reasoning, and the loop's starvation rung reads "empty".
 *
 * `patches/forge_reasoning_passthrough.py` (commit e81a7e5) restored
 * `reasoning_content` on the wire, so a turn where the model produced reasoning
 * and nothing else now reaches pi as `content: [thinking]` instead of
 * `content: []`. `vendor/prinny-channel` was changed in the SAME commit to
 * notice the new shape; `vendor/pi-loop-mode` was not.
 *
 *   agent_end's emptyResponse =
 *       Boolean(lastAssistant)
 *       && !messageToText(m).trim()
 *       && !messageToRepetitionText(m).trim()   <- reads `thinking` blocks
 *       && toolCallsThisTurn === 0
 *
 * The middle line is the one that changed meaning. `messageToRepetitionText`
 * exists so the DEGENERATE-repetition scan can see thinking; borrowing it for
 * "did the model say anything" makes a thinking-only turn non-empty.
 *
 * FIXED. `emptyResponse` now asks whether the model produced an ANSWER — text or
 * a tool call — and the thinking is reported separately so the operator can tell
 * the two empties apart. The two modes are the two message SHAPES, and both now
 * route to recovery; before the fix only `before` did.
 *
 * Run both modes (one process each — the loop's state is module-global):
 *   node --experimental-strip-types j1-reasoning-only-turn-is-not-empty.mjs before
 *   node --experimental-strip-types j1-reasoning-only-turn-is-not-empty.mjs after
 */
import { makeHost, statusLines } from "./_host.mjs";
import loopExtension from "../../../vendor/pi-loop-mode/extensions/index.ts";

const mode = process.argv[2] ?? "after";
const host = makeHost({ percent: 90 });
loopExtension(host.pi);

// The SAME provider turn, in the two shapes it has had.
const message =
  mode === "before"
    ? { role: "assistant", content: [], stopReason: "stop", usage: { output: 126 } }
    : {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking:
              "Let me think about which file to open first. The parser lives in src/, and the " +
              "failing test names tokenize(), so that is probably where the fault is. I should " +
              "read it before changing anything.",
          },
        ],
        stopReason: "stop",
        usage: { output: 126 },
      };

console.log("=== a reasoning-only turn at 90% of a 32k window ===");
console.log(
  mode === "before"
    ? "    BEFORE the forge patch: reasoning discarded, pi gets content: []\n"
    : "    AFTER  the forge patch: reasoning preserved, pi gets content: [thinking]\n",
);

await host.run("start migrate the callsites");
host.notices.length = 0;
await host.fire("message_end", { message });
await host.fire("agent_end", { messages: [message] });

console.log("  what the loop did:");
console.log("    " + (host.notices.join("\n    ") || "(no notice at all)"));
console.log();
console.log(statusLines(await host.run("status"), /^(Status|Iterations|Errors|Context recoveries|Last notice)/));

console.log(`
BEFORE the fix

  before   Loop: context pressure detected (1/3) — recovering.
           "empty response at 90% context (no text, no thinking, no tool call)"
           Iterations 0/∞ · Errors 1

  after    (no notice at all)
           Iterations 1/∞ · Errors 0

           The turn was counted as a successful iteration — and the success path
           RESETS consecutiveErrorCount, contextCooldownCount and
           contextCompressionLevel, so the ladder could never accumulate the three
           consecutive failures CONTEXT_RECOVERY_ATTEMPTS needs. The next turn was
           scheduled into the same 90%-full window.

NOW

  Both shapes route to recovery, and the notice says which one it was. \`before\` is
  the control: it behaved correctly throughout, and a fix that broke it would be
  worse than the defect.

  The measurement the rung was built on: below 87% of the window, 3 empty
  assistant turns out of 196; at or above 87%, 33 out of 63. It is a cliff, and an
  empty turn still costs a full iteration.`);
await host.quit();
process.exit(0);
