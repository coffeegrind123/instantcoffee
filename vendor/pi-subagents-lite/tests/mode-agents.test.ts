/**
 * SUBAGENT_MODE_AGENTS_DIR — agent types a launcher mode brings with it.
 *
 * Orchestrator mode ships its own worker types (prompts/orchestrator/agents/ in
 * the forge repo): a system prompt that follows a brief and reports evidence,
 * not intent. None of the three existing roots can hold them. The global
 * ~/.pi/agent/agents is the operator's and applies to every mode; a project's
 * .pi/agents and .agents/agents belong to whatever repo pi is running in. So
 * the launcher names a fourth root for this launch only.
 *
 * Precedence: above the user's global agents (the mode's worker must be the
 * mode's), below the project's (a repo that defines its own `worker` still
 * means it). Loading uses the same `.js` → `.ts` hook as agent-frontmatter.
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

register(
  `data:text/javascript,
   import { existsSync } from "node:fs";
   import { fileURLToPath } from "node:url";
   export async function resolve(specifier, context, next) {
     if (specifier.startsWith(".") && specifier.endsWith(".js")) {
       try {
         const r = await next(specifier.slice(0, -3) + ".ts", context);
         if (existsSync(fileURLToPath(r.url))) return r;
       } catch {}
     }
     return next(specifier, context);
   }`,
);

const AT = await import("../src/agents/agent-types.ts");

function agentFile(dir: string, name: string, body: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${name}.md`),
    `---\nname: ${name}\ndescription: ${body}\n---\n${body}\n`,
  );
}

function roots() {
  const base = mkdtempSync(join(tmpdir(), "mode-agents-"));
  return {
    user: join(base, "user"),
    shared: join(base, "shared"),
    project: join(base, "project"),
    mode: join(base, "mode"),
  };
}

describe("SUBAGENT_MODE_AGENTS_DIR", () => {
  it("adds the mode's agent types when set", async () => {
    const r = roots();
    agentFile(r.mode, "worker", "MODE WORKER");
    AT.setAgentScanDirs(r.user, r.project, r.shared);
    process.env.SUBAGENT_MODE_AGENTS_DIR = r.mode;
    try {
      const merged = await AT.scanAndMerge();
      assert.match(merged.get("worker")?.systemPrompt ?? "", /MODE WORKER/);
    } finally {
      delete process.env.SUBAGENT_MODE_AGENTS_DIR;
    }
  });

  it("adds nothing when unset — every other mode", async () => {
    const r = roots();
    agentFile(r.mode, "worker", "MODE WORKER");
    AT.setAgentScanDirs(r.user, r.project, r.shared);
    const merged = await AT.scanAndMerge();
    assert.equal(merged.has("worker"), false);
  });

  it("outranks the operator's global agent of the same name", async () => {
    const r = roots();
    agentFile(r.user, "worker", "GLOBAL WORKER");
    agentFile(r.mode, "worker", "MODE WORKER");
    AT.setAgentScanDirs(r.user, r.project, r.shared);
    process.env.SUBAGENT_MODE_AGENTS_DIR = r.mode;
    try {
      const merged = await AT.scanAndMerge();
      assert.match(merged.get("worker")?.systemPrompt ?? "", /MODE WORKER/);
    } finally {
      delete process.env.SUBAGENT_MODE_AGENTS_DIR;
    }
  });

  it("is outranked by the project's own agent of the same name", async () => {
    const r = roots();
    agentFile(r.mode, "worker", "MODE WORKER");
    agentFile(r.project, "worker", "PROJECT WORKER");
    AT.setAgentScanDirs(r.user, r.project, r.shared);
    process.env.SUBAGENT_MODE_AGENTS_DIR = r.mode;
    try {
      const merged = await AT.scanAndMerge();
      assert.match(merged.get("worker")?.systemPrompt ?? "", /PROJECT WORKER/);
    } finally {
      delete process.env.SUBAGENT_MODE_AGENTS_DIR;
    }
  });
});
