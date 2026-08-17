/**
 * verification-badge.ts — Forge fork. What the verifier did, in one token.
 *
 * ## Why this file exists at all
 *
 * The verifier's whole purpose is to draw one distinction: an answer that was
 * checked and is fine, against an answer nobody checked. Until this file, the
 * UI drew neither. `record.verification` was set on every checked answer and
 * carried into the tool result's details, and then nothing read it — a pass
 * was silent by design (a passing answer must not be decorated with a note the
 * parent model would quote), which left "checked and fine" and "never checked"
 * rendering identically. The field existed; the distinction did not.
 *
 * ## Why the mapping is data and not a switch inside the renderer
 *
 * There are three places a verdict has to appear — the widget's finished line,
 * the foreground tool result, and the background subagent-result card — and
 * they use different theme calls and different line budgets. A verdict that
 * says `repaired` in one place and `fixed` in another is worse than no verdict,
 * because the operator has to learn two vocabularies for one fact. So the icon,
 * the wording and the tone are decided once, here, and the three call sites
 * differ only in how they paint it.
 *
 * This module deliberately has **no runtime imports**. It is loaded by the
 * tests directly under plain node, where the `.js` specifiers the rest of `src`
 * uses do not resolve; a pure mapping with type-only imports is testable
 * without a bundler and without pi's loader.
 *
 * ## Tone, and what "loud" is for
 *
 * `passed` is dim on purpose: it is the common case, it appears on every
 * delegation once verification is on, and a bright tick on every line would
 * train the eye to skip the column that the loud cases live in. `repaired` and
 * `failed` are the two that change what the parent's answer is worth, so they
 * get warning and error. The skips are split by cause rather than collapsed
 * into one "skipped", because "the agent answered nothing" and "the run was cut
 * off" and "no task was recorded to check against" are three different
 * problems with three different fixes.
 */

import type { AgentVerification, VerifyPhase } from "../types.js";

/** Theme colour names used by the badge. Matches the palette the rest of the UI uses. */
export type BadgeTone = "dim" | "warning" | "error";

export interface VerificationBadge {
  /** Single glyph, chosen not to collide with the stats line's ⟳ (turns) or ↻ (compactions). */
  icon: string;
  /** Two or three words. The line it lands on is already busy and truncates from the right. */
  label: string;
  tone: BadgeTone;
}

const BADGES: Record<AgentVerification, VerificationBadge> = {
  passed: { icon: "✓", label: "checked", tone: "dim" },
  repaired: { icon: "✎", label: "repaired", tone: "warning" },
  failed: { icon: "✗", label: "off-task", tone: "error" },
  unparsed: { icon: "?", label: "unreadable verdict", tone: "warning" },
  errored: { icon: "?", label: "check errored", tone: "warning" },
  "skipped-empty": { icon: "⊘", label: "empty answer", tone: "warning" },
  "skipped-cutoff": { icon: "⊘", label: "unchecked (cut off)", tone: "dim" },
  "skipped-nobrief": { icon: "⊘", label: "unchecked (no task)", tone: "dim" },
};

/**
 * The badge for a verdict, or undefined when there is no verdict to show.
 *
 * Undefined is the load-bearing case: absence means the verifier never ran
 * (SUBAGENT_VERIFY=0, or a run that predates it), and inventing a marker for
 * that would recreate exactly the ambiguity this exists to remove.
 */
export function verificationBadge(verification: AgentVerification | undefined): VerificationBadge | undefined {
  if (!verification) return undefined;
  return BADGES[verification];
}

/** `"✓ checked"` — the badge as one plain string, for callers that paint it themselves. */
export function verificationBadgeText(verification: AgentVerification | undefined): string | undefined {
  const badge = verificationBadge(verification);
  return badge ? `${badge.icon} ${badge.label}` : undefined;
}

/**
 * What the verifier is doing right now, for the activity line of a row that is
 * still being checked.
 *
 * Both phases are real model calls on the one llama slot the parent is waiting
 * on, and they are the reason the session appears to stall after a subagent
 * has apparently finished. Saying which one is running is the difference
 * between a visible wait and an unexplained one.
 */
export function verifyPhaseActivity(phase: VerifyPhase | undefined): string | undefined {
  switch (phase) {
    case "judging":
      return "checking the answer against the task…";
    // Deliberately not "once more": the repair loop has a configurable budget,
    // and a row that promises a last attempt on the first of three is a lie the
    // operator would only catch by reading the config.
    case "repairing":
      return "answer was off-task — asking again…";
    default:
      return undefined;
  }
}
