/**
 * I8 probe — U7 (**FIXED**): the subagent denylist reasons about `vendor/`, and
 * what a child actually discovers is `.pi/extensions/`. `stack.ts` now carries
 * the same factory guard the two vendored packages use, and
 * `pi-subagents-lite/tests/subagent-denylist.test.ts` carries the standing check
 * for the class.
 *
 * A subagent does not inherit the parent's `-e` flags. It builds its own
 * `DefaultResourceLoader`, which DISCOVERS extensions — so `vendor/` is absent
 * unless `subagentExtraExtensionPaths()` names it, and everything under
 * `.pi/extensions/` reaches the child for free. `subagent-denylist.ts` says so
 * itself, and cites a live run: compaction-guard was observed capping the
 * CHILD's own `read` result at 9,778 → 8,176 chars inside the child session.
 * That is the measurement this probe rests on — the directory is known to reach
 * a child, because one of its members was watched working there.
 *
 * The denylist's whole ledger is about `vendor/`: prinny is denied, rtk is added
 * back, pi-loop-mode was added back and then removed, and the removal is priced
 * — "the `loop` tool costs a child ~177 tokens of schema on every turn, which is
 * the child's window".
 *
 * Nothing priced the directory the child reads on its own. This does.
 *
 *   node --experimental-strip-types i8-what-a-child-discovers.mjs
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { REPO } from "./_host.mjs";

const EXT_DIR = join(REPO, ".pi", "extensions");

/** Chars per token, the convention used throughout this stack's measurements. */
const CHARS_PER_TOKEN = 4;

function entryPoints(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      for (const candidate of ["index.ts", "index.js"]) {
        try { statSync(join(full, candidate)); out.push([name, join(full, candidate)]); break; } catch {}
      }
    } else if (name.endsWith(".ts")) {
      out.push([name.replace(/\.ts$/, ""), full]);
    }
  }
  return out;
}

console.log("=== I8 · what a subagent picks up from .pi/extensions/ ===\n");
console.log(
  "  " + "extension".padEnd(18) + "| registers a tool? | guards itself? | wanted in a child?",
);
console.log("  " + "-".repeat(18) + "+-------------------+----------------+-------------------");

const WANTED = {
  "compaction-guard": "yes: bounds the CHILD's own output",
  "browser-guard": "harmless — hooks only",
  stack: "no — and now inert there",
};

for (const [name, file] of entryPoints(EXT_DIR)) {
  const source = readFileSync(file, "utf8");
  const registers = /pi\.registerTool\s*\(/.test(source);
  const guarded = source.includes("__PI_SUBAGENT_SPAWN_DEPTH__");
  console.log(
    "  " + name.padEnd(18) +
    "| " + (registers ? "YES" : "no").padEnd(17) +
    " | " + (guarded ? "yes" : registers ? "NO" : "n/a").padEnd(14) +
    " | " + (WANTED[name] ?? "?"),
  );
}

// The stack_status schema, read out of the file rather than restated.
const stackSource = readFileSync(join(EXT_DIR, "stack.ts"), "utf8");
const block = stackSource.slice(stackSource.indexOf('name: "stack_status"'));
// The literals are read out of the file between one key and the next, so the
// numbers below are the file's, not a copy of it that can drift.
const between = (from, to) => {
  const start = block.indexOf(`${from}:`);
  const end = block.indexOf(`${to}:`, start);
  if (start < 0 || end < 0) return "";
  const region = block.slice(start + from.length + 1, end);
  return (region.match(/"(?:[^"\\]|\\.)*"/g) ?? []).map((s) => JSON.parse(s)).join("");
};
const description = between("description", "promptSnippet");
const promptSnippet = between("promptSnippet", "promptGuidelines");
const promptGuidelines = between("promptGuidelines", "parameters");

const wire = JSON.stringify({
  name: "stack_status",
  description,
  input_schema: { type: "object", properties: {} },
});
const total = wire.length + promptSnippet.length + promptGuidelines.length;

console.log("\n  What stack_status costs a child, per turn:\n");
console.log("    tool JSON on the wire  :", String(wire.length).padStart(5), "chars");
console.log("    promptSnippet          :", String(promptSnippet.length).padStart(5), "chars");
console.log("    promptGuidelines       :", String(promptGuidelines.length).padStart(5), "chars");
console.log("    ".padEnd(27) + "-".repeat(11));
console.log("    total                  :", String(total).padStart(5), `chars  ≈ ${Math.round(total / CHARS_PER_TOKEN)} tokens`);
console.log("\n    the `loop` tool, removed from children for this exact reason: ~177 tokens");

console.log(`
NOW: \`stack.ts\` opens its factory with the same \`__PI_SUBAGENT_SPAWN_DEPTH__\`
check \`pi-subagents-lite\` and \`pi-loop-mode\` use, so a child's instance
registers nothing — not \`stack_status\`, not \`/stack\`, not the entry renderer.
The operator's session is unchanged.

BEFORE: every subagent carried a tool for inspecting the inference stack it was
running on — model, context size, slot cache, speculative decoding, GPU memory,
forge health and the effective .env — in every turn of its window, at the price
shown above and within four tokens of the one the denylist removed for costing
too much.

It was read-only and it was not dangerous. The route is the finding:
\`subagent-denylist.ts\` reasons entirely about \`vendor/\`, where nothing is
discovered, and said nothing about \`.pi/extensions/\`, where everything is. So
the repair is in two parts — the guard, and a standing check that the NEXT
extension dropped into that directory cannot arrive unnoticed:
\`pi-subagents-lite/tests/subagent-denylist.test.ts\` fails if anything there
registers a model-visible tool without guarding itself.
`);
