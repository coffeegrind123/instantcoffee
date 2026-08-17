/**
 * Bounding what a single tool result may spend of the context.
 *
 * ## Why an advisory was not enough
 *
 * The context notice in `context-notice.ts` fires at 60% and hardens at 80%, and
 * on 2026-08-17 it did exactly that — and the run died anyway. Reconstructed from
 * the session, with `cacheRead` included so the percentages are the real ones:
 *
 *   entry 46   26,989 tok   82.4%   CRITICAL notice in context
 *   entry 48   27,684 tok   84.5%   CRITICAL notice in context
 *                                   -> model runs a 3-URL curl loop
 *   entry 49   tool result 17,790 chars (~4,447 tokens)
 *   entry 50   32,766 tok  100.0%   empty turn — the model produced nothing
 *   entry 51   compaction
 *
 * The notice was in front of the model, saying "Do not read whole files or run
 * commands with large output this turn", at 84.5% of the window. It ran the
 * command regardless. That is not a bug in the notice and not a threshold that
 * needs tuning: a soft instruction does not bind, and — more to the point — the
 * model could not have complied even in good faith, because nobody knows how
 * many bytes a `curl | python` pipeline will print until it has printed them.
 *
 * The only thing that can bound an unpredictable output is a bound applied after
 * it exists and before it reaches the context. That is this file.
 *
 * ## The shape of the bound
 *
 * Scaled to what is left, not fixed. A 20,000-character result at 15% used is
 * fine and truncating it would be vandalism; the same result at 85% ends the
 * run. So the allowance is a fraction of the REMAINING window, floored so there
 * is always something useful to read and ceilinged so no single result can eat a
 * third of a fresh context either.
 *
 * Head and tail are kept rather than a prefix: the head carries what the command
 * was doing and the tail carries how it ended, and a naive `head -c` throws away
 * the half that says whether it worked.
 *
 * Nothing is lost. The full output is written to a file and the marker names it,
 * so the model can page back into the middle if it genuinely needs it — the same
 * bargain the `[chars X-Y of TOTAL]` contract already offers for page text.
 */

/**
 * Fraction of the REMAINING context one tool result may occupy.
 *
 * 0.10 rather than something more generous, and the number was chosen against
 * the failure rather than by taste. At the moment that run broke, 27,684 of
 * 32,768 tokens were used — 5,084 left. A fifth of the remainder is 4,067 chars,
 * which lands the run at 88.5%: still above the 87% cliff where more than half
 * of assistant turns come back empty, so the cap would have been theatre. A
 * tenth is 2,034 chars and lands it at 86.8%, under the cliff, with room to
 * write a conclusion. `tests/output-cap.test.ts` asserts that end state, so this
 * constant cannot drift back without the test saying which side of the cliff it
 * has moved to.
 */
export const REMAINING_FRACTION = 0.1;
/** Never cap below this: a result too small to be useful is worse than a big one. */
export const MIN_ALLOWANCE_CHARS = 1_500;
/** Never allow more than this, however empty the context is. */
export const MAX_ALLOWANCE_CHARS = 20_000;
/** Chars per token, matching the rest of this extension. */
export const CHARS_PER_TOKEN = 4;
/** Of the kept budget, how much comes from the start. The rest is the tail. */
export const HEAD_SHARE = 0.7;

export interface CapPlan {
  /** The text to put in the context instead of the original. */
  text: string;
  /** Original length, for the log. */
  originalChars: number;
  /** What survived, marker included. */
  keptChars: number;
}

/**
 * How many characters a tool result may contribute, given the room left.
 *
 * `remainingTokens` unknown (null) happens right after a compaction, before the
 * next response reports usage. Cap at the ceiling then: still bounded, but not
 * punitive on a context that is probably nearly empty.
 */
export function allowanceChars(remainingTokens: number | null | undefined): number {
  if (remainingTokens === null || remainingTokens === undefined || !Number.isFinite(remainingTokens)) {
    return MAX_ALLOWANCE_CHARS;
  }
  const chars = Math.round(Math.max(0, remainingTokens) * REMAINING_FRACTION * CHARS_PER_TOKEN);
  return Math.min(MAX_ALLOWANCE_CHARS, Math.max(MIN_ALLOWANCE_CHARS, chars));
}

/** Cut at a line boundary when one is close enough to be worth preferring. */
function clipHead(text: string, max: number): string {
  const slice = text.slice(0, max);
  const nl = slice.lastIndexOf('\n');
  return nl > max * 0.6 ? slice.slice(0, nl) : slice;
}

function clipTail(text: string, max: number): string {
  const slice = text.slice(-max);
  const nl = slice.indexOf('\n');
  return nl >= 0 && nl < max * 0.4 ? slice.slice(nl + 1) : slice;
}

/**
 * Cap `text` to `allowance`, or return undefined when it already fits.
 *
 * `spillPath` is named in the marker so the result is recoverable; pass
 * undefined when it could not be written, and the marker says so rather than
 * pointing at a file that is not there.
 */
export function planOutputCap(
  text: string,
  allowance: number,
  spillPath: string | undefined,
  percentUsed?: number | null
): CapPlan | undefined {
  if (typeof text !== 'string') return undefined;
  const originalChars = text.length;
  if (originalChars <= allowance) return undefined;

  const where =
    typeof percentUsed === 'number' && Number.isFinite(percentUsed)
      ? ` at ${Math.round(percentUsed)}% context`
      : '';
  const recovery = spillPath
    ? `Full output: ${spillPath}`
    : 'The full output could not be saved, so re-run with a narrower filter if you need the rest';
  const marker =
    `\n\n[output capped${where}: ${originalChars} chars, kept about ${allowance}. ` +
    `${recovery}. Prefer a narrower command — grep, a line range, --max-count — over reading it all back.]\n\n`;

  const budget = Math.max(0, allowance - marker.length);
  const headChars = Math.round(budget * HEAD_SHARE);
  const tailChars = budget - headChars;
  const head = clipHead(text, headChars);
  const tail = tailChars > 0 ? clipTail(text, tailChars) : '';
  const out = `${head}${marker}${tail}`;
  return { text: out, originalChars, keptChars: out.length };
}
