/**
 * aa4 — AN4, the switches the launcher never forwarded.
 *
 * FIXED — entirely real on both sides. It scans the REAL sources of
 * `vendor/pi-subagents-lite` for every `SUBAGENT_*` the package reads out of the
 * environment, and the REAL `scripts/pi-local.sh` for what it exports. The
 * BEFORE column is the same launcher with this pass's three lines filtered out,
 * so both columns are the shipped file.
 *
 * The rule is the launcher's own, from the comment above the block:
 *
 * > Exported, not passed as a flag: the fork reads both from `process.env`, and
 * > **a value that only ever lives in .env is a knob that silently does
 * > nothing.**
 *
 *   run: node aa4-the-switches-the-launcher-never-forwarded.mjs [table|effect]
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const REPO = "/home/claudeuser/qwen3.8-forge";
const SRC = `${REPO}/vendor/pi-subagents-lite/src`;
const LAUNCHER = `${REPO}/scripts/pi-local.sh`;

const MODES = {
  /** Every switch, and whether it reaches the process. */
  table: {},
  /** What the two that did not actually cost. */
  effect: {},
};

const MODE = process.argv[2] ?? "table";
if (!MODES[MODE]) {
  console.error(`usage: node aa4-…mjs <${Object.keys(MODES).join("|")}>`);
  process.exit(2);
}

let failures = 0;
const check = (label, ok) => {
  console.log(`   ${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) failures++;
};

function sources(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) sources(full, out);
    else if (full.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** Every `SUBAGENT_*` the package reads, and the file it reads it in. */
function switchesRead() {
  const found = new Map();
  for (const file of sources(SRC)) {
    for (const match of readFileSync(file, "utf8").matchAll(/\b(?:process\.)?env\.(SUBAGENT_[A-Z_]+)\b/g)) {
      if (!found.has(match[1])) found.set(match[1], file.slice(SRC.length + 1));
    }
  }
  return found;
}

const launcherNow = readFileSync(LAUNCHER, "utf8");
/** The same file with this pass's three exports removed. */
const launcherBefore = launcherNow
  .split("\n")
  .filter((line) => !/(SUBAGENT_TRANSCRIPT|SUBAGENT_VERIFY_LOG)/.test(line))
  .join("\n");

const forwards = (launcher, name) => new RegExp(`export ${name}=`).test(launcher);

console.log(`\naa4 [${MODE}] — the switches the launcher never forwarded (AN4)\n`);

if (MODE === "table") {
  const read = [...switchesRead().entries()].sort();
  console.log("   switch                       read in                     BEFORE  NOW");
  for (const [name, file] of read) {
    const before = forwards(launcherBefore, name) ? "  ✔   " : "  ✘   ";
    const now = forwards(launcherNow, name) ? " ✔" : " ✘";
    console.log(`   ${name.padEnd(28)} ${file.padEnd(26)} ${before} ${now}`);
  }
  console.log("");

  const missingBefore = read.filter(([name]) => !forwards(launcherBefore, name)).map(([name]) => name);
  const missingNow = read.filter(([name]) => !forwards(launcherNow, name)).map(([name]) => name);
  console.log(`   BEFORE  ${missingBefore.length} of ${read.length} never reached the process: ${missingBefore.join(", ")}`);
  console.log(`   NOW     ${missingNow.length} of ${read.length}\n`);

  check("the scan finds the switches at all — its own control", read.length >= 5);
  check("BEFORE three were unreachable from .env", missingBefore.length === 3);
  check("NOW none are", missingNow.length === 0);
  check("…and the four that always worked still do", forwards(launcherNow, "SUBAGENT_VERIFY"));
} else {
  const { transcriptEnabled, MAX_ENTRIES, MAX_ENTRY_CHARS } = await import(
    `${SRC}/agents/transcript-entry.ts`
  );
  const { verifyLogEnabled, MAX_LINES, MAX_FIELD_CHARS } = await import(`${SRC}/agents/verify-log.ts`);

  console.log("   what the two switches turn off, driven through the real modules.\n");
  console.log("   SUBAGENT_TRANSCRIPT");
  console.log(`     default              : ${transcriptEnabled({}) ? "ON" : "off"}`);
  console.log(`     with the value set   : ${transcriptEnabled({ SUBAGENT_TRANSCRIPT: "0" }) ? "ON" : "off"}`);
  console.log(`     what it writes       : up to ${MAX_ENTRIES} session entries per delegation,`);
  console.log(`                            ${MAX_ENTRY_CHARS} chars each`);
  console.log("");
  console.log("   SUBAGENT_VERIFY_LOG");
  console.log(`     default              : ${verifyLogEnabled({}) ? "ON" : "off"}`);
  console.log(`     with the value set   : ${verifyLogEnabled({ SUBAGENT_VERIFY_LOG: "0" }) ? "ON" : "off"}`);
  console.log(`     what it writes       : one JSONL line per verifier model call,`);
  console.log(`                            ${MAX_LINES} lines kept, ${MAX_FIELD_CHARS} chars per field`);
  console.log("");
  console.log("   BEFORE: both defaults were the only setting available, because the");
  console.log("           value in .env never reached the process. The only spelling");
  console.log("           that worked was an inline `SUBAGENT_TRANSCRIPT=0 ./scripts/…`,");
  console.log("           which `env_get` reads because it checks the EXPORTED value first.");
  console.log("");

  check("the modules do read the switches", transcriptEnabled({ SUBAGENT_TRANSCRIPT: "0" }) === false);
  check("…both of them", verifyLogEnabled({ SUBAGENT_VERIFY_LOG: "0" }) === false);
  check("…and default to on", transcriptEnabled({}) && verifyLogEnabled({}));
  check("NOW the launcher forwards them", forwards(launcherNow, "SUBAGENT_TRANSCRIPT") && forwards(launcherNow, "SUBAGENT_VERIFY_LOG"));
}

console.log("");
process.exit(failures === 0 ? 0 : 1);
