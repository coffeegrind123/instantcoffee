# pi-loop-mode

> Unattended loop mode for [pi](https://github.com/earendil-works/pi) — endless, self-correcting agent iterations for multi-day runs.
>
> **Full documentation with examples: [DOCUMENTATION.md](DOCUMENTATION.md)** (deutsche Übersetzung: [DOCUMENTATION_de.md](DOCUMENTATION_de.md))

Pi package for an unattended loop mode: give the agent a goal and it works on it in small iterations until **you** stop it — designed for multi-day runs where a product keeps growing (features, tests, bug fixes, refactoring, docs). Works with commercial and open-source models alike.

## Preview

[![pi-loop-mode preview](https://unpkg.com/pi-loop-mode@2.5.4/assets/pi-loop-mode-preview.png)](https://unpkg.com/pi-loop-mode@2.5.4/assets/pi-loop-mode-demo.mp4)

Click the preview image to open the short MP4 demo. The same video is also exposed as `pi.video` metadata for the pi.dev package gallery.

## What it does

- **Endless by default**: no iteration cap. The loop runs until `/loop stop`. Set `--max N` for an optional cap, `--until-done` if completion should actually stop the loop.
- **Objective goal function** (`--check "CMD"`): a shell command run after every iteration. Exit code 0 = criteria met (verified completion in `--until-done` mode — the check decides, not the model's claim). Optional `SCORE: <n>` output enables progress tracking: score improvements count as real progress, score regressions trigger an immediate "find and fix the regression" prompt. Essential against models that claim success without delivering.
- **Error resilience**: transient model/provider errors retry with exponential backoff (5s → 5min). Context-pressure failures take a safer path: emergency compaction without another model call, followed by a two-attempt circuit breaker instead of an endless `400` retry loop.
- **Garbage/repetition detection**: repeated assistant answers (exact fingerprints *and* near-duplicates via trigram similarity with numbers masked, alternating A-B-A-B patterns), repeated tool results/errors, repeated questions, and narration-only turns (3 turns without a single tool call) are all detected. Instead of pausing, the loop injects rotating recovery strategies (switch subtask, write PROGRESS.md, run tests and fix one failure, review diffs, list alternative approaches) with escalating delays — important for weaker open-source models that loop on the same output.
- **Degenerate-generation kill switch**: if one sentence dominates a response, one word repeats 16× consecutively, or a short phrase (up to four words) repeats 8× consecutively in visible output or provider thinking/reasoning, the stream is aborted live, the stored message is truncated, and already-poisoned context is sanitized before every LLM call. The abort enters automatic stuck recovery instead of pausing the loop.
- **Escalation ladder on persistent stuck**: rotating strategy → anti-repetition sampling penalties (`frequency_penalty`/`presence_penalty` + higher temperature for 3 turns, OpenAI-compatible APIs only) → hard reset with banned openings → one rescue turn by a stronger model (`--rescue-model M`, after 3 consecutive stuck interventions) → automatic context compaction (after 5).
- **Context-overflow recovery**: a `length` stop with almost no output, or a context-saturated 400/token error, triggers a bounded local compaction built from loop state and durable project files. Saturated manual `/compact` uses the same LLM-independent fallback.
- **Backlog-driven improvement mode**: after `LOOP_DONE` in endless mode the loop works off an `IMPROVEMENTS.md` backlog — concrete checklist items with file paths and acceptance criteria; vague items ("add support for other platforms") are forbidden.
- **Bounded per-iteration JSONL log** (`.pi-loop-log.jsonl`, 5 MiB + one `.1` backup) with `/loop stats`: event distribution, interventions, productive iterations/hour, score trend — compare models and goal phrasings without unbounded disk growth.
- **No-progress audit**: if no concrete file/system change happens for 8 iterations, the loop demands a tangible artifact (file change, passing test, fixed bug).
- **Never waits for a human**: `LOOP_BLOCKED:` does not pause the loop. The model is told to make a documented assumption (`ASSUMPTIONS.md`) and keep going.
- **Done ≠ stop (endless mode)**: when the model reports `LOOP_DONE:`, the loop continues with improvement work — new features, more tests, bug fixes, refactoring, performance, docs.
- **Auto-resume**: loop state is persisted in the session; after a pi restart/reload an active loop resumes automatically after 3 seconds.
- **Short iterations**: every loop prompt tells the model to do one concrete progress batch and keep output under 1,200 characters, so context stays small and normal compaction works.
- **Operator control**: `Esc` (abort) pauses the loop; `/loop resume` continues it; `/loop finish` soft-stops it (current iteration completes, then no new turn); `/loop stop` stops it immediately; `/loop end` clears state.

## Recommended workflow: separate goal, preparation, and execution

```text
/loop goal <goal + flags>                       # 1. set the goal — starts nothing
/loop prepare --model anthropic/claude-opus-4-6  # 2. strong model writes GOAL.md + check script (ends with GOAL_READY:)
/loop run --model vllm-omega/qwen3-coder-30b --rescue-model anthropic/claude-sonnet-4-5
#                                                # 3. cheap/local model works the loop against the spec;
#                                                #    the rescue model takes over for one cleanup turn when stuck
```

Planning and execution are decoupled: an expensive model writes a precise spec once (`GOAL.md`, reviewable/editable before the run), a cheap or local model executes it for days. The run model is persisted and restored on auto-resume. Switch models mid-run with `/loop stop` + `/loop resume --model M`.

## Commands

Pi slash commands only match the first word, so this package registers a single `/loop` command with subcommands:

| Command | Description |
|---------|-------------|
| `/loop goal <goal> [flags]` | Set goal + config without starting. `/loop goal` shows it. |
| `/loop prepare [--model M] [--file F]` | Have a (strong) model write the goal spec (`GOAL.md`) + check script. |
| `/loop run [--model M]` | Start the loop, optionally with a different model. |
| `/loop start <goal>` | Shortcut: goal + run in one step (endless loop). |
| `/loop start <goal. Done when: criteria>` | Optional explicit completion criteria. |
| `/loop start <goal> --max 50` | Optional iteration cap (pauses at N). |
| `/loop start <goal> --delay 30` | Wait 30s between iterations. |
| `/loop start <goal> --check "npm test"` | Objective goal check after every iteration. |
| `/loop start <goal> --check "./check.sh" --check-timeout 300` | Check with custom timeout (default 120s). |
| `/loop start <goal> --until-done` | Stop on verified completion (check passes; without check: `LOOP_DONE:`). |
| `/loop start <goal> --rescue-model M` | Stronger model takes over for one cleanup turn after 3 consecutive stuck interventions. |
| `/loop resume [--max N] [--model M] [--rescue-model M]` | Continue a stopped/paused loop, optionally switching models. |
| `/loop status` | Show loop state, errors, interventions, iterations. |
| `/loop stats` | Summarize the per-iteration JSONL log: events, interventions, iterations/hour, score trend. |
| `/loop finish` | Soft stop: finish the current iteration, then stop (state preserved). Alias: `/loop soft-stop`. |
| `/loop stop` | Hard stop: abort the in-flight turn immediately and preserve state. |
| `/loop end` | End the loop and clear state. |
| `/loop help` | Show command help. |

Additionally, the `/loop-examples [focus]` prompt template inspects the current project and proposes ready-to-paste `/loop` commands (features, bug fixing, tests, refactoring, docs) — including model-split setups for weaker/local models. Focus values: `features`, `bugs`, `tests`, `refactor`, `docs`, `quality`.

Example — a 5-day product-building run:

```text
/loop start Build a complete REST API for task management in ./taskapi: CRUD, auth, SQLite, tests, docs. Keep improving it: more features, better tests, bug fixes, refactoring.
```

Then stop it whenever you want with `/loop stop`.

Example — with objective goal function:

```text
/loop start Build a REST API in ./taskapi. Done when: all tests pass --check "cd taskapi && npm test" --until-done
```

### Writing a goal check script

The check command is the loop's fitness function. Exit 0 = done criteria met; print `SCORE: <n>` (higher = better) for progress/regression tracking:

```bash
#!/usr/bin/env bash
# check.sh — example goal function
cd taskapi || { echo "SCORE: 0"; exit 1; }
npm run build >/dev/null 2>&1 || { echo "SCORE: 0"; exit 1; }   # build must work
passed=$(npm test 2>/dev/null | grep -oE '[0-9]+ passing' | grep -oE '[0-9]+' || echo 0)
echo "SCORE: $passed"
[ "$passed" -ge 50 ] && exit 0 || exit 1   # done when 50+ tests pass
```

Score ideas: number of passing tests, test coverage, implemented endpoints, `-` lint warning count. The score appears in every loop prompt and in the status bar, and drives regression detection.

## How failures are handled

| Situation | Behavior |
|-----------|----------|
| Model/provider error (crash, rate limit, timeout) | Retry with exponential backoff, then "recover" prompt; never gives up. |
| Model repeats the same answer/tool call/question | Stuck intervention with rotating strategies and escalating delay. |
| Model repeats a *near*-identical answer (≥ 80 % trigram similarity, numbers masked) | Also a stuck intervention. |
| Model answers with narration only (3 turns without any tool call) | Also a stuck intervention. |
| One sentence, word, or short phrase repeats mechanically within one response | Stream aborted mid-generation (sentences ≥ 6×, words ≥ 16× consecutively, phrases ≥ 8× consecutively); stored message truncated; automatic stuck recovery continues the loop. |
| 3 consecutive stuck interventions | Hard reset (banned openings, turn must start with a tool call) — or a one-turn takeover by the `--rescue-model`, if configured. |
| 5 consecutive stuck interventions | Automatic context compaction (repetitive filler explicitly excluded from the summary). |
| Any stuck intervention | Additionally: anti-repetition sampling penalties for the next 3 turns (OpenAI-compatible APIs). |
| Model produces analysis but no changes for 8 iterations | Audit prompt demanding a tangible artifact. |
| Model says `LOOP_DONE:` (endless mode) | Loop continues with backlog-driven improvement work (`IMPROVEMENTS.md`). |
| Model says `LOOP_DONE:` but goal check fails (`--until-done`) | Loop rejects the claim and demands fixing what the check reports. |
| Goal check score drops | Immediate regression prompt: inspect diffs, fix what broke. |
| Goal check passes (`--until-done`) | Verified completion — loop stops. |
| Goal check command itself fails to run | Warning shown; loop continues without blocking. |
| Model says `LOOP_BLOCKED:` | Loop instructs it to assume, document in ASSUMPTIONS.md, and continue. |
| Operator presses Esc | Loop pauses; `/loop resume` continues. |
| `/loop finish` (soft stop) | Current iteration completes, then the loop stops without a new turn; state preserved for `/loop resume`. Survives restarts (finalized on session start instead of auto-resuming). |
| pi restart / reload | Active loop auto-resumes after 3s, restoring the stored loop model. |
| Loop model unavailable after restart | Warning; loop continues with the current model. |
| `--max N` reached | Loop pauses; `/loop resume` continues (uncapped if exhausted). |

## Install

```bash
pi install npm:pi-loop-mode
```

Or from a local checkout:

```bash
pi install /path/to/pi-loop-mode
```

Then start or reload pi and run `/loop help`.

> **Security note:** pi packages run with full system access, and this package is built for *unattended* operation — the model works for hours without supervision. Use a dedicated directory/repo, ideally a VM or container, and keep production systems out of reach.

## Files

```text
pi-loop-mode/
├── package.json
├── README.md                 # This file
├── DOCUMENTATION.md          # Full documentation with examples (English)
├── DOCUMENTATION_de.md       # German translation
├── CHANGELOG.md
├── GALLERY.md                # pi.dev gallery asset notes
├── LICENSE                   # GNU AGPL v3.0 only
├── assets/                   # pi.dev preview video + poster image
├── extensions/index.ts       # Pi command/event orchestration
├── src/                       # Repetition, parsing, state, checks, and bounded logging
├── skills/loop-skill/SKILL.md  # Behavior rules for the model in loop mode
├── prompts/loop-prompt.md    # Prompt template
└── prompts/loop-examples.md  # /loop-examples — project-specific loop recipes (features, bugs, tests, …)
```

## Notes

- Loop state is persisted with `pi.appendEntry()` and does not add large payloads to model context.
- The loop deliberately allows Pi's normal compaction behavior; short per-turn output keeps multi-day runs compactable.
- Recommended for long runs: work in a git repo so the model can commit incrementally, and tell it so in the goal.
- The bounded per-iteration logs `.pi-loop-log.jsonl` and `.pi-loop-log.jsonl.1` are written to the working directory — add both to `.gitignore` if you don't want them committed.
- "Continue" prompts are slightly varied per iteration; identical prompts encourage identical (repetitive) answers from weaker models.
