# rtk-pi — forge fork

Forked from [`rtk-ai/rtk`](https://github.com/rtk-ai/rtk) `hooks/pi/rtk.ts` at
v0.45.0 (Apache-2.0). Vendored rather than installed with `rtk init --agent pi`
because that command writes `.pi/extensions/rtk.ts` into whichever project pi was
started in — and pi is started in *your* project, not in this checkout. Every
other extension here is loaded by absolute path for the same reason.

`scripts/pi-local.sh` loads it as:

```
-e vendor/rtk-pi/extensions/index.ts
```

Nothing needs installing on the node side. The extension's only bare imports are
pi's own package (one `import type`, erased before it runs, and
`isToolCallEventType`), which pi resolves from its own module root. The `rtk`
binary itself is a separate, pinned artifact — `./scripts/rtk.sh --install`.

## Why this is here at all

`CTX_SIZE=32768`. Bash output is not billed on this stack, it is *rented* — every
byte of `pytest` chatter is a byte that is not the file the model was asked to
read. This is the same trade the repo already makes for MCP (19k tokens of tool
schemas down to ~120), applied to the other big consumer.

Measured in this repo on 2026-08-16 against rtk 0.45.0:

| command | raw | filtered | saved | on the allow-list |
| --- | --- | --- | --- | --- |
| `git status` | 275 B | 49 B | 82% | yes |
| `pytest -q` (43 tests, 3 failing) | 1312 B | 476 B | 64% | yes |
| `find vendor -name '*.ts'` | 1718 B | 773 B | 55% | yes |
| `ls -la` | 1125 B | 348 B | 69% | no — see below |
| `git diff HEAD~1` | 2384 B | 2213 B | 7% | yes |
| `git log --oneline -20` | 1570 B | 1570 B | 0% | yes |
| `grep -rn env_get scripts` | 3286 B | 3286 B | 0% | no |
| `cat README.md` | 67652 B | 67652 B | 0% | no |
| `ls -1` | 123 B | 242 B | **-97%** | no |

The headline "up to 90%" is real but narrow. `git status`, `find` and the test
runners carry it; several advertised filters do nothing on a repo shaped like
this one, and one makes the output bigger. The pytest filter keeps the counts,
keeps the failing tracebacks, and writes the full output to a tee file whose path
it prints — which is the design that makes a lossy filter safe on a failure path.

Two entries in the coverage table have no filter at all on 0.45.0: `npm test` and
`cargo nextest` (bare or `run`) both come back "no rewrite". They were on this
allow-list until `--check` said otherwise.

## What was changed, and why

Upstream's extension is a thin delegate: it hands **every** bash command to
`rtk rewrite` and applies whatever comes back. One measured problem with that
(§1), plus two guards that cost nothing and bound what a future rtk can do
(§2, §3).

### 1. Some rewrites change what the command means

Not what the issue tracker led me to expect. rtk's filters are mostly *faithful*
— diffed against the real command, `rtk find` returned the same 38-file set,
`grep -rl` the same paths, `rtk read` the same bytes. Upstream #3527 ("`rtk ls
-1` returns empty output unconditionally") does not reproduce on 0.45.0 at all:
`rtk ls -1` agrees with `ls -1A` minus `.git`, and adds sizes.

What does bite is a rewrite that silently substitutes a *different command*:

| rewrite | what happens |
| --- | --- |
| `npm run lint` -> `rtk lint` | the `npm run` indirection is discarded. Whatever the package's lint script actually is — flags, target, `--max-warnings 0` — is replaced by a bare eslint |
| `uv run pytest` -> `uv run rtk pytest` | resolves a different pytest than the venv's |

Both are invisible from inside a session: the command runs, exits, and reports
something. A 27B model at `REASONING_EFFORT=medium` cannot smell that, and the
repo's own operating rules say to log raw evidence rather than an interpretation
of it.

So the fork **inverts the default**: an allow-list of commands whose filters were
checked by hand, and everything else passes through untouched. `./scripts/rtk.sh
--check` re-runs those measurements against the installed binary and fails if
they stop holding.

The narrowness is mostly about *value*, not danger. Most denied filters are
simply not worth having here — `cat`/`head` save 0% (`rtk read` is byte-for-byte
`cat` at every size tried, up to 180 KB), `grep` saves 0-6%, `ls` helps `ls -la`
by 69% and makes `ls -1` 97% *bigger*. `cat` is the one entry denied on principle
rather than arithmetic: it costs nothing to deny today, and the README advertises
"signatures and structure over full bodies", so the current losslessness is
undocumented and could turn off in a point release. This stack's known failure
mode is an edit whose `old_string` does not match the file, and a summarised
read is precisely how that starts. `--check` watches for the day the README
becomes true.

### 2. What comes back is validated before it is run

`extractRewrite()` takes the last non-empty line of rtk's stdout and requires it
to start with `rtk `. For a bare allow-listed command that is the shape of every
valid rewrite, and it is not the shape of an error, an advisory, or a prefixed
form like `uv run rtk pytest`.

**This guards nothing that is currently broken.** rtk writes its advisories —
`[rtk] /!\ No hook installed — run `rtk init -g`...` — to **stderr**, so
upstream's `result.stdout.trim()` is safe. That was worth pinning down: a first
reading here claimed the advisory shared stdout with the rewrite and that
upstream therefore spliced it into the command. It was an artefact of probing
with `2>&1`. Re-run with the streams separated and the rate-limit stamp
(`~/.local/share/rtk/.hook_warn_last`) deleted first, the advisory is on stderr
every time.

The check stays because it costs a string comparison and the thing it guards is
handed to a shell. It is the reason `uv run rtk pytest` could not be run even if
the allow-list were widened carelessly.

### 3. Compound commands and prefixes are refused outright

rtk declines most of these already — `ls | wc -l`, `cargo test > out.txt` and
`git status | grep foo | wc -l` all came back "no rewrite" — but it accepted
`git status && git log` and `echo hi; git status`. A pipe or a redirect means the
output is going to a parser or a file, where being shorter is simply being wrong.
Cheaper to refuse the class than to track which members of it rtk gets right this
month. Likewise anything wearing a `VAR=`, `sudo`, `timeout`, `uv` or `npx`
prefix: rtk strips those before matching, so the thing that gets rewritten is not
the thing that was measured.

Everything else is upstream's: the exit-code contract (0 and 3 both mean
rewrite), the >= 0.23.0 version guard, `RTK_DISABLED=1`, and fail-open on any
unexpected error.

### 4. Whitespace is collapsed for the match, not for the command

`git   status` is a thing a model writes, rtk normalises it happily (it answers
`rtk git status`), and a literal prefix match would miss it — losing the saving
silently, which is the kind of loss nobody notices. `shouldFilter()` collapses
runs of spaces and tabs **for the decision only**; the original string is what
gets sent to rtk, so nothing about what actually runs changes. Tested both ways,
including that collapsing does not resurrect `uv   run pytest` or a piped form.

### 5. The version probe can tell a hang from an answer (AB3, eleventh pass)

The load-time probe answers one question — is there a usable rtk on PATH? — and
asked it with `ver.code !== 0`. pi's `execCommand` resolves a child it killed on
the timeout with `code: code ?? 0`, because a signalled child exits with no code.
So a **wedged** rtk arrives looking exactly like a healthy one that printed
nothing:

```
  state                    code  killed  stdout          BEFORE       NOW
  ----------------------------------------------------------------------------
  rtk is healthy           0     false   "rtk 0.45.0"    FILTERING    FILTERING
  rtk is not installed     127   false   ""              not on PATH  not on PATH
  rtk is WEDGED (hangs)    0     true    ""              FILTERING    wedged
  rtk is old               0     false   "rtk 0.19.3"    too old      too old
```

Both states the probe was *written* for are answered correctly in both columns.
Only the state nobody thought about read as healthy — and the consequences
compound: the "not on PATH" warning does not fire, `parseSemver("")` returns null
so the `>= 0.23.0` guard is skipped entirely, the handler registers, and every
allow-listed command then spends the full 2,000 ms waiting for the same wedged
binary before `rewriteCommand`'s own `killed` check fails it open. Silently.

Forty lines below the probe, `rewriteCommand` tests `result.killed` first and is
right. That is what makes this a finding rather than an oversight in general: the
file knows the rule and applied it at one of its two `pi.exec` call sites.

`if (ver.killed) { warn; return }` now runs before the `code` test.
`tests/version-probe.test.ts` pins the ORDER at both call sites, and its first
case drives pi's real `execCommand` to establish the premise. Full account in
`context/design/subagents-loop-verifier-signals.md` (AB3) and
`context/testing/probes/o3-…`.

**Two things this sweep confirmed rather than changed**, both worth having
written down:

- **Mutating `event.input.command` in place is the sanctioned mechanism**, not a
  trick. pi's own `ToolCallEventResult` says *"Block tool execution. To modify
  arguments, mutate `event.input` in place instead."*, and the reference chain
  holds: `beforeToolCall({args: validatedArgs})` → `emitToolCall` passes the event
  with no clone → `prepareToolCall` returns `{kind:"prepared", args:
  validatedArgs}`, the same object. Arguments are validated *before* the hook, so
  a rewrite is never re-validated.
- **`emitToolCall` has no try/catch around handlers** (unlike `emitUserBash`), and
  agent-session rethrows as "Extension failed, blocking execution", which
  `prepareToolCall` turns into an error result. So a throwing `tool_call` handler
  BLOCKS the tool. This file's blanket `try`/`catch` and its "fail open, always" is
  not defensiveness — it is the only correct shape for this hook.

## What `--check` pins, and why each one is there

`./scripts/rtk.sh --check` is the half of the contract this repo cannot express
in a unit test, because it is about a binary this repo does not own:

| assertion | why it exists |
| --- | --- |
| every allow-listed command still rewrites | caught `npm test`, `cargo nextest` and bare `ruff` being in rtk's coverage table with nothing behind them |
| `rtk read` is still byte-identical to `cat` | the day this fails, denying `cat` stops being free insurance and starts being load-bearing |
| `rtk find` returns the same file set | `find` is the one allow-listed filter that *reformats* — it groups filenames under their directory above a certain tree size, so "did it drop any" is not answerable by eye |
| a pytest collection error still exits non-zero and still names what failed | upstream #2317 reports filters masking hard failures behind benign summaries. It does not reproduce on 0.45.0, and `pytest` is only allow-listed because of that. A masked failure means the model reports a green run and moves on — worse than no filtering |

The last one is the reason the gate is worth its weight. Everything else here
trades context for a little risk; that one is the risk being bounded.

`--check` also prints what `npm run lint` and `uv run pytest` currently rewrite
to. Those are reported, never fatal: upstream fixing one of them is good news,
and good news should not fail a check.

## Adding a command to the allow-list

Not a judgement call — a measurement:

```bash
./scripts/rtk.sh --status                    # what is filtered now
diff <(some-command) <(./scripts/rtk.sh some-command)   # what the filter drops
```

Read the diff. If everything it dropped is noise, and a failing run still names
what failed, add the entry to `ALLOW` in `src/gate.ts` with the measured saving
in the comment. Then run both halves of the contract and commit:

```bash
node --experimental-strip-types --test tests/*.test.ts
../../scripts/rtk.sh --check
```

`--check` reads `ALLOW` out of `src/gate.ts` rather than restating it, so a new
entry is probed automatically. If the bare prefix is not a runnable command —
`find` is the existing case — add a probe invocation to the `case` in
`run_check`, or it will report a healthy filter as missing.

## Layout

```
src/gate.ts             the allow-list, the refusals, extractRewrite. No pi
                        import, so it is testable with bare node.
extensions/index.ts     the pi coupling: version probe, tool_call handler.
tests/gate.test.ts      the decisions, in isolation
tests/binary.test.ts    the decisions and the real binary, composed
tests/version-probe.test.ts
                        the load-time probe against pi's REAL execCommand, and
                        the `killed`-before-`code` order at both call sites (AB3)
```

Twenty tests. `binary.test.ts` skips itself when rtk is not installed, so a clone
without the binary still runs a green suite — the stack is designed to work
without it.

## Upstream

Nothing was filed, and that is a conclusion rather than an omission. As of
2026-08-16, every defect this fork works around is either already reported or
turned out not to exist:

| finding | status |
| --- | --- |
| `npm run lint` -> `rtk lint` discards the indirection | reported, #3543 |
| `uv run pytest` -> `uv run rtk pytest` | reported, #3565 |
| `cargo nextest` has no filter | reported, #2046 |
| `rtk ls -1` miscounts | **does not reproduce** on 0.45.0 (#3527) — it agrees with `ls -1A` minus `.git` |
| pytest collection errors masked as a benign summary | **does not reproduce** on 0.45.0 (#2317) |
| rtk splices its advisory banner into the rewritten command | **not a defect** — the advisory is on stderr; the earlier reading came from probing with `2>&1` |

`npm test` having no filter, and bare `ruff` matching nothing while `ruff check`
does, are the two findings here with no upstream issue behind them. Both are
coverage-table drift rather than misbehaviour, and `--check` catches them
locally, which is the thing that actually matters for this repo.

## Seventeenth pass — no findings, and this package is the control

**No AH finding is here**, and 20 tests are unchanged. It is worth one paragraph
because AH3 is a rule this package gets right in both of its `pi.exec` call
sites, and it is the only one that does.

The rule is `killed` before `code`: pi's `execCommand` never rejects and resolves
a child it killed on its own timeout with `code: code ?? 0` — a signalled child
exits with a signal and no code — so a wedged command arrives looking exactly
like a healthy one that printed nothing. `rewriteCommand` reads
`if (result.killed) return null` before it looks at the code, and the factory's
version probe does the same, under the comment that names the shape:

> Same shape as AA2, one call site over; see AB3 …

**That sentence is what AH3 is the enumeration of.** Two packages had written the
rule down; a third had it in a module header (`git-failure.ts`, "this is AA2 one
package over"); and three call sites in that third package, plus two in
`.pi/extensions/stack.ts`, still tested `code` first. The rule was never far
away — see §10.5 of `context/design/subagents-loop-verifier-instances.md`, whose
R3 row has all ten instances laid out by distance.

The scan that now keeps it true lives in the package that needed it
(`vendor/pi-subagents-lite/tests/exec-verdicts.test.ts`). This package does not
have one, and does not need one: it has two call sites, both in one file, both
correct, and both with the reasoning in a comment beside them.
