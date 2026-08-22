/**
 * transcript-entry.ts — Forge fork, twentieth pass. A subagent's own turns, in
 * the operator's session transcript.
 *
 * ## The request, and what was there before it
 *
 * *"Subagents are not logged into the session transcripts, and they should be —
 * in the same session transcript that the main stuff goes into, just marked as
 * a subagent."* (operator, 2026-08-19.)
 *
 * Measured rather than assumed. For one delegation the parent's session file
 * got exactly two things: the `Agent` tool call and its tool result
 * (foreground), or the `subagent-result` custom message (background). That is
 * the ANSWER and nothing else. The child's own turns lived in three other
 * places, two of them outside the session and two of the three absent by
 * default:
 *
 * ```
 *   the child's session   SessionManager.inMemory(cwd)      agent-runner.ts:612
 *                         — never written anywhere, disposed with the record
 *   the output log        /tmp/pi-agent-outputs/<agentId>.log
 *                         — OFF BY DEFAULT (`outputTranscript: false`,
 *                           config-io.ts), a different file, in /tmp, keyed by
 *                           an id nobody has once the session is over
 *   the verifier's log    ~/.pi/agent/subagent-verify.jsonl
 *                         — a THIRD file, and the judge's prompt/reply only
 * ```
 *
 * ## Why a custom ENTRY, and why that is affordable on a 32k window
 *
 * `pi.appendEntry(customType, data)` + `pi.registerEntryRenderer(customType, …)`
 * is the pair `/stack` and `/prinny` already use. pi's own source settles the
 * property the whole design rests on:
 *
 * ```js
 *   sessionEntryToContextMessages(entry)                    session-manager.js
 *     entry.type === "message" | "custom_message"
 *       | "branch_summary" | "compaction"   →  a context message
 *     entry.type === "custom"               →  []      ← NOTHING. ever.
 * ```
 *
 * A `type: "custom"` entry is **written to the session file, rendered in the
 * transcript, and never sent to the model** — not on the next turn, not after a
 * compaction, not at all. On this box that is the whole ballgame: a child's
 * reasoning is precisely what must not enter the parent's context, and this is
 * the one surface in pi that persists and renders without being context.
 * `restoreLoopState` already walks these entries back out
 * (`pi-loop-mode/src/loop-state.ts`), so reading them later is solved too.
 *
 * ## Attribution, because three delegations settle interleaved
 *
 * Every entry carries the agent id, its short form, the agent type and the
 * phase. `AgentWidget` and `/agents` already speak in short ids, so a reader
 * scrolling the transcript can line an entry up with the agent it came from
 * without a second vocabulary.
 *
 * ## Bounds, because an unattended /loop delegates for days
 *
 * The same problem `MAX_SPILL_FILES`, `verify-log.ts`'s line cap and
 * `result-cap.ts` all exist for: nothing removes a session entry, and a `/loop`
 * delegating every iteration would otherwise write every child's whole
 * reasoning into the session file forever. So:
 *
 *   - ONE entry per child TURN, not per line — `streamAgentOutput`'s
 *     `onTurnFlush` is what makes that possible without a second formatter;
 *   - `MAX_ENTRIES` entries per agent, after which one final entry says how
 *     many turns were dropped and where the rest is;
 *   - `MAX_ENTRY_CHARS` per entry and `MAX_LINES` lines, whichever comes first.
 *
 * ## Never throws
 *
 * A transcript that cannot be written must never be the reason a delegation
 * fails. Every path here swallows, exactly as `verify-log.ts` does, and for the
 * same reason.
 */

import { SHORT_ID_LENGTH } from "../types.ts";

/** The entry customType. One for every phase; the payload says which. */
export const SUBAGENT_ENTRY_TYPE = "subagent-turn";

/** Entries per agent, after which the stream is closed with a note. */
export const MAX_ENTRIES = 60;

/** Characters kept in one entry. */
export const MAX_ENTRY_CHARS = 4_000;

/** Lines kept in one entry, whichever bound is reached first. */
export const MAX_LINES = 120;

/** Set `SUBAGENT_TRANSCRIPT=0` to write nothing at all. */
export function transcriptEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SUBAGENT_TRANSCRIPT !== "0";
}

export type TranscriptPhase = "brief" | "turn" | "verify" | "repair" | "done" | "capped";

export interface SubagentEntry {
  /** Full agent id, so a later reader can join across entries. */
  agentId: string;
  /** The form the widget and /agents print. */
  shortId: string;
  /** The agent type, e.g. "general-purpose". */
  agentType: string;
  /** Which part of the delegation this entry is. */
  phase: TranscriptPhase;
  /** Turn ordinal within the child's run, for `phase: "turn"`. */
  turn?: number;
  /** One-line description of the delegation, on the opening entry. */
  description?: string;
  /** The formatted lines, already bounded. */
  lines: string[];
  /** How many lines were cut to fit, if any. */
  dropped?: number;
}

/** The minimum of pi this module needs. Narrow so a test can hand it a stub. */
export interface EntryWriter {
  appendEntry<T>(customType: string, data: T): void;
}

/** What replaces the tail of a line the char budget could not fit whole. */
export const TRUNCATION_MARK = " …[cut]";

/**
 * Below this much remaining room, a truncated line is not worth keeping — the
 * marker would be most of it. Comfortably above `TRUNCATION_MARK.length`.
 */
const MIN_TRUNCATED_KEEP = 40;

/**
 * Bound one entry, truncating the line that does not fit rather than dropping it.
 *
 * Forge fork, twenty-first pass (§11.10 of `…-lifetimes.md`, off the axis).
 * This used to `break` on
 * `chars + line.length > MAX_ENTRY_CHARS`, which is right for a line that
 * *starts* past the budget and wrong for the line that *crosses* it — and
 * catastrophically wrong for the first line of an entry. A single line longer
 * than `MAX_ENTRY_CHARS` made `kept` empty on the first iteration, so the entry
 * was written with `lines: []` and `dropped: 1`: a `brief` whose prompt is one
 * long paragraph, or a turn whose assistant message has no newline in it,
 * became an entry containing nothing at all.
 *
 * The header promises "`MAX_ENTRY_CHARS` per entry and `MAX_LINES` lines,
 * whichever comes first", which a reader takes as truncation. It now is one.
 */
function boundLines(lines: readonly string[]): { lines: string[]; dropped?: number } {
  const kept: string[] = [];
  let chars = 0;
  for (const line of lines) {
    if (kept.length >= MAX_LINES) break;
    const room = MAX_ENTRY_CHARS - chars;
    if (room <= 0) break;
    if (line.length > room) {
      if (room >= MIN_TRUNCATED_KEEP) {
        kept.push(line.slice(0, room - TRUNCATION_MARK.length) + TRUNCATION_MARK);
      }
      break;
    }
    kept.push(line);
    chars += line.length;
  }
  const dropped = lines.length - kept.length;
  return dropped > 0 ? { lines: kept, dropped } : { lines: kept };
}

/**
 * One delegation's transcript, as session entries.
 *
 * Created at spawn, attached when the child's session exists, finalized at the
 * record's terminal transition — the same three moments `AgentOutputLog` has,
 * because it is the same lifecycle and a second one would drift.
 */
export class AgentTranscript {
  private buffer: string[] = [];
  private written = 0;
  private turn = 0;
  private cleanup?: () => void;
  private closed = false;
  private droppedTurns = 0;

  private readonly pi: EntryWriter;
  private readonly agentId: string;
  private readonly agentType: string;

  // Explicit fields, not parameter properties: the suite runs under
  // `node --experimental-strip-types`, which cannot desugar them.
  constructor(pi: EntryWriter, agentId: string, agentType: string) {
    this.pi = pi;
    this.agentId = agentId;
    this.agentType = agentType;
  }

  /** The short id this transcript's entries carry. */
  get shortId(): string {
    return this.agentId.slice(0, SHORT_ID_LENGTH);
  }

  /** The opening entry: what the child was asked, and by which type. */
  brief(prompt: string, description?: string): void {
    this.append({
      phase: "brief",
      description,
      lines: splitLines(prompt),
    });
  }

  /**
   * The sink `streamAgentOutput` writes formatted lines to.
   *
   * Bound rather than passed as a method reference so a caller cannot lose
   * `this` on the way. It BUFFERS; nothing reaches the session until
   * `endTurn()`, which is what keeps a 40-turn child to 40 entries rather than
   * several thousand.
   */
  readonly sink = (content: string): void => {
    if (this.closed) return;
    this.buffer.push(...splitLines(content));
  };

  /** Close the current turn into one entry. Wired to `onTurnFlush`. */
  readonly endTurn = (): void => {
    this.flushTurn();
  };

  /**
   * Remember how to stop the stream.
   *
   * `streamAgentOutput` lives in `output-file.ts`, which imports pi and the
   * package's `.js`-suffixed siblings; this module deliberately imports
   * neither, so the suite can load it under bare
   * `node --experimental-strip-types`. The manager owns the wiring — it is two
   * lines there and a dependency here.
   */
  setCleanup(cleanup: () => void): void {
    if (this.closed) {
      try {
        cleanup();
      } catch {
        // Already finished; nothing to unsubscribe from that matters.
      }
      return;
    }
    this.cleanup = cleanup;
  }

  /** One verifier call — the judge's or the repair's — as its own entry. */
  verify(phase: "verify" | "repair", prompt: string, reply: string): void {
    this.append({
      phase,
      lines: [...splitLines(`PROMPT: ${prompt}`), "", ...splitLines(`REPLY: ${reply}`)],
    });
  }

  /**
   * Close the stream and write the last entry.
   *
   * `summary` is the one-line outcome — status, turns, tool uses — so a reader
   * who collapsed everything above still sees how it ended.
   */
  finalize(summary: string): void {
    if (this.closed) return;
    if (this.cleanup) {
      try {
        this.cleanup();
      } catch {
        // The stream's own ending is worth less than the entry below it.
      }
      this.cleanup = undefined;
      // Whatever is still buffered is `streamAgentOutput`'s own `[DONE]` line:
      // its cleanup calls `onTurnFlush` AFTER the last flush and BEFORE writing
      // that line, so the turns are already committed and only the line is
      // left. The entry below says the same thing with the RECORD's numbers —
      // status, verification and the error, none of which the session knows.
      this.buffer = [];
    } else {
      // Never attached (a spawn that failed before the session existed). There
      // is no DONE line to drop and the buffer may hold something real.
      this.flushTurn();
    }
    this.closed = true;
    this.append(
      {
        phase: "done",
        lines: [summary],
      },
      true,
    );
  }

  /** Drop the subscription without writing anything. For a record being cleared. */
  dispose(): void {
    this.closed = true;
    try {
      this.cleanup?.();
    } catch {
      // Nothing to do about it, and nothing depends on it.
    }
    this.cleanup = undefined;
    this.buffer = [];
  }

  private flushTurn(): void {
    if (this.buffer.length === 0) return;
    const lines = this.buffer;
    this.buffer = [];
    this.turn += 1;
    this.append({ phase: "turn", turn: this.turn, lines });
  }

  /**
   * Write one entry, or count it as dropped once the budget is spent.
   *
   * `force` is for the closing entry: an agent that hit the cap still gets to
   * say so, and saying so is the only thing that keeps the cap from looking
   * like a transcript that simply stops.
   */
  private append(entry: Omit<SubagentEntry, "agentId" | "shortId" | "agentType">, force = false): void {
    if (!transcriptEnabled()) return;
    if (this.written >= MAX_ENTRIES && !force) {
      this.droppedTurns += 1;
      return;
    }
    const bounded = boundLines(entry.lines);
    const payload: SubagentEntry = {
      agentId: this.agentId,
      shortId: this.shortId,
      agentType: this.agentType,
      ...entry,
      lines: bounded.lines,
      ...(bounded.dropped ? { dropped: bounded.dropped } : {}),
    };
    if (force && this.droppedTurns > 0) {
      payload.lines = [
        ...payload.lines,
        `(${this.droppedTurns} further turn(s) were not written: this delegation reached the ` +
          `${MAX_ENTRIES}-entry transcript cap.)`,
      ];
    }
    try {
      this.pi.appendEntry<SubagentEntry>(SUBAGENT_ENTRY_TYPE, payload);
      this.written += 1;
    } catch {
      // The session may be going away underneath us. `verify-log.ts`'s rule:
      // a record that cannot be written must not be the reason work is lost.
    }
  }
}

function splitLines(text: unknown): string[] {
  return String(text ?? "")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line !== "");
}
