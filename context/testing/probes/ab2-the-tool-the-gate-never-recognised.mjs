/**
 * ab2 — AO2, the always-ask list that names a tool the gate does not know.
 *
 * FIXED — both columns are real and both run the SHIPPED module.
 *
 *   NOW     `needsApproval` from `vendor/prinny-channel/src/permission-gate.ts`,
 *           unchanged except that its first branch asks `namesTool`.
 *   BEFORE  `settings.permissionTools.includes(toolName)`, the expression that
 *           branch used to be — evaluated here against the same settings object
 *           the NOW column is given, so the two columns differ in one operator.
 *
 * `permissionTools` is the one entry in that function that fires in EVERY mode,
 * including `off`, and `parseSetting` accepts it unvalidated: split on commas,
 * trim, store. Every other setting in that switch is checked against its enum,
 * and every other allowlist in the package validates its entries and says why
 * (`MXID_RE`, `ROOM_ID_RE`). This one did not, and pi's tool names are not one
 * case.
 *
 *   run: node --experimental-strip-types ab2-the-tool-the-gate-never-recognised.mjs [off|all|store]
 */

const REPO = "/home/claudeuser/qwen3.8-forge";
const SRC = `${REPO}/vendor/prinny-channel/src`;
const { needsApproval, namesTool } = await import(`${SRC}/permission-gate.ts`);
const { parseSetting } = await import(`${SRC}/config.ts`);

/** The expression the first branch of `needsApproval` used to hold. */
const beforeMatch = (toolName, list) => list.includes(toolName);

/**
 * Tool names as they are actually registered in this stack, read off the
 * sources rather than remembered.
 *
 *   pi built-ins            agent-types.ts  BUILTIN_TOOL_NAMES
 *   this repo's own         registration.ts name: "Agent" | "StopAgent" | "AgentStatus"
 */
const REGISTERED = ["read", "bash", "edit", "write", "grep", "find", "ls", "Agent", "StopAgent", "AgentStatus"];

/** What an operator plausibly types, and which tool they meant. */
const TYPED = [
  ["Bash", "bash"],
  ["BASH", "bash"],
  ["Write", "write"],
  ["Edit", "edit"],
  ["agent", "Agent"],
  ["stopagent", "StopAgent"],
  ["bash", "bash"],
  ["write", "write"],
];

const MODES = { off: "off", all: "all", store: null };
const MODE = process.argv[2] ?? "off";
if (!(MODE in MODES)) {
  console.error(`usage: node ab2-…mjs <${Object.keys(MODES).join("|")}>`);
  process.exit(2);
}

let failures = 0;
const check = (label, ok) => {
  console.log(`   ${ok ? "ok  " : "FAIL"}  ${label}`);
  if (!ok) failures++;
};

console.log(`\nab2 [${MODE}] — the tool the always-ask list named and the gate did not know (AO2)\n`);

if (MODE === "store") {
  const parsed = parseSetting("permissionTools", "bash, Bash, BASH, write, write");
  console.log(`   /prinny set permissionTools "bash, Bash, BASH, write, write"`);
  console.log(`     BEFORE stored  ["bash","Bash","BASH","write","write"]   5 entries, 2 tools`);
  console.log(`     NOW    stored  ${JSON.stringify(parsed.value)}   ${parsed.value.length} entries, 2 tools\n`);
  check("the stored list is one entry per tool", parsed.value.length === 2);
  check("…and keeps the operator's own spelling", parsed.value[0] === "bash");
  process.exit(failures === 0 ? 0 : 1);
}

const mode = MODES[MODE];
// In `all` mode `bash`/`edit`/`write` gate on MUTATING_TOOLS whatever the list
// says, so the table there is restricted to the tools the MODE does not gate.
// A column that measures the mode is not a measurement of the list.
const rows = mode === "all" ? TYPED.filter(([, called]) => !["bash", "edit", "write"].includes(called)) : TYPED;
const exactlySpelled = rows.filter(([typed, called]) => typed === called).length;

console.log(`   permissionMode = "${mode}"${mode === "off" ? "   ← the always-ask list is the ONLY gate" : "   (mutating tools excluded: `all` gates those on its own)"}\n`);
console.log(`   typed by the operator   the tool pi calls    BEFORE    NOW`);

let beforeGated = 0;
let nowGated = 0;
for (const [typed, called] of rows) {
  const settings = { permissionMode: mode, permissionTools: [typed] };
  const before = beforeMatch(called, settings.permissionTools);
  const now = needsApproval(called, { command: "rm -rf /tmp/x" }, settings).gate === true;
  if (before) beforeGated++;
  if (now) nowGated++;
  console.log(
    `   ${typed.padEnd(22)}  ${called.padEnd(18)}  ${(before ? "gate" : "PASS ✘").padEnd(8)}  ${now ? "gate" : "PASS"}`,
  );
}

console.log("");
console.log(`   BEFORE gated ${beforeGated}/${rows.length} · NOW ${nowGated}/${rows.length}\n`);

check(
  `BEFORE only the ${exactlySpelled} exactly-spelled entries gated`,
  beforeGated === exactlySpelled,
);
check("NOW every spelling of a real tool gates", nowGated === rows.length);
check(
  "and nothing else moved: a tool nobody named is still not gated",
  needsApproval("read", {}, { permissionMode: mode, permissionTools: ["bash"] }).gate === (mode === "all" ? false : false),
);
check(
  "a name that is not a registered tool matches nothing — folding widens case, not the set",
  REGISTERED.every((tool) => namesTool(tool, ["definitely-not-a-tool"]) === false),
);

console.log("");
process.exit(failures === 0 ? 0 : 1);
