# qwen3.8-forge

[![CI](https://img.shields.io/badge/ci-passing-brightgreen?logo=githubactions&style=flat)](https://github.com/coffeegrind123/qwen3.8-forge/actions)

Reproducible Docker Compose stack running **Qwen3.8-27B** on a single **RTX 4090**,
behind the **forge** guardrail proxy, driven by the **pi** coding agent. One
backend: upstream **llama.cpp** with a single-file MTP GGUF (speculative
decoding, mmap-friendly).

Two switchable regimes — `coding` on the unsloth weights, `prose` on a
Heretic-decensored 3.8 build — via `./scripts/mode.sh` or `/stack mode` inside
pi. `coding` is the default.

> **Migrated from Qwen3.6-27B on 2026-08-15**, the day 3.8-27B released. The
> architecture string is unchanged (`qwen35`), so the pinned llama.cpp build
> loads it as-is, and UD-Q4_K_XL is the same 17.9 GB — but three things moved:
> MTP now ships in the mainline quant (no `*-MTP-GGUF` repo), the card publishes
> one thinking temperature (1.0) where 3.6 published two, and there is a new
> `reasoning_effort` control that defaults to `xhigh` and will eat any budget you
> give it. See `REASONING_EFFORT` in `.env` and the 2026-08-15 entry in
> `context/design/decisions.md`.
>
> **Verified on this box on migration day:** smoke test 11/11 (including a real
> tool call through forge), prefill **1175 tok/s**, decode **39.6 tok/s**, MTP
> acceptance **86.2%**, VRAM **21469 / 24564 MiB** at 32K — within 100 MiB of
> what 3.6 used, so the quant table below carries over unchanged. Decode is well
> down on the 69.2 tok/s `versions.lock` recorded for 3.6; 86% acceptance at a
> draft depth of **2** points at the inherited `SPEC_DRAFT_N_MAX` being too low
> for 3.8's draft head, and that sweep is not finished.
>
> **Settled 2026-08-17 — and the draft depth was not the problem.** A full 2×6
> sweep (`./scripts/spec-sweep.sh`) found **p-min** was the binding knob: at
> `p-min=0.75` the draft was cut to a single token on ~70% of cycles, so raising
> `n-max` under it measured nothing. `.env` now runs
> **`SPEC_TYPE=ngram-simple,draft-mtp`, `n-max 4`, `p-min 0.40`** — the measured
> optimum, worth **1.23× on novel text and 2.20× on repetitive** against the old
> values, and re-verified at 11/11 on the smoke test. `ngram-simple` drafts up to
> 48 tokens per lookup with no forward pass, but it is only safe at n-max 4 — at
> n-max 2 it *costs* 25% on novel text. Costs 529 MiB of VRAM. Full tables in
> `context/design/decisions.md` (2026-08-16 / 2026-08-17) and raw results in
> `context/bench/spec-sweep/`.
>
> forge went 0.8.2 → **0.9.0** in the same change, and that one is not a version
> bump: 0.9 rejects `--budget-mode` for externally managed backends (the proxy
> refuses to start), and `/health` now forwards the *backend's* readiness while
> forge's own liveness moved to `/forge/health`. Both are handled here — see the
> forge notes in `.env`. pi went 0.84.1 → 0.84.2, which is uneventful.
>
> **Superseded 2026-08-22.** The line that used to stand here said llama.cpp
> "stays pinned at `b10200` deliberately: nothing between it and the newest
> published CUDA image is Qwen3.8-specific". That is no longer true, and the
> pin has moved to **`server-cuda-b10573`**. Four commits in the gap bear on
> this stack: a Qwen tool-call parsing fix (#26793), an MTP memory-allocation
> fix (#26605), a `draft-mtp` fix (#27400), and `2b562109` (#26079), which adds
> a CUDA MMVQ→MMQ crossover table labelled "tuned on RTX 4090" where `b10200`
> had **no Ada Lovelace entry at all**. That last one changes nothing at the
> current `n-max 4` — both builds pick the same kernel for a verify batch of 5
> — but it is what makes the `n-max 6/8` rows of the sweep measure something
> other than a GEMV cliff. The three correctness fixes are the immediate
> reason to move.
>
> **Also 2026-08-22 — the 32K context ceiling was a misdiagnosis, and is gone.**
> The KV cache did not have to be `f16/f16`. A stock CUDA build compiles only
> **matched** flash-attention KV pairs (`f16/f16`, `q4_0/q4_0`, `q8_0/q8_0`,
> `bf16/bf16`); the experiment that produced the ~65x prefill collapse used
> `f16` K with `q8_0` V, and it was the *mismatch* that pushed flash attention
> onto the CPU, not the quantization. Confirmed by llama.cpp#20866. Matched
> `q8_0/q8_0` halves the cache, so `CTX_SIZE` is now **98304**. 4-bit KV stays
> off the table — llama.cpp#27109 (open) has `q4_x` collapsing prefill to
> 34–106 t/s on this exact `qwen35` hybrid architecture against 991–1276 t/s at
> `q8_0`, which is what makes most of the public 130K–250K 4090 recipes
> unusable here. DFlash2 (PR #27342) is **not** adopted: a report on the PR from
> an RTX 4090 running this model against multi-turn tool-result histories — this
> stack's exact workload — measures generation collapsing to 12–14 tok/s on a
> real agentic session, with `draft-mtp` immune on the identical request.
> Full reasoning and citations in the 2026-08-22 entry of
> `context/design/decisions.md`.
>
> **Measured on the box the same day**, on `b10573` / `q8_0-q8_0` / `65536`:
> smoke test **11/11** including a real tool call through forge; VRAM
> **22382 MiB of 24564** — double the context for **+384 MiB** against the old
> f16/f16 32K config's 21998 MiB, with ~2.1 GiB spare. Prefill by prompt length:
> 1121 @ 541, 1504 @ 1053, 1799 @ 2077, 2032 @ 4125, 2338 @ 8221, 1706–2162 @
> 16413, 2243 @ 32797 tok/s — four digits throughout and *rising* with depth,
> which is the proof that flash attention is on the GPU (llama.cpp#27109's 4-bit
> failure is the opposite shape: two digits, falling). Decode 52.6–70.4 tok/s.
> Two outlier runs were discarded as host contention, not measurement — see the
> `verified` block in `versions.lock` for why and what the control was.
>
> **Throughput itself is unchanged; the win banked here is the window.** The
> speed work is `./scripts/spec-sweep.sh`, which now has n3/n6/n8 rows —
> and it must be run on a quiet box.

```
              pi  (scripts/pi-local.sh)
                  │
                  │  OpenAI chat-completions (POST /v1/chat/completions)
                  ▼
       ┌─────────────────────┐   forge proxy      :8081
       │  forge-guardrails   │   response validation, rescue parsing,
       │  (container)        │   retry-with-nudge, reasoning-replay policy
       └──────────┬──────────┘
                  │  OpenAI wire, tools forwarded verbatim
                  ▼
       ┌─────────────────────┐   llama-server     :8080
       │  llama.cpp (CUDA)    │   Qwen3.8-27B, --jinja native function
       │                      │   calling, 96K context
       └─────────────────────┘
                  │
              RTX 4090 / 24 GiB
```

pi talks to **8081** (forge). Nothing should talk to 8080 directly except forge —
that port is exposed only for debugging and metrics.

**This stack targets pi and nothing else.** Claude Code support was removed
(2026-08-12): it cost a launcher, an Anthropic-wire smoke test, a Harbor agent
subclass, an SDK dependency, and a set of `.env` keys, all to serve a client
whose fixed prompt-and-tool-schema overhead is the worst possible fit for a
32K local window. forge still *serves* `/v1/messages`, so an Anthropic-shaped client
would work — it is simply not what anything here is tuned, measured, or
documented for.

## Requirements

- Docker Desktop with **GPU support enabled** (Settings → Resources → GPU)
- NVIDIA driver with CUDA support — verified here on driver `596.36`
- ~18 GB of disk for the `coding` model, another ~15 GB if you also want
  `prose`, ~5 GB for images
- `bash`, `curl`, and `docker` for the scripts (`python3` optional — the scripts fall
  back to a throwaway container when it is missing)
- `uv` only for one optional extra: MCP-as-a-CLI (`scripts/mcp.sh`). Nothing in
  the core stack needs it.

## Quick start

```bash
git clone <this repo> && cd qwen3.8-forge

# Edit MODELS_DIR in .env first if D: is not where you want ~18 GB to land.
./scripts/setup.sh
```

`setup.sh` checks prerequisites, builds the forge image, downloads the GGUF, starts
both services, and then runs the end-to-end smoke test. It is idempotent — re-run it
any time.

Then start a session. pi works on your **current directory**, so `cd` to the
project you want it to work on and call the launcher by absolute path:

```bash
cd ~/my-project
~/qwen3.8-forge/scripts/pi-local.sh
```

Add the alias once and you never type the path again:

```bash
echo "alias qpi='~/qwen3.8-forge/scripts/pi-local.sh'" >> ~/.bashrc && . ~/.bashrc
cd ~/my-project && qpi
```

## Day-to-day

| Command | What it does |
| --- | --- |
| `./scripts/up.sh` | Start the stack |
| `./scripts/down.sh` | Stop the stack |
| `./scripts/logs.sh llama` | Tail llama-server (watch the model load here) |
| `./scripts/smoke-test.sh` | Verify inference and tool calling end to end |
| `./scripts/update.sh` | Update llama.cpp and forge, restart, verify, roll back on failure |
| `./scripts/update.sh --check` | Report what is available without changing anything |
| `cd <project> && ~/qwen3.8-forge/scripts/pi-local.sh` | Launch pi against the local model, scoped to that folder |
| `./scripts/download-model.sh` | Fetch the GGUF (resumable; a no-op if it is already on disk) |
| `./scripts/mode.sh` | Show the active regime; `mode.sh prose --restart` switches |
| `./scripts/ab-think-lang.sh` | A/B the `THINK_LANG` prompt before trusting it |
| `./scripts/spec-sweep.sh --dry-run` | Plan the speculative-decoding sweep and price it |
| `./scripts/spec-sweep.sh --only baseline,pmin-050,pmin-040` | Is the MTP draft p-min-bound or n-max-bound |
| `./scripts/spec-sweep.sh --workload repeat` | What `ngram-simple` is worth on repetitive output |
| `./scripts/spec-sweep.sh --report` | Re-print the last sweep's table without running anything — with mean, max and within-config spread, and a provenance block that says whether every row came off one stack |
| `./scripts/spec-sweep.sh --pins` | What build, context size, KV types and weights this box would stamp on a result right now |
| `./scripts/capacity-probe.sh --config 'ctx-96k\|CTX_SIZE=98304' --bench prefill` | Does a launch flag FIT, and what does it cost in VRAM — context window, ngram table size, draft cache type |
| `./scripts/capacity-probe.sh --list` | Re-print the capacity table without running anything — now with within-config SPREAD, SPREAD% and DRAFT/CYCLE, and a provenance footer |
| `./scripts/vram-floor.sh` | How much VRAM the Windows desktop is holding, sampled over 15 minutes without stopping llama, and what that leaves for a bigger context window |
| `./scripts/vram-floor.sh --report` | Re-print the last floor capture without re-sampling |
| `docker compose --profile tools run --rm --build --entrypoint python bench /work/scripts/bench_quality.py --control` | Prove the quality harness before trusting it: reference implementations must score 5/5 or the grid refuses to run |
| `docker compose --profile tools run --rm --build --entrypoint python bench /work/scripts/ctx_needle.py --tokens 90000 --control 105000` | Prove a context window is real: a nonce at each end of the document must come back, and a prompt past the limit must be refused by name |
| `docker compose --profile tools run --rm --build --entrypoint python bench /work/scripts/bench_repeat.py` | Decode speed on repetitive output — the file-rewrite shape pi actually produces |
| `docker compose --profile tools run --rm --build --entrypoint python bench /work/scripts/bench_quality.py` | Which `REASONING_EFFORT` is worth it, scored on executed tests rather than output length |
| `./scripts/mcp.sh --servers` | List MCP servers reachable as a CLI |
| `./scripts/rtk.sh --install` | One-time: install the pinned rtk that filters bash output |
| `./scripts/rtk.sh --status` | What is being filtered, and whether the pin matches |
| `./scripts/rtk.sh --check` | Do rtk's filters still behave the way the allow-list assumes |
| `./scripts/browser.sh status` | Is the browser up, and what page is open |
| `./scripts/browser.sh health` | Probe Chrome itself (exit 2 = wedged) |
| `./scripts/browser.sh reap` | Clear leftovers from servers that died |
| `./scripts/browser.sh down` | Stop Chrome and its server |
| `pi install npm:pi-mcp-adapter@2.26.0` | One-time: the browser as native pi tools |
| `cd vendor/pi-loop-mode && npm test` | Test the vendored `/loop` fork (39 tests, no install) |
| `cd vendor/prinny-channel && npm test` | Test the Matrix channel (296 tests, no install) |
| `cd vendor/rtk-pi && node --experimental-strip-types --test tests/*.test.ts` | Test the rtk gate (28 tests, no install) |

## Updating

```bash
./scripts/update.sh
```

One command updates every pinned component:

1. Resolves the newest llama.cpp CUDA build from the `org.opencontainers.image.version`
   annotation on ghcr's floating `server-cuda` tag, then pins the **immutable
   per-build tag** (`server-cuda-b10200`), never the floating one.
2. Resolves the newest `forge-guardrails` from PyPI.
3. Shows a current-vs-latest table and asks before touching anything.
4. Pulls, rebuilds, restarts, and runs the smoke test.
5. **If the smoke test fails, the previous pins are restored and the stack is brought
   back up on them.** An update that breaks inference does not get to stay.
6. Rewrites `versions.lock` with the resolved image digest — commit it, that file is
   the record of what was actually verified working.

`update.sh` does not bump rtk — `RTK_VERSION` in `.env` is moved by hand, because
raising it means re-measuring the allow-list. What it *does* do, in the same pass
that smoke-tests the stack, is run `./scripts/rtk.sh --check` and record the
answer in `versions.lock` as `rtk_filters`. A failure there warns rather than
rolls back: rtk breaking means bash output stops being compressed, not that
inference regressed, and tearing down a verified llama/forge update over it would
be the wrong trade.

## Configuration

Everything lives in `.env`, which is committed on purpose (no secrets in it — the
pins are the whole point). For machine-local changes that should not be committed,
create `.env.local` with the same keys; the scripts merge it on top.

The keys worth knowing:

| Key | Default | Notes |
| --- | --- | --- |
| `MODELS_DIR` | `//d/llm-models` | **Must be a Windows-style path** — see the bind-mount trap below |
| `GGUF_FILE` | set by the active mode | `coding` uses `Qwen3.8-27B-UD-Q4_K_XL.gguf`; `prose` the Heretic-decensored IQ4_XS. See the VRAM table |
| `CTX_SIZE` | `98304` | Context per slot; also what forge uses as its token budget. Sized by the `q8_0/q8_0` KV cache — see below. **`DRY_PENALTY_LAST_N` must move with it**: b10573 deleted the `-1 = context size` sentinel |
| `REASONING_BUDGET` | `4096` | `-1` unrestricted, `0` disables thinking, `N` caps it. The guard against a turn that thinks itself out of an answer entirely — at a cap, `xhigh` has been measured returning 12,582 reasoning chars and **zero** content |
| `REASONING_BUDGET_MESSAGE` | *(see `.env`)* | What the engine injects when the budget runs out. Phrase it toward delivering, not toward answering — an agentic turn cut off mid-plan still needs to be free to call a tool |
| `REASONING_EFFORT` | `medium` | **New in 3.8.** `xhigh`\|`high`\|`medium`\|`low` — `high` is rewritten to `xhigh`, anything else fails the request *for this setting*. A **request** may instead send `{"reasoning_effort":"none"}` (llama.cpp intercepts it before the template) or override per turn with `{"chat_template_kwargs":{"reasoning_effort":"low"}}`; forge forwards both. Upstream defaults to `xhigh`; this stack does not, see below |
| `THINK_LANG` | set by the active mode | Reason in Mandarin, answer in English. `zh` in `coding`, `off` in `prose`. Unmeasured on this hardware — see below |
| `FLASH_ATTN` | `on` | Recent llama.cpp requires a **value** here (`on`/`off`/`auto`) |
| `LLAMA_EXTRA_FLAGS` | `-n 8192 --load-mode none` | `--load-mode none` disables mmap (mandatory on a 9p bind mount); `-n` is the server-side generation cap. **No KV quantization** — see below |
| `CACHE_PROMPT` | `1` | Persist KV cache to disk for fast warm restarts |
| `CACHE_RAM` | `2048` | RAM budget for prompt cache in MiB; 0 disables. **This is HOST RAM, not VRAM.** It was 8192, which was the single largest avoidable memory consumer on this box and collapsed prefill to 2.83 tok/s once the host started swapping |
| `CACHE_REUSE` | `64` | Previous cache entries to compare for reuse |
| `SLOT_PROMPT_SIMILARITY` | `0.20` | Similarity threshold for cache reuse (0.0–1.0) |
| `CTX_CHECKPOINTS` | `16` | KV checkpoints per slot for agentic rewind; 0 disables |
| `CHECKPOINT_MIN_STEP` | `256` | Minimum tokens between checkpoints |
| `SPEC_TYPE` | `ngram-simple,draft-mtp` | Comma-separated **list**; the engine hard-codes the priority (n-gram drafters ahead of draft-model ones, first non-empty wins). Set from a full sweep — see below |
| `SPEC_DRAFT_N_MAX` | `4` | Draft length for `draft-mtp`. Does **not** cap `ngram-simple`, which is bounded by remaining context |
| `SPEC_DRAFT_N_MIN` | `0` | Minimum MTP draft tokens; 0 = auto |
| `SPEC_DRAFT_P_MIN` | `0.40` | Minimum MTP per-token acceptance probability. **Sweep this before `n-max`** — the draft loop tests it first, so a tight p-min hides n-max entirely |
| `SPEC_NGRAM_MIN_HITS` | *(empty)* | Times a span must be seen before `ngram-simple` drafts it. Empty = llama.cpp's default of **1**. Untested here; 2–3 may cut bad drafts on novel text |
| `SPEC_NGRAM_SIZE_N` | *(empty)* | n-gram lookup width. Empty = default 12 |
| `SPEC_NGRAM_SIZE_M` | *(empty)* | Max tokens drafted per lookup. Empty = default 48 |
| `MMPROJ_FILE` | *(empty)* | Set to `mmproj-F16.gguf` for image input |
| `FORGE_CAPABILITY` | `native` | Keep `native` — llama.cpp with `--jinja` does real function calling |
| `FORGE_REASONING_REPLAY` | `full` | `keep-last` / `full` replay captured reasoning to the backend |
| `BIND_ADDR` | `127.0.0.1` | `0.0.0.0` to expose on the LAN |
| `PI_MAX_TOKENS` | `8192` | Generation cap given to pi; keep `-n` in `LLAMA_EXTRA_FLAGS` equal to it |
| `PI_CONTEXT_FILES` | `1` | Loads the project's `AGENTS.md`/`CLAUDE.md`; `0` passes `-nc` |
| `PI_EXTRA_ARGS` | *(empty)* | Flags your own `pi` alias would add — aliases do not expand in scripts |
| `PI_AUTO_UPDATE` | `1` | Keep pi on the latest npm release; fails soft |
| `PI_UPDATE_INTERVAL_H` | `24` | Hours between update checks |
| `MCP2CLI_ENABLED` | `1` | Loads the `mcp-tools` skill so pi can call MCP servers as a CLI. `0` disables |
| `MCP2CLI_VERSION` | `3.3.1` | mcp2cli release |
| `MCP_SDK_VERSION` | `1.29.0` | MCP Python SDK pin — must stay `<2`, see below |
| `RTK_ENABLED` | `1` | Filters the output of 23 bash commands before pi reads it. Inert without the binary, so it is safe on a fresh clone. `RTK_DISABLED=1` turns it off for one launch |
| `RTK_VERSION` | `0.45.0` | rtk pin. Moved by hand, not by `update.sh` — raising it means re-measuring the allow-list with `./scripts/rtk.sh --check` |

## Creative writing, and what is *not* in the way

Nothing in this stack filters content. That was checked rather than assumed, on
2026-08-13:

| Layer | Finding |
| --- | --- |
| forge | No content filtering. Its `guardrails/` are tool-call plumbing — response validation, retry nudges, step enforcement. Removing them breaks tool calling and unlocks nothing. |
| pi | Its system prompt is mechanical: tool list, "show file paths", "be concise", cwd. **Zero** safety, refusal, or content language. `--system-prompt` replaces it wholesale anyway. |
| chat template | No refusal text, no injected default system prompt. |
| llama.cpp | No such feature exists. |

So if an uncensored model is behaving timidly here, the cause is configuration,
not a filter. Four things constrain output, and **`prose` mode already fixes the
first three** — they are listed so the reasoning is inspectable, not as a to-do:

1. **A sampler profile tuned for code.** `TEMPERATURE=0.6` is Qwen's "precise
   coding" preset, and XTC/DRY ship disabled. `prose` moves to 1.0 with DRY on.
2. **The MTP quant caps your sampling range.** DavidAU's card asks for
   `temp <= 1` and `repeat pen 1.0` on MTP quants, then separately recommends
   `repeat pen 1.1-1.15` for chat/roleplay and regular GGUFs "for creative/
   complex and/or temps over 1". Those conflict, and the card resolves it: use
   a non-MTP quant if you want to go above temp 1. `prose` sits at exactly 1.0,
   which is the highest the MTP quant tolerates.
3. **`THINK_LANG=zh`** appends a page of instructions about reasoning language,
   verbatim tool arguments and code identifiers. Not a filter, but dead weight
   in a fiction session. `prose` sets it `off`.
4. **pi loads the project's `AGENTS.md`/`CLAUDE.md` by default** — in a code
   repo that injects coding conventions into a writing session. This one is
   per-session, not per-mode: pass `-nc`, or `PI_CONTEXT_FILES=0`.

For a writing session, drop pi's coding tools too — it is an agent, and will
otherwise reach for `read`/`bash`/`edit`/`write`:

```bash
qpi -nt -nc --system-prompt "You are a literary fiction writer. Return only prose."
```

### Two modes

The stack ships two regimes. A mode is just a file of `KEY=VALUE` lines in
`modes/`; adding one means adding a file.

```bash
./scripts/mode.sh                    # which preset .env matches, and what differs
./scripts/mode.sh --list
./scripts/mode.sh prose              # rewrite .env
./scripts/mode.sh prose --restart    # ...and recreate llama
```

From inside pi, the same thing — the extension shells out to that script rather
than carrying a second definition of what "prose mode" means:

```
/stack mode                 # status
/stack mode prose           # switch, then offer the restart it needs
```

| | `coding` | `prose` |
| --- | --- | --- |
| model | unsloth `UD-Q4_K_XL` | `Qwen3.8-27B-Uncensored` `IQ4_XS` |
| temperature | 1.0 | 1.0 |
| DRY | off | 0.8 |
| `REASONING_EFFORT` | medium | medium |
| `THINK_LANG` | zh | off |

Both modes now sit at temperature 1.0. On 3.6 `coding` ran at 0.6, which was
Qwen3.6's separate "precise coding" preset; the 3.8 card publishes a single
thinking preset and it is 1.0, and the GGUF metadata says the same
(`general.sampling.temp=1.0`). The old **0.913 / 27-27** scorecard was measured
on 3.6 at 0.6; it described neither this model nor this temperature, and it was
deleted along with the rest of the eval harness rather than left to rot.

`prose` moved model as well as version. There is no 3.8 Fable-Fusion — DavidAU
had published one 3.8 model at migration time, with no GGUF — so the whole
Fable-Fusion card, including its `temp <= 1` MTP ceiling and its rep-pen ban,
is gone with it. The replacement is
[`JonathanColetti/Qwen3.8-27B-Uncensored-GGUF`](https://huggingface.co/JonathanColetti/Qwen3.8-27B-Uncensored-GGUF),
picked because it publishes numbers instead of adjectives: Heretic
refusal-direction removal at bf16, **12/100 refusals against the base model's
98/100** at KL 0.1191, a mean 0-shot capability delta of **-0.5** across
MMLU/ARC-C/HellaSwag/Winogrande (all inside stderr), and MTP tensors grafted
back after abliteration and verified file by file. That last point is the
one that matters operationally — abliteration silently drops `blk.64` while
`config.json` still advertises it, so most decensored 3.8 GGUFs are 64 blocks
and cannot do MTP at all. This one is 65, checked here from the GGUF header
before it was chosen.

DRY stays at 0.8 in `prose` as a preference now, not as a card requirement: it
penalises repeated *sequences* rather than repeated tokens, which is what keeps
long fiction from collapsing into the same phrasing without flattening style the
way a flat repeat penalty does. `DRY_MULTIPLIER=0.0` gives Qwen's preset
unmodified.

Known cost of the prose model, stated by its publisher: the draft head was
trained against the unmodified weights, so MTP acceptance may fall. Speculative
decoding verifies every drafted token against the target, so that is a decode-
speed risk and never a quality one.

> **`max_tokens` bites in prose mode.** This is a thinking model with
> `REASONING_BUDGET=4096`, so a request must leave room for the thinking block
> *and* the prose. Measured: a "150 word noir scene" used 4212 chars of
> reasoning and returned 913 chars of story — 1286 completion tokens. Ask for
> `max_tokens=400` and you get an **empty** `content` and
> `finish_reason=length`, because llama's `--reasoning-format deepseek` puts the
> thinking in `reasoning_content` where a naive client never looks. Keep
> `max_tokens` well above the reasoning budget, or set `REASONING_BUDGET=0` and
> switch to Qwen's non-thinking preset (`temp 0.7, top_p 0.80, presence 1.5`).

### The knobs

Every sampler this build supports is wired through `.env`, and each ships at
llama.cpp's **disabled** value, so `coding` is Qwen's published preset and
nothing else. The chain runs:

```
penalties -> dry -> top_n_sigma -> top_k -> typ_p -> top_p -> min_p -> xtc -> temperature
```

`prose` mode sets the first four already. The remaining dial worth reaching for
is **XTC** ("exclude top choices"), which drops the most-probable tokens when
several are plausible — the one sampler here aimed squarely at stopping prose
collapsing into the same phrasings. Neither card mentions it, so it is left off:

```bash
XTC_PROBABILITY=0.5
XTC_THRESHOLD=0.1
```

Prefer **DRY** over `REPEAT_PENALTY` for prose. A flat repeat penalty also
punishes ordinary function words and flattens style — which is the problem
`smoothing_factor` is usually reached for.

> The model itself is not the limiter: Heretic took refusals from **98/100 to
> 12/100** on the 3.8 base, per the card's own measurement. (The 3.6 prose model
> this replaces measured 99/100 → 4/100 by the same method — a different weight
> edit on a different base, so the two numbers are not a regression, they are
> different experiments.)

## Choosing a quant for 24 GiB

The 4090 has 24.0 GiB. Qwen3.8-27B is a hybrid: only **16 of its 64 layers** use full
attention (the other 48 are Gated DeltaNet, whose recurrent state does not grow with
context). That makes its KV cache far smaller than a normal 27B. Unchanged from 3.6 —
the GGUF still declares `full_attention_interval=4`, `head_count_kv=4` and 256-wide
K/V heads, and every quant is within 10 MB of its 3.6 counterpart, so the table below
carries over byte for byte.

**The KV cache must be a MATCHED pair, and that is what sets the context size.**
Measured on this machine on 2026-08-12, not inherited from a guide:

| KV cache | Prompt processing | 12K-token request |
| --- | --- | --- |
| `-ctk f16 -ctv q8_0` | 26–140 tok/s, **falling** as the prompt grows (GPU at 0%) | never finished inside forge's 600s timeout |
| f16 / f16 | **1806 tok/s** | **6.9 s**, correct answer |
| `q8_0 / q8_0` (what this repo now uses) | see `versions.lock` — being re-measured | — |

**Corrected 2026-08-22.** That measurement is real, but the conclusion drawn from
it — "a quantized V cache takes prefill off the GPU" — was one step too broad, and
it is what held `CTX_SIZE` at 32768 for ten days. A stock CUDA build compiles only
**matched** flash-attention KV pairs (`f16/f16`, `q4_0/q4_0`, `q8_0/q8_0`,
`bf16/bf16`); mixing types returns `BEST_FATTN_KERNEL_NONE` and attention falls to
the CPU. The failing row above mixes `f16` K with `q8_0` V. It was the *mismatch*.
Upstream confirms it: llama.cpp#20866, where the fix is a rebuild with
`-DGGML_CUDA_FA_ALL_QUANTS=ON` and another reporter measures the same collapse
(96 → 2361 tok/s across that flag). Disabling flash attention is still not an
escape — llama.cpp refuses to start with `V cache quantization requires flash_attn`.

So a matched `q8_0/q8_0` was available the whole time. Only **16 of 64 layers** hold
a KV cache on this hybrid architecture (`16 × (3 × GatedDeltaNet → 1 × Gated
Attention)`), so with the MTP block counted the cache is ~68 KiB/token at `f16` and
~34 KiB/token at `q8_0` (measured from llama's own `-lv 5` table, 16 layers).
`CTX_SIZE` is now **98304**, which costs about 1,360 MiB more
than the 32K `f16` window it replaced.

**4-bit KV is not an option here**, whatever the public 4090 recipes say: llama.cpp
\#27109 (open) reports `q4_x` collapsing prefill to 34–106 tok/s on this exact
`qwen35` hybrid architecture against 991–1276 tok/s at `q8_0`, with generation
unaffected — so a decode-only benchmark will not catch it.

| GGUF | Weights | @32K f16/f16 | Verdict on ~22.4 GiB |
| --- | --- | --- | --- |
| `IQ4_XS` | 14.4 GiB | ~19.8 | Most headroom, lowest quality of the 4-bits |
| `Q4_K_M` | 15.7 GiB | ~21.1 | Fits |
| **`UD-Q4_K_XL`** | **16.4 GiB** | **~21.6 (measured 21566 MiB)** | **Default — best quality that still fits** |
| `Q5_K_M` | 18.2 GiB | — | Does not fit |
| `Q6_K` | 21.0 GiB | — | Does not fit |

Totals include ~1.3 GiB of CUDA context and compute buffers. `-b`/`-ub` are
deliberately left at their defaults: raising them to `4096`/`2048` cost ~850 MiB of
VRAM for a prompt-processing win that does not exist once prefill is actually on the
GPU. Note that the card is never entirely yours: measured here, llama.cpp saw
**22992 MiB free** of 24563 MiB with an ordinary Windows desktop running, so budget
against ~22.4 GiB rather than 24. Check yours with:

```bash
docker compose run --rm --no-deps llama --list-devices
```

## Using it with pi (pi.dev)

### Starting a session in a project

pi works on your **current directory**, so scope it by `cd`-ing there first and
calling the launcher by its absolute path. Everything the launcher needs
(prompt fragments, the MCP skill) is resolved absolutely, so it runs correctly
from anywhere:

```bash
cd ~/my-project
~/qwen3.8-forge/scripts/pi-local.sh
```

pi then reads and edits files under `~/my-project`. Worth adding to your shell
so you stop typing the path:

```bash
echo "alias qpi='~/qwen3.8-forge/scripts/pi-local.sh'" >> ~/.bashrc && . ~/.bashrc
cd ~/my-project && qpi
```

(`~/.zshrc` if you use zsh. The alias points at the script, not at `pi` itself,
so it keeps working when the launcher changes.)

Common variants — any pi flag passes straight through:

```bash
qpi                                  # interactive session
qpi -c                               # continue the previous session here
qpi -p "what does src/auth.py do?"   # one-shot, non-interactive, prints and exits
qpi --print-only                     # show the exact command, run nothing
qpi --install-only                   # just refresh ~/.pi/agent/models.json
```

### Changing settings for one session

Any `.env` key can be overridden for a single launch by setting it in front of
the command — the same way `docker compose` treats the shell environment:

```bash
PI_CONTEXT_FILES=0 qpi     # skip this project's AGENTS.md / CLAUDE.md
THINK_LANG=off qpi         # no Chinese-reasoning fragment this session
MCP2CLI_ENABLED=0 qpi      # drop the MCP skill for this session
```

Your project's `AGENTS.md`/`CLAUDE.md` **is** loaded by default — pi walks
parent directories to find it. `PI_CONTEXT_FILES=0` turns that off for a session
where the window matters more than the conventions: a long single-file refactor,
or a project whose conventions file is enormous.

For a permanent change, edit `.env`; for a permanent *machine-local* change that
should not be committed, put it in `.env.local`.

### Controlling the stack from inside pi: `/stack`

`.pi/extensions/stack.ts` ships with the repo, and `pi-local.sh` loads it by
absolute path — so `/stack` is there in **every** session the launcher starts,
including sessions in a completely unrelated directory. The launch banner ends
with `, /stack` when it is active.

> Do not rely on pi's own `.pi/extensions/` auto-discovery for this. That is
> scoped to the project pi was *started in* and needs that project trusted, so
> starting anywhere else means no `/stack` — and because an unregistered
> `/stack` is forwarded to the model as plain text, you get a confident,
> invented answer instead of an error. If you launch `pi` directly rather than
> through `pi-local.sh`, pass
> `-e ~/qwen3.8-forge/.pi/extensions/stack.ts` yourself.

```
/stack                     model, context, slots, throughput, GPU, forge, settings
/stack mode                which preset .env matches, and what differs
/stack mode coding|prose   switch regime, then offer the restart it needs
/stack env [FILTER]        every effective setting (.env + .env.local + exported)
/stack set KEY=VALUE       edit .env, and say exactly what must restart
/stack up | down           start / stop via scripts/
/stack restart [llama|forge]
/stack smoke | bench
/stack logs [llama|forge]
/stack slots save|restore|erase [id]
```

**Observation is model-callable; mutation is not.** The `stack_status` tool lets
the model check throughput or KV usage before blaming itself for slow output.
Every command that changes something is user-only, so a model cannot restart
llama in the middle of your task.

**Nothing here reconfigures a running server, because nothing can.**
llama-server answers **501 to `POST /props`** on this build — context size,
sampling, reasoning budget and MTP are startup flags, full stop — and forge has
no admin API either. 0.9.0 added `/forge/health` and `/forge/usage` and started
forwarding `/health`, `/v1/models`, `/v1/health`, `/models` and `/props` to the
backend, but every management mutation stays closed. So `/stack set` edits
`.env` and then tells you precisely what to recreate, reading the key→service
mapping out of `docker-compose.yml` so it cannot drift. It distinguishes keys
that only `pi-local.sh` reads — those just need pi restarted — from keys that
need a container recreate and, for llama, a ~20 minute cold load.

`/stack` also detects one failure mode that ordinary health checks miss: if
`/props` answers while `/slots` and `/metrics` time out, llama's **task queue is
wedged** and inference is down even though the container looks healthy and
`/health` passes. The status output says so, and names the recovery.

> **`/stack slots` is sharp.** Measured on this box: saving one 32k slot wrote
> 315 MB in 180 s without finishing, and **aborting a save wedged the server** as
> above, costing a container recreate and a cold load. The command therefore has
> no client-side timeout — interrupting is the thing that breaks it — and it
> re-probes the queue afterwards. Read the confirmation before saying yes.

### Unattended loops: `/loop`

`vendor/pi-loop-mode` — a fork of `pi-loop-mode@2.5.4`, carried in this repo —
iterates the agent until you stop it. Nothing to install: `pi-local.sh` loads the
extension, its skill and its prompt templates from the checkout by absolute path,
so `/loop` behaves the same in whatever directory you started pi in.

If the upstream npm package is still in pi's user settings from before the fork,
remove it — two copies register two `/loop` commands that fight over one
session's state, and the launcher warns when it sees one:

```bash
pi uninstall npm:pi-loop-mode
```

Then, in the project you want worked on:

```
/loop start read @PLAN.md and implement it
/loop start <goal> --check "python3 -m pytest -q"   # objective done-ness
/loop start <goal> --max 20                          # cap the iterations
/loop stop | /loop resume | /loop finish | /loop stats
```

**Why this one.** Three properties matter on a stack like this, and they were
checked rather than taken from the README:

- **It survives compaction, which is the whole point on a local window.**
  Loop state is persisted as pi session entries and restored with
  `restoreLoopState(ctx.sessionManager.getBranch())`, so a compaction does not
  end the run. On context pressure it builds a *local* summary from loop state
  and touched files instead of making another model call — which matters here,
  because a summarization request against an already-saturated context is
  exactly what fails under `--no-context-shift`.
- **It is built for weak models.** Repetition and near-duplicate detection,
  a degenerate-output kill switch, and an escalation ladder that injects
  recovery strategies. A 27B local model does get stuck in ways a frontier
  model does not.
- **Done-ness can be objective.** `--check "CMD"` runs a shell command after
  every iteration and believes the exit code, not the model's claim.

**The no-progress nudge now fires on the runs it was written for.** After eight
iterations with no concrete change the loop stops asking for the next batch and
demands a tangible artifact instead. What counted as "a change" used to be a
word list — including `passed`, `fixed` and `successfully` — matched against the
output of *any* tool, so a `--check "cargo test"` run that prints `42 passed`
every iteration pinned the counter and the nudge could never fire; so did a
`read` of a CHANGELOG and a `grep` that matched `updated`. Now a `write` or an
`edit` counts by definition, `bash` and `Agent` are the only tools whose output
is read at all, and the verdict words are gone. See AK5 in
`context/design/subagents-loop-verifier-proxies.md`.

**One thing to know about `--check`, because it is the sharpest edge here.** The
command runs with `bash -lc` once per iteration, for the life of the run and
across `/loop resume`, through `pi.exec` — which emits no `tool_call`, so nothing
in this stack reviews it: not the Matrix permission relay, not `rtk-pi`'s gate,
not the compaction guard's output cap. Typed by you in the terminal that is
exactly right, and unchanged. Two other routes to the same field are narrower:

```
   from Matrix        --check is REFUSED outright, with its own reason, along
                      with --model and --rescue-model  (AD6)
   from the MODEL     the `loop` tool declares `check`. You are told the model
                      asked, and asked to confirm it; with nobody to ask the
                      check is not armed and the LOOP STARTS ANYWAY, without one.
                      LOOP_TOOL_CHECK=1 in .env is the standing yes.   (AJ2)
```

`--until-done` without a check still terminates on the model's `LOOP_DONE:`
marker, which is what that mode does whenever no check is configured — so
declining costs the run its objective done-ness, not the run.

Verified end to end on Qwen3.6-27B: given a `PLAN.md`, a two-iteration run
produced a working module and a passing test, and `python3 test_calc.py` exited
0 — the plan's own acceptance criterion.

**Why it is forked.** A longer unattended run died on the one thing it is
supposed to survive:

```
Error: "Backend returned 400"
[compaction] Compacted from 33,719 tokens
Error: Compaction failed: Already compacted
Loop paused — context recovery required
```

The context overflowed, **the recovery worked**, and the loop stopped anyway —
waiting for a human to type `/compact` and `/loop resume`, which is the one thing
an unattended loop cannot ask for. pi runs its own overflow recovery *after* the
`agent_end` event that upstream compacts from, so the two race; pi's lands first,
and pi refuses a second compaction of a branch that already ends in one. Upstream
treated that refusal — someone else's success — as a fatal error.

The fork defers its compaction to `agent_settled` (nothing left to race), adopts
pi's recovery when pi wins, treats `Already compacted` as "no work to do" rather
than a failure, and replaces the terminal pause with a cooldown ladder that
retries with a progressively tighter summary.

**Then it stopped overflowing and still went nowhere.** Eight real sessions under
`~/.pi/agent/sessions` show the sequel: 24 compactions, not one error, and from
the fourth compaction onward the session pinned at **94–96% of the 32k window**,
compacting nearly every iteration and freeing nothing. pi's compaction defaults
are sized for a 200k window and do three separate harmful things on 32k — they
no-op silently between 50% and 66% full, they always keep 20,000 tokens (61% of
this window), and the summary is merged into the previous one every time, so it
grows (measured: 1,666 → 11,054 chars) until it is what fills the window.

That matters because of a cliff. Above ~87% full, **33 of 63 assistant turns came
back completely empty** (`content: []`, `stopReason: "stop"`); below it, 3 of 196.
And the loop's own guards read those empty turns as fixation and answered them by
injecting more prompt text into the context that caused them.

So the fork now **hands off instead of compacting** on any window ≤ 64k: a
bounded summary that does not grow, cut at the last turn instead of at pi's
20,000-token tail, built locally with no model call. An empty turn above 80% is
classified as context pressure rather than stuck-ness, the stuck ladder skips
straight to compaction when the context is full instead of scolding the model,
and the model is shown its own remaining budget once past 60% so it can finish
and write state to `PROGRESS.md` before the handoff. `pi-local.sh` also sizes
pi's own `reserveTokens`/`keepRecentTokens` from `CTX_SIZE`, which alone drops
the post-compaction floor from 20,000 tokens to 7,000.

`vendor/pi-loop-mode/FORK.md` has the full list and the measurements;
`cd vendor/pi-loop-mode && npm test` runs the 39 tests that drive the real
handlers through both failures.

> **Third-party code runs with full system access.** Both this and the
> alternative were reviewed before running: no install-time lifecycle scripts,
> no network calls, no filesystem writes outside pi's own API. `pi-loop-mode`'s
> single `pi.exec` is the documented `--check` command you supply yourself.
> Re-review anything pulled from upstream into `vendor/` — the fork is now the
> only copy that runs, so nothing changes under it without a commit here.

### Delegating to a subagent: `Agent`

`vendor/pi-subagents-lite` gives the model a way to hand a job to a focused child
session that burns **its own** window and returns a summary. pi ships no
subagents deliberately ("ask pi to build what you want or install a third party
pi package"), so this is a vendored fork of `pi-subagents-lite@1.11.0`;
`vendor/pi-subagents-lite/FORK.md` is the full account, including why this
package out of the 341 the catalog matches on "subagent".

**On by default** (`SUBAGENTS_ENABLED=1`). It is not free — a registered tool is
charged on every turn whether or not it is called — but the bill was measured:
710 chars, ~178 tokens, 0.54% of a 32k window for all three tools. Set
`SUBAGENTS_ENABLED=0` to get those back.

Be clear about what it buys here, because most of what is written about
subagents does not apply to one llama slot. It is **not** parallelism:
`PARALLEL_SLOTS=1` means concurrent children queue no matter where the queue
forms, and the fork therefore defaults concurrency to 1 so at most one foreign
prefix competes with the parent's at a time. (That default lived in the wrong
file for a release and every session actually ran at 4 — the manager's constant
was unreachable behind a config store that always supplies one. It is one number
now, in `config/config-io.ts`, and a probe through the real wiring reports
`{ limit: 1 }`.) What it buys is **context isolation** — the noisy search happens
in a window that is not this one.

**The real cost is the prefix cache, not the schema.** Measured against
`cached_tokens` on both ports, with a repeat of the same prefix as the control:
a subagent's own system prompt does *not* evict the parent — six small child
turns left the parent at a 99.2% cache hit. A child that grows to ~18k tokens
does: the parent's next call dropped from 2,117 cached tokens to zero and from
**442 ms to 2,949 ms**, a full re-prefill. A real session carries far more than
the 2,133 tokens that was measured on, so treat that as a floor. Delegate work
that is worth a re-prefill; do not delegate a lookup.

The popular packages (`pi-subagents` at 244,797/mo, `subagent-isolation`) all run
each subagent as a child `pi --mode json -p` process, which on this stack costs a
second system prompt that evicts the parent's cached prefix and buys no
concurrency in exchange. This one runs in process, through pi's own
`createAgentSession`.

**What it costs, measured on the wire** rather than estimated — the same stub
model `vendor/prinny-channel/tests/tool-budget.test.ts` uses:

```
baseline (no extension)          2,900 chars   read · bash · edit · write
with vendor/pi-subagents-lite    3,610 chars   + Agent 357 · StopAgent 193 · AgentStatus 157
delta                              710 chars   ~178 tokens, every turn
```

That is 0.54% of a 32k window, and it is that small because upstream ships the
tools with **no description at all** — `Agent`, `run_in_background` and
`worktree_path` are the documentation. Whether a 27B local model drives a schema
that bare is the open question about this package, not its cost.

**What a subagent inherits, measured rather than assumed.** A child does not get
the parent's `-e` flags — it discovers its own extensions. So everything under
`.pi/extensions/` reaches it (the compaction guard included: a live run shows it
capping the *child's own* `read` result at 9,778 → 8,176 chars inside the child
session) and everything under `vendor/` does not. forge is in the path either
way, because the child resolves the same provider, so the reasoning passthrough
and the real `finish_reason` apply to subagent turns too.

That default is wrong in one direction and right in the other, so the fork does
both:

| | in a subagent | why |
| --- | --- | --- |
| compaction guard | yes, by discovery | a child that blows its own window returns nothing |
| forge patches | yes, server-side | same provider, same proxy |
| `rtk` | **put back** | a child running `bash` uncompressed is the session that can least afford it |
| `/loop` | **not given** | it keeps its loop in module scope, and a child binds the same module — see below |
| `prinny` + its skills | **denied outright** | the model spawns subagents on its own initiative; they do not get to post to Matrix |

The denial is unconditional and runs after the agent's own filter, so no agent
file can widen it back, and `SUBAGENT_EXTRA_EXTENSIONS` cannot be used to smuggle
it in. Every subagent also has a turn ceiling — `DEFAULT_MAX_TURNS = 40`, which
steers "wrap up immediately" at the limit and hard-aborts only after the grace
turns, so hitting it produces an answer rather than a severed run. `StopAgent` is
the parent's kill switch.

**A subagent's own turns are in the session transcript.** Twentieth pass, and it
is the answer to *"a delegation just ran; where is the record of what it did?"*.
Before it, one delegation put exactly two things in the parent's session file —
the `Agent` tool call and its result, or the `subagent-result` message — and the
child's own turns lived in an in-memory session that is thrown away, a `/tmp`
log that is off by default, and the verifier's JSONL. Now every child turn, the
brief, each verifier call and the outcome are written into the operator's own
transcript as `subagent-turn` entries, headed with the short id `/agents` uses:

```
   ┌ subagent  a3f9c2  Explore  · turn 1 ──────────────────────────────────┐
   │   …[TOOL] bash(grep -rn 'foo(' src)                                   │
   │   …[ASSISTANT] Three: src/a.ts:12, src/b.ts:40, src/c.ts:7.           │
   └───────────────────────────────────────────────────────────────────────┘
```

It costs the model nothing, ever: pi's `sessionEntryToContextMessages` returns
`[]` for a `type: "custom"` entry, so it persists and renders and is never
context — measured against pi's own `SessionManager`, across two compactions and
a re-open from disk, before the code was written. Bounded at 60 entries per
delegation and 4,000 characters each; `SUBAGENT_TRANSCRIPT=0` turns it off. See
§5.7 of `context/design/subagents-loop-verifier-proxies.md`.

**`/loop` was put back, and then taken out again**, which is worth a paragraph
because the reason is the sharpest edge in this whole design. Subagents run **in
the parent's process**, so a child session binds the *same module object* — and
`vendor/pi-loop-mode` keeps its entire loop in module scope while getting its own
event bus per session. All thirteen of its handlers therefore ran a second time
per delegation, against the operator's one loop. Reproduced, with a loop running
and a subagent doing something unrelated: the child's system prompt gained
*"Loop mode is active. Goal: `<the operator's goal>` … keep every response under
1,200 characters … never stop on your own"*; the child's `agent_end` drove the
operator's iteration ladder and had the operator's **next loop turn delivered
into the child**; and a child that compacted had its whole conversation replaced
by the operator's loop handoff summary. An earlier fix had guarded two of the
thirteen. The package is now inert inside a spawn and is no longer handed to a
child at all, which also returns ~177 tokens/turn of `loop` tool schema to the
child's window. It goes back when its state is keyed by session rather than by
module. `context/design/subagents-loop-verifier-evaluation.md` has the
reproductions.

**The model can start and stop a loop itself.** `/loop` was command-only, which
meant only a human could start one — a model calls tools, it cannot type a slash
command. `vendor/pi-loop-mode` now registers a `loop` tool alongside the command
(709 chars, ~177 tokens/turn on the wire) so the model can run its own bounded
goal loop and stop it, in the main session or inside a subagent.

**Answers are checked against the task before you see them.** A subagent gets a
brief it has no context for and compacts its window as it fills — and what a
monotonic summary erodes first is the oldest thing in it, which is the brief. So
three layers, cheapest first: the task is restated into the child's context
after every compaction (free, and the layer that matters most, because it stops
the drift instead of catching it); an empty answer or a run that hit the turn
ceiling is handled with no model call at all; and only a non-empty answer from a
clean run is worth asking a judge about.

The judge is a fresh one-turn agent with no tools that sees **only** the task and
the answer — not the child's session. A model shown its own reasoning ratifies
its own answer, so the judge is made harder to fool by knowing less. It knows
less about the *work*, not about the *text*: both the task and the answer are
quoted into its prompt inside fences, and a subagent's answer is model output
shaped by whatever the subagent read — so an answer containing a fence used to
end the quoted region early and continue in instruction position, above the two
lines the judge is meant to obey. Both blocks are now defused the way
`prinny-channel` has always defused a Matrix sender's `</channel>` and `[matrix]`
(a zero-width space, and nothing else touched: an answer is expected to contain
code). See AJ4 in `context/design/subagents-loop-verifier-authority.md`. A failed
verdict continues the *child* once, since that is where the context to fix it
lives — and that fix is then judged in its turn, because the answer least worth
trusting unchecked is the one produced by a child already known to have drifted.
That check→repair pair is a loop with a ceiling, exactly like the child's own
turn limit: `SUBAGENT_VERIFY_ROUNDS` repairs (default 1, clamped to 3), stopping
early on an empty retry or one identical to the answer just rejected. Worst
case is `1 + 2×rounds` model calls for one subagent answer. If every attempt
fails, the child's **original** answer goes back, flagged — it is what the
parent would have received with the verifier off, and a retry from a child
that has just been told twice it is wrong is not an upgrade.
`SUBAGENT_VERIFY=0` turns the whole thing off.

The answer **text** is only annotated when something went wrong — a note there
is text the parent model reads and quotes, so a pass must not carry one. The
verdict instead shows as a marker on the result line and in the agent list: dim
`✓ checked` for a pass, `✎ repaired`, `✗ off-task`, and a `⊘` label naming the
kind of skip. **No marker means it was never checked**, which is the distinction
the whole layer exists to draw and which was previously impossible to see. While
the judge is working the agent keeps its row in the widget and says so, because
that call holds the one llama slot the session is waiting on.

It costs nothing in schema — the verifier agent is hidden from the `Agent` tool's
type list, and that was measured, not assumed. It does not catch subtly wrong
work: the judge is the same 27B. It is a drift check, not a correctness proof.

One thing was fixed rather than inherited. A **foreground** subagent returns as a
tool result, so the compaction guard bounds it like everything else. A
**background** one is injected with `pi.sendMessage(..., {triggerTurn: true})`,
which pi delivers straight to the agent without emitting `tool_result`, `input`,
or anything else an extension can hook — so an unbounded result would arrive in
the context and trigger a turn, which is precisely the 17,790-character failure
the guard exists to prevent. The fork bounds it at the source, reusing the
guard's measured constants rather than restating them.

### Talking to it from Matrix: `/prinny`

`vendor/prinny-channel` puts a pi session on Matrix. A message from an
allowlisted sender becomes a turn; the answer comes back to the room by itself.
It is a conversion of the Claude Code plugin of the same name — the Matrix half
is upstream's and unmodified, everything that touched Claude Code was rewritten
for pi. `vendor/prinny-channel/FORK.md` is the full account.

**Off by default** (`PRINNY_ENABLED=0`). It is the only part of this stack that
logs into a remote service and makes the session addressable from the internet,
which is a decision to take on purpose. Set it to `1` and:

```
/prinny prepare                                     once, ~1 min
/prinny configure https://matrix.example.org @bot:matrix.example.org <password>
# message the bot from your Matrix client — it replies with a code
/prinny pair <code>
/prinny policy allowlist                            stop handing out codes
```

`/prinny` on its own prints connection state, policy, allowlist, pending
pairings and settings. `/prinny log` tails the channel's own log — the channel
never writes to the terminal, because in pi stdout and stderr are the TUI.

The Matrix layer runs as a **child process**, not inside pi. Loading
matrix-js-sdk plus its Rust crypto blocks the event loop for ~15 seconds and
writes to stdout on the way up; in-process that is a frozen TUI drawn over with
library chatter. Its ~105MB of dependencies are installed outside the repo, at
`~/.pi/agent/channels/prinny/runtime`, by `/prinny prepare`.

**The answer is forwarded, not requested.** Upstream made a `reply` tool the
only way out, which holds at frontier scale and does not at 27B: the model
writes a good answer into the transcript, never calls the tool, and the person
on Matrix sees nothing while the operator sees a complete reply. So the
extension sends the assistant's text itself — `text` content only, never
thinking blocks and never tool calls, filtered by allowlist so a new content
kind is excluded rather than leaked. `/prinny forward all` sends each message as
it completes instead of just the final one; `/prinny forward off` restores
upstream's behaviour.

**A Matrix message reads as one line, and there is one tool.** Both were paid for
on every turn. Upstream's `<channel …>` block carried up to fourteen attributes
so the model could hand `room_id` back to a tool — 249 chars of wrapper around a
29-char message on this stack's own traffic, 279 around 2. The extension already
knows which room a turn came from, so it keeps that itself and the model sees
`[matrix] <what they said>`, annotated only when it changes the answer
(`image=`, `attachment=`, `from=` in rooms, `delayed=`). Same two messages: 38
chars and 25.

The six `prinny_*` tools became one `prinny`, dispatching on `action` —
`reply`, `react`, `edit`, `download`, `history`, `search`. Measured off the wire
with the same harness that measured the six: **1,333 chars against ~5,900**,
~333 tokens against ~1,470. Nothing was lost, because the common path never
needed a tool — an ordinary written answer is forwarded already.

The `[matrix]` marker stays, at about a token, because it is the boundary
between "the operator typed this" and "a stranger sent this" that every
untrusted-input guideline depends on.

### The proxy was destroying the model's reasoning

`patches/forge_reasoning_passthrough.py`. Empty assistant turns on this stack —
`content: []`, `stopReason: "stop"`, a clean successful turn with no answer in it
— were forge's doing, not llama.cpp's. The control, same request to both ports:

```
llama-server :8080  ->  finish_reason "length",  reasoning_content 490 chars
forge        :8081  ->  finish_reason "stop",    no reasoning_content key at all
```

forge's `TextResponse` carried `content` and nothing else. `ToolCall` has always
carried `reasoning`, and the llama client said so outright — "reasoning is only
useful on ToolCall, TextResponse just gets clean content" — which holds right up
until the model produces reasoning and *nothing else*. Then `accumulated_content`
is empty, the reasoning has nowhere to live, and everything generated is gone
before the response is assembled.

`finish_reason` was hardcoded `"stop"` in the same place, so a **truncated
answer** was indistinguishable from a finished one: the model writes past
`PI_MAX_TOKENS`, gets cut mid-sentence, and the half-finished sentence is
recorded as the answer.

Reasoning is emitted as `reasoning_content` and **never merged into `content`**,
which is the whole safety argument: pi maps it to a *thinking* block, and
`vendor/prinny-channel` allowlists *text* blocks, so the harness sees the
reasoning and a Matrix sender does not. Setting `--reasoning-format none` on
llama-server would recover the same tokens by putting them in `content`, and
would leak them.

Verified against pristine PyPI source before the build, not against the running
container — which is already patched and reports the pre-patch blocks as missing,
loudly, which is what the source-text verification is for.

**A Matrix sender can run a named few pi commands.** `sendUserMessage` passes
`expandPromptTemplates: false`, so a `/` message had never executed anything — it
reached the model as literal text. Allowed now: `/compact` (which this extension
performs itself, because pi's `prompt()` dispatches extension commands only), the
whole `/loop` lifecycle, and **`/stack status` and `/stack help` — not the rest of
`/stack`**. Refused, each on its own grounds: `/prinny` (it edits the allowlist
itself), `/trust` (loads a project's extensions — arbitrary code), `/login`,
`/logout`, `/settings`, `/share`, `/export`, `/copy`, `/new`, `/fork`, `/resume`,
`/session`, `/tree`, `/quit`, `/model`, `/name`, plus `--model`, `--rescue-model`
and `--check` on anything permitted, which would route around a refusal made
elsewhere. A refused command is answered on Matrix and **not** delivered to the
model, so it cannot be talked into running it another way. Anything unrecognised
stays prose — `/usr/bin/foo is broken` is a sentence. See
`src/command-routing.ts`.

`/stack` was allowed in full until 2026-08-19, and it should not have been: every
one of its twelve subcommands ends in `pi.exec`, which emits no `tool_call`, so
none of them passes the permission relay — and `/stack up`, `/stack smoke`,
`/stack bench <args>`, `/stack logs` and `/stack slots erase` had no confirmation
of any kind. The five that did have one used `ctx.ui.confirm`, which is a modal
in **your** terminal that said nothing about a Matrix sender having asked for it.
The two forms that remain are exactly what the sidecar advertises the command as.
If the sender's real question is "is the model up?", ask in ordinary words: the
model calls the read-only `stack_status` tool and answers on Matrix, which is a
route that actually reaches them — a `/stack status` writes a terminal entry
they never see. See AJ1 in
`context/design/subagents-loop-verifier-authority.md`.

**The typing indicator follows "Working…".** Up between `agent_start` and
`agent_settled`, refreshed every 8s against Matrix's 20s expiry. Two subtleties
were paid for: re-asserting `typing: true` while already typing produces **no
`m.typing` EDU at all** (Synapse only broadcasts when the set changes), so each
assertion clears first; and the sidecar no longer signals typing on *arrival*,
which was claiming work up to 89 seconds before pi had the message.

**A run that ends without an answer is continued, not abandoned.** Empty turns
have three observed causes — a truncated response, a turn that generated tokens
but no answer, and a transport failure — and the diagnosis names which. Two
retries, wording per cause, with the question restated so a compaction cannot
lose it. Nothing is ever forwarded in place of an answer: an empty final turn
used to make the forwarder walk *back* to the previous turn's deliberation and
send that.

`/prinny permissions dangerous` relays a Matrix approval prompt before `rm -rf`,
`sudo`, force pushes and similar. pi has no approval system of its own, so this
is the extension's own gate rather than a relay of one; it **fails closed**, so
a dead channel blocks rather than allows.

"And similar" is now a property rather than a spelling. The three guards that
name one — a recursive force delete, discarding working-tree changes, making
something world-writable — read the command's tokens instead of matching a
regex, so `rm -rfv`, `rm -r -f`, `rm --recursive --force`, `rm /path -rf`,
`git clean --force -d` and `chmod 0777` all ask, and `rm -- -rf` (a file with
that name) still does not. See AK2 in
`context/design/subagents-loop-verifier-proxies.md`.

**A prompt nobody answers now says so.** The relay stops waiting after
`permissionTimeoutSeconds` and blocks the call. It tells the sidecar how long it
will wait, so an Allow pressed after that is answered *"no longer waiting … pi
blocked the call. Nothing was run"* rather than `✅ Allowed` — which is what the
room used to be told about a command that never ran.

> **One Matrix account per channel.** Two bots signed into the same account
> duplicate every delivery and fight over the crypto store, which ends with a
> bot that cannot decrypt its own rooms.

### The launch banner

Every session prints what it is actually doing, so nothing is on silently:

```
pi -> http://localhost:8081  (model: qwen3.8-27b, context files off, thinking in zh, mcp via cli, browser (native tools), /stack)
```

Read it. `thinking in zh` means the Chinese-reasoning fragment is active;
`mcp via cli` means the MCP skill is loaded; `browser (native tools)` means the
adapter registered the `browser_*` tools, against `browser (cli)` for the shell
path, `browser (server down)` when the server would not start, and
`browser (no checkout)` when there is no Zendriver-MCP to run;
`context files off` means `-nc`;
`/loop` means the vendored loop-mode fork loaded (and that no upstream npm copy
is shadowing it);
`/stack` means the stack extension loaded. If `/stack` is absent from the
banner, the command will not exist in that session. `/prinny` means the Matrix
channel loaded — and it says so with a qualifier when it will not work yet:
`/prinny (runtime not built)` or `/prinny (not configured)`.

### Keeping pi current

`PI_AUTO_UPDATE=1` (the default) has the launcher check npm and upgrade pi in
place. The check is rate-limited to once every `PI_UPDATE_INTERVAL_H` hours (24)
via a stamp file, so you are not paying a registry round trip every session, and
it **fails soft** in every direction — no npm, no network, or a failed install
all warn and launch on the version already there. `PI_AUTO_UPDATE=0` pins it.

### If it will not start

`pi-local.sh` refuses to launch rather than dropping you into a session that
cannot reach the model:

```
err  forge is not answering at http://localhost:8081 — start it with ./scripts/up.sh
```

`./scripts/up.sh` starts the stack. The **first** start after a cold boot takes
~20 minutes: the model is 17.9 GB read over a Docker Desktop bind mount that
measures 10–38 MB/s. `./scripts/logs.sh llama` shows real progress; the health
status will say `starting` the whole time.

### How the provider config is generated

pi has no "point at a proxy" flag — custom providers live in
`~/.pi/agent/models.json`. The script generates that entry from `.env`, so the
model id, context window and port cannot drift from what the stack serves. It
*merges* into the file rather than overwriting, since pi keeps other providers
there too.

What it writes, and why each field:

```json
{
  "providers": {
    "forge": {
      "baseUrl": "http://localhost:8081/v1",
      "api": "openai-completions",
      "apiKey": "local",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false
      },
      "models": [
        { "id": "qwen3.8-27b", "contextWindow": 98304, "maxTokens": 8192 }
      ]
    }
  }
}
```

`contextWindow` above is illustrative. The real one is GENERATED from
`CTX_SIZE` by `scripts/pi-local.sh:100`, so it tracks `.env` automatically and
this block cannot drift the running system — only a reader who hand-copies it.

- **`openai-completions`, not `anthropic-messages`.** forge speaks both, but the
  OpenAI endpoint is the short path (pi → forge → llama.cpp). Routing via
  Anthropic would add a translation hop that drops `cache_control` and
  `thinking` for no gain. It is also the only path anything here is measured on.
- **`apiKey: "local"`** — pi hides models it considers unauthenticated, so even a
  keyless local server needs a placeholder.
- **`compat` both false — and on 3.8 the reason is the engine, not the model.**
  Qwen3.8's template supports the `developer` role and takes a real
  `reasoning_effort` variable. llama.cpp only started forwarding an API-level
  `reasoning_effort` to the template in commit `7e4c0a9` (2026-08-14), and the
  newest published CUDA image at migration time was `server-cuda-b10423`, cut a
  day earlier — so a client that sends the field has it silently dropped. Effort
  is set server-side instead; see below.
- **`maxTokens` well under `contextWindow`** — with `--no-context-shift` an
  overflowing request fails loudly, and an agent loop's prompt grows every turn.
  It comes from `PI_MAX_TOKENS`, and `LLAMA_EXTRA_FLAGS` carries the same number
  as `-n` so the server enforces it even if a client forgets to ask.
- **`baseUrl` host** — the script uses `host.docker.internal` when it detects it
  is running inside a container, `localhost` otherwise.

**Not using pi's `/llama` integration.** pi can manage its own llama.cpp router
and models. That would bypass forge completely and lose every guardrail this
repo exists to provide, so the model is registered as a plain custom provider
instead.

**It sizes compaction from `CTX_SIZE` too**, into `~/.pi/agent/settings.json`
(merged, not overwritten — pi keeps its theme and packages there):

```json
{ "compaction": { "reserveTokens": 16384, "keepRecentTokens": 6554 } }
```

pi's defaults are `16384` / `20000`, sized for a 200k window. On 32k the second
one is 61% of the whole window, so a compaction cannot free more than the
remainder, and `prepareCompaction()` silently returns nothing at all until the
context exceeds it — which is why compaction in the measured sessions first fired
at 88% full rather than at the 50% the setting implies. `reserveTokens =
min(16384, CTX_SIZE // 2)` keeps the trigger at 50% of whatever window is
actually served; `keepRecentTokens = max(2000, min(20000, CTX_SIZE * 0.2))` cuts
back to ~20% of it. Measured against pi's own `prepareCompaction()`, that drops
the post-compaction floor from 20,000 tokens to 7,000. Global rather than a
`.pi/settings.json` here, because `/loop` runs in whatever project you point it
at — and project settings only load for a *trusted* project.

**What that sizing cannot fix, and `.pi/extensions/compaction-guard/` does.**
Two knobs are not enough, because `reserveTokens` is also the summarizer's own
`maxTokens` and nothing bounds the summary pi carries from one compaction into
the next. pi's `UPDATE_SUMMARIZATION_PROMPT` tells the model to *"PRESERVE all
existing information from the previous summary"* and to include *"previously
done items AND newly completed items"*, so the summary is monotonic by
construction. Across the 42 real compaction points under `~/.pi/agent/sessions`
it runs 456 → 4,029 → 11,054 chars, and inside one session it only ever went up:
1,666 → 3,183 → 5,891 → 9,411 → 11,054.

The guard caps what pi is allowed to feed back — 5% of the window (6,554 chars
on 32k), trimmed section-aware so `## Goal` and `## Next Steps` survive and the
accumulating `### Done` list is what goes. Replayed over those same 42 real
summaries: 11 are trimmed, none exceed the cap, no `## Goal` or `## Next Steps`
is lost, and that growth curve flattens to `6,458 → 6,538 → 6,550 → 6,516`.

**And it caps a single tool result to a share of what context is left**, because
the advisory below is not enough on its own. Watched failing on 2026-08-17: the
CRITICAL notice was in context at 84.5% of the window, saying "do not run
commands with large output this turn", and the model ran a three-URL curl loop
that returned 17,790 characters — 100% of the window, an empty assistant turn,
and a dead run. It could not have complied even in good faith, because nobody
knows how many bytes a pipeline prints until it has printed them.

The allowance is 10% of the REMAINING window (floor 1,500 chars, ceiling
20,000), so a 20k result at 15% used is untouched and the same result at 85% is
cut to ~2,000. Head and tail are kept — the head says what ran, the tail says
whether it worked — and the full output goes to a file the marker names, so
nothing is lost. On the failing run that lands the context at 86.8% instead of
99%, below the empty-turn cliff, with room to write a conclusion.

It also shows the model its own remaining budget above 60% of the window, which
is the generic half of the `/loop` context work: above 87% of the window 52% of
assistant turns came back empty (33 of 63) against 1.5% below it (3 of 196), and
that cliff is a property of the model and the window, not of `/loop`.

Both hooks only ever *add* a bounded line or *shrink* a string pi was about to
send to the summarizer — `session_before_compact` returns `undefined`, so pi
still writes its own model summary and the guard can never replace or cancel a
compaction. What is deliberately **not** ported is `/loop`'s handoff, which
throws the conversation away and rebuilds from `GOAL.md`/`PROGRESS.md`: that is
right for a loop and wrong for a session where the conversation *is* the state.

**`BROWSER_MCP_TOOL_TIMEOUT` sizes the browser server's own budget below the
client's.** `ToolBase._register` has always guarded each tool with a time budget,
but at 120s against pi's `requestTimeoutMs` of 30s the server lost that race
every time: it kept working on a tab the client had abandoned, the model fired
the next call at the same tab, and the CDP session corrupted. That is what
wedges the browser — not the page. On a fresh browser the exact URL that "hung"
loads in 7.6s. At 25s the server answers first, with a sentence naming the tool
and the number.

**And `httpIdleTimeoutMs`, for the same reason.** pi's default is 300,000 ms —
how long a request may go without producing a single byte. Prefill produces no
bytes while it runs. Measured 2026-08-16 in a real session: the first two
requests both died with `Error: terminated` at **exactly 301 s**, ten minutes
before the first token, because this box had collapsed to 20–37 tok/s of prefill
under memory pressure (the healthy figure at the top of this README is 1,175).
6.5k tokens of prompt at 35 tok/s is 187 s of silence, and a prompt-cache
eviction pushed it past 300. The value is sized so a *full* window still prefills
inside the budget at 36 tok/s — the degraded floor, not the healthy rate — then
clamped to `[300 s, 15 min]`: 900,000 ms on a 32k window.

That is a seatbelt, not a fix. If you are seeing it engage, the box is swapping;
see the note on `CACHE_RAM` above and run `/free`.

### Why pi, and what that costs

pi is minimal by design: **no MCP** (its README says so outright — "build CLI
tools with READMEs, or build an extension that adds MCP support"), no
sub-agents. On a 32K local window that is the feature, not the limitation. A
single MCP server can publish hundreds of tool schemas that load before your
first message, and that budget is gone before the model has read anything.

What you give up is real and worth stating: no MCP servers, no sub-agent
fan-out, and no ecosystem of Claude Code plugins. What you get back is nearly
the whole window for the actual session.

Your project's conventions still load: pi walks parent directories for
`AGENTS.md`/`CLAUDE.md` and `PI_CONTEXT_FILES` is `1` by default. That is a
deliberate exception to the window-frugality above — an agent that ignores the
conventions file in the repo it is editing costs more in rework than the tokens
save. `PI_CONTEXT_FILES=0` passes `-nc` and skips the discovery.

## MCP, without MCP

You can still reach MCP servers — just not by loading their schemas. This is
**on by default**: the launcher passes pi a skill that teaches it about
`./scripts/mcp.sh`, which fronts [mcp2cli](https://github.com/knowsuchagency/mcp2cli):

```bash
./scripts/mcp.sh --servers                    # what is registered
./scripts/mcp.sh everything --search sum      # find a tool
./scripts/mcp.sh everything get-sum --help    # that one tool's arguments
./scripts/mcp.sh everything get-sum --a 20 --b 22
#=> The sum of 20 and 22 is 42.
```

The economics are the whole point. Wiring an MCP server into a client puts every
tool's schema in the prompt on every turn, forever. Here the always-on cost is
the skill's name and description — about 60 tokens, because pi loads a skill's
body only when a task matches — and a tool's schema enters the context only when
the model asks for that one tool with `<tool> --help`. `--compact` lists a whole
server for roughly 2 tokens per tool.

Servers are declared in `mcp/servers.json`, `stdio` or `url`, one line each. An
`auth_header` value takes `env:VAR` and `file:/path` prefixes, so no credential
goes in the committed file — CI rejects a literal one.

One server does not go through here: the browser. It is stateful and this path
spawns a fresh server per call, so it gets its own long-lived process and its own
wrapper — see [A browser](#a-browser).

This is on without a measurement gate in front of it because the cost is bounded
and known — the skill description, and nothing else until the model chooses to
call a server. It needs `uv` on PATH; `MCP2CLI_ENABLED=0` turns it off, and
`pi-local.sh` says which state it is in.

Two things that were measured rather than assumed, on 2026-08-12:

- **`uv tool install mcp2cli` is broken as of today.** The MCP Python SDK
  released 2.0.0, which renames `Tool.inputSchema` to `input_schema`; mcp2cli
  3.3.1 still reads the old name, so an unpinned install resolves 2.0.0 and every
  call dies with `AttributeError` before it reaches the server. `MCP_SDK_VERSION`
  pins `mcp==1.29.0` and `scripts/mcp.sh` installs with that pin. CI fails if the
  pin moves to 2.x.
- **mcp2cli's persistent sessions did not work here.** `--session-start` returns
  "session daemon did not start in time". Each call therefore spawns the server
  (~5s for an `npx` one). The skill tells the model to batch questions rather
  than reach for sessions.

### What does not survive the trip

- **Streaming is not incremental.** forge accepts `stream=true` and returns SSE, but
  inference completes before the events are emitted, because rescue parsing and
  retries need the whole response. Expect the reply to land at once after a pause,
  not to type itself out.
- **The model name is ignored** end to end. It is a label; llama.cpp serves
  whatever GGUF it was started with.
- **`reasoning_effort` does not survive as an API field** on the pinned build,
  which is why the provider entry declares it unsupported. Thinking depth is set
  server-side by `REASONING_EFFORT` in `.env` and capped by `REASONING_BUDGET`.
- **Prompt caching is not an API-level feature here.** There is no
  `cache_control` on the OpenAI wire; the stack gets the same effect from
  `--cache-prompt` + `--slot-save-path` (KV cache persisted to disk, so warm
  restarts skip re-prefill), `preserve_thinking` (no KV re-prefill across
  agentic turns), and `--ctx-checkpoints` (fast rewind). See `.env` for
  `CACHE_RAM`, `CACHE_REUSE` and the related knobs.

## Shorter bash output

Same arithmetic as the MCP section, pointed at the other big consumer of a 32K
window. [rtk](https://github.com/rtk-ai/rtk) is a Rust binary that filters a
command's output before the client reads it — `git status` compacted, test
runners reduced to their failures. `scripts/rtk.sh` installs a pinned build;
`vendor/rtk-pi` is the pi extension that decides what gets filtered.

**On by default, and inert without the binary** — the extension warns once and
filters nothing, so `RTK_ENABLED=1` is safe on a fresh clone. One command to make
it live:

```bash
./scripts/rtk.sh --install     # pinned build, sha256-verified, ~10 MB
./scripts/rtk.sh --status      # what is filtered, and whether the pin matches
```

Measured here on 2026-08-16, against rtk 0.45.0:

| command | raw | filtered | saved |
| --- | --- | --- | --- |
| `git status` | 275 B | 49 B | 82% |
| `pytest -q` (43 tests, 3 failing) | 1312 B | 476 B | 64% |
| `find vendor -name '*.ts'` | 1718 B | 773 B | 55% |
| `git diff HEAD~1` | 2384 B | 2213 B | 7% |
| `cat README.md` | 67652 B | 67652 B | 0% |
| `ls -1` | 123 B | 242 B | **-97%** |

### Why it filters an allow-list rather than everything

Upstream's pi extension hands **every** bash command to rtk and applies whatever
comes back. This one filters 23 commands and passes the rest through untouched,
because of what running the binary turned up rather than reading its docs:

- **Some rewrites substitute a different command.** `npm run lint` becomes
  `rtk lint` — the indirection is discarded, so whatever the package's lint
  script actually is gets replaced by a bare eslint. `uv run pytest` becomes
  `uv run rtk pytest`, resolving a pytest outside the venv. Both are silent, and
  a 27B model at `REASONING_EFFORT=medium` has no way to smell either.
- **Two commands in rtk's coverage table have no filter behind them** on 0.45.0:
  `npm test` and `cargo nextest` (bare or `run`) both come back "no rewrite".
  Bare `ruff` likewise — only `ruff check`/`ruff format` match.

What was *not* found is worth saying too, because the issue tracker suggested
otherwise. Diffed against the real command, rtk's filters are mostly faithful:
`find` returned the same 38-file set, `grep -rl` the same paths, `rtk read` the
same bytes at every size tried up to 180 KB. The allow-list is narrow because
most filters **save nothing on a repo shaped like this one**, not because most of
them lie.

**And one command it will not rewrite whatever the allow-list says: one a person
has already approved.** With the Matrix permission relay on (`/prinny permissions
all`), a `bash` call is shown to a human on their phone before it runs — and this
extension's handler runs one position AFTER that relay, on the same tool-call
input object. So the approver read `git status` and pi ran `rtk git status`,
which is an approval for a different command; the channel log recorded the first
one too. The relay now stamps what it showed on the call, and rtk stands down
when it sees the stamp — leaving the command unfiltered, which is the direction
every other decision in that file already fails in. With the relay off (the
default) nothing is stamped and nothing changes. See AJ3 in
`context/design/subagents-loop-verifier-authority.md`.

`cat` is the one entry denied on principle rather than arithmetic. It costs 0%
to deny today, and rtk's README advertises "signatures and structure over full
bodies" — so the current losslessness is undocumented and could turn off in a
point release. The failure that would cause is this stack's known one: an edit
whose `old_string` no longer matches the file.

### Keeping it honest

Two halves, both in CI, because neither implies the other:

```bash
cd vendor/rtk-pi && node --experimental-strip-types --test tests/*.test.ts
./scripts/rtk.sh --check
```

The unit tests cover which commands are handed to rtk and what is accepted back.
`--check` re-runs every measurement in the allow-list against the installed
binary and fails if one stops holding — it is what caught `npm test` and
`cargo nextest` being in rtk's coverage table with no filter behind them, and
what will catch `rtk read` the day it starts summarising. `RTK_VERSION` is pinned
for the same reason: rtk shipped 45 minor versions in seven months, and the
filters are what the allow-list is trusting.

One check earns its place over all the others: a `pytest` collection error must
still exit non-zero and still name what failed. Upstream #2317 reports filters
masking hard failures behind benign summaries; it does not reproduce on 0.45.0,
and pytest is only on the allow-list because of that. A masked failure here means
the model reports a green run and moves on, which is worse than no filtering at
all.

Verified end to end on 2026-08-16: a pi session against the local model ran
`git status` through the bash tool and it arrived as `rtk git status` — 42 tokens
saved on a single call, 64.8% across the session.

`RTK_DISABLED=1 qpi` turns filtering off for one session without editing `.env`.

## A browser

The model can drive a real Chrome — open pages, read them, click, type, fill
forms, read cookies and network logs, get past bot protection. **On by default**;
nothing runs until a tool is called.

Underneath is [Zendriver-MCP-fork](https://github.com/coffeegrind123/Zendriver-MCP-fork)
— CDP rather than WebDriver, so it is not detected as automation — running as a
**long-lived HTTP server** that `./scripts/browser.sh` starts, health-checks and
stops. `ZENDRIVER_MCP_DIR` points at the checkout; it is not vendored, because it
pulls zendriver and a Chrome.

**That process ownership is the fixed point of the design.** The server is not
something pi spawns: it outlives any one session, survives `/clear`, is shared
with anything else on the box, and is stopped deliberately. What changes between
the two modes below is only how pi *reaches* it.

### Adapter mode — the browse loop as native tools (default)

With `MCP_ADAPTER_ENABLED=1`, pi loads
[pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter) and
`mcp/adapter.json` points it at the running server. Five tools register as
ordinary pi tools; the other 93 stay one search away:

```
browser_navigate({ url: "https://example.com" })
browser_get_text_content({ max_chars: 4000 })
browser_get_interaction_tree({ limit: 40 })
browser_click({ selector: "3" })
browser_type_text({ selector: "7", text: "hello" })

mcp({ search: "cookie" })                     → any of the other 93, with schemas
mcp({ tool: "browser_set_cookie", args: … })  → call one
mcpScript({ code: "…" })                      → several calls in ONE turn
```

Measured on 2026-08-16 — not from the READMEs. The token figures are the bytes
**pi actually put on the wire**, captured from a stub model that logged the
request (the adapter's own README claims "~200 tokens" for the proxy tool; it is
720):

| | tokens | per call |
| --- | --- | --- |
| All 98 schemas, the normal MCP way | ~19,000 (60% of the window) | — |
| `mcp` proxy tool | 720 | — |
| `mcpScript` | 302 | — |
| The five direct tools | 1,155 | 25–417 ms |
| **Adapter mode total** | **2,178 (6.6%)** | in-process |
| pi's own `read`/`bash`/`edit`/`write`, for scale | 723 | — |
| CLI mode (`skills/browser`) | ~120 | 1.7–6.5 s |

Two levers if 6.6% is too much: `"scriptMode": false` in `mcp/adapter.json`
settings drops `mcpScript` (−302), and shortening `directTools` to
`navigate`/`get_interaction_tree`/`get_text_content` drops another ~500 at the
cost of a proxy hop for every click and keystroke.

The per-call figure is why this exists: the CLI pays a Python start and a full
`tools/list` on every invocation, and `mcpScript` collapses navigate → read →
click → read into a single turn, which on a 27B local model is worth more than
the token arithmetic.

`start_browser` is deliberately **not** one of the five — its schema alone is
2.3 KB (~570 tokens, the largest on the server). Instead `browser.sh` runs the
server with `ZENDRIVER_MCP_AUTOSTART_BROWSER=1`, so the first tool that needs a
browser opens one. That fix lives in the server, so both modes get it.

`freezeDirectTools` is on: the registered surface is part of the prompt prefix,
and this stack reuses KV cache across turns and restarts, so a reconnect must not
rewrite it mid-session.

The package is **not vendored** — 42 dependencies, 83 MB installed. `pi-local.sh`
checks for it, warns with the exact install command, and falls back to CLI mode
rather than passing pi a `--mcp-config` flag that only exists when the adapter is
loaded:

```bash
pi install npm:pi-mcp-adapter@2.26.0     # the version .env pins
```

### CLI mode — the same server, through the shell

`MCP_ADAPTER_ENABLED=0` (or no adapter installed) loads `skills/browser` instead,
and the model shells out. This is also what a human or a script uses, and it needs
no npm package at all:

```bash
./scripts/browser.sh navigate --url https://example.com   # opens Chrome if needed
./scripts/browser.sh get_text_content                     # the page as plain text
./scripts/browser.sh get_interaction_tree                 # numbered clickable elements
./scripts/browser.sh get_interaction_tree --links         # ...with each link's target
./scripts/browser.sh click --selector 3
./scripts/browser.sh --search cookie                      # find one of the other 98 tools
./scripts/browser.sh <tool> --help                        # that one tool's parameters
./scripts/browser.sh up | status | down                   # the server, in both modes
```

### Why it is not just another entry in mcp/servers.json

There deliberately is not one — `mcp/servers.json` says so where the entry would
be, and CI keeps it that way. Three reasons, all measured on 2026-08-16:

- **A browser is stateful and mcp2cli is not.** mcp2cli spawns the server per
  call, and its `--session-start` daemon does not work here (same finding as
  above). Every call would therefore get a fresh process and a fresh Chrome:
  `navigate` opens a page that the next command cannot see. The server here runs
  once and every call reaches that one process, whose `BrowserSession` is a
  module-level singleton — so the tab survives across calls that are separate OS
  processes. Verified by navigating in one shell command and reading the page in
  the next.
- **Latency.** One mcp2cli invocation costs **11-60 s** on this box (it is a fat
  Python venv paying its import cost on every call). One direct `tools/call` POST
  to the running server costs **24 ms**. A browser task is 20-plus calls.

- **A stale tool list, silently.** Found while testing the entry that used to be
  in the registry: mcp2cli **caches the tool list per URL**, so after the server's
  surface changes it keeps offering the old one. A gateway-mode experiment left it
  convinced the server had 10 tools, and `get-page-info` came back as
  `invalid choice` rather than as anything naming the real problem. `--refresh`
  fixes it — if you know to. Both supported paths read `tools/list` live.

Both paths therefore speak MCP streamable-http to the server directly. `browser.sh`
does it in **stateless mode**, where a single POST carries a whole `tools/call`
with no initialize handshake, in stdlib-only Python: no `uv`, no install step,
nothing pinned.

### The context arithmetic, again

Wiring these 98 tools into a client that loads schemas costs **76,893 bytes —
about 19k tokens, 60% of a 32K window** — before the first message. Neither mode
pays that. Adapter mode buys back 5 tools and a search hop for 2,178 tokens; CLI
mode pays almost nothing standing and charges for discovery instead:

| What | Cost |
| --- | --- |
| The skill's name and description, every session | ~120 tokens |
| `--list --compact` (all 98 names) | ~370 tokens |
| `--search <word>` (typically 8 lines) | ~100 tokens |
| One tool's `--help` | ~130 tokens |

The server *does* ship a search gateway (`ZENDRIVER_MCP_GATEWAY=1`) that collapses
98 tools to 10 for clients that load schemas. Both modes deliberately turn it off:
neither loads schemas up front, so the gateway would only add a `call_tool`
indirection hop and hide 88 tools behind a search that the adapter's own `mcp`
proxy and the CLI both do better.

### Nothing to manage

The model is never told to start, stop or check anything, and neither skill
mentions a lifecycle command. That is not politeness — on a 32K window, every
sentence about operating a service is context that could have been the page it
was asked to read, and a model that believes it must repair the browser will
spend a turn trying.

So the machinery holds itself up, at three levels:

- **The server starts with the session** (`BROWSER_MCP_AUTOUP`), before the model
  can reach a closed port.
- **A supervisor restarts it if it dies** — `browser.sh up` starts a supervisor,
  not the server, and it puts the server back with exponential backoff, giving up
  loudly after 10 restarts in 10 minutes. It also kills the dead server's process
  group, because a crashed server leaves Chrome re-parented to init holding its
  profile (measured: `ppid=1`, and the replacement server started a second Chrome
  beside it).
- **Chrome opens on the first tool that needs it, and is replaced if it dies.**
  Both live in the server, so the CLI and the adapter get them equally. Verified
  by killing each layer under a live session and watching the next call succeed.

**None of that covered the failure that actually happened.** On 2026-08-16 Chrome
stopped answering its own DevTools endpoint while the MCP server in front of it
stayed perfectly healthy — `tools/list` instant, `get_browser_status` cheerfully
reporting *"Running, 1 tab"*, and every `navigate` hanging until the client gave
up. It sat like that for four hours. The supervisor was watching the half that
had not broken, and `status` was asking the server about a browser that was gone,
which is a question the server answers from cache. A health check that cannot
fail is not a health check.

So health is now measured against Chrome itself:

- **`./scripts/browser.sh health`** probes Chrome's CDP endpoint directly —
  found by process ancestry, so it cannot report another session's browser as
  this one's — and exits `0` healthy, `2` wedged. `status` grew the same probe
  and the same third exit code, and prints zendriver's view only *after* it,
  clearly labelled as the cached opinion it is.
- **The supervisor watches Chrome, not just the server.** Two consecutive failed
  probes (30 s apart) and it restarts the server, whose process group takes the
  wedged Chrome with it. It does not try `stop_browser` first: that is a call
  into the process whose browser is the thing not responding.
- **`browser.sh up` opens Chrome up front** (`BROWSER_MCP_WARM`). A cold launch
  measured **74 s** — longer than the MCP SDK's default per-request timeout, so
  the first tool call used to fail with a timeout while nothing was wrong.
- **`./scripts/browser.sh reap [--dry-run]`** clears leftovers from servers that
  died without stopping. Deliberately narrow: only processes whose parent is
  already gone, and only profile directories no live Chrome references — several
  agent sessions on this box run their own bridge, and those have live owners.

And when a call does time out, the model is told something it can act on. It used
to get `Failed to call tool: Request timed out` followed by a dump of the tool's
parameters — a parameter dump, for a failure that has nothing to do with
parameters. It did the only thing that message suggests: sent the identical call
again, waited another 60 s, and only then guessed its way to `curl`. Two minutes
and ~500 tokens for a page that was never going to load.
`.pi/extensions/browser-guard.ts` now rewrites that result, using a live probe to
say *which* failure it is — wedged, not started, or a slow page — and to tell the
model to fall back to `bash` rather than retry. It registers no tools and no
commands, so it costs nothing in the window.

`./scripts/browser.sh up | status | down | logs` still exist — for you, not for
the model. Chrome costs a few hundred MB while it is open; `down` stops it and
the supervisor together.

### Two things that were measured rather than assumed

- **`FASTMCP_HOST` / `FASTMCP_PORT` are ignored.** FastMCP documents them, but in
  mcp SDK ≥ 1.28 `FastMCP.__init__` passes its own keyword defaults straight to
  `Settings`, bypassing the environment. Exporting `FASTMCP_PORT=8931` produced a
  server bound to **8000**, announcing 8000, with no error. The fork's `run.py`
  now takes `--transport / --host / --port` and sets `mcp.settings` directly.
- **A tool call needs no `initialize`.** In stateless mode the server answers a
  bare `tools/call` POST, which is what makes a shell wrapper practical. In
  stateful mode (`run.py --stateful`) it does not, and the reply is framed as SSE.

### Knobs

| Variable | Default | What it does |
| --- | --- | --- |
| `BROWSER_MCP_ENABLED` | `1` | Offer the browser at all (loads one of the two skills) |
| `MCP_ADAPTER_ENABLED` | `1` | Native tools via pi-mcp-adapter; `0` falls back to the CLI |
| `MCP_ADAPTER_VERSION` | `2.26.0` | Pinned adapter version, checked at launch |
| `BROWSER_MCP_AUTOUP` | `1` | Start the server at launch in adapter mode (no Chrome yet) |
| `ZENDRIVER_MCP_DIR` | `/opt/zendriver-mcp` | The Zendriver-MCP checkout to run |
| `BROWSER_MCP_HOST` / `_PORT` | `127.0.0.1` / `8931` | Where the server listens; `mcp/adapter.json` interpolates both |
| `BROWSER_MCP_DISPLAY` | `:99` | X display for Chrome; empty inherits `DISPLAY` |
| `BROWSER_MCP_AUTOSTART` | `1` | Let a tool call start the server, and the server open Chrome |
| `BROWSER_MCP_TIMEOUT` | `180` | Seconds one tool call may take |

Adapter tuning that is not a port — the direct-tool list, the output guard, the
lifecycle — lives in `mcp/adapter.json`, commented in place.

## Reasoning effort — the 3.8 knob that will bite you

New in 3.8, and the reason release-day reports are full of 20-minute answers:
the model takes a `reasoning_effort` level, and **upstream's default is
`xhigh`**. At `xhigh` the template prepends

> *Reasoning effort is set to xhigh. Please think carefully through the task,
> validate key assumptions, consider plausible alternatives, and prioritize
> correctness, consistency, and clarity in the final answer.*

and the model does exactly that — public reports on release day include 22-36k
thinking tokens for a single SVG. Against `REASONING_BUDGET=4096` that is not
"slower", it is a truncation on **every** turn: the answer arrives mid-thought
with the budget message stapled to it.

This stack sets `REASONING_EFFORT=medium`, passed to llama-server as
`--chat-template-kwargs '{"preserve_thinking": true, "reasoning_effort": "..."}'`.

The accepted values, read out of the template embedded in the GGUF and confirmed
by rendering it:

| Value | What the template does |
| --- | --- |
| `xhigh` | Prepends the steering paragraph above. Upstream default |
| `high` | Silently rewritten to `xhigh` |
| `medium` | **Injects nothing at all.** What this stack runs |
| `low` | Prepends "keep your thinking brief and focused" |
| anything else | `raise_exception()` — the request fails |

That last row includes `none`, which several release-day write-ups list as a
fourth level. It is not one — *for this setting*. It also includes the empty
string, so never leave `REASONING_EFFORT=` blank in `.env`.

### But the API is a different path, and it does accept `none`

`REASONING_EFFORT` reaches the template through `--chat-template-kwargs`. A
**request** has two routes the template never sees first
(`tools/server/server-common.cpp:1073-1094`):

```jsonc
{"reasoning_effort": "none"}                              // thinking off entirely
{"chat_template_kwargs": {"reasoning_effort": "low"}}     // per-turn override
```

llama.cpp intercepts a top-level `"none"` and maps it to `enable_thinking=false`
before rendering, so it never raises. And a request's `chat_template_kwargs` are
merged **over** the server's, so a client picks its own effort per turn with no
restart. **forge forwards both** — verified end to end, content length through
forge tracked llama within 1% on identical prompts. Only `none` is special-cased
at the top level; `low`/`medium`/`xhigh` must go via `chat_template_kwargs`.

### Which level is actually worth it

Measured with `bench_quality.py` — 5 coding tasks, 5 hidden edge-case assertions
each, the model's code **executed**, LOC standing in for over-engineering:

| effort | pass% | LOC | reason chars | wall |
| --- | --- | --- | --- | --- |
| `none` | 84.0 | **164** | 0 | 23.3s |
| `low` | 96.0 | **63** | 9,007 | 48.3s |
| `medium` | **100.0** | 71 | 13,876 | 59.9s |
| `xhigh` | **100.0** | 99 | 41,489 | 244.4s |

`xhigh` ties `medium` on correctness while writing 40% more code and costing 4×
the wall clock — 39 lines for `roman_to_int` where `low` used 13. It buys
nothing. `none` is worst on both axes at once: fewest passes *and* the most
sprawling code, because with no planning phase it rambles.

`medium` stays the default because it is the only level at 100%, and a coding
agent's failure mode is a wrong function rather than a verbose one. `low` writes
the leanest correct code and is a fair choice if terseness is worth 4 points.

Measure quality, not length: an earlier pass here compared output *size* and got
the answer backwards, because the whole complaint about `xhigh` is that it
produces **more** output, not less.

Raising it is a two-key change, not one: `xhigh` without a matching increase to
`REASONING_BUDGET` (and the context to hold it) just moves where the truncation
lands. On a 32K window on one 4090 there is not much room to give it.

## Thinking in another language

`THINK_LANG=zh` appends `prompts/think-zh.md` to the client's system prompt,
which asks the model to reason in Simplified Chinese while keeping everything
that leaves the thinking block — prose, code, quoted text, and tool-call
arguments — in the user's language.

The claim comes from the 2026-08-11 HN thread: Qwen reasons best and most
cheaply in Mandarin because that is what it was most natively trained on. The
follow-up question in that thread — *better thinking, or just shorter?* — was
never answered, and nobody posted a measurement.

**`coding` mode turns this on, by operator decision, ahead of that measurement.**
It is running on a community claim, not a local result. `prose` mode sets it
`off` — the fragment is a page about verbatim tool arguments and code
identifiers, which buys a fiction session nothing. `THINK_LANG=off` in `.env`
reverts it anywhere, and the A/B below is how you find out whether it earns its
place in `coding`.

It costs nothing in readability on this stack specifically: the provider entry
declares `reasoning: false`, so pi never renders a thinking trace and you would
not be reading it anyway. The real risk is the opposite one — a model reasoning in
Chinese that then writes a Chinese character into an `old_string` or a file path
has produced a patch that does not apply.

That is what the A/B harness checks:

```bash
./scripts/up.sh                       # the stack must be running
./scripts/ab-think-lang.sh --repeat 3 # ~36 requests, both arms, thinking on
```

It runs six objectively-scored tasks with and without the fragment and prints:

| metric | baseline | think-lang |
| --- | --- | --- |
| mean score | … | … |
| mean reasoning chars | … | … |
| CJK in visible output | 0 | … |
| CJK in tool args | 0 | … |

Any Chinese in tool-call arguments exits non-zero and the verdict tells you not
to adopt it, whatever the score did. Since it is already on, treat a non-zero
exit as a signal to set `THINK_LANG=off` rather than as advice you can defer.

`pi-local.sh` prints `thinking in zh` in its launch banner whenever it is
active, so a session can never be running it silently.

Neither llama-server nor forge can inject a system prompt — verified, with the
receipts, in `prompts/README.md` — so this is applied by the launchers, and by
`ab_think_lang.py`, which takes `--system-prompt-file`.

Adding another language is a file: drop `prompts/think-<code>.md` and set
`THINK_LANG=<code>`. An unknown code fails the launch loudly rather than starting
a session without the prompt it was told to use.

## Troubleshooting

**Tool calls never come back / the model "won't use tools".**
Run `./scripts/smoke-test.sh`. It asserts on `tool_calls` specifically, because
llama.cpp *silently ignores* the `tools` parameter when `--jinja` is missing — which
looks identical to a model that is bad at tool calling. The smoke test prints the raw
response body when this happens.

**The first start takes ~25 minutes and the container shows `unhealthy`.**
Expected on this machine, and not a fault. The GGUF is 17.9 GB and it is read
over a Docker Desktop bind mount from the Windows side, which was measured here
at **10–12 MB/s** (`dd` from a throwaway container against the same mount, twice)
— about 24 minutes for a cold load. `start_period` and the smoke test's
`SMOKE_LOAD_TIMEOUT` are sized for that. Warm restarts are much faster because
the host has the file cached. Watch real progress with `./scripts/logs.sh llama`
rather than the health status.

**The load seems stuck: VRAM flat, no new log lines, low CPU.**
Read this before concluding anything, because the two obvious tells are both
misleading on this stack.

*Flat VRAM is normal here.* With `--load-mode none` (no mmap) llama-server
allocates the **whole** weight buffer up front and then streams the file into
it, so `nvidia-smi` jumps to ~18.5 GiB in the first seconds and does not move
again until the KV cache is allocated at the end. It is not a progress bar.
(The old advice in this slot said flat VRAM meant a stall. That applies to an
mmap'd load, which this is not.)

*Silence in the log is also normal.* llama-server prints nothing between
`load_model: loading model ...` and the end of the load.

**The real progress counter** is bytes read by the process — and note that
`init: true` means llama-server is **PID 7**, not PID 1:

```bash
docker exec qwen38-llama sh -c 'grep ^rchar /proc/7/io; cat /proc/7/wchan'
```

Sample it twice and divide. `State: D` with `wchan: p9_client_rpc` is the
process waiting on the 9p mount, which is what a healthy load looks like most of
the time.

**Measured here on 2026-08-15, and the reason this entry exists:**

| Condition | Load read rate | Window |
| --- | --- | --- |
| Model download running concurrently, VM at 2.2 GiB free | **2.1 MB/s** | 160 s |
| Download stopped, page cache dropped | **32.3 MB/s** | 300 s |

A **15x** difference, and the whole 17.9 GB load finished in **27 minutes**
wall clock including the slow first half. Do not pull a model and cold-load
another at the same time — they contend for the same 9p mount.

The control that proves the mount itself was fine throughout: `dd` off the same
GGUF read at **12.9 MB/s** while llama was apparently crawling at 2.

Sample over minutes, not seconds. A 13-second window on this same load reported
19.9 MB/s where the 300-second window reported 32.3 — the rate is bursty enough
that a short sample is worthless in either direction.

```bash
docker run --rm -v //d/llm-models:/m alpine \
  dd if=/m/<model>.gguf of=/dev/null bs=1M count=200 skip=6000
```

If that control is *also* slow, then it is memory pressure or the mount. Free
memory with `docker run --rm --privileged alpine sh -c 'sync; echo 3 >
/proc/sys/vm/drop_caches'` and re-measure before restarting anything.

**The model download restarts from zero, or dies with `[Errno 12] Cannot
allocate memory`.**
Memory pressure, not a network fault, and it is reclaimable. Hit during the 3.8
migration at ~6 GB into an 18 GB pull: the VM had 2.1 GiB free with 11 GiB sitting
in page cache, and the transfer failed with `OSError: [Errno 12]`. The download
script retries 12 times, so this shows up as a pull that keeps starting over
rather than as an error you notice. Fix it and let the retry proceed:

```bash
docker run --rm --privileged alpine sh -c 'sync; echo 3 > /proc/sys/vm/drop_caches'
free -h     # want multiple GiB *free*, not just available
```

That one command took free memory from 2.1 GiB to 11 GiB here. Check
`docker logs <downloader container>` for the `[retry]` lines — a plain
`du -sh $MODELS_DIR/.hf-cache` going *down* is the symptom.

**It is unbearably slow (< 1 tok/s).**
The GPU is not attached and it is running on CPU. Check `docker info | grep -i nvidia`
and that Docker Desktop has GPU support enabled. `./scripts/logs.sh llama` shows how
many layers were actually offloaded.

**CUDA out of memory on load.**
Drop a rung on the quant table or lower `CTX_SIZE`. **Do not reach for
`-ctk f16 -ctv q8_0`** — a quantized V cache buys ~2 GiB of VRAM and takes
prefill off the GPU entirely (~65x slower, measured); it is why `CTX_SIZE` is
98304 since 2026-08-23 (65536 on 2026-08-22, 32768 before that). Proven by
`ctx_needle.py`, not by `/props` — see the quant section above.

**`docker pull` from ghcr.io fails with `denied` on a public image.**
A stale ghcr credential in `~/.docker/config.json` is being sent and rejected — this
fails even though the image is public. Fix with `docker logout ghcr.io`, or refresh it:
`gh auth token | docker login ghcr.io -u <user> --password-stdin`.

**`AttributeError: 'Tool' object has no attribute 'inputSchema'` from an MCP call.**
The mcp2cli install lost its SDK pin. MCP Python SDK 2.0.0 renamed that field
and mcp2cli 3.3.1 still reads the old name. `./scripts/mcp.sh --install`
reinstalls with `mcp==${MCP_SDK_VERSION}` and fixes it.

**A command's output in the session looks nothing like what I get in my own shell.**
That is rtk, and it is doing its job — `git status` comes back as a compact stat
block, a test run comes back as its failures. `./scripts/rtk.sh --status` lists
exactly which commands this applies to; everything else is untouched. If you need the
raw bytes for one session, launch with `RTK_DISABLED=1`; to turn it off for good,
set `RTK_ENABLED=0` in `.env`.

The case that is *not* normal is output that looks wrong rather than short —
a count that disagrees with reality, a test run that reports success when it
failed. Run `./scripts/rtk.sh --check` first: it re-runs every measurement the
allow-list rests on, including that a failing pytest still exits non-zero and
still names what broke. If that passes and the output is still wrong, the command
does not belong on the allow-list — take it out of `vendor/rtk-pi/src/gate.ts`
and record why, the way the entries already there do.

**The bind-mount trap (Docker Desktop on Windows/WSL).**
Docker Desktop resolves bind sources on the **Windows** side. A WSL-style path such as
`/home/you/models` mounts an **empty directory** rather than failing, so the container
sees nothing and the error surfaces somewhere unrelated. `MODELS_DIR` must be the
`//d/...` form. This is why the helper scripts are baked into the forge image instead
of being bind-mounted.

## Layout

```
.gitignore              .env.local, models, caches
.env                    committed config + version pins
.env.local.example      machine-local override template (copy to .env.local)
versions.lock           what update.sh last verified (generated)
docker-compose.yml      llama + forge, plus tools-profile one-shots
Dockerfile.forge        forge proxy image, pinned to FORGE_VERSION
.github/workflows/ci.yml  CI pipeline (lint, build, verify)
badges/ci.json          shield.io endpoint JSON for the CI badge
prompts/
  think-zh.md           reason in Mandarin, answer in the user's language
  README.md             why this is applied client-side and not in the engine
scripts/
  lib.sh                shared helpers, sourced by every script here
  setup.sh              prerequisites -> model -> build -> up -> verify
  update.sh             update everything, verify, roll back on failure
  up.sh / down.sh       start / stop the stack
  logs.sh               tail llama or forge
  smoke-test.sh         run smoke_test.py against the running stack
  download-model.sh     runner for download_model.py
  smoke_test.py         end-to-end checks (runs inside the compose network)
  ab_think_lang.py      A/B a thinking-language prompt: quality, cost, leakage
  ab-think-lang.sh      runner for the above (resolves the fragment from .env)
  test_repeat_detector.py  standalone unit tests for the loop detector
  test_cjk_detector.py     standalone unit tests for the CJK leak detector
  bench.sh              runner for bench.py
  bench.py              prefill / decode / MTP acceptance, from llama's timings
  bench_repeat.py       the repetition workload bench.py cannot measure — its
                        nonce defeats ngram-simple as well as the prefix cache.
                        Reports "echo" so a flat result can be told apart from
                        a workload that failed to repeat
  bench_quality.py      reasoning effort vs ANSWER QUALITY: hidden edge-case
                        assertions, model code executed, LOC as the
                        over-engineering proxy. Length is not quality
  capacity-probe.sh     does a launch flag FIT and what does it cost — context
                        window, ngram size_m, draft KV type. Records VRAM
                        against a stack-down idle floor and llama's own -lv 5
                        allocation table, and restores .env on every exit path
  ctx_needle.py         proves a context window is real rather than advertised:
                        a distinct nonce at EACH END of the document must come
                        back, plus a negative control past the limit. Sizes the
                        prompt from the server's /tokenize, not an estimate
  vram-floor.sh         what the WINDOWS DESKTOP holds on the shared GPU,
                        sampled over a period and WITHOUT stopping llama.
                        Decomposes the device with Windows' own GPU perf
                        counters, since nvidia-smi returns [N/A] per process
                        under WDDM. Needs the host bridge
  spec-sweep.sh         sweep SPEC_TYPE x n-max x p-min, report draft/cycle.
                        Every result records the pin set that produced it,
                        so --resume cannot skip a row measured on another
                        build and --report cannot pass a mixed table off as
                        a comparison
  slot-cache.sh         save/restore KV cache — UNUSED, and read its header first
  mode.sh               switch between the regimes in modes/
  download_model.py     resumable GGUF fetch
  pi-local.sh           launch pi against the stack (the only client)
  mcp.sh                call an MCP server as a CLI (wraps mcp2cli)
  browser.sh            drive Chrome as a CLI (resolves .env, runs browser_cli.py)
  browser_cli.py        the client: server lifecycle, tool discovery, tool calls
  test_browser_cli.py   standalone unit tests for the browser CLI's arg parsing
  rtk.sh                install/pin rtk, and --check its filters against the
                        allow-list they are trusted to match
modes/
  coding.env            mainline unsloth quant, Qwen's published preset
  prose.env             decensored model, card sampling, no thinking-language
patches/
  forge_merge_consecutive.py  build-time fix for a forge crash on structured
                        message content; fails the build if forge changes
  forge_cached_tokens.py      build-time fix for forge dropping llama's
                        prompt-cache counter; fails the build if forge changes
  forge_reasoning_passthrough.py  build-time fix for forge destroying a
                        reasoning-only turn and hardcoding finish_reason;
                        fails the build if forge changes
.pi/extensions/
  stack.ts              /stack command + stack_status tool inside pi
  browser-guard.ts      turns a browser-tool timeout into an instruction
  compaction-guard/     bounds pi's carried-over summary, caps oversized tool
                        results, and shows the model its context budget — in
                        every session, not just /loop
    src/                pure modules — the cap, the notice (no pi import)
    tests/              node --test suite, 37 tests
vendor/pi-loop-mode/    /loop — fork of pi-loop-mode@2.5.4, loaded from here
  FORK.md               what was changed and why (context-recovery race)
  tests/                node --test suite for the fork's recovery ladder
vendor/pi-subagents-lite/  Agent — fork of pi-subagents-lite@1.11.0, in-process
  FORK.md               why this package of 341, the wire cost, what was changed
  src/spawn/result-cap.ts  bounds a BACKGROUND result — the one path the guard
                        cannot see, because pi injects it without a tool_result
  tests/                node --test suite for the cap, plus a lint that works
vendor/prinny-channel/  /prinny — Matrix channel, converted from a Claude plugin
  FORK.md               what the conversion changed, and why forwarding exists
  extensions/index.ts   the pi extension: tools, /prinny, forwarding, lifecycle
  src/                  pure modules — client, gate, block renderer, access
  server/               the Matrix sidecar, run as a child process
  tests/                296 tests, no node_modules
vendor/rtk-pi/          bash output filtering — fork of rtk's own pi extension
  FORK.md               the measurements, and why it filters an allow-list
  src/gate.ts           what is filtered and what is accepted back (no pi import)
  extensions/index.ts   the pi coupling, and nothing else
  tests/                node --test suite for the gate
mcp/servers.json        registry of MCP servers reachable via scripts/mcp.sh
mcp/adapter.json        pi-mcp-adapter config: how pi reaches the browser server
skills/mcp-tools/       pi skill teaching the model to use scripts/mcp.sh
skills/browser/         pi skill for CLI mode (scripts/browser.sh)
skills/browser-tools/   pi skill for adapter mode (native browser_* tools)
context/                why things are the way they are
  README.md              index of the above, and the conventions it follows
  design/decisions.md    all design decisions, flags, quant choice
```

## Verifying it works

There is no scored eval suite in this repo any more (removed 2026-08-15, with
the 3.8 migration — the 9-suite harness, its committed scorecard, its badges and
the Harbor adapter all went together). Four things verify the stack now, and
each answers a different question:

```bash
./scripts/up.sh                  # start it

./scripts/smoke-test.sh          # does it work end to end, at all
./scripts/bench.sh --full        # how fast, and is MTP paying for itself
./scripts/ab-think-lang.sh       # is THINK_LANG earning its place

./scripts/rtk.sh --check         # do rtk's filters still match the allow-list

# No GPU needed — the same checks CI runs:
python3 scripts/test_repeat_detector.py   # 14 unit tests
python3 scripts/test_cjk_detector.py      # CJK leak detector, both directions
(cd vendor/pi-loop-mode && npm test)      # 39 tests for the /loop fork
(cd vendor/prinny-channel && npm test)    # 296 tests for the Matrix channel
(cd vendor/rtk-pi && node --experimental-strip-types --test tests/*.test.ts)
docker compose --profile tools config     # validate compose
```

`rtk.sh --check` is the odd one out: it tests a binary this repo does not own,
because `vendor/rtk-pi`'s allow-list is a set of claims about that binary's
behaviour. It needs no GPU and no stack — only the pinned rtk.

### bench.sh measures the engine, not the proxy

Two ways to get a throughput number that looks fine and means nothing, both of
which this repo has actually shipped:

**Dividing token counts by wall clock.** That measures forge's overhead as if it
were engine throughput. `bench.sh` talks to llama-server directly and reports
`timings.prompt_per_second` / `timings.predicted_per_second`, which llama
measures around the compute itself and forge strips out of the response. The
version this replaced scored the same before and after a fix that made prefill
**~65x faster** — a benchmark that cannot see a 65x regression is worse than
none.

**Reusing a prompt.** `--cache-prompt` is on, so the second run of a fixed
prompt is served from the prefix cache and reports a prefill rate for work it
never did. Every prompt `bench.sh` sends carries a unique nonce **at the front**
(a prefix cache matches from the start, so a trailing nonce would not help), and
any run whose `timings.cache_n` is non-zero is printed as `CACHED (excluded)`
rather than counted.

### Tuning MTP with it

When `SPEC_TYPE=draft-mtp` is on, llama reports `draft_n` and
`draft_n_accepted`, and `bench.sh` prints acceptance per run and in aggregate.
**Do not hand-tune `SPEC_DRAFT_N_MAX` with `bench.sh` — that is the trap this
repo fell into.** Use `./scripts/spec-sweep.sh`, which sweeps the knobs together
and reports the number that tells them apart.

In llama.cpp b10200 the MTP draft loop (`common/speculative.cpp:1520-1670`)
tests the **p-min gate before the n-max gate**. At `p-min=0.75` the second token
survives only if the head's top-1 probability clears 0.75, so the draft is cut
to length 1 on most cycles and `n-max` is never reached — raising it measures a
knob held shut by a different one. That is exactly why the inherited "2 fastest,
3 no better, 4 collapses" result looked settled and was wrong.

The diagnostic is `draft/cycle` = `draft_n / (predicted_n - draft_accepted)`:
near 1.0 at n-max 2 means p-min is truncating; near n-max means n-max is
binding. **Acceptance is not the target** — it falls as p-min drops, and that is
the trade being bought.

```bash
./scripts/spec-sweep.sh --dry-run                    # plan and cost
./scripts/spec-sweep.sh                              # novel text (pessimistic)
./scripts/spec-sweep.sh --workload repeat            # repetitive (agentic)
./scripts/spec-sweep.sh --report                     # re-print, run nothing
```

Run **both** workloads. `bench.sh` nonce-randomises every prompt to defeat the
prefix cache, which also defeats `ngram-simple` — measured on the repeat
workload alone, `ngram-simple` looks like a flat 2× win; measured on novel text
at n-max 2 it *costs* 25%. Only the pair gives the real answer.

If no draft counters appear at all, either `SPEC_TYPE` is empty or the GGUF has
no MTP head — check `block_count`, which must be **65**, not 64.
