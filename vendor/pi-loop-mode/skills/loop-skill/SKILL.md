---
name: loop-skill
description: >
  Skill for operating the loop module. Use this skill when a loop is active.
  Defines the loop goal, monitors progress, breaks stuck cycles, and
  drives the agent toward completion. The operator can stop the loop at any time.
---

# Loop Skill

## Purpose

When loop mode is active, every turn must advance the loop goal in a small, concrete batch. The loop is designed for long unattended runs (hours to days): by default it never stops on its own — only the operator stops it with `/loop stop` (immediate) or `/loop finish` (after the current iteration).

## Operating rules

1. Use tools to inspect or change files; do not replace tool use with long narration. Every turn must contain at least one tool call — never answer with text only, and never claim something "already exists" without verifying it with a tool.
2. Keep assistant responses concise (under 1,200 characters).
3. Never dump full logs, full diffs, large files, or the whole conversation.
4. Produce a tangible artifact every few turns: a file change, a passing test, a fixed bug, a committed improvement.
5. If the core goal appears complete, say `LOOP_DONE: <one-line summary>`. In default (endless) mode the loop then continues with improvement work, driven by an `IMPROVEMENTS.md` backlog: concrete checklist items with affected file paths and a one-line acceptance criterion. Vague items without file paths are forbidden. Take the top open item, implement it, mark it done; add new specific items (based on tool inspection) when fewer than 3 remain. In `--until-done` mode the loop stops.
6. Never wait for a human. If information is missing, make the most reasonable assumption, record it in `ASSUMPTIONS.md`, and continue. Use `LOOP_BLOCKED:` only for truly impossible external barriers — the loop will still push you to continue with assumptions.
7. Maintain a `PROGRESS.md` for long runs: current state, decisions, next steps. This survives compaction and restarts.

## Commands

```text
/loop goal <goal[. Done when: criteria]> [--max N] [--delay S] [--check "CMD"] [--check-timeout S] [--file GOAL.md] [--model M] [--rescue-model M] [--until-done]
/loop prepare [--model M] [--file F]
/loop run [--model M] [--rescue-model M]
/loop start <goal> [flags]        # goal + run in one step
/loop resume [--max N] [--check "CMD"] [--model M] [--rescue-model M]
/loop status
/loop stats
/loop finish                      # soft stop: finish current iteration, then stop
/loop stop                        # hard stop: abort immediately, keep state
/loop end                         # stop and clear state
```

Recommended workflow: `/loop goal` (set only), `/loop prepare --model <strong model>` (write the spec), `/loop run --model <cheap model>` (execute).

- Default is **endless**: no iteration cap, `LOOP_DONE` does not stop the loop.
- `--max N` sets an optional iteration cap (pauses at N; `/loop resume` continues).
- `--delay S` waits S seconds between iterations.
- `--check "CMD"` sets an objective goal function: a shell command run after every iteration. Exit 0 = criteria met. Print `SCORE: <n>` (higher = better) for progress/regression tracking.
- `--until-done` stops the loop on verified completion (goal check passes; without a check: `LOOP_DONE:`).
- `--model M` selects the model per phase (`provider/id` or unique id substring).
- `--rescue-model M` sets a stronger model that takes over for a single cleanup turn after 3 consecutive stuck interventions.
- `/loop stats` summarizes the bounded per-iteration JSONL log (`.pi-loop-log.jsonl`, 5 MiB plus one `.1` backup): events, interventions, productive iterations/hour, score trend.
- If context pressure triggers emergency compaction, re-establish bearings from `GOAL.md`, `PROGRESS.md`, `IMPROVEMENTS.md`, `ASSUMPTIONS.md`, and recent git history before the next concrete batch.

## Preparation turns (/loop prepare)

When asked to prepare a goal specification:

1. Do NOT start implementing the goal.
2. Inspect the current project state, then write the goal file (default `GOAL.md`): refined objective, scope & non-goals, measurable completion criteria, milestone roadmap of small steps, quality standards (tests, docs, git commits), explicit assumptions.
3. If objectively checkable, create a check script (exit 0 = criteria met, print `SCORE: <n>`) and reference it in the goal file.
4. Keep the goal file under ~200 lines, concrete and unambiguous — it must guide another (possibly weaker) model through a long unattended run.
5. End with `GOAL_READY: <one-line summary>` and the exact `--check` command if you created a check script.

## Loop turns with a prepared goal

If a goal file exists, read it at the start of the run and whenever you lose track of the plan. Follow its milestone roadmap and quality standards.

## Goal check behavior

When a goal check is configured:

- Completion is decided by the check command, not by your claim. `LOOP_DONE:` with a failing check is rejected — fix exactly what the check reports.
- The current check status and score appear in every loop prompt. Treat the score as your fitness function: raise it.
- If the score drops, a recent change broke something. Inspect recent diffs and fix the regression before anything else.

## Stuck behavior

The extension detects being stuck via exact repeats, near-duplicate responses (≥ 80 % similarity, numbers ignored), alternating repeats, repeated tool results, turns without any tool call, and degenerate generation in either visible output or provider thinking/reasoning (the same sentence, one word repeated 16× consecutively, or a short phrase of up to four words repeated 8× consecutively within one response). Such turns are aborted mid-stream, truncated in context, and routed through automatic stuck recovery. If it reports that you are stuck:

- Do not repeat the same answer, command, or question — not even rephrased.
- If the intervention lists banned openings, never start your response with any of them; begin the turn with a tool call instead.
- Follow the injected strategy: list alternatives, switch subtasks, write `PROGRESS.md`, run tests and fix one failure, or review recent diffs.
- Keep the intervention response concise.

The extension never pauses on stuck detection; it escalates: rotating strategies with escalating delays → anti-repetition sampling penalties for a few turns → a single rescue turn with a stronger model (if `--rescue-model` is set) → automatic context compaction. It keeps going until the operator stops the loop.

## Rescue turns

If you are the rescue model (the prompt says "RESCUE TURN"): inspect the project state, fix or finish ONE concrete thing, rewrite `PROGRESS.md` with the next 3 unambiguous steps (exact file paths), update the `IMPROVEMENTS.md` backlog, and end with a single line `NEXT: <exact instruction for the next turn>`. Do not start large refactorings — you have one turn.

## Error behavior

If a turn fails with a model/provider error, the extension retries automatically with exponential backoff (5s → 5min). After recovery, briefly re-check the project state and continue — do not restart from scratch.
