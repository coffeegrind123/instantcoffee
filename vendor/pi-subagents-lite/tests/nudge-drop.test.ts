/**
 * §11.1, closed — a background result that was not delivered says so.
 *
 * `SpawnCoordinator.emitIndividualNudge` is the only route a background
 * subagent's answer has to the parent model, and it began with three guards —
 * `this.disposed`, `!pi`, `!record`. Each is correct: there is genuinely nothing
 * to send through, or nothing to send. Each also dropped a finished delegation's
 * answer with nothing said anywhere.
 *
 * AC1 settled what this is worth saying — *"a delivery that did not happen is the
 * loudest thing this class can report; it must not be the quietest"* — and built
 * a `console.warn` plus a notice for the `catch` around the send. All three
 * guards return before that `try`.
 *
 * Recorded by the fifteenth pass as the one refusal it found and did not close,
 * on the grounds that the full fix is a delivery queue surviving a session swap.
 * That is still true, and it is not what this is: the answer is still on the
 * record either way, so the whole of what was missing is a sentence naming it.
 *
 * `spawn-coordinator.ts` imports `../shell.js`, which imports pi, so the suite
 * cannot load it: the sentences are tested here and the wiring is pinned at the
 * source, with comments stripped because this file's own comments quote the
 * defective form.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  describeNudgeDrop,
  NO_RECOVERY_ADVICE,
  RECOVERY_ADVICE,
  type NudgeDropReason,
} from "../src/spawn/nudge-drop.ts";

/**
 * The three guards inside `emitIndividualNudge`.
 *
 * `session-ending` is deliberately NOT in this list: it is reported from
 * `dispose()`, not from a guard, and the wiring assertions below slice the
 * `emitIndividualNudge` body. AI1 has its own block at the bottom.
 */
const REASONS: NudgeDropReason[] = ["session-replaced", "no-runtime", "record-gone"];

/** Strip comments: the ones below quote the three bare returns on purpose. */
function codeOf(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
}

describe("§11.1 — what an undelivered background result says", () => {
  it("names the agent, the cause, and the recovery", () => {
    const drop = describeNudgeDrop("session-replaced", "1a2b3c4d", "Explore");
    assert.match(drop.log, /could not deliver the result of "Explore" 1a2b3c4d/);
    assert.match(drop.log, /the session was replaced/);
    assert.match(drop.notice, /result NOT delivered to the model/);
    // AG6: the recovery has to be one that can produce the answer. `AgentStatus`
    // cannot — see the AG6 block at the bottom of this file.
    assert.match(drop.notice, /View result/, "the answer is still on the record");
  });

  it("gives each cause its own sentence", () => {
    const causes = REASONS.map((reason) => describeNudgeDrop(reason, "x", "Explore").log);
    assert.equal(new Set(causes).size, REASONS.length, "three guards, three different facts");
    assert.match(causes[1], /no live extension runtime/);
    assert.match(causes[2], /record was removed/);
    assert.match(causes[2], /cleared from \/agents/, "the likeliest way it happens is worth naming");
  });

  it("works without a type, which is the one case that has no record left", () => {
    const drop = describeNudgeDrop("record-gone", "1a2b3c4d");
    assert.match(drop.log, /the result of 1a2b3c4d/);
    assert.doesNotMatch(drop.log, /undefined/);
    assert.doesNotMatch(drop.notice, /undefined/);
  });

  it("every reason ends in an instruction that can actually be followed", () => {
    // AG6 (sixteenth pass): this used to assert that all three ended in "Read it
    // with AgentStatus", which is a tool that prints a status and never the
    // result. The instruction now depends on whether there IS an answer left to
    // read — see the AG6 block at the bottom of this file — so what is common to
    // all three is that each ends in a sentence, not that they end in the same
    // one.
    for (const reason of REASONS) {
      const { notice } = describeNudgeDrop(reason, "x", "T");
      assert.match(notice, /\.$/, `${reason} must end in a full sentence`);
      assert.ok(
        notice.endsWith(RECOVERY_ADVICE) || notice.endsWith(NO_RECOVERY_ADVICE),
        `${reason} must end in one of the two sentences this module owns: ${notice}`,
      );
    }
  });
});

describe("§11.1 — the wiring", () => {
  const code = codeOf(fileURLToPath(new URL("../src/spawn/spawn-coordinator.ts", import.meta.url)));

  it("no guard returns without reporting", () => {
    // The shape of the defect: `if (…) return;` with nothing before the return.
    // The positive assertions below are the control — they fail if the calls are
    // renamed or moved, which an absence assertion alone cannot see (the
    // thirteenth pass's rule).
    const nudge = code.slice(code.indexOf("private emitIndividualNudge"));
    const body = nudge.slice(0, nudge.indexOf("\n  }"));
    assert.doesNotMatch(body, /if \(this\.disposed\) return;/);
    assert.doesNotMatch(body, /if \(!pi\) return;/);
    assert.doesNotMatch(body, /if \(!record\) return;/);
    for (const reason of REASONS) {
      assert.match(body, new RegExp(`this\\.reportDrop\\("${reason}"`), `${reason} must be reported`);
    }
  });

  it("the record is looked up BEFORE the guards, so a drop can name it", () => {
    const nudge = code.slice(code.indexOf("private emitIndividualNudge"));
    const body = nudge.slice(0, nudge.indexOf("\n  }"));
    const lookup = body.indexOf("this.manager.getRecord(agentId)");
    const disposed = body.indexOf("this.disposed");
    assert.ok(lookup > 0 && lookup < disposed, "otherwise the notice cannot say which agent it was");
  });

  it("reports on a channel that exists headless", () => {
    // `noOpUIContext.notify` is `() => {}` outside a TUI, which is where an
    // unattended run lives — so the warn is not decoration.
    const report = code.slice(code.indexOf("private reportDrop"));
    const body = report.slice(0, report.indexOf("\n  }"));
    assert.match(body, /console\.warn\(/);
    assert.match(body, /spawnCtx \?\? getSessionCtx\(\)/, "the spawning session's own context first, as AC1 does");
    assert.match(body, /catch/, "a session that is going away must not throw out of a report about it");
  });
});

/**
 * AG6 — the recovery a drop notice names has to be able to produce the answer.
 *
 * All four notices said "Read it with AgentStatus", and `executeAgentStatusTool`
 * formats one line per agent — `id (type) status` — and never reads
 * `record.result` at all. The surface that CAN show it is `/agents` → the agent
 * → "View result".
 *
 * The two source reads below are the point of the test rather than decoration:
 * the claim is *about* those two files, and it is what would silently stop being
 * true if either of them changed. That is the sixteenth pass's own rule — the
 * thing you name is a file you can open — applied to the assertion.
 */
describe("AG6 — the surface a dropped result points at", () => {
  const PKG = fileURLToPath(new URL("../src/", import.meta.url));
  const status = readFileSync(`${PKG}agents/agent-status.ts`, "utf8");
  const menu = readFileSync(`${PKG}ui/menu/menu-running-agents.ts`, "utf8");
  const coordinator = readFileSync(`${PKG}spawn/spawn-coordinator.ts`, "utf8");

  it("the premise: AgentStatus prints a status and never the result", () => {
    assert.match(status, /return `\$\{shortId\} \(\$\{record\.display\.type\}\) \$\{listedStatus\(record\)\}`/);
    assert.doesNotMatch(status, /record\.result/, "the tool that is named cannot show an answer");
  });

  it("the premise: /agents can — that is the surface to name", () => {
    assert.match(menu, /value: "view-result", label: "View result"/);
    assert.match(menu, /showTextViewer\(ctx, record, "result", record\.result!\)/);
  });

  it("no drop notice sends the operator to AgentStatus any more", () => {
    for (const reason of REASONS) {
      const { notice } = describeNudgeDrop(reason, "1a2b3c4d", "Explore");
      assert.doesNotMatch(notice, /AgentStatus/, `${reason} named a tool that cannot show it`);
    }
  });

  it("the two recoverable reasons name /agents and its action by name", () => {
    for (const reason of ["session-replaced", "no-runtime"] as NudgeDropReason[]) {
      const { notice } = describeNudgeDrop(reason, "1a2b3c4d", "Explore");
      assert.ok(notice.endsWith(RECOVERY_ADVICE), `${reason}: ${notice}`);
      assert.match(notice, /\/agents/);
      assert.match(notice, /View result/);
    }
  });

  it("record-gone says there is nothing to read, because both surfaces read the same map", () => {
    const { notice } = describeNudgeDrop("record-gone", "1a2b3c4d", "Explore");
    assert.ok(notice.endsWith(NO_RECOVERY_ADVICE), notice);
    assert.doesNotMatch(notice, /View result/, "recommending a surface that cannot work is worse than silence");
  });

  it("the coordinator's own catch uses the same sentence rather than a fourth copy", () => {
    assert.match(coordinator, /RECOVERY_ADVICE/);
    assert.doesNotMatch(coordinator, /read it with AgentStatus/i);
  });
});

/**
 * AI1 — the nudge that was still QUEUED when the session ended.
 *
 * `dispose()` cleared `pendingNudges` and cancelled the one timer that drains
 * it, so an id sitting in that set at `session_shutdown` was discarded with
 * nothing said — while the `session-replaced` guard written for "session_shutdown,
 * or a session replaced under it" could only ever fire for a record that settles
 * AFTER the dispose. The report existed and the path to it did not.
 *
 * AH1 (seventeenth pass) made the window large: a nudge held for somebody else's
 * compaction is put back into that same set every `COMPACTION_WAIT_MS` for as
 * long as the lock is held, which the lock bounds at five minutes.
 *
 * The control for all of it is `AgentManager.dispose`, thirty lines away in the
 * same package, which fails its QUEUED records honestly for the same reason.
 */
describe("AI1 — a queued nudge at session_shutdown", () => {
  const coordinator = readFileSync(fileURLToPath(new URL("../src/spawn/spawn-coordinator.ts", import.meta.url)), "utf8");
  const manager = readFileSync(fileURLToPath(new URL("../src/agents/agent-manager.ts", import.meta.url)), "utf8");

  it("has its own sentence, distinct from a session replaced under a live nudge", () => {
    const ending = describeNudgeDrop("session-ending", "1a2b3c4d", "Explore");
    const replaced = describeNudgeDrop("session-replaced", "1a2b3c4d", "Explore");
    assert.notEqual(ending.log, replaced.log, "never fired and fired-too-late are two different facts");
    assert.match(ending.log, /still queued/);
    assert.match(ending.notice, /result NOT delivered to the model/);
    assert.match(ending.notice, /"Explore" 1a2b3c4d/);
  });

  it("does NOT name /agents, because the session that owns it is the thing ending", () => {
    // AG6's rule, applied to the one reason it did not exist for: a recovery that
    // cannot work is worse than saying there is none. `events.ts` disposes the
    // manager two statements after the coordinator, and `/agents` reads that map.
    const { notice } = describeNudgeDrop("session-ending", "1a2b3c4d", "Explore");
    assert.doesNotMatch(notice, /\/agents/);
    assert.doesNotMatch(notice, /View result/);
    assert.ok(notice.endsWith(NO_RECOVERY_ADVICE), notice);
  });

  it("names the transcript when there is one — the only thing that outlives the session", () => {
    const { notice } = describeNudgeDrop("session-ending", "1a2b3c4d", "Explore", "/tmp/pi-agents/1a2b3c4d.md");
    assert.match(notice, /transcript is at \/tmp\/pi-agents\/1a2b3c4d\.md/);
    assert.doesNotMatch(notice, /undefined/);
  });

  it("dispose() drains the pending set through reportDrop instead of clearing it", () => {
    const body = coordinator.slice(coordinator.indexOf("  dispose(): void {"));
    const end = body.slice(0, body.indexOf("\n  }"));
    assert.match(end, /this\.reportDrop\("session-ending"/, "the drop has to be spoken");
    // The defect is an ORDER as much as a call: the ids have to be read before
    // the set is cleared, or there is nothing left to report about.
    const read = end.indexOf("[...this.pendingNudges]");
    const cleared = end.indexOf("this.pendingNudges.clear()");
    assert.ok(read >= 0 && read < cleared, "read the queue before clearing it");
  });

  it("the control: AgentManager.dispose already fails its queued records loudly", () => {
    // Same teardown, same kind of pending work, and the sentence AI1 is modelled
    // on. If this stops being true the finding's own argument has moved.
    const body = manager.slice(manager.indexOf("  dispose() {"));
    assert.match(body.slice(0, body.indexOf("\n  }")), /status === "queued"/);
    assert.match(manager, /DISPOSE_QUEUED_MESSAGE = "Agent manager disposed before the queued agent could start\."/);
  });
});
