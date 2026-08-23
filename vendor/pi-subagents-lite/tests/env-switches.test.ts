/**
 * AN4 — the switches the launcher never forwarded.
 *
 * `scripts/pi-local.sh` states the rule this pins, in the block that forwards
 * the subagent settings:
 *
 * > Exported, not passed as a flag: the fork reads both from `process.env`, and
 * > **a value that only ever lives in .env is a knob that silently does
 * > nothing.**
 *
 * It forwarded four of the seven `SUBAGENT_*` variables the package reads. The
 * three it did not are `SUBAGENT_TRANSCRIPT`, `SUBAGENT_VERIFY_LOG` and
 * `SUBAGENT_VERIFY_LOG_FILE` — and the first two are documented as the way to
 * turn each feature off (`README.md`, and the handoff for the twentieth pass),
 * in a file whose four siblings all live in `.env`. `env_get` reads an already
 * EXPORTED variable first, so `SUBAGENT_TRANSCRIPT=0 ./scripts/pi-local.sh`
 * worked and the documented spelling did not.
 *
 * Both default to ON and both write per delegation: up to sixty session entries
 * of four thousand characters, and one JSONL line per verifier model call. The
 * operator who goes looking for the switch is the operator who had a reason to.
 *
 * ## This is a scan, not three fixes
 *
 * The seventeenth pass's lesson, and it applies exactly: *write the scan, not
 * the third fix.* Every `env.SUBAGENT_*` this package reads has to be named in
 * the launcher, or the launcher has to say out loud that it is deliberately
 * inline-only. A fourth switch added to a module and not to the script is a
 * failing test rather than a knob that does nothing.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const LAUNCHER = fileURLToPath(new URL("../../../scripts/pi-local.sh", import.meta.url));

/** Every `.ts` under src/, recursively. */
function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) sources(full, out);
    else if (full.endsWith(".ts")) out.push(full);
  }
  return out;
}

/**
 * Every `SUBAGENT_*` this package reads out of the environment.
 *
 * Both spellings, because both are used: `process.env.X` at a call site, and
 * `env.X` inside a module that takes the environment as a parameter.
 */
function switchesRead(): Set<string> {
  const found = new Set<string>();
  for (const file of sources(SRC)) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/\b(?:process\.)?env\.(SUBAGENT_[A-Z_]+)\b/g)) {
      found.add(match[1]);
    }
  }
  return found;
}

/**
 * Deliberately not forwarded, with the reason. Empty, and that is the point: a
 * name added here is a decision somebody has to write down.
 */
const INLINE_ONLY = new Map<string, string>();

describe("AN4 — every switch this package reads reaches the process", () => {
  const launcher = existsSync(LAUNCHER) ? readFileSync(LAUNCHER, "utf8") : undefined;

  it("finds the switches at all — the control for the scan itself", () => {
    const read = switchesRead();
    // A negative result is only as good as its control: if the regex stopped
    // matching, every assertion below would pass by finding nothing.
    assert.ok(read.has("SUBAGENT_VERIFY"), "the scan has to see the one that was always forwarded");
    assert.ok(read.size >= 5, `expected several SUBAGENT_* reads, found ${read.size}`);
  });

  it("the launcher exports each of them", { skip: launcher ? false : "scripts/pi-local.sh not found" }, () => {
    const missing = [...switchesRead()]
      .filter((name) => !INLINE_ONLY.has(name))
      .filter((name) => !new RegExp(`export ${name}=`).test(launcher!));
    assert.deepEqual(
      missing,
      [],
      "read from process.env and never exported: a value in .env would do nothing at all",
    );
  });

  it("…and reads each of them out of .env first", { skip: launcher ? false : "scripts/pi-local.sh not found" }, () => {
    const missing = [...switchesRead()]
      .filter((name) => !INLINE_ONLY.has(name))
      .filter((name) => !new RegExp(`env_get ${name}\\)`).test(launcher!));
    assert.deepEqual(missing, [], "exported from what? `env_get` is what reads the .env file");
  });

  it("the two AN4 named are there by name", { skip: launcher ? false : "scripts/pi-local.sh not found" }, () => {
    assert.match(launcher!, /export SUBAGENT_TRANSCRIPT=/);
    assert.match(launcher!, /export SUBAGENT_VERIFY_LOG=/);
    assert.match(launcher!, /export SUBAGENT_VERIFY_LOG_FILE=/);
  });
});
