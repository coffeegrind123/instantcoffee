# context/

Internal development documentation — the reasoning behind the stack, kept
separate from `README.md`, which is the operating manual.

| File | What it holds |
| --- | --- |
| `design/decisions.md` | Every design decision, in date order: model and quant choice, llama.cpp and forge flags, environment traps that cost real time, the settings review against other public Qwen3.6 rigs, and the 2026-08-12/13 entries — the move to pi-only, MCP-as-a-CLI, the KV-quantization and memory findings, and why headroom was evaluated and removed. |
| `design/eval-methodology.md` | What the eval suites measure, where the benchmarks come from, and how scoring works. |

Two conventions this directory follows, both worth keeping:

**Dates and observed values stay in.** Every claim records when it was verified
and against what, so a future reader can tell what has gone stale rather than
guessing. Superseded passages are marked as superseded rather than deleted —
the log is a record of what was believed and why, not a description of the
current tree. `README.md` is where the current tree is described.

**Unverified claims are labelled as unverified.** `THINK_LANG=zh` is on while
resting on a community claim, and says so, and names the harness that would
settle it (`scripts/ab-think-lang.sh`). Where a claim has since been measured —
the KV cache, the load mode, headroom's savings — the entry carries the number
and the method, not a conclusion on its own.
