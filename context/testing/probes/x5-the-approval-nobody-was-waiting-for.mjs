/**
 * x5 — AK4. The prompt that stayed answerable, and the outcome it reported.
 *
 * FIXED — BEFORE is the plain `Map` this used to be, run beside the real
 * `PermissionRegistry` over the same sequence, so both columns are measured.
 *
 * ## The finding
 *
 * The extension's `requestApproval` **fails closed on a timeout**: after
 * `permissionTimeoutSeconds` it drops its own pending entry, resolves
 * `timeout`, and the tool call is BLOCKED. It told the sidecar nothing.
 *
 * So on the sidecar side the prompt lived for the life of the process — one
 * entry per unanswered request, each holding up to 4,000 characters of
 * `input_preview`, which for a `write` call is the file's entire contents — and
 * the Allow/Deny buttons stayed live in every paired sender's room.
 *
 * The leak is the small half. Pressing Allow on one of those answered the
 * callback `✅ Allowed` and edited the room's own record of the decision to say
 * so, for a command that had already been blocked. The extension logs the late
 * reply as `permission decision for unknown request` and does nothing —
 * correctly — so the only lasting account of what happened was the one in the
 * room, and it said the opposite of the truth.
 *
 *   run: node x5-the-approval-nobody-was-waiting-for.mjs
 */

import { readFileSync } from "node:fs";

const REPO = "/home/claudeuser/qwen3.8-forge";
const DIST = `${process.env.HOME}/.pi/agent/channels/prinny/runtime/dist`;

let failures = 0;
const check = (label, ok) => {
  console.log(`   ${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) failures++;
};

console.log("\nx5 — the approval nobody was waiting for (AK4)\n");

const { PermissionRegistry, DEFAULT_PERMISSION_TTL_MS, EXPIRED_PERMISSION_MESSAGE } = await import(
  `${DIST}/permissions.js`
);

/** What the extension actually sends, and how long it actually waits. */
const TIMEOUT_MS = 300_000;
const PROMPT = {
  tool_name: "bash",
  description: "recursive force delete: rm -rf /home/claudeuser/qwen3.8-forge/vendor",
  input_preview: JSON.stringify({ command: "rm -rf /home/claudeuser/qwen3.8-forge/vendor" }, null, 2),
};

// ── BEFORE: a plain Map, exactly as it was ──────────────────────────────────
const before = new Map();
before.set("abcde", PROMPT);

// ── NOW: the registry, told how long pi will wait ───────────────────────────
const now = new PermissionRegistry();
const t0 = 1_000_000;
now.add("abcde", PROMPT, TIMEOUT_MS, t0);

const AN_HOUR = 3_600_000;
const pressAt = t0 + AN_HOUR;

console.log("   a prompt is sent, nobody answers, pi blocks the call after 300s.");
console.log("   an hour later somebody presses Allow in their Matrix client:\n");

const beforeDetails = before.get("abcde");
console.log(`     BEFORE  the sidecar still had it: ${Boolean(beforeDetails)}`);
console.log("             → decidePermission fires, the room is edited to read");
console.log("               \"🔐 Permission: **bash**  ✅ Allowed\"");
console.log("             → the extension logs \"decision for unknown request\" and");
console.log("               does nothing, because the call was blocked 55 minutes ago.\n");

const nowDetails = now.live("abcde", pressAt);
console.log(`     NOW     the sidecar still has it: ${Boolean(nowDetails)}`);
console.log(`             → the room is edited to read:`);
console.log(`               "${EXPIRED_PERMISSION_MESSAGE}"\n`);

check("BEFORE: a dead prompt was indistinguishable from a live one", Boolean(beforeDetails));
check("NOW: it is not", nowDetails === undefined);
check("…and what the room is told says nothing ran", EXPIRED_PERMISSION_MESSAGE.includes("Nothing was run"));

// ── the two sides stop waiting at the same instant ──────────────────────────
console.log("   the boundary, since both sides have to agree on it:");
for (const at of [TIMEOUT_MS - 1, TIMEOUT_MS, TIMEOUT_MS + 1]) {
  const fresh = new PermissionRegistry();
  fresh.add("abcde", PROMPT, TIMEOUT_MS, 0);
  console.log(`     t=${String(at).padStart(7)}ms  ${fresh.live("abcde", at) ? "live" : "expired"}`);
}
const edge = new PermissionRegistry();
edge.add("abcde", PROMPT, TIMEOUT_MS, 0);
check("live one millisecond before pi gives up", Boolean(edge.live("abcde", TIMEOUT_MS - 1)));
check("expired at exactly the moment pi gives up", edge.live("abcde", TIMEOUT_MS) === undefined);

// ── the leak, over a day of an unattended run ───────────────────────────────
console.log("\n   an unattended run: one dangerous command an hour, nobody at the phone.");
const day = new PermissionRegistry();
const leaked = new Map();
for (let hour = 0; hour < 24; hour++) {
  const at = hour * AN_HOUR;
  day.add(`id${hour}`, PROMPT, TIMEOUT_MS, at);
  leaked.set(`id${hour}`, PROMPT);
}
const bytes = (n) => `${Math.round((n * JSON.stringify(PROMPT).length) / 1024)} KB`;
console.log(`     BEFORE  ${leaked.size} prompts held, ~${bytes(leaked.size)} of tool input`);
console.log(`     NOW     ${day.size} prompt held,  ~${bytes(day.size)}\n`);
check("BEFORE: every prompt of the day is still held", leaked.size === 24);
check("NOW: only the one still worth answering is", day.size === 1);

// ── and the extension now tells the sidecar how long it will wait ───────────
const extension = readFileSync(`${REPO}/vendor/prinny-channel/extensions/index.ts`, "utf8");
const request = extension.slice(extension.indexOf("'notifications/claude/channel/permission_request'"));
check("the request carries timeout_ms", request.slice(0, 900).includes("timeout_ms: timeoutMs"));
check(
  "…and the sidecar falls back to the extension's own default without it",
  DEFAULT_PERMISSION_TTL_MS === TIMEOUT_MS,
);

console.log(failures === 0 ? "\n   all expectations held\n" : `\n   ${failures} expectation(s) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
