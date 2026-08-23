/**
 * aa1 — AN1, the read that could not parse and the write that finished it off.
 *
 * FIXED — the NOW column drives the REAL `ConfigStore` and the REAL
 * `createConfigIO` from `vendor/pi-subagents-lite`, against a temporary agent
 * directory. The BEFORE column drives the SAME real store through a `ConfigIO`
 * that is the old implementation, quoted:
 *
 * ```js
 *   function readGlobalRaw() {
 *     try { return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")); }
 *     catch { return {}; }
 *   }
 *   saveGlobal: (config) => { writeJsonAtomic(CONFIG_PATH, config); }
 * ```
 *
 * `ConfigIO` is an injectable port and the STORE is what does the damage, so
 * swapping the port is the faithful way to show it: the layer merge, the
 * defaults, the mutation and the save are all the shipped code.
 *
 * **One process per column.** `config-io.ts` resolves `CONFIG_PATH` from
 * `getAgentDir()` at module load, and jiti caches the module — so two columns in
 * one process both read the first column's directory, which is how the first
 * draft of this probe managed to show the fix failing. Same reason the loop
 * probes run one process per mode.
 *
 * The `prinny` mode is the second instance, and there both columns are entirely
 * real (`readSettingsLayer` / `writeSettings` take the file as a parameter), with
 * BEFORE produced by the four lines the fix replaced.
 *
 *   run: node aa1-the-config-the-reader-could-not-parse.mjs [subagents|prinny|absent]
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "/home/claudeuser/qwen3.8-forge";
const PI = "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
const SELF = fileURLToPath(import.meta.url);

/** What an operator's config actually holds here. */
const REAL = {
  agent: {
    default: "forge/qwen3.8-27b",
    Explore: "forge/qwen3.8-27b",
    graceTurns: 3,
    widgetMaxLines: 20,
    showCost: true,
    systemPromptMode: "custom",
  },
  concurrency: { default: 2, providers: { forge: 2 } },
};
/** …with one comma removed, which is what a hand-edit leaves behind. */
const BROKEN = JSON.stringify(REAL, null, 2).replace('"graceTurns": 3,', '"graceTurns": 3');

const scratch = (tag) => mkdtempSync(join(tmpdir(), `aa1-${tag}-`));

// ── the child: one column, in its own process ────────────────────────────────

if (process.env.AA1_COLUMN) {
  const column = process.env.AA1_COLUMN;
  const dir = process.env.PI_CODING_AGENT_DIR;
  const configPath = join(dir, "subagents-lite.json");

  const { createJiti } = await import(
    "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs"
  );
  const jiti = createJiti(`file://${PI}`, {
    interopDefault: true,
    alias: { "@earendil-works/pi-coding-agent": PI },
  });

  /** The old ConfigIO, quoted. One catch, and a write that asks nothing. */
  const beforeIO = {
    load: () => {
      let global = {};
      try {
        global = JSON.parse(readFileSync(configPath, "utf-8"));
      } catch {
        global = {};
      }
      return { global, project: null, projectStatus: "untrusted", globalStatus: "absent" };
    },
    saveGlobal: (config) => writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8"),
    saveProject: () => {},
  };

  const cs = await jiti.import(`${REPO}/vendor/pi-subagents-lite/src/config/config-store.ts`);
  const io = await jiti.import(`${REPO}/vendor/pi-subagents-lite/src/config/config-io.ts`);
  const store = new cs.ConfigStore(column === "BEFORE" ? beforeIO : io.createConfigIO());

  const loaded = {
    model: store.agent.defaultModel,
    concurrency: store.concurrency.default,
    said: store.globalConfigUnreadable !== undefined,
  };

  // One /agents toggle, which is all it takes.
  store.mutate.widget.setShowCompletionCards(false);

  const kept = readdirSync(dir).filter((name) => name.includes(".corrupt-"));
  process.stdout.write(
    `${JSON.stringify({
      ...loaded,
      after: existsSync(configPath) ? readFileSync(configPath, "utf-8") : "(no file)",
      kept,
      keptBody: kept.length ? readFileSync(join(dir, kept[0]), "utf-8") : undefined,
    })}\n`,
  );
  process.exit(0);
}

// ── the parent ───────────────────────────────────────────────────────────────

const MODES = {
  /** The subagents global config: models, concurrency, every /agents setting. */
  subagents: {},
  /** prinny's pi.json: the Matrix permission relay lives in it. */
  prinny: {},
  /** The control: an ABSENT file is not a malformed one, and never was. */
  absent: {},
};

const MODE = process.argv[2] ?? "subagents";
if (!MODES[MODE]) {
  console.error(`usage: node aa1-…mjs <${Object.keys(MODES).join("|")}>`);
  process.exit(2);
}

let failures = 0;
const check = (label, ok) => {
  console.log(`   ${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) failures++;
};

console.log(`\naa1 [${MODE}] — the read that could not parse, and the write that finished it off (AN1)\n`);

if (MODE === "subagents" || MODE === "absent") {
  const results = {};
  for (const label of ["BEFORE", "NOW"]) {
    const dir = scratch(label.toLowerCase());
    if (MODE !== "absent") writeFileSync(join(dir, "subagents-lite.json"), BROKEN);
    const run = spawnSync(process.execPath, ["--experimental-strip-types", SELF], {
      env: { ...process.env, AA1_COLUMN: label, PI_CODING_AGENT_DIR: dir },
      encoding: "utf8",
    });
    const line = (run.stdout ?? "").split("\n").find((l) => l.startsWith(""));
    if (!line) {
      console.error(run.stdout, run.stderr);
      process.exit(2);
    }
    const out = JSON.parse(line.slice(1));
    results[label] = out;
    console.log(`   ${label}`);
    console.log(`     default model after load     : ${out.model ?? "null"}`);
    console.log(`     concurrency after load       : ${out.concurrency}`);
    console.log(`     anybody told the file is bad : ${out.said ? "yes" : "NO"}`);
    console.log(`     the operator's bytes kept    : ${out.kept.length ? out.kept[0] : "NO — gone"}`);
    console.log(`     the file after one toggle    : ${out.after.replace(/\s+/g, " ").slice(0, 68)}`);
    console.log("");
  }

  if (MODE === "absent") {
    check("a fresh install loads defaults in both columns", results.BEFORE.model === null && results.NOW.model === null);
    check("…and nobody claims a file is broken", results.NOW.said === false);
    check("…and nothing is quarantined", results.NOW.kept.length === 0);
    check("…and the first save writes the file", results.NOW.after.includes("showCompletionCards"));
  } else {
    check("BEFORE the settings read as absent", results.BEFORE.model === null && results.BEFORE.concurrency === 1);
    check("BEFORE nothing said the file was unreadable", results.BEFORE.said === false);
    check("BEFORE one toggle replaced the file", !results.BEFORE.after.includes("forge/qwen3.8-27b"));
    check("BEFORE the operator's bytes were gone", results.BEFORE.kept.length === 0);
    check("NOW the store says the layer is unreadable", results.NOW.said === true);
    check("NOW the bytes are kept as .corrupt-<time>", results.NOW.kept.length === 1);
    check("NOW the kept copy is the operator's file, unchanged", results.NOW.keptBody === BROKEN);
    check("…and the toggle still saved", results.NOW.after.includes("showCompletionCards"));
  }
} else {
  const config = await import(`${REPO}/vendor/prinny-channel/src/config.ts`);

  const CONFIGURED = {
    deliverAs: "steer",
    forward: "all",
    permissionMode: "all",
    permissionTools: ["bash", "write"],
    permissionTimeoutSeconds: 600,
    requestTimeoutSeconds: 90,
    connectTimeoutSeconds: 180,
  };
  const BROKEN_SETTINGS = JSON.stringify(CONFIGURED, null, 2).replace('"forward": "all",', '"forward": "all"');

  console.log("   the Matrix approval relay is in this file. `permissionMode: all`");
  console.log("   means every tool call is shown to a person before it runs.\n");

  const results = {};
  for (const label of ["BEFORE", "NOW"]) {
    const dir = scratch(label.toLowerCase());
    const file = join(dir, "pi.json");
    writeFileSync(file, BROKEN_SETTINGS);

    const layer = config.readSettingsLayer(file);
    if (label === "BEFORE") {
      // `writeSettings` as it was: ensureStateDir, tmp, rename. Nothing asked.
      writeFileSync(`${file}.tmp`, `${JSON.stringify({ ...layer.settings, forward: "off" }, null, 2)}\n`);
      renameSync(`${file}.tmp`, file);
    } else {
      config.writeSettings({ ...layer.settings, forward: "off" }, file);
    }

    const kept = readdirSync(dir).filter((name) => name.includes(".corrupt-"));
    results[label] = { layer, kept, dir };
    console.log(`   ${label}`);
    console.log(`     permissionMode after load    : ${layer.settings.permissionMode}  (the file says "all")`);
    console.log(`     permissionTools after load   : ${JSON.stringify(layer.settings.permissionTools)}`);
    console.log(`     read status                  : ${label === "BEFORE" ? "(the old read had none)" : layer.status}`);
    console.log(`     the operator's bytes kept    : ${kept.length ? kept[0] : "NO — gone"}`);
    console.log("");
  }

  check("both columns read the relay as OFF — that damage is the same", results.NOW.layer.settings.permissionMode === "off");
  check("NOW the read says MALFORMED rather than absent", results.NOW.layer.status === "malformed");
  check("BEFORE the write replaced the file", results.BEFORE.kept.length === 0);
  check("NOW the bytes are kept", results.NOW.kept.length === 1);
  check("…unchanged", readFileSync(join(results.NOW.dir, results.NOW.kept[0]), "utf-8") === BROKEN_SETTINGS);
}

console.log("");
process.exit(failures === 0 ? 0 : 1);
