/**
 * Syntax gate for the fork.
 *
 * The house pattern (vendor/prinny-channel, .pi/extensions/compaction-guard) is
 * `node --check` over every .ts file. It does not work on this package, and the
 * reason is worth writing down rather than rediscovering: `node --check` decides
 * whether a file is CommonJS or an ES module by scanning for a top-level
 * `import`/`export`, and only the ES-module path strips TypeScript. Two files
 * here — `src/prompt/context.ts` and `src/agents/stream-retry.ts` — open with a
 * plain `function` or `interface` and put their single `export` further down, so
 * the scan gives up first and they are parsed as CommonJS, where `c: unknown` is
 * a syntax error. Neither `--experimental-strip-types` nor `--input-type=module`
 * changes that; `--check` never strips types. It is a limitation of the checker,
 * not a defect in the files — pi loads both, and the wire measurement in
 * FORK.md was taken with them loaded.
 *
 * So this strips the types with node's own stripper, writes the result as .mjs
 * so there is nothing left to detect, and runs `node --check` on that. Same
 * guarantee as the house pattern, no file excluded, and a file it cannot read
 * fails loudly instead of being skipped.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

const files = [...walk(join(ROOT, "src")), ...walk(join(ROOT, "tests"))];
if (files.length === 0) {
  console.error("lint: no .ts files found — the walk is broken, not the source");
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), "pi-subagents-lint-"));
let failed = 0;
try {
  for (const file of files) {
    const rel = file.slice(ROOT.length + 1);
    let js;
    try {
      // "transform" rather than "strip": five files here use constructor
      // parameter properties (`constructor(private manager: AgentManager)`),
      // which strip-only mode refuses because erasing them would change the
      // runtime. pi's own loader transforms too, so this matches what runs.
      js = stripTypeScriptTypes(readFileSync(file, "utf8"), { mode: "transform" });
    } catch (error) {
      failed += 1;
      console.error(`lint: ${rel}\n  ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const out = join(work, `${rel.replace(/[^\w.-]+/g, "_")}.mjs`);
    writeFileSync(out, js, "utf8");
    const check = spawnSync(process.execPath, ["--check", out], { encoding: "utf8" });
    if (check.status !== 0) {
      failed += 1;
      console.error(`lint: ${rel}\n${(check.stderr || "").split("\n").slice(0, 4).join("\n")}`);
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(`lint: ${files.length - failed}/${files.length} files parsed`);
process.exit(failed > 0 ? 1 : 0);
