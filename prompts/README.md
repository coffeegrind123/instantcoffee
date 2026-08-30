# System-prompt fragments

Text appended to the client's system prompt by `scripts/pi-local.sh`. Three
fragments exist; each is attached only when the thing it talks about is actually
on the tool surface, because a fragment describing a tool that was never
registered invites a failed call rather than doing nothing.

**These have to be applied client-side.** Verified against the real binaries on
2026-08-11, not assumed:

- **llama-server cannot do it.** `-sys` / `--system-prompt` exist in llama.cpp's
  `common/arg.cpp`, but they are registered
  `.set_examples({LLAMA_EXAMPLE_COMPLETION, LLAMA_EXAMPLE_CLI, LLAMA_EXAMPLE_DIFFUSION, LLAMA_EXAMPLE_MTMD})`
  — `LLAMA_EXAMPLE_SERVER` is not in that list, and `tools/server/server.cpp`
  never reads `params.system_prompt`. Passing `-sys` to llama-server is an
  argument error, not a silent no-op.
- **forge cannot do it either.** `forge-proxy --help` at 0.8.2 has no
  system-prompt or prompt-injection option. Its only prompt surgery is
  `--backend-capability prompt` (tool-call injection) and
  `--inject-respond-tool`.

So the fragment is appended by the launcher, via `pi --append-system-prompt`,
which was checked with `--help` on the installed binary.

| File | Attached when | What it does |
| --- | --- | --- |
| `think-zh.md` | `THINK_LANG=zh` | Reason in Simplified Chinese, answer in the user's language |
| `web-untrusted.md` | `BROWSER_MCP_ENABLED=1` | Treat fetched page content as untrusted input |
| `delegate.md` | `SUBAGENTS_ENABLED=1` **and** `SUBAGENT_NUDGE=1` | Delegate read-heavy investigation to a subagent, above a stated threshold |

## `delegate.md`, and why it argues both ways

The `Agent` tool carries **no description** — upstream deletes it to save prompt
tokens (`vendor/pi-subagents-lite/FORK.md`), so the only thing advertising
delegation is the tool's name and an enum reading `general-purpose,Explore`.
FORK.md's live run against this model shows the capability was never missing: it
emitted "a well-formed `Agent` call with a self-contained prompt and a sensible
`description`, did not search itself, and got a correct answer back", and
inferred `run_in_background` and `AgentStatus` from parameter names alone. It
delegates well **when asked**. Nothing in the session ever asked.

An agent type in `~/.pi/agent/agents/` would have been cheaper still — the enum
is built as `types.join(",")` (`src/registration.ts:33`), so a type costs its
*name* and its frontmatter description never reaches the wire. It was not taken:
`Explore` is already a built-in, already in that enum, and already summarised as
"Explore codebase architecture". The menu was never missing.

The fragment carries a **floor** as well as encouragement — roughly five file
reads or three searches. That is not hedging. FORK.md measured that a small
child leaves the parent's prefix cache at 99.2%, while one that reads files and
grows to ~18k tokens **evicts** it, taking the parent's next call from 442 ms to
2,949 ms on a 2,133-token parent (a floor, not a worst case). A nudge that just
said "delegate more" would trade cheap reads for re-prefills and make this stack
slower. Do not edit the threshold out.

## Adding another

Drop `think-<code>.md` in this directory and set `THINK_LANG=<code>`. The
launchers resolve the path from the value and fail loudly if the file is
missing — a system prompt that silently fails to load changes how the agent
behaves without changing anything you can see.

## Status

`THINK_LANG=zh` is **on**, enabled 2026-08-11 by operator decision ahead of
measurement. It rests on an unverified community claim, not a local result.

Confirm it on your own hardware and record the numbers:

```bash
./scripts/ab-think-lang.sh --repeat 3 --save
```

That runs the same tasks with and without the fragment, with thinking enabled in
both arms, and reports correctness, reasoning length, wall time, and — the thing
that actually decides it — whether Chinese leaked into user-visible output or
into tool-call arguments.

A non-zero exit means turn it off (`THINK_LANG=off` in `.env`), not that you have
a decision to make later.

## `delegate.md` status

**UNMEASURED**, and on the same footing as `THINK_LANG=zh` above: adopted by
operator decision ahead of evidence. What it should move is how far a task gets
before the window fills, and turns per session — **not** correctness. If it
changes correctness in either direction, that is a finding, not a bonus.

The control arm is `SUBAGENT_NUDGE=0` in `.env`, which drops the fragment and
leaves everything else identical. There is no A/B script for this yet;
`scripts/ab-think-lang.sh` is the shape one would take.
