/**
 * verify-runner.ts — Forge fork. The verifier's control flow.
 *
 * `verify.ts` decides *what* the verdict is; this decides *when to spend a model
 * call on one*, and what happens to the answer afterwards. The model calls are
 * injected rather than imported so the whole ladder can be tested without a
 * model — the branch that matters most (a failed judge, one repair, still
 * failing) is the one that would otherwise never be exercised outside a live
 * session with a deliberately bad subagent in it.
 *
 * Order, and it is the point: the free checks run first and can end the whole
 * thing, so the common failures — an empty answer, a run that hit the turn
 * ceiling — cost nothing at all. Only a non-empty answer from a clean run is
 * worth a judge, because that is the only case where drift is invisible.
 */

import {
  buildJudgePrompt,
  buildRepairPrompt,
  parseJudgeVerdict,
  structuralVerdict,
  verificationNote,
} from "./verify.ts";
import type { AgentRecord } from "../types.js";

// `./verify.ts`, not `./verify.js`: upstream's internal specifiers are `.js`
// (fine under pi's loader and a bundler), but `tests/` runs under plain node,
// where `./verify.js` resolves to a file that does not exist. The extension
// loads either way — the wire measurement in FORK.md was taken with this.

export interface VerifyDeps {
  /** Run the judge on its own, with no history. Returns its raw reply. */
  judge: (prompt: string) => Promise<string>;
  /** Continue the child's own session with one repair prompt. Returns the new answer. */
  repair: (prompt: string) => Promise<string>;
  /** Operator-facing line; never shown to either model. */
  notify?: (message: string) => void;
}

export interface VerifyOutcome {
  /** The answer to hand the parent — original, repaired, or annotated. */
  answer: string;
  /** What happened, for the log and the tests. */
  status: "skipped-empty" | "skipped-cutoff" | "passed" | "unparsed" | "repaired" | "failed" | "errored";
}

/**
 * Check one settled answer, and repair it once if it does not address the task.
 *
 * Never throws. A verifier that fails takes the answer with it otherwise, and
 * an unverified answer is worth more than no answer — the caller is told which
 * it got.
 */
export async function verifyAnswer(
  record: Pick<AgentRecord, "result" | "lifecycle">,
  brief: string,
  deps: VerifyDeps,
): Promise<VerifyOutcome> {
  const answer = record.result ?? "";

  const structural = structuralVerdict(answer, record.lifecycle);
  if (!structural.ok) {
    // An empty answer is replaced by the note, not appended to: there is
    // nothing to append to, and an empty string reads to the parent as a
    // successful lookup that found nothing.
    return { answer: structural.note ?? answer, status: "skipped-empty" };
  }
  if (!structural.worthJudging) {
    return { answer, status: "skipped-cutoff" };
  }
  if (!brief.trim()) {
    // No brief recorded means nothing to check against. Say nothing and pass it
    // through rather than inventing a comparison.
    return { answer, status: "skipped-cutoff" };
  }

  try {
    const verdict = parseJudgeVerdict(await deps.judge(buildJudgePrompt(brief, answer)));

    if (verdict.unparsed) {
      deps.notify?.("Subagent answer went out unchecked — the verifier's reply could not be read.");
      return { answer: answer + verificationNote("unparsed"), status: "unparsed" };
    }
    if (verdict.addressed) {
      return { answer, status: "passed" };
    }

    deps.notify?.(`Subagent answer did not address the task (${verdict.why}) — asking it once more.`);
    const repaired = (await deps.repair(buildRepairPrompt(brief, verdict.why))).trim();

    // A repair that comes back empty is worse than the original: at least the
    // original said something. Keep the first answer and flag it.
    if (repaired === "") {
      return { answer: answer + verificationNote("failed"), status: "failed" };
    }

    // The repair is NOT re-judged. One judge call and one repair is the whole
    // budget: a re-judge invites a loop on the slot the parent is waiting for,
    // and the parent is told this answer is a second attempt so it can weigh it.
    return { answer: repaired + verificationNote("repaired"), status: "repaired" };
  } catch (error) {
    deps.notify?.(`Subagent answer went out unchecked — the verifier failed: ${errorText(error)}`);
    return { answer: answer + verificationNote("unparsed"), status: "errored" };
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
