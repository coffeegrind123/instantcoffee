/**
 * I2 probe — U2 (**FIXED**): the loop's repetition memory used to be measured in
 * assistant MESSAGES and tool RESULTS, while every rule written on top of it is
 * phrased in TURNS. It is now filled once per turn, from `commitTurnMemory`.
 *
 * `pi.on("message_end")` fires once per assistant message, and a tool-using turn
 * produces several: a message that announces a tool call, another after the
 * results, and a final answer. `pi.on("tool_result")` likewise fires once per
 * call. Both handlers `pushLimited` into fixed windows —
 *
 *     fingerprints 8 · snippets 5 · texts 4 · toolResults 10   (PERSISTED_WINDOW)
 *
 * — and `detectStuck()` reads those windows at `agent_end`, i.e. once per turn,
 * describing what it finds as "the assistant repeated the same response" and
 * "the same grep calls returned the same thing 3 turns running".
 *
 * The unit mismatch cut both ways, and both are shown here.
 *
 *   blind    Four consecutive turns whose FINAL answer is byte-identical. Before
 *            the fix they were not detected at all, because each turn's four
 *            intermediate messages pushed the previous turn's answer out of an
 *            8-slot window before the next comparison happened — the exact
 *            failure the detector exists for, on the shape a tool-using loop
 *            always has.
 *   control  The same four turns with one message each. Caught on turn 2, before
 *            and after.
 *   noisy    ONE productive turn — an edit, then three greps confirming nothing
 *            references the removed symbol. Before the fix this was reported
 *            stuck, because the last three tool results were three identical
 *            "No matches found."
 *   quiet    The same turn with the greps FIRST and the edit last, which before
 *            the fix was NOT reported stuck — so the verdict depended on the
 *            order the model happened to work in.
 *
 * Run one mode per process:
 *   node --experimental-strip-types i2-repetition-window-counts-messages.mjs blind
 *   node --experimental-strip-types i2-repetition-window-counts-messages.mjs control
 *   node --experimental-strip-types i2-repetition-window-counts-messages.mjs noisy
 *   node --experimental-strip-types i2-repetition-window-counts-messages.mjs quiet
 */

import { REPO, makeHost, toolResult } from "./_host.mjs";

const ext = (await import(`${REPO}/vendor/pi-loop-mode/extensions/index.ts`)).default;
const MODE = process.argv[2] ?? "blind";

const host = makeHost({ percent: 20 });
ext(host.pi);
await host.run("tidy the importer");

const FINAL =
  "Nothing further to change here; the importer already handles every case in the fixture set and the suite is green.";

/** Four distinct intermediate messages, the way a tool-using turn really arrives. */
const intermediates = (i) => [
  `Reading the importer entry point to see how stage ${"abcd"[i]} is wired.`,
  `Grepping for the ragged-row handler in the reader package under src/${"wxyz"[i]}.`,
  `Checking whether the ${["alpha", "beta", "gamma", "delta"][i]} fixture still applies.`,
  `Running the focused suite for the ${["one", "two", "three", "four"][i]} case.`,
];

const NOMATCH = toolResult("grep", "No matches found.");
const EDIT = toolResult("edit", "edited src/importer.ts");

console.log(`=== I2 · MODE=${MODE} ===\n`);

if (MODE === "blind" || MODE === "control") {
  console.log(
    MODE === "blind"
      ? "Four turns. Each ends with the SAME answer, each also emits four intermediate messages."
      : "Four turns. Each is the SAME answer and nothing else — one assistant message per turn.",
  );
  console.log(`Final answer each turn: "${FINAL.slice(0, 60)}…"\n`);
  for (let i = 0; i < 4; i++) {
    const messages = MODE === "blind" ? [...intermediates(i), FINAL] : [FINAL];
    // Distinct tool results per call, so the repeated-tool-result rule (the
    // other half of this probe) cannot account for the outcome either way.
    const notice = await host.turn({
      messages,
      tools: [0, 1, 2, 3].map((k) => toolResult("edit", `edited src/stage-${i}-${k}.ts`)),
    });
    console.log(`  turn ${i + 1} (${messages.length} assistant message${messages.length > 1 ? "s" : ""}): ${notice}`);
  }
} else {
  const order =
    MODE === "noisy"
      ? [EDIT, NOMATCH, NOMATCH, NOMATCH]
      : [NOMATCH, NOMATCH, NOMATCH, EDIT];
  console.log(
    MODE === "noisy"
      ? "ONE turn: remove the shim, then three greps confirming nothing references it."
      : "ONE turn: three greps looking for the shim's callers, then remove it.",
  );
  console.log(`Tool results in order: ${order.map((t) => t.toolName).join(", ")}\n`);
  const notice = await host.turn({
    messages: [
      "Removing the shim, and confirming nothing still references it.",
      "Done — the shim is gone and three searches come back empty.",
    ],
    tools: order,
  });
  console.log(`  turn 1: ${notice}`);
}

await host.quit();

console.log(`
NOW

  blind / control
    Identical. Four turns with the same final answer are caught on turn 2 whether
    each turn is one assistant message or five, because a turn contributes ONE
    entry: its final answer. \`commitTurnMemory\` does the push, at agent_end,
    from a buffer that message_end fills and every early return drops.

  noisy / quiet
    Neither is stuck. The tool window now holds one signature per turn — the
    ordered (tool, result) pairs, hashed — so three empty greps inside one turn
    are one entry, and the verdict no longer depends on which order the model
    worked in. Three turns that make the SAME calls and get the SAME answers back
    are still caught; that case is pinned in tests/stuck-ladder.test.ts, because a
    fix that just stopped intervening would pass this probe.

BEFORE

  blind    no intervention in four turns. Five messages per turn against an
           8-slot window meant the previous turn's answer was five places back by
           the time the next one arrived, so the "last two" and "last three"
           tests never saw two answers adjacent — and \`lastAssistantTexts\` is 4
           deep, so the near-duplicate test compared a turn's final answer against
           ITS OWN second message.
  control  caught on turn 2. The only difference is how many messages the turn
           took to say it.
  noisy    "Loop stuck (1x): same grep result repeated" — on a turn that removed
           a shim and confirmed the removal. The intervention is not free: it
           arms the sampling penalties for three turns, adds an escalating delay,
           injects "You are repeating yourself. Do NOT repeat the previous
           answer" into a turn that did real work, and counts toward the rescue
           and compaction rungs.
  quiet    no notice, for the same turn.

Neither direction was a threshold that wanted tuning. Both were the same fact:
the windows counted messages and tool calls, and every rule and every notice
built on them is written in turns.
`);
