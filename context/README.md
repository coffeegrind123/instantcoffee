# context/

Internal development documentation — the reasoning behind the stack, kept
separate from `README.md`, which is the operating manual.

| File | What it holds |
| --- | --- |
| `HANDOFF.md` | The state of play at the end of a working session: every path touched, what changed and why it mattered, what is verified against a real run and what is not, and the brief for the next session. Rewritten 2026-08-17 after the subagent work landed; the next session's subject is **visibility** — finding whoever has already built the Claude-Code-style agent taskbar (a status-line entry you can hop into a running subagent from), and giving the answer verifier a visual indicator for both its work and its verdict. |
| `testing/subagents-loop-verifier.md` | Hand-testing script for subagents, the `loop` tool and the verifier: a prompt per behaviour and what counts as evidence, including the `--mode json` recipes for the things that are invisible in the TUI, and the two paths that have never fired live. |
| `design/decisions.md` | Every design decision, in date order: model and quant choice, llama.cpp and forge flags, environment traps that cost real time, the settings review against other public Qwen3.6 rigs, the 2026-08-12/13 entries — the move to pi-only, MCP-as-a-CLI, the KV-quantization and memory findings, why headroom was evaluated and removed, the `/stack` extension, the Fable-Fusion evaluation, and the audit corrections — the 2026-08-15 entry, the migration to Qwen3.8-27B and the removal of the eval harness, and the 2026-08-16 entry, adopting rtk for bash-output filtering and the three research-pass findings that measurement overturned. It also carries the **Still open** list at the end, which is the successor to the old root-level `HANDOFF.md`. |

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

**Deleted history stays deleted, and stays described.** The scored eval harness
and its committed scorecard were removed on 2026-08-15. The entries that
recorded what it measured, and what it got wrong, are still here — a measurement
this repo has stopped taking is exactly the kind of thing a future reader will
otherwise re-invent.
