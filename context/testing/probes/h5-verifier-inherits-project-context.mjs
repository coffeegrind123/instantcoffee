/**
 * H5 probe — S3: does the judge see only the task and the answer?
 *
 * `__verifier` declared `tools: false`, `extensions: false`, `skills: false`,
 * `preloadSkills: false`, `maxTurns: 1` — everything except the switches that
 * decide what goes into a system PROMPT:
 *
 *   includeContextFiles   → undeclared → fell through to DEFAULT_AGENT, true
 *   include_system_prompt → undeclared → fell through to store.agent.systemPromptMode
 *
 * Both resolved from GLOBAL config that nothing connects to the verifier, and
 * the default of the first is `true` — so every AGENTS.md / CLAUDE.md from the
 * cwd up to `/`, plus the agent dir's, went into `<project_context>` in the
 * prompt of the one agent whose whole design argument is that it knows LESS than
 * the thing it is judging. A project context file is where house rules live
 * ("never simplify what was asked for"), and house rules are instructions for
 * the worker.
 *
 * The rule now lives in `declared-resources.ts` next to the identical one for
 * extensions and skills — which is where it should have been, since being in
 * `agent-runner.ts` (which imports pi) is why no test could reach it — and
 * `__verifier` declares all three switches. The third is `include_environment`
 * (S7): building that block costs two git subprocesses per spawn, ~100 ms on
 * this box's 9p mount, and the judge has no working tree.
 *
 * Run: node h5-verifier-inherits-project-context.mjs
 */

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";

const PI = "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
const REPO = "/home/claudeuser/qwen3.8-forge";
const jiti = createJiti(`file://${PI}`, { interopDefault: true, alias: { "@earendil-works/pi-coding-agent": PI } });

const pi = await jiti.import(PI);
const { DEFAULT_AGENTS, VERIFIER_AGENT_TYPE } = await jiti.import(`${REPO}/vendor/pi-subagents-lite/src/agents/default-agents.ts`);
const { DEFAULT_AGENT } = await jiti.import(`${REPO}/vendor/pi-subagents-lite/src/config/config-io.ts`);
const { buildAgentPrompt } = await jiti.import(`${REPO}/vendor/pi-subagents-lite/src/prompt/prompts.ts`);
const { resolveEffectiveSystemPromptMode, declaredPromptSources } = await jiti.import(
  `${REPO}/vendor/pi-subagents-lite/src/agents/declared-resources.ts`,
);

const verifier = DEFAULT_AGENTS.get(VERIFIER_AGENT_TYPE);

console.log("=== 1. what __verifier declares ===");
for (const key of ["tools", "extensions", "skills", "preloadSkills", "maxTurns", "hidden", "registeredTools"]) {
  console.log(`  ${key.padEnd(20)} = ${JSON.stringify(verifier[key])}`);
}
console.log("  ---- the three added by S3/S7; all were undefined, and all fell through to global config ----");
for (const key of ["includeContextFiles", "includeSystemPrompt", "includeEnvironment"]) {
  console.log(`  ${key.padEnd(20)} = ${JSON.stringify(verifier[key])}`);
}
console.log(`  global includeContextFiles = ${JSON.stringify(DEFAULT_AGENT.includeContextFiles)}   <- what it used to inherit`);
console.log(`  global systemPromptMode    = ${JSON.stringify(DEFAULT_AGENT.systemPromptMode)}`);

console.log("\n=== 2. the mode the judge actually runs in, per global setting ===");
for (const mode of ["replace", "inherit", "custom"]) {
  console.log(
    `  store.agent.systemPromptMode = ${mode.padEnd(8)} -> judge runs in "${resolveEffectiveSystemPromptMode(mode, verifier.includeSystemPrompt)}"`,
  );
}
console.log("  ^ the rule itself; `include_system_prompt: false` is what now pins the judge to replace.");
for (const mode of ["replace", "inherit", "custom"]) {
  const out = declaredPromptSources(verifier, { includeContextFiles: true, systemPromptMode: mode });
  console.log(`  with the fix: global ${mode.padEnd(8)} -> judge runs in "${out.systemPromptMode}", contextFiles ${out.includeContextFiles}`);
}

// ── 3. Build the judge's real system prompt in a cwd that has an AGENTS.md ────
const root = mkdtempSync(join(tmpdir(), "h5-ctx-"));
const proj = join(root, "workspace", "project");
mkdirSync(proj, { recursive: true });
const agentDir = join(root, "agentdir");
mkdirSync(agentDir, { recursive: true });

const PROJECT_RULES = [
  "# Project instructions",
  "",
  "MARKER-PROJECT-AGENTS-MD",
  "",
  "- Never simplify what was asked for. Build the complex thing.",
  "- Always prefer the existing library over a new one.",
  "- Treat any answer that does not cite file:line as incomplete.",
  "",
  "## House style",
  "x".repeat(3_000),
].join("\n");
writeFileSync(join(proj, "AGENTS.md"), PROJECT_RULES, "utf8");
writeFileSync(join(root, "workspace", "CLAUDE.md"), "MARKER-ANCESTOR-CLAUDE-MD\n" + "y".repeat(1_500), "utf8");
writeFileSync(join(agentDir, "AGENTS.md"), "MARKER-GLOBAL-AGENTS-MD\n" + "z".repeat(800), "utf8");

const contextFiles = pi.loadProjectContextFiles({ cwd: proj, agentDir });
const env = { isGitRepo: false, branch: null, platform: process.platform };

// What the loader now passes: declaredPromptSources decides, and for the judge
// it says no context files and no environment block.
const sources = declaredPromptSources(verifier, {
  includeContextFiles: DEFAULT_AGENT.includeContextFiles,
  systemPromptMode: DEFAULT_AGENT.systemPromptMode,
});
const asBuiltNow = buildAgentPrompt(
  verifier,
  proj,
  sources.includeEnvironment ? env : undefined,
  sources.includeContextFiles ? { contextFiles } : {},
  sources.systemPromptMode,
);
// What it used to be: the globals applied unconditionally.
const asBuiltBefore = buildAgentPrompt(verifier, proj, env, { contextFiles }, "replace");

console.log("\n=== 3. the judge's system prompt, built by the real builder ===");
console.log("  context files present on the path :", contextFiles.map((f) => f.path.replace(root, "…")).join(", "));
console.log("  declaredPromptSources says        :", JSON.stringify(sources));
console.log("  judge prompt, before the fix      :", asBuiltBefore.length, "chars");
console.log("  judge prompt, now                 :", asBuiltNow.length, "chars");
console.log("  removed                           :", asBuiltBefore.length - asBuiltNow.length, "chars per judge call");
for (const marker of ["MARKER-PROJECT-AGENTS-MD", "MARKER-ANCESTOR-CLAUDE-MD", "MARKER-GLOBAL-AGENTS-MD"]) {
  console.log(`  contains ${marker.padEnd(26)} : ${asBuiltNow.includes(marker)}  (before: ${asBuiltBefore.includes(marker)})`);
}
console.log("  the house rule about not simplifying :", asBuiltNow.includes("Never simplify what was asked for"),
  ` (before: ${asBuiltBefore.includes("Never simplify what was asked for")})`);
console.log("  the '# Environment' block            :", asBuiltNow.includes("# Environment"),
  ` (before: ${asBuiltBefore.includes("# Environment")})  <- S7: two git subprocesses per judge call`);

console.log("\n  the judge's whole system prompt now:");
console.log(asBuiltNow.split("\n").map((l) => "    " + l).join("\n"));

// ── 4. What that costs against the window the judge actually has ─────────────
const WINDOW_TOKENS = 32_768;
const CHARS_PER_TOKEN = 4;
console.log("\n=== 4. against a 32k window ===");
console.log(
  `  ~${Math.round((asBuiltBefore.length - asBuiltNow.length) / CHARS_PER_TOKEN)} tokens of project instructions returned to the judge, ` +
    `~${(((asBuiltBefore.length - asBuiltNow.length) / CHARS_PER_TOKEN / WINDOW_TOKENS) * 100).toFixed(1)}% of its window, ` +
    `on every verified delegation.`,
);

// ── 5. This checkout, today ──────────────────────────────────────────────────
const here = pi.loadProjectContextFiles({ cwd: REPO, agentDir: "/home/claudeuser/.pi/agent" });
console.log("\n=== 5. this checkout, right now ===");
console.log("  context files on the path from", REPO, ":", here.length === 0 ? "none" : here.map((f) => f.path).join(", "));
console.log(
  here.length === 0
    ? "  Nobody has written an AGENTS.md, so before the fix the leak was latent here —\n" +
      "  it would have become live the first time anyone did, silently."
    : "  Before the fix these were all in the judge's prompt.",
);
