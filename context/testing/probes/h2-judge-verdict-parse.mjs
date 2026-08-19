/**
 * H2 probe — S2: what `parseJudgeVerdict` makes of the replies a 27B gives.
 *
 * The judge prompt ends with:
 *
 *   Reply with exactly two lines:
 *   VERDICT: ADDRESSED or NOT_ADDRESSED
 *   WHY: one sentence, ...
 *
 * A small local model echoing that instruction line is one of the most common
 * failure shapes there is. `parseJudgeVerdict` tests NOT_ADDRESSED first —
 * correctly, since one string contains the other — and its second alternative
 * `/\bNOT[_\s-]ADDRESSED\b/i` used to match anywhere in the reply, so an echo of
 * the MENU of choices read as a chosen verdict, and read as the failing one.
 *
 * Now a `VERDICT:` line outranks a bare token, scanned newest-first, and a line
 * carrying the menu rather than a choice is skipped. The bare-token pass is kept
 * because it is what catches `NOT-ADDRESSED — it answered a different question`
 * and `**VERDICT:** ADDRESSED`; it just runs second, with the menu removed.
 *
 * Every case below carries the verdict it used to produce, so this is its own
 * control: EXPECT is what the parser should say, WAS is what it did say.
 *
 * Run: node --experimental-strip-types h2-judge-verdict-parse.mjs
 */

const REPO = "/home/claudeuser/qwen3.8-forge";
const { parseJudgeVerdict, buildJudgePrompt } = await import(`${REPO}/vendor/pi-subagents-lite/src/agents/verify.ts`);

/** [label, reply, what it SHOULD read as, what it DID read as before the fix] */
const CASES = [
  ["the intended good reply", "VERDICT: ADDRESSED\nWHY: it lists the callers as asked.", "pass", "pass"],
  ["the intended bad reply", "VERDICT: NOT_ADDRESSED\nWHY: it summarises a different file.", "repair", "repair"],
  ["echoes the instruction line, then answers", "VERDICT: ADDRESSED or NOT_ADDRESSED\nVERDICT: ADDRESSED\nWHY: the answer lists the callers.", "pass", "repair"],
  ["echoes the instruction line only", "VERDICT: ADDRESSED or NOT_ADDRESSED\nWHY: the answer does what was asked.", "unparsed", "repair"],
  ["restates the rubric before answering", "I must reply ADDRESSED or NOT_ADDRESSED.\nVERDICT: ADDRESSED\nWHY: fine.", "pass", "repair"],
  ["a pass whose WHY happens to contain the phrase", "VERDICT: ADDRESSED\nWHY: nothing in the task was left not addressed.", "pass", "repair"],
  ["markdown-bolded verdict", "**VERDICT:** ADDRESSED\nWHY: fine.", "pass", "pass"],
  ["a bolded fail", "**VERDICT:** NOT_ADDRESSED\nWHY: wrong file.", "repair", "repair"],
  ["a bare token, no VERDICT line", "NOT-ADDRESSED — it answered a different question", "repair", "repair"],
  ["reconsiders, and commits last", "VERDICT: ADDRESSED\nWHY: hmm.\nVERDICT: NOT_ADDRESSED\nWHY: on reflection, wrong file.", "repair", "repair"],
  ["chatty prose, no verdict token", "Yes, this looks like a reasonable answer to the question.", "unparsed", "unparsed"],
];

const read = (v) => (v.unparsed ? "unparsed" : v.addressed ? "pass" : "repair");

console.log("=== H2: parseJudgeVerdict on realistic replies ===");
console.log("(pass = delivered as-is · repair = sent back, 2 more model calls · unparsed = fails open)\n");

let wrong = 0;
let changed = 0;
for (const [label, reply, expect, was] of CASES) {
  const now = read(parseJudgeVerdict(reply));
  if (now !== expect) wrong++;
  if (was !== expect) changed++;
  const mark = now === expect ? "  " : "!!";
  console.log(`${mark}${label}`);
  console.log(`    reply  : ${JSON.stringify(reply)}`);
  console.log(`    WAS    : ${was}${was === expect ? "" : "   <- wrong"}`);
  console.log(`    NOW    : ${now}${now === expect ? "" : "   <- WRONG"}\n`);
}

console.log("---");
console.log(`cases the old parser got wrong : ${changed}/${CASES.length}`);
console.log(`cases the parser gets wrong now : ${wrong}/${CASES.length}`);
console.log(`
The four that changed were all a GOOD answer sent back for repair: two extra
model calls on the slot the parent is blocked on, and — if the repair did not
satisfy the judge either — a "✗ off-task" badge and a "[verification: ... Treat
it as unreliable.]" note attached to an answer that was right the first time.

The two bolded cases and the bare-token one are the controls on the fix rather
than evidence for it. They show why the loose alternatives were kept rather than
deleted: the strict "VERDICT:\\s*ADDRESSED" form misses "**VERDICT:** ADDRESSED",
and nothing anchored catches "NOT-ADDRESSED — it answered a different question".
The loose NOT_ADDRESSED alternative was the one that over-fired, and it fired
FIRST; it now runs second, with the prompt's own menu removed from the text.

"echoes the instruction line only" lands on unparsed rather than pass, which is
the honest reading: the judge did not choose, and unparsed fails open.
`);

// The prompt line the model is being asked to echo, for the record.
const prompt = buildJudgePrompt("TASK", "ANSWER");
console.log("the instruction the reply is echoing:");
console.log("  " + prompt.split("\n").slice(-2).join("\n  "));
