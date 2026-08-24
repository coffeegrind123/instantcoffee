// AB3 — a wedged `rtk` looks exactly like a healthy one.
//
//   node --experimental-strip-types --test tests/*.test.ts   (from vendor/rtk-pi)
//
// The load-time probe exists to answer one question — "is there a usable rtk on
// PATH?" — and it asked it with `ver.code !== 0`. pi's `execCommand`
// (`core/exec.js`) resolves a child it killed on the timeout with
// `code: code ?? 0`, because a signalled child exits with a signal and no code.
// So an rtk that HANGS comes back `{ code: 0, stdout: "", killed: true }`:
//
//   - the "not on PATH" branch does not fire, so nothing is said;
//   - `parseSemver("")` returns null, so the `>= 0.23.0` guard is skipped
//     entirely — the one place the extension decides not to filter;
//   - the `tool_call` handler registers, and every allow-listed command then
//     spends the full REWRITE_TIMEOUT_MS waiting for the same wedged binary
//     before `rewriteCommand`'s own `killed` check fails it open.
//
// `rewriteCommand` had this right; the probe forty lines above it did not. That
// is the whole finding, and it is why this file also pins the ORDER: `killed`
// answers a different question from `code`, and testing `code` first cannot
// reach it.
//
// The extension imports pi's runtime (`isToolCallEventType`), so this suite
// cannot load it. The first test drives pi's REAL `execCommand` to establish the
// shape; the rest pin the source and model the decision.
//
// See AB3 in `context/design/subagents-loop-verifier-signals.md`.

import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { describe, test } from "node:test";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where pi's `core/exec.js` actually is, on THIS machine.
 *
 * This used to be the literal string
 * `/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/exec.js`,
 * which is true of a box where pi was installed with npm's default global
 * prefix and of nowhere else. On a GitHub runner the import threw
 * ERR_MODULE_NOT_FOUND, the suite failed, and because `rtk gate unit tests` is
 * the fourth step of the workflow it took every step after it down with it —
 * CI reported "failure" for nine days over a path.
 *
 * Resolved from the `pi` binary on PATH instead: npm links it to
 * `<prefix>/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js`, so
 * the realpath's directory IS `dist`. Falls back to the old absolute path so a
 * box that has pi somewhere unusual but at the historic location still works.
 */
function findPiExec(): string | null {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const bin = join(dir, "pi");
    if (!existsSync(bin)) continue;
    try {
      const cli = realpathSync(bin);           // .../dist/cli.js
      const exec = join(dirname(cli), "core", "exec.js");
      if (existsSync(exec)) return exec;
    } catch {
      // an unreadable PATH entry is not this test's problem
    }
  }
  const legacy = "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/exec.js";
  return existsSync(legacy) ? legacy : null;
}

const PI_EXEC = findPiExec();
const EXTENSION = join(dirname(dirname(fileURLToPath(import.meta.url))), "extensions", "index.ts");

/** The probe's decision, as the extension makes it. Kept in one place so both orders can be tried. */
function probeVerdict(ver: { code: number; stdout: string; killed: boolean }): "wedged" | "absent" | "usable" {
  if (ver.killed) return "wedged";
  if (ver.code !== 0) return "absent";
  return "usable";
}

describe("AB3 — the version probe", () => {
  // Skipped rather than stubbed when pi is absent. The value of this one is
  // that it drives pi's REAL execCommand — a stub of it would assert the shape
  // this file already assumes and prove nothing. The other three tests pin the
  // source and run everywhere, so an environment without pi still fails on a
  // regression in the extension itself.
  test("pi resolves a hung `--version` as exit code 0", { skip: PI_EXEC ? false : "pi is not installed on PATH" }, async () => {
    // The premise, against the real implementation rather than a stub of it.
    const { execCommand } = await import(PI_EXEC as string);
    const hung = await execCommand("bash", ["-lc", "sleep 5"], process.cwd(), { timeout: 300 });

    assert.equal(hung.code, 0, "a SIGTERMed child has no exit code, and execCommand substitutes 0");
    assert.equal(hung.killed, true, "`killed` is the only field that says what happened");
    assert.equal(hung.stdout, "");

    const missing = await execCommand("definitely-not-a-binary-xyz", ["--version"], process.cwd(), { timeout: 300 });
    assert.equal(missing.code, 1, "control — a spawn failure really does come back non-zero");
    assert.equal(missing.killed, false);
  });

  test("a wedged rtk is not reported as usable", () => {
    assert.equal(probeVerdict({ code: 0, stdout: "", killed: true }), "wedged");
    assert.equal(probeVerdict({ code: 1, stdout: "", killed: false }), "absent");
    assert.equal(probeVerdict({ code: 0, stdout: "rtk 0.45.0", killed: false }), "usable");
  });

  test("the extension tests `killed` before `code`", () => {
    const source = readFileSync(EXTENSION, "utf8");
    const probe = source.indexOf('pi.exec("rtk", ["--version"]');
    assert.ok(probe > 0, "the load-time probe must still be there");

    const after = source.slice(probe);
    const killedAt = after.indexOf("ver.killed");
    const codeAt = after.indexOf("ver.code !== 0");

    assert.ok(killedAt > 0, "a probe that never reads `killed` cannot tell a hang from an answer");
    assert.ok(codeAt > 0);
    assert.ok(killedAt < codeAt, "`code` is 0 for a killed child, so testing it first swallows the case");
  });

  test("control — rewriteCommand still checks it too", () => {
    // The site that was already right. Both matter: the probe decides whether to
    // register at all, and this one decides each command.
    const source = readFileSync(EXTENSION, "utf8");
    const rewrite = source.indexOf("async function rewriteCommand");
    const body = source.slice(rewrite, source.indexOf("export default"));

    assert.match(body, /if \(result\.killed\) return null/);
    assert.ok(
      body.indexOf("result.killed") < body.indexOf("result.code !== 0"),
      "same order, same reason"
    );
  });
});
