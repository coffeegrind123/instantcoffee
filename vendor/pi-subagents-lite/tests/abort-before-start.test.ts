/**
 * AB4 — an abort that arrives before the listener does is an abort nobody hears.
 *
 * `AbortSignal` dispatches `abort` exactly once, at abort time. A listener added
 * afterwards never runs — the event is gone, and `signal.aborted` is the only
 * remaining evidence. Every `AbortSignal` consumer therefore has TWO cases to
 * cover, and only one of them looks like work:
 *
 * ```
 *   if (signal.aborted) …                         ← the case that has happened
 *   signal.addEventListener("abort", …)           ← the case that has not
 * ```
 *
 * `forwardAbortSignal` (`src/agents/agent-runner.ts`) had only the second, and it
 * is called at the top of `runTurnLoop` — i.e. AFTER the whole of a child's
 * setup: `reloadAndMap()` running every extension factory (one of which,
 * `vendor/rtk-pi`, shells out to a subprocess), `createAgentSession()`,
 * `bindExtensions()`, `setActiveToolsByName()`. Seconds, on a 9p mount. An abort
 * inside that window was dropped, and:
 *
 *   - `stopAgent()` on a running record does nothing else — its whole effect on a
 *     started run is `record.execution.abortController?.abort()` — so **stopping
 *     a subagent during its build did not stop it**. The child ran its prompt to
 *     the end on the single llama slot, and `attachSettlementChain` handed its
 *     answer to the parent through the completion gate.
 *   - T5, closed in the tenth pass so a verification could be interrupted, lost
 *     the same race: `startDeadline` composes the operator's stop correctly, but
 *     the composed signal is then handed to `runAgent`, whose `forwardAbortSignal`
 *     could not see a signal that had already fired. Esc during the judge's setup
 *     bought a full model call before `assertNotExpired()` threw.
 *
 * The fix is a refusal, not an abort: `session.abort()` before `session.prompt()`
 * is consumed by nothing, so the prompt would run anyway with the stop spent.
 * `runTurnLoop` throws instead, and the throw lands on paths that already handle
 * a stop.
 *
 * `agent-runner.ts` imports pi, so this suite cannot load it. The first two tests
 * are the JS fact and the fact about the wrong fix — both executable, both the
 * reason the guard has the shape it has. The rest pin the source, and the last
 * one is the invariant: every abort listener in this package is paired with an
 * `.aborted` test, so a fourth one cannot be added without classifying it.
 *
 * See AB4 in `context/design/subagents-loop-verifier-signals.md`.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { describe, it } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(dirname(fileURLToPath(import.meta.url))), "src");

function readSrc(relative: string): string {
  return readFileSync(join(SRC, relative), "utf8");
}

function everyTsFile(dir: string, found: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) everyTsFile(full, found);
    else if (name.endsWith(".ts")) found.push(full);
  }
  return found;
}

describe("AB4 — an abort that already happened", () => {
  it("is invisible to a listener attached afterwards", () => {
    const controller = new AbortController();
    controller.abort();

    let heard = false;
    controller.signal.addEventListener("abort", () => {
      heard = true;
    }, { once: true });

    assert.equal(controller.signal.aborted, true);
    assert.equal(heard, false, "this is the whole finding: the event is gone and only `.aborted` is left");
  });

  it("control — the same listener attached first does hear it", () => {
    const controller = new AbortController();
    let heard = false;
    controller.signal.addEventListener("abort", () => {
      heard = true;
    }, { once: true });
    controller.abort();

    assert.equal(heard, true, "so the listener is right for every abort that is still to come");
  });

  it("control — aborting the session first would not have worked either", async () => {
    // A model of the fix that looks obvious and is wrong. `session.abort()`
    // before `prompt()` is consumed by nothing: pi's abort tears down whatever
    // is running now, and the prompt issued afterwards is a new run.
    let prompted = 0;
    const session = {
      aborted: false,
      async abort() {
        this.aborted = true;
      },
      async prompt() {
        prompted++;
      },
    };

    await session.abort();
    await session.prompt();

    assert.equal(session.aborted, true);
    assert.equal(prompted, 1, "the stop was spent and the run went ahead — which is why runTurnLoop refuses instead");
  });

  it("runTurnLoop refuses to start a run whose signal has already fired", () => {
    const source = readSrc("agents/agent-runner.ts");
    const guard = source.indexOf("if (options.signal?.aborted) throw new Error(ABORTED_BEFORE_START)");
    const prompt = source.indexOf("await session.prompt(prompt)");

    assert.ok(guard > 0, "runTurnLoop must test `.aborted` itself; forwardAbortSignal cannot answer it");
    assert.ok(prompt > 0);
    assert.ok(guard < prompt, "and it must be tested BEFORE the prompt, or the run has already gone out");
  });

  it("startDeadline still composes an already-aborted stop", () => {
    // The tenth pass got this one right, and it is the reason the finding is
    // narrow rather than general: T5's own composition is correct, and only the
    // hand-off into runAgent lost the signal.
    const source = readSrc("agents/agent-manager.ts");
    assert.match(source, /if \(stopSignal\.aborted\) controller\.abort\(\);/);
  });

  it("spawn still records an already-aborted parent as stopped", () => {
    const source = readSrc("agents/agent-manager.ts");
    const spawnGuard = source.indexOf("if (options.signal.aborted) {");
    const listener = source.indexOf('options.signal.addEventListener("abort", handler');

    assert.ok(spawnGuard > 0);
    assert.ok(listener > spawnGuard, "the queued/never-started case is decided before the listener is attached");
  });

  it("every abort listener in the package is paired with an `.aborted` test", () => {
    // The invariant, not the instances. Three sites today; a fourth has to say
    // which of the two cases it covers, or this fails.
    const sites: string[] = [];
    for (const file of everyTsFile(SRC)) {
      const source = readFileSync(file, "utf8");
      const lines = source.split("\n");
      lines.forEach((line, i) => {
        const code = line.trim();
        // Code only — forwardAbortSignal's own header names the call it is about.
        if (code.startsWith("*") || code.startsWith("//")) return;
        if (!code.includes('addEventListener("abort"')) return;
        // The paired `.aborted` test may be just above (startDeadline, spawn) or
        // deliberately elsewhere with the reason written down (forwardAbortSignal,
        // whose pair lives in runTurnLoop and is named in its header).
        const near = lines.slice(Math.max(0, i - 12), i + 12).join("\n");
        const documented = source.includes("AB4") && file.endsWith("agent-runner.ts");
        if (!near.includes(".aborted") && !documented) sites.push(`${file}:${i + 1}`);
      });
    }
    assert.deepEqual(sites, [], "an abort listener with no `.aborted` sibling covers half of the signal");
  });
});
