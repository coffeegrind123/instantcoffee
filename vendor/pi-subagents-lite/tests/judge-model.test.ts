/**
 * The judge runs on the CHILD's model, not the parent's.
 *
 * `buildVerifyDeps` runs the judge through `runAgent` directly (not `spawn()`,
 * for the deadlock reason its own comment gives), and passed no `model`. So
 * `initSession` fell to `findModelInRegistry(agentConfig?.model, …, ctx.model)`
 * — the `__verifier` type has no model of its own, so that is the PARENT's.
 *
 * With every model the same, nobody could tell. In orchestrator mode the parent
 * is the local 27B on one llama slot and the children are remote: fifteen
 * children settling means fifteen judge calls queued on the slot the parent
 * needs, each prefilling a task and an answer over the parent's cached prefix.
 * The repair already continues the child's own session, so it was always on the
 * child's model; the judge now matches it.
 *
 * `agent-manager.ts` imports pi, so this is a source pin, like the others here.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

function code(rel: string): string {
  return readFileSync(new URL(rel, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
}

const MANAGER = code("../src/agents/agent-manager.ts");
const RUNNER = code("../src/agents/agent-runner.ts");

function judgeCall(): string {
  const start = MANAGER.indexOf("judge: async (prompt: string)");
  assert.ok(start >= 0, "the judge dependency is gone — re-read buildVerifyDeps");
  const call = MANAGER.indexOf("runAgent(ctx, VERIFIER_AGENT_TYPE", start);
  assert.ok(call >= 0, "the judge no longer calls runAgent for VERIFIER_AGENT_TYPE");
  return MANAGER.slice(call, MANAGER.indexOf("});", call));
}

describe("the judge's model", () => {
  it("is the child session's model", () => {
    assert.match(judgeCall(), /\bmodel:\s*record\.execution\.session\?\.model\b/);
  });

  it("control — runAgent's explicit model outranks the agent type's and the parent's", () => {
    // If this precedence changed, passing `model` above would stop mattering.
    assert.match(
      RUNNER,
      /const model = options\.model \?\? findModelInRegistry\(agentConfig\?\.model, ctx\.modelRegistry, ctx\.model\)/,
    );
  });

  it("control — the repair still continues the child's own session", () => {
    const start = MANAGER.indexOf("repair: async (prompt: string)");
    assert.ok(start >= 0);
    assert.match(MANAGER.slice(start, start + 400), /const session = record\.execution\.session;/);
  });
});
