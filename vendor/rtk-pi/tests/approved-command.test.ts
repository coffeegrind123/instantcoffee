// AJ3 (nineteenth pass) — the command a person approved, and the one that ran.
//
//   node --experimental-strip-types --test tests/approved-command.test.ts
//
// `tool_call` handlers run in load order over ONE mutable `event.input`, and
// `scripts/pi-local.sh` loads `vendor/prinny-channel` before this package. The
// relay therefore shows a Matrix approver the command exactly as the model wrote
// it, waits for a yes, and this handler then rewrites `event.input.command` to
// `rtk <something>` — so the string on the phone and the string pi executed were
// two different commands.
//
// Two things are asserted here, and the second is the one that rots:
//
//   1. the stand-down itself, through the REAL handler, on the same shape of
//      mutable input object pi passes;
//   2. that this package's copy of the key still equals the one prinny writes,
//      read out of prinny's own source. Vendor packages must not import each
//      other — the compaction lock has three copies of its protocol for the same
//      reason — so a cross-source assertion is what keeps them equal.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import { APPROVED_COMMAND_KEY, approvedAsWritten } from "../src/gate.ts";

const PRINNY_GATE = new URL(
  "../../prinny-channel/src/permission-gate.ts",
  import.meta.url,
);

describe("approvedAsWritten — the stamp, and only the stamp", () => {
  test("an approved call is recognised", () => {
    assert.equal(approvedAsWritten({ command: "git status", [APPROVED_COMMAND_KEY]: "git status" }), true);
  });

  test("an ordinary call is not", () => {
    assert.equal(approvedAsWritten({ command: "git status" }), false);
  });

  test("a shape this module does not recognise reads as NOT approved", () => {
    // The fail-open direction: an unrecognised value leaves rtk doing what it
    // always did, rather than silently switching itself off for every command.
    for (const value of [undefined, null, 0, 1, true, {}, [], ""]) {
      assert.equal(approvedAsWritten({ command: "git status", [APPROVED_COMMAND_KEY]: value }), false, String(value));
    }
    for (const input of [undefined, null, "git status", 7]) {
      assert.equal(approvedAsWritten(input), false, String(input));
    }
  });
});

describe("the two packages agree on the key", () => {
  test("prinny's source declares the same literal", () => {
    const src = readFileSync(PRINNY_GATE, "utf8");
    const declared = src.match(/export const APPROVED_COMMAND_KEY = '([^']+)'/)?.[1];
    assert.ok(declared, "prinny-channel no longer declares APPROVED_COMMAND_KEY");
    assert.equal(
      declared,
      APPROVED_COMMAND_KEY,
      "the stamp prinny writes and the one rtk reads have drifted apart",
    );
  });

  test("prinny still writes it, and writes what the approver read", () => {
    const src = readFileSync(PRINNY_GATE, "utf8");
    assert.match(src, /export function markApproved/, "the writer is gone");
    assert.match(src, /input\[APPROVED_COMMAND_KEY\] = shown/, "the writer no longer writes the key");
  });
});

describe("the handler stands down BEFORE it decides anything else", () => {
  // The extension imports pi's runtime (`isToolCallEventType`), so this suite
  // cannot load it — the same reason `version-probe.test.ts` pins its ordering
  // out of the source. The position is the assertion: a stand-down below
  // `rewriteCommand` would still spend a subprocess on a command it is about to
  // leave alone, and one below the assignment would not stand down at all.
  const source = readFileSync(new URL("../extensions/index.ts", import.meta.url), "utf8");

  // The exact form, not a substring: a control run for this finding disables the
  // guard rather than deleting it, and `if (false && approvedAsWritten(...))`
  // still contains every substring a looser assertion would look for. A test
  // that survives its own control is not a control.
  const GUARD = /\n\s*if \(approvedAsWritten\(event\.input\)\) \{/;

  test("the guard is in the tool_call handler, and is a guard", () => {
    assert.match(source, GUARD);
  });

  test("…above shouldFilter, and above the rewrite it would otherwise apply", () => {
    const guard = source.search(GUARD);
    const filter = source.indexOf("shouldFilter(cmd)");
    const rewrite = source.indexOf("rewriteCommand(pi, cmd");
    const assign = source.indexOf("event.input.command = rewritten");
    assert.ok(guard > 0 && filter > 0 && rewrite > 0 && assign > 0);
    assert.ok(guard < filter, "a call that was approved must not even be classified");
    assert.ok(guard < rewrite, "…nor cost a `rtk rewrite` subprocess");
    assert.ok(guard < assign, "…and above all must not be edited after the fact");
  });

  test("it says so out loud, because an unfiltered command is a visible change", () => {
    // Same policy as every other stand-down in this file: fail open, and leave a
    // line. `console.warn` runs whether or not there is a UI.
    const guard = source.search(GUARD);
    const filter = source.indexOf("shouldFilter(cmd)");
    assert.ok(guard > 0);
    assert.match(source.slice(guard, filter), /console\.warn/);
  });
});
