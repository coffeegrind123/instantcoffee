# Verifying it works

There is no scored eval suite in this repo any more — removed 2026-08-15, with
the 3.8 migration; the harness, its committed scorecard, its badges and its
Harbor adapter all went together. On this branch there is also no local model to
benchmark: decode speed, draft acceptance, prefill rate and VRAM are not
quantities this stack has. What is left to verify is the machinery *around* the
model, and every check below runs with no GPU and no API key.

## The suites

These are the same commands CI runs, and they are the whole verification surface
for this branch:

```bash
# pi's extensions
node --experimental-strip-types --no-warnings --test \
  .pi/extensions/tests/*.test.ts \
  .pi/extensions/compaction-guard/tests/*.test.ts \
  .pi/extensions/observe/tests/*.test.ts

# the surviving scripts, by hand
python scripts/test_browser_cli.py
python scripts/test_container_env.py
python scripts/test_untrusted_content.py

# the vendored forks
(cd vendor/rtk-pi && node --experimental-strip-types --test tests/*.test.ts)
(cd vendor/pi-persona && npm run lint && npm test)
(cd vendor/pi-toolresult-guard && npm run lint && npm test)
(cd vendor/pi-loop-mode && npm run lint && npm test)
(cd vendor/pi-subagents-lite && \
  node --experimental-strip-types --test tests/mode-seed.test.ts tests/mode-agents.test.ts)

# a binary this repo does not own, whose behaviour the rtk allow-list assumes
./scripts/rtk.sh --install
./scripts/rtk.sh --check

# the Matrix channel (build the sidecar runtime first, then unit + e2e)
(cd vendor/prinny-channel && node server/bin/prinny-channel.mjs --prepare)
(cd vendor/prinny-channel && npm run test:unit)
(cd vendor/prinny-channel && npm run test:e2e)

# config that only fails mid-session if it is wrong
docker compose config
```

The syntax checks CI adds on top — `py_compile` over `scripts/*.py`, `bash -n`
over `scripts/*.sh`, and a type-strip parse of every extension — are worth
running before a commit for the same reason CI has them: pi is lenient about a
malformed extension and a malformed skill, so a parse error presents as a
feature that is quietly absent rather than as an error.

Two of these suites are the ones worth understanding, because their failure mode
is silent:

- **`vendor/rtk-pi`'s gate** decides which bash commands get their output
  rewritten before pi sees it. Too permissive and a command is quietly replaced
  by a different one; too strict and the savings evaporate. `./scripts/rtk.sh
  --check` re-runs every measurement the allow-list rests on against the
  installed binary.
- **`vendor/pi-toolresult-guard`** keeps a malformed tool result from *exiting*
  pi. It is loaded first, so every other handler reads a content array that is
  already safe. A regression there ends the session, which is not something a
  green session would show you.

`vendor/pi-subagents-lite`'s full suite is not run here: its standing
`pi.exec`-verdict scan is order-sensitive under the node test runner's
parallelism and passes alone but flakes in the full run. The two files named
above pin the model-precedence ladder — the thing the three seats depend on —
and are deterministic.

## What CI runs that you do not run by hand

The workflow at `.github/workflows/ci.yml` also checks the things a session
would only discover live:

- every prompt fragment is non-empty, and the orchestrator prompt's
  `{{PLACEHOLDER}}`s are exactly the four the launcher fills;
- every key the launcher reads is present in `.env`;
- `skills/*/SKILL.md` frontmatter parses as real YAML with a valid name and a
  non-trivial body;
- `mcp/servers.json` entries have exactly one transport and never a literal
  secret, and `mcp/adapter.json` interpolates the browser host and port rather
  than hardcoding them;
- the browser is not registered as an mcp2cli server, and the MCP SDK stays
  pinned below 2.0;
- `docker compose config` parses.

## What this branch does not measure

Two honest gaps, both a consequence of the model being hosted:

- **Output quality is not benchmarked here.** The harness that scored reasoning
  effort against executed tests went with the local model. Nothing replaced it,
  because a benchmark of a hosted model's quality is not a property of this
  repo. If you want one, it belongs beside the prompts that shape the seats, not
  in `.env`.
- **Speed is Anthropic's to report.** The only timing this stack sees is the
  session's own `time to first token` and per-generation duration, which the
  observe dashboard records. Decode speed, draft acceptance and prefill rate
  were llama.cpp counters and there is no longer a llama.cpp to ask.

What replaced that surface is the **cache accounting**: the session's
`cacheRead` / `cacheWrite` / `cacheWrite1h` numbers, surfaced in `/session` and
the dashboard, are the quantity this branch actually optimises. A cache write
thrown away on the next turn is the regression to watch for, and
`showCacheMissNotices` is what makes it visible.

## What ended with the local model

The measurement commands the local branch carried are gone with the hardware:
the speculative-decoding sweeps (`spec-sweep.sh`, `capacity-probe.sh`), the
perplexity-at-depth and KL runs (`ppl-depth-run.sh`, `kld-run.sh`), the
throughput benches (`bench.sh`, `bench.py`, `bench_repeat.py`,
`bench_quality.py`), the literal-survival and context probes (`ctx_needle.py`,
`bench_literal.py`, `gguf_probe.py`, `template_probe.py`), and the workstream
tape (`capture.sh`, `capture_proxy.py`, `capture_sessions.py`). Their results are
still in `context/bench/` and `context/design/`, kept as the record of what the
local model did and why. They are not resurrectable against a hosted API, and
that is the point rather than an omission.

---

[← back to the README](../README.md)
