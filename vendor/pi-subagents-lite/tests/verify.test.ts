/**
 * The verifier's judgement, without a model in the loop.
 *
 * These pin the decisions that are easy to get subtly wrong and impossible to
 * notice afterwards: that "NOT_ADDRESSED" is not read as "ADDRESSED" because it
 * contains it, that an unreadable verdict fails open rather than throwing away
 * good work, and that the repair prompt restates the brief instead of pointing
 * at it — the brief being exactly the thing that may have gone missing.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  JUDGE_ANSWER_CHARS,
  JUDGE_BRIEF_CHARS,
  VERDICT_MENU_TEXT,
  WHY_INSTRUCTION,
  briefForCheck,
  buildAnchorMessage,
  buildJudgePrompt,
  buildRepairPrompt,
  parseJudgeVerdict,
  structuralVerdict,
  MAX_BRIEF_CHARS,
  appendFollowUp,
  verificationNote,
} from "../src/agents/verify.ts";

const BRIEF = "Find every call site of decodeFrame() and report the file and line of each.";

describe("structuralVerdict", () => {
  it("fails an empty answer, and says what to do instead of repeating the task", () => {
    const v = structuralVerdict("", { status: "completed" } as any);
    assert.equal(v.ok, false);
    assert.equal(v.worthJudging, false);
    assert.match(v.note ?? "", /narrower question/);
  });

  it("treats whitespace as empty", () => {
    assert.equal(structuralVerdict("   \n\t ", { status: "completed" } as any).ok, false);
  });

  it("does not pay a judge to confirm what the status note already says", () => {
    for (const status of ["aborted", "turn_limited", "stopped"]) {
      const v = structuralVerdict("partial work", { status } as any);
      assert.equal(v.ok, true, `${status} keeps its partial output`);
      assert.equal(v.worthJudging, false, `${status} already explains itself`);
    }
  });

  it("does not judge a run that ended in a provider error, whose text is never shown at all", () => {
    // Stronger than the three above: for a foreground spawn, `executeAgentTool`
    // intercepts error status and returns `errorResult(record.error)` without
    // reading `record.result`. So a judge and up to three repairs could run, on
    // the one slot the parent is blocked on, and every character they produced
    // was then discarded unread.
    const v = structuralVerdict("half an answer before the provider died", { status: "error" } as any);
    assert.equal(v.ok, true, "the partial text is still kept on the record");
    assert.equal(v.worthJudging, false, "but no model call may be spent on it");
    // Grouped with the cutoffs for cost, reported apart from them for truth: the
    // operator reads this in the widget, and "cut off" describes a run that was
    // stopped or ran out of turns, which is not what happened here.
    assert.equal(v.skip, "error", "a provider error is not a cutoff");
    for (const status of ["aborted", "turn_limited", "stopped"]) {
      assert.equal(structuralVerdict("partial", { status } as any).skip, "cutoff", `${status} is a cutoff`);
    }
  });

  it("sends a clean, non-empty answer to the judge — the case where drift is invisible", () => {
    const v = structuralVerdict("src/decode.ts:12", { status: "completed" } as any);
    assert.deepEqual(v, { ok: true, worthJudging: true });
  });
});

describe("buildJudgePrompt", () => {
  it("shows the judge the task and the answer, and nothing else", () => {
    const prompt = buildJudgePrompt(BRIEF, "src/decode.ts:12");
    assert.ok(prompt.includes(BRIEF));
    assert.ok(prompt.includes("src/decode.ts:12"));
    assert.match(prompt, /not checking whether the work is correct/i);
  });

  it("asks for the verdict before the reasoning", () => {
    // A local model allowed to reason first talks itself into agreement.
    const prompt = buildJudgePrompt(BRIEF, "x");
    assert.ok(prompt.indexOf("VERDICT:") < prompt.indexOf("WHY:"));
  });

  it("bounds what it quotes, so a huge answer cannot make the check expensive", () => {
    const prompt = buildJudgePrompt(BRIEF, "y".repeat(50_000));
    assert.ok(prompt.length < JUDGE_ANSWER_CHARS + 3_000, `judge prompt was ${prompt.length} chars`);
    assert.match(prompt, /more chars/);
  });
});

describe("parseJudgeVerdict", () => {
  it("reads a pass", () => {
    const v = parseJudgeVerdict("VERDICT: ADDRESSED\nWHY: it lists every call site with line numbers.");
    assert.equal(v.addressed, true);
    assert.equal(v.unparsed, false);
    assert.match(v.why, /call site/);
  });

  it("reads a fail without being fooled by the substring", () => {
    // "NOT_ADDRESSED" contains "ADDRESSED". Matching the wrong one first turns
    // every failure into a pass, silently.
    const v = parseJudgeVerdict("VERDICT: NOT_ADDRESSED\nWHY: it describes the function instead of finding callers.");
    assert.equal(v.addressed, false);
    assert.match(v.why, /instead of finding callers/);
  });

  it("accepts the loose shapes a 27B actually produces", () => {
    assert.equal(parseJudgeVerdict("verdict: not addressed\nwhy: nope").addressed, false);
    assert.equal(parseJudgeVerdict("NOT-ADDRESSED — it answered a different question").addressed, false);
    assert.equal(parseJudgeVerdict("VERDICT:ADDRESSED").addressed, true);
  });

  // S1 (fourth pass). The judge prompt ends "VERDICT: ADDRESSED or
  // NOT_ADDRESSED", and a 27B echoing its own instructions is one of the most
  // common reply shapes there is. A loose token search reads that echo as a
  // chosen verdict, and — because NOT_ADDRESSED is correctly tested first — as a
  // failure. Every case below came back NOT_ADDRESSED before the VERDICT-line
  // pass was added.
  it("does not read the prompt's own menu of choices as a verdict", () => {
    const echoThenAnswer = parseJudgeVerdict(
      "VERDICT: ADDRESSED or NOT_ADDRESSED\nVERDICT: ADDRESSED\nWHY: the answer lists the callers.",
    );
    assert.equal(echoThenAnswer.addressed, true, "an explicit verdict line outranks the menu above it");
    assert.equal(echoThenAnswer.unparsed, false);

    const rubricThenAnswer = parseJudgeVerdict("I must reply ADDRESSED or NOT_ADDRESSED.\nVERDICT: ADDRESSED\nWHY: fine.");
    assert.equal(rubricThenAnswer.addressed, true, "restating the rubric first is not a failing verdict");

    const menuOnly = parseJudgeVerdict("VERDICT: ADDRESSED or NOT_ADDRESSED\nWHY: the answer does what was asked.");
    assert.equal(menuOnly.unparsed, true, "a judge that only echoed the menu did not choose");
    assert.equal(menuOnly.addressed, true, "and an unread verdict fails open");
  });

  it("does not read 'not addressed' inside a WHY as the verdict", () => {
    const v = parseJudgeVerdict("VERDICT: ADDRESSED\nWHY: nothing in the task was left not addressed.");
    assert.equal(v.addressed, true);
    assert.equal(v.unparsed, false);
  });

  it("still reads a real fail, whether or not it is on a VERDICT line", () => {
    // The controls for the two cases above: the fix must not have bought them by
    // making the parser deaf to an actual NOT_ADDRESSED.
    assert.equal(parseJudgeVerdict("VERDICT: NOT_ADDRESSED\nWHY: wrong file.").addressed, false);
    assert.equal(parseJudgeVerdict("**VERDICT:** NOT_ADDRESSED\nWHY: wrong file.").addressed, false);
    assert.equal(parseJudgeVerdict("NOT-ADDRESSED — it answered a different question").addressed, false);
    assert.equal(
      parseJudgeVerdict("VERDICT: ADDRESSED\nWHY: hmm.\nVERDICT: NOT_ADDRESSED\nWHY: on reflection, wrong file.").addressed,
      false,
      "the last verdict line wins — a model that reconsiders commits last",
    );
  });

  // AH2 (seventeenth pass). `UNADDRESSED` is what a 27B writes when it means
  // NOT_ADDRESSED, and it is the ordinary English word for the thing being
  // reported. Before the fix each of these came back `addressed: true` with
  // `unparsed: false` — a false PASS, reported to the parent as a check that
  // succeeded, which is the one outcome the module's own comment calls fatal.
  it("reads UNADDRESSED as a fail, not as a pass", () => {
    for (const reply of [
      "VERDICT: UNADDRESSED\nWHY: it never opened the file.",
      "VERDICT: Unaddressed\nWHY: it answered a different question.",
      "**VERDICT:** UNADDRESSED",
      "UNADDRESSED — it answered a different question.",
    ]) {
      const v = parseJudgeVerdict(reply);
      assert.equal(v.addressed, false, `read as a PASS: ${JSON.stringify(reply)}`);
    }
  });

  // The control for the fix above, and the reason it is an alternation rather
  // than the `\b` the thirteenth pass weighed and declined: the VERDICT-line
  // value arrives with its markdown attached, and `_` is a word character, so
  // `\bADDRESSED\b` would stop reading an italicised verdict.
  it("still reads the tolerant positive forms the parser was widened for", () => {
    assert.equal(parseJudgeVerdict("VERDICT: _ADDRESSED_").addressed, true);
    assert.equal(parseJudgeVerdict("VERDICT: ** ADDRESSED").addressed, true);
    assert.equal(parseJudgeVerdict("VERDICT: ADDRESSED\nWHY: nothing was left unaddressed.").addressed, true);
  });

  it("reads a markdown-bolded verdict", () => {
    assert.equal(parseJudgeVerdict("**VERDICT:** ADDRESSED\nWHY: fine.").addressed, true);
    assert.equal(parseJudgeVerdict("> verdict : addressed").addressed, true);
  });

  it("fails OPEN on an unreadable reply, and says so rather than claiming a pass", () => {
    const v = parseJudgeVerdict("I think it's probably fine, honestly.");
    assert.equal(v.addressed, true, "a chatty judge must not discard good work");
    assert.equal(v.unparsed, true, "but the parent must be told it went unchecked");
  });

  it("survives a non-string reply rather than throwing at settle time", () => {
    const v = parseJudgeVerdict(undefined as unknown as string);
    assert.equal(v.addressed, true);
    assert.equal(v.unparsed, true);
  });
});

describe("buildRepairPrompt", () => {
  it("restates the brief in full rather than referring to it", () => {
    // Pointing at "the original task" points at the thing that went missing.
    const prompt = buildRepairPrompt(BRIEF, "it described the function instead");
    assert.ok(prompt.includes(BRIEF));
    assert.match(prompt, /it described the function instead/);
  });

  it("forbids the two answers a cornered model gives instead of answering", () => {
    const prompt = buildRepairPrompt(BRIEF, "why");
    assert.match(prompt, /do not restate the task/i);
    assert.match(prompt, /do not describe what you would do/i);
  });
});

describe("buildAnchorMessage", () => {
  it("carries the brief and says it is not new work", () => {
    const msg = buildAnchorMessage(BRIEF);
    assert.ok(msg.includes(BRIEF));
    assert.match(msg, /Nothing here is new work/);
  });

  it("stays short — it lands in a context that was just cut down for room", () => {
    const msg = buildAnchorMessage("z".repeat(50_000));
    assert.ok(msg.length < 2_000, `anchor was ${msg.length} chars`);
  });
});

describe("verificationNote", () => {
  it("distinguishes a failed check from an unread one", () => {
    assert.match(verificationNote("failed"), /Treat it as unreliable/);
    assert.match(verificationNote("unparsed"), /went out unchecked/);
    assert.match(verificationNote("repaired"), /corrected one/);
  });

  // AH5 (seventeenth pass). `SUBAGENT_VERIFY_ROUNDS=0` is a value `clampRounds`
  // accepts, and at it `attempts` is 0 on the `failed` path. The note then said
  // "no attempt was made to correct it" and "kept because the corrections were
  // no better" in one sentence — `describeAttempts` was made count-aware and the
  // clause after it was not.
  it("does not claim corrections that were never attempted", () => {
    const none = verificationNote("failed", 0);
    assert.match(none, /no attempt was made to correct it/);
    assert.doesNotMatch(none, /corrections were no better/);
    // The control: the ordinary shape still says why the original was kept.
    assert.match(verificationNote("failed", 1), /corrections were no better/);
    assert.match(verificationNote("failed", 2), /corrections were no better/);
  });

  /**
   * W5 — these are the verifier's only channel to the PARENT MODEL, and this
   * file's own comment on `describeAttempts` says why the wording is not
   * decoration: "the parent model reads this text, and '1 attempts' is the kind
   * of thing it copies into its own answer."
   *
   * Two of the five notes built their own count and got it wrong in opposite
   * directions. See W5 in
   * context/design/subagents-loop-verifier-readers.md.
   */
  it("counts a repair in English, at every budget it can be given", () => {
    // `${attempts}th` is correct from four upwards and MAX_VERIFY_ROUNDS is 3,
    // so every reachable value read wrong: "the 2th attempt", "the 3th attempt".
    assert.match(verificationNote("repaired", 2), /the second attempt/);
    assert.match(verificationNote("repaired", 3), /the third attempt/);
    for (const attempts of [0, 1, 2, 3]) {
      assert.doesNotMatch(verificationNote("repaired", attempts), /\dth attempt/);
    }
    // The control: one repair still reads as the plain sentence, which is the
    // only shape anyone has seen because the default budget is one round.
    assert.match(verificationNote("repaired", 1), /this is the corrected one/);
  });

  it("counts the ask that was not made, rather than hardcoding it", () => {
    // The task is the first ask and each repair is one more, so the ask NOT made
    // is `attempts + 2`. At the default budget that is the third — which is what
    // the sentence used to say unconditionally, and why it stayed invisible.
    assert.match(verificationNote("stalled", 1), /not asked a third time/);
    assert.match(verificationNote("stalled", 2), /not asked a fourth time/);
    assert.match(verificationNote("stalled", 3), /not asked a fifth time/);
  });

  it("says the first answer failed when an unreadable check followed a repair", () => {
    // `verifyAnswer` returns the CANDIDATE on this path, and from the second
    // round on the candidate is a corrected answer. A note that mentions only the
    // unreadable check drops the one fact a `repaired` note exists to carry.
    assert.match(verificationNote("unparsed", 0), /^\n\n\[verification: the check could not be read/);
    assert.match(verificationNote("unparsed", 1), /the first answer did not address the task/);
    assert.match(verificationNote("unparsed", 1), /could not be read/);
  });

  it("defaults to claiming no repair rather than one", () => {
    // The default used to be 1 — an assertion that a repair had happened, made by
    // a parameter whose whole job is not to overclaim. Every real caller passes
    // it; the default is only ever read by one that has no count to give.
    assert.equal(verificationNote("unparsed"), verificationNote("unparsed", 0));
    assert.match(verificationNote("failed"), /no attempt was made to correct it/);
  });
});

describe("appendFollowUp", () => {
  const STEER = "Now also list the callers of validateToken().";

  it("keeps the original task alongside the follow-up", () => {
    // The failure: `brief` was written once at spawn and never updated, so a
    // steered continuation answered the STEER and was judged against the
    // ORIGINAL. The judge said NOT_ADDRESSED — correctly — and the repair then
    // told the child to answer the original instead, discarding the operator's
    // instruction and labelling the result "repaired".
    const out = appendFollowUp(BRIEF, STEER);
    assert.ok(out.includes(BRIEF), "the original task must survive — the follow-up presupposes it");
    assert.ok(out.includes(STEER), "and the steer has to be in what the judge checks against");
  });

  it("accumulates across several steers, oldest first", () => {
    const out = appendFollowUp(appendFollowUp(BRIEF, "one"), "two");
    assert.ok(out.indexOf("one") < out.indexOf("two"));
    assert.ok(out.includes(BRIEF));
  });

  it("ignores an empty or whitespace steer rather than growing the brief", () => {
    assert.equal(appendFollowUp(BRIEF, ""), BRIEF);
    assert.equal(appendFollowUp(BRIEF, "   \n "), BRIEF);
  });

  it("uses the steer alone when there was no brief to extend", () => {
    assert.equal(appendFollowUp(undefined, STEER), STEER);
    assert.equal(appendFollowUp("", STEER), STEER);
  });

  it("stays bounded however many times an agent is steered", () => {
    let brief = BRIEF;
    for (let i = 0; i < 500; i++) brief = appendFollowUp(brief, `follow-up number ${i} with some padding text`);
    assert.ok(brief.length <= MAX_BRIEF_CHARS, `brief grew to ${brief.length} chars`);
  });

  it("drops the OLDEST follow-ups, never the original task", () => {
    let brief = BRIEF;
    for (let i = 0; i < 500; i++) brief = appendFollowUp(brief, `follow-up number ${i} with some padding text`);
    assert.ok(brief.includes(BRIEF), "the original is what everything else refers back to");
    assert.ok(brief.includes("follow-up number 499"), "the newest instruction must always be there");
    assert.ok(!brief.includes("follow-up number 0 "), "the oldest are what gets dropped");
  });

  it("keeps the newest instruction even when the original alone fills the budget", () => {
    const huge = "x".repeat(MAX_BRIEF_CHARS - 20);
    const out = appendFollowUp(huge, STEER);
    assert.ok(out.length <= MAX_BRIEF_CHARS, `brief was ${out.length} chars`);
    assert.ok(out.startsWith(huge), "the original is not truncated to make room");
    assert.ok(out.length > huge.length, "a steer must never silently do nothing");
  });
});

/**
 * AF5 — the brief grows at the tail, and both readers cut it at the head.
 *
 * `appendFollowUp` above puts every steer at the END, and `MAX_BRIEF_CHARS`
 * (6,000) is four times `JUDGE_BRIEF_CHARS` (1,500). `buildJudgePrompt` and
 * `buildAnchorMessage` both used `truncate(brief, JUDGE_BRIEF_CHARS)` — a head
 * cut — so on an original brief of 1,500 characters or more the follow-up was
 * the first thing dropped:
 *
 *   · the judge was shown a task the answer was not answering and said
 *     NOT_ADDRESSED, correctly, about the question it was given. That spends a
 *     repair round and a re-judge on the one llama slot the parent is queued
 *     behind, and `buildRepairPrompt` restates the brief in FULL — so the child
 *     answers the same thing again and the run ends at `stalled`, handing the
 *     parent the answer it already had, labelled "Treat it as unreliable".
 *   · the anchor restated, into a freshly compacted context, exactly the half of
 *     the task the child still had, and dropped the half it had been steered
 *     with.
 *
 * W3 made `growBrief` run on every branch of `steer()` so the accumulated task
 * would reach the judge. This is the other end of that fix.
 */
describe("AF5 — briefForCheck keeps the instruction that arrived last", () => {
  const LONG_ORIGINAL = `Audit the decoder. ${"Trace every branch of the frame path. ".repeat(60)}`;
  const STEER = "Now also list the callers of validateToken().";

  it("shows the judge the follow-up, not only the head of the original", () => {
    assert.ok(LONG_ORIGINAL.length > JUDGE_BRIEF_CHARS, "the premise: an original that alone fills the budget");
    const brief = appendFollowUp(LONG_ORIGINAL, STEER);
    const prompt = buildJudgePrompt(brief, "src/token.ts:42 validateToken is called from…");

    assert.ok(prompt.includes(STEER), "the steer is what the answer in front of the judge is about");
    assert.ok(prompt.includes("Audit the decoder."), "and the original task is still stated");
    assert.match(prompt, /more chars/, "with the cut declared rather than hidden");
  });

  it("restates the follow-up in the anchor too — the same field, the same cut", () => {
    const brief = appendFollowUp(LONG_ORIGINAL, STEER);
    const anchor = buildAnchorMessage(brief);
    assert.ok(anchor.includes(STEER), "a compaction is exactly when the newest instruction goes missing");
    assert.ok(anchor.length < 2_000, `anchor was ${anchor.length} chars`);
  });

  it("keeps the newest follow-ups and drops the oldest, like appendFollowUp", () => {
    let brief = LONG_ORIGINAL;
    for (let i = 0; i < 40; i++) brief = appendFollowUp(brief, `follow-up number ${i} with some padding text`);
    const out = briefForCheck(brief, JUDGE_BRIEF_CHARS);

    assert.ok(out.includes("follow-up number 39"), "the newest instruction must always be there");
    assert.ok(!out.includes("follow-up number 0 "), "and the oldest are what goes");
    assert.ok(out.includes("Audit the decoder."), "the original is still what everything refers back to");
  });

  it("never lets the follow-ups crowd the original out entirely", () => {
    const brief = appendFollowUp("Short original.", "y".repeat(5_000));
    const out = briefForCheck(brief, JUDGE_BRIEF_CHARS);
    assert.ok(out.startsWith("Short original."), "the original leads, however long the steer was");
    assert.ok(out.includes("y".repeat(100)), "and the steer is represented rather than dropped");
  });

  it("stays bounded — a brief four times the budget still fits it", () => {
    let brief = LONG_ORIGINAL;
    for (let i = 0; i < 500; i++) brief = appendFollowUp(brief, `follow-up ${i} padding padding padding`);
    const out = briefForCheck(brief, JUDGE_BRIEF_CHARS);
    assert.ok(out.length < JUDGE_BRIEF_CHARS + 200, `briefForCheck returned ${out.length} chars`);
  });

  it("control — a brief that fits is handed over untouched", () => {
    const brief = appendFollowUp(BRIEF, STEER);
    assert.equal(briefForCheck(brief, JUDGE_BRIEF_CHARS), brief);
    assert.ok(buildJudgePrompt(brief, "x").includes(brief));
  });

  it("control — a long brief with no follow-up is cut exactly as it was before", () => {
    const out = briefForCheck(LONG_ORIGINAL, JUDGE_BRIEF_CHARS);
    assert.ok(out.startsWith(LONG_ORIGINAL.slice(0, JUDGE_BRIEF_CHARS)));
    assert.match(out, /… \[\d+ more chars\]$/);
  });
});

/**
 * AG1 — the share is a FLOOR, and it was being applied as a ceiling.
 *
 * AF5's own docstring says `briefForCheck` applies the split `appendFollowUp`
 * owns, "so the two cannot drift". `appendFollowUp` gives the follow-ups
 * `MAX_BRIEF_CHARS - original.length` — everything the original does not use —
 * and `briefForCheck` gave them a flat `floor(max * FOLLOW_UP_CHECK_SHARE)` and
 * returned the remainder unspent.
 *
 * On a LONG original the two agree, which is why every test above passes: they
 * all use `LONG_ORIGINAL`. On a SHORT one they do not, and short is the ordinary
 * shape — a brief is usually one sentence and the steers are what accumulate.
 *
 * Measured on the shipped module (probe `t3`): a 71-character brief steered four
 * times at ~400 characters each was cut to 481 characters of a 1,500-character
 * budget, keeping ONE follow-up of four, with 1,019 characters unused.
 *
 * These are the assertions that fail when the `Math.max` is removed.
 */
describe("AG1 — the follow-up share is the least they may have, not the most", () => {
  const SHORT_ORIGINAL = "Find every caller of parseConfig and say which of them can pass a null.";
  const steer = (n: number) => `steer ${n}: ${"x".repeat(388)}`;
  const fourSteers = () => {
    let brief = SHORT_ORIGINAL;
    for (const n of [1, 2, 3, 4]) brief = appendFollowUp(brief, steer(n));
    return brief;
  };

  it("spends the room the original left rather than returning it", () => {
    const brief = fourSteers();
    assert.ok(brief.length > JUDGE_BRIEF_CHARS, "the premise: a brief that has to be cut");
    const out = briefForCheck(brief, JUDGE_BRIEF_CHARS);
    // The defect returned 481 of 1,500. Anything near half the budget is the
    // reserve being applied as a ceiling again.
    assert.ok(
      out.length > JUDGE_BRIEF_CHARS * 0.8,
      `briefForCheck used only ${out.length} of ${JUDGE_BRIEF_CHARS} characters`,
    );
  });

  it("keeps every follow-up the budget has room for, not half of them", () => {
    const out = briefForCheck(fourSteers(), JUDGE_BRIEF_CHARS);
    for (const n of [2, 3, 4]) {
      assert.ok(out.includes(`steer ${n}:`), `follow-up ${n} fits the budget and must be shown`);
    }
    assert.ok(out.startsWith(SHORT_ORIGINAL), "the original still leads");
  });

  it("the judge is asked about the accumulated task, not a quarter of it", () => {
    const prompt = buildJudgePrompt(fourSteers(), "an answer to the newest steer");
    assert.ok(prompt.includes("steer 4:"), "the newest instruction is never droppable");
    assert.ok(prompt.includes("steer 2:"), "and neither are the ones that fit beside it");
  });

  it("the same room reaches the post-compaction anchor", () => {
    const anchor = buildAnchorMessage(fourSteers());
    assert.ok(anchor.includes("steer 3:"), "the anchor reads the same field by the same rule");
  });

  it("control — the reserve still holds when the original would crowd them out", () => {
    // A 1,400-character original leaves 100 characters; the SHARE floor gives
    // the follow-ups 750, and that is the case FOLLOW_UP_CHECK_SHARE exists for.
    let brief = "T".repeat(1_400);
    for (const n of [1, 2, 3]) brief = appendFollowUp(brief, `steer ${n}: ${"y".repeat(188)}`);
    const out = briefForCheck(brief, JUDGE_BRIEF_CHARS);
    for (const n of [1, 2, 3]) assert.ok(out.includes(`steer ${n}:`), `follow-up ${n} is inside the floor`);
    assert.ok(out.startsWith("TTT"), "and the original is truncated to make room for it");
  });

  it("control — still bounded: a brief four times the budget still fits it", () => {
    let brief = SHORT_ORIGINAL;
    for (let i = 0; i < 500; i++) brief = appendFollowUp(brief, `follow-up ${i} padding padding padding`);
    const out = briefForCheck(brief, JUDGE_BRIEF_CHARS);
    assert.ok(out.length < JUDGE_BRIEF_CHARS + 200, `briefForCheck returned ${out.length} chars`);
    assert.ok(out.includes("follow-up 499 "), "the newest is still never dropped");
  });
});

/**
 * The judge's REASON, which drives the repair.
 *
 * ## The failure this pins
 *
 * `parseJudgeVerdict` used to read the two halves of one reply by opposite rules:
 * the verdict newest-first, line-anchored and menu-guarded (S2's fix), and the
 * reason as `text.match(/WHY:\s*(.+)/i)` — the first match anywhere, anchored to
 * nothing, guarded by nothing.
 *
 * `buildJudgePrompt` ends with the two lines a small local model is most likely
 * to echo, and both get echoed. S2 was the first of them being read as a verdict;
 * this is the second being read as a reason. It is not decoration: it is the
 * whole of `buildRepairPrompt`'s "Reason:" line, so a repair round — a model call
 * in the child's own session, on the slot the parent is blocked on, in a window
 * that is already the thing most likely to be wrong — was spent telling the child
 * its answer was wrong because "one sentence, and if NOT_ADDRESSED say what the
 * task asked for that the answer does not give." It is also the sentence the
 * operator is shown.
 *
 * ## Control
 *
 * The plain two-line reply is asserted alongside every case, so a fix that simply
 * stopped reading WHY at all would fail here rather than pass.
 */
describe("parseJudgeVerdict — the reason, not just the verdict", () => {
  const REAL = "the answer describes the function instead of listing its callers.";

  it("control — the two lines the judge was asked for", () => {
    const verdict = parseJudgeVerdict(`VERDICT: NOT_ADDRESSED\nWHY: ${REAL}`);
    assert.equal(verdict.addressed, false);
    assert.equal(verdict.why, REAL);
  });

  it("ignores the prompt's own WHY line echoed back", () => {
    const reply = [
      "Reply with exactly two lines:",
      `VERDICT: ${VERDICT_MENU_TEXT}`,
      `WHY: ${WHY_INSTRUCTION}`,
      "",
      "VERDICT: NOT_ADDRESSED",
      `WHY: ${REAL}`,
    ].join("\n");
    const verdict = parseJudgeVerdict(reply);
    assert.equal(verdict.addressed, false, "S2's fix: the menu is not a choice");
    assert.equal(verdict.why, REAL, "and the instruction is not a reason");
  });

  it("takes the reason that follows the verdict it acted on", () => {
    const reply = [
      "Let me work through it. WHY: I first need to check whether call sites appear at all.",
      "They do not.",
      "VERDICT: NOT_ADDRESSED",
      "WHY: no call sites are given, only a description of the function.",
    ].join("\n");
    assert.equal(parseJudgeVerdict(reply).why, "no call sites are given, only a description of the function.");
  });

  it("reads the bold and quoted shapes a 27B writes", () => {
    assert.equal(parseJudgeVerdict(`**VERDICT:** NOT_ADDRESSED\n**WHY:** ${REAL}`).why, REAL);
    assert.equal(parseJudgeVerdict(`> verdict : NOT_ADDRESSED\n> why : ${REAL}`).why, REAL);
  });

  it("with no verdict line at all, the LAST reason wins", () => {
    // Same argument as the newest-first verdict scan: a model that thinks out
    // loud and then commits writes its commitment last.
    const reply = ["WHY: maybe it does answer it.", "On reflection, NOT-ADDRESSED.", `WHY: ${REAL}`].join("\n");
    const verdict = parseJudgeVerdict(reply);
    assert.equal(verdict.addressed, false);
    assert.equal(verdict.why, REAL);
  });

  it("falls back to a sentence a human can read when the judge gave no reason", () => {
    assert.equal(parseJudgeVerdict("VERDICT: NOT_ADDRESSED").why, "the judge did not say why");
    assert.equal(
      parseJudgeVerdict(`VERDICT: NOT_ADDRESSED\nWHY: ${WHY_INSTRUCTION}`).why,
      "the judge did not say why",
      "an echo is not a reason, and must not be passed off as one",
    );
  });

  it("the repair prompt carries the reason the judge actually gave", () => {
    const reply = [`VERDICT: ${VERDICT_MENU_TEXT}`, `WHY: ${WHY_INSTRUCTION}`, "VERDICT: NOT_ADDRESSED", `WHY: ${REAL}`].join("\n");
    const prompt = buildRepairPrompt("List every caller of parseHeader().", parseJudgeVerdict(reply).why);
    assert.match(prompt, new RegExp(REAL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(prompt, /one sentence, and if NOT_ADDRESSED/);
  });
});
