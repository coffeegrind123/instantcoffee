/**
 * _staged.mjs — a stand-in channel runtime the extension will actually accept.
 *
 * ## Why this file exists
 *
 * Nine probes drive `vendor/prinny-channel/extensions/index.ts` in-process
 * against `_sidecar.mjs`, which speaks the protocol without needing a
 * homeserver, an account and 105 MB of Matrix dependencies. Each one built its
 * own throwaway `PRINNY_STATE_DIR` and wrote a one-line stand-in at
 * `runtime/dist/server.js`, because that file was the whole of what
 * `runtimeState()` used to check:
 *
 * ```js
 *   existsSync(join(RUNTIME_DIR, "dist", "server.js"))
 * ```
 *
 * **AN2 (twenty-third pass) changed the question and nothing re-ran them.** A
 * staged runtime is now `absent` | `stale` | `current`, keyed on a content
 * fingerprint of `server/` written to `runtime/.source-stamp` — and
 * `startupBlocker()` refuses to start on `stale`, which is exactly what a
 * stand-in with no stamp is:
 *
 * ```js
 *   if (!existsSync(entryPath(runtimeDir))) return "absent"
 *   const stamp = readStamp(runtimeDir)
 *   if (stamp === undefined) return "stale"     ← every probe stand-in
 * ```
 *
 * So from AN2 onward those probes started a channel that immediately refused,
 * `sendUserMessage` was never called, every scenario ran against an extension
 * that had done nothing, and the failures read as findings about the code.
 * Measured 2026-08-23: **10 of 18** probes that load the prinny extension were
 * failing, and the box's real runtime was `current` the whole time — this was
 * never an unprepared checkout.
 *
 * The fix is one line per probe and it belongs in one place, because the next
 * change to what "ready" means will land the same way. `stageStandIn` asks the
 * shipped `runtime-stamp.mjs` for the fingerprint rather than writing a constant,
 * so a probe cannot go stale against a source change again.
 *
 * ## What it does NOT do
 *
 * It does not compile anything and it does not make the stand-in real. The
 * sidecar a probe runs is still `_sidecar.mjs`, selected with
 * `PRINNY_SIDECAR_ENTRY`; this only satisfies the readiness gate that stands in
 * front of spawning it. A probe that wants the genuine staged runtime should
 * point at `~/.pi/agent/channels/prinny/runtime` and say so — `ab4` and `ab6`
 * do, and they report honestly when it has not been prepared.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const REPO = "/home/claudeuser/qwen3.8-forge";
const PAYLOAD_ROOT = join(REPO, "vendor", "prinny-channel", "server");

const { sourceFingerprint, stagedState } = await import(
  `${PAYLOAD_ROOT}/bin/runtime-stamp.mjs`
);

/**
 * Make `<stateDir>/runtime` read as `current` to the shipped `runtimeState()`.
 *
 * Returns the state the extension will now see, so a caller can assert on it
 * rather than assume it — the assumption is what broke last time.
 */
export function stageStandIn(stateDir) {
  const runtime = join(stateDir, "runtime");
  mkdirSync(join(runtime, "dist"), { recursive: true });
  writeFileSync(join(runtime, "dist", "server.js"), "// stand-in for the built Matrix runtime\n");
  writeFileSync(join(runtime, ".source-stamp"), sourceFingerprint(PAYLOAD_ROOT));
  const state = stagedState(runtime, PAYLOAD_ROOT);
  // Throwing, not returning a bad state and hoping the caller looks. A probe
  // that silently ran against a refused channel is the whole reason this file
  // exists, and every one of the nine had a scenario that read as a finding.
  if (state !== "current") {
    throw new Error(
      `the stand-in runtime staged at ${runtime} reads as "${state}" to the shipped runtimeState(), so ` +
        "startupBlocker() would refuse to start the channel and every scenario below would run against " +
        "an extension that did nothing.",
    );
  }
  return state;
}

/** The credentials file `isConfigured()` looks for. The other startup blocker. */
export function writeCredentials(stateDir) {
  writeFileSync(
    join(stateDir, ".env"),
    "PRINNY_HOMESERVER=https://example.org\nPRINNY_USER_ID=@bot:example.org\nPRINNY_PASSWORD=x\n",
    { mode: 0o600 },
  );
}

/**
 * Everything the extension needs before `session_start` will get past
 * `startupBlocker()`: credentials, a runtime it accepts, and an empty inbox and
 * outbox for `_sidecar.mjs`.
 *
 * Throws rather than returning a bad state — a probe that silently ran against a
 * refused channel is the whole reason this file is here.
 */
export function prepareStateDir(stateDir) {
  writeCredentials(stateDir);
  const state = stageStandIn(stateDir);
  const inbox = join(stateDir, "inbox.jsonl");
  const outbox = join(stateDir, "outbox.jsonl");
  writeFileSync(inbox, "");
  writeFileSync(outbox, "");
  return { inbox, outbox, runtime: join(stateDir, "runtime"), state };
}
