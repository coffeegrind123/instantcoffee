/**
 * H3 probe — S5: does every section of a handoff summary survive every
 * compression level?
 *
 * The per-section budgets do not fit inside the total and never did: level 0 has
 * room for ~3.5k characters of body while its sections may claim 7,500. That is
 * fine on its own — a summary has to degrade somehow. What was not fine is that
 * it degraded by POSITION. `buildSummary()` assembled the whole body and then
 * did
 *
 *   const summary = body.slice(0, max(0, summaryChars - finalDirection.length)) + finalDirection
 *
 * so what fell off was whatever came last: `## File Operations` first, then
 * `## Durable Project Context` — the PROGRESS.md / GOAL.md excerpts, i.e. the
 * state that actually crosses the handoff — and at level 2 `## Loop State` too.
 * The levels that cut hardest are only reached after a recovery that did not
 * free enough room, which is when the summary matters most.
 *
 * `.pi/extensions/compaction-guard/src/summary-budget.ts` exists because pi's
 * own summary had exactly this failure; its header says a blind slice "keeps
 * `## Goal` while cutting exactly the two sections that carry the work forward".
 * The loop's own builder now allocates by priority instead, with a floor per
 * section, and lets the durable-file excerpts absorb the shortfall — they are
 * the one section that is also on disk, and the Next Step block already tells
 * the model to read those files.
 *
 * Run: node --experimental-strip-types h3-handoff-budget-overrun.mjs
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = "/home/claudeuser/qwen3.8-forge";
const recovery = await import(`${REPO}/vendor/pi-loop-mode/src/context-recovery.ts`);
const { defaultState } = await import(`${REPO}/vendor/pi-loop-mode/src/loop-state.ts`);

// A realistic long-run loop state and a realistic PROGRESS.md on disk.
const cwd = mkdtempSync(join(tmpdir(), "h3-handoff-"));
writeFileSync(
  join(cwd, "PROGRESS.md"),
  "# Progress\n" + Array.from({ length: 40 }, (_, i) => `- step ${i + 1}: done, see src/file${i}.ts`).join("\n"),
  "utf8",
);
writeFileSync(join(cwd, "GOAL.md"), "# Goal\n" + "The full specification of the objective. ".repeat(40), "utf8");

const state = {
  ...defaultState(),
  active: true,
  description:
    "Port the legacy importer to the new pipeline, keeping the CSV, TSV and JSONL front ends working, " +
    "and make the streaming path handle files larger than memory. " .repeat(6),
  completionCriteria: "npm test passes and the 2GB fixture imports in under 90 seconds. ".repeat(6),
  iterationCount: 137,
  status: "retrying",
  lastNotice: "Context pressure 2/3: empty response at 91% context (no text, no thinking, no tool call). ".repeat(4),
  goalFile: "GOAL.md",
};

const preparation = {
  firstKeptEntryId: "entry-fallback",
  tokensBefore: 30_000,
  fileOps: {
    read: new Set(Array.from({ length: 30 }, (_, i) => `src/read${i}.ts`)),
    written: new Set(["src/importer.ts", "src/stream.ts"]),
    edited: new Set(["src/pipeline.ts"]),
  },
};

const SECTIONS = [
  "## Goal",
  "## Completion Criteria",
  "## Loop State",
  "## Durable Project Context",
  "## File Operations",
  "## Next Step",
];

function report(label, build) {
  console.log(`\n=== ${label} ===`);
  for (let level = 0; level <= recovery.MAX_COMPRESSION_LEVEL; level++) {
    const result = build(level);
    const present = SECTIONS.filter((s) => result.summary.includes(s));
    const missing = SECTIONS.filter((s) => !result.summary.includes(s));
    console.log(
      `level ${level}: summary ${String(result.summary.length).padStart(5)} chars` +
        `  kept [${present.map((s) => s.replace("## ", "")).join(", ")}]`,
    );
    if (missing.length) {
      console.log(`          DROPPED [${missing.map((s) => s.replace("## ", "")).join(", ")}]`);
    }
    const goalLine = result.summary.split("\n")[1] ?? "";
    console.log(`          goal text ends: …${JSON.stringify(goalLine.slice(-60))}`);
  }
}

console.log("=== H3: what survives a handoff / emergency summary at each compression level ===");
console.log("(level rises after a recovery that did not free enough room — i.e. exactly when it matters most)");

report("HANDOFF (small window: every compaction on a <=64k window)", (level) =>
  recovery.buildHandoffCompaction(state, preparation, cwd, [], level),
);

report("EMERGENCY (overflow recovery)", (level) =>
  recovery.buildEmergencyCompaction(state, preparation, cwd, level),
);

console.log(`
The handoff ladder is the one in use on this stack: HANDOFF_MAX_WINDOW_TOKENS is
65,536 and the window here is 32,768, so EVERY compaction in a loop session takes
the handoff path.

BEFORE the fix, the blind slice() dropped sections off the END of the body:
  level 0 -> DROPPED [File Operations]
  level 1 -> DROPPED [File Operations]
  level 2 -> DROPPED [Loop State, Durable Project Context, File Operations]
The direction block is appended after the slice, so "## Next Step" always
survived; everything between the goal and it did not.

Sections are now allocated by priority (SECTION_PRIORITY) with a floor each, and
the durable-file excerpts — the only section that is also sitting on disk, and
which the Next Step block already tells the model to read — absorb whatever the
others leave.
`);

// ── Where the boundary actually is, so this is not just a worst case ──────────
console.log("=== the arithmetic, level by level ===");
// HANDOFF_DIRECTIONS, one per level — the long form was 469 chars of a
// 1,000-char summary at level 2, which is half the budget spent explaining what
// a handoff is.
const DIRECTION_CHARS = [372, 227, 118];
const LADDER = [
  { level: 0, total: 4000, goal: 1500, criteria: 800, notice: 400, excerpt: 1200 },
  { level: 1, total: 2000, goal: 800, criteria: 400, notice: 200, excerpt: 400 },
  { level: 2, total: 1000, goal: 600, criteria: 300, notice: 120, excerpt: 0 },
];
for (const l of LADDER) {
  // Four durable files are looked for: GOAL.md, PROGRESS.md, IMPROVEMENTS.md, ASSUMPTIONS.md.
  const sectionsMax = l.goal + l.criteria + l.notice + l.excerpt * 4;
  const room = l.total - DIRECTION_CHARS[l.level];
  console.log(
    `level ${l.level}: room for the body ${String(room).padStart(4)}   ` +
      `sections may claim up to ${String(sectionsMax).padStart(5)} (goal ${l.goal} + criteria ${l.criteria} + notice ${l.notice} + 4×excerpt ${l.excerpt})` +
      `   ${sectionsMax > room ? "OVER by " + (sectionsMax - room) + " -> the excerpts absorb it" : "fits"}`,
  );
}

// ── Where the boundary is, walked rather than asserted ───────────────────────
//
// The four durable files the summary looks for are GOAL.md, PROGRESS.md,
// IMPROVEMENTS.md and ASSUMPTIONS.md — and the loop's own rules tell the model
// to write to every one of them ("record state in PROGRESS.md", "update the
// IMPROVEMENTS.md backlog", "document it in ASSUMPTIONS.md"). So they grow with
// the run, and the run is what this summary has to survive.
const small = {
  ...defaultState(),
  active: true,
  description: "Make the importer stream large files.",
  completionCriteria: "npm test passes.",
  iterationCount: 12,
  goalFile: "GOAL.md",
  lastNotice: "",
};
const smallPrep = {
  firstKeptEntryId: "e",
  tokensBefore: 30_000,
  fileOps: { read: new Set(["src/a.ts", "src/b.ts"]), written: new Set(["src/c.ts"]), edited: new Set() },
};

console.log("\n=== level 0 as the durable files grow (a modest goal throughout) ===");
writeFileSync(join(cwd, "GOAL.md"), "# Goal\nMake the importer stream.\n", "utf8");
for (const perFile of [200, 600, 1_000, 1_400, 2_000, 4_000]) {
  for (const name of ["PROGRESS.md", "IMPROVEMENTS.md", "ASSUMPTIONS.md"]) {
    writeFileSync(join(cwd, name), `# ${name}\n` + "- a line about src/a.ts\n".repeat(Math.ceil(perFile / 24)), "utf8");
  }
  const r = recovery.buildHandoffCompaction(small, smallPrep, cwd, [], 0);
  const missing = SECTIONS.filter((s) => !r.summary.includes(s)).map((s) => s.replace("## ", ""));
  console.log(
    `each durable file ~${String(perFile).padStart(4)} chars -> summary ${String(r.summary.length).padStart(4)}` +
      `  ${missing.length ? "DROPPED [" + missing.join(", ") + "]" : "all sections kept"}`,
  );
}

console.log(`
So level 0 is not broken on day one — a short run with small durable files fits.
It breaks as the run gets longer, which is the only kind of run that reaches many
handoffs, and it breaks silently: the operator sees "handing off to a fresh
context (N% used, 4000-char summary)" whether or not the file excerpts survived.

Levels 1 and 2 cannot fit their own sections at any size (see the arithmetic
above), and those are the levels reached after a recovery that did not free
enough room.`);
