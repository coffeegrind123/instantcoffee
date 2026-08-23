/**
 * ab5 — AO5, the suite that was green about a program not in the tree.
 *
 * MEASURED ON THIS BOX, and the BEFORE column is a reading rather than a
 * reconstruction: it is what `stagedState()` said about the staged runtime at
 * the moment this finding was written, quoted below, next to what it says now.
 *
 * `vendor/prinny-channel/tests/harness.ts` imports the sidecar's COMPILED
 * output, and says why:
 *
 *   > the tests run against the compiled output, which has the side benefit of
 *   > testing the artifact that actually ships rather than a re-compile of it.
 *
 * True while the staged artifact IS this checkout's source. Nothing asked.
 * AN2 (twenty-third pass) built `stagedState()` — `current | stale | absent` —
 * because four readers were answering that question with
 * `existsSync(dist/server.js)`. The harness was the fifth, and it is the one
 * whose wrong answer is silent: a stale runtime does not fail a suite, it
 * PASSES it.
 *
 * What was on this box when the finding was written:
 *
 * ```
 *   .source-stamp                     f297f2b6f673ac38…
 *   fingerprint of server/src         94b4a2f9753bd76c…
 *   stagedState()                     stale
 *   dist/                             access history inbox mentions permissions
 *                                     queue server state stdout-guard
 *                                     — no connect.js at all
 *   vendor/prinny-channel  npm test   511 tests, 511 pass
 * ```
 *
 * 116 of those suites drove `loadServerModule`, i.e. a build of sources that
 * could not be produced from this checkout — AL3's connect-loop fix was not in
 * it, and neither was anything else since 2026-08-22.
 *
 *   run: node --experimental-strip-types ab5-the-program-the-suite-was-testing.mjs [live|stale|absent]
 */

import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const REPO = "/home/claudeuser/qwen3.8-forge";
const PKG = `${REPO}/vendor/prinny-channel`;
const PAYLOAD_ROOT = `${PKG}/server`;
const { sourceFingerprint, stagedState, readStamp } = await import(`${PAYLOAD_ROOT}/bin/runtime-stamp.mjs`);
const { assertRuntimeMatchesSource } = await import(`${PKG}/tests/harness.ts`);
const { stateDir } = await import(`${PAYLOAD_ROOT}/bin/agent-dir.mjs`);

/** What the harness used to ask. */
const beforeQuestion = (runtime) => {
  try {
    readdirSync(join(runtime, "dist"));
    return "built";
  } catch {
    return "not built";
  }
};

const MODES = { live: {}, stale: {}, absent: {} };
const MODE = process.argv[2] ?? "live";
if (!MODES[MODE]) {
  console.error(`usage: node ab5-…mjs <${Object.keys(MODES).join("|")}>`);
  process.exit(2);
}

let failures = 0;
const check = (label, ok) => {
  console.log(`   ${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) failures++;
};

console.log(`\nab5 [${MODE}] — which program the suite was testing (AO5)\n`);

if (MODE === "live") {
  const runtime = process.env.PRINNY_RUNTIME_DIR ?? join(stateDir(), "runtime");
  const fingerprint = sourceFingerprint(PAYLOAD_ROOT);
  const state = stagedState(runtime, PAYLOAD_ROOT, fingerprint);
  let files = [];
  try {
    files = readdirSync(join(runtime, "dist"));
  } catch {
    files = [];
  }
  console.log(`   runtime            ${runtime}`);
  console.log(`   .source-stamp      ${readStamp(runtime) ?? "(none)"}`);
  console.log(`   server/src hashes  ${fingerprint}`);
  console.log(`   dist/              ${files.join(" ") || "(none)"}`);
  console.log("");
  console.log(`   BEFORE  the harness asked "is there a dist?"    → ${beforeQuestion(runtime)}`);
  console.log(`   NOW     it asks stagedState()                  → ${state}\n`);
  check("the staged runtime is the sources in this tree", state === "current");
  check("…and the harness would let the suite run", (() => { try { assertRuntimeMatchesSource(); return true; } catch { return false; } })());
  check("connect.js is staged — AL3's fix is compiled in for the first time", files.includes("connect.js"));
} else {
  // A fabricated runtime that the old question calls "built".
  const runtime = mkdtempSync(join(tmpdir(), `ab5-${MODE}-`));
  try {
    mkdirSync(join(runtime, "dist"), { recursive: true });
    // `absent` is decided by the ENTRY (`dist/server.js`), so the two modes
    // differ in what is missing: a stamp for other sources, or the entry itself
    // with a dist directory that still looks built to the old question.
    const names = MODE === "stale" ? ["state.js", "server.js", "queue.js"] : ["state.js", "queue.js"];
    for (const name of names) writeFileSync(join(runtime, "dist", name), "\n");
    if (MODE === "stale") writeFileSync(join(runtime, ".source-stamp"), "f".repeat(64));

    const state = stagedState(runtime, PAYLOAD_ROOT, sourceFingerprint(PAYLOAD_ROOT));
    let threw;
    try {
      assertRuntimeMatchesSource(runtime, PAYLOAD_ROOT);
      threw = undefined;
    } catch (err) {
      threw = err.message;
    }
    console.log(`   a runtime with a dist and ${MODE === "stale" ? "a stamp for other sources" : "no compiled entry"}\n`);
    console.log(`   BEFORE  "is there a dist?"   → ${beforeQuestion(runtime)}   ← the suite runs, and passes`);
    console.log(`   NOW     stagedState()        → ${state}`);
    console.log(`           the harness          → ${threw ? "refuses" : "runs"}\n`);
    if (threw) console.log(`   ${threw.split("\n").join("\n   ")}\n`);
    check(`stagedState calls it ${MODE}`, state === MODE);
    check("BEFORE the suite would have run against it", beforeQuestion(runtime) === "built");
    check("NOW the suite refuses", typeof threw === "string");
    check("…and the sentence names the command that fixes it", (threw ?? "").includes("--prepare"));
  } finally {
    rmSync(runtime, { recursive: true, force: true });
  }
}

console.log("");
process.exit(failures === 0 ? 0 : 1);
