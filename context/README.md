# context/

Internal development documentation — the reasoning behind the stack, kept
separate from `README.md`, which is the operating manual.

| File | What it holds |
| --- | --- |
| `design/decisions.md` | Every design decision, in date order: model and quant choice, llama.cpp and forge flags, environment traps that cost real time, the settings review against other public Qwen3.6 rigs, and the 2026-08-12 entries covering the move to pi-only, headroom, and MCP-as-a-CLI. |
| `design/eval-methodology.md` | What the eval suites measure, where the benchmarks come from, and how scoring works. |

Two conventions this directory follows, both worth keeping:

**Dates and observed values stay in.** Every claim records when it was verified
and against what, so a future reader can tell what has gone stale rather than
guessing. Superseded passages are marked as superseded rather than deleted —
the log is a record of what was believed and why, not a description of the
current tree. `README.md` is where the current tree is described.

**Unverified claims are labelled as unverified.** `THINK_LANG=zh` is on while
resting on a community claim; the headroom numbers do not exist yet. Both say
so, and both name the harness that would settle them.
