/**
 * This stack's pi session entries that pi draws with a custom renderer, as Ovis
 * chat notices. Ovis's pi reader skips `custom` entries (it shows only
 * `custom_message`s with `display`), so without this a command run from the
 * Ovis chat came back with nothing: /stack's report, a subagent's transcript,
 * a Matrix bridge's output and every ctx.ui.notify (saved by
 * .pi/extensions/ovis-bridge.ts) lived only on pi's screen.
 *
 * Pure (no Ovis imports): scripts/ovis_patch.py copies it into Ovis's server/
 * and its piNotice calls it; this stack's CI tests it with plain node, and
 * scripts/test_ovis.py fails when an extension in the repo registers an entry
 * renderer for a type not listed in NOTICE_TYPES, so a new one cannot stay
 * invisible in Ovis by accident.
 */

export interface Notice {
  kind: "notice";
  text: string;
  source: string;
}

type Row = Record<string, unknown>;
const row = (value: unknown): Row => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {});
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const lines = (value: unknown): string[] => (Array.isArray(value) ? value.filter((line): line is string => typeof line === "string") : []);

/** customType -> its data as the text the TUI renderer shows. */
const FORMATS: Record<string, (data: unknown) => string> = {
  // .pi/extensions/ovis-bridge.ts: ctx.ui.notify(message, level)
  "ovis-notice": (data) => text(row(data).message),
  // .pi/extensions/stack.ts: report(title, lines, tone). Ovis shows a notice's
  // first line as its collapsed summary, so a bare title ("stack") read as an
  // empty answer (operator, 2026-11-01): the summary carries the first line too.
  "stack-report": (data) => {
    const body = lines(row(data).lines);
    const first = body.find((line) => line.trim())?.replace(/\s+/g, " ").trim();
    const title = text(row(data).title);
    return [first ? `${title} · ${first}` : title, ...body].filter(Boolean).join("\n");
  },
  // .pi/extensions/team-solve.ts: the same title/first-line contract.
  "team-solve-report": (data) => {
    const body = lines(row(data).lines);
    const first = body.find((line) => line.trim())?.replace(/\s+/g, " ").trim();
    const title = text(row(data).title);
    return [first ? `${title} · ${first}` : title, ...body].filter(Boolean).join("\n");
  },
  // vendor/pi-subagents-lite: one part of a delegation's transcript
  "subagent-turn": (data) => {
    const d = row(data);
    const head = [`[subagent ${text(d.shortId)} ${text(d.agentType)}]`.replace(/\s+\]/, "]"), text(d.phase), text(d.description)]
      .filter(Boolean)
      .join(" ");
    const dropped = typeof d.dropped === "number" && d.dropped > 0 ? [`… ${d.dropped} more lines`] : [];
    return [head, ...lines(d.lines), ...dropped].join("\n");
  },
  // vendor/prinny-channel: what the Matrix bridge printed
  "prinny-output": (data) => text(data),
};

export const NOTICE_TYPES: readonly string[] = Object.keys(FORMATS);

/** A notice for one of this stack's entries; undefined when the entry is not one (Ovis's own rules apply). */
export function piEntryNotice(value: unknown): Notice | null | undefined {
  const entry = row(value);
  if (entry.type !== "custom" || typeof entry.customType !== "string") return undefined;
  const format = FORMATS[entry.customType];
  if (!format) return undefined;
  const said = format(entry.data).trim();
  return said ? { kind: "notice", text: said, source: entry.customType } : null;
}
