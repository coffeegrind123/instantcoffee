/**
 * Bound the compaction summary that pi feeds back into itself.
 *
 * pi merges each compaction summary into the previous one, and the prompt that
 * does it (`UPDATE_SUMMARIZATION_PROMPT` in `core/compaction/compaction.js`)
 * instructs the model to accumulate rather than to choose:
 *
 *     - PRESERVE all existing information from the previous summary
 *     - [x] [Include previously done items AND newly completed items]
 *
 * So the summary is monotonic by construction. Measured across the 42 real
 * compaction points under `~/.pi/agent/sessions`: 456 chars at the low end,
 * 4,029 at the median, 11,054 at the high end, and within a single session it
 * only ever went up — 1,666 → 3,183 → 5,891 → 9,411 → 11,054. Nothing bounds it:
 * the summarizer's own `maxTokens` is `min(0.8 * reserveTokens, model.maxTokens)`,
 * which is 13,107 tokens on this stack and therefore not a limit at all.
 *
 * That is the one part of pi's compaction that sizing `keepRecentTokens` from
 * `CTX_SIZE` does NOT fix. With the current global settings the *kept tail* is
 * well behaved — 13% of the window at the low end, 20% median, 31% worst across
 * those same 42 points — while the summary keeps climbing underneath it. On a
 * 32k window an 11k-char summary is ~8% of the context spent restating history,
 * and it is the component that grows without limit as a session gets longer.
 *
 * The lever available to an extension is the INPUT: `preparation.previousSummary`
 * is read by `compact()` after `session_before_compact` is emitted, and the event
 * is passed by reference. Capping it bounds what "PRESERVE all existing
 * information" is able to preserve, so each summary settles at roughly
 * `cap + one round of new material` instead of growing with iteration count.
 *
 * This is a bound on the accumulator, not a hard ceiling on pi's output — pi
 * writes the new summary after this hook returns, and nothing here can truncate
 * that. It is the difference between linear growth and a stable size.
 *
 * Trimming is section-aware on purpose. pi's summary format is a fixed set of
 * `##` sections, and a blind `slice()` keeps `## Goal` while cutting exactly the
 * two sections that carry the work forward (`## Next Steps`, `## Critical
 * Context`), because they are last. Sections are therefore dropped by usefulness
 * and reassembled in their original order, so the result still looks like the
 * format the update prompt asks the model to maintain.
 */

/** Marker appended when trimming happened. Fixed text, and stripped before re-trimming, so it cannot accumulate. */
export const TRIM_MARKER = "(Earlier summary detail was trimmed to fit the context budget.)";

/**
 * Fraction of the context window the carried-over summary is allowed to occupy,
 * and the chars-per-token used to convert it. 5% of a 32,768-token window is
 * ~1,638 tokens ≈ 6,553 chars, which sits above the measured median summary
 * (4,029) and below the measured maximum (11,054) — it clips the runaway tail
 * without touching a summary of ordinary size.
 */
export const SUMMARY_WINDOW_FRACTION = 0.05;
export const CHARS_PER_TOKEN = 4;
export const MIN_SUMMARY_CAP_CHARS = 2_000;
export const MAX_SUMMARY_CAP_CHARS = 20_000;

/**
 * Sections kept in preference order when the summary does not fit. `## Progress`
 * is last because its `### Done` list is the part that accumulates: every
 * compaction adds to it and the update prompt forbids removing from it.
 */
export const SECTION_PRIORITY: readonly string[] = [
  "## Goal",
  "## Next Steps",
  "## Constraints & Preferences",
  "## Key Decisions",
  "## Critical Context",
  "## Progress",
];

export interface SummarySection {
  /** The `## ...` heading line, or "" for text before the first heading. */
  heading: string;
  /** The whole section including its heading, trailing whitespace trimmed. */
  text: string;
}

/** The cap in characters for a given context window. Falls back to the minimum when the window is unknown. */
export function summaryCapChars(contextWindow: number | undefined): number {
  if (!contextWindow || contextWindow <= 0 || !Number.isFinite(contextWindow)) return MIN_SUMMARY_CAP_CHARS;
  const chars = Math.round(contextWindow * SUMMARY_WINDOW_FRACTION * CHARS_PER_TOKEN);
  return Math.min(MAX_SUMMARY_CAP_CHARS, Math.max(MIN_SUMMARY_CAP_CHARS, chars));
}

/** Split a summary into `##` sections, preserving order. Text before the first heading becomes a leading section with heading "". */
export function splitSections(summary: string): SummarySection[] {
  const lines = summary.split("\n");
  const sections: SummarySection[] = [];
  let heading = "";
  let buffer: string[] = [];
  const flush = () => {
    const text = buffer.join("\n").replace(/\s+$/, "");
    if (text.trim().length > 0) sections.push({ heading, text });
    buffer = [];
  };
  for (const line of lines) {
    // A section starts at a level-2 heading. Deeper headings (`### Done`) belong to the section above them.
    if (/^##\s+\S/.test(line) && !/^###/.test(line)) {
      flush();
      heading = line.trim();
    }
    buffer.push(line);
  }
  flush();
  return sections;
}

/** Cut text to at most `maxChars`, preferring a line boundary so a section does not end mid-sentence. */
function clipToLine(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const slice = text.slice(0, maxChars);
  const lastNewline = slice.lastIndexOf("\n");
  // Only honour the line boundary when it keeps a useful amount of the section.
  const cut = lastNewline > maxChars * 0.5 ? slice.slice(0, lastNewline) : slice;
  return cut.replace(/\s+$/, "");
}

/**
 * Bound a carried-over summary to `maxChars`, dropping whole sections by
 * {@link SECTION_PRIORITY} and truncating the first one that does not fit.
 * Returns the input unchanged when it already fits.
 */
export function capSummary(summary: string | undefined, maxChars: number): string | undefined {
  if (typeof summary !== "string") return summary;
  // Anything already within the cap is returned byte-for-byte, marker and all.
  // This is what makes the function idempotent, and it has to come BEFORE the
  // marker is stripped: every compaction re-caps the output of the last one, so
  // stripping first would quietly shorten an already-capped summary on each
  // pass and drop the marker that says it was trimmed.
  if (summary.length <= maxChars) return summary;
  // Only now, on a summary that genuinely has to shrink, remove any previous
  // marker so that re-trimming cannot stack a second one.
  const source = summary.split(TRIM_MARKER).join("").replace(/\s+$/, "");
  if (source.length === 0) return summary;

  const sections = splitSections(source);
  if (sections.length === 0) return `${clipToLine(source, maxChars)}\n\n${TRIM_MARKER}`;

  const rank = (section: SummarySection) => {
    const index = SECTION_PRIORITY.indexOf(section.heading);
    // An unrecognised heading (or the pre-heading preamble) sits between the
    // essential sections and the accumulating one, rather than being discarded:
    // a model that deviated from the format still wrote something meaningful.
    return index >= 0 ? index : SECTION_PRIORITY.length - 1;
  };

  // Reserve room for the marker so the result is genuinely within the cap.
  const budget = Math.max(0, maxChars - TRIM_MARKER.length - 2);
  const order = sections.map((section, index) => ({ section, index })).sort((a, b) => {
    const byRank = rank(a.section) - rank(b.section);
    return byRank !== 0 ? byRank : a.index - b.index;
  });

  const kept = new Map<number, string>();
  let used = 0;
  for (const { section, index } of order) {
    if (used >= budget) break;
    const separator = kept.size > 0 ? 2 : 0; // the "\n\n" this section will be joined with
    const room = budget - used - separator;
    if (room <= 0) break;
    if (section.text.length <= room) {
      kept.set(index, section.text);
      used += section.text.length + separator;
      continue;
    }
    // Only truncate into a section when what survives is worth keeping; otherwise leave it out entirely.
    const clipped = clipToLine(section.text, room);
    if (clipped.trim().length > section.heading.length) {
      kept.set(index, clipped);
      used += clipped.length + separator;
    }
    break;
  }

  const body = [...kept.keys()]
    .sort((a, b) => a - b)
    .map((index) => kept.get(index) as string)
    .join("\n\n");
  return `${body}\n\n${TRIM_MARKER}`;
}
