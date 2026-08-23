/**
 * The identifier a caller was SHOWN has to be one the lookup accepts — AO1.
 *
 * An agent id is seventeen characters; every model-facing surface in this
 * package publishes the first eight of it, `StopAgent` looked its record up with
 * an exact `Map.get` on the seventeen, and its refusal handed back a list of
 * eights. The assertion below is the invariant rather than its neighbourhood:
 * for every id this package can hold, the SHORT form of that id resolves to it.
 *
 * See §11.1 of `context/design/subagents-loop-verifier-identity.md`.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { ambiguousAgentIdMessage, distinguishingLength, resolveAgentId } from "../src/agents/agent-id.ts";
import { SHORT_ID_LENGTH } from "../src/types.ts";

/** Exactly how `AgentManager.spawn` mints one. */
const AGENT_ID_PREFIX_LENGTH = 17;
const newId = () => randomUUID().slice(0, AGENT_ID_PREFIX_LENGTH);
const short = (id: string) => id.slice(0, SHORT_ID_LENGTH);

describe("AO1 — the id that was published resolves to the record", () => {
  it("the short form every surface prints resolves, for a hundred real ids", () => {
    const ids = Array.from({ length: 100 }, newId);
    for (const id of ids) {
      const resolved = resolveAgentId(short(id), ids);
      assert.deepEqual(resolved, { kind: "resolved", id }, `short form of ${id}`);
    }
  });

  it("the full form still resolves — the exact rung is not lost to the prefix one", () => {
    const ids = Array.from({ length: 20 }, newId);
    for (const id of ids) assert.deepEqual(resolveAgentId(id, ids), { kind: "resolved", id });
  });

  it("an exact hit wins over a prefix hit, so a full id is never ambiguous", () => {
    // `abc` is both a record and a prefix of `abcdef`. The exact rung has to run
    // first or the full id reports two candidates and stops nothing.
    assert.deepEqual(resolveAgentId("abc", ["abc", "abcdef"]), { kind: "resolved", id: "abc" });
  });

  it("two records sharing the prefix are reported, never picked", () => {
    const resolved = resolveAgentId("ab", ["abcdef", "abzzzz"]);
    assert.equal(resolved.kind, "ambiguous");
    assert.deepEqual(resolved.kind === "ambiguous" ? resolved.candidates : [], ["abcdef", "abzzzz"]);
  });

  it("case folding, because hex is a thing a model re-types", () => {
    const id = "01a00f82-5331-7ea";
    assert.deepEqual(resolveAgentId(id.toUpperCase(), [id]), { kind: "resolved", id });
    assert.deepEqual(resolveAgentId(short(id).toUpperCase(), [id]), { kind: "resolved", id });
  });

  it("surrounding whitespace is not a different agent", () => {
    const id = newId();
    assert.deepEqual(resolveAgentId(`  ${short(id)} `, [id]), { kind: "resolved", id });
  });

  it("an empty, absent or non-string id is not-found rather than a match on everything", () => {
    const ids = [newId(), newId()];
    for (const bad of ["", "   ", undefined, null, 7, {}]) {
      assert.deepEqual(resolveAgentId(bad, ids), { kind: "not-found" }, `${String(bad)}`);
    }
  });

  it("an id that names nothing is not-found", () => {
    assert.deepEqual(resolveAgentId("zzzzzzzz", [newId(), newId()]), { kind: "not-found" });
  });

  it("no records at all is not-found, not a throw", () => {
    assert.deepEqual(resolveAgentId("abcdefgh", []), { kind: "not-found" });
  });

  it("the ambiguity message shows the candidates at a length that tells them apart", () => {
    // The candidates of an ambiguity are identical at the length that was asked,
    // so the message has to widen or it says "abcdefgh, abcdefgh. Use more of
    // the id" — which names nothing the caller can act on.
    const ids = ["abcdefghij-klmno", "abcdefghXY-klmno"];
    const message = ambiguousAgentIdMessage("abcdefgh", ids, SHORT_ID_LENGTH);
    assert.match(message, /matches 2 agents/);
    const shown = message.slice(message.indexOf(": ") + 2, message.indexOf(". Use")).split(", ");
    assert.equal(new Set(shown).size, 2, `two distinct spellings, got ${message}`);
    for (const s of shown) assert.ok(ids.some((id) => id.startsWith(s)), `${s} is a prefix of a candidate`);
    // …and each one resolves, so the sentence's own advice works.
    for (const s of shown) assert.equal(resolveAgentId(s, ids).kind, "resolved");
  });

  it("distinguishingLength never goes below the published width, and never past the id", () => {
    assert.equal(distinguishingLength(["abcdefghij", "abcdefghXY"], SHORT_ID_LENGTH), 9);
    assert.equal(distinguishingLength(["ab", "cd"], SHORT_ID_LENGTH), 2, "capped at the longest id");
    assert.equal(distinguishingLength(["abcdefghij", "klmnopqrst"], SHORT_ID_LENGTH), SHORT_ID_LENGTH);
    // Two records that are the same string cannot be told apart at any width;
    // the answer is the whole id rather than a loop that never ends.
    assert.equal(distinguishingLength(["abcd", "abcd"], 1), 4);
  });

  it("control — the exact lookup StopAgent used to make still misses the short form", () => {
    // The BEFORE column, stated as a test so the fix cannot be reverted quietly:
    // `Map.get(short)` on a map keyed by full ids is undefined for every id.
    const ids = Array.from({ length: 50 }, newId);
    const map = new Map(ids.map((id) => [id, id]));
    for (const id of ids) assert.equal(map.get(short(id)), undefined);
  });
});

/**
 * AO9 — the wiring, which is the half AO1's tests did not hold.
 *
 * Everything above drives `resolveAgentId` directly, and probe `ab1` drives the
 * same module beside a quoted copy of the old expression. Neither of them
 * touches the one line that makes the fix reach a caller:
 * `executeStopAgentTool` asking `resolveId` instead of `getRecord`.
 *
 * Measured, 2026-08-23. That line was put back to its pre-AO1 form — an exact
 * `getRecord(requestedId)` — and the whole tree stayed green: 1,434 tests, 0
 * failed, 121 probes, nothing said a word. A live delegation caught it in one
 * turn (`context/testing/subagents-loop-verifier.md` §AI.3): `AgentStatus`
 * printed `cbc6575f`, `StopAgent` was called with `cbc6575f`, and the answer was
 * `Agent cbc6575f not found. Running agents: cbc6575f (general-purpose)`.
 *
 * So the "control" test above — `Map.get(short)` is undefined — is true of the
 * expression and says nothing about whether this package still evaluates it.
 * A control run has to be able to fail.
 *
 * `tool-execution.ts` imports pi and cannot be loaded here, which is why this is
 * a source pin, in the shape `action-report.test.ts`'s "AF2 — the wiring" and
 * `background-delivery.test.ts` already use: an absence assertion for the
 * defective form, and positive assertions that fail if the call moves or is
 * renamed, so the absence is never vacuously true.
 */
describe("AO9 — StopAgent's resolution call site", () => {
  /** Comments are stripped: this file's subject is quoted in the comments there. */
  const source = readFileSync(fileURLToPath(new URL("../src/agents/tool-execution.ts", import.meta.url)), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
  const start = source.indexOf("export async function executeStopAgentTool(");
  const body = source.slice(start, source.indexOf("export async function toolCallListener("));

  it("the function this is about is still here, and still one function", () => {
    // The control for every assertion below: if `executeStopAgentTool` is
    // renamed or the next function moves, this fails first rather than letting
    // an empty slice pass the absence check.
    assert.ok(start > 0, "executeStopAgentTool not found in tool-execution.ts");
    assert.ok(body.length > 500, `body is ${body.length} chars — the slice bounds moved`);
  });

  it("asks the manager to RESOLVE the requested id", () => {
    assert.match(body, /const resolution = getManager\(\)!\.resolveId\(requestedId\);/);
  });

  it("does not look the requested id up exactly — that is the defect verbatim", () => {
    assert.doesNotMatch(body, /getRecord\(\s*requestedId\s*\)/, "the pre-AO1 lookup is back");
  });

  it("handles every rung the ladder can return", () => {
    // A resolution the call site does not branch on is a resolution it treats as
    // a hit, which for `ambiguous` would stop an agent nobody named.
    assert.match(body, /resolution\.kind === "ambiguous"/);
    assert.match(body, /resolution\.kind === "not-found"/);
    assert.match(body, /const agentId = resolution\.id;/);
  });

  it("fetches the record with the RESOLVED id, not the requested one", () => {
    assert.match(body, /getRecord\(agentId\)/);
  });

  it("names the agent back in the published spelling, not the one it resolved to", () => {
    // AO1's other half: a reply that identifies a record in a form the next call
    // would reject is the finding, one message over.
    assert.match(body, /const shortId = agentId\.slice\(0, SHORT_ID_LENGTH\);/);
    assert.doesNotMatch(body, /Stopped agent \$\{agentId\}/);
  });

  it("and the manager's resolveId is the ladder, not a second copy of it", () => {
    const manager = readFileSync(fileURLToPath(new URL("../src/agents/agent-manager.ts", import.meta.url)), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    assert.match(manager, /resolveId\(requested: unknown\): AgentIdResolution \{\s+return resolveAgentId\(requested, this\.agents\.keys\(\)\);/);
  });
});
