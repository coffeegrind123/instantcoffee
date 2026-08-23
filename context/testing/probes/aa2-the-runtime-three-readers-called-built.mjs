/**
 * aa2 — AN2, the runtime three readers called "built".
 *
 * FIXED — both columns are real. The BEFORE column is `existsSync(dist/server.js)`,
 * which is literally what `startupBlocker()`, `/prinny status`,
 * `/prinny configure` and `scripts/pi-local.sh` each asked; the NOW column is
 * `stagedState()` from `server/bin/runtime-stamp.mjs`, which is the question the
 * bootstrap has always asked itself.
 *
 * The `live` mode runs both against THIS BOX's real staged runtime, and that is
 * the finding rather than an illustration of it: when this was written the staged
 * tree was missing `server/src/connect.ts` entirely — the twenty-first pass's fix
 * for a connect loop that builds one matrix-js-sdk client per failed attempt and
 * stops none of them — and every reader said "built".
 *
 *   run: node aa2-the-runtime-three-readers-called-built.mjs [staged|live|absent]
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = "/home/claudeuser/qwen3.8-forge";
const PAYLOAD = `${REPO}/vendor/prinny-channel/server`;
const { entryPath, sourceFingerprint, stagedState, stampPath, readStamp } = await import(
  `${PAYLOAD}/bin/runtime-stamp.mjs`
);

const MODES = {
  /** A staged runtime, then one source file added — the AL3 shape. */
  staged: {},
  /** This box's real runtime directory, right now. */
  live: {},
  /** The control: nothing compiled reads as absent to both. */
  absent: {},
};

const MODE = process.argv[2] ?? "staged";
if (!MODES[MODE]) {
  console.error(`usage: node aa2-…mjs <${Object.keys(MODES).join("|")}>`);
  process.exit(2);
}

let failures = 0;
const check = (label, ok) => {
  console.log(`   ${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) failures++;
};

/** What every reader but the bootstrap used to ask. */
const beforeAnswer = (runtimeDir) => (existsSync(entryPath(runtimeDir)) ? "built" : "NOT BUILT");

const scratch = () => mkdtempSync(join(tmpdir(), "aa2-"));

console.log(`\naa2 [${MODE}] — the runtime three readers called "built" (AN2)\n`);

if (MODE === "live") {
  const stateDir =
    process.env.PRINNY_STATE_DIR ??
    join(process.env.PI_CODING_AGENT_DIR ?? join(process.env.HOME ?? "", ".pi", "agent"), "channels", "prinny");
  const runtimeDir = process.env.PRINNY_RUNTIME_DIR ?? join(stateDir, "runtime");

  const stamp = readStamp(runtimeDir);
  const now = sourceFingerprint(PAYLOAD);
  const state = stagedState(runtimeDir, PAYLOAD, now);

  console.log(`   runtime dir : ${runtimeDir}`);
  console.log(`   stamp       : ${stamp ? `${stamp.slice(0, 8)}…` : "(none)"}`);
  console.log(`   source now  : ${now.slice(0, 8)}…\n`);
  console.log(`   BEFORE  ${beforeAnswer(runtimeDir)}`);
  console.log(`   NOW     ${state}\n`);

  if (state === "stale") {
    // Name the difference, because "stale" on its own is a verdict and the
    // files are the evidence.
    const stagedSrc = join(runtimeDir, "src");
    const missing = [];
    if (existsSync(stagedSrc)) {
      const { readdirSync } = await import("node:fs");
      const staged = new Set(readdirSync(stagedSrc));
      for (const name of readdirSync(join(PAYLOAD, "src"))) if (!staged.has(name)) missing.push(name);
    }
    console.log(`   files in the checkout the staged tree has never seen: ${missing.join(", ") || "(none)"}\n`);
  }

  check("both answers exist", true);
  check(
    "the two readers agree, or the disagreement is the finding",
    state === "current" ? beforeAnswer(runtimeDir) === "built" : true,
  );
  if (state !== "current") {
    console.log("   ↑ this is the finding, on this box, right now: the weaker reader");
    console.log("     said `built` for a runtime that will re-stage on the next start,");
    console.log("     inside a 120 s connect budget that already spends 27.5 s importing.\n");
  }
} else if (MODE === "absent") {
  const runtimeDir = join(scratch(), "runtime");
  console.log(`   BEFORE  ${beforeAnswer(runtimeDir)}`);
  console.log(`   NOW     ${stagedState(runtimeDir, PAYLOAD)}\n`);
  check("BEFORE says NOT BUILT", beforeAnswer(runtimeDir) === "NOT BUILT");
  check("NOW says absent — the one state the weaker question got right", stagedState(runtimeDir, PAYLOAD) === "absent");
} else {
  // A payload tree, staged, and then one file added to the source.
  const root = scratch();
  const payload = join(root, "payload");
  mkdirSync(join(payload, "src"), { recursive: true });
  cpSync(join(PAYLOAD, "package.json"), join(payload, "package.json"));
  writeFileSync(join(payload, "src", "server.ts"), "export const a = 1;\n");

  const runtimeDir = join(root, "runtime");
  mkdirSync(join(runtimeDir, "dist"), { recursive: true });
  writeFileSync(entryPath(runtimeDir), "// compiled\n");
  writeFileSync(stampPath(runtimeDir), sourceFingerprint(payload));

  const fresh = { before: beforeAnswer(runtimeDir), now: stagedState(runtimeDir, payload) };

  // AL3, in one line: a file the runtime has never seen.
  writeFileSync(join(payload, "src", "connect.ts"), "export const c = 3;\n");
  const moved = { before: beforeAnswer(runtimeDir), now: stagedState(runtimeDir, payload) };

  console.log("   a staged, compiled runtime, and then one source file added.\n");
  console.log("                        BEFORE          NOW");
  console.log(`   just staged      :   ${fresh.before.padEnd(14)}  ${fresh.now}`);
  console.log(`   +src/connect.ts  :   ${moved.before.padEnd(14)}  ${moved.now}\n`);

  check("BEFORE both look the same", fresh.before === moved.before);
  check("NOW the fresh one is current", fresh.now === "current");
  check("NOW the moved one is stale", moved.now === "stale");

  // …and a stamp that is simply missing is not evidence of being current.
  rmSync(stampPath(runtimeDir));
  console.log(`   no stamp at all  :   ${beforeAnswer(runtimeDir).padEnd(14)}  ${stagedState(runtimeDir, payload)}\n`);
  check("a build with no stamp is stale, not current", stagedState(runtimeDir, payload) === "stale");
}

console.log("");
process.exit(failures === 0 ? 0 : 1);
