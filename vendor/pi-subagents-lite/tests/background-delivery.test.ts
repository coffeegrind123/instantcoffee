/**
 * AA4 — the background result's delivery mode is not a choice pi can honour.
 *
 * `SpawnCoordinator.emitIndividualNudge` used to pick it with
 * `parentIdle ? "followUp" : "steer"`. pi reads `deliverAs` in exactly one
 * branch of `sendCustomMessage`:
 *
 *   if (deliverAs === "nextTurn")                        agent-session.js:1078
 *   else if (this.isStreaming && triggerTurn !== false)                 :1081  ← reads it
 *   else if (triggerTurn) await this._runAgentPrompt(msg)               :1089  ← ignores it
 *
 * and `isStreaming` (`:588`) and `isIdle` (`:592`) are both `_isAgentRunActive`,
 * so they are exact complements. `parentIdle === true` is therefore precisely
 * the case that falls to `:1089`, where the value is discarded; `parentIdle ===
 * false` is precisely the case that reads it, where the ternary had already
 * committed to `"steer"`. The `followUp` arm existed only for the state in
 * which pi does not look at it.
 *
 * Now that it is a real choice it is made: `followUp`. Both queues drain inside
 * the same agent run and the same `agent_end` (`runLoop`'s outer while feeds
 * follow-ups back into the inner loop), so this does not change the turn SHAPE —
 * it changes where in the run the result lands. A steer is drained by the inner
 * while, before the next assistant response, i.e. possibly in the middle of a
 * tool chain the parent is halfway through; a follow-up is drained by the outer
 * while, once the model has stopped calling tools. A background result is by
 * construction not urgent — the parent chose not to block on it — so the later
 * injection point is the coherent one, and on a one-slot server the latency it
 * costs is one turn, not a queue wait.
 *
 * `spawn-coordinator.ts` imports `../shell.js`, which imports pi, so this suite
 * cannot load it. The first test pins the source; the second pins the routing
 * fact the source pin rests on, so a future pi that separates `isIdle` from
 * `isStreaming` breaks a test rather than silently reviving the dead arm.
 *
 * See AA4 in `context/design/subagents-loop-verifier-hosts.md` and probe
 * `context/testing/probes/n4-the-delivery-mode-that-is-never-read.mjs`.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const PI_AGENT_SESSION =
  "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js";

/** Strip comments: this file's own comments quote the defective form on purpose. */
function codeOf(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
}

describe("AA4 — the background nudge's deliverAs", () => {
  it("is not chosen from the parent's idle state", () => {
    const code = codeOf(fileURLToPath(new URL("../src/spawn/spawn-coordinator.ts", import.meta.url)));

    // The defect has one written form: a ternary on idleness feeding deliverAs.
    const ternary = /deliverAs\s*=\s*[^;]*\bisIdle\b|deliverAs\s*=\s*parentIdle\s*\?/;
    assert.equal(
      ternary.test(code),
      false,
      "pi ignores deliverAs on exactly the branch an idle parent takes, so choosing it from " +
        "isIdle() picks a value for the case that discards it and hardcodes the other",
    );

    assert.match(code, /const deliverAs = "followUp"/, "the mode pi can actually honour, stated");
  });

  it("control — pi still treats isIdle and isStreaming as the same bit", () => {
    // The whole argument above rests on this. If a future pi separates them, the
    // dead arm becomes live and this assertion is where that surfaces.
    const pi = readFileSync(PI_AGENT_SESSION, "utf8");
    const streaming = pi.match(/get isStreaming\(\)\s*\{\s*return ([^;]+);/);
    const idle = pi.match(/get isIdle\(\)\s*\{\s*return ([^;]+);/);
    assert.ok(streaming, "AgentSession.isStreaming not found — re-read the routing before trusting AA4");
    assert.ok(idle, "AgentSession.isIdle not found — re-read the routing before trusting AA4");
    assert.equal(streaming![1].trim(), "this._isAgentRunActive");
    assert.equal(idle![1].trim(), "!this._isAgentRunActive");
  });

  it("control — sendCustomMessage still reads deliverAs only while streaming", () => {
    const pi = codeOf(PI_AGENT_SESSION);
    const body = pi.slice(pi.indexOf("async sendCustomMessage("));
    const branch = body.slice(0, body.indexOf("async sendUserMessage("));

    // The streaming branch is the only one that mentions deliverAs alongside a
    // queue call; the triggerTurn branch goes straight to _runAgentPrompt.
    assert.match(branch, /this\.isStreaming && options\?\.triggerTurn !== false/);
    assert.match(branch, /else if \(options\?\.triggerTurn\)\s*\{?\s*await this\._runAgentPrompt\(appMessage\)/);
  });
});

/**
 * AC1 (twelfth pass) — and the reason this file needed a second kind of test.
 *
 * Everything above reads `spawn-coordinator.ts` as TEXT. That is what the header
 * says and it was the honest thing available: the module imports `../shell.js`,
 * which imports pi, so the suite cannot `import` it. But a source pin proves the
 * text changed, not that the function runs — and AA4's edit deleted one more
 * line than it meant to. Removing the `parentIdle` ternary removed the
 * `const ctx = getSessionCtx()` that fed it, and left three readers of `ctx`
 * below: the result cap and both notify calls.
 *
 * Nothing caught it. `npm run lint` is `node --check` (syntax only), pi loads
 * `.ts` through jiti, which strips types without checking them, and the pin
 * above was satisfied — the ternary really was gone and `const deliverAs =
 * "followUp"` really was there. So `emitIndividualNudge` threw
 * `ReferenceError: ctx is not defined` on its FIRST use of `ctx`, three lines
 * before `pi.sendMessage`, and the catch below it — written for a stale runtime
 * — reported "Result available" to a UI that is `() => {}` headless. Every
 * background subagent's answer, and every continuation's, stopped reaching the
 * parent model from the tenth pass onward.
 *
 * The probes already load pi-importing modules through pi's own bundled jiti
 * (`h6`, `l6`, `m1`, `m2`). So does this, and the rule it leaves behind is: a
 * fix whose test cannot EXECUTE the function it is about is pinned against
 * editing, not against breaking.
 *
 * See AC1 in `context/design/subagents-loop-verifier-deliveries.md`.
 */
describe("AC1 — the background result reaches the parent", () => {
  const PI_ENTRY = "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
  const JITI = "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";
  const SRC = fileURLToPath(new URL("../src", import.meta.url));

  /** A settled background record, and the shell state the nudge reads at call time. */
  async function harness(answer: string, percentUsed = 24) {
    const { createJiti } = await import(JITI);
    const jiti = createJiti(`file://${PI_ENTRY}`, {
      interopDefault: true,
      alias: { "@earendil-works/pi-coding-agent": PI_ENTRY },
    });
    const shell = await jiti.import(`${SRC}/shell.ts`);
    const { SpawnCoordinator } = await jiti.import(`${SRC}/spawn/spawn-coordinator.ts`);

    const sent: { content: string; options: unknown }[] = [];
    const notices: string[] = [];
    const ctx = {
      ui: { notify: (m: unknown) => notices.push(String(m)) },
      model: { contextWindow: 32_768 },
      getContextUsage: () => ({
        tokens: Math.round((32_768 * percentUsed) / 100),
        contextWindow: 32_768,
        percent: percentUsed,
      }),
      isIdle: () => true,
    };
    shell.setPiInstance({
      sendMessage: (m: { content: string }, options: unknown) => sent.push({ content: m.content, options }),
    });
    shell.setSessionCtx(ctx);

    const record = {
      id: "agent-0123456789ab",
      result: answer,
      verification: "passed",
      lifecycle: { status: "completed", startedAt: Date.now() - 5_000, completedAt: Date.now(), started: true },
      display: { type: "general-purpose", description: "read the parser" },
      execution: { modelKey: "forge/local", settled: true, settlementCount: 1, brief: "b", spawnCtx: ctx },
      stats: {
        lifetimeUsage: { input: 10, output: 20, cacheWrite: 0, cacheRead: 0, cost: 0 },
        toolUses: 1,
        turnCount: 2,
        compactionCount: 0,
      },
    };
    const coordinator = new SpawnCoordinator({ getRecord: (id: string) => (id === record.id ? record : undefined) });
    return { coordinator, record, sent, notices, shell };
  }

  it("injects the answer into the parent's session", async () => {
    const { coordinator, record, sent } = await harness("src/parser.ts exports parse() and tokenize().");
    coordinator.emitIndividualNudge(record.id);

    assert.equal(sent.length, 1, "the parent model must be given the result it did not block on");
    assert.match(sent[0].content, /exports parse\(\) and tokenize\(\)/);
    assert.deepEqual(sent[0].options, { deliverAs: "followUp", triggerTurn: true });
  });

  it("caps it against the parent's remaining window on the way in", async () => {
    // 90% used: the allowance is small, the answer is not, so the cap applies —
    // which is the OTHER thing the missing binding switched off.
    const { coordinator, record, sent, notices } = await harness("w".repeat(60_000), 90);
    coordinator.emitIndividualNudge(record.id);

    assert.equal(sent.length, 1);
    assert.ok(sent[0].content.length < 60_000, "an uncapped 60k result is the incident the cap exists for");
    assert.ok(
      notices.some((n) => /capped/i.test(n)),
      "the cap reports through the SESSION ctx — the binding this test exists for",
    );
  });

  it("control — no record, no message", async () => {
    const { coordinator, sent } = await harness("x");
    coordinator.emitIndividualNudge("agent-does-not-exist");
    assert.equal(sent.length, 0);
  });

  it("control — a session ctx that is not there yet still delivers", async () => {
    // `capBackgroundResult` takes `ExtensionContext | undefined` and never
    // throws, so the binding must be optional-safe as well as present.
    const { coordinator, record, sent, shell } = await harness("y");
    shell.setSessionCtx(undefined);
    coordinator.emitIndividualNudge(record.id);
    assert.equal(sent.length, 1, "a missing ctx bounds nothing; it must not lose the answer");
  });
});
