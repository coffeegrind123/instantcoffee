/**
 * verify-log.ts — Forge fork. What the judge actually said.
 *
 * ## Why this exists, and why it took twelve passes
 *
 * "Log the judge's raw reply" has been the #1 item on the *still unwatched* list
 * since the fourth pass. It is not a defect and it never produced a symptom; it
 * is the reason four findings needed a probe to be believed:
 *
 *   S2  a judge that echoed the prompt's own `VERDICT: ADDRESSED or
 *       NOT_ADDRESSED` menu was read as having CHOSEN `NOT_ADDRESSED`
 *   U4  a judge that echoed the `WHY:` instruction had that instruction quoted
 *       back to the child as the reason its answer was wrong
 *   V5  a repair that was hard-aborted mid-token went to the judge as an answer
 *   W5  the note the parent reads said "the 2th attempt"
 *
 * Every one of those is a statement about a string that existed for a few
 * milliseconds inside `verifyAnswer` and was then discarded. `parseJudgeVerdict`
 * is careful and heavily tested, but the tests are about replies somebody
 * *imagined* a 27B writing. This file is how the next one gets to be about a
 * reply a 27B actually wrote.
 *
 * ## What is written
 *
 * One JSONL line per model call the verifier makes — the judge's prompt and raw
 * reply, or the repair's prompt and the run it produced — plus the parse the
 * stack acted on. The parse is the point: a reply and a verdict side by side is
 * the only thing that can show the parser was wrong, and neither alone can.
 *
 * ## Bounds, because an unattended run does this once per delegation
 *
 * Both fields are truncated and the file is capped by line count, for the reason
 * `MAX_SPILL_FILES` exists in `compaction-guard`: a `/loop` running for days
 * verifies every delegation, and nothing else would ever remove a line. The cap
 * is applied on write, by rewriting the tail — cheap at this size, and it keeps
 * the newest entries, which are the ones anybody is reading.
 *
 * ## Never throws, and never blocks
 *
 * It runs inside `verifyAnswer`'s try, which is the function whose whole
 * contract is *never throw — an unverified answer is worth more than no answer*.
 * A log that cannot be written must not be the reason a verdict is lost, so every
 * path here swallows. Synchronous on purpose: the alternative is an unawaited
 * promise inside a function that returns a verdict, and one llama call takes
 * seconds where this takes microseconds.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { agentDirFile } from "../agent-dir.ts";

/**
 * Where the log lives.
 *
 * Under the pi agent directory rather than the working directory, because a
 * verification is a fact about this INSTALL and not about the repository the
 * parent happens to be looping on — and because an operator who wants to read it
 * after a run should not have to remember which cwd the run had. Resolved the
 * way `prinny-channel/src/config.ts` resolves its state directory, and for the
 * same reason: this module must not import pi.
 */
export function verifyLogFile(env: NodeJS.ProcessEnv = process.env): string {
  if (env.SUBAGENT_VERIFY_LOG_FILE) return env.SUBAGENT_VERIFY_LOG_FILE;
  // AN7: through `agent-dir.ts`, which is where this rule now lives. It was
  // written out here first and `pi-settings.ts` had a different answer to the
  // same question; one module, so a third reader cannot invent a third.
  return agentDirFile("subagent-verify.jsonl", env);
}

/** How much of a prompt or a reply is kept. Enough to read; not enough to be a transcript. */
export const MAX_FIELD_CHARS = 4_000;

/**
 * How many lines the file keeps.
 *
 * Two thousand is a few megabytes at these field sizes and months of ordinary
 * use; an unattended loop delegating every iteration reaches it in about a week.
 */
export const MAX_LINES = 2_000;

/** Set `SUBAGENT_VERIFY_LOG=0` to write nothing at all. */
export function verifyLogEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SUBAGENT_VERIFY_LOG !== "0";
}

export interface VerifyLogEntry {
  /** "judge" or "repair" — which model call this line is about. */
  phase: "judge" | "repair";
  agentId?: string;
  agentType?: string;
  /** Which round: 0 is the first judge, 1 the first repair and its re-judge, … */
  attempt: number;
  /** Exactly what the model was asked. */
  prompt: string;
  /** Exactly what came back, before anything read it. */
  reply: string;
  /** What the stack made of it. Absent for a repair, which is not parsed. */
  parsed?: { addressed: boolean; unparsed: boolean; why: string };
  /** For a repair: how the run ended, which is what the structural gate reads. */
  runStatus?: string;
  /** Milliseconds the call took. */
  ms?: number;
}

function truncate(text: unknown, max: number): string {
  const value = typeof text === "string" ? text : String(text ?? "");
  return value.length <= max ? value : `${value.slice(0, max)}\n… [${value.length - max} more chars]`;
}

/**
 * Keep the newest `MAX_LINES` lines.
 *
 * Read-and-rewrite rather than a rolling rename: the file is small, one writer
 * owns it, and a `.1` sibling is one more thing for an operator to know about.
 * The rewrite goes through a temp file and a rename so a reader never sees a
 * half-written log — the same shape `updateEnv` uses in `prinny-channel`.
 */
function prune(file: string, maxLines: number): void {
  try {
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
    if (lines.length <= maxLines) return;
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, `${lines.slice(-maxLines).join("\n")}\n`, { mode: 0o600 });
    renameSync(tmp, file);
  } catch {
    // Housekeeping. A file that cannot be pruned is not a reason to lose the
    // line the caller came here to write.
  }
}

/** How often to check the line count, in writes. Cheap, but not free. */
const PRUNE_EVERY = 50;
let writesSincePrune = 0;

/**
 * Append one line. Never throws.
 *
 * Returns whether anything was written, so a test can assert the switch works
 * without reading the filesystem.
 */
export function appendVerifyLog(entry: VerifyLogEntry, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!verifyLogEnabled(env)) return false;
  try {
    const file = verifyLogFile(env);
    const dir = dirname(file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      ...entry,
      prompt: truncate(entry.prompt, MAX_FIELD_CHARS),
      reply: truncate(entry.reply, MAX_FIELD_CHARS),
    });
    appendFileSync(file, `${line}\n`, { mode: 0o600 });
    if (++writesSincePrune >= PRUNE_EVERY) {
      writesSincePrune = 0;
      // Only when the file is big enough to be worth reading: `statSync` is
      // cheaper than the read `prune` would otherwise do every fiftieth write.
      if (statSync(file).size > MAX_LINES * 200) prune(file, MAX_LINES);
    }
    return true;
  } catch {
    // A log that cannot be written must never be the reason a verdict is lost.
    // `verifyAnswer` is the function whose contract is "never throw".
    return false;
  }
}

/** Reset the write counter. For tests. */
export function resetVerifyLogCounter(): void {
  writesSincePrune = 0;
}
