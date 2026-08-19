/**
 * verify-runner.ts — Forge fork. The verifier's control flow.
 *
 * `verify.ts` decides *what* the verdict is; this decides *when to spend a model
 * call on one*, and what happens to the answer afterwards. The model calls are
 * injected rather than imported so the whole ladder can be tested without a
 * model — the branch that matters most (a failed judge, a repair, still
 * failing) is the one that would otherwise never be exercised outside a live
 * session with a deliberately bad subagent in it.
 *
 * Order, and it is the point: the free checks run first and can end the whole
 * thing, so the common failures — an empty answer, a run that hit the turn
 * ceiling — cost nothing at all. Only a non-empty answer from a clean run is
 * worth a judge, because that is the only case where drift is invisible.
 *
 * ## Rounds, and why there is a ceiling rather than a single hardcoded retry
 *
 * The check→repair pair is a loop with a budget, exactly like the child's own
 * turn ceiling: `DEFAULT_VERIFY_ROUNDS` repairs, each one re-judged, then the
 * verifier stops and says what happened. Two properties matter more than the
 * number:
 *
 * - **The repair is checked.** The earlier design judged the original and then
 *   returned the retry unverified, which meant the single answer nobody
 *   verified was the one already known to have come from a confused child. A
 *   budget of rounds makes "was the fix any good?" answerable instead of
 *   assumed.
 * - **It terminates on three separate conditions**, not just the counter: an
 *   empty repair, a repair identical to what was just rejected, and the budget.
 *   A counter alone lets a child that has stopped moving burn the whole budget
 *   restating itself.
 *
 * When every attempt fails, the child's **original** answer is what goes back,
 * annotated. It is the answer the parent would have received with the verifier
 * switched off, and preferring a later attempt would mean shipping text
 * produced by a child that has since been told twice it was wrong — smaller,
 * more apologetic, and no better addressed. The alternative (return the last
 * attempt) is defensible and was rejected deliberately.
 */

import {
  buildJudgePrompt,
  buildRepairPrompt,
  parseJudgeVerdict,
  structuralVerdict,
  verificationNote,
} from "./verify.ts";
import type { AgentRecord, AgentStatus, AgentVerification, VerifyPhase } from "../types.js";

// `./verify.ts`, not `./verify.js`: upstream's internal specifiers are `.js`
// (fine under pi's loader and a bundler), but `tests/` runs under plain node,
// where `./verify.js` resolves to a file that does not exist. The extension
// loads either way — the wire measurement in FORK.md was taken with this.

/**
 * What one repair run produced, and how it ended.
 *
 * The status is not decoration. A repair is a RUN — it goes into the child's own
 * session with the child's own tools, at `maxTurns: 1` and the configured grace
 * turns, so pi's loop keeps going while there are tool results and the hard abort
 * lands several turns later with whatever had streamed. The structural gate below
 * refuses to judge a child run that ended that way; until this field existed it
 * could not refuse a REPAIR that ended that way, because the repair reported only
 * its text.
 *
 * See V5 in `context/design/subagents-loop-verifier-shapes.md`.
 */
export interface RepairResult {
  /** The new answer, as the run produced it. */
  text: string;
  /** How the run ended: the same classification the manager gives the child's own run. */
  status: AgentStatus;
}

export interface VerifyDeps {
  /** Run the judge on its own, with no history. Returns its raw reply. */
  judge: (prompt: string) => Promise<string>;
  /** Continue the child's own session with one repair prompt. Returns the new answer and how the run ended. */
  repair: (prompt: string) => Promise<RepairResult>;
  /** Operator-facing line; never shown to either model. */
  notify?: (message: string) => void;
  /**
   * Called with the phase about to run, and with undefined when the verifier is
   * done. Only the two paths that make a model call report a phase — the free
   * structural checks announce nothing, so a skip never flashes a "verifying"
   * row for the microsecond it takes to decide, and never reports a clear for a
   * phase it never set.
   */
  onPhase?: (phase: VerifyPhase | undefined) => void;
  /**
   * One record per model call this function makes: what was asked, what came
   * back, and what was made of it.
   *
   * Injected rather than imported for the reason everything else here is — this
   * module must stay loadable without a filesystem — and OPTIONAL because the
   * verdict does not depend on it. See `verify-log.ts` for why it exists at all:
   * four findings in this series are statements about a judge's reply that
   * nothing kept, and a reply without the parse beside it cannot show that the
   * parser was wrong.
   */
  log?: (entry: VerifyLogRecord) => void;
}

/** What {@link VerifyDeps.log} is handed. Mirrors `verify-log.ts`'s entry. */
export interface VerifyLogRecord {
  phase: "judge" | "repair";
  attempt: number;
  prompt: string;
  reply: string;
  parsed?: { addressed: boolean; unparsed: boolean; why: string };
  runStatus?: string;
  ms?: number;
}

export interface VerifyOutcome {
  /** The answer to hand the parent — original, repaired, or annotated. */
  answer: string;
  /** What happened, for the log and the tests. */
  status: AgentVerification;
}

export interface VerifyOptions {
  /** How many repair attempts to allow. Clamped to [0, MAX_VERIFY_ROUNDS]. */
  rounds?: number;
}

/**
 * How many times a wrong answer may be sent back, by default.
 *
 * One, and the reasoning is the same as the one behind the child's own turn
 * ceiling: the point of a bound is not that the number is optimal but that
 * there is one. A round costs two model calls (the repair, then the re-check)
 * on the single llama slot the parent is blocked on, and it costs the child two
 * more turns in a window that is already the thing most likely to be wrong —
 * repeatedly re-asking a child whose context is nearly full pushes it toward
 * the compaction that causes the drift this exists to catch. So the default
 * spends one round and then tells the truth about the result.
 */
export const DEFAULT_VERIFY_ROUNDS = 1;

/**
 * The ceiling on the ceiling. Three rounds is already up to seven model calls
 * for one subagent answer; past that the honest move is a narrower task, not a
 * more insistent verifier.
 */
export const MAX_VERIFY_ROUNDS = 3;

/**
 * Read the round budget from an operator-supplied string.
 *
 * Anything unreadable falls back to the default rather than to zero: a typo in
 * `.env` must not silently disable the repair, because the failure would look
 * exactly like a verifier that judged everything correct.
 */
export function resolveVerifyRounds(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_VERIFY_ROUNDS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_VERIFY_ROUNDS;
  return clampRounds(parsed);
}

function clampRounds(rounds: number | undefined): number {
  if (rounds === undefined || !Number.isFinite(rounds)) return DEFAULT_VERIFY_ROUNDS;
  return Math.min(MAX_VERIFY_ROUNDS, Math.max(0, Math.floor(rounds)));
}

/**
 * How long one verification model call may take before it is abandoned.
 *
 * There has to be a number, because nothing else bounds these calls. They run
 * inside the settlement chain, *after* the child's status has gone terminal —
 * and every stop path keys off `status === "running"`. So during a judge or a
 * repair: the operator's Esc reaches `abort()`, which reaches `stopAgent()`,
 * which returns false; the `StopAgent` tool the same; and the watchdog's
 * `check()` does not merely skip the record, it drops its state. Meanwhile the
 * parent's `Agent` tool call is blocked on the completion gate, which does not
 * open until verification returns. A wedged provider therefore hangs the parent
 * with no operator-reachable exit — and this stack has seen llama-server wedge
 * badly enough that an 8-token completion timed out at 60s while /health
 * answered instantly.
 *
 * Five minutes: long enough that a slow but working 27B is never cut off (the
 * judge is one turn over at most ~5.5k chars, the repair one turn in a context
 * that already exists), short enough that a wedge is a pause and not a hang.
 * A timeout surfaces as the verifier's existing `errored` verdict — the answer
 * still goes out, annotated as unchecked, which is the whole failure policy of
 * this layer.
 */
export const DEFAULT_VERIFY_TIMEOUT_MS = 300_000;

/** Floor and ceiling. Below the floor a working call would be cut off; above it, "bounded" is a fiction. */
export const MIN_VERIFY_TIMEOUT_MS = 10_000;
export const MAX_VERIFY_TIMEOUT_MS = 3_600_000;

/**
 * Read the per-call deadline from an operator-supplied string, in milliseconds.
 *
 * Unreadable falls back to the default rather than to "no timeout", for the same
 * reason `resolveVerifyRounds` does: a typo in `.env` must not silently restore
 * the hang this exists to prevent. `0` is not a way to disable it — it clamps to
 * the floor — because a disabled deadline is indistinguishable from the bug.
 */
export function resolveVerifyTimeoutMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_VERIFY_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_VERIFY_TIMEOUT_MS;
  return Math.min(MAX_VERIFY_TIMEOUT_MS, Math.max(MIN_VERIFY_TIMEOUT_MS, Math.floor(parsed)));
}

/**
 * Check one settled answer, and repair it up to `rounds` times if it does not
 * address the task.
 *
 * Never throws. A verifier that fails takes the answer with it otherwise, and
 * an unverified answer is worth more than no answer — the caller is told which
 * it got.
 *
 * "Never throws" is why the structural gate, the brief check and `clampRounds`
 * are INSIDE the try rather than above it. They were above it, which made the
 * promise true only for the code anyone was looking at: this runs inside
 * `attachSettlementChain`'s `.then`, so a throw from the prologue reached that
 * chain's `.catch`, which sets `record.result = undefined` and the status to
 * `error`. A finished subagent's answer would have been discarded and its run
 * reported to the parent as a failure because the CHECK broke — the exact
 * inversion this layer exists to prevent. Nothing in the prologue throws today;
 * the point is that the guarantee should not depend on that staying true.
 */
export async function verifyAnswer(
  record: Pick<AgentRecord, "result" | "lifecycle">,
  brief: string,
  deps: VerifyDeps,
  options: VerifyOptions = {},
): Promise<VerifyOutcome> {
  const answer = typeof record?.result === "string" ? record.result : "";
  // Only a run that announced a phase has one to clear. Moving the structural
  // gate inside the try (see the doc comment) put the skips through the same
  // `finally`, and clearing unconditionally there would report a phase change on
  // a path that never made a model call — the one thing the skips were written
  // to avoid.
  let phaseReported = false;

  try {
    const structural = structuralVerdict(answer, record.lifecycle);
    if (!structural.ok) {
      // An empty answer is replaced by the note, not appended to: there is
      // nothing to append to, and an empty string reads to the parent as a
      // successful lookup that found nothing.
      return { answer: structural.note ?? answer, status: "skipped-empty" };
    }
    if (!structural.worthJudging) {
      // Two different facts, two different badges. A run that died on the
      // provider is not a run that was cut off, and the operator reads the
      // difference in the widget and in /agents.
      return { answer, status: structural.skip === "error" ? "skipped-error" : "skipped-cutoff" };
    }
    if (typeof brief !== "string" || !brief.trim()) {
      // No brief recorded means nothing to check against. Say nothing and pass it
      // through rather than inventing a comparison. Reported separately from a
      // cut-off run: that one explains itself in the status note, this one is a
      // fault in the spawn path that would otherwise never surface.
      return { answer, status: "skipped-nobrief" };
    }

    const rounds = clampRounds(options.rounds);

    // `candidate` is what is being judged this time round; `answer` stays the
    // child's original throughout, because that is what gets handed back if
    // every attempt fails.
    let candidate = answer;
    let attempts = 0;

    for (;;) {
      phaseReported = true;
      phase(deps, "judging");
      const judgePrompt = buildJudgePrompt(brief, candidate);
      const judgeStartedAt = Date.now();
      const reply = await deps.judge(judgePrompt);
      const verdict = parseJudgeVerdict(reply);
      // The reply and the parse together, because neither alone can show that
      // the parse was wrong — which is what S2, U4, V5 and W5 each needed and
      // none of them had. Guarded: a logger that throws must not cost a verdict.
      try {
        deps.log?.({
          phase: "judge",
          attempt: attempts,
          prompt: judgePrompt,
          reply,
          parsed: { addressed: verdict.addressed, unparsed: verdict.unparsed, why: verdict.why },
          ms: Date.now() - judgeStartedAt,
        });
      } catch {
        // A verdict is worth more than a log line.
      }

      if (verdict.unparsed) {
        deps.notify?.("Subagent answer went out unchecked — the verifier's reply could not be read.");
        // `attempts` matters here from the second round on: `candidate` is then a
        // REPAIRED answer, and a note that mentions only the unreadable check
        // drops the fact that the original did not address the task.
        return { answer: candidate + verificationNote("unparsed", attempts), status: "unparsed" };
      }
      if (verdict.addressed) {
        // attempts === 0 is the common case: the child was right first time and
        // its answer must go back undecorated.
        return attempts === 0
          ? { answer: candidate, status: "passed" }
          : { answer: candidate + verificationNote("repaired", attempts), status: "repaired" };
      }
      if (attempts >= rounds) {
        return { answer: answer + verificationNote("failed", attempts), status: "failed" };
      }

      attempts += 1;
      deps.notify?.(
        `Subagent answer did not address the task (${verdict.why}) — asking again (attempt ${attempts} of ${rounds}).`,
      );
      phaseReported = true;
      phase(deps, "repairing");
      const repairPrompt = buildRepairPrompt(brief, verdict.why);
      const repairStartedAt = Date.now();
      const outcome = await deps.repair(repairPrompt);
      const repaired = typeof outcome?.text === "string" ? outcome.text.trim() : "";
      try {
        deps.log?.({
          phase: "repair",
          attempt: attempts,
          prompt: repairPrompt,
          reply: typeof outcome?.text === "string" ? outcome.text : "",
          // How the run ENDED, which is what the structural gate below reads —
          // V5 is the finding that a repair's status was dropped on the floor.
          runStatus: outcome?.status,
          ms: Date.now() - repairStartedAt,
        });
      } catch {
        // Same as the judge's: a verdict is worth more than a log line.
      }

      // The repair is a run, so it goes through the same gate the child's run
      // did. That covers both of the cheap rejections at once:
      //
      //   - an EMPTY repair is worse than the original, which at least said
      //     something (`ok: false`, skipped-empty);
      //   - a repair that was cut off — hard-aborted at maxTurns + graceTurns,
      //     stopped, or dead on the provider — is a run whose text is not an
      //     answer, whatever it happens to contain (`worthJudging: false`).
      //
      // The second case is why this exists. Before it, only the text crossed
      // back, so a repair truncated mid-token was judged as though it had
      // finished — and if the judge read the fragment as addressing the task, the
      // parent was handed it under "this is the corrected one, and it was
      // re-checked". The identical text, labelled as the run it actually was, is
      // something this same function declines to judge four lines up.
      //
      // `?? "completed"` keeps a caller that reports no status working, and is
      // deliberately the permissive default: a missing status must not turn a
      // good repair into a failure.
      const repairGate = structuralVerdict(repaired, { status: outcome?.status ?? "completed" });
      if (!repairGate.ok || !repairGate.worthJudging) {
        return { answer: answer + verificationNote("failed", attempts), status: "failed" };
      }

      // The child repeated itself. Another round would spend the same slot on
      // the same text for the same verdict; a model that has nothing more to
      // give says so by saying the same thing again.
      if (repaired === candidate.trim()) {
        return { answer: answer + verificationNote("stalled", attempts), status: "failed" };
      }

      candidate = repaired;
    }
  } catch (error) {
    try {
      deps.notify?.(`Subagent answer went out unchecked — the verifier failed: ${errorText(error)}`);
    } catch {
      // The operator's notice is the least important thing on this path; a
      // throwing notifier must not be the reason the answer is lost.
    }
    return { answer: answer + verificationNote("errored"), status: "errored" };
  } finally {
    // Every path leaves through here, including the structural skips and the two
    // throwing ones. A phase left set would show a row spinning "checking the
    // answer" forever on an agent that finished, which is a worse lie than
    // showing nothing — but a skip never set one, and must not report a change.
    if (phaseReported) phase(deps, undefined);
  }
}

/**
 * Report a phase without letting the reporter break the verdict.
 *
 * The hook writes to a UI-facing record field, and this is called from inside
 * the try that decides the outcome — an exception from a display concern must
 * not be caught below and reported as "the verifier failed".
 */
function phase(deps: VerifyDeps, value: VerifyPhase | undefined): void {
  try {
    deps.onPhase?.(value);
  } catch {
    // A verdict is worth more than a spinner.
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
