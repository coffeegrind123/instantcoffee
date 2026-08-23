/**
 * AN6, the wiring half — `runAgentImpl` releases its buffer on every exit.
 *
 * `notice-buffer.test.ts` drives the buffer itself. This one is about where it
 * is flushed, and it has to read source text because `agent-runner.ts` imports
 * `@earendil-works/pi-coding-agent`, which does not resolve under the bare
 * `node --experimental-strip-types --test` this suite runs on. The twentieth
 * pass is about that gap; the answer here is the same one six suites in
 * `vendor/prinny-channel/tests` already use — pin the shape, and keep the thing
 * it is a proxy for written down.
 *
 * What is pinned, and why each one:
 *
 *   · the flush is in a `finally`, not after the `await` — the defect was that
 *     a throwing run took the buffer with it;
 *   · the `try` opens ABOVE the setup, not just around the run — four of the
 *     five writers are setup checks, and a setup that throws is the case where
 *     the sentence is worth most;
 *   · the buffer is the module, not a bare array — an array cannot be tested,
 *     which is why the previous form had no test at all.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const SOURCE = readFileSync(new URL("../src/agents/agent-runner.ts", import.meta.url), "utf8");

/** `runAgentImpl`'s body, from its signature to the closing brace at column 0. */
function runAgentImplBody(): string {
  const start = SOURCE.indexOf("async function runAgentImpl(");
  assert.ok(start >= 0, "runAgentImpl must still exist");
  const end = SOURCE.indexOf("\n}", start);
  assert.ok(end > start, "runAgentImpl must still close");
  return SOURCE.slice(start, end);
}

describe("AN6 — runAgentImpl's setup warnings", () => {
  it("uses the buffer module rather than a bare array", () => {
    assert.match(SOURCE, /import \{ NoticeBuffer \} from "\.\/notice-buffer\.ts"/);
    assert.match(runAgentImplBody(), /const warnings = new NoticeBuffer\(\)/);
  });

  it("flushes INSIDE the finally, not merely after it", () => {
    // Brace-matched rather than "appears later in the file". A control run that
    // moved the flush one line below `} finally {}` passed the ordering form,
    // which is §11.7 of the previous pass — a test that pinned the wrong thing —
    // arriving in this pass's own suite.
    const body = runAgentImplBody();
    const finallyAt = body.indexOf("} finally {");
    assert.ok(finallyAt >= 0, "the flush has to be on every exit, not just the happy one");
    const open = body.indexOf("{", finallyAt + 1);
    let depth = 0;
    let close = -1;
    for (let i = open; i < body.length; i++) {
      if (body[i] === "{") depth += 1;
      else if (body[i] === "}") {
        depth -= 1;
        if (depth === 0) {
          close = i;
          break;
        }
      }
    }
    assert.ok(close > open, "the finally block must close");
    const inside = body.slice(open, close);
    assert.match(inside, /warnings\.flush\(ctx\)/, "the release point is in the finally block itself");
  });

  it("opens the try above the setup, not just around the run", () => {
    const body = runAgentImplBody();
    const tryAt = body.indexOf("\n  try {");
    const settingsAt = body.indexOf("SettingsManager.create");
    const promptSourcesAt = body.indexOf("resolveSystemPromptSources");
    const buildAt = body.indexOf("buildSubagentSession");
    assert.ok(tryAt >= 0, "runAgentImpl must still have its try");
    assert.ok(settingsAt > tryAt, "the settings manager is built inside it");
    assert.ok(promptSourcesAt > tryAt, "resolveSystemPromptSources writes into the buffer");
    assert.ok(buildAt > tryAt, "so does the resource loader, from inside buildSubagentSession");
  });

  it("does not flush anywhere else", () => {
    const occurrences = SOURCE.split("warnings.flush(").length - 1;
    assert.equal(occurrences, 1, "one release point, or the idempotence is load-bearing for the wrong reason");
  });

  it("still buffers rather than notifying during setup — the control", () => {
    // The reason the buffer exists at all. A `ctx.ui.notify` call inside the
    // setup would be the defect this whole mechanism was built to avoid.
    const body = runAgentImplBody();
    const setup = body.slice(0, body.indexOf("} finally {"));
    assert.doesNotMatch(setup, /ctx\.ui\.notify\(/, "setup must hand its warnings to the buffer, not to the UI");
  });
});
