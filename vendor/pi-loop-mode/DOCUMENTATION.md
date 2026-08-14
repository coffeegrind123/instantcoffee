# Loop Module — Documentation

> Deutsche Version: [DOCUMENTATION_de.md](DOCUMENTATION_de.md)

Unattended loop mode for [pi](https://github.com/earendil-works/pi): you give the agent **one goal** and it works on it in small iterations — for hours or days — until **you** stop it. Works with commercial models (Claude, GPT, Gemini) as well as open-source models (Qwen, GLM, gpt-oss, …), because the loop itself is hardened against the typical weaknesses of weaker models: repetition loops, false "done" claims, provider failures.

---

## Contents

1. [Installation](#1-installation)
2. [Quick start](#2-quick-start)
3. [Core concept](#3-core-concept)
4. [Command reference](#4-command-reference)
5. [Options in detail](#5-options-in-detail)
6. [The goal function (`--check`)](#6-the-goal-function---check)
7. [Error and failure handling](#7-error-and-failure-handling)
8. [Practical examples](#8-practical-examples)
9. [Best practices for multi-day runs](#9-best-practices-for-multi-day-runs)
10. [Status display and monitoring](#10-status-display-and-monitoring)
11. [Internals & tuning constants](#11-internals--tuning-constants)
12. [FAQ](#12-faq)

---

## 1. Installation

```bash
pi install npm:pi-loop-mode
```

Or from a local checkout:

```bash
pi install /path/to/pi-loop-mode
```

Then restart pi or run `/reload`. The `/loop` command is now available.

**Package files:**

```text
pi-loop-mode/
├── package.json              # pi package definition
├── README.md                 # Overview
├── DOCUMENTATION.md          # This file
├── DOCUMENTATION_de.md       # German translation
├── CHANGELOG.md              # Version history
├── GALLERY.md                # pi.dev gallery asset notes
├── LICENSE                   # GNU AGPL v3.0 only
├── assets/                   # pi.dev preview video + poster image
├── extensions/index.ts       # Pi command/event orchestration
├── src/                       # Repetition, parsing, state, checks, and bounded logging
├── skills/loop-skill/SKILL.md  # Behavior rules for the model in loop mode
├── prompts/loop-prompt.md    # Prompt template
└── prompts/loop-examples.md  # /loop-examples — project-specific loop recipes
```

---

## 2. Quick start

**Recommended workflow — set goal, prepare, run (separate phases, with model selection):**

```text
/loop goal Build a task-management REST API in ./taskapi: CRUD, auth, SQLite, tests, docs. Commit incrementally in git.
/loop prepare --model anthropic/claude-opus-4-6     # strong model writes GOAL.md + check.sh
/loop run --model vllm-omega/qwen3-coder-30b        # cheap/local model works the loop
```

**Or everything in one step** (no preparation, with the current model):

```text
/loop start Build a task-management REST API in ./taskapi: CRUD, auth, SQLite, tests, docs. Commit incrementally in git.
```

**Watch:**

```text
/loop status
```

**Stop:**

```text
/loop finish   # soft: finish the current iteration, then stop
/loop stop     # immediate: abort the in-flight turn
```

**Continue:**

```text
/loop resume
```

That's all you need for basic operation.

### The 3-phase workflow in detail

| Phase | Command | What happens | Typical model |
|-------|---------|--------------|---------------|
| **1. Set goal** | `/loop goal <goal> [flags]` | Stores goal + configuration. **Starts nothing.** | — (no LLM call) |
| **2. Prepare** (optional) | `/loop prepare [--model M]` | A model analyzes the project and writes `GOAL.md` (specification, milestones, assumptions) plus a check script. Ends with `GOAL_READY:`. You can then review and edit `GOAL.md`. | Strong model (Opus, GPT-5, …) |
| **3. Run the loop** | `/loop run [--model M]` | Starts the actual endless loop. The first iteration reads `GOAL.md` as the specification. | Cheap/local model (Qwen, GLM, Sonnet, …) |

The idea: **decouple planning and execution.** An expensive, strong model writes a precise specification once — a cheap or local model works through it for days. `GOAL.md` lives in the project, survives compaction/restarts, and is referenced in every loop prompt ("read it whenever you lose track of the plan").

---

## 3. Core concept

The loop works like this:

```
┌─────────────────────────────────────────────────────┐
│  /loop start <goal>                                 │
└──────────────────┬──────────────────────────────────┘
                   ▼
        ┌─── Loop iteration ────────────────────┐
        │ 1. Loop prompt sent to the model      │
        │    (goal, criteria, rules,            │
        │     check status, iteration counter)  │
        │ 2. Model does ONE concrete            │
        │    progress batch (tools, edits)      │
        │ 3. Goal check runs (if --check)       │
        │ 4. Evaluation:                        │
        │    Error? → retry with backoff        │
        │    Repetition? → stuck strategy       │
        │    Regression? → fix prompt           │
        │    Done? → keep improving             │
        │      (or stop with --until-done)      │
        │    Otherwise → next iteration         │
        └───────────────┬───────────────────────┘
                        │ (until /loop stop)
                        ▼
```

**Core principles:**

- **Small iterations**: every response max. 1,200 characters, one progress batch per turn. This keeps context small so pi's normal compaction keeps working for days.
- **Endless by default**: no iteration cap. `LOOP_DONE:` from the model does *not* stop the loop — instead it continues with improvement work (features, tests, bug fixes, refactoring, docs).
- **Never wait for a human**: missing information → the model makes a documented assumption (`ASSUMPTIONS.md`) and keeps working.
- **Objective truth**: with `--check`, a shell command decides progress and completion — not the model's self-assessment.
- **Persistence**: loop state lives in the session. After a pi restart/reload, an active loop automatically resumes after 3 seconds.

---

## 4. Command reference

| Command | Description |
|---------|-------------|
| `/loop goal <goal> [flags]` | Set goal + configuration **without starting**. |
| `/loop goal` | Show the current goal and configuration. |
| `/loop prepare [--model M] [--file F]` | Have a (strong) model write the specification (`GOAL.md`) + check script. |
| `/loop run [--model M]` | Start the loop — optionally with a different model than used for preparation. |
| `/loop start <goal> [flags]` | Shortcut: set goal + start immediately (one step). |
| `/loop <goal>` | Short form of `/loop start <goal>`. |
| `/loop resume [--max N] [--check "CMD"] [--model M] [--rescue-model M]` | Continue a stopped/paused loop, optionally with a new cap/check/model. |
| `/loop status` | Show the full state. |
| `/loop stats` | Statistics from the iteration log (`.pi-loop-log.jsonl`): events, interventions, productive iterations/h, score trend. |
| `/loop finish` | Soft stop: the current iteration completes, then no new turn (state preserved for `/loop resume`). Alias: `/loop soft-stop`. |
| `/loop stop` | Hard stop: abort the in-flight turn immediately, state preserved. |
| `/loop end` | End the loop and clear state. |
| `/loop help` | Short help. |

**Flags** (valid with `goal`, `start`, and partly with `prepare`/`run`/`resume`):

| Flag | Description |
|------|-------------|
| `--max N` | Iteration cap (default: ∞). |
| `--delay S` | Pause between iterations in seconds. |
| `--check "CMD"` | Objective goal function (see [section 6](#6-the-goal-function---check)). |
| `--check-timeout S` | Check timeout in seconds (default 120). |
| `--file GOAL.md` | Name of the specification file (default `GOAL.md`). |
| `--model M` | Model for this phase: `provider/id` (e.g. `anthropic/claude-opus-4-6`) or a unique id substring (e.g. `qwen3-coder`). |
| `--rescue-model M` | Stronger model that takes over for **one** cleanup turn after 3 consecutive stuck interventions (see [section 7](#7-error-and-failure-handling)). |
| `--until-done` | Loop stops on verified completion. |

**Goal syntax:** everything before `Done when:` is the goal, everything after are the criteria:

```text
/loop start Implement feature X. Done when: tests green and README updated.
```

Without `Done when:` the loop runs in pure improvement mode ("continuous improvement until the operator stops the loop").

### Model selection (`--model`)

Each phase can use its own model:

```text
/loop goal Build X …                                  # no LLM call
/loop prepare --model anthropic/claude-opus-4-6       # planning: strong model
/loop run --model vllm-omega/qwen3-coder-30b          # execution: local model
```

- Format: `provider/id` (exact) or a unique substring of the model id (`--model qwen3-coder` finds `vllm-omega/qwen3-coder-30b`).
- The model chosen at `run` is stored as the **loop model**: after a pi restart/reload, auto-resume restores this model (with a warning if it is unavailable — the loop then continues with the current model).
- Unknown model or missing API key → clear error message, the loop does **not** start.
- Without `--model`, the phase simply uses the currently active model.
- Switch mid-run: `/loop stop`, then `/loop resume --model <other model>`.

### Rescue model (`--rescue-model`)

Strongly recommended for long runs with weak/local models:

```text
/loop run --model vllm-omega/qwen3-coder-30b --rescue-model anthropic/claude-sonnet-4-5
```

If the loop model gets stuck 3 times in a row, the rescue model takes over for exactly **one turn**: it inspects the project state, finishes one concrete thing, rewrites `PROGRESS.md` (next 3 unambiguous steps with file paths), updates the `IMPROVEMENTS.md` backlog, and leaves a `NEXT:` line. Then the loop continues with the regular model — weak models follow a clear external plan far better than they create one.

### Preparation (`/loop prepare`)

`/loop prepare` sends a one-time task to the model (not a loop!):

1. Inspect the project state (files, README, tests).
2. Write `GOAL.md`: refined objective, scope & non-goals, measurable completion criteria, a milestone roadmap of small steps, quality standards (tests, docs, git commits), explicit assumptions.
3. If objectively checkable: create a check script (`check.sh`) and reference it in `GOAL.md`.
4. Finish with `GOAL_READY: <summary>` — this is how the extension detects that preparation is complete and recommends the exact `--check` command.

After that: **review `GOAL.md` and edit it by hand if needed** — only `/loop run` starts the loop. From then on the loop prompt references the specification in every iteration; the first iteration explicitly starts by reading `GOAL.md`.

---

## 5. Options in detail

### `--max N` — iteration cap

Default: **unlimited** (∞). With `--max 50` the loop pauses after 50 iterations. `/loop resume` continues — if the cap is exhausted, it automatically switches to unlimited (with a notice).

Useful for: first test runs with a new model, cost control with commercial APIs.

### `--delay S` — pause between iterations

Default: **0 s**. With `--delay 30` the loop waits 30 seconds between iterations.

Useful for: rate limits on commercial APIs, sparing local GPU resources when other jobs run in parallel.

### `--until-done` — classic "until finished" mode

Default: **off** (endless mode). With `--until-done` the loop stops on completion:

- **With `--check`**: the loop stops as soon as the check command returns exit code 0 — *verified* completion, regardless of what the model claims.
- **Without `--check`**: the loop stops when the model reports `LOOP_DONE:` (self-assessment — unreliable with weak models, so `--check` is recommended).

### `--check "CMD"` / `--check-timeout S`

See next section.

---

## 6. The goal function (`--check`)

The goal function is a shell command (executed via `bash -lc`) that runs **after every iteration**. It is the loop's objective fitness function.

### Contract

| Signal | Meaning |
|--------|---------|
| **Exit code 0** | Completion criteria met. With `--until-done`: loop stops (verified completion). |
| **Exit code ≠ 0** | Criteria not yet met. Loop continues. |
| **`SCORE: <number>`** in the output (optional) | Numeric progress score, higher = better. Negative/decimal values allowed. If it appears multiple times, the last occurrence counts. |

### What the check gives the loop

1. **Verified completion** — with `--until-done` the exit code decides, not the model's claim. If the model reports `LOOP_DONE:` while the check fails, the claim is rejected: *"Completion is decided by the check, not by your claim. Fix exactly what the check reports"* — including the check output in the prompt.
2. **Regression detection** — if the score drops compared to the previous run, the model immediately gets a regression prompt: inspect recent changes (`git diff`/`git log`), fix the regression before doing anything else. Critical for multi-day runs where a refactoring silently breaks tests.
3. **Real proof of progress** — a new best score counts as measurable progress and feeds the no-progress audit (see [section 7](#7-error-and-failure-handling)).
4. **Objective feedback** — every loop prompt contains the current check status:

```text
Goal check: `./check.sh` → FAILING (streak 3) · score 34 (best 41 @ iteration 87)
```

The model thus optimizes against a measurable quantity instead of its own self-assessment.

### Example check scripts

**Simple — tests must pass:**

```bash
/loop start Fix all bugs in ./app. Done when: test suite green --check "cd app && npm test" --until-done
```

**With score — number of passing tests:**

```bash
#!/usr/bin/env bash
# check.sh — fitness function for an API-building run
cd taskapi || { echo "SCORE: 0"; exit 1; }

# Build must work, otherwise score 0
npm run build >/dev/null 2>&1 || { echo "SCORE: 0"; exit 1; }

# Score = number of passing tests
passed=$(npm test 2>/dev/null | grep -oE '[0-9]+ passing' | grep -oE '[0-9]+' || echo 0)
echo "SCORE: $passed"

# Done at 50+ passing tests
[ "$passed" -ge 50 ] && exit 0 || exit 1
```

**Multi-dimensional score — tests + coverage − lint warnings:**

```bash
#!/usr/bin/env bash
cd myproject || { echo "SCORE: -1000"; exit 1; }
go build ./... >/dev/null 2>&1 || { echo "SCORE: -1000"; exit 1; }

tests=$(go test ./... 2>/dev/null | grep -c '^ok' || echo 0)
coverage=$(go test -cover ./... 2>/dev/null | grep -oE '[0-9]+\.[0-9]+%' | tr -d '%' | awk '{s+=$1; n++} END {print (n ? int(s/n) : 0)}')
lint=$(golangci-lint run 2>/dev/null | wc -l | tr -d ' ')

score=$(( tests * 10 + coverage - lint ))
echo "SCORE: $score"

# Done: all packages ok, coverage ≥ 80%, no lint warnings
[ "$coverage" -ge 80 ] && [ "$lint" -eq 0 ] && go test ./... >/dev/null 2>&1 && exit 0
exit 1
```

**Web project — endpoints + E2E:**

```bash
#!/usr/bin/env bash
cd webapp || exit 1
npm run build >/dev/null 2>&1 || { echo "SCORE: 0"; exit 1; }
unit=$(npx vitest run --reporter=json 2>/dev/null | jq '.numPassedTests' 2>/dev/null || echo 0)
e2e=$(npx playwright test --reporter=json 2>/dev/null | jq '.stats.expected' 2>/dev/null || echo 0)
echo "SCORE: $(( unit + e2e * 5 ))"   # weight E2E tests higher
[ "$e2e" -ge 10 ] && exit 0 || exit 1
```

### Score ideas

- Number of passing tests / E2E tests
- Test coverage percentage
- Number of implemented API endpoints (e.g. via `grep -c 'app\.\(get\|post\|put\|delete\)'`)
- Negated error count: `SCORE: -$(eslint . 2>/dev/null | wc -l)`
- Feature checklist: `SCORE: $(grep -c '^\- \[x\]' FEATURES.md)`
- Weighted combinations (see above)

### Rules for good check scripts

- **Keep it fast** (< 2 min; otherwise raise `--check-timeout`). The check runs after *every* iteration.
- **Deterministic**: no flaky tests in the check — every downward score jump triggers a regression prompt.
- **Robust**: the script itself must never hang; use per-step timeouts (`timeout 60 npm test`).
- **Meaningfully monotonic**: the score should rise when the product gets better. Not: "number of files" (invites garbage production).
- If the check command itself fails (e.g. not found), the loop shows a warning and continues **without blocking**.

---

## 7. Error and failure handling

The loop is designed to run unattended for days. Overview of all situations:

| Situation | Behavior |
|-----------|----------|
| **Transient model/provider error** (crash, rate limit, timeout, empty response, `stopReason: "error"`) | Automatic retry with exponential backoff: 5 s → 10 s → 20 s → … → max. 5 min. Then a "recover" prompt: briefly re-orient and continue. |
| **Context-pressure failure** (`length` with ≤32 output tokens, or a 400/context/token error at ≥85% context) | LLM-independent emergency compaction, then one recovery turn. Two emergency attempts are allowed; a third consecutive failure pauses with state preserved instead of retrying forever. |
| **Model repeats the same answer** (fingerprint comparison, 2× identical) | Stuck intervention: a rotating recovery strategy is injected (see below), with escalating delay 2 s → 4 s → … → 60 s. **Never pauses.** |
| **Model repeats a *near*-identical answer** (≥ 80% similarity on word trigrams, digits masked — catches rephrasings like "Already exists. Let me continue with improvements…") | Also a stuck intervention. |
| **Same answer 3×+ in the recent window** (including alternating A-B-A-B) | Also a stuck intervention. |
| **3 turns without a single tool call** (pure narration instead of work) | Also a stuck intervention. |
| **Degenerate generation** (same sentence ≥ 4×, one word ≥ 16× consecutively, or a phrase of up to four words ≥ 8× consecutively in *one* response) | Response is stored truncated (context hygiene) + stuck intervention. Sentence loops are aborted at ≥ 6 repeats while streaming; word/phrase runs abort at their consecutive thresholds. The abort enters automatic stuck recovery instead of pausing. |
| **Same tool result/error 3× in a row** | Also a stuck intervention. |
| **Same question repeated 2×** | Also a stuck intervention. |
| **3 consecutive stuck interventions** | Hard-reset escalation: the recent response openings are injected as banned phrases; the first action of the turn **must** be a tool call (no text before it). If `--rescue-model` is set: a rescue turn instead (see below). |
| **5 consecutive stuck interventions** | Auto-compaction: the context is compacted (repetitive filler sentences are explicitly excluded from the summary) so the repetition pattern leaves the context window. |
| **8 iterations without a concrete change** (no file writes/edits, no score increase) | Audit prompt: "Stop analyzing, produce a tangible artifact now: a file change, a green test, a fixed bug, or a commit." |
| **Model reports `LOOP_DONE:`** (endless mode) | Loop continues with an "improve" prompt: pick and implement the most valuable next improvement. |
| **Model reports `LOOP_DONE:` but the check fails** (`--until-done`) | Claim is rejected; "check_failed" prompt with the check output. |
| **Check score drops** | Immediate "regression" prompt: inspect diffs, fix the regression. |
| **Check passes** (`--until-done`) | Verified completion — loop stops. |
| **Model reports `LOOP_BLOCKED:`** | Loop does **not** pause. "unblock" prompt: make the most reasonable assumption, document it in `ASSUMPTIONS.md`, keep working. |
| **Operator presses Esc** (turn aborted) | Loop pauses deliberately (operator's will). `/loop resume` continues. |
| **`/loop finish`** (soft stop) | The current iteration completes, then the loop stops without a new turn. State is preserved for `/loop resume`; survives a pi restart (finalized on session start instead of auto-resuming). |
| **pi restart / `/reload`** | Active loop auto-resumes after 3 s (with a notice and the option to cancel via `/loop stop`). |
| **`--max N` reached** | Loop pauses. `/loop resume` continues (removes the cap if exhausted). |

### The rotating stuck strategies

When repetition is detected, one of these strategies is injected in rotation:

1. List three genuinely different approaches in one line each, execute the most promising one immediately.
2. Switch to a different subtask of the goal that was not touched recently.
3. Write/update `PROGRESS.md`: current state, what was tried, what failed, next 3 steps — then execute step 1.
4. Run the build/test suite, fix exactly **one** failure or warning.
5. Review recent changes (`git diff` / `git log`), verify correctness, fix any issue found.

This rotation prevents the intervention itself from becoming a loop — important for weaker open-source models.

Additional defense layers against endless rambling from weaker models:

- **Near-duplicate detection**: responses are compared not only exactly (hash) but also via trigram similarity (digits masked). Slightly rephrased repetition ("Already exists. Let me continue with improvements…") is still caught.
- **Tool requirement**: every loop prompt demands at least one tool call per turn. Three turns without tool usage trigger a stuck intervention.
- **Hard-reset escalation**: from the 3rd consecutive stuck intervention, the recent response openings are passed along as banned phrases and the turn must start with a tool call.
- **Degeneration kill switch**: if the model repeats the same sentence many times, one word 16× consecutively, or a short phrase of up to four words 8× consecutively within visible output or provider thinking/reasoning, the stream is aborted live, the response is truncated in the session, and both text and thinking context are sanitized before every LLM call. The abort enters automatic stuck recovery, so unattended loops continue instead of pausing and the garbage cannot reinforce itself.
- **Sampling penalties**: after every stuck intervention, `frequency_penalty`/`presence_penalty` (0.5) are set for 3 iterations and the temperature slightly raised — only on OpenAI-compatible APIs (vLLM, Ollama). This fights repetition at the sampling level, where prompts alone often are not enough.
- **Rescue model** (`--rescue-model M`): from 3 consecutive stuck interventions, a stronger model takes over for one turn, cleans up, and leaves a clear plan (`PROGRESS.md`, `IMPROVEMENTS.md`, `NEXT:` line).
- **Auto-compaction**: from 5 consecutive stuck interventions, the context is compacted — a fresh context window often breaks fixations better than any prompt intervention.
- **Emergency context recovery**: at context saturation, loop mode can bypass the failing summarization model. It creates a bounded local summary from loop state, file-operation metadata, and excerpts from `GOAL.md`, `PROGRESS.md`, `IMPROVEMENTS.md`, and `ASSUMPTIONS.md`. Normal Pi compaction remains preferred when it works.
- **Circuit breaker**: after two emergency recoveries without a successful assistant turn, the third context-pressure failure pauses the loop. Run `/compact` and then `/loop resume` after addressing the context; ordinary temporary provider outages still use backoff.
- **Prompt variation**: the "continue" prompt is slightly varied — identical prompts encourage identical (repetitive) answers.
- **Backlog-driven improve mode**: after `LOOP_DONE` in endless mode, the loop works through an `IMPROVEMENTS.md` backlog: concrete items with file paths and an acceptance criterion; vague items ("add support for other platforms") are forbidden. Implement the top item, check it off.

### Compaction settings for very large-context models

Pi's defaults suit most models. For a 512k model with a 65,536-token output budget and tool-heavy turns, add project-local `.pi/settings.json`:

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 65536,
    "keepRecentTokens": 150000
  }
}
```

This starts normal compaction near 87.5% usage and keeps enough recent context that the older summarization request remains comfortably below the model limit. These absolute values are specific to a 512k context window. If normal summarization still fails, a saturated manual `/compact` uses loop mode's local emergency summary.

### Iteration log and `/loop stats`

Every loop event (continue, stuck, rescue, compact, error, done, soft_stop, …) is written as a JSONL line to `.pi-loop-log.jsonl` in the working directory (timestamp, iteration, event, model, score, stuck streak). The active file is capped at 5 MiB and rotated to one `.pi-loop-log.jsonl.1` backup, bounding retained data near 10 MiB. `/loop stats` reads only those bounded files, ignores malformed lines, and summarizes event distribution, interventions, productive iterations per hour, and score trend (first/best/last).

---

## 8. Practical examples

> **Tip:** `/loop-examples [focus]` (e.g. `/loop-examples tests`) analyzes the current project and proposes ready-made, tailored `/loop` commands — with real paths, the actual test/build commands as `--check`, and model recommendations for weaker models. Focus values: `features`, `bugs`, `tests`, `refactor`, `docs`, `quality`.

### Example 1: 5-day product run with model separation (the core use case)

```text
# Phase 1: define the goal (starts nothing)
/loop goal Build a production-ready task-management REST API in ./taskapi (Node.js/Express, SQLite): CRUD for tasks/projects/tags, JWT auth, validation, OpenAPI docs, comprehensive tests. Work in git, commit every completed unit. Improve continuously: new features, more tests, bug fixes, refactoring, performance. --check "cd taskapi && ./check.sh" --delay 10

# Phase 2: strong model writes GOAL.md + check.sh (~1 turn, then GOAL_READY)
/loop prepare --model anthropic/claude-opus-4-6

# → review GOAL.md, adjust if needed …

# Phase 3: local/cheap model works for days
/loop run --model vllm-omega/qwen3-coder-30b
```

with `taskapi/check.sh`:

```bash
#!/usr/bin/env bash
cd "$(dirname "$0")" || exit 1
npm run build >/dev/null 2>&1 || { echo "SCORE: 0"; exit 1; }
passed=$(timeout 90 npm test 2>/dev/null | grep -oE '[0-9]+ passing' | grep -oE '[0-9]+' || echo 0)
endpoints=$(grep -rcE 'router\.(get|post|put|delete)' src/routes/ 2>/dev/null | awk -F: '{s+=$2} END {print s+0}')
echo "SCORE: $(( passed * 2 + endpoints ))"
exit 1   # endless mode: never "done", always keep improving
```

The loop runs endlessly, the score grows with tests and endpoints, regressions are detected immediately. The Qwen model follows the specification written by Opus. After 5 days: `/loop stop`.

**Switching models mid-run** (e.g. because the local model fails at a milestone):

```text
/loop stop
/loop resume --model anthropic/claude-sonnet-4-5
```

### Example 2: bug hunt until everything is green

```text
/loop start Fix all failing tests in this repo. Done when: entire test suite green. --check "npm test" --until-done
```

Stops automatically and verified as soon as `npm test` exits with 0 — regardless of what the model claims in between.

### Example 3: driving up test coverage

```text
/loop start Raise the test coverage of ./src to at least 90%. Write meaningful tests, do not mock everything. --check "./coverage-check.sh" --until-done --check-timeout 300
```

```bash
#!/usr/bin/env bash
# coverage-check.sh
cov=$(npx vitest run --coverage 2>/dev/null | grep -oE 'All files[^0-9]+[0-9]+\.[0-9]+' | grep -oE '[0-9]+\.[0-9]+' | head -1)
cov=${cov%%.*}
echo "SCORE: ${cov:-0}"
[ "${cov:-0}" -ge 90 ] && exit 0 || exit 1
```

### Example 4: cautious first run with a new open-source model

```text
/loop start Refactor ./legacy to TypeScript, module by module. Commit after each module. --max 20 --delay 15 --check "cd legacy && npx tsc --noEmit && npm test"
```

`--max 20` limits the test run. Then inspect the result and continue with `/loop resume --max 100` (or without a cap).

### Example 5: documentation maintenance overnight

```text
/loop start Complete the documentation in ./docs: every public function documented, examples for all modules, README up to date. Continuously improve clarity and completeness.
```

Without `--check` (documentation quality is hard to measure) — the no-progress audit still ensures files actually get changed.

### Example 6: paying down lint debt (negative score)

```text
/loop start Eliminate all ESLint warnings and errors in the repo without changing functionality. Done when: eslint reports nothing. --check "./lint-check.sh" --until-done
```

```bash
#!/usr/bin/env bash
count=$(npx eslint . 2>/dev/null | grep -cE 'warning|error')
echo "SCORE: $(( -count ))"
[ "$count" -eq 0 ] && exit 0 || exit 1
```

The score starts at e.g. −347 and works its way toward 0. Every new warning (regression) is spotted immediately.

---

## 9. Best practices for multi-day runs

1. **Work in a git repository** and demand it explicitly in the goal ("commit every completed unit"). Commits survive compaction, restarts, and context loss — and regressions can be found via `git diff`.
2. **Always use `--check`** when anything is measurable. The goal function is the strongest lever against model hallucinations.
3. **Demand `PROGRESS.md`** — it is also part of the skill rules. After compaction or a restart, the model orients itself by it.
4. **Set `--delay` with commercial APIs** (e.g. 10–30 s) to manage rate limits and costs; with local models usually 0.
5. **First run with `--max 15–25`** on an unknown model: check the behavior, then `/loop resume` without a cap.
6. **Phrase the goal concretely**: technology, directory, quality expectations, improvement directions. "Build something cool" produces drift; example 1 above is the right level of detail.
7. **Mind the sandbox**: the loop works unattended with full tool permissions. For long runs use a dedicated directory/repo, ideally a VM/container, with no production systems in reach.
8. **Version the check script** (commit it to the repo) — then the model can read it and understands what it is measured against. But make clear in the goal that the check script must not be manipulated.

---

## 10. Status display and monitoring

**Status bar** (footer, live):

```text
Loop 142/∞ · 1d 7h 23m · err 3 · score 87: Build a production-ready task-management…
```

- `142/∞` — iterations / cap
- `1d 7h 23m` — elapsed time
- `err 3` — total model/provider errors (all survived automatically)
- `score 87` — last check score (or `check ✓`/`check ✗` without a score)

**`/loop status`** shows the full state:

```text
Active: true
Status: running
Goal: Build a production-ready task-management REST API in ./taskapi …
Criteria: - (endless improvement)
Mode: endless
Iterations: 142/∞
Delay: 10s
Check: cd taskapi && ./check.sh (timeout 120s)
Check status: failing (streak 2), score 87 (best 91 @ iter 138)
Goal file: GOAL.md (prepared)
Loop model: vllm-omega/qwen3-coder-30b
Rescue model: anthropic/claude-sonnet-4-5
Elapsed: 1d 7h 23m
Errors: 3 total, 0 consecutive
Interventions: 7 (stuck streak: 0)
Done signals: 2, blocked signals: 1
Last notice: -
Session entries: 4211
```

Interesting fields:
- **Interventions** — how often stuck/audit/regression prompts were needed (high value → model is struggling; phrase the goal more concretely or pick a stronger model).
- **Done signals** — how often the model reported "done" (normal and harmless in endless mode).
- **Check status** — `streak` counts consecutive check failures; `best @ iter` shows when the best value was reached.

**`/loop stats`** evaluates the iteration log `.pi-loop-log.jsonl` (current run, otherwise all runs):

```text
Loop stats (current run, 214 entries, .pi-loop-log.jsonl):
Events: continue 187, stuck 14, done 6, rescue_start 3, compact 1, error 3
Interventions: 18 (rescue 3, compact 1)
Productive iterations/h: 11.2
Score: first 12, best 91, last 87
```

This lets you compare which model or goal phrasing runs stably (few interventions, high productive rate, rising score). The file lives in the working directory — consider adding it to `.gitignore`.

---

## 11. Internals & tuning constants

Constants at the top of `extensions/index.ts`:

| Constant | Value | Meaning |
|----------|-------|---------|
| `BASE_BACKOFF_SECONDS` | 5 | Initial backoff after a model error. |
| `MAX_BACKOFF_SECONDS` | 300 | Backoff ceiling (5 min). |
| `NO_PROGRESS_WINDOW` | 8 | Iterations without a concrete change until the audit prompt. |
| `AUTO_RESUME_DELAY_MS` | 3000 | Wait before auto-resume after a restart. |
| `MAX_STORED_TEXT` | 280 | Snippet length for persisted fingerprints. |
| `SIMILARITY_THRESHOLD` | 0.8 | Jaccard threshold for near-duplicate responses. |
| `REPEAT_WINDOW_COUNT` | 3 | Same fingerprint N× in the recent window = stuck. |
| `MAX_TOOLLESS_TURNS` | 3 | Turns without a tool call until a stuck intervention. |
| `HARD_RESET_AFTER` | 3 | Stuck streak until hard-reset escalation. |
| `DEGENERATE_REPEATS` | 4 | Sentence repeats in one response = degenerate. |
| `DEGENERATE_STREAM_REPEATS` | 6 | Sentence repeats at which the stream is aborted mid-generation. |
| `DEGENERATE_WORD_REPEATS` | 16 | Consecutive repeats of one word = degenerate. |
| `DEGENERATE_PHRASE_REPEATS` | 8 | Consecutive repeats of a short phrase = degenerate. |
| `DEGENERATE_MAX_PHRASE_WORDS` | 4 | Maximum token width of a repeated phrase. |
| `RESCUE_AFTER` | 3 | Stuck streak until the rescue turn (if `--rescue-model`). |
| `COMPACT_AFTER` | 5 | Stuck streak until auto-compaction. |
| `PENALTY_TURNS` | 3 | Iterations with sampling penalties after an intervention. |
| `LOG_FILE` | `.pi-loop-log.jsonl` | Active iteration log for `/loop stats`. |
| `MAX_LOG_BYTES` | 5 MiB | Per-file limit; one `.1` backup is retained. |
| `CONTEXT_PRESSURE_PERCENT` | 85 | Context utilization that makes length/context errors eligible for emergency recovery. |
| `LOW_OUTPUT_LENGTH_TOKENS` | 32 | Maximum output on a `length` stop classified as context pressure regardless of percentage. |
| `MAX_EMERGENCY_SUMMARY_CHARS` | 24,000 | Hard bound for the LLM-independent emergency summary. |

**How the detection works:**

- *Repetition detection*: SHA-256 fingerprint over normalized response text (whitespace/ANSI removed, lowercased, first 4,000 characters). The last 5 assistant responses and the last 10 tool results are compared. Error turns (`stopReason: error/aborted`) are not included in the fingerprints.
- *Progress detection*: `write`/`edit` tool calls, success keywords in tool outputs (`created`, `passed`, `committed`, …), or a new check best score.
- *Persistence*: state is stored as a custom session entry (`loop-state`) via `pi.appendEntry()` — it does **not** enter the LLM context.
- *Goal check*: runs via `pi.exec("bash", ["-lc", CMD])` with a timeout; `SCORE:` parsing via regex (last occurrence wins, negative/decimal values allowed).
- *Context hygiene*: the loop injects only one compact prompt per iteration (goal + rules + check status) and allows pi's normal compaction — the session is never fully re-injected.

---

## 12. FAQ

**Why doesn't the loop stop when the model says "done"?**
Because that is the use case: a product that keeps growing over days. In endless mode, `LOOP_DONE:` leads to the "improve" prompt (next feature, more tests, bug fix, …). If you want classic "until finished," use `--until-done` — ideally with `--check`.

**The model claims the tests are green, but they aren't.**
That is exactly what `--check` is for. The loop only believes the exit code of the check command, never the model's claim.

**What happens during a rate limit in the middle of the night?**
Retry with exponential backoff up to max. 5 min between attempts, unlimited retries. In the morning, `err N` in the status bar shows how often it struggled.

**Can I use different models for planning and execution?**
Yes — that is the recommended workflow: `/loop goal <goal>` (only sets the goal), `/loop prepare --model <strong model>` (writes `GOAL.md` + check script), `/loop run --model <cheap model>` (works through the specification). The loop model is stored and restored on auto-resume after a restart.

**What happens to GOAL.md after preparation?**
It sits in the project as a normal file — you can review and edit it before `/loop run`. The loop references it in every prompt; the working model reads it in the first iteration and whenever it loses track.

**Can I intervene while the loop is running?**
Yes. A normal message is fed into the loop as steering. `Esc` pauses the loop (deliberately — operator's will), `/loop resume` continues. `/loop finish` stops gracefully after the current iteration.

**Won't the loop eventually eat the entire context?**
Pi's automatic compaction is the primary defense. If its summarization request itself no longer fits, loop mode recognizes the resulting low-output `length`/context error and performs one bounded, LLM-independent emergency compaction. A circuit breaker pauses after repeated failed recoveries instead of making the context larger with endless retries. Long-term orientation should still live in `GOAL.md`, `PROGRESS.md`, and git history.

**What if the check script itself is broken?**
Warning in the UI, the loop continues undisturbed (the check never blocks). `/loop resume --check "corrected CMD"` sets a new check command.

**Does this work with local models (Ollama/vLLM)?**
Yes — the loop is model-agnostic and specifically hardened for weaker models (repetition and degeneration detection, sampling penalties, rescue model, auto-compaction, completion verification via check, error retry). Recommendation for small models: a more concrete goal, always `--check`, set `--rescue-model <strong model>`, possibly `--max` for the first run.

**The model keeps repeating the same sentence, word, or short phrase — what should I do?**
Nothing — there are multiple defense lines for exactly this: near-duplicate detection catches rephrased repetition, while the degeneration kill switch aborts sentence loops, single-word runs (16×), and short-phrase runs (8×) mid-stream and cuts them out of the context. Automatic stuck recovery continues the loop; sampling penalties, the rescue model, and auto-compaction provide further escalation. If it still happens frequently: check `/loop stats` — many `stuck`/`compact` events point to a model that is too weak or a goal that is too vague.

**How do I stop everything and start fresh?**
`/loop end` clears the state completely. `/loop start <new goal>` also replaces the loop entirely.
