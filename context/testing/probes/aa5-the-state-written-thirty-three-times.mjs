/**
 * aa5 — AN5, the state written thirty-three times and read once.
 *
 * FIXED — both columns are the REAL `vendor/pi-loop-mode` extension. The BEFORE
 * column is loaded from a copy of `extensions/index.ts` with the memo patched
 * back out, the way `z4` does it: a probe that reproduces a fix's absence by
 * re-implementing it is a probe about the re-implementation.
 *
 * `persistState` appends a `loop-state` custom entry, and `restoreLoopState`
 * reads exactly ONE of them back — the last on the branch. Every other entry is
 * carried for its own sake.
 *
 * The `session` mode is the measurement the finding came from: a real session
 * file under `~/.pi/agent/sessions`, and how much of it is loop state that said
 * nothing new.
 *
 *   run: node --experimental-strip-types aa5-the-state-written-thirty-three-times.mjs [live|session|swap]
 */

import { readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const REPO = "/home/claudeuser/qwen3.8-forge";

const MODES = {
  /** Drive the real extension: two writes of the same state. */
  live: {},
  /** Count the duplicates in a real session file on this box. */
  session: {},
  /** The trap in the fix: the memo is per session, the module is per process. */
  swap: {},
};

const MODE = process.argv[2] ?? "live";
if (!MODES[MODE]) {
  console.error(`usage: node aa5-…mjs <${Object.keys(MODES).join("|")}>`);
  process.exit(2);
}

let failures = 0;
const check = (label, ok) => {
  console.log(`   ${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) failures++;
};

console.log(`\naa5 [${MODE}] — the state written thirty-three times and read once (AN5)\n`);

if (MODE === "session") {
  const root = join(homedir(), ".pi", "agent", "sessions");
  let files = [];
  try {
    for (const dir of readdirSync(root)) {
      for (const name of readdirSync(join(root, dir))) {
        if (name.endsWith(".jsonl")) files.push(join(root, dir, name));
      }
    }
  } catch {
    files = [];
  }

  const rows = [];
  for (const file of files) {
    let entries = 0;
    let bytes = 0;
    let duplicates = 0;
    let previous;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.includes('"customType":"loop-state"')) continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (parsed?.customType !== "loop-state") continue;
      entries += 1;
      bytes += line.length + 1;
      const body = JSON.stringify(parsed.data);
      if (body === previous) duplicates += 1;
      previous = body;
    }
    if (entries > 0) rows.push({ file, entries, bytes, duplicates, total: statSync(file).size });
  }

  if (rows.length === 0) {
    console.log("   no session file on this box carries loop-state entries.");
    console.log("   (Nothing to measure; the `live` mode drives the module instead.)\n");
    process.exit(0);
  }

  rows.sort((a, b) => b.bytes - a.bytes);
  console.log("   session file                          entries   bytes    of file  identical");
  for (const row of rows.slice(0, 6)) {
    const share = `${((row.bytes / row.total) * 100).toFixed(1)}%`;
    console.log(
      `   ${row.file.split("/").pop().slice(0, 36).padEnd(36)} ${String(row.entries).padStart(7)} ` +
        `${String(row.bytes).padStart(8)} ${share.padStart(8)} ${String(row.duplicates).padStart(10)}`,
    );
  }
  const worst = rows[0];
  console.log("");
  console.log(`   the largest: ${worst.entries} entries, ${worst.bytes} bytes — ${((worst.bytes / worst.total) * 100).toFixed(1)}% of the file,`);
  console.log(`   mean ${Math.round(worst.bytes / worst.entries)} bytes, and ${worst.duplicates} of them byte-identical to the one before.`);
  console.log("   Only the LAST one is ever read back.\n");

  check("there is something to measure", worst.entries > 1);
  check("…and some of it said nothing new", worst.duplicates > 0);
} else {
  const { completedCheck } = await import(`${REPO}/vendor/pi-loop-mode/tests/exec-shapes.ts`);

  /** One column: a host, an extension instance, and the entries it appended. */
  function makeColumn(extension) {
    const handlers = new Map();
    let commandHandler;
    let branch = [{ type: "message" }];
    const appended = [];
    const pi = {
      on: (event, handler) => handlers.set(event, handler),
      registerCommand: (_name, config) => {
        commandHandler = config.handler;
      },
      registerTool: () => {},
      appendEntry: (customType, data) => {
        appended.push({ customType, data });
        branch.push({ type: "custom", customType, data });
      },
      sendMessage: () => {},
      exec: async () => completedCheck(0),
      setModel: async () => true,
    };
    const ctx = {
      cwd: process.cwd(),
      mode: "tui",
      hasUI: true,
      ui: { notify: () => {}, setStatus: () => {} },
      sessionManager: { getBranch: () => branch, getEntries: () => branch },
      modelRegistry: { find: () => undefined, getAll: () => [] },
      model: { api: "openai-completions", contextWindow: 32_768 },
      isIdle: () => true,
      hasPendingMessages: () => false,
      getContextUsage: () => ({ percent: 10, contextWindow: 32_768, tokens: 3_276 }),
      compact: () => {},
      abort: () => {},
      waitForIdle: async () => {},
    };
    extension(pi);
    return {
      ctx,
      appended,
      command: (args) => commandHandler(args, ctx),
      emit: (event, payload = {}) => handlers.get(event)?.(payload, ctx),
      newBranch: () => {
        branch = [{ type: "message" }];
      },
      entries: () => appended.filter((entry) => entry.customType === "loop-state"),
      bytes: () =>
        appended
          .filter((entry) => entry.customType === "loop-state")
          .reduce((total, entry) => total + JSON.stringify(entry.data).length, 0),
    };
  }

  /**
   * The same extension, with one part of the fix patched back out.
   *
   * `dedupe` is the memo itself; `reset` is the two `resetPersistMemo()` calls
   * in the session handlers — the trap, and the reason the `swap` mode has a
   * third column.
   */
  async function patchedExtension(which, tag) {
    const path = `${REPO}/vendor/pi-loop-mode/extensions/index.ts`;
    const original = readFileSync(path, "utf8");
    const patched =
      which === "dedupe"
        ? original.replace(
            `  const payload = persistedLoopState(state);
  const encoded = JSON.stringify(payload);
  if (encoded === lastPersisted) return;`,
            `  const payload = persistedLoopState(state);
  const encoded = JSON.stringify(payload);`,
          )
        : original.replace(/^\s*resetPersistMemo\(\);\n/gm, "");
    if (patched === original) throw new Error("could not remove the fix — the source has moved");
    const tmp = `${REPO}/vendor/pi-loop-mode/extensions/.aa5-${tag}.ts`;
    writeFileSync(tmp, patched);
    try {
      return (await import(tmp)).default;
    } finally {
      rmSync(tmp, { force: true });
    }
  }

  const shipped = (await import(`${REPO}/vendor/pi-loop-mode/extensions/index.ts`)).default;
  const columns = { BEFORE: makeColumn(await patchedExtension("dedupe", "before")), NOW: makeColumn(shipped) };
  if (MODE === "swap") {
    // The third column: the memo kept, its reset removed. This is what the trap
    // looks like from the outside, and it is why the reset is two lines rather
    // than none.
    columns["NO RESET"] = makeColumn(await patchedExtension("reset", "noreset"));
  }

  if (MODE === "live") {
    console.log("   `/loop end` sets `state = defaultState()` and persists it. Run twice,");
    console.log("   the second one has nothing to add.\n");
    for (const [label, column] of Object.entries(columns)) {
      await column.command("end");
      await column.command("end");
      await column.command("end");
      console.log(`   ${label}`);
      console.log(`     entries written : ${column.entries().length}`);
      console.log(`     bytes           : ${column.bytes()}`);
      console.log("");
    }
    check("BEFORE every call wrote one", columns.BEFORE.entries().length === 3);
    check("NOW only the one that said something did", columns.NOW.entries().length === 1);
    check("…and it is the same state", JSON.stringify(columns.NOW.entries()[0].data.status) === '"stopped"');

    // …and a change still lands, which is the control.
    for (const column of Object.values(columns)) await column.command("start Improve the site");
    console.log(`   after a /loop start, which IS a change:`);
    console.log(`     BEFORE ${columns.BEFORE.entries().length} entries, NOW ${columns.NOW.entries().length}\n`);
    check("NOW a real change is still written", columns.NOW.entries().length === 2);
  } else {
    console.log("   the trap: the memo is per SESSION and the module is per PROCESS.");
    console.log("   A new session starts with an empty branch, so `restoreState` hands");
    console.log("   back defaultState() — the same payload `/loop end` just wrote.\n");
    for (const [label, column] of Object.entries(columns)) {
      await column.command("end");
      const first = column.entries().length;
      column.newBranch();
      await column.emit("session_shutdown");
      await column.emit("session_start");
      await column.command("end");
      const second = column.entries().length - first;
      console.log(`   ${label}`);
      console.log(`     the first session wrote  : ${first}`);
      console.log(`     the NEW session wrote    : ${second}${second === 0 ? "   ← its file would have no loop state at all" : ""}`);
      console.log("");
    }
    check("NOW the new session gets an entry of its own", columns.NOW.entries().length === 2);
    check("BEFORE it did too, for the boring reason that it always wrote", columns.BEFORE.entries().length === 2);
    check(
      "with the reset removed, the new session's file would hold NO loop state",
      columns["NO RESET"].entries().length === 1,
    );
  }
}

console.log("");
process.exit(failures === 0 ? 0 : 1);
