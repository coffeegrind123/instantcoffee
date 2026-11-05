# Team solve in Anthropic mode

`/team-solve` is a durable, command-checked workflow for work that benefits
from several fresh Claude contexts. It ports the GVS5H/Memdoor
plan → ideate → solve → verify loop from the Codex team-solve project into pi.

The verification command is the only authority on completion. A planner,
manager, or audit role can explain a result, but it cannot turn a nonzero exit
status into success. The orchestrator stores and reruns the command without
rewriting it.

## Requirements

- Anthropic mode is active: `STACK_BACKEND=anthropic`.
- `ANTHROPIC_API_KEY` is present in the environment or gitignored `.env.local`.
- `/team-solve` is enabled with `TEAM_SOLVE_ENABLED=1` (the default).
- `python3` is available. Git is optional, but enables diff snapshots for review
  and repair roles.

The extension is loaded only by the Anthropic launcher path. Switching the
configuration back to local mode requires the usual pi relaunch; the running
session keeps the command it launched with.

## Quick start

From the project pi should edit:

```text
/team-solve run "Implement the missing parser and cover its edge cases" --check "python3 -m pytest -q"
```

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

1. Run the check once to establish a baseline.
2. Route the task to a workload profile.
3. Plan, then ask two ideators for independent proposals in parallel.
4. Implement, then run the check.
5. Triage the check, review the diff, and let a manager choose the next action.
6. Repair and check again for up to ten rounds by default.
7. Capture a final diff, run the strict final check, and audit the handoff.

A passing baseline short-circuits the run unless `--improve` is supplied.
Completed role markers are reused only when both the prompt and the evidence
files that role read are unchanged. The check is always rerun because workspace
state may have changed while the orchestrator was stopped.

## Model allocation

The `coding` profile is the primary path:

| Role | Claude model | Effort | Access |
| --- | --- | --- | --- |
| Router, failure triage, cut-off summary | Haiku 5.5 | medium | read tools only |
| Plan, manager, final audit | Fable 5.1 | high | read tools only |
| Independent ideators, review | Sonnet 5.5 | high | read tools only |
| Implementation, repair | Opus 5.5 | high | read/write/bash |

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

The check is a shell command supplied by the operator and run in the workspace
with `bash --noprofile --norc -c`. Use an existing objective test, build, or
reproduction command:

```text
/team-solve run "Fix the race" --check "go test ./..."
/team-solve run "Reproduce and fix issue 42" --check "python3 scripts/repro.py"
```

Exit 0 is the only success signal. The orchestrator also treats a timeout as
failure. Roles are told not to weaken tests, delete coverage, or special-case
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
task.md                 task statement given to every role
state.json              durable phase, role, usage, budget, and check state
result.json             final machine-readable handoff
tasks.json              manager-curated task ledger
round-NN/plan.md        planner output
round-NN/tasks-initial.json
round-NN/tasks-before.json
round-NN/proposals/     ideator A and B outputs
round-NN/*.jsonl        raw pi event streams per attempt
round-NN/check.log      captured verification output
round-NN/diff.txt       tracked and untracked workspace changes
round-NN/*.cutoff.md    partial output from a role cut off at its limit
round-NN/cutoff.md      Haiku summary of the cut-off attempt
round-NN/*.md           triage, review, manager, repair, and audit ledgers
final-check.log         authoritative final check
final-diff.txt          final change snapshot
```

`.team-solve/` is private runtime state. It is gitignored because it can contain
source diffs, prompts, logs, and workspace paths. It should not be published or
copied into a public repository.

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
