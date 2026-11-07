# Team solve in Anthropic mode

`/team-solve` is a durable workflow for work that benefits from several fresh
Claude contexts. It ports the GVS5H/Memdoor method from the Codex team-solve
project into pi: a direct attempt first, then plan → ideate → solve → verify
rounds when that attempt does not pass.

The task can be just a sentence. A verification command, when there is one, is
the authority on completion: a planner, manager, review, judge or audit role
can explain a result, but none can turn a failing check into success. When no
command can check the work, the review and a fresh judge must both pass it, and
the result says **judged, not checked**.

## Requirements

- Anthropic mode is active: `STACK_BACKEND=anthropic`.
- `ANTHROPIC_API_KEY` is present in the environment or gitignored `.env.local`.
- `/team-solve` is enabled with `TEAM_SOLVE_ENABLED=1` (the default).
- `python3` and the `git` binary are available. The workspace itself need not be
  a git repository: outside one, a private shadow repository tracks the run.

The extension is loaded only by the Anthropic launcher path. Switching the
configuration back to local mode requires the usual pi relaunch; the running
session keeps the command it launched with.

## Quick start

From the project pi should edit:

```text
/team-solve run "Implement the missing parser and cover its edge cases" --check "python3 -m pytest -q"
/team-solve run "Rename ReadConfig to LoadConfig everywhere; go test ./... must pass"
/team-solve run "Write docs/branching.md for new teammates" --until "it names the feature/ prefix and the review rule"
```

- With `--check`, that command is the check.
- Without it, the planner settles one: the command the task names ("Check:
  `go test ./x/` passes"), else the project's own tests scoped to the task.
  When nothing can be run, the check is **the judge**.
- `--until "sentence"` is your end condition in your own words. It goes into
  the task every role reads and becomes the first line of Done when, word for
  word; the review and the judge fail the work while it does not hold.

The command starts a detached orchestrator and returns immediately. It does not
hold the pi session open for a multi-hour or multi-day run.

The process survives leaving or replacing the interactive pi session. It does
not survive a host reboot or container teardown; launch pi again in the same
workspace and use `/team-solve resume`, which reuses the persisted role ledger.

```text
/team-solve status
/team-solve logs
/team-solve logs --role solve
/team-solve check
/team-solve resume
/team-solve stop
```

Use `/team-solve preview --check "pytest -q"` to print the role/model allocation
without spending tokens.

## Workflow

Every role is a new `pi --mode json --no-session` process. Roles do not share a
conversation; they communicate through the run ledger. The role processes also
disable discovered extensions, skills, context files, and MCP servers so a
team run is reproducible and does not recursively start another team.

The sequence is:

```
snapshot ─ [baseline] ─ route ─┬─ direct (writable, the prompt as written) ─┬─ test-0 ─┬─ passed ─────────────────────────┐
                               └─ plan ─ settle ─ [baseline on a copy] ─────┘          └─ failed: ideate A ‖ B ─ solve ─┤
round r:  check ─ triage ─ review ─ [judge] ─ manager ─ accepted + DONE? ─── no: repair ─ round r+1
keep net ─ final check ─ audit
```

1. Snapshot the workspace as the run found it. With `--check`, run it once on
   that untouched workspace: the baseline.
2. Route the task to a workload profile.
3. The **direct attempt** (one writable agent on the prompt as written) and
   the **planner** run side by side. The planner settles Deliverable, Check,
   Scope and Done when into `task.md`; a check it settled gets its baseline on
   a copy of the start (the direct attempt is already changing the live one).
4. **test-0**: the check and the scope on the direct attempt. When it passes,
   it is round 1's work and only review (and the judge when needed) follow.
   When it does not, two ideators propose in parallel and the solver corrects
   the attempt.
5. Each round: run the check, capture the diff since the start and the scope
   report, triage, review, the judge when a command cannot settle it, then the
   manager picks the next action. Repair and check again, up to ten rounds by
   default; a repair that changes nothing stops the run.
6. The keep net, a final diff, the strict final check, and the audit.

A passing baseline ends the run with no model work only when no task was given
besides the check. With a task, a check that already passed cannot show the
work, so the team runs and the judge has to agree too. `--improve` keeps
working after the work is accepted.

**A round is accepted** when the check passes (or there is none to run), the
review's verdict is not FAIL, and, whenever a command cannot settle it alone
(no command, a check that cannot decide, a check that passed before any work,
a repaired change, a review with no verdict), the judge says PASS. The judge
is a fresh read-only role that sees the task and the diff, never the team's
reasoning. The run stops when a round is accepted and the manager says DONE.

**The baseline counts what the work adds.** When the check already failed on
the workspace as found, the run counts only the failing tests the change adds
(pytest, unittest, Django's runner and go test logs). A failure that reads
exactly as it did before any change cannot decide: the judge gets its log. Any
other failure counts against the change.

**The keep net.** Every accepted state is saved. If a later round breaks it,
the last accepted state is put back. With nothing accepted, a command check
puts the direct attempt back unless the team's work passes it; a judge-only
task keeps the latest work. The work set aside is in `team.patch`.
Completed role markers are reused only when both the prompt and the evidence
files that role read are unchanged. The check is always rerun because workspace
state may have changed while the orchestrator was stopped.

## Model allocation

The `coding` profile is the primary path:

| Role | Claude model | Effort | Access |
| --- | --- | --- | --- |
| Router, failure triage, cut-off summary | Haiku 5.5 | medium | read tools only |
| Plan, manager, judge, final audit | Fable 5.1 | high | read tools only |
| Independent ideators, review | Sonnet 5.5 | high | read tools only |
| Direct attempt, implementation, repair | Opus 5.5 | high | read/write/bash |

The judge always runs on a different model from the one that wrote the work:
Fable in `coding`, `writing` and `general`, Opus in `everyday` and `research`
(where Fable or Sonnet solve), Sonnet in `high-volume`.

Other profiles preserve the same separation while shifting cost:

| Profile | Intended work |
| --- | --- |
| `auto` | Classify the task with Haiku, then select one of the profiles below |
| `coding` | Complex implementation, debugging, tests, builds, and agents |
| `everyday` | Routine fixes, small implementations, tests, and build chores |
| `research` | Fable plans and solves; Sonnet supplies a second research path |
| `writing` | Sonnet plans, solves, and repairs; Opus reviews; Fable audits |
| `general` | Mixed work without a clear category |
| `high-volume` | Haiku handles most roles; Sonnet manages and reviews |

The planner emits an initial checklist and the manager owns it thereafter,
marking items done, merging or dropping stale work, adding new work, and saving
the curated list to `tasks.json`. An Opus or Fable worker cut off at its output
limit is summarized by Haiku; the partial reasoning, summary, and any workspace
changes remain available to the next manager instead of being discarded.

Runs with a multi-day horizon promote planning, management, and audit to Fable
on every profile, even when execution stays on Sonnet or Haiku. The Haiku
router classifies that horizon from the task; force it for an explicit-profile
run with `--multi-day`.

The model ids and effort levels are configurable in `.env` or `.env.local`:

```dotenv
TEAM_SOLVE_FABLE_MODEL=claude-fable-5-1
TEAM_SOLVE_OPUS_MODEL=claude-opus-5-5
TEAM_SOLVE_SONNET_MODEL=claude-sonnet-5-5
TEAM_SOLVE_HAIKU_MODEL=claude-haiku-5-5

TEAM_SOLVE_FABLE_THINKING=high
TEAM_SOLVE_OPUS_THINKING=high
TEAM_SOLVE_SONNET_THINKING=high
TEAM_SOLVE_HAIKU_THINKING=medium
```

The Fable tier is deliberately reserved for long-horizon planning, management,
and audit; the coding profile gives actual file-writing work to Opus. Haiku is
used where latency and cost matter more than sustained reasoning. The
`high-volume` profile is selected by the router for explicit batch, bulk, or
high-volume classification and extraction work, and can also be forced with
`--profile high-volume`.

## Budgets and controls

Defaults are sized for unattended work:

| Key | Default | Meaning |
| --- | --- | --- |
| `TEAM_SOLVE_MAX_HOURS` | `72` | Total wall-clock budget for the run |
| `TEAM_SOLVE_MAX_ROUNDS` | `10` | Maximum solve/repair rounds |
| `TEAM_SOLVE_ROLE_TIMEOUT` | `4h` | Per-role process limit |
| `TEAM_SOLVE_CHECK_TIMEOUT` | `1h` | Per-check limit |
| `TEAM_SOLVE_ROLE_RETRIES` | `1` | Retries after a failed role process |
| `TEAM_SOLVE_MULTI_DAY` | auto | Set `1` to promote long-horizon roles to Fable |

The total budget bounds every child call and check. Expiring it stops the run
with a resumable error rather than starting another expensive role.

Pass `--max-hours`, `--rounds`, `--role-timeout`, and `--check-timeout` to
override them for one run. `--improve` runs the full team even when the baseline
check already passes and continues through the requested rounds instead of
stopping at the first passing check. `/team-solve stop` terminates the
orchestrator, active role and check process groups, and their descendants, then
records the run as stopped. `/team-solve resume --max-hours N`
restarts an unfinished or failed run with a fresh total budget.

## The check contract

The check is a shell command, supplied by the operator or settled by the
planner, run in the workspace with `bash --noprofile --norc -c`. Use an
existing objective test, build, or reproduction command:

```text
/team-solve run "Fix the race" --check "go test ./..."
/team-solve run "Reproduce and fix issue 42" --check "python3 scripts/repro.py"
```

Exit 0 is the success signal (or, against a failing baseline, no new failing
test). The orchestrator also treats a timeout as failure. With no command, the
review and the judge decide, and `status`, the final line and `result.json`
say so. Roles are told not to weaken tests, delete coverage, or special-case
sample inputs. If the check does not already exist, create or review it before
starting an unattended run.

The implementation and repair roles receive `bash`, `edit`, and `write`. Their
prompts forbid changing the check or expected test data, and the orchestrator
does not alter them. There is no integrity manifest or filesystem sandbox
around those tools, so an operator-supplied check should be reviewed before
unattended use just like the repository it tests.

## Isolation boundary

Each role gets a fresh pi process, no session, no project extensions, no MCP
servers, an isolated `HOME`, and an allowlisted environment. Read-tool roles do
not receive `bash`, `edit`, or `write`, so they cannot modify the workspace
through pi's tools.

This is capability separation, not a filesystem jail. Pi reads files as the
same operating-system user, and the writable implementation and repair roles
can access paths that user can access. Use a container, VM, or other
filesystem policy when the task itself must be confined to the workspace.

## Artifacts

Each run writes under `.team-solve/runs/<run-id>/`:

```text
prompt.md               the task as given (and --until), untouched
task.md                 the task plus the settled Deliverable, Check, Scope, Done when
direct.patch            the direct attempt; accepted.patch the last accepted state
team.patch              work the keep net set aside, when it put a state back
state.json              durable phase, role, usage, budget, and check state
result.json             final machine-readable handoff
tasks.json              manager-curated task ledger
round-NN/plan.md        planner output
round-NN/tasks-initial.json
round-NN/tasks-before.json
round-NN/proposals/     ideator A and B outputs
round-NN/*.jsonl        raw pi event streams per attempt
round-01/direct.md      the direct attempt's summary; direct-check.log, direct-diff.txt
round-NN/check.log      captured verification output
round-NN/diff.txt       every change since the run started, with the scope report
round-NN/scope.txt      each changed file against the Scope
round-NN/judge.md       the judge's verdict, when it ran
round-NN/*.cutoff.md    partial output from a role cut off at its limit
round-NN/cutoff.md      Haiku summary of the cut-off attempt
round-NN/*.md           triage, review, manager, repair, and audit ledgers
final-check.log         authoritative final check
final-diff.txt          final change snapshot
```

`.team-solve/` is private runtime state. It carries its own `.gitignore` because
it can contain source diffs, prompts, logs, and workspace paths. It should not be
published or copied into a public repository.

**Snapshots.** Each state of the workspace is a git tree written through a
private index, so the project's index, branch and stash are never touched, and
the diff since the start shows neither the operator's own uncommitted work nor
a file untracked before the run as the team's. Sensitive paths (`.env*`,
`*.pem`, `*.key`, `*secret*`, `*credential*`, ...) are excluded from every
snapshot, so their contents never enter the object store. A role that moves
HEAD has it put back. Outside a git repository a private shadow repository in
`.team-solve/shadow.git` provides the same diffs and snapshots. The run's refs
(`refs/team-solve/<run>/`) are deleted when it finishes.

## Direct command-line use

The pi command wraps the same orchestrator:

```bash
python3 /path/to/checkout/scripts/team-solve/team_solve.py \
  run --dir /path/to/project \
  "Fix the failing build" \
  --check "make test"
```

This is useful for automation that does not have a live pi session. The
backend and credential checks are the same.

## Failure behavior

- Missing Anthropic mode or key: immediate preflight error, no model call.
- Role process failure: one retry by default, then a resumable run error.
- Solver/repair output limit: the partial reasoning and text are saved, Haiku
  summarizes them, and the check still decides whether the work succeeded.
- Failed check: the manager must continue; `STATUS: DONE` cannot override it.
- Malformed JSONL, a missing `agent_settled`, an aborted run, or a non-`stop`
  assistant stop reason fails that attempt instead of treating partial output
  as a completed role.
- Budget or timeout: the current process group is stopped and the state is saved.
- Final audit failure: the check verdict remains authoritative and the warning
  is recorded in `state.json` and `result.json`.

Anthropic pricing applies to every role process. `/team-solve preview` and
`/team-solve status` are free ways to inspect the allocation and progress.
