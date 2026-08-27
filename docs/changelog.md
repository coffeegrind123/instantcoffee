# Changelog

What changed on this stack, newest concern last within each entry. These were
blockquotes at the top of the README until 2026-08-25; they are history, not
instructions, and the README got unreadable carrying them.

For the reasoning behind a change rather than the fact of it, see
`../context/design/decisions.md`. For what is pinned right now, see
`../versions.lock` — that file, not this one, is the authority on current state.

---

**Migrated from Qwen3.6-27B on 2026-08-15**, the day 3.8-27B released. The
architecture string is unchanged (`qwen35`), so the pinned llama.cpp build
loads it as-is, and UD-Q4_K_XL is the same 17.9 GB — but three things moved:
MTP now ships in the mainline quant (no `*-MTP-GGUF` repo), the card publishes
one thinking temperature (1.0) where 3.6 published two, and there is a new
`reasoning_effort` control that defaults to `xhigh` and will eat any budget you
give it. See `REASONING_EFFORT` in `.env` and the 2026-08-15 entry in
`context/design/decisions.md`.

**Verified on this box on migration day:** smoke test 11/11 (including a real
tool call through forge), prefill **1175 tok/s**, decode **39.6 tok/s**, MTP
acceptance **86.2%**, VRAM **21469 / 24564 MiB** at 32K — within 100 MiB of
what 3.6 used, so the quant table below carries over unchanged. Decode is well
down on the 69.2 tok/s `versions.lock` recorded for 3.6; 86% acceptance at a
draft depth of **2** points at the inherited `SPEC_DRAFT_N_MAX` being too low
for 3.8's draft head, and that sweep is not finished.

**Settled 2026-08-17 — and the draft depth was not the problem.** A full 2×6
sweep (`./scripts/spec-sweep.sh`) found **p-min** was the binding knob: at
`p-min=0.75` the draft was cut to a single token on ~70% of cycles, so raising
`n-max` under it measured nothing. `.env` now runs
**`SPEC_TYPE=ngram-simple,draft-mtp`, `n-max 4`, `p-min 0.40`** — the measured
optimum, worth **1.23× on novel text and 2.20× on repetitive** against the old
values, and re-verified at 11/11 on the smoke test. `ngram-simple` drafts up to
48 tokens per lookup with no forward pass, but it is only safe at n-max 4 — at
n-max 2 it *costs* 25% on novel text. Costs 529 MiB of VRAM. Full tables in
`context/design/decisions.md` (2026-08-16 / 2026-08-17) and raw results in
`context/bench/spec-sweep/`.

forge went 0.8.2 → **0.9.0** in the same change, and that one is not a version
bump: 0.9 rejects `--budget-mode` for externally managed backends (the proxy
refuses to start), and `/health` now forwards the *backend's* readiness while
forge's own liveness moved to `/forge/health`. Both are handled here — see the
forge notes in `.env`. pi went 0.84.1 → 0.84.2, which is uneventful.

**Superseded 2026-08-22.** The line that used to stand here said llama.cpp
"stays pinned at `b10200` deliberately: nothing between it and the newest
published CUDA image is Qwen3.8-specific". That is no longer true, and the
pin has moved to **`server-cuda-b10573`**. Four commits in the gap bear on
this stack: a Qwen tool-call parsing fix (#26793), an MTP memory-allocation
fix (#26605), a `draft-mtp` fix (#27400), and `2b562109` (#26079), which adds
a CUDA MMVQ→MMQ crossover table labelled "tuned on RTX 4090" where `b10200`
had **no Ada Lovelace entry at all**. That last one changes nothing at the
current `n-max 4` — both builds pick the same kernel for a verify batch of 5
— but it is what makes the `n-max 6/8` rows of the sweep measure something
other than a GEMV cliff. The three correctness fixes are the immediate
reason to move.

**Also 2026-08-22 — the 32K context ceiling was a misdiagnosis, and is gone.**
The KV cache did not have to be `f16/f16`. A stock CUDA build compiles only
**matched** flash-attention KV pairs (`f16/f16`, `q4_0/q4_0`, `q8_0/q8_0`,
`bf16/bf16`); the experiment that produced the ~65x prefill collapse used
`f16` K with `q8_0` V, and it was the *mismatch* that pushed flash attention
onto the CPU, not the quantization. Confirmed by llama.cpp#20866. Matched
`q8_0/q8_0` halves the cache, so `CTX_SIZE` is now **98304**. 4-bit KV stays
off the table — llama.cpp#27109 (open) has `q4_x` collapsing prefill to
34–106 t/s on this exact `qwen35` hybrid architecture against 991–1276 t/s at
`q8_0`, which is what makes most of the public 130K–250K 4090 recipes
unusable here. DFlash2 (PR #27342) is **not** adopted: a report on the PR from
an RTX 4090 running this model against multi-turn tool-result histories — this
stack's exact workload — measures generation collapsing to 12–14 tok/s on a
real agentic session, with `draft-mtp` immune on the identical request.
Full reasoning and citations in the 2026-08-22 entry of
`context/design/decisions.md`.

**Measured on the box the same day**, on `b10573` / `q8_0-q8_0` / `65536`:
smoke test **11/11** including a real tool call through forge; VRAM
**22382 MiB of 24564** — double the context for **+384 MiB** against the old
f16/f16 32K config's 21998 MiB, with ~2.1 GiB spare. Prefill by prompt length:
1121 @ 541, 1504 @ 1053, 1799 @ 2077, 2032 @ 4125, 2338 @ 8221, 1706–2162 @
16413, 2243 @ 32797 tok/s — four digits throughout and *rising* with depth,
which is the proof that flash attention is on the GPU (llama.cpp#27109's 4-bit
failure is the opposite shape: two digits, falling). Decode 52.6–70.4 tok/s.
Two outlier runs were discarded as host contention, not measurement — see the
`verified` block in `versions.lock` for why and what the control was.

**Throughput itself is unchanged; the win banked here is the window.** The
speed work is `./scripts/spec-sweep.sh`, which now has n3/n6/n8 rows —
and it must be run on a quiet box.

---

**`Dockerfile.pi` — pi in a container of its own, 2026-08-26.** Optional, and
nothing else in this repo depends on it. It carries pi, Chrome + the Zendriver
MCP server, `rtk`, `mcp2cli`, `uv` and a docker client, so a session can be given
its own home directory. llama and forge stay in the compose stack on the host
GPU, driven through a mounted docker socket; `pi-local.sh` already swaps
`localhost` for `host.docker.internal` when it sees `/.dockerenv`, so no script
changed.

Three things it does deliberately, each paid for elsewhere in this stack:
every tool is installed into the **image** rather than `$HOME`, because `$HOME`
is the bind mount and anything the build writes there is shadowed the moment the
volume is attached; `x11-utils` is a hard dependency, because `browser.sh`'s
display probe otherwise falls back to a `pgrep` that a stale
`/tmp/.X11-unix/X99` socket satisfies and Chrome drops silently to headless; and
the image seeds **no credentials** of any kind, saying so at startup rather than
letting it be found at the first commit.

**Verified on the box:** the built image reaches forge at
`host.docker.internal:8081` and completes a real pi turn with a tool call; the
Zendriver server comes up with **98 tools** and drives a headed Chrome on Xvfb
through `navigate` + `get_text_content`; `scripts/browser.sh up/status/navigate/down`
works from inside against the read-only checkout.

`docs/container.md` also records the three absolute-path dependencies that break
quietly when an **existing** agent home is relocated — the crypto snapshot's
IndexedDB key above all — and why the one-bot-per-Matrix-account lock cannot see
across two containers' home directories.

**`scripts/pi-container.sh`, the same day.** The container is plumbing, so it
should not be something you drive: the launcher creates it on first use, reuses
it after, and delegates to `pi-local.sh` inside, so the flags, the banner and
the session are the ones already documented. It is a no-op wrapper when already
inside one — the image sets `PI_AGENT_CONTAINER=1` — which is what makes an
alias to it safe everywhere.

Three of its behaviours were bugs first and are worth keeping in mind. `docker
inspect` on a missing container exits non-zero **and** prints a newline, so the
obvious `... || echo absent` yields a value matching neither branch and docker
gets asked to start something that does not exist. A note printed on a function's
stdout is captured into the path it returns, and arrives as docker's
`Cwd must be an absolute path`. And "does this directory exist in the container"
is a false positive for `/tmp`, `/usr` and `/`, which exist on both sides and
mean different things — so the working-directory search is scoped to the
container's home, and running from the host's `/tmp` falls back with a note
instead of silently landing pi in an empty directory that looks fine.

**Corrected the same day:** scoping the working-directory search to the
container's *home* was too blunt. It also rejected a project deliberately
mounted somewhere else — which is the entire point of `PI_CONTAINER_EXTRA_ARGS`
— so launching from a mounted project still fell back to the home. The test is
now "is this path inside one of the container's bind mounts", which is the
question that was actually being asked: it keeps `/tmp` and `/usr` out and lets
a mounted project in. The fallback also says which mount is missing and prints
the `-v` line to add, rather than one dim line about not being visible.

**A relocated agent home needs `prinny-bot`'s `node_modules` too, 2026-08-26.**
`docs/container.md` said to copy the built runtime and verify with `--staged`,
which reports `current` and proves the source fingerprint matches. It does not
prove the channel can start. Where `PRINNY_BOT_PATH` names a local checkout the
runtime's `node_modules/@prinny/bot` is a symlink into it, and node resolves
through the symlink to the real path — so the bot's dependencies are looked up
in that checkout, not in the runtime. Omit them and every reader says healthy
until the sidecar throws `ERR_MODULE_NOT_FOUND` on `matrix-js-sdk`, which the
session surfaces as the far less specific "the channel is up but has not logged
into Matrix yet" — because the sidecar is up, and holding the account lock,
having failed a single import. The doc now says to import the module as the
check, rather than to trust the fingerprint.

**An unattended `/loop` could get stuck and stay stuck, 2026-08-27.** A run
against this stack produced nothing for 33 iterations and ~45 minutes of GPU,
and the loop's own escalation never fired. Four defects in a line, three of them
silent:

- **forge returned an empty 200 with no log line.** `FORGE_MAX_RETRIES=0` bounds
  the attempt loop at one; `FORGE_MAX_TOOL_ERRORS=2` bounds tool-error kinds at
  three. The second outlived the first, so the first malformed tool call left
  forge queueing a correction for an attempt it could not make, falling out of
  its own loop and returning `None` — an empty assistant turn with no usage, no
  finish_reason and nothing in the log. A tool call cut off at the token cap is
  exactly what produces it: truncated JSON does not decode to a dict.
  `patches/forge_empty_turn.py` (patch 8) makes exhaustion whichever budget runs
  out first, and makes both empty exits loud.
- **forge reported truncation as a natural stop, and dropped the reasoning, on
  the one path pi uses.** `_emit_text`'s own docstring said so: the OpenAI SSE
  path carried neither. llama-server reports `length` for a capped generation,
  streaming or not; forge said `stop`. `patches/forge_text_sse_passthrough.py`
  (patch 9).
- **the loop's stuck ladder could never pass rung 1.** An intervention zeroes the
  counter the next narration-only verdict needs, and the streak was cleared by
  any turn without a verdict — so the rescue model (3), the hard reset (3) and
  the compaction (5) were unreachable. Six interventions in that run, every one
  logged `stuckStreak: 1`.
- **an empty turn counted as narration**, so three of them — ~85 s of GPU each,
  carrying no answer, no tool call and nothing any text rule can read — were
  needed before anything fired. It now has its own rule and fires on the first.

Both loop halves are in `vendor/pi-loop-mode` (FORK.md, AP1/AP2). The image was
rebuilt: `test_forge_patches.py` 70/70, loop suite 295/295, smoke test 11/11.

---

[← back to the README](../README.md)
