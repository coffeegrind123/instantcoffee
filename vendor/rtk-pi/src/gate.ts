// The filtering gate: which bash commands are handed to rtk, and what is
// accepted back from it.
//
// Kept clear of any pi import so it can be tested with bare node — the same
// split vendor/pi-loop-mode uses. extensions/index.ts is the pi-coupled half and
// holds no decisions of its own.
//
// Adding a command here is a deliberate act. Measure it first — run the real
// command and `rtk <command>` side by side and diff them — then add it, with the
// measurement in the comment. ../FORK.md says how, and `./scripts/rtk.sh --check`
// re-runs every measurement below against the installed binary.

// Commands whose rtk filter has been checked against the real command's output.
// Matched as a token-boundary prefix, so "git status" covers "git status -s" but
// never "git stash". Percentages are bash-output bytes removed, measured in this
// repo on 2026-08-16 against rtk 0.45.0.
//
// Deliberately NOT here, and why (all measured, same day, same binary):
//   ls                  Helps the verbose forms and hurts the compact ones:
//                       `ls -la` 1125 -> 348 bytes, but `ls -1` 123 -> 242,
//                       because the filter adds sizes and shows dotfiles. Not
//                       wrong — it agrees with `ls -1A` minus .git — just not
//                       reliably a saving.
//   cat, head, tail     Rewritten to `rtk read`, which returned the file byte
//                       for byte at every size tried, up to 180 KB / 15k lines.
//                       0% saved, so denying it costs nothing — and the README
//                       advertises "signatures and structure over full bodies",
//                       so today's losslessness is undocumented and could turn
//                       off in a point release. This stack's known failure mode
//                       is an edit whose old_string does not match the file, and
//                       a summarised read is exactly how that starts.
//   grep, rg            0% and -6% on this repo. Faithful — `grep -rl` returned
//                       the same paths — but there is no gain to bank.
//   npm run, uv run     `npm run lint` -> `rtk lint`, which throws away the
//                       indirection: whatever the package's lint script actually
//                       runs is replaced by a bare eslint. `uv run pytest` ->
//                       `uv run rtk pytest`, which resolves a different pytest
//                       than the venv's.
//   npm test            no filter exists for it on 0.45.0 (docs say otherwise).
//   cargo nextest       likewise — neither the bare form nor `cargo nextest run`
//                       rewrites, despite being in the coverage table.
//   aws                 Upstream #3549: reports success for a cluster that does
//                       not exist. Not reproduced here, not worth reproducing.
export const ALLOW: readonly string[] = [
  "git status",       // 82%: 275 -> 49 bytes
  "git diff",         // 7%: context lines trimmed. Low value, verified faithful.
  "git show",         // same filter as diff
  "git log",          // 0% on --oneline; harmless, helps on verbose formats
  "git stash list",
  "find",             // 44-55%: grouped by directory above a certain tree size.
                      // Diffed the file sets on a 38-file tree — identical.
  "pytest",           // 64%: 1312 -> 476 on 43 tests. Counts correct, failures
                      // kept with tracebacks, full output tee'd to a file.
  "cargo test",
  "cargo build",
  "cargo check",
  "cargo clippy",
  "go test",
  "jest",
  "vitest",
  "tsc",
  "eslint",           // -> `rtk lint`, which is just the filter's name; args are
                      // preserved (`eslint src` -> `rtk lint src`). Not the same
                      // defect as `npm run lint`, where the indirection is what
                      // gets lost.
  "ruff check",       // bare `ruff` has no filter; `ruff check`/`format` do
  "ruff format",
  "docker ps",
  "gh pr view",
  "gh pr checks",
  "gh run list",
  "gh issue view",
]

// Shell syntax that means the output is going somewhere other than the model's
// eyes — a parser, a file, another command. rtk already declines most of these
// (`ls | wc -l` and `cargo test > out.txt` both came back "no rewrite"), but it
// accepted `git status && git log` and `echo hi; git status`, and a filter that
// is merely shorter is still wrong when something downstream is counting lines.
// Cheaper to refuse the whole class here than to track which members of it rtk
// currently gets right.
export const COMPOUND = /[|<>;&`\n]|\$\(/

// A leading VAR=value or a wrapper binary. rtk strips these before matching its
// own rules, which means a command can be rewritten under a prefix that changes
// what the rewrite means — `uv run pytest` is the worked example. The allow-list
// is written for bare invocations, so anything wearing a prefix is not the thing
// that was measured.
export const PREFIXED =
  /^(?:[A-Za-z_][A-Za-z0-9_]*=|sudo\b|env\b|time\b|timeout\b|nohup\b|xargs\b|nice\b|uv\b|npx\b|pnpm\b|yarn\b|poetry\b|pdm\b|hatch\b|bundle\b|rye\b)/

export function isAllowed(cmd: string): boolean {
  for (const prefix of ALLOW) {
    if (cmd === prefix) return true
    // Token boundary: "git status" must not match "git statusfoo".
    if (cmd.startsWith(prefix) && /\s/.test(cmd.charAt(prefix.length))) return true
  }
  return false
}

// The whole gate, in one place, so tests/gate.test.ts exercises what the handler
// actually runs rather than a restatement of it.
//
// Runs of whitespace are collapsed for the MATCH only — the original string is
// what gets sent to rtk. `git   status` is a command a model writes often
// enough, rtk normalises it happily (it answers `rtk git status`), and without
// this the allow-list would miss it and silently drop the saving. Collapsing
// only the decision keeps that from changing what actually runs.
export function shouldFilter(cmd: string): boolean {
  const trimmed = cmd.trim().replace(/[ \t]+/g, " ")
  if (trimmed === "") return false
  if (trimmed.startsWith("rtk ")) return false
  if (COMPOUND.test(trimmed)) return false
  if (PREFIXED.test(trimmed)) return false
  return isAllowed(trimmed)
}

// Pull the rewritten command out of rtk's stdout.
//
// Defence in depth, not a fix for a known bug: on 0.45.0 rtk's advisories go to
// stderr (verified with the streams separated and the ~/.local/share/rtk
// /.hook_warn_last stamp cleared first — an earlier reading of this that said
// "stdout" was an artefact of probing with 2>&1), so upstream's
// `result.stdout.trim()` is safe today.
//
// It is kept because the cost is a string comparison and the failure it guards
// is unbounded: whatever lands here is handed to a shell. Requiring the last
// non-empty line to start with "rtk " admits every valid rewrite of a bare
// allow-listed command and nothing else — not an advisory, not an error, and
// not a prefixed form like "uv run rtk pytest". Anything else is dropped and the
// command runs unfiltered.
export function extractRewrite(stdout: string): string | null {
  const lines = stdout.split("\n").map((l) => l.trim()).filter((l) => l !== "")
  if (lines.length === 0) return null
  const last = lines[lines.length - 1]
  if (!last.startsWith("rtk ")) return null
  if (COMPOUND.test(last)) return null
  return last
}

// Parse "X.Y.Z" semver, return [major, minor, patch] or null.
export function parseSemver(raw: string): [number, number, number] | null {
  const m = raw.trim().match(/(\d+)\.(\d+)\.(\d+)/)
  if (!m) return null
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)]
}

// The key `vendor/prinny-channel` stamps on a tool call a person has approved.
//
// Nineteenth pass (AJ3). `tool_call` handlers run in load order over ONE mutable
// `event.input`, and `scripts/pi-local.sh` loads prinny before this package. So
// the permission relay shows a Matrix approver `describeCall(...)` — the command
// exactly as the model wrote it — waits for a yes, and THEN this handler rewrites
// `event.input.command` to `rtk <something>`. The string that was approved and
// the string pi executed were two different commands, and the audit line in the
// channel log records the first one.
//
// The rewrite set is measured-faithful, so the damage is small; the promise is
// not. `permission-gate.ts`'s own docstring is explicit about what that prompt is
// for: "short enough to read on a phone and specific enough to decide on — an
// approval prompt that only names the tool is a prompt that gets approved without
// being read." Deciding on a string that is then edited is the same defect one
// step further in.
//
// So: an approved call is left exactly as approved. This is a stand-down, not a
// refusal — the command still runs, unfiltered, which is the direction every
// other decision in this file already fails in.
//
// The literal is duplicated rather than imported for the reason the compaction
// lock is a `globalThis` key with three copies of its protocol: vendor packages
// must not import each other, and this one is a fork of an upstream hook that
// knows nothing about Matrix. `tests/approved-command.test.ts` reads prinny's
// source and asserts the two agree.
export const APPROVED_COMMAND_KEY = "_prinnyApprovedCommand"

// True when a person has approved this call as written, so nothing may edit it.
//
// The PRESENCE of the stamp is the whole signal; the value (what the approver
// actually read) is kept for a human reading a transcript, not compared here.
// Anything can write a key onto a tool input, so a shape this function does not
// recognise reads as "not approved" — the direction that leaves rtk doing what it
// always did rather than silently switching itself off.
export function approvedAsWritten(input: unknown): boolean {
  if (!input || typeof input !== "object") return false
  const value = (input as Record<string, unknown>)[APPROVED_COMMAND_KEY]
  return typeof value === "string" && value.length > 0
}
