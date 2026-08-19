/**
 * j7 — V7. The judge's session is disposed on the path where `runAgent` returns,
 *      and on no other. A rejection leaks it.
 *
 * The judge deliberately goes around `spawn()`, so there is no AgentRecord and
 * nothing in `dispose()` or `clear()` can ever reach the session — the `finally`
 * in `buildVerifyDeps.judge` IS the whole teardown, and its own comment says so.
 * It reads `result?.session`, and `result` is only assigned when the await
 * resolves.
 *
 * `runAgent` -> `runAgentImpl` creates the session (`createAgentSession`), binds
 * its extensions, and only then prompts. Anything that rejects after the session
 * exists — `bindExtensions` throwing, `session.prompt()` rejecting on a provider
 * fault — drops the only reference to a live session with its message history
 * and its bound extensions, for the life of the process.
 *
 * A timeout does NOT leak: the deadline aborts the signal, `session.prompt()`
 * resolves, `result` is assigned, and `assertNotExpired()` throws afterwards.
 *
 * Source-pinned rather than driven: `agent-manager.ts` imports pi, which does not
 * resolve under the plain node the probes run on.
 *
 * FIXED. The session is captured in `onSessionCreated`, which fires inside
 * `createAndConfigureSession` before `bindExtensions` returns, so the `finally`
 * has a reference on every exit. A source pin lives in
 * `tests/turn-tracking.test.ts` next to U8's, because this file imports pi.
 *
 *   node j7-judge-session-leaks-on-throw.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "../../../vendor/pi-subagents-lite/src/agents/agent-manager.ts");
const src = readFileSync(SRC, "utf8");

console.log("=== the judge's teardown, as it is written ===\n");
const start = src.indexOf("      judge: async (prompt: string) => {");
const end = src.indexOf("      repair: async (prompt: string) => {");
for (const line of src.slice(start, end).split("\n")) {
  if (!line.trim() || /^\s*(\/\/|\/\*|\*)/.test(line)) continue;
  console.log("  " + line.replace(/^ {6}/, ""));
}

console.log(`
=== the three ways runAgent can end ===

                        BEFORE                            NOW
  resolves normally     result.session.dispose()    ok    judgeSession.dispose()  ok
  resolves aborted      result.session.dispose()    ok    judgeSession.dispose()  ok
  REJECTS               nothing disposed          LEAK    judgeSession.dispose()  ok

=== the replay, on both shapes ===`);

const session = (log) => ({ dispose: () => log.push("disposed") });

/** The shape as it was: the teardown reads the run's result. */
async function beforeShape(runAgent) {
  let result;
  try {
    result = await runAgent();
    return result.responseText;
  } finally {
    try { result?.session?.dispose(); } catch {}
  }
}

/** The shape as it is: the teardown reads what onSessionCreated handed back. */
async function nowShape(runAgent) {
  let judgeSession;
  try {
    const result = await runAgent({ onSessionCreated: (s) => { judgeSession = s; } });
    return result.responseText;
  } finally {
    try { judgeSession?.dispose(); } catch {}
  }
}

for (const [label, shape] of [["BEFORE", beforeShape], ["NOW", nowShape]]) {
  const answered = [];
  const threw = [];
  await shape(async (opts) => {
    const s = session(answered);
    opts?.onSessionCreated?.(s);
    return { responseText: "VERDICT: ADDRESSED", session: s };
  });
  await shape(async (opts) => {
    const s = session(threw);
    opts?.onSessionCreated?.(s);
    throw new Error("llama-server closed the connection");
  }).catch(() => {});
  console.log(`\n  ${label}`);
  console.log(`    a judge that answered : ${answered.length ? "disposed" : "LEAKED"}`);
  console.log(`    a judge that threw    : ${threw.length ? "disposed" : "LEAKED"}`);
}

console.log(`
  The comment above the block is the argument for the fix and for the finding:

    "Going around spawn() also means going around every teardown spawn() would
     have arranged: no record, so nothing in dispose() or clear() ever reaches
     this session. Disposing it here is the whole cleanup — without it every
     judged answer leaks one AgentSession, its message history and its bound
     extensions, for the life of the process."`);
