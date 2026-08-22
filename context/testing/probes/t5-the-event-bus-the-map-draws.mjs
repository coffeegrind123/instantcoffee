/**
 * t5 — AG4. The event-bus table in §1.D, checked against the handlers the five
 * packages actually register.
 *
 * The map is the artefact every one of these passes reasons from — §1.D is what
 * "loop FIRST, guard second" and "prinny FIRST, rtk SECOND" are read off, and
 * four findings across three passes turn on an ordering taken from it. It has
 * carried three phantom marks and one missing row since the eleventh pass
 * (`…-signals.md`), through five documents.
 *
 * This is a standing check rather than a one-off reproduction: it derives the
 * table from the source and diffs it against the table in the document, so the
 * next edit to either cannot drift.
 *
 *   run: node t5-the-event-bus-the-map-draws.mjs [path/to/document.md]
 */

import { readFileSync } from "node:fs";

const REPO = "/home/claudeuser/qwen3.8-forge";
const DOC = process.argv[2] ?? `${REPO}/context/design/subagents-loop-verifier-proxies.md`;

let failures = 0;
const check = (label, ok) => {
  console.log(`   ${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) failures++;
};

/**
 * Every package `scripts/pi-local.sh` loads, in that order, and where its
 * handlers live.
 *
 * Nineteenth pass (AJ5): there are SEVEN, not five. `.pi/extensions/stack.ts`
 * and `.pi/extensions/browser-guard.ts` occupy `-e` positions and were in
 * neither the table nor this list — so a handler registered by either was
 * invisible to the artefact AND to the check written to keep the artefact
 * honest. `browser-guard` registers one, on `tool_result`, in the FIRST position
 * of the process; the table's own §3.1 says "loop FIRST" about that event.
 *
 * The two additions are what makes the third check below (`every event some
 * package handles has a row`) able to see anything the map's own list left out.
 * A probe given the same list as the document it is checking can only ever
 * confirm the document's arithmetic.
 */
const PACKAGES = [
  { column: "stack", files: [`${REPO}/.pi/extensions/stack.ts`] },
  { column: "browser", files: [`${REPO}/.pi/extensions/browser-guard.ts`] },
  { column: "loop", files: [`${REPO}/vendor/pi-loop-mode/extensions/index.ts`] },
  { column: "guard", files: [`${REPO}/.pi/extensions/compaction-guard/index.ts`] },
  {
    column: "subag",
    // Every .ts under src/, because a handler registered anywhere in the package
    // counts — the point of the check is not to trust a single file.
    files: listSources(`${REPO}/vendor/pi-subagents-lite/src`),
  },
  { column: "prinny", files: [`${REPO}/vendor/prinny-channel/extensions/index.ts`] },
  { column: "rtk", files: [`${REPO}/vendor/rtk-pi/extensions/index.ts`] },
];

function listSources(dir) {
  const { readdirSync, statSync } = require$("node:fs");
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = `${d}/${name}`;
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".ts")) out.push(p);
    }
  };
  walk(dir);
  return out;
}
// `require` is not available in an .mjs module; the two calls above are the only
// synchronous directory reads this probe needs, so they come from node:fs directly.
function require$() {
  return fsModule;
}
import * as fsModule from "node:fs";

/**
 * Events a package registers a handler for, read out of its source.
 *
 * Comments are stripped first, and they have to be: every module in this stack
 * quotes its own wiring in prose, and `result-cap.ts`'s header contains the
 * literal string `pi.on("tool_result")` while the module registers nothing at
 * all. A scan that counted that would report a handler that does not exist,
 * which is the exact class of error this probe is about.
 */
function handlersOf(files) {
  const found = new Set();
  for (const file of files) {
    const src = readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    for (const m of src.matchAll(/\bpi\.on\(\s*["']([a-z_]+)["']/g)) found.add(m[1]);
  }
  return found;
}

const actual = new Map(PACKAGES.map((p) => [p.column, handlersOf(p.files)]));

console.log("\nt5 — the event bus, from the source\n");
for (const [column, events] of actual) {
  console.log(`   ${column.padEnd(7)} ${events.size} handler(s): ${[...events].sort().join(", ")}`);
}

// ── the same thing, read out of the document ────────────────────────────────
const doc = readFileSync(DOC, "utf8").split("\n");
// AJ5: the header may name any subset of the seven columns, in any order — an
// older document has five and this pass's has seven, and both are checkable.
// What is NOT optional is that a column exists for every package that registers
// something, which is the third check below.
const headerIndex = doc.findIndex((line) => /\bevent\b/.test(line) && /\bloop\b/.test(line) && /\bprinny\b/.test(line) && /\brtk\b/.test(line));
check(`the document has an event-bus table (${DOC.split("/").pop()})`, headerIndex >= 0);
if (headerIndex < 0) process.exit(1);

const header = doc[headerIndex];
const columns = Object.fromEntries(
  PACKAGES.map((p) => p.column).filter((c) => header.indexOf(c) >= 0).map((c) => [c, header.indexOf(c)]),
);
for (const { column } of PACKAGES) {
  const registers = actual.get(column).size > 0;
  if (registers && !(column in columns)) {
    console.log(`   FAIL  the table has no \`${column}\` column, and it registers ${
      [...actual.get(column)].sort().join(", ")}`);
    failures++;
  }
}
const claimed = new Map(Object.keys(columns).map((c) => [c, new Set()]));
const rows = [];
for (let i = headerIndex + 1; i < doc.length; i++) {
  const line = doc[i];
  if (/^\s*$/.test(line)) break;
  const name = line.trim().match(/^([a-z_]+)\b/)?.[1];
  if (!name) continue;
  rows.push(name);
  for (let col = 0; col < line.length; col++) {
    if (line[col] !== "✓") continue;
    const nearest = Object.keys(columns).reduce((a, b) =>
      Math.abs(columns[a] - col) <= Math.abs(columns[b] - col) ? a : b);
    claimed.get(nearest).add(name);
  }
}

console.log("\n   the document's table, and the diff:\n");
console.log("     package   event                 document   source");
let phantom = 0;
let missing = 0;
for (const column of Object.keys(columns)) {
  const said = claimed.get(column);
  const is = actual.get(column);
  for (const event of new Set([...said, ...is])) {
    const inDoc = said.has(event);
    const inSrc = is.has(event);
    if (inDoc === inSrc) continue;
    if (inDoc) phantom++;
    else missing++;
    console.log(
      `     ${column.padEnd(9)} ${event.padEnd(21)} ${(inDoc ? "✓" : "—").padEnd(10)} ${inSrc ? "✓" : "—"}`,
    );
  }
}
const missingRows = [...new Set([...actual.values()].flatMap((s) => [...s]))].filter((e) => !rows.includes(e));
for (const event of missingRows) console.log(`     (no row)  ${event.padEnd(21)} —          registered by ${
  [...actual].filter(([, s]) => s.has(event)).map(([c]) => c).join(", ")}`);

console.log("");
check("no handler the document draws is absent from the source", phantom === 0);
check("no handler the source registers is absent from the document", missing === 0);
check("every event some package handles has a row", missingRows.length === 0);

console.log(
  failures === 0
    ? `
     This document's table matches the source. Point the probe at an earlier
     one to see the drift:
       node ${process.argv[1].split("/").pop()} ../../design/subagents-loop-verifier-omissions.md
`
    : `
     The load order the four "decisive orderings" are read off is
     scripts/pi-local.sh's, and it is unchanged and correct. What is wrong is
     which packages are on which rows.
`,
);

console.log(failures > 0 ? `   ${failures} expectation(s) failed` : "   all expectations held");
process.exit(failures > 0 ? 1 : 0);
