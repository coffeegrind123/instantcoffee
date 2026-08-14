---
description: Inspect the current project and propose ready-to-run /loop commands (features, bug fixing, tests, refactoring, docs) — including setups for weaker/local models
argument-hint: "[focus: features|bugs|tests|refactor|docs|quality]"
---

Inspect this project and propose concrete, copy-pasteable `/loop` commands to improve it unattended. Focus: ${1:-all areas (features, bugs, tests, refactoring, docs)}.

Do this now:

1. Look at the project (README, package manifest, source layout, test setup, TODO/FIXME comments, open lint/build warnings). Use tools; do not guess.
2. Detect the available quality signals: test runner, linter, type checker, build command, coverage tooling. These become `--check` commands.
3. Output 4–8 tailored `/loop` command lines the operator can paste directly. Adapt the recipes below to THIS project: real file paths, the project's actual test/build commands, and a goal wording that a weaker model can follow for days.

## Recipe patterns to adapt

**Endless product improvement (default mode — runs until `/loop stop`):**

```text
/loop start Improve this project continuously: pick the most valuable next improvement (features, bug fixes, tests, refactoring, docs), implement it completely, and commit it. Keep IMPROVEMENTS.md as your backlog with file paths and acceptance criteria.
```

**Bug fixing with an objective check (exit 0 = green, SCORE = passing tests):**

```text
/loop start Fix all failing tests and eliminate warnings, then harden edge cases. Done when: test suite passes with zero warnings. --check "npm test" --until-done
```

**Test coverage as a fitness function (score must rise, regressions are auto-detected):**

```text
/loop start Raise test coverage: for each iteration, pick ONE untested module, write focused unit tests for its edge cases, and make them pass. --check "./check-coverage.sh"
```

(where `check-coverage.sh` runs the suite and prints `SCORE: <coverage %>`; exit 0 when the target is met)

**Feature roadmap from a spec file — the strong/cheap model split for weaker models:**

```text
/loop goal Implement the features listed in TODO.md one by one, each with tests and a commit. Done when: all TODO.md items are checked off.
/loop prepare --model anthropic/claude-opus-4-5
/loop run --model ollama/qwen3:14b --rescue-model anthropic/claude-sonnet-4-5
```

(an expensive model writes `GOAL.md` + check script once; a cheap/local model executes for days; the rescue model takes over for one turn when the loop gets stuck 3×)

**Refactoring with a safety net (tests must stay green — any regression triggers a fix prompt):**

```text
/loop start Refactor for readability and consistency: one module per iteration, no behavior changes, tests must stay green after every iteration. --check "npm test && npm run lint"
```

**Docs and examples:**

```text
/loop start Document every public function and add a runnable example per module; keep README feature list in sync with the code. --max 30
```

**Overnight run with throttling (rate limits / local hardware):**

```text
/loop start <goal> --delay 60 --model ollama/qwen3:14b --rescue-model anthropic/claude-sonnet-4-5
```

## Rules for your proposals

- Every proposed command must use this project's real commands and paths — no placeholders like `<test command>` unless nothing exists yet (then propose creating it as the first loop goal).
- Prefer goals with an objective `--check`: weaker models claim success without delivering; the check decides, not the model. Suggest a `SCORE:` output wherever a measurable number exists (passing tests, coverage, endpoint count, lint warnings as negative score).
- Goal wording must be batch-friendly: "one module/bug/feature per iteration", "commit after each change" — so a weak model always has an obvious next step.
- For projects without git: recommend `git init` first; incremental commits are the loop's safety net.
- End with a one-line recommendation: which single command to start with and why.
