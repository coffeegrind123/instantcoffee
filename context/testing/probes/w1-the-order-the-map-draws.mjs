/**
 * w1 — AJ4. Which handler runs FIRST, from the launcher, against what the map says.
 *
 * `t5` derives WHICH events each package handles and diffs that against the
 * table in a document. It has passed for four passes. What it does not derive is
 * the ORDER, and §3.1 of every document since the sixteenth pass is four
 * sentences about exactly that — "loop FIRST", "prinny FIRST, then rtk, then
 * subagents" — with a ✔ beside each one.
 *
 * Three of the four are right. The fourth had `pi-subagents-lite` LAST, and it
 * runs FIRST: `scripts/pi-local.sh` passes `-e` in the order
 *
 *     stack · browser-guard · pi-loop-mode · compaction-guard ·
 *     pi-subagents-lite · prinny-channel · rtk-pi
 *
 * and pi loads them in that order (`loadExtensionsInternal` is a sequential
 * `for … await loadExtension(…)`, and `mergePaths(cliEnabled, discovered)` puts
 * the `-e` list ahead of anything auto-discovered), then dispatches
 * `for (const ext of this.extensions)` in the same order. So the safety property
 * §3.1 states — *"a blocked call never reaches rtk's rewrite or the subagent
 * model injection"* — is true of the first half and false of the second: the
 * subagent listener has already written `_resolvedAgent`, `model` and `thinking`
 * onto the input by the time prinny can block anything.
 *
 * Nothing is damaged by that today. What is damaged is the next decision made by
 * reading it, which is how §3.1 came to exist at all: **four findings across
 * three passes turned on an ordering taken from this map.**
 *
 * ## What this checks, and how far it can be trusted
 *
 * The ORDER half is exact — it is read out of the launcher and the sources. The
 * DOCUMENT half is a heuristic over prose: it takes the §3.1 block for an event
 * and reads the package names in the order they first appear. That is enough to
 * catch a sentence that names them backwards, and not enough to grade a
 * paragraph. A mismatch prints both orders and leaves the verdict to a reader,
 * which is the same contract `t5` has.
 *
 *   run: node w1-the-order-the-map-draws.mjs [path/to/document.md]
 */

import { readFileSync, readdirSync, statSync } from "node:fs";

const REPO = "/home/claudeuser/qwen3.8-forge";
const DOC = process.argv[2] ?? `${REPO}/context/design/subagents-loop-verifier-proxies.md`;

let failures = 0;
const check = (label, ok) => {
  console.log(`   ${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) failures++;
};

/**
 * Every package that can register a handler, keyed by the column name the
 * documents use, with the `-e` path the launcher would pass for it.
 *
 * Two of these are not in `t5`'s table at all and belong here anyway:
 * `.pi/extensions/stack.ts` and `browser-guard.ts` occupy load-order positions,
 * so a claim about "who runs first" that leaves them out is a claim about a
 * different list. Both register no event handlers today, which is a fact this
 * probe should be the thing that notices if it changes.
 */
const PACKAGES = [
  { column: "stack", entry: `${REPO}/.pi/extensions/stack.ts`, sources: [`${REPO}/.pi/extensions/stack.ts`] },
  { column: "browser", entry: `${REPO}/.pi/extensions/browser-guard.ts`, sources: [`${REPO}/.pi/extensions/browser-guard.ts`] },
  { column: "loop", entry: `${REPO}/vendor/pi-loop-mode/extensions/index.ts`, sources: [`${REPO}/vendor/pi-loop-mode/extensions/index.ts`] },
  { column: "guard", entry: `${REPO}/.pi/extensions/compaction-guard/index.ts`, sources: [`${REPO}/.pi/extensions/compaction-guard/index.ts`] },
  { column: "subag", entry: `${REPO}/vendor/pi-subagents-lite/src/index.ts`, sources: listSources(`${REPO}/vendor/pi-subagents-lite/src`) },
  { column: "prinny", entry: `${REPO}/vendor/prinny-channel/extensions/index.ts`, sources: [`${REPO}/vendor/prinny-channel/extensions/index.ts`] },
  { column: "rtk", entry: `${REPO}/vendor/rtk-pi/extensions/index.ts`, sources: [`${REPO}/vendor/rtk-pi/extensions/index.ts`] },
];

function listSources(dir) {
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

/** Strip comments first: every module here quotes its own wiring in prose. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function handlersOf(files) {
  const found = new Set();
  for (const file of files) {
    for (const m of stripComments(readFileSync(file, "utf8")).matchAll(/\bpi\.on\(\s*["']([a-z_]+)["']/g)) {
      found.add(m[1]);
    }
  }
  return found;
}

// ── 1. the load order, out of the launcher ──────────────────────────────────
const launcher = readFileSync(`${REPO}/scripts/pi-local.sh`, "utf8");
const flagOrder = [...launcher.matchAll(/pi_flags\+=\(-e\s+"([^"]+)"\)/g)].map((m) => m[1]);

console.log("\nw1 — the order the map draws\n");
console.log("   scripts/pi-local.sh passes -e in this order:\n");
const resolved = [];
for (const raw of flagOrder) {
  const expanded = raw
    .replace(/\$\{?REPO_ROOT\}?/g, REPO)
    .replace(/\$\{?LOOP_DIR\}?/g, `${REPO}/vendor/pi-loop-mode`)
    .replace(/\$\{?GUARD_DIR\}?/g, `${REPO}/.pi/extensions/compaction-guard`)
    .replace(/\$\{?GUARD_EXT\}?/g, `${REPO}/.pi/extensions/browser-guard.ts`)
    .replace(/\$\{?STACK_EXT\}?/g, `${REPO}/.pi/extensions/stack.ts`)
    .replace(/\$\{?SUBAGENTS_DIR\}?/g, `${REPO}/vendor/pi-subagents-lite`)
    .replace(/\$\{?PRINNY_DIR\}?/g, `${REPO}/vendor/prinny-channel`)
    .replace(/\$\{?RTK_DIR\}?/g, `${REPO}/vendor/rtk-pi`);
  const hit = PACKAGES.find((p) => p.entry === expanded);
  console.log(`     ${(hit?.column ?? "?").padEnd(9)} ${expanded.replace(REPO + "/", "")}`);
  if (hit) resolved.push(hit);
}
check("every -e path maps to a known package", resolved.length === flagOrder.length);

// pi's own two rules, both read out of its source rather than assumed:
//   resource-loader.js  `mergePaths(cliEnabledExtensions, enabledExtensions)`
//                       — the -e list first, auto-discovery after, deduped
//   loader.js           `for (const extPath of paths) await loadExtension(…)`
//                       — sequential, so an async factory still finishes before
//                         the next one starts (rtk's is async)
//   runner.js           `emit`: `for (const ext of this.extensions)`
const PI_LOADER = "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/core";
const loaderSrc = readFileSync(`${PI_LOADER}/extensions/loader.js`, "utf8");
const resourceSrc = readFileSync(`${PI_LOADER}/resource-loader.js`, "utf8");
check(
  "pi puts the -e list ahead of auto-discovery (mergePaths(cli, enabled))",
  /mergePaths\(cliEnabledExtensions, enabledExtensions\)/.test(resourceSrc),
);
check(
  "pi loads them sequentially, so an async factory keeps its place",
  /for \(const extPath of paths\) \{\s*const \{ extension, error \} = await loadExtension/.test(
    loaderSrc.replace(/\n\s*/g, "\n"),
  ) || /await loadExtension\(extPath/.test(loaderSrc),
);

// ── 2. who handles what, in that order ──────────────────────────────────────
const byEvent = new Map();
for (const pkg of resolved) {
  for (const event of handlersOf(pkg.sources)) {
    if (!byEvent.has(event)) byEvent.set(event, []);
    byEvent.get(event).push(pkg.column);
  }
}

const multi = [...byEvent.entries()].filter(([, cols]) => cols.length > 1).sort();
console.log("\n   events with more than one handler, in the order they run:\n");
for (const [event, cols] of multi) {
  console.log(`     ${event.padEnd(24)} ${cols.join("  →  ")}`);
}
const single = [...byEvent.entries()].filter(([, cols]) => cols.length === 1).sort();
console.log(`\n   (${single.length} event(s) with a single handler: ${single.map(([e]) => e).join(", ")})`);

// ── 3. the same thing, read out of the document ─────────────────────────────
const ALIASES = [
  ["subag", /\bsub-?agents?\b|\bsubag\b|pi-subagents-lite/i],
  ["prinny", /\bprinny\b/i],
  ["rtk", /\brtk\b/i],
  ["loop", /\bloop\b|pi-loop-mode/i],
  ["guard", /\bguard\b|compaction-guard/i],
  ["stack", /\bstack\.ts\b/i],
  ["browser", /\bbrowser(?:-guard)?\b/i],
];

function claimedOrder(block) {
  // First occurrence wins, so "loop FIRST … the guard's cap runs after. The loop
  // also strips…" reads as [loop, guard] rather than [loop, guard, loop].
  const hits = [];
  for (let i = 0; i < block.length; i++) {
    for (const [column, pattern] of ALIASES) {
      if (hits.includes(column)) continue;
      const window = block.slice(i, i + 24);
      if (pattern.test(window) && pattern.exec(window).index === 0) hits.push(column);
    }
  }
  return hits;
}

const doc = readFileSync(DOC, "utf8");
const docName = DOC.split("/").pop();
console.log("");
check(`the document has an ordering section (${docName})`, /orderings? that decide/i.test(doc));

// Only the ordering section, and only its first fenced block: the event-bus
// TABLE a few lines above has rows that start the same way, and reading a ✓
// column as an ordering claim would be this probe making the map's own mistake.
const allLines = doc.split("\n");
const sectionAt = allLines.findIndex((line) => /orderings? that decide/i.test(line));
const fenceStart = allLines.findIndex((line, i) => i > sectionAt && /^```/.test(line));
const fenceEnd = allLines.findIndex((line, i) => i > fenceStart && /^```/.test(line));
check("…and the section has a block to read", sectionAt >= 0 && fenceStart > 0 && fenceEnd > fenceStart);
const lines = fenceEnd > fenceStart ? allLines.slice(fenceStart + 1, fenceEnd) : [];

// Each claim is the run of lines from an event name at the start of an indented
// line up to the next one (or the end of the fence).
const starts = [];
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(/^\s{2,}([a-z_]+)\s{2,}\S/);
  if (m && byEvent.has(m[1])) starts.push([m[1], i]);
}

let compared = 0;
for (const [event, cols] of multi) {
  const at = starts.find(([name]) => name === event);
  if (!at) {
    check(`§3.1 says something about \`${event}\``, false);
    continue;
  }
  const next = starts.find(([, i]) => i > at[1]);
  const block = lines.slice(at[1], next ? next[1] : lines.length).join(" ");
  const claimed = claimedOrder(block).filter((c) => cols.includes(c));
  compared++;
  const ok = claimed.join(">") === cols.join(">");
  check(`\`${event}\`: the document says ${claimed.join(" → ") || "(nothing readable)"}`, ok);
  if (!ok) {
    console.log(`         source says   ${cols.join("  →  ")}`);
    console.log(`         document says ${claimed.join("  →  ") || "(nothing readable)"}`);
  }
}
check("every multi-handler event was compared", compared === multi.length);

console.log(`
   The order is read out of scripts/pi-local.sh and pi 0.84.2's own loader, not
   out of a document — which is the point. Point this at an earlier write-up to
   see the drift:

     node w1-the-order-the-map-draws.mjs ../../design/subagents-loop-verifier-promises.md
`);

if (failures > 0) {
  console.log(`   ${failures} expectation(s) failed`);
  process.exit(1);
}
console.log("   all expectations held");
process.exit(0);
