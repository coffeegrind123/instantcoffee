// The gate and the real rtk binary, composed.
//
//   node --experimental-strip-types --test tests/*.test.ts   (from vendor/rtk-pi)
//
// gate.test.ts checks the decisions in isolation and `./scripts/rtk.sh --check`
// checks the binary in isolation. Neither covers the join, which is where the
// interesting failure lives: the gate can be right about `git status` and the
// extension still ship a broken command if what comes back off the wire is not
// the shape extractRewrite expects.
//
// Skips itself when rtk is not installed, so a clone without the binary still
// runs a green suite — the stack is designed to work without it.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, test } from "node:test";

import { extractRewrite, shouldFilter } from "../src/gate.ts";

function rtkAvailable(): boolean {
  try {
    execFileSync("rtk", ["--version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

// What the extension does, minus pi: gate, shell out, validate the answer.
function filteredCommand(cmd: string): string | null {
  if (!shouldFilter(cmd)) return null;
  let stdout = "";
  try {
    stdout = execFileSync("rtk", ["rewrite", cmd], {
      encoding: "utf8",
      // rtk's telemetry is opt-in and already off, but this stack is meant to
      // run with the network unplugged and a test should not be the exception.
      env: { ...process.env, RTK_TELEMETRY_DISABLED: "1" },
    });
  } catch (err: any) {
    // Exit 1 means "no rtk equivalent" and is not a failure. Exit 3 means
    // "rewrite found" and also lands here, because execFileSync throws on any
    // non-zero status.
    if (err?.status === 1) return null;
    if (err?.status !== 3) throw err;
    stdout = err.stdout ?? "";
  }
  return extractRewrite(stdout);
}

describe("gate + rtk binary", { skip: rtkAvailable() ? false : "rtk is not installed" }, () => {
  test("allow-listed commands come back as a runnable rtk command", () => {
    for (const [cmd, want] of [
      ["git status", "rtk git status"],
      ["git status -s", "rtk git status -s"],
      ["pytest -q", "rtk pytest -q"],
      ["docker ps", "rtk docker ps"],
      ["find . -name '*.rs'", "rtk find . -name '*.rs'"],
    ] as const) {
      assert.equal(filteredCommand(cmd), want, cmd);
    }
  });

  test("denied commands are never sent to rtk at all", () => {
    // The assertion is `null`, not "rtk declined it" — several of these DO have
    // a filter (`cat f` -> `rtk read f`, `ls -la` -> `rtk ls -la`). They are
    // withheld by the gate, which is the whole point of the fork.
    for (const cmd of [
      "cat src/main.rs",
      "ls -la",
      "grep -rn foo src",
      "npm run lint",
      "uv run pytest",
      "git status | grep foo",
      "sudo docker ps",
    ]) {
      assert.equal(filteredCommand(cmd), null, cmd);
    }
  });

  test("a rewrite is never returned unchanged or empty", () => {
    // Guards the case where rtk starts echoing its input: the extension would
    // assign it back onto itself, which is harmless, but a null here means the
    // handler skips the assignment entirely.
    const out = filteredCommand("git status");
    assert.ok(out && out !== "git status");
    assert.ok(out.startsWith("rtk "));
  });
});
