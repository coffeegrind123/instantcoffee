/**
 * w2 — AJ1. `/stack` from Matrix: advertised as a status readout, allowed in full.
 *
 * FIXED — this prints BEFORE and NOW side by side, so it is its own control.
 *
 * ## The two sentences
 *
 * `.pi/extensions/stack.ts` puts its whole command surface under a section
 * header that reads `--- user-only control ---`, and says so to the operator in
 * its own `/stack help`:
 *
 *   > The model can call stack_status to read the stack. It cannot change it:
 *   > every mutation above is a user-only command on purpose.
 *
 * The sidecar advertises the command to a Matrix client's `/` menu as:
 *
 *   > stack — Show local model stack status
 *
 * ## Where they are not true
 *
 * `MATRIX_ALLOWED` in `vendor/prinny-channel/src/command-routing.ts` had
 * `stack: null`, and `null` means the whole command. "User-only" had been
 * decided against the MODEL, which cannot type a slash command; the third actor
 * in this process — an allowlisted Matrix sender — reaches every subcommand
 * through `sendUserMessage(text, { expandPromptTemplates: true })` →
 * `prompt()` → `_tryExecuteExtensionCommand`.
 *
 * And every branch of `/stack` ends in `pi.exec`, which is AD6's own door:
 * `pi.exec` is `execCommand` and emits no `tool_call`, so `prinny-channel`'s
 * permission relay, `rtk-pi`'s gate and `compaction-guard`'s output cap all miss
 * it. AD6 refused `--check` on exactly that argument, one line up in the same
 * object.
 *
 *   run: node --experimental-strip-types w2-…mjs matrix
 *        node --experimental-strip-types w2-…mjs exec
 */

import { readFileSync } from "node:fs";

const REPO = "/home/claudeuser/qwen3.8-forge";

let failures = 0;
const check = (label, ok) => {
  console.log(`   ${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) failures++;
};

const MODES = ["matrix", "exec"];
const MODE = process.argv[2] ?? "matrix";
if (!MODES.includes(MODE)) {
  console.error(`usage: node --experimental-strip-types w2-…mjs <${MODES.join("|")}>`);
  process.exit(2);
}

const { classifyMatrixCommand, MATRIX_ALLOWED, MATRIX_DEFAULT_SUBCOMMAND, advertisedCommands } = await import(
  `${REPO}/vendor/prinny-channel/src/command-routing.ts`
);

console.log(`\nw2 [${MODE}] — /stack, and who is allowed to run it\n`);

/**
 * What each subcommand reaches, read out of `stack.ts` rather than restated.
 * The timeouts are the ones in the source; the third column is whether anything
 * stands between a Matrix message and the call.
 */
const SUBCOMMANDS = [
  ["status", "GET /props /slots /metrics · docker ps · docker exec nvidia-smi", "no"],
  ["help", "(prints a list)", "no"],
  ["env", "(reads .env; prints to the terminal only)", "no"],
  ["logs", "docker logs --tail 60 <container>", "no"],
  ["up", "bash scripts/up.sh                            900 s", "no"],
  ["smoke", "bash scripts/smoke-test.sh                    900 s", "no"],
  ["bench", "docker compose --build run bench <ARGS>     3,600 s", "no"],
  ["slots erase", "POST /slots/{id}?action=erase", "no"],
  ["down", "bash scripts/down.sh                          900 s", "ui.confirm"],
  ["restart llama", "compose up -d --force-recreate llama          600 s", "ui.confirm"],
  ["mode prose", "bash scripts/mode.sh <target>, then a recreate", "ui.confirm"],
  ["set CTX_SIZE=65536", "bash -c 'source lib.sh; env_set …'             20 s", "ui.confirm"],
  ["slots save", "POST /slots/{id}?action=save  (no client timeout)", "ui.confirm"],
];

if (MODE === "matrix") {
  const advertised = advertisedCommands().find((entry) => entry.command === "stack");
  console.log(`   the sidecar advertises it as : ${JSON.stringify(advertised?.description)}`);
  console.log(`   MATRIX_ALLOWED.stack         : ${JSON.stringify(MATRIX_ALLOWED.stack)}`);
  console.log(`   the bare form means          : ${JSON.stringify(MATRIX_DEFAULT_SUBCOMMAND.stack)}\n`);

  console.log("      /stack …                BEFORE   NOW       what it reaches");
  console.log("      ─────────────────────   ──────   ───────   ─────────────────────────────────────");
  for (const [sub, reaches, gate] of [["", "(defaults to status)", "no"], ...SUBCOMMANDS]) {
    const line = `/stack${sub ? ` ${sub}` : ""}`;
    const now = classifyMatrixCommand(line).kind;
    console.log(
      `      ${line.padEnd(21)}   ${"run".padEnd(6)}   ${now.padEnd(7)}   ${reaches}${gate === "no" ? "" : `  [${gate}]`}`,
    );
  }
  console.log("");

  const mutating = SUBCOMMANDS.filter(([sub]) => !["status", "help", "env", "logs"].includes(sub.split(" ")[0]));
  check(
    "every subcommand that runs something is refused",
    mutating.every(([sub]) => classifyMatrixCommand(`/stack ${sub}`).kind === "refuse"),
  );
  check("…including the four that had no confirmation at all", ["up", "smoke", "bench --repeat 3", "slots erase"].every(
    (sub) => classifyMatrixCommand(`/stack ${sub}`).kind === "refuse",
  ));
  check("the advertised form still works", classifyMatrixCommand("/stack").kind === "run");
  check("…and so does the one it defaults to", classifyMatrixCommand("/stack status").kind === "run");
  check("the refusal says what IS allowed", /\/stack status/.test(classifyMatrixCommand("/stack up").reason ?? ""));
  check(
    "…and names the route that still reaches the sender",
    /ordinary words/.test(classifyMatrixCommand("/stack up").reason ?? ""),
  );
  check("control — /loop is untouched", MATRIX_ALLOWED.loop === null && classifyMatrixCommand("/loop start x").kind === "run");

  console.log(`
   The BEFORE column is not a reconstruction: \`stack: null\` classified every one
   of these as \`run\`, and \`run\` means "hand it to pi", which for an EXTENSION
   command means execute it. Four of them had no confirmation of any kind. The
   other five had \`ctx.ui.confirm\` — a modal in the OPERATOR's terminal, with
   nothing in it saying a Matrix sender had asked, and \`false\` headless, so the
   same request was refused in \`pi -p\` and popped an unattributed dialog in a TUI.
`);
}

if (MODE === "exec") {
  // The other half of the finding, read out of stack.ts: this is the one command
  // in the stack whose body is `pi.exec` from end to end, and `pi.exec` is the
  // door AD6 named.
  const src = readFileSync(`${REPO}/.pi/extensions/stack.ts`, "utf8");
  const calls = [...src.matchAll(/pi\.exec\(\s*\n?\s*"([^"]+)"/g)].map((m) => m[1]);
  console.log(`   pi.exec sites in stack.ts    : ${calls.length}  (${[...new Set(calls)].join(", ")})`);

  const relay = readFileSync(`${REPO}/vendor/prinny-channel/extensions/index.ts`, "utf8");
  check("the permission relay is a tool_call handler, and only that", /pi\.on\('tool_call'/.test(relay));
  // The whole point: `/stack` never produces a `tool_call` event, so nothing
  // that reviews tool calls can review any of the nine commands above. (The one
  // `tool_call` string in this file is a llama capability flag, `supports_tool_calls`.)
  check("stack.ts registers no tool_call handler", !/pi\.on\(\s*["']tool_call/.test(src));
  check("…and every command it runs goes through pi.exec, which emits none", calls.length === 9);
  check("stack.ts still says its control surface is user-only", /user-only command on purpose/.test(src));
  check(
    "…and still labels the section that way",
    /--- user-only control/.test(src),
  );

  console.log("\n      subcommand              confirmation      reaches");
  console.log("      ─────────────────────   ───────────────   ──────────────────────────────────────");
  for (const [sub, reaches, gate] of SUBCOMMANDS) {
    console.log(`      ${sub.padEnd(21)}   ${(gate === "no" ? "—" : gate).padEnd(15)}   ${reaches}`);
  }

  console.log(`
   \`ctx.ui.confirm\` is the strongest gate in this file and it is not a gate
   against a REMOTE caller: it asks whoever is at the keyboard, about a request
   they did not make, without saying who did. Refusing the subcommand in the
   routing table is what removes the question rather than mis-addressing it.

   The read-only need is already met, and by a better route: \`stack_status\` is a
   model-callable tool whose whole surface is HEADLINE_KEYS — a fixed list of
   nineteen harmless settings — so a Matrix sender who asks "is the model up?" in
   ordinary words gets an answer that actually reaches them. A \`/stack status\`
   from Matrix writes a \`stack-report\` ENTRY, which is rendered in the terminal
   and sent nowhere.
`);
}

console.log("");
if (failures > 0) {
  console.log(`   ${failures} expectation(s) failed`);
  process.exit(1);
}
console.log("   all expectations held");
process.exit(0);
