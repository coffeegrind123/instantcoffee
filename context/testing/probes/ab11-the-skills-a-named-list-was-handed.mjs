/**
 * ab11 — AO7. Which skills a subagent that NAMES its skills is handed, on a
 * relocated install.
 *
 * FIXED — and this probe exists because for two sessions the fix was held by
 * three source-text assertions and a hand test that could not fail.
 *
 * AO7 changed root 3 of `prompt/skill-loader.ts`'s `loadAllSkills` from a
 * hardcoded `join(homedir(), ".pi", "agent")` to `agentDir()`, so a relocated
 * install (`PI_CODING_AGENT_DIR`) loads a child's named skills from the
 * directory pi actually uses. `tests/agent-dir.test.ts` pins it with three
 * assertions that READ THE SOURCE — `agentDir()` appears, no file builds the
 * path itself, nobody else names the variable. Every one of them would still
 * pass if `loadAllSkills` asked `agentDir()` and then threw the answer away.
 *
 * Nothing drove the function. §AI.7 of the testing write-up was supposed to be
 * the behavioural half by hand, and its FIRST recipe measured nothing at all —
 * see "the door" below.
 *
 * ## The control, and the one that matters
 *
 * Run with root 3 put back to the hardcoded join — the literal defect:
 *
 * ```
 *   ab11   preload FAIL   meta FAIL   reach FAIL   equivalence ok   live ok
 *   suite  516 tests, 2 failed        ← the source scan does catch THAT spelling
 * ```
 *
 * `equivalence` and `live` passing is correct, not a gap: neither goes through
 * the call. `live` is this box, where the override is unset and the two answers
 * are identical — the same shape as `ab8`'s `physical` mode, and the same
 * sentence: *this is why nobody noticed.*
 *
 * Now the control that says why this file had to exist. Leave the
 * `agentDir: agentDir()` call **exactly as shipped** and set
 * `includeDefaults: false` instead — root 3 is gone, the right value is computed
 * and discarded, and the defect is worse than the original:
 *
 * ```
 *   suite  516 tests, 0 failed        ← every scan assertion still matches
 *   ab11   preload FAIL   meta FAIL   reach FAIL
 * ```
 *
 * **A test that reads the source cannot tell a call from a use.** Both controls
 * were run on 2026-08-23 and the tree was restored and re-verified after each.
 *
 * ## Both columns are the shipped function, with one input changed
 *
 * There is no monkeypatch here and no reimplementation. `agentDir()`'s whole
 * contract is:
 *
 * ```js
 *   const override = env[ENV_AGENT_DIR];
 *   if (override) return expandTilde(override);
 *   return join(homedir(), ".pi", "agent");     // ← the pre-AO7 expression
 * ```
 *
 * So with `PI_CODING_AGENT_DIR` unset, `agentDir()` returns the exact expression
 * root 3 used to hold, character for character — and the `equivalence` mode
 * asserts that rather than assuming it. The BEFORE column is therefore the real
 * `loadAllSkills` computing the real old path, not a stand-in for it.
 *
 * ## Why a sandbox HOME, and not just "is it found"
 *
 * A presence/absence pair proves too little: "not found" is what a typo looks
 * like too. So both directories exist and both hold a skill, with different
 * names, and the probe asserts BOTH directions in BOTH columns:
 *
 * ```
 *   $HOME/.pi/agent/skills/home-marker/SKILL.md          the operator's old dir
 *   $PI_CODING_AGENT_DIR/skills/relocated-marker/…       where pi actually reads
 *
 *   NOW      relocated-marker  FOUND        home-marker  not found
 *   BEFORE   relocated-marker  not found    home-marker  FOUND     ← the defect
 * ```
 *
 * BEFORE does not merely fail to find the right skill. It finds the WRONG one,
 * silently, and hands the child a skill the operator moved away from.
 *
 * ## The door — the correction §AI.7 walked into
 *
 * §11.7 used to call `skill-loader.ts` *"the one that decides which skills a
 * SUBAGENT is given"*. It is narrower than that, and the difference is why the
 * first hand-test recipe produced the same answer in both columns:
 *
 * ```
 *   ordinary discovery   agent-runner.ts:544  DefaultResourceLoader
 *                        { agentDir: getAgentDir() }    ← pi's own, honours it
 *   this module          preloadSkills / loadSkillMeta
 *                        reached ONLY from buildPrompt, and only when the
 *                        agent's frontmatter NAMES its skills
 * ```
 *
 * A default `general-purpose` child never reaches this code — `reach` mode
 * asserts that from the shipped `DEFAULT_AGENTS`, which is why nothing noticed
 * for as long as it did.
 *
 * ## The two entry points differ in what the child can see
 *
 * `preload_skills:` puts the skill's CONTENT in the system prompt, so the defect
 * is legible to the child. `skills:` puts only name + description, and the NAME
 * is echoed back either way — a child asked to list its skills answers the same
 * in both columns and only the description differs. That is the trap §AI.7's
 * second recipe was written around, and `meta` mode prints it so nobody rebuilds
 * the same broken instrument a third time.
 *
 *   run: node ab11-the-skills-a-named-list-was-handed.mjs [preload|meta|reach|equivalence|live]
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";

const PI = "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
const jiti = createJiti(`file://${PI}`, { interopDefault: true, alias: { "@earendil-works/pi-coding-agent": PI } });
const R = "/home/claudeuser/qwen3.8-forge/vendor/pi-subagents-lite/src";

const { preloadSkills, loadSkillMeta, loadAllSkills } = await jiti.import(`${R}/prompt/skill-loader.ts`);
const { agentDir, ENV_AGENT_DIR } = await jiti.import(`${R}/agent-dir.ts`);
const { DEFAULT_AGENTS } = await jiti.import(`${R}/agents/default-agents.ts`);

const MODES = {
  /** `preload_skills:` — the child is handed the skill's content, or a sentence saying it does not exist. */
  preload: {},
  /** `skills:` — name and description only, and why the name is not evidence. */
  meta: {},
  /** Which agents reach this module at all. */
  reach: {},
  /** That the BEFORE column really is the expression AO7 removed. */
  equivalence: {},
  /** This box, as it is configured right now. */
  live: {},
};
const MODE = process.argv[2] ?? "preload";
if (!MODES[MODE]) {
  console.error(`usage: node ab11-…mjs <${Object.keys(MODES).join("|")}>`);
  process.exit(2);
}

let failures = 0;
const check = (label, ok) => {
  console.log(`   ${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) failures++;
};

const NOT_FOUND = (name) => `(Skill "${name}" not found in .pi/skills/, .agents/skills/, or global skill locations)`;

/**
 * Two agent directories, both real, both populated, with different skills in
 * them — and a cwd with nothing, so roots 1, 2 and 4 of `loadAllSkills` cannot
 * supply either name and root 3 is the only door.
 */
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "ab11-home-"));
  const relocated = mkdtempSync(join(tmpdir(), "ab11-agentdir-"));
  const cwd = mkdtempSync(join(tmpdir(), "ab11-cwd-"));

  const skill = (root, name, body) => {
    const dir = join(root, "skills", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${body}\n---\n\nBODY-OF-${name.toUpperCase()}\n`,
    );
    return join(dir, "SKILL.md");
  };

  const homePath = skill(join(home, ".pi", "agent"), "home-marker", "The directory the operator moved away from.");
  const relocatedPath = skill(relocated, "relocated-marker", "The directory pi actually reads.");
  return { home, relocated, cwd, homePath, relocatedPath };
}

/**
 * Run `fn` with the environment of one column.
 *
 * NOW sets the override; BEFORE unsets it, which is what makes `agentDir()`
 * return the pre-AO7 expression. `HOME` is redirected in both, because
 * `os.homedir()` reads `process.env.HOME` on POSIX and the BEFORE column has to
 * land in the sandbox rather than in the operator's real directory.
 */
function inColumn(column, fx, fn) {
  const savedHome = process.env.HOME;
  const savedDir = process.env[ENV_AGENT_DIR];
  process.env.HOME = fx.home;
  if (column === "NOW") process.env[ENV_AGENT_DIR] = fx.relocated;
  else delete process.env[ENV_AGENT_DIR];
  try {
    return fn();
  } finally {
    process.env.HOME = savedHome;
    if (savedDir === undefined) delete process.env[ENV_AGENT_DIR];
    else process.env[ENV_AGENT_DIR] = savedDir;
  }
}

console.log(`\nab11 — the skills a named list was handed  [${MODE}]\n`);

// ── preload — `preload_skills:`, where the child can see the difference ──────
if (MODE === "preload") {
  const fx = fixture();
  console.log(`   HOME                    : ${fx.home}`);
  console.log(`   ${ENV_AGENT_DIR}  : ${fx.relocated}`);
  console.log(`   cwd                     : ${fx.cwd}   (empty — roots 1, 2, 4 supply nothing)`);
  console.log("");

  const names = ["relocated-marker", "home-marker"];
  const columns = {};
  for (const column of ["NOW", "BEFORE"]) {
    const loaded = inColumn(column, fx, () => preloadSkills(names, fx.cwd));
    columns[column] = Object.fromEntries(loaded.map((s) => [s.name, s.content]));
    const dir = inColumn(column, fx, () => agentDir());
    console.log(`   ${column.padEnd(6)}  root 3 = ${dir}`);
    for (const n of names) {
      const content = columns[column][n];
      const found = !content.startsWith("(Skill ");
      console.log(`           ${n.padEnd(17)} ${found ? `FOUND     ${JSON.stringify(content.trim().split("\n").pop())}` : "not found"}`);
    }
    console.log("");
  }

  check("NOW: the relocated skill is found", !columns.NOW["relocated-marker"].startsWith("(Skill "));
  check("NOW: and its CONTENT reaches the child", columns.NOW["relocated-marker"].includes("BODY-OF-RELOCATED-MARKER"));
  check("NOW: the old directory's skill is not", columns.NOW["home-marker"] === NOT_FOUND("home-marker"));

  check("BEFORE: the relocated skill was invisible", columns.BEFORE["relocated-marker"] === NOT_FOUND("relocated-marker"));
  check(
    "BEFORE: and the WRONG skill was handed over instead — silently",
    columns.BEFORE["home-marker"].includes("BODY-OF-HOME-MARKER"),
  );
  // The control for both absence claims: each name IS findable, by the same
  // call, in the column where its directory is the one root 3 names. Neither
  // "not found" can mean "the fixture was never written".
  check(
    "control: each skill is found in exactly one column, so neither absence is a typo",
    !columns.NOW["relocated-marker"].startsWith("(Skill ") && !columns.BEFORE["home-marker"].startsWith("(Skill "),
  );
}

// ── meta — `skills:`, and the trap in reading the name back ──────────────────
if (MODE === "meta") {
  const fx = fixture();
  const columns = {};
  for (const column of ["NOW", "BEFORE"]) {
    const metas = inColumn(column, fx, () => loadSkillMeta(["relocated-marker"], fx.cwd));
    columns[column] = metas[0];
    console.log(`   ${column.padEnd(6)}  name        : ${JSON.stringify(metas[0].name)}`);
    console.log(`           description : ${JSON.stringify(metas[0].description)}`);
    console.log(`           location    : ${JSON.stringify(metas[0].location)}`);
    console.log("");
  }

  check("NOW: the description is the skill's own", columns.NOW.description === "The directory pi actually reads.");
  check("NOW: and the location is the relocated file", columns.NOW.location === fx.relocatedPath);
  check('BEFORE: the description was `(Skill "…" not found)`', columns.BEFORE.description === '(Skill "relocated-marker" not found)');
  check("BEFORE: and there was no file behind it", columns.BEFORE.location === "");

  console.log("");
  console.log("   The trap, stated: `skills:` echoes the NAME either way.");
  check(
    "the two columns agree on the name — so a child asked to LIST its skills cannot tell them apart",
    columns.NOW.name === columns.BEFORE.name,
  );
  console.log("   That is why §AI.7's first recipe measured nothing. Use `preload_skills:`");
  console.log("   and ask for the CONTENT, which is what `preload` mode above drives.\n");
}

// ── reach — who goes through this module at all ──────────────────────────────
if (MODE === "reach") {
  // Not a source scan: the shipped default's own declarations, read off the map
  // the extension registers.
  const gp = DEFAULT_AGENTS.get("general-purpose");
  console.log(`   general-purpose.skills        : ${JSON.stringify(gp.skills ?? null)}`);
  console.log(`   general-purpose.preloadSkills : ${JSON.stringify(gp.preloadSkills ?? null)}`);
  console.log("");
  console.log("   buildPrompt (agent-runner.ts) gates both calls on Array.isArray:");
  console.log("     Array.isArray(agentConfig?.preloadSkills)  → preloadSkills(…)");
  console.log("     Array.isArray(declaredResources(…).skills) → loadSkillMeta(…)");
  console.log("");
  check("general-purpose declares no skills LIST, so loadSkillMeta is not called for it", !Array.isArray(gp.skills));
  check("…and no preload list, so preloadSkills is not either", !Array.isArray(gp.preloadSkills));

  // The global default that fills an undeclared `skills` is `true` or `false`,
  // never a list — so nothing turns general-purpose into an array behind its
  // back. Explore is the second shipped default and answers the same way.
  const explore = DEFAULT_AGENTS.get("Explore");
  check("Explore, the other shipped default, likewise", !Array.isArray(explore.skills) && !Array.isArray(explore.preloadSkills));

  // The control: the gate is real, i.e. an agent that DOES declare a list is
  // routed through this module. Driven, not asserted about.
  const fx = fixture();
  const named = inColumn("NOW", fx, () => preloadSkills(["relocated-marker"], fx.cwd));
  check(
    "control: an agent that NAMES a skill does reach this module, and gets the file",
    named[0].content.includes("BODY-OF-RELOCATED-MARKER"),
  );
  console.log("");
  console.log("   So the blast radius is: an agent whose frontmatter names its skills,");
  console.log("   on a relocated install. Not every child — which is the correction");
  console.log("   §AI.7 made to §11.7 by trying to measure it.\n");
}

// ── equivalence — that BEFORE is the expression AO7 removed ──────────────────
if (MODE === "equivalence") {
  const sandbox = mkdtempSync(join(tmpdir(), "ab11-equiv-"));
  const savedHome = process.env.HOME;
  const savedDir = process.env[ENV_AGENT_DIR];
  try {
    process.env.HOME = sandbox;
    delete process.env[ENV_AGENT_DIR];
    const viaRule = agentDir();
    const preAO7 = join(homedir(), ".pi", "agent");
    console.log(`   HOME                                  : ${sandbox}`);
    console.log(`   agentDir() with the override unset    : ${viaRule}`);
    console.log(`   join(homedir(), ".pi", "agent")       : ${preAO7}   ← root 3, pre-AO7`);
    console.log("");
    check("the BEFORE column IS the removed expression, not a stand-in for it", viaRule === preAO7);

    process.env[ENV_AGENT_DIR] = join(sandbox, "elsewhere");
    console.log(`   agentDir() with the override set      : ${agentDir()}`);
    check("…and with it set they differ, so the column really is switched", agentDir() !== preAO7);
  } finally {
    process.env.HOME = savedHome;
    if (savedDir === undefined) delete process.env[ENV_AGENT_DIR];
    else process.env[ENV_AGENT_DIR] = savedDir;
  }
}

// ── live — this box ──────────────────────────────────────────────────────────
if (MODE === "live") {
  const override = process.env[ENV_AGENT_DIR];
  console.log(`   ${ENV_AGENT_DIR} : ${override === undefined ? "(unset)" : JSON.stringify(override)}`);
  console.log(`   root 3 resolves to    : ${agentDir()}`);
  const skills = loadAllSkills(process.cwd());
  console.log(`   skills visible to a named list, from ${process.cwd()}: ${skills.length}`);
  for (const s of skills.slice(0, 12)) console.log(`      ${s.name.padEnd(24)} ${s.filePath}`);
  if (skills.length > 12) console.log(`      … and ${skills.length - 12} more`);
  console.log("");
  check("root 3 is the directory pi reads on this box", agentDir() === (override || join(homedir(), ".pi", "agent")));
  check("loadAllSkills answers without throwing on a real tree", Array.isArray(skills));
}

console.log("");
if (failures) {
  console.log(`   ${failures} FAILED\n`);
  process.exit(1);
}
console.log("   all checks passed\n");
