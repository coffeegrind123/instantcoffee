/**
 * The `Agent` tool's declared surface and its implementation say the same thing.
 *
 * Several notes, most of them the same shape — S1's shape, "the artefact a reader
 * checks is not what runs" — and all in `tool-execution.ts`, which imports pi and
 * cannot be loaded by this suite. So these are source pins, and each one also
 * pins the DECLARATION it has to agree with, so the pair cannot drift apart
 * silently.
 *
 * 1. **`max_turns` was read off `params`** and the schema does not declare it,
 *    with `additionalProperties: false`, so the read was always undefined.
 *    Adding it to the schema was rejected: `max_turns` is the ceiling that stops
 *    an unbounded child stalling the one-slot machine, and it belongs to the
 *    agent's own .md or the operator's config, not to the caller about to be
 *    blocked on it.
 *
 *    **Thirteenth pass (AD1): `model` was in that sentence and did not belong
 *    there, and this test is how the mistake shipped.** The pin asserted
 *    `doesNotMatch(/params\.model\b/)` on the strength of "the schema forbids
 *    it, so nothing can send it" — true of the MODEL, and the model is not the
 *    sender. `toolCallListener` is a `tool_call` handler; pi hands the same
 *    validated-args object to the handler and to `execute`
 *    (pi-agent-core `agent-loop.js`: `beforeToolCall({args: validatedArgs})`,
 *    then `tool.execute(id, prepared.args, …)`), and the listener writes
 *    `input.model` and `input.thinking` onto it. So the tool read `thinking`
 *    from the same object three lines below the line this test forbade reading
 *    `model` from. What the schema governs is what the MODEL may send; what the
 *    listener writes is a different question, and the two are pinned separately
 *    below.
 *
 * 2. **`hidden: true` kept a type out of the tool's description and not out of
 *    `resolveType`.** The `agent` parameter is a plain `Type.String()`, not an
 *    enum, so a parent model could spawn `__verifier` by name — one wasted call
 *    on the single llama slot, and a record labelled "verify" in `/agents` doing
 *    something that is not a verification. Now `executeAgentTool` refuses it,
 *    while `resolveType` stays open for the internal callers (the judge reaches
 *    `__verifier` through `getAgentConfig`, the wizard through the coordinator).
 *
 * 3. **`record.stats.turnCount` started at 1**, and `onTurnEnd` writes the
 *    RUNNING total — so the initial value is only ever read before the first
 *    `turn_end`, where "1" claims a turn finished when none has. A record that
 *    fails during setup settles with it, and every reader treats it as a count
 *    of finished turns.
 *
 * See §9 of `context/design/subagents-loop-verifier-hosts.md`.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

/** Comments quote the defective forms on purpose; strip them before matching. */
function codeOf(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
}

describe("the Agent tool's parameters", () => {
  const execution = codeOf("../src/agents/tool-execution.ts");
  const registration = codeOf("../src/registration.ts");

  it("does not read a parameter only the model could have sent", () => {
    assert.doesNotMatch(execution, /params\.max_turns/, "the schema has additionalProperties: false");
  });

  it("DOES read the two the tool_call listener writes", () => {
    // AD1. These are not model-supplied and the schema has nothing to say about
    // them: `toolCallListener` computes them and mutates the args object pi is
    // about to execute with. Dropping the `model` read silently retired every
    // layer of `resolveModel`'s precedence above the parent's own model, while
    // `renderAgentToolCall` and the `/agents` model menu went on reporting the
    // override as the effective one.
    assert.match(execution, /params\.model as string \| undefined/);
    assert.match(execution, /parseThinkingLevel\(params\.thinking as string \| undefined\)/);
  });

  it("…and reads them only while they are about the type it is spawning", () => {
    // AE6 (fourteenth pass). AD1's read is right and is not the whole rule: the
    // listener resolves against the name the MODEL wrote and the registry as it
    // stands, while this function resolves the canonical name AFTER a discovery
    // scan. Two keys, one precedence, and the injected value is the answer only
    // when they are the same key.
    assert.match(execution, /const listenerResolvedThisType = params\._resolvedAgent === resolvedType;/);
    assert.match(execution, /listenerResolvedThisType\s*\?\s*\(params\.model as string \| undefined\)\s*:\s*resolveSpawnModel\(resolvedType, ctx\)/);
    assert.match(execution, /const thinkingLevel = listenerResolvedThisType/);
    assert.match(execution, /:\s*resolveSpawnThinking\(resolvedType\);/);
  });

  it("control — the listener is what puts them there, keyed on the CANONICAL name", () => {
    // The pin above is only meaningful while this holds. If the listener stops
    // injecting, the reads become dead and this pair is re-decided together.
    //
    // AE6 added the second half: the listener must resolve the name before it
    // resolves anything else, and must stamp what it resolved. A listener that
    // went back to `input.agent` verbatim would satisfy the old three assertions
    // and reopen the defect, which is why the canonicalisation is pinned here and
    // not only in the tool.
    const listener = execution.slice(execution.indexOf("export async function toolCallListener"));
    assert.match(listener, /const canonicalType = canonicalAgentType\(requestedType\);/);
    assert.match(listener, /if \(!canonicalType\) return;/, "an unresolvable name injects nothing at all");
    assert.match(listener, /input\._resolvedAgent = canonicalType;/);
    assert.match(listener, /input\.model = effectiveModel/);
    assert.match(listener, /const effectiveModel = resolveSpawnModel\(canonicalType, ctx\);/);
    assert.match(listener, /input\.thinking = resolveSpawnThinking\(canonicalType\);/);
    assert.doesNotMatch(
      listener,
      /modelFor\(\s*subagentType/,
      "the raw name the model wrote is not a key anything is looked up by",
    );
  });

  it("control — there is ONE resolver, and it is the six-level precedence", () => {
    // Both ends call the same two functions, so the value the TUI prints beside
    // the call and the value the spawn runs on cannot be computed differently.
    // That is the whole repair: AD1 made resolution load-bearing, and two callers
    // resolving it separately is how it drifted again.
    assert.match(execution, /function resolveSpawnModel\(canonicalType: string, ctx: ExtensionContext\): string \{/);
    assert.match(execution, /return getStore\(\)\.modelFor\(canonicalType, parentModelId, getAgentConfig\(canonicalType\)\);/);
    assert.match(execution, /function canonicalAgentType\(requested: string\)/);
    assert.match(execution, /resolution\.kind === "resolved" \? resolution\.key : undefined/);
  });

  it("control — the declaration is still the five keys, closed", () => {
    // The pin above is only meaningful while this holds. If a future change adds
    // max_turns back to the schema, this fails and the pair is re-decided
    // together rather than drifting.
    assert.match(registration, /additionalProperties: false/);
    for (const key of ["prompt", "description", "agent", "run_in_background", "worktree_path"]) {
      assert.match(registration, new RegExp(`${key}:`), `${key} must still be declared`);
    }
    assert.doesNotMatch(registration, /\bmax_turns:/);
  });

  it("refuses a hidden agent type", () => {
    assert.match(
      execution,
      /getAgentConfig\(resolvedType\)\?\.hidden === true/,
      "hidden must mean not offered AND not callable through the model-facing tool",
    );
  });

  it("control — resolveType stays open to hidden names for internal callers", () => {
    // The judge reaches __verifier through getAgentConfig -> resolveType, so
    // closing THAT would break the verifier itself. The gate belongs at the tool.
    const types = codeOf("../src/agents/agent-types.ts");
    const body = types.slice(types.indexOf("export function resolveType("));
    const fn = body.slice(0, body.indexOf("\n}\n") + 2);
    assert.doesNotMatch(fn, /hidden/, "resolveType must not learn about hidden");
  });
});

describe("a record's turn count", () => {
  it("starts at zero, because no turn has finished", () => {
    const manager = codeOf("../src/agents/agent-manager.ts");
    assert.match(manager, /turnCount: 0,/);
    assert.doesNotMatch(manager, /turnCount: 1,/);
  });
});

describe("T5 — a verification is stoppable", () => {
  const manager = codeOf("../src/agents/agent-manager.ts");

  it("runVerification arms an abort controller for the window it owns", () => {
    assert.match(manager, /record\.execution\.verifyAbort = new AbortController\(\)/);
    assert.match(manager, /record\.execution\.verifyAbort = undefined;/, "cleared in the finally");
  });

  it("stopAgent aborts it instead of returning false", () => {
    // The status is already terminal by then, so the `status === "running"`
    // test below it can never see this work. The branch has to come first.
    const body = manager.slice(manager.indexOf("private stopAgent("));
    const branch = body.indexOf("isVerifyingRecord(record) && record.execution.verifyAbort");
    const runningTest = body.indexOf('record.lifecycle.status !== "running"');
    assert.notEqual(branch, -1, "stopAgent must recognise a verifying record");
    assert.ok(branch < runningTest, "and must do it BEFORE the test that would return false");
  });

  it("the deadline composes the stop signal, so whichever comes first wins", () => {
    assert.match(manager, /function startDeadline\(label: string, timeoutMs: number, stopSignal\?: AbortSignal\)/);
    assert.match(manager, /if \(stopSignal\?\.aborted\) throw new Error\(`the \$\{label\} was stopped`\)/);
    // Both model calls pass it.
    const passes = manager.match(/record\.execution\.verifyAbort\?\.signal/g) ?? [];
    assert.equal(passes.length, 2, "the judge and the repair are the two calls to bound");
  });

  it("control — the per-call deadline is still there, because nobody presses Esc in a cron job", () => {
    assert.match(manager, /resolveVerifyTimeoutMs\(process\.env\.SUBAGENT_VERIFY_TIMEOUT_MS\)/);
  });

  it("control — Clear still refuses a verifying record", () => {
    // T5 makes the work stoppable; it does not make the record clearable. Y1's
    // reason is unchanged: removeRecord disposes the session a repair runs in.
    assert.match(manager, /if \(isVerifyingRecord\(record\)\) return false;/);
  });
});

/**
 * AD2 (thirteenth pass) — T5's stop, reached from the tool as well as from the
 * menu.
 *
 * `AgentManager.stopAgent()` has recognised a verifying record since the
 * eleventh pass, and its comment claims the fix covers "the operator's Esc, for
 * `StopAgent`, and for anything else that asked". `executeStopAgentTool` had its
 * own precondition one layer up — `status !== "running" && status !== "queued"`
 * → return early — and a verifying record's status is terminal, so the manager
 * was never asked and the model was told the agent was "already completed"
 * while a judge held the single llama slot.
 *
 * These are pins; `tool-execution.ts` imports pi and cannot be loaded here. The
 * EXECUTION is `context/testing/probes/q2-the-stop-the-tool-cannot-reach.mjs`,
 * which drives the real function through pi's own jiti and shows both columns —
 * because a fix whose test cannot execute the function it changed is pinned
 * against editing, not against breaking (the twelfth pass's own lesson, AC1).
 */
describe("AD2 — the StopAgent tool and a record that is still being checked", () => {
  const execution = codeOf("../src/agents/tool-execution.ts");

  it("asks whether the record is BUSY, not what its status says", () => {
    assert.match(execution, /if \(!isBusyRecord\(record\)\) \{/);
    assert.doesNotMatch(
      execution,
      /record\.lifecycle\.status !== "running" && record\.lifecycle\.status !== "queued"/,
      "the status pair is what could not see a verifying record",
    );
  });

  it("names which run it stopped, because the child's own run had finished", () => {
    assert.match(execution, /const verifying = isVerifyingRecord\(record\);/);
    assert.match(execution, /Stopped the answer check on agent/);
  });

  it("and the 'Running agents' hint uses the same predicate", () => {
    const list = execution.slice(execution.indexOf("function formatRunningAgents("));
    assert.match(list.slice(0, 400), /\.filter\(isBusyRecord\)/);
  });

  it("control — one definition, three readers", () => {
    // record-activity.ts exists because this question had three answers. The
    // widget and the /agents menu were already on it; this was the fourth reader
    // and the last one with its own.
    const activity = codeOf("../src/agents/record-activity.ts");
    assert.match(activity, /export function isBusyRecord/);
    assert.match(activity, /return isActiveRecord\(record\) \|\| isVerifyingRecord\(record\);/);
  });
});
