/**
 * output-file.ts — Human-readable output logging for agent transcripts.
 *
 * Path: /tmp/pi-agent-outputs/<agentId>.log
 * Append-only, human-readable, supports `tail -f`.
 * Lines: [USER], [TOOL], [ASSISTANT], [DONE] with ISO timestamps.
 */

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { formatTokens } from "./usage.ts";
import { summarizeToolArgs } from "../utils.ts";

/** Punctuation treated as a flush boundary when streaming thinking deltas. */
const SENTENCE_BOUNDARY_CHARS = ".!?,\n";

function findLastSentenceBoundary(text: string): number {
  for (let i = text.length - 1; i >= 0; i--) {
    if (SENTENCE_BOUNDARY_CHARS.includes(text[i])) {
      return i;
    }
  }
  return -1;
}

function formatDoneLine(stats: OutputFinalStats): string {
  const tokensStr = `${formatTokens(stats.totalTokens)} tokens`;
  return `${timestamp()} [DONE] ${stats.turnCount} turns, ${stats.toolUseCount} tool uses, ${tokensStr}\n`;
}
/** Max content length for full tool result display — longer results get a summary line. */
const MAX_TOOL_RESULT_DISPLAY_LENGTH = 500;

function timestamp(): string {
  return new Date().toISOString();
}

/**
 * Create the output file path, ensuring the parent dir exists (0o700).
 * @param baseDir - Overrides the default /tmp/pi-agent-outputs; used for testability.
 */
export function createOutputFilePath(agentId: string, baseDir?: string): string {
  const dir = baseDir ?? "/tmp/pi-agent-outputs";
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return join(dir, `${agentId}.log`);
}

export function writeInitialEntry(path: string, prompt: string): void {
  const line = `${timestamp()} [USER] ${prompt}\n`;
  writeFileSync(path, line, "utf-8");
}

/** Best-effort append that never throws. */
function safeAppend(path: string, content: string): void {
  try {
    appendFileSync(path, content, "utf-8");
  } catch {
    /* ignore write errors */
  }
}

/**
 * Live thinking-block streaming state for the output file.
 *
 * Thinking deltas accumulate in a buffer. Once the buffer reaches the
 * configured size it flushes at the nearest sentence boundary (or at the
 * limit when none exists). thinking_end carries the full block, so the
 * streamed character count deduplicates the tail. turn_end flushes the
 * tail and marks any in-progress block as streamed so the message replay
 * in flush() skips it.
 */
class ThinkingStreamer {
  private buffer = "";
  /** Total chars streamed for the current block; deduplicates thinking_end. */
  private streamedChars = 0;
  /** Thinking blocks written live; skipped in the final message replay. */
  private streamedBlocks = 0;
  private blockInProgress = false;

  private readonly sink: OutputSink;
  private readonly bufferSize: number;

  // Explicit fields rather than parameter properties: this module is now
  // imported by `transcript-entry.ts`, which the suite loads under
  // `node --experimental-strip-types`, and strip-only mode cannot desugar a
  // parameter property. pi's jiti can; the test runner is the tighter
  // constraint and the one that has to be met.
  constructor(sink: OutputSink, bufferSize: number) {
    this.sink = sink;
    this.bufferSize = bufferSize;
  }

  onStart(): void {
    this.streamedChars = 0;
    this.blockInProgress = true;
  }

  onDelta(delta: string): void {
    this.buffer += delta;
    if (this.buffer.length < this.bufferSize) return;
    // Round down to nearest sentence boundary when possible
    const boundary = findLastSentenceBoundary(this.buffer);
    if (boundary >= 0) {
      const flushText = this.buffer.slice(0, boundary + 1);
      this.buffer = this.buffer.slice(boundary + 1);
      this.append(`${timestamp()} [THINKING] ${flushText}\n`);
      this.streamedChars += flushText.length;
    } else {
      // No sentence boundary found, flush at buffer limit
      this.flushTail();
    }
  }

  /**
   * Complete a block. thinking_end carries the full block: flush the
   * buffered tail first (counted in streamedChars), then stream whatever
   * remains.
   */
  onEnd(fullContent?: string): void {
    this.flushTail();
    if (fullContent && fullContent.length > this.streamedChars) {
      const remaining = fullContent.slice(this.streamedChars);
      this.append(`${timestamp()} [THINKING] ${remaining}\n`);
      this.streamedChars = fullContent.length;
    }
    this.streamedBlocks++;
    this.blockInProgress = false;
  }

  /**
   * End of turn: flush the tail, and if thinking_end never fired treat the
   * in-progress block as streamed so the message replay skips it.
   */
  endTurn(): void {
    this.flushTail();
    if (this.blockInProgress) {
      this.streamedBlocks++;
      this.blockInProgress = false;
    }
  }

  flushTail(): void {
    if (this.buffer.length === 0) return;
    this.append(`${timestamp()} [THINKING] ${this.buffer}\n`);
    this.streamedChars += this.buffer.length;
    this.buffer = "";
  }

  get blocksStreamed(): number {
    return this.streamedBlocks;
  }

  private append(content: string): void {
    this.sink(content);
  }
}

function splitAndPrefix(text: string, role: string): string {
  return text
    .split("\n")
    .filter(Boolean)
    .map((l) => `${timestamp()} [${role}] ${l}\n`)
    .join("");
}

function formatToolItem(item: Record<string, unknown>): string {
  const name = (item.name ?? item.toolName ?? "unknown") as string;
  // pi-ai ToolCall uses `arguments`, legacy/anthropic format uses `input`
  const rawArgs = (item.arguments ?? item.input) as Record<string, unknown> | undefined;
  const argsStr = summarizeToolArgs(name, rawArgs);
  return `${timestamp()} [TOOL] ${name}${argsStr}\n`;
}

function extractUserText(content: string | ReadonlyArray<Record<string, unknown>> | undefined): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((c) => String(c.text ?? "")).join("\n");
  }
  return "";
}

function formatToolResult(toolName: string, content: ReadonlyArray<Record<string, unknown>> | undefined): string {
  if (!content || !Array.isArray(content)) return "";

  const text = content
    .filter((c): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n");

  if (text.length > MAX_TOOL_RESULT_DISPLAY_LENGTH) {
    return `${timestamp()} [TOOL_RESULT] ${toolName}: ${text.length} chars\n`;
  }

  if (!text.trim()) return "";

  return splitAndPrefix(text, "TOOL_RESULT");
}

function formatMessageLine(
  content: string | ReadonlyArray<Record<string, unknown>> | undefined,
  skipStreamedThinkingBlocks: number = 0,
): string {
  if (typeof content === "string") {
    return splitAndPrefix(content, "ASSISTANT");
  }

  if (Array.isArray(content)) {
    let thinkingSkipped = 0;
    return content
      .map((item) => {
        if (item.type === "text" && typeof item.text === "string") {
          return splitAndPrefix(item.text, "ASSISTANT");
        }
        if (item.type === "toolUse" || item.type === "toolCall") {
          return formatToolItem(item);
        }
        if (item.type === "thinking" && typeof item.thinking === "string") {
          if (thinkingSkipped < skipStreamedThinkingBlocks) {
            thinkingSkipped++;
            return ""; // Already streamed, skip
          }
          const text = item.redacted ? "[redacted]" : item.thinking;
          return splitAndPrefix(text, "THINKING");
        }
        return "";
      })
      .join("");
  }

  return "";
}
/**
 * Where formatted lines go.
 *
 * Forge fork, twentieth pass. This used to be a path, and everything below
 * called `safeAppend(path, …)`. There are now two sinks for the same lines —
 * the `/tmp` log this file has always written, and the session transcript in
 * `transcript-entry.ts` — and the operator's request was for the SECOND SINK,
 * not a second formatter:
 *
 *   > The existing `AgentOutputLog` already owns the per-message formatting and
 *   > the thinking-buffer flush — the work is a second SINK, not a second
 *   > formatter.
 *
 * So the formatting, the `writtenCount` anchor, the compaction re-anchor and
 * the thinking-buffer sentence boundaries all stay here, exactly once, and a
 * caller says where the lines land.
 */
export type OutputSink = (content: string) => void;

/**
 * Stream session messages to `sink` on each turn_end. The returned cleanup
 * writes the DONE line and unsubscribes.
 *
 * `onTurnFlush` fires after each turn's lines have been handed over, which is
 * what lets the transcript sink group a turn into ONE session entry instead of
 * one per line — three background delegations settle interleaved, and a
 * transcript that cannot tell them apart is worse than the files it replaces.
 *
 * `startIndex` is where in `session.messages` this subscription begins, and it
 * is a parameter because there are now two kinds of attach.
 *
 * Forge fork, twenty-first pass (AL1). The default of 1 is the FIRST attach —
 * `onSessionCreated`, where index 0 is the prompt the caller has already
 * written as its opening line. `AgentOutputLog` only ever attaches there, so
 * for the life of this file the constant was right.
 *
 * The transcript added a SECOND attach: `continueSettledAgent` builds a fresh
 * `AgentTranscript` for a follow-up and subscribes it to the child's EXISTING
 * session, which by then holds every message of the settled run. A new
 * subscription anchored at 1 replays all of them on its first flush — so the
 * entry labelled *turn 1* of the follow-up held the beginning of the previous
 * run, and `MAX_LINES` then dropped the answer that follow-up was actually
 * about. The bound made the replay look like a truncated answer rather than
 * like a replay, which is why it reads as a transcript problem and is not one.
 *
 * The compaction re-anchor below still resets to 1, and correctly: pi rebuilds
 * the array, so index 0 is the new summary and everything after it is new.
 */
export function streamAgentOutput(
  session: AgentSession,
  sink: OutputSink,
  stats?: OutputFinalStats,
  bufferSize: number = 0,
  onTurnFlush?: () => void,
  startIndex: number = 1,
): () => void {
  let writtenCount = Math.max(0, startIndex);
  const thinking = new ThinkingStreamer(sink, bufferSize);

  const flush = () => {
    const messages = session.messages;
    while (writtenCount < messages.length) {
      const msg = messages[writtenCount];
      if (msg.role === "assistant") {
        const lines = formatMessageLine(msg.content as any, thinking.blocksStreamed);
        if (lines) sink(lines);
      } else if (msg.role === "user") {
        const text = extractUserText(msg.content as any);
        if (text.trim()) {
          sink(`${timestamp()} [USER] ${text}\n`);
        }
      } else if (msg.role === "toolResult") {
        const msgAny = msg as unknown as Record<string, unknown>;
        const lines = formatToolResult(
          (msgAny.toolName ?? "unknown") as string,
          msgAny.content as ReadonlyArray<Record<string, unknown>> | undefined,
        );
        if (lines) sink(lines);
      }
      writtenCount++;
    }
  };

  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "turn_end") {
      thinking.endTurn();
      flush();
      onTurnFlush?.();
    }

    // Flush before compaction runs so any not-yet-flushed tail still reaches the file
    if (event.type === "compaction_start") {
      flush();
    }

    // Re-anchor writtenCount to the rebuilt array after successful compaction.
    // Deferred one microtask because on the overflow-retry path pi trims the
    // trailing error assistant message AFTER emitting compaction_end — anchoring
    // synchronously would skip the first post-compaction message.
    if (event.type === "compaction_end" && !event.aborted && event.result) {
      queueMicrotask(() => {
        writtenCount = 1;
      });
    }

    if (bufferSize > 0 && event.type === "message_update") {
      const assistantEvent = event.assistantMessageEvent;
      if (assistantEvent.type === "thinking_start") {
        thinking.onStart();
      } else if (assistantEvent.type === "thinking_delta") {
        thinking.onDelta(assistantEvent.delta);
      } else if (assistantEvent.type === "thinking_end") {
        thinking.onEnd(assistantEvent.content);
      }
    }
  });

  return () => {
    thinking.flushTail();
    flush();
    onTurnFlush?.();

    const doneStats = stats ?? { turnCount: 0, toolUseCount: 0, totalTokens: 0 };
    sink(formatDoneLine(doneStats));

    unsubscribe();
  };
}

/** The `/tmp` log, which is `streamAgentOutput` with a file for a sink. */
export function streamToOutputFile(
  session: AgentSession,
  path: string,
  stats?: OutputFinalStats,
  bufferSize: number = 0,
): () => void {
  return streamAgentOutput(session, (content) => safeAppend(path, content), stats, bufferSize);
}

// ---------------------------------------------------------------------------
//  AgentOutputLog — lifecycle wrapper for per-agent output streaming
// ---------------------------------------------------------------------------

/** Final stats written to the DONE line at agent completion. */
export interface OutputFinalStats {
  turnCount: number;
  toolUseCount: number;
  totalTokens: number;
}

/**
 * Manages a single agent's output log lifecycle: create path → write initial
 * entry → attach session stream → finalize with stats → close.
 *
 * The manager holds one instance per agent. At spawn time the constructor
 * creates the file and writes the [USER] entry. When the session is ready,
 * `attach()` subscribes to streaming events. At completion, `finalize()`
 * flushes remaining messages, writes the [DONE] line, and unsubscribes.
 */
export class AgentOutputLog {
  readonly path: string;
  private cleanup?: () => void;
  private statsRef?: OutputFinalStats;
  private bufferSize: number;

  constructor(agentId: string, prompt: string, baseDir?: string, bufferSize: number = 0) {
    this.path = createOutputFilePath(agentId, baseDir);
    writeInitialEntry(this.path, prompt);
    this.bufferSize = bufferSize;
  }

  /**
   * Subscribe to session events so messages stream to the output file.
   * Internally passes a mutable stats reference that `finalize()` populates
   * before the DONE line is written.
   */
  attach(session: AgentSession): void {
    this.statsRef = { turnCount: 0, toolUseCount: 0, totalTokens: 0 };
    this.cleanup = streamToOutputFile(session, this.path, this.statsRef, this.bufferSize);
  }

  /**
   * Flush remaining messages, write the [DONE] line with final stats,
   * and unsubscribe from session events.
   *
   * Safe to call without a prior `attach()` — writes the DONE line only.
   */
  finalize(stats: OutputFinalStats): void {
    if (this.cleanup && this.statsRef) {
      // Populate the mutable stats ref so streamToOutputFile's cleanup
      // writes the actual final values to the DONE line.
      this.statsRef.turnCount = stats.turnCount;
      this.statsRef.toolUseCount = stats.toolUseCount;
      this.statsRef.totalTokens = stats.totalTokens;
      this.cleanup();
      this.cleanup = undefined;
      this.statsRef = undefined;
    } else {
      // No attach was called — write DONE directly
      safeAppend(this.path, formatDoneLine(stats));
    }
  }
}
