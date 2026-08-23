/**
 * aa3 — AN3, the device id a new token inherited.
 *
 * FIXED — the NOW column calls the REAL `credentialUpdatesForToken` from
 * `vendor/prinny-channel/src/config.ts`; the BEFORE column is the one expression
 * it replaced, `{ PRINNY_ACCESS_TOKEN: token }`. The merge into `.env` is
 * `updateEnv`'s, quoted from `extensions/index.ts` (that file imports pi-tui and
 * cannot be loaded here), and the device-id decision underneath is
 * `resolveDeviceId`'s, quoted from `server/src/server.ts`:
 *
 * ```js
 *   async function resolveDeviceId() {
 *     if (creds.deviceId) return creds.deviceId;      // ← never asks
 *     if (!creds.accessToken) return undefined;
 *     …/_matrix/client/v3/account/whoami…
 * ```
 *
 * Both quotes are pinned by `tests/token-device-id.test.ts`, so this probe and
 * the source cannot drift apart quietly.
 *
 *   run: node --experimental-strip-types aa3-the-device-id-a-new-token-inherited.mjs [rotate|first|switch]
 */

import { mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = "/home/claudeuser/qwen3.8-forge";
const { credentialUpdatesForToken } = await import(`${REPO}/vendor/prinny-channel/src/config.ts`);

const MODES = {
  /** A channel that has run before: a stored token AND a stored device. */
  rotate: {},
  /** The control: a first token, with no device stored yet. */
  first: {},
  /** The control the fix was copied from: the three-argument account switch. */
  switch: {},
};

const MODE = process.argv[2] ?? "rotate";
if (!MODES[MODE]) {
  console.error(`usage: node aa3-…mjs <${Object.keys(MODES).join("|")}>`);
  process.exit(2);
}

let failures = 0;
const check = (label, ok) => {
  console.log(`   ${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) failures++;
};

/** `updateEnv`, quoted from `extensions/index.ts`. `null` deletes the line. */
function updateEnv(file, updates) {
  let lines = [];
  try {
    lines = readFileSync(file, "utf8").split("\n");
  } catch {
    // First write.
  }
  for (const [key, value] of Object.entries(updates)) {
    const index = lines.findIndex((line) => new RegExp(`^\\s*${key}\\s*=`).test(line));
    if (value === null) {
      if (index >= 0) lines.splice(index, 1);
      continue;
    }
    if (index >= 0) lines[index] = `${key}=${value}`;
    else lines.push(`${key}=${value}`);
  }
  const body = lines.filter((line) => line.trim() !== "").join("\n");
  writeFileSync(`${file}.tmp`, `${body}\n`, { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

/** The env, read the way `loadEnvFile` reads it. */
function envOf(file) {
  const out = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const match = /^\s*(\w+)\s*=\s*(.*)$/.exec(line);
    if (match) out[match[1]] = match[2].trim();
  }
  return out;
}

/** `resolveDeviceId`, quoted. The stored id short-circuits everything below it. */
function resolveDeviceId(creds) {
  if (creds.PRINNY_DEVICE_ID) return { device: creds.PRINNY_DEVICE_ID, askedWhoami: false };
  if (!creds.PRINNY_ACCESS_TOKEN) return { device: undefined, askedWhoami: false };
  // The homeserver's answer for the NEW token, and the account check that rides
  // on the same call.
  return { device: "DEVICE_FOR_THE_NEW_TOKEN", askedWhoami: true };
}

const scratch = () => mkdtempSync(join(tmpdir(), "aa3-"));

console.log(`\naa3 [${MODE}] — the device id a new token inherited (AN3)\n`);

const STORED = [
  "PRINNY_HOMESERVER=https://matrix.example.org",
  "PRINNY_USER_ID=@pi:matrix.example.org",
  "PRINNY_PASSWORD=hunter2",
  "PRINNY_ACCESS_TOKEN=syt_the_old_one",
  "PRINNY_DEVICE_ID=OLDDEVICE",
].join("\n");

if (MODE === "switch") {
  console.log("   the three-argument `configure` with a DIFFERENT user id. This arm");
  console.log("   has always cleared both keys — it is where the fix came from.\n");
  const file = join(scratch(), ".env");
  writeFileSync(file, `${STORED}\n`);
  updateEnv(file, {
    PRINNY_HOMESERVER: "https://matrix.example.org",
    PRINNY_USER_ID: "@other:matrix.example.org",
    PRINNY_PASSWORD: "hunter3",
    PRINNY_ACCESS_TOKEN: null,
    PRINNY_DEVICE_ID: null,
  });
  const env = envOf(file);
  console.log(`   PRINNY_ACCESS_TOKEN : ${env.PRINNY_ACCESS_TOKEN ?? "(cleared)"}`);
  console.log(`   PRINNY_DEVICE_ID    : ${env.PRINNY_DEVICE_ID ?? "(cleared)"}\n`);
  check("the old token is gone", env.PRINNY_ACCESS_TOKEN === undefined);
  check("the old device is gone", env.PRINNY_DEVICE_ID === undefined);
} else {
  const stored = MODE === "rotate" ? STORED : STORED.split("\n").slice(0, 3).join("\n");
  console.log(
    MODE === "rotate"
      ? "   `/prinny configure token syt_the_new_one` on a channel that has run\n   before, so a device id is stored.\n"
      : "   `/prinny configure token syt_the_new_one` on a channel that has never\n   minted a device. The control.\n",
  );

  const results = {};
  for (const [label, updates] of [
    ["BEFORE", { PRINNY_ACCESS_TOKEN: "syt_the_new_one" }],
    ["NOW", credentialUpdatesForToken("syt_the_new_one")],
  ]) {
    const file = join(scratch(), ".env");
    writeFileSync(file, `${stored}\n`);
    updateEnv(file, updates);
    const env = envOf(file);
    const resolved = resolveDeviceId(env);
    results[label] = { env, resolved };
    console.log(`   ${label}`);
    console.log(`     PRINNY_ACCESS_TOKEN  : ${env.PRINNY_ACCESS_TOKEN}`);
    console.log(`     PRINNY_DEVICE_ID     : ${env.PRINNY_DEVICE_ID ?? "(cleared)"}`);
    console.log(`     next start resolves  : ${resolved.device ?? "(none)"}`);
    console.log(`     …by asking whoami    : ${resolved.askedWhoami ? "yes" : "NO — it used the stored one"}`);
    console.log(`     token/device match   : ${resolved.askedWhoami || !env.PRINNY_DEVICE_ID ? "yes" : "NO"}`);
    console.log("");
  }

  if (MODE === "rotate") {
    check("BEFORE the new token kept the old device", results.BEFORE.env.PRINNY_DEVICE_ID === "OLDDEVICE");
    check("BEFORE the whoami lookup was skipped", results.BEFORE.resolved.askedWhoami === false);
    check("…so the account check that rides on it was skipped too", results.BEFORE.resolved.askedWhoami === false);
    check("NOW the device id is cleared with the token", results.NOW.env.PRINNY_DEVICE_ID === undefined);
    check("NOW the next start asks the homeserver", results.NOW.resolved.askedWhoami === true);
    check("…and gets the device that goes with THIS token", results.NOW.resolved.device === "DEVICE_FOR_THE_NEW_TOKEN");
    check("the token itself is written either way", results.BEFORE.env.PRINNY_ACCESS_TOKEN === "syt_the_new_one");
  } else {
    check("with no device stored, both columns ask whoami", results.BEFORE.resolved.askedWhoami && results.NOW.resolved.askedWhoami);
    check("…and both get the same answer", results.BEFORE.resolved.device === results.NOW.resolved.device);
  }
}

console.log("");
process.exit(failures === 0 ? 0 : 1);
