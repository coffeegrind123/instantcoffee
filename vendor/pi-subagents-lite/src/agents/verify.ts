/**
 * verify.ts — Forge fork. Is the answer an answer to the question that was asked?
 *
 * ## The failure this exists for
 *
 * A subagent gets a brief it cannot see the context for, works in its own
 * window, and when that window fills pi compacts it and it carries on from a
 * summary. pi's summaries are merged under a "PRESERVE all existing
 * information" prompt, so they grow monotonically — 456 → 4,029 → 11,054 chars
 * across 42 real compactions before `compaction-guard` capped them — and what
 * they erode first is the oldest thing in the transcript, which is the brief.
 * A child that has compacted three times is answering a question that has
 * quietly drifted from the one it was given, and nothing in the pipeline
 * notices: `formatResultContent()` hands the parent whatever the child said
 * last, and the parent has no view of the child's reasoning to judge it by.
 *
 * ## Three layers, cheapest first
 *
 * 1. **Anchor** (no model call). After each compaction, restate the brief into
 *    the child's freshly-summarised context. Prevention beats detection: the
 *    drift never happens rather than being caught afterwards.
 * 2. **Structural gate** (no model call). An empty answer, or a run that ended
 *    at the turn ceiling / by watchdog / by a stop, is objectively suspect and
 *    needs no judgement. This is most of what actually goes wrong.
 * 3. **Judge** (one small model call). Only for answers that are non-empty and
 *    ended cleanly, because those are the ones where drift is invisible.
 *
 * ## Why the judge must not run in the child's own session
 *
 * The obvious implementation — ask the child "does that answer the question?" —
 * is the weakest one available. The child has every step of the reasoning that
 * led it astray sitting in its context, and a model asked to review its own
 * work with its own justifications in front of it will ratify it. The judge
 * therefore sees only two things: the brief, and the final answer. No
 * transcript, no tools, one turn. It is harder to fool precisely because it
 * knows less.
 *
 * The repair goes the other way: the child *does* have the context to fix its
 * answer, so a failed verdict continues the child's session with the brief
 * restated, once. Judge without history, repair with it.
 *
 * ## What this cannot do
 *
 * The judge is the same 27B that wrote the answer. It catches a different
 * question being answered, an empty or evasive summary, and a claim about work
 * that was plainly not done. It does not catch subtly wrong work — it is a
 * drift check, not a correctness proof, and calling it verification in the
 * stronger sense would be a lie the parent would act on.
 */

import type { AgentLifecycle } from "../types.js";

/** How much of the brief and the answer the judge is shown. Enough to judge, not enough to be expensive. */
export const JUDGE_BRIEF_CHARS = 1_500;
export const JUDGE_ANSWER_CHARS = 4_000;

export interface StructuralVerdict {
  /** False when the answer is objectively unusable and no judgement is needed. */
  ok: boolean;
  /** Set when !ok: what to tell the parent, in the parent's terms. */
  note?: string;
  /** Whether asking a judge is worth a model call at all. */
  worthJudging: boolean;
}

/**
 * The checks that need no model call.
 *
 * `worthJudging` is false for anything already known to be bad: a run that was
 * cut off explains itself, and paying for a judge to confirm it is waste.
 */
export function structuralVerdict(answer: string, lifecycle: Pick<AgentLifecycle, "status">): StructuralVerdict {
  const text = typeof answer === "string" ? answer.trim() : "";

  if (text === "") {
    return {
      ok: false,
      worthJudging: false,
      note:
        "The agent returned no answer at all. This is usually a saturated context, not a hard task — " +
        "re-task it with a narrower question rather than repeating this one.",
    };
  }

  // These already carry their own note from status-note.ts, so this only
  // decides that a judge would be telling the parent something it knows.
  if (lifecycle.status === "aborted" || lifecycle.status === "turn_limited" || lifecycle.status === "stopped") {
    return { ok: true, worthJudging: false };
  }

  return { ok: true, worthJudging: true };
}

/**
 * The judge's whole context. Deliberately two quoted blocks and a question.
 *
 * It asks for the verdict FIRST, on its own line. A local model that is allowed
 * to reason first talks itself into agreement by the time it reaches the
 * verdict; asking for the verdict up front costs it that opportunity, and the
 * reason after it is still useful for the repair prompt.
 */
export function buildJudgePrompt(brief: string, answer: string): string {
  return [
    "You are checking one thing: does the ANSWER address the TASK it was given?",
    "",
    "You cannot see how the answer was produced, and you do not need to. You are",
    "not checking whether the work is correct — only whether it answers this task",
    "rather than a different one, and whether it is a real answer rather than a",
    "restatement, a plan, or an apology.",
    "",
    "TASK:",
    "```",
    truncate(brief, JUDGE_BRIEF_CHARS),
    "```",
    "",
    "ANSWER:",
    "```",
    truncate(answer, JUDGE_ANSWER_CHARS),
    "```",
    "",
    "Reply with exactly two lines:",
    "VERDICT: ADDRESSED or NOT_ADDRESSED",
    "WHY: one sentence, and if NOT_ADDRESSED say what the task asked for that the answer does not give.",
  ].join("\n");
}

export interface JudgeVerdict {
  addressed: boolean;
  why: string;
  /** True when the reply could not be read as a verdict at all. */
  unparsed: boolean;
}

/**
 * Read the judge's reply.
 *
 * Unparsed counts as ADDRESSED. A judge that answered in a shape nobody asked
 * for is evidence about the judge, not about the answer, and failing a good
 * result because a 27B was chatty would make the whole layer worse than not
 * having it. The `unparsed` flag is kept so the caller can say so rather than
 * silently claiming the answer passed.
 */
export function parseJudgeVerdict(reply: string): JudgeVerdict {
  const text = typeof reply === "string" ? reply : "";
  const why = (text.match(/WHY:\s*(.+)/i)?.[1] ?? "").trim();

  // NOT_ADDRESSED first: "NOT_ADDRESSED" contains "ADDRESSED".
  if (/VERDICT:\s*NOT[_\s-]?ADDRESSED/i.test(text) || /\bNOT[_\s-]ADDRESSED\b/i.test(text)) {
    return { addressed: false, why: why || "the judge did not say why", unparsed: false };
  }
  if (/VERDICT:\s*ADDRESSED/i.test(text) || /\bADDRESSED\b/i.test(text)) {
    return { addressed: true, why, unparsed: false };
  }
  return { addressed: true, why: why || "the judge's reply could not be read as a verdict", unparsed: true };
}

/**
 * The one repair attempt, sent into the child's own session.
 *
 * The brief is restated in full rather than referred to, because the reason the
 * child is being asked again is that its context may no longer contain it —
 * pointing at "the original task" would point at the thing that went missing.
 */
export function buildRepairPrompt(brief: string, why: string): string {
  return [
    "Your answer did not address the task you were given. Reason:",
    why,
    "",
    "This is the task, in full, as it was given to you:",
    "```",
    brief,
    "```",
    "",
    "Answer it now. If you cannot, say plainly what is missing and stop.",
    "Do not restate the task, and do not describe what you would do.",
  ].join("\n");
}

/**
 * The reminder injected after a compaction, so the brief cannot be summarised away.
 *
 * Short on purpose: it lands in a context that was just cut down to make room,
 * and a long reminder would spend the room it was making.
 */
export function buildAnchorMessage(brief: string): string {
  return [
    "[task anchor — the context was just compacted, so this restates the task you",
    "are working on. Nothing here is new work.]",
    "",
    truncate(brief, JUDGE_BRIEF_CHARS),
  ].join("\n");
}

/** What the parent is told when the answer went out unverified or failed. */
export function verificationNote(kind: "failed" | "unparsed" | "repaired"): string {
  switch (kind) {
    case "failed":
      return (
        "\n\n[verification: this answer was checked against the task and did not address it, " +
        "and one attempt to correct it did not fix it. Treat it as unreliable.]"
      );
    case "repaired":
      return "\n\n[verification: the first answer did not address the task; this is the corrected one.]";
    case "unparsed":
      return "\n\n[verification: the check could not be read, so this answer went out unchecked.]";
  }
}

function truncate(text: string, max: number): string {
  const s = typeof text === "string" ? text : "";
  return s.length <= max ? s : `${s.slice(0, max)}\n… [${s.length - max} more chars]`;
}
