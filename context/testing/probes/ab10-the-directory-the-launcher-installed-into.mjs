/**
 * ab10 — AO10. The launcher asked where pi's agent directory is in four places
 * and answered it two ways.
 *
 * FIXED — both columns are real, and the NOW column runs the shipped script.
 *
 * `PI_CODING_AGENT_DIR` is pi's `ENV_AGENT_DIR`. `scripts/pi-local.sh` honoured
 * it for the prinny state path and the MCP adapter path, and did NOT honour it
 * for `PI_DIR` — which is where it writes `models.json` (the custom provider
 * that points pi at forge) and `settings.json` (the compaction budget). So on a
 * relocated install the launcher installed the provider into a directory pi does
 * not read.
 *
 * **Measured on this box before the fix, with a control:**
 *
 * ```
 *   pi --list-models                                     forge  qwen3.8-27b
 *   PI_CODING_AGENT_DIR=<dir> pi --list-models           (nothing)
 * ```
 *
 * The negative is only worth having because the control ran in the same minute:
 * the same command, same box, override unset, finds `forge`. Without that,
 * "no forge" would be indistinguishable from a broken invocation.
 *
 * That is worse than the AN7/AO7 instances this fix follows: those made a
 * relocated install read an empty directory and carry on with a default. This
 * one leaves pi with no provider for the local model at all, which is the single
 * thing the script exists to arrange.
 *
 * ## The sentence that was wrong in three places
 *
 * `aa7`'s header, `vendor/pi-subagents-lite/src/agent-dir.ts`'s header, and §11.7
 * of the identity write-up all say some form of *"`scripts/pi-local.sh` honours
 * `PI_CODING_AGENT_DIR` in two places"*. True, and incomplete: it also ignored it
 * in two, in the same file, and one of those two is the one that matters. Three
 * readers of one fact, and the fact was a partial count nobody had recounted.
 *
 *   run: node ab10-the-directory-the-launcher-installed-into.mjs [relocated|rule|sites|live]
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, existsSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const REPO = "/home/claudeuser/qwen3.8-forge";
const LIB = `${REPO}/scripts/lib.sh`;
const LAUNCHER = `${REPO}/scripts/pi-local.sh`;
const { agentDir, ENV_AGENT_DIR } = await import(`${REPO}/vendor/pi-subagents-lite/src/agent-dir.ts`);

const MODES = {
  /** The shipped launcher, run for real, with the override set. */
  relocated: {},
  /** The bash rule against the TypeScript one, value for value. */
  rule: {},
  /** Every site in the launcher that names the agent directory. */
  sites: {},
  /** What this box answers, both languages. */
  live: {},
};
const MODE = process.argv[2] ?? "relocated";
if (!MODES[MODE]) {
  console.error(`usage: node ab10-…mjs <${Object.keys(MODES).join("|")}>`);
  process.exit(2);
}

let failures = 0;
const check = (label, ok) => {
  console.log(`   ${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) failures++;
};

/**
 * The NOW column: `agent_dir` from the shipped lib.sh.
 *
 * A sentinel rather than `.trim()`, and it is not fussiness: one of the cases
 * below is the value `"  "`, which pi treats as a relative directory and not as
 * "unset" (AO7). Trimming the shell's answer turns that case into the empty
 * string before it is compared, so the harness reports a disagreement the code
 * does not have — a measurement destroying the value it was taking. Found by
 * this probe failing on exactly that case.
 */
const shellAgentDir = (env) => {
  const out = execFileSync("bash", ["-c", `source ${LIB} >/dev/null 2>&1; agent_dir; printf "@@"`], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return out.slice(0, out.lastIndexOf("@@"));
};

/** The BEFORE column: the expression `pi-local.sh` used to hold, verbatim. */
const shellBefore = (env) =>
  execFileSync("bash", ["-c", 'printf "%s" "${HOME}/.pi/agent"'], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });

console.log(`\nab10 — where the launcher installs pi's provider  [${MODE}]\n`);

// ── relocated — the shipped script, run for real ─────────────────────────────
if (MODE === "relocated") {
  const sandboxHome = mkdtempSync(join(tmpdir(), "ab10-home-"));
  const relocated = mkdtempSync(join(tmpdir(), "ab10-agentdir-"));
  mkdirSync(join(sandboxHome, ".pi", "agent"), { recursive: true });

  const env = { HOME: sandboxHome, [ENV_AGENT_DIR]: relocated };

  console.log(`   HOME                    : ${sandboxHome}`);
  console.log(`   ${ENV_AGENT_DIR}  : ${relocated}`);
  console.log("");
  console.log(`   BEFORE  PI_DIR would be : ${shellBefore(env)}`);
  console.log(`   NOW     PI_DIR is       : ${shellAgentDir(env)}`);
  console.log("");

  check("BEFORE: the override was ignored — PI_DIR fell back to $HOME", shellBefore(env) === join(sandboxHome, ".pi", "agent"));
  check("NOW: PI_DIR is the directory pi will read", shellAgentDir(env) === relocated);

  // And the script itself, for real. --install-only writes models.json and stops.
  let ran = true;
  try {
    execFileSync("bash", [LAUNCHER, "--install-only"], {
      encoding: "utf8",
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    });
  } catch (error) {
    ran = false;
    console.log(`   the launcher did not complete: ${String(error).slice(0, 200)}`);
  }

  const landedRelocated = existsSync(join(relocated, "models.json"));
  const landedHome = existsSync(join(sandboxHome, ".pi", "agent", "models.json"));
  console.log(`   models.json in ${ENV_AGENT_DIR}   : ${landedRelocated}`);
  console.log(`   models.json in $HOME/.pi/agent     : ${landedHome}   ← BEFORE it was here`);
  console.log("");
  check("the shipped launcher completed", ran);
  check("NOW: it installed the provider where pi reads it", landedRelocated);
  check("NOW: and not into the directory pi is not using", !landedHome);

  if (landedRelocated) {
    const models = JSON.parse(readFileSync(join(relocated, "models.json"), "utf8"));
    const names = Object.keys(models.providers ?? models ?? {});
    console.log(`   providers written                  : ${names.join(", ")}`);
    check("the provider it installed is `forge`", names.includes("forge"));
  }
}

// ── rule — the two languages, value for value ────────────────────────────────
if (MODE === "rule") {
  const home = homedir();
  const cases = [
    [undefined, join(home, ".pi", "agent"), "unset — the control, where the two always agreed"],
    ["/srv/pi", "/srv/pi", "an absolute path"],
    ["~", home, "a bare tilde, which pi expands"],
    ["~/pi-work", join(home, "pi-work"), "a tilde path"],
    ["/tmp/~backup", "/tmp/~backup", "a tilde that is not a home reference — left alone"],
    ["  ", "  ", "two spaces: a RELATIVE directory to pi, not `unset` (AO7)"],
  ];
  let agreed = 0;
  for (const [value, expected, why] of cases) {
    const env = value === undefined ? { [ENV_AGENT_DIR]: "" } : { [ENV_AGENT_DIR]: value };
    // An empty string is falsy to pi, which is what "unset" means to both.
    const ts = agentDir(value === undefined ? {} : { [ENV_AGENT_DIR]: value });
    const sh = shellAgentDir(env);
    const ok = ts === expected && sh === expected;
    if (ok) agreed++;
    console.log(`   ${JSON.stringify(value ?? null).padEnd(14)} ts=${JSON.stringify(ts).padEnd(28)} sh=${JSON.stringify(sh).padEnd(28)} ${why}`);
    check(`both languages agree: ${why}`, ok);
  }
  console.log("");
  check("every case agrees, which is the whole point of writing it twice", agreed === cases.length);
}

// ── sites — one answer in the shipped launcher ───────────────────────────────
if (MODE === "sites") {
  const source = readFileSync(LAUNCHER, "utf8");
  const code = source.replace(/^\s*#.*$/gm, "");

  const viaHelper = [...code.matchAll(/\$\(agent_dir\)/g)].length;
  // The defect's written form: an agent-directory PATH built from $HOME, or the
  // env var read inline instead of through the helper.
  const literal = [...code.matchAll(/\$\{?HOME\}?\/\.pi\/agent/g)].map((m) => m[0]);
  const inlineEnv = [...code.matchAll(/\$\{PI_CODING_AGENT_DIR:-[^}]*\}/g)].map((m) => m[0]);

  console.log(`   sites going through agent_dir      : ${viaHelper}`);
  console.log(`   agent-dir paths built from $HOME   : ${literal.length}  ${literal.join(" ")}`);
  console.log(`   PI_CODING_AGENT_DIR read inline    : ${inlineEnv.length}  ${inlineEnv.join(" ")}`);
  console.log("");
  check("the launcher asks in more than one place — so agreement is not free", viaHelper >= 3);
  check("NOW: no agent-directory path is built from $HOME", literal.length === 0);
  check("NOW: and none reads the override inline instead of through the rule", inlineEnv.length === 0);
  // The control for those two absence assertions: the helper really is defined
  // and really is what answers, so "none found" cannot mean "nothing looked".
  check("control: the helper exists in lib.sh", /^agent_dir\(\) \{/m.test(readFileSync(LIB, "utf8")));
  check("control: and the launcher sources lib.sh", /source .*lib\.sh/.test(code));
}

// ── live — this box ──────────────────────────────────────────────────────────
if (MODE === "live") {
  const override = process.env[ENV_AGENT_DIR];
  console.log(`   ${ENV_AGENT_DIR} on this box : ${override === undefined ? "(unset)" : JSON.stringify(override)}`);
  console.log(`   bash        agent_dir              : ${shellAgentDir({})}`);
  console.log(`   typescript  agentDir()             : ${agentDir()}`);
  console.log("");
  check("the two languages answer the same on this box", shellAgentDir({}) === agentDir());
  const dir = agentDir();
  for (const f of ["models.json", "settings.json"]) {
    const there = existsSync(join(dir, f));
    console.log(`   ${f.padEnd(14)} present          : ${there}`);
    check(`${f} is where both readers say it is`, there);
  }
}

console.log("");
if (failures) {
  console.log(`   ${failures} FAILED\n`);
  process.exit(1);
}
console.log("   all checks passed\n");
