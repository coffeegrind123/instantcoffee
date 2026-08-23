/**
 * AN7 — the one reader of pi's own directory that ignored pi's own override.
 *
 * `PI_CODING_AGENT_DIR` is pi's `ENV_AGENT_DIR`, and everything in this stack
 * honours it — pi's `getAgentDir()`, `scripts/pi-local.sh` in two places,
 * `vendor/prinny-channel/src/config.ts`, `server/src/state.ts` (with a comment
 * saying why), and `agents/verify-log.ts`. `pi-settings.ts` did not: it was a
 * bare `join(os.homedir(), ".pi", "agent", "settings.json")`.
 *
 * On a relocated install that reads a path pi does not write, finds nothing, and
 * returns `hideThinkingBlock: false` — so `conversation-viewer.ts` opens with
 * thinking blocks shown to an operator who turned them off.
 *
 * The rule now lives in `src/agent-dir.ts` and both modules ask it. These tests
 * are about the rule, about the two readers agreeing, and about the variable
 * NAME still being the one pi builds — that last one reads pi's installed
 * `dist/config.js`, because a rename upstream should be a failing test rather
 * than a silent divergence.
 */

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { ENV_AGENT_DIR, agentDir, agentDirFile } from "../src/agent-dir.ts";
import { getPiSettingsPath } from "../src/pi-settings.ts";
import { verifyLogFile } from "../src/agents/verify-log.ts";

const DEFAULT = join(homedir(), ".pi", "agent");

describe("agentDir", () => {
  it("defaults to ~/.pi/agent", () => {
    assert.equal(agentDir({}), DEFAULT);
  });

  it("honours the override", () => {
    assert.equal(agentDir({ [ENV_AGENT_DIR]: "/srv/pi" }), "/srv/pi");
  });

  it("treats an empty override as absent, exactly as pi does", () => {
    // An exported-but-empty variable is what a shell leaves behind when a
    // conditional export did not fire; it must not mean "the root directory".
    // pi's own guard is `if (envDir)`, so `""` is absent there too.
    assert.equal(agentDir({ [ENV_AGENT_DIR]: "" }), DEFAULT);
  });

  it("a whitespace-only override is a relative directory, because it is one to pi", () => {
    // AO7. This used to assert DEFAULT, on a `.trim() !== ""` guard that pi does
    // not have. It is the better rule and it is a DIFFERENT one, and a
    // different one is the whole failure this module exists to stop: pi would
    // write `settings.json` into a directory named with spaces and this reader
    // would look in `~/.pi/agent` and find nothing. Where the two disagree, pi
    // is right by definition — it is the one that writes the files.
    assert.equal(agentDir({ [ENV_AGENT_DIR]: "   " }), "   ");
  });

  it("expands a leading tilde, as pi's expandTildePath does", () => {
    assert.equal(agentDir({ [ENV_AGENT_DIR]: "~" }), homedir());
    assert.equal(agentDir({ [ENV_AGENT_DIR]: "~/elsewhere/agent" }), join(homedir(), "elsewhere", "agent"));
  });

  it("does not expand a tilde that is not a home reference", () => {
    assert.equal(agentDir({ [ENV_AGENT_DIR]: "/tmp/~backup" }), "/tmp/~backup");
  });

  it("agentDirFile joins", () => {
    assert.equal(agentDirFile("settings.json", { [ENV_AGENT_DIR]: "/srv/pi" }), "/srv/pi/settings.json");
  });
});

describe("AN7 — the two readers that must not diverge again", () => {
  it("pi-settings reads pi's settings.json under the override", () => {
    assert.equal(getPiSettingsPath({ [ENV_AGENT_DIR]: "/srv/pi" }), "/srv/pi/settings.json");
  });

  it("…and under the default", () => {
    assert.equal(getPiSettingsPath({}), join(DEFAULT, "settings.json"));
  });

  it("the verify log follows the same directory — the control", () => {
    assert.equal(verifyLogFile({ [ENV_AGENT_DIR]: "/srv/pi" }), "/srv/pi/subagent-verify.jsonl");
  });

  it("its own explicit file override still wins over the directory", () => {
    assert.equal(
      verifyLogFile({ [ENV_AGENT_DIR]: "/srv/pi", SUBAGENT_VERIFY_LOG_FILE: "/tmp/judge.jsonl" }),
      "/tmp/judge.jsonl",
    );
  });
});

describe("AN7 — the variable name is pi's", () => {
  const PI_CONFIG = "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/config.js";

  it("pi still builds ENV_AGENT_DIR as <APP>_CODING_AGENT_DIR", { skip: !existsSync(PI_CONFIG) }, () => {
    const source = readFileSync(PI_CONFIG, "utf8");
    assert.match(
      source,
      /ENV_AGENT_DIR = `\$\{APP_NAME\.toUpperCase\(\)\}_CODING_AGENT_DIR`/,
      "pi renamed its agent-dir variable; agent-dir.ts has to follow",
    );
    assert.match(
      source,
      /APP_NAME = piConfigName \|\| "pi"/,
      "…and the app name defaults to pi, which is what makes it PI_CODING_AGENT_DIR",
    );
    assert.match(source, /CONFIG_DIR_NAME = pkg\.piConfig\?\.configDir \|\| "\.pi"/, "…in ~/.pi");
  });
});

describe("AO7 — nobody else hardcodes the agent directory", () => {
  /**
   * The scan, not the third fix.
   *
   * AN7 found two readers of `~/.pi/agent` that disagreed, wrote `agent-dir.ts`
   * so the question has one answer, converted both, and did not look for a
   * third. `prompt/skill-loader.ts` was the third — `loadSkills({ agentDir:
   * join(homedir(), ".pi", "agent") })`, which is where a SUBAGENT's skills
   * come from. This test is what makes a fourth a failing test instead.
   */
  const SRC = new URL("../src/", import.meta.url);

  function sourceFiles(dir: URL): URL[] {
    const out: URL[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const child = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
      if (entry.isDirectory()) out.push(...sourceFiles(child));
      else if (entry.name.endsWith(".ts")) out.push(child);
    }
    return out;
  }

  it("no source but agent-dir.ts builds pi's agent directory itself", () => {
    // Comments are stripped first: several files describe the path in prose,
    // and prose is not a reader.
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const name = file.pathname.slice(file.pathname.indexOf("/src/") + 5);
      if (name === "agent-dir.ts") continue;
      const code = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      // `join(homedir(), ".pi", …)` in any spacing. Deliberately NOT a match on
      // the string `.pi/agent`: several menu descriptions name the directory in
      // prose the operator reads, and `<cwd>/.pi/agents` — the PROJECT agents
      // directory, which is a different thing — is built in four files and is
      // correct there.
      if (/homedir\(\)\s*,\s*["'`]\.pi["'`]/.test(code)) offenders.push(name);
    }
    assert.deepEqual(offenders, [], `these build the agent dir themselves; use agentDir() from src/agent-dir.ts`);
  });

  it("every reader of the override goes through agentDir()", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const name = file.pathname.slice(file.pathname.indexOf("/src/") + 5);
      if (name === "agent-dir.ts") continue;
      const code = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      if (code.includes("PI_CODING_AGENT_DIR")) offenders.push(name);
    }
    assert.deepEqual(offenders, [], "the variable name belongs to agent-dir.ts (ENV_AGENT_DIR)");
  });

  it("skill-loader's user root is the agent dir — the reader this scan was written for", () => {
    const code = readFileSync(new URL("prompt/skill-loader.ts", SRC), "utf8");
    assert.match(code, /agentDir\(\)/, "root 3 asks the shared rule");
    const call = code.slice(code.indexOf("const defaultsResult"), code.indexOf("const defaultsResult") + 300);
    assert.match(call, /agentDir: agentDir\(\)/, "…in the loadSkills call itself");
  });
});

/**
 * AO10 — the same rule in the other language, and the file that installs the
 * provider.
 *
 * This package's scan above holds the TypeScript side. The stack has a second
 * reader of the same fact in bash: `scripts/pi-local.sh` writes `models.json`
 * (the custom provider that points pi at forge) and `settings.json` into pi's
 * agent directory, and it asked where that is in FOUR places while answering two
 * ways — `PI_DIR` ignored the override; the prinny state path and the MCP
 * adapter path honoured it.
 *
 * Measured 2026-08-23, with the control run in the same minute:
 *
 * ```
 *   pi --list-models                              forge  qwen3.8-27b
 *   PI_CODING_AGENT_DIR=<dir> pi --list-models    (nothing)
 * ```
 *
 * Worse than the AN7/AO7 instances: those made a relocated install read an empty
 * directory and fall back to a default. This one left pi with **no provider for
 * the local model at all** — the one thing the launcher exists to arrange.
 *
 * The rule now lives once per language: `agentDir()` here, `agent_dir()` in
 * `scripts/lib.sh`. This pins that the shell one exists, is what the launcher
 * asks, and encodes the same three decisions — pi's bare truthiness guard, the
 * tilde expansion, and the `~/.pi/agent` default. Probe `ab10` drives both and
 * compares them value for value; this is the cheap half that fails on the edit.
 */
describe("AO10 — the launcher's copy of the rule", () => {
  const REPO = new URL("../../../", import.meta.url);
  const lib = readFileSync(new URL("scripts/lib.sh", REPO), "utf8");
  const launcher = readFileSync(new URL("scripts/pi-local.sh", REPO), "utf8");
  /** Comments in both files quote the defect on purpose. */
  const launcherCode = launcher.replace(/^\s*#.*$/gm, "");

  it("the shell helper exists — the control for every absence assertion below", () => {
    assert.match(lib, /^agent_dir\(\) \{/m, "scripts/lib.sh no longer defines agent_dir");
    assert.match(launcherCode, /source .*lib\.sh/, "the launcher no longer sources it");
    assert.ok(launcherCode.length > 1000, "the launcher slice is empty — the comment strip ate it");
  });

  it("the launcher asks in more than one place, so agreeing is not automatic", () => {
    const sites = (launcherCode.match(/\$\(agent_dir\)/g) ?? []).length;
    assert.ok(sites >= 3, `expected at least 3 sites through agent_dir, found ${sites}`);
  });

  it("no agent-directory path in the launcher is built from $HOME", () => {
    // The defect verbatim: `PI_DIR="${HOME}/.pi/agent"`.
    assert.doesNotMatch(launcherCode, /\$\{?HOME\}?\/\.pi\/agent/, "the pre-AO10 form is back");
  });

  it("and none reads the override inline instead of through the rule", () => {
    assert.doesNotMatch(launcherCode, /\$\{PI_CODING_AGENT_DIR:-/, "two spellings of one rule again");
  });

  it("the shell rule encodes the same three decisions this module does", () => {
    const body = lib.slice(lib.indexOf("agent_dir() {"), lib.indexOf("# --- json"));
    // pi's guard is bare truthiness, NOT a trim — a value of "  " is a relative
    // directory to pi and not `unset`. That is AO7, one language over.
    assert.match(body, /-n "\$override"/, "the guard");
    assert.doesNotMatch(body, /xargs|sed .*s\/\^\[|trim/, "a trim here would diverge from pi");
    assert.match(body, /"~"/, "the bare-tilde case pi's expandTildePath has");
    assert.match(body, /"~\/"\*/, "the ~/… case");
    assert.match(body, /\.pi\/agent/, "the default when the override is unset");
  });

  it("and the variable it reads is the one this module names", () => {
    assert.match(lib, new RegExp(`\\$\\{${ENV_AGENT_DIR}:-`), `the shell reads ${ENV_AGENT_DIR}`);
  });
});
