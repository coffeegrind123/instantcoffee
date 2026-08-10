# System-prompt fragments

Text appended to the client's system prompt by `scripts/claude-local.sh` and
`scripts/pi-local.sh` when `THINK_LANG` is set in `.env`.

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

So the fragment is appended by the launcher, via `claude --append-system-prompt`
and `pi --append-system-prompt`, both of which were checked with `--help` on the
installed binaries.

| File | `THINK_LANG` | What it does |
| --- | --- | --- |
| `think-zh.md` | `zh` | Reason in Simplified Chinese, answer in the user's language |

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
