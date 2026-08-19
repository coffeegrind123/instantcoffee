/**
 * k3 — W3. `steer()` has two branches. One grows the brief; the other does not.
 *
 * The fork already fixed this for a SETTLED agent, and its own comment in
 * `continueSettledAgent` says exactly what went wrong:
 *
 *   > `brief` was written once, at spawn, and never updated. So steering a settled
 *   > agent … produced an answer to the STEER, judged against the ORIGINAL prompt.
 *   > The judge said NOT_ADDRESSED, correctly, and the repair then told the child
 *   > "This is the task, in full, as it was given to you: <the original>. Answer it
 *   > now" — actively undoing the operator's instruction.
 *
 * `AgentManager.steer()` reaches `continueSettledAgent` only when the record is
 * NOT running. The running branch called `session.steer(message)` and returned,
 * and the pending-steer branch pushed onto `record.execution.pendingSteers`.
 * Neither touched `record.execution.brief`.
 *
 * FIXED: both running branches call `growBrief`, which is the same
 * `appendFollowUp` the settled path uses — the live one only after the steer went,
 * because a brief that records an instruction the model never saw is the same
 * defect pointing the other way.
 *
 * Steering a running agent is not an obscure path: it is the affordance the
 * conversation viewer advertises by name — `conversation-viewer.ts` picks its verb
 * with `this.isActive() ? "steer" : "continue"`, so "steer" IS the running case —
 * and the /agents running-agents menu offers the same action.
 *
 * Three things read `record.execution.brief`, and all three get the wrong text:
 * the judge (what the answer is checked against), the repair prompt (what the
 * child is told to answer instead), and the compaction anchor (what is restated
 * into a freshly summarised context).
 *
 *   run:  node --experimental-strip-types k3-steering-a-running-agent-does-not-grow-the-brief.mjs
 */

import { readFileSync } from "node:fs";
import { appendFollowUp, buildRepairPrompt, buildAnchorMessage } from "/home/claudeuser/qwen3.8-forge/vendor/pi-subagents-lite/src/agents/verify.ts";

const SRC = "/home/claudeuser/qwen3.8-forge/vendor/pi-subagents-lite/src/agents/agent-manager.ts";

console.log("\n=== k3 — the brief, on every branch of steer() ===\n");

// ── the source, so this is pinned to the shipped file ────────────────────────
const src = readFileSync(SRC, "utf8");
const body = src.slice(src.indexOf("  async steer(id: string"), src.indexOf("  private continueSettledAgent"));
console.log("AgentManager.steer(), out of the file:\n");
console.log(body.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).map((l) => "  " + l).join("\n"));

const steerSrc = /async steer\(id: string[\s\S]*?\n  \}/.exec(src)?.[0] ?? "";
const grows = (steerSrc.match(/growBrief\(record, message\)/g) ?? []).length;
console.log(`  branches of steer() that grow the brief : ${grows} of 2   (BEFORE: 0)`);
console.log(`  the settled path still does             : ${/private continueSettledAgent[\s\S]*?growBrief\(record, message\)/.test(src)}\n`);

// ── what each path leaves the three readers ─────────────────────────────────
const ORIGINAL = "List every caller of tokenize() in src/, with file:line.";
const STEER = "Now also list the callers of lex(), same format.";

const settledBrief = appendFollowUp(ORIGINAL, STEER);
const runningBrief = ORIGINAL; // unchanged — the running branch never calls it

const show = (label, brief) => {
  console.log(`── ${label} ─────────────────────────────────────────────`);
  console.log("  brief the verifier checks against:");
  console.log("   ", JSON.stringify(brief));
  console.log("  what the repair tells the child, when the judge says NOT_ADDRESSED:");
  for (const line of buildRepairPrompt(brief, "it lists callers of lex(), which the task did not ask for").split("\n")) {
    console.log("   ", line);
  }
  console.log("  what the compaction anchor restates into the fresh context:");
  console.log("   ", buildAnchorMessage(brief).split("\n").slice(3).join(" "));
  console.log();
};

show("BEFORE — a running agent, steered: the brief stays at the spawn prompt", runningBrief);
show("NOW — every branch of steer() grows it, as the settled one always did", settledBrief);

console.log("  The child answered both questions. Judged against the BEFORE brief the extra");
console.log("  half is unasked-for, and the repair prompt hands the child the original task");
console.log("  with \"Answer it now\" and \"Do not restate the task\" — the operator's steer");
console.log("  undone by the layer that exists to catch drift, and labelled `✎ repaired`.\n");
