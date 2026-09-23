/**
 * SUBAGENT_MAX_DEPTH — a subagent that can delegate, one level down.
 *
 * Default 1 is the old contract: a child has no way to spawn. At 2
 * (orchestrator mode sets it) a depth-1 child gets one tool, `SubAgent`, and a
 * depth-2 grandchild gets nothing. What makes that safe:
 *
 * - The child gets the tool from the RUNNER, which knows the depth, type and id
 *   of the session it is building, as an inline extension factory on that
 *   child's resource loader. A child never loads this extension from its path
 *   (it discovers its own extensions and never sees the parent's `-e`), so
 *   index.ts's early return is not where this can be decided — measured: its
 *   factory ran once per session, in the parent, and never in a child.
 * - `SubAgent` is foreground-only. A background result is delivered to the
 *   process-wide pi instance, which is the OPERATOR's session — a grandchild's
 *   answer would land in the orchestrator instead of the child that asked for
 *   it. pi runs one turn's tool calls in parallel, so a child still fans out.
 * - A read-only caller (an explorer) may only spawn read-only types, judged on
 *   the tool list each type actually runs with.
 * - Each depth has its own concurrency pool (depth-slots.test.ts).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  effectiveTools,
  isReadOnlyTools,
  maxDepth,
  mayNest,
  nestedDepthFor,
} from "../src/spawn/build-context.ts";

function code(rel: string): string {
  return readFileSync(new URL(rel, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
}

describe("maxDepth", () => {
  it("is 1 when unset — the old contract, for every mode that does not ask", () => {
    assert.equal(maxDepth({}), 1);
  });

  it("reads 2", () => {
    assert.equal(maxDepth({ SUBAGENT_MAX_DEPTH: "2" }), 2);
  });

  for (const bad of ["0", "3", "two", "1.5", "-1", ""]) {
    it(`refuses ${JSON.stringify(bad)} and keeps 1`, () => {
      assert.equal(maxDepth({ SUBAGENT_MAX_DEPTH: bad }), 1);
    });
  }
});

describe("nestedDepthFor", () => {
  it("gives a depth-1 child the tool when the limit is 2", () => {
    assert.equal(nestedDepthFor({ depth: 1, type: "worker" }, 2), 1);
  });

  it("gives a depth-2 grandchild nothing", () => {
    assert.equal(nestedDepthFor({ depth: 2, type: "worker" }, 2), null);
  });

  it("gives nothing at the default limit", () => {
    assert.equal(nestedDepthFor({ depth: 1, type: "worker" }, 1), null);
  });

  it("gives nothing to a run that is not a spawn — the judge has no depth", () => {
    assert.equal(nestedDepthFor({ depth: Infinity, type: "__verifier" }, 2), null);
  });
});

describe("mayNest", () => {
  const WRITE = undefined; // tools unset = everything, including edit and write
  const READ = ["read", "grep", "find", "ls", "bash", "SubAgent"];

  it("read-only is a declared whitelist without edit or write, or no tools at all", () => {
    assert.equal(isReadOnlyTools(READ), true);
    assert.equal(isReadOnlyTools(false), true);
    assert.equal(isReadOnlyTools(WRITE), false);
    assert.equal(isReadOnlyTools(true), false);
    assert.equal(isReadOnlyTools(["read", "edit"]), false);
  });

  it("a writer may spawn anything", () => {
    assert.equal(mayNest(WRITE, WRITE), true);
    assert.equal(mayNest(WRITE, READ), true);
  });

  it("a read-only caller may spawn only read-only types", () => {
    assert.equal(mayNest(READ, READ), true);
    assert.equal(mayNest(READ, WRITE), false);
  });
});

describe("effectiveTools", () => {
  // The built-in Explore restricts itself through registeredTools and leaves
  // `tools` unset. Read off `tools` alone it looks like a writer — so an
  // explorer could not spawn it, and an Explore could spawn workers.
  const READ_ONLY_REGISTERED = ["read", "grep", "find", "ls"];

  it("a declared whitelist wins", () => {
    assert.deepEqual(effectiveTools(["read", "bash"], ["read", "bash", "edit", "write"]), ["read", "bash"]);
  });

  it("no tools at all is an empty surface", () => {
    assert.deepEqual(effectiveTools(false, ["read"]), []);
  });

  it("unset falls back to the registered set — Explore", () => {
    assert.deepEqual(effectiveTools(undefined, READ_ONLY_REGISTERED), READ_ONLY_REGISTERED);
    assert.equal(isReadOnlyTools(effectiveTools(undefined, READ_ONLY_REGISTERED)), true);
  });

  it("…and general-purpose, registered with edit and write, is a writer", () => {
    assert.equal(isReadOnlyTools(effectiveTools(undefined, ["read", "bash", "edit", "write"])), false);
  });

  it("the tool passes effective lists to mayNest, not raw frontmatter", () => {
    const EXEC_SRC = readFileSync(new URL("../src/agents/tool-execution.ts", import.meta.url), "utf8");
    assert.match(EXEC_SRC, /mayNest\(\s*effectiveTools\(/);
  });
});

describe("the wiring", () => {
  const INDEX = code("../src/index.ts");
  const RUNNER = code("../src/agents/agent-runner.ts");
  const EXEC = code("../src/agents/tool-execution.ts");

  it("the runner decides, from the spawn's own depth, type and id", () => {
    assert.match(
      RUNNER,
      /nestedDepthFor\(\s*\{\s*depth:\s*options\.depth\s*\?\?\s*Infinity,\s*type\s*\},\s*maxDepth\(\)\s*\)/,
    );
  });

  it("…and hands the child's loader an inline factory that registers SubAgent", () => {
    assert.match(RUNNER, /extensionFactories:/);
    assert.match(RUNNER, /registerNestedAgentTool\(pi, nestedDepth, type, options\.agentId\)/);
  });

  it("index.ts no longer pretends to decide it: a child never runs that factory", () => {
    assert.doesNotMatch(INDEX, /registerNestedAgentTool|nestedDepthFor|currentBuild/);
  });

  it("SubAgent spawns in the foreground, one level down, bound to the caller's signal", () => {
    const start = EXEC.indexOf("export async function executeNestedAgentTool(");
    assert.ok(start >= 0, "executeNestedAgentTool is gone");
    const body = EXEC.slice(start, EXEC.indexOf("\nexport ", start + 10));
    assert.match(body, /runInBackground:\s*false/);
    assert.match(body, /depth:\s*callerDepth \+ 1/);
    assert.match(body, /signal,/);
    assert.match(body, /mayNest\(/);
  });
});
