/**
 * s3 — AF6. The tool output the cap was exempting is the one it was built for.
 * FIXED — this probe prints BEFORE and NOW side by side.
 *
 * `.pi/extensions/compaction-guard` exists because of one measured incident: at
 * 84.5% of a 32,768-token window the model ran a curl loop, the result was
 * 17,790 characters, the context went to 100% and the next turn came back empty.
 * The cap bounds a single tool result to a share of what is LEFT.
 *
 * Its handler began:
 *
 *     // An error is short and is the one thing worth reading in full.
 *     if ((event as { isError?: boolean }).isError) return undefined;
 *
 * That is a claim about the host, and the host says otherwise. pi's bash tool
 * (`dist/core/tools/bash.js`) formats the WHOLE captured output — its own bound
 * is 2,000 lines or 50 KB — and then, for a non-zero exit, throws it:
 *
 *     const { text: outputText, details } = formatOutput(snapshot);
 *     if (exitCode !== 0 && exitCode !== null) {
 *         throw new Error(appendStatus(outputText, `Command exited with code ${exitCode}`));
 *     }
 *
 * `executePreparedToolCall` catches that and builds
 * `createErrorToolResult(error.message)` — one text block, `isError: true` — so
 * on this stack `isError` means "the command failed", not "the message is
 * short", and up to ~12,500 tokens of a 32k window arrived exempt from the one
 * mechanism that bounds a tool result.
 *
 * And it is the ordinary case for the runs this extension exists for. An
 * unattended `/loop` fixing a failing test suite runs that suite every
 * iteration; every run of it while it is still failing is an error result.
 *
 * Driven against the SHIPPED handler, with pi's own bash source pinned above it.
 *
 *   run: node s3-the-output-that-was-an-error.mjs
 */

import { readFileSync } from "node:fs";

const REPO = "/home/claudeuser/qwen3.8-forge";
const PI_DIST = "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist";

let failures = 0;
const check = (label, ok) => {
  console.log(`   ${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) failures++;
};

console.log("\ns3 — a failing command's output, and the cap that let it through\n");

// ── what pi's bash tool does with a non-zero exit ────────────────────────────
{
  const bash = readFileSync(`${PI_DIST}/core/tools/bash.js`, "utf8");
  const at = bash.indexOf("if (exitCode !== 0 && exitCode !== null)");
  const lines = bash.slice(at - 120, at + 200).split("\n").map((l) => l.trim()).filter(Boolean);
  console.log(lines.slice(0, 5).map((l) => "   " + l).join("\n"));
  check("a non-zero exit throws the WHOLE formatted output", /appendStatus\(outputText/.test(bash.slice(at, at + 200)));

  const truncate = readFileSync(`${PI_DIST}/core/tools/truncate.js`, "utf8");
  const maxBytes = truncate.match(/DEFAULT_MAX_BYTES = (.+?);/)?.[1] ?? "?";
  const maxLines = truncate.match(/DEFAULT_MAX_LINES = (\d+)/)?.[1] ?? "?";
  console.log(`\n   bash's own bound: ${maxLines} lines or ${maxBytes.trim()} — so an error result can be 50 KB.\n`);
}

{
  const core = readFileSync(`${PI_DIST}/../node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js`, "utf8");
  const at = core.indexOf("function createErrorToolResult(message)");
  console.log(core.slice(at, at + 130).split("\n").map((l) => "   " + l.trim()).filter((l) => l.trim()).join("\n"));
  check(
    "…and the thrown message becomes the result's only text block, isError: true",
    /content: \[\{ type: "text", text: message \}\]/.test(core.slice(at, at + 200)),
  );
}

// ── the shipped handler ──────────────────────────────────────────────────────
const { createJiti } = await import(`${PI_DIST}/../node_modules/jiti/lib/jiti.mjs`);
const jiti = createJiti(`file://${PI_DIST}/index.js`, {
  interopDefault: true,
  alias: { "@earendil-works/pi-coding-agent": `${PI_DIST}/index.js` },
});
const guard = (await jiti.import(`${REPO}/.pi/extensions/compaction-guard/index.ts`)).default;

const handlers = new Map();
const notices = [];
const pi = { on: (name, fn) => handlers.set(name, [...(handlers.get(name) ?? []), fn]) };
const WINDOW = 32_768;
const PERCENT = 84.5;
const ctx = {
  ui: { notify: (message) => notices.push(String(message)) },
  model: { contextWindow: WINDOW },
  getContextUsage: () => ({ tokens: Math.round((WINDOW * PERCENT) / 100), contextWindow: WINDOW, percent: PERCENT }),
};
guard(pi);

/** What `npm test` hands back while the suite is still red. */
const FAILING = `${"FAIL tests/decode.test.ts › frame boundary — expected 3, received 4\n".repeat(260)}
Tests: 260 failed, 1188 passed
Command exited with code 1`;

async function capped(isError) {
  const event = {
    toolName: "bash",
    toolCallId: isError ? "call-fail" : "call-pass",
    isError,
    content: [{ type: "text", text: FAILING }],
  };
  let result;
  for (const fn of handlers.get("tool_result") ?? []) result = await fn(event, ctx);
  return result?.content?.[0]?.text;
}

const asError = await capped(true);
const asSuccess = await capped(false);

const tokens = (chars) => Math.round(chars / 4);
console.log(`
     the result                 : ${FAILING.length} chars (~${tokens(FAILING.length)} tokens of a ${WINDOW}-token window)
     the context before it      : ${PERCENT}% used

     BEFORE  isError: true  →  passed through at ${FAILING.length} chars, untouched
     NOW     isError: true  →  ${asError.length} chars
             isError: false →  ${asSuccess.length} chars   (unchanged, and the control)
`);

check("a failing command's output is capped", asError.length < FAILING.length);
check("by the same rule as a successful one", Math.abs(asError.length - asSuccess.length) < 40);
check("the head is kept — what the command was doing", asError.startsWith("FAIL tests/decode.test.ts"));
check("and the tail — how it ended, which for an error is the point", /Command exited with code 1$/.test(asError));
check("the rest is recoverable rather than lost", /Full output: \S+pi-tool-output-\S+\.txt/.test(asError));
check("the operator is told", notices.some((line) => /capped bash output/.test(line)));

// The control that keeps the exemption's original intent: a short error is
// still handed over whole.
const short = "ENOENT: no such file or directory, open 'nope.txt'\nCommand exited with code 1";
let shortResult;
for (const fn of handlers.get("tool_result") ?? []) {
  shortResult = await fn(
    { toolName: "bash", toolCallId: "call-short", isError: true, content: [{ type: "text", text: short }] },
    ctx,
  );
}
check("control — a short error is not rewritten at all", shortResult === undefined);

console.log("");
if (failures > 0) {
  console.log(`   ${failures} expectation(s) failed`);
  process.exit(1);
}
console.log("   all expectations held");
process.exit(0);
