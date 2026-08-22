/**
 * x4 — AK3. A request from the sidecar, read as a reply to ours.
 *
 * FIXED — this drives the REAL `McpChild` against a real child process, in both
 * orders, so BEFORE is a measurement rather than a reconstruction: the probe
 * loads the module, then loads a copy of it with the two branches swapped back,
 * and runs the identical scenario through each.
 *
 * ## The finding
 *
 * JSON-RPC gives a server-initiated REQUEST both an `id` and a `method`.
 * `dispatch` branched on `typeof id === "number"` first, so such a message was
 * looked up in `pending` and, on a hit, `pending.resolve(message.result)` —
 * with `message.result` undefined. The client's own outstanding call therefore
 * resolved with nothing, no error, and no sign anything had gone wrong.
 *
 * `nextId` starts at 1 and `initialize` is the first thing this client sends,
 * so the first server request in a fresh process would have resolved the
 * HANDSHAKE.
 *
 * The `method not found` reply was already in the file, written for exactly
 * this case — its own comment says "a server-initiated *request* (has an id)" —
 * and it could not be reached with a numeric id, which is the only kind
 * anything sends. The guard existed; the path to it did not.
 *
 *   run: node --experimental-strip-types x4-the-request-read-as-a-reply.mjs
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = "/home/claudeuser/qwen3.8-forge";
const SOURCE = `${REPO}/vendor/prinny-channel/src/mcp-stdio.ts`;
const FAKE = `${REPO}/vendor/prinny-channel/tests/fixtures/fake-sidecar.mjs`;

let failures = 0;
const check = (label, ok) => {
  console.log(`   ${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) failures++;
};

console.log("\nx4 — a request from the sidecar is not a reply to ours (AK3)\n");

/** The shipped module, and a copy with the two branches in the old order. */
async function loadBoth() {
  const text = readFileSync(SOURCE, "utf8");
  const methodStart = text.indexOf("    // `method` FIRST, and the order is the whole of the fix.");
  const idStart = text.indexOf("    const id = message.id;\n    if (typeof id === 'number') {", methodStart);
  const idEnd = text.indexOf("      return;\n    }\n  }", idStart) + "      return;\n    }\n".length;
  if (methodStart < 0 || idStart < 0) throw new Error("could not find the two branches — has dispatch moved?");
  const methodBlock = text.slice(methodStart, idStart);
  const idBlock = text.slice(idStart, idEnd);
  const reverted = text.slice(0, methodStart) + idBlock + "\n" + methodBlock + text.slice(idEnd);

  const dir = mkdtempSync(join(tmpdir(), "probe-ak3-"));
  const file = join(dir, "mcp-stdio.ts");
  writeFileSync(file, reverted);
  return {
    now: (await import(SOURCE)).McpChild,
    before: (await import(file)).McpChild,
  };
}

const { now: NowChild, before: BeforeChild } = await loadBoth();

/**
 * One `tools/call` against a sidecar that answers it with a REQUEST wearing the
 * same id, which is what a JSON-RPC server does when it asks the client
 * something while a call is outstanding.
 */
async function run(McpChild, label) {
  const stderr = [];
  const child = new McpChild({
    command: process.execPath,
    args: [FAKE],
    env: { PRINNY_FAKE_MODE: "serverrequest" },
    onStderr: (line) => stderr.push(line),
    onExit: () => undefined,
    onNotification: () => undefined,
    connectTimeoutMs: 20_000,
    requestTimeoutMs: 1_200,
    clientName: "probe",
    clientVersion: "0.0.0",
  });
  await child.start();
  const started = Date.now();
  let outcome;
  try {
    const result = await child.callTool("reply", { room_id: "!r:x", text: "the answer" });
    outcome = { kind: "resolved", value: result };
  } catch (err) {
    outcome = { kind: "rejected", why: err.message };
  }
  const ms = Date.now() - started;
  await new Promise((resolve) => setTimeout(resolve, 150));
  await child.stop(500).catch(() => undefined);

  console.log(`   ${label}`);
  if (outcome.kind === "resolved") {
    console.log(`     the call RESOLVED after ${ms}ms with ${JSON.stringify(outcome.value)}`);
    console.log("     — an empty success, for a call the sidecar never ran.");
  } else {
    console.log(`     the call rejected after ${ms}ms: ${outcome.why}`);
  }
  const replied = stderr.join("").includes("client-reply");
  console.log(`     the server's request was ${replied ? "answered" : "NOT answered"}\n`);
  return { outcome, replied, stderr: stderr.join("") };
}

const before = await run(BeforeChild, "BEFORE — id first:");
const after = await run(NowChild, "NOW — method first:");

check("BEFORE: the outstanding call resolved on the server's request", before.outcome.kind === "resolved");
check("BEFORE: …with an empty result nobody could tell from a real one", JSON.stringify(before.outcome.value ?? {}) === '{"content":[]}');
check("BEFORE: …and the request itself was never answered", !before.replied);

check("NOW: the outstanding call is not resolved by it", after.outcome.kind === "rejected");
check("NOW: …it times out, which is what an unanswered call should do", after.outcome.why.includes("tools/call timed out"));
check("NOW: …and the request gets the answer the code always meant to send", after.replied);
check("NOW: …which is a JSON-RPC 'method not found'", after.stderr.includes("-32601") && after.stderr.includes("method not found: ping"));

console.log(failures === 0 ? "\n   all expectations held\n" : `\n   ${failures} expectation(s) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
