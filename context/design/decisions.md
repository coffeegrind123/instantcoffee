# Design decisions

Why the stack is shaped the way it is. Everything below was verified against the
real thing on 2026-07-31, not taken from documentation or memory — the dates and
observed values are kept so a future reader can tell what has gone stale.

## The model

`Qwen/Qwen3.6-27B` (released 2026-04-24), served from `unsloth/Qwen3.6-27B-MTP-GGUF`
(the MTP variant of the same UD-Q4_K_XL quant — see the settings review below).

### Why 27B dense, not the 35B-A3B MoE

The HN thread (June 2026, "Ask HN: Has anyone replaced Claude/GPT with a local
model for daily coding?") surfaced a strong independent consensus: **the 27B
dense model beats the 35B-A3B MoE for real coding work**, despite the MoE being
~3× faster at token generation. Every operator who compared them directly
converged on 27B for quality-sensitive coding.

The rule of thumb that explains it: `sqrt(total × active)` approximates the
effective-dense parameter count for an MoE. `sqrt(35 × 10) ≈ 18.7`, well below
the dense 27B. The MoE is faster, but for raw code generation quality the dense
model is the right choice. This is not re-litigated; the decision is recorded
here so future model discussions start from it.

Named data points from the thread: jborak, bluejay2387, mgsram, c16, henrixd,
stared, electronsoup, and amarshall all independently converged on this choice.

Facts pulled from the model's own `config.json` rather than assumed:

| Property | Value | Consequence |
| --- | --- | --- |
| Architecture | `Qwen3_5ForConditionalGeneration` (`qwen3_5`) | Needs a llama.cpp new enough to have `conversion/qwen.py` — verified present |
| Layers | 64 | — |
| Layer layout | 16 × (3 × Gated DeltaNet → 1 × full attention) | Only **16 layers** hold a KV cache |
| Full-attention heads | 24 Q / 4 KV, head_dim 256 | ≈ 64 KiB of KV per token at f16, ~34 KiB at q8_0 |
| Native context | 262,144 | Far more than 24 GiB of VRAM can hold; we cap at 64K |
| Vision | SigLIP-style tower, `mmproj-F16.gguf` (0.93 GB) | Optional, off by default — forge does not use vision |
| Thinking | On by default, `<think>…</think>` | Needs a reasoning budget; see below |

The hybrid layout is the reason a 27B model is comfortable here at all. A dense 27B
with full attention on every layer would need ~4× the KV cache.

### Quant choice

`UD-Q4_K_XL` (16.4 GiB) over `Q4_K_M` (15.7 GiB): unsloth's dynamic quants hold
quality better at the same rung, and the 0.7 GiB difference is affordable — the
projected total at 64K context with a q8_0 KV cache is ~19.8 GiB against the
~22.4 GiB actually free (a desktop holds the rest). The README carries the full
ladder so dropping a rung is a one-line change.

## The backends

**llama-server, not Ollama or vLLM.** forge's own eval suite reports its top-10
configurations all running on llama-server, and `--jinja` gives real native function
calling. vLLM wants AWQ/GPTQ weights and is built for concurrent serving that a
single-user 4090 will not exercise.

**`ghcr.io/ggml-org/llama.cpp`, pinned to an immutable per-build tag.** The floating
`server-cuda` tag pointed at build `b10200` (built 2026-07-31T08:46Z) at the time of
writing, and moves without warning. `.env` pins `server-cuda-b10200`; `update.sh`
reads the floating tag's `org.opencontainers.image.version` annotation to discover
the newest build and then pins *that* immutable tag. Reading the annotation beats
paging the tag list — the tags endpoint returns an unordered 100-tag page whose
newest entries were years stale.

**forge from PyPI, not from a git checkout.** `forge-guardrails==0.8.2` in a
`pip install` means updating is a version bump in `.env` and a rebuild, with no
submodule to keep in sync.

## Flags that are not obvious

Checked against `common/arg.cpp` at tag `b10200`:

- **`--jinja` is mandatory.** Without it llama.cpp ignores the `tools` parameter
  entirely. It does not error — it returns a perfectly normal text response, which
  reads as "this model is bad at tool calling" and sends you debugging the wrong
  thing. The smoke test asserts on `tool_calls` for exactly this reason.
- **`-fa` now takes a value** (`on`/`off`/`auto`). The bare `-fa` that older guides
  show is a parse error on current builds.
- **`--reasoning-budget` defaults to `-1` (unrestricted).** On reasoning-tagged
  models that is what lets a run fill the KV cache or hang. Capped at 4096 here;
  `0` disables thinking entirely.
- **`--reasoning-format deepseek`** is set explicitly so thoughts always land in
  `reasoning_content` instead of depending on template auto-detection.
- **`--no-context-shift`** makes an over-long conversation fail loudly instead of
  silently dropping the oldest tokens mid-session.
- Sampling follows Qwen's **precise-coding** thinking preset (`temp 0.6`,
  `top_p 0.95`, `top_k 20`, `min_p 0.0`) rather than the 1.0 general preset — see
  the settings review below. Client requests still override them.

### forge flags

`--budget-mode manual --budget-tokens ${CTX_SIZE}` pins forge's budget to the same
number llama-server booted with, so forge never probes for it and the two can never
disagree.

`--inject-respond-tool` is **off** (it is opt-in as of forge 0.8.x). It exists to
keep ~8B models from wandering out of tool-calling mode; a 27B does not need the
crutch. `FORGE_EXTRA_FLAGS` is there if that turns out to be wrong in practice.

## Environment traps that cost real time

**Docker Desktop bind mounts resolve on the Windows side.** A WSL-style source path
mounts an **empty directory** — it does not fail. Verified directly:

```
$ docker run --rm -v /home/you/proj/scripts:/x:ro alpine ls /x
                                        # ← empty, no error
$ docker run --rm -v //c/users/you/proj/scripts:/x:ro alpine ls /x
setup.sh  up.sh  smoke-test.sh  ...
```

Consequences baked into this repo:

- `MODELS_DIR` must be a `//d/...` path, and is documented as such.
- The helper scripts are **COPY'd into the forge image** rather than bind-mounted.
  A `./scripts` mount would have silently mounted nothing and surfaced as
  "python: can't open file '/work/scripts/smoke_test.py'".
- Build contexts are unaffected — those are read by the Docker CLI, not the daemon.

**Model storage goes on D:.** C: had 44.1 GiB free against D:'s 7.6 TiB, and Docker's
own named volumes live on C: inside the VM's virtual disk.

**A stale ghcr credential breaks *anonymous* pulls.** `~/.docker/config.json` held an
expired PAT for `ghcr.io`; Docker sent it and the registry answered `denied` on a
public image. It presents as an access problem with the image, not with the local
credential. Fixed by re-issuing from `gh auth token`.

**The Xet transfer backend stalled silently.** `HF_HUB_ENABLE_HF_TRANSFER` is
deprecated in favour of Xet, so the downloader was switched to it — and Xet then
stopped dead at ~1.1 GB with the container still running, the connection still open,
no error, and no progress for ten minutes. The chunk cache inside the container was
only 1.2 MB, ruling out progress happening somewhere invisible.

Setting `HF_HUB_DISABLE_XET=1` (plain HTTP range requests) downloaded steadily at
~2.6 MB/s, which is *faster* than Xet managed before it hung. That is the default
here; flip it to `"0"` on a better-behaved network.

The download also retries up to `DOWNLOAD_ATTEMPTS` times (default 12), resuming from
the `.incomplete` file. Over an 18 GB pull on a slow link, a dropped connection is a
matter of when, not if.

**The link here is slow, and it is not HuggingFace's fault.** Measured concurrently:
GitHub 5 KB/s, PyPI 34 KB/s, HF ~1–2.6 MB/s. Always run the control before blaming
the remote.

## Verification

`scripts/smoke_test.py` runs inside the compose network so it exercises the same
service names forge uses, rather than the host port mapping. It checks reachability,
`/props` (context size and that a tool-aware chat template actually loaded), a plain
completion, an **OpenAI-format tool call**, and an **Anthropic-format tool call** —
the last being the path Claude Code takes. `update.sh` runs it after every update and
rolls back the pins if it fails.

## Settings taken from other public Qwen3.6 rigs

Three external configurations were reviewed. Flags were checked against
`common/arg.cpp` at b10200 before adopting anything — the value name is
`draft-mtp` with a hyphen, not the underscore form seen in some write-ups.

**Adopted:**

- **`--temp 0.6`** instead of 1.0. Qwen publishes two thinking-mode presets: 1.0 for
  general use, 0.6 for "precise coding". Two independent public rigs converged on 0.6,
  and this stack exists to drive a coding agent.
- **`-b 4096 -ub 2048`.** The default micro-batch of 512 leaves the GPU idle during
  prompt processing, which is the dominant per-turn cost for a client that resends a
  very large prompt every turn. Two external configs raise these; Thireus separately
  reports that larger batches *lower* perplexity.
- **MTP speculative decoding** (`--spec-type draft-mtp --spec-draft-n-max 2`), with
  `MODEL_REPO` switched to `unsloth/Qwen3.6-27B-MTP-GGUF`. Decode speed only — output
  is unchanged. One public rig measured n-max 2 fastest, 3 no better, and 4 collapsing
  back to non-MTP speed. Not yet measured on this card; `SPEC_TYPE=` disables it.

**Rejected:**

- **`--reasoning-preserve`.** Real flag, but it governs how llama.cpp carries reasoning
  through chat history — and forge owns that concern via `--reasoning-replay`, sending
  a full message list every turn. Redundant at best, conflicting at worst.
- **DRY sampler** (`--dry-multiplier 1.2 --dry-allowed-length 2`, `--repeat-penalty 1.1`).
  Contradicts Qwen's own recommendation of `repetition_penalty 1.0`, and an allowed
  length of 2 is aggressive for code, where short token sequences repeat legitimately
  (indentation, `});`). Available via `LLAMA_EXTRA_FLAGS` if repetition loops show up.

**Deferred for experiment: top-n sigma sampler.** Der_Einzige on the HN thread
(June 2026) claims setting llama.cpp's `--sampling-top-n-sigma 1` with temperature
at any value eliminates long-context degeneration, which is framed as "mostly a
sampling problem." 0xbadcafebee independently agrees loop-elimination is mostly
sampler tuning. Zero cost to A/B test via `LLAMA_EXTRA_FLAGS`:
`LLAMA_EXTRA_FLAGS=-ctk f16 -ctv q8_0 -b 4096 -ub 2048 --sampling-top-n-sigma 1`.
Skeptical (Qwen publishes its own presets and this is not among them), but worth
a two-line experiment if loop/repeat issues persist despite the smoke-test repeat
detector and K-f16 cache.

**Note on a third-party spec sheet.** One reference circulated for this model lists
`head_dim=80, q_heads=64, kv_heads=64`. Qwen's published `config.json` says
`head_dim=256, 24 Q heads, 4 KV heads`. Any KV-cache sizing derived from the former
is wrong — the real per-token cost is ~4x what those numbers imply.

## HN thread findings (2026-07-31)

The "Ask HN: Has anyone replaced Claude/GPT with a local model for daily coding?"
thread (June 2026, 1318 points, 563 comments) was read in full and cross-checked
against this stack. Seven actionable changes landed here. The ones that touch the
documented bottleneck ("every turn re-reads the whole conversation") are #1 and #2.

### 1. preserve_thinking + FORGE_REASONING_REPLAY=full (FIXED)

Qwen3.6 was trained for `--chat-template-kwargs '{"preserve_thinking": true}'`.
Without it, the Jinja template strips prior-turn reasoning, so every agentic turn
forces a full KV re-prefill — exactly the "no prompt caching, re-reads everything"
behaviour in the README. The deeper thread (lambda, chakspak, havfo, stymaar)
confirmed this is not a forge/cache_control problem but a template/engine one.

- `--chat-template-kwargs '{"preserve_thinking": true}'` added to both backends
  in `docker-compose.yml`.
- `FORGE_REASONING_REPLAY` promoted from `none` to `full` so prior thinking
  actually reaches the backend instead of being dropped.
- Trade-off: thinking stays in the context window (higher per-turn token cost),
  but reduces re-prefill and can avoid re-doing reasoning on later turns.

### 2. K-f16, V-q8_0 KV cache (FIXED)

lloyd-christmas (R9700, Qwen): "quantizing k leads to broken json on tool calls,
which is fairly unrecoverable." girvo: F16-K/Q8-V "got rid of a lot of the loops."
The default was `-ctk q8_0 -ctv q8_0` (both quantized). At 64K that is ~34 KiB/token
vs ~64 KiB/token f16 K, so f16 K costs roughly ~1 GiB more — fits within the 22.4 GiB
budget.

- `.env`: `IK_CACHE_TYPE_K=f16`, `LLAMA_EXTRA_FLAGS=-ctk f16 -ctv q8_0 ...`
- README VRAM table recalculated for f16 K costs.

### 3. Loop/repeat detector in smoke_test.py (FIXED)

rhdunn ships a promptfoo Python assert that flags output where a fixed substring
repeats ≥3×. The smoke test already asserts on `tool_calls` but not on degeneracy;
a repeat check catches a sampling regression the tool-call assert misses. Directly
ported: `_count_repeats` / `check_for_repeats` / `_check_content_repeats` wired
into both the plain completion and OpenAI tool-call checks.

### 4. Edit-tool hygiene in the priming prompt (FIXED)

- nicman23: edit failures are "almost always trailing white spaces"
- geophile: "updated AGENTS.md to limit editing (as opposed to rewriting) and
  that helps a little"
- adyavanapalli's harness problem (hash-anchor each line for diffs) — harness-side

Added four concrete rules to `~/claude-prompt.txt` (strip trailing whitespace,
prefer targeted edits, retry tool calls directly before re-reading, re-read on
second failure).

### 5. 27B-dense over 35B-A3B MoE confirmed (DOCUMENTED)

Jborak, bluejay2387, mgsram, c16, henrixd, stared, electronsoup all independently
converged: 27B dense beats the 35B-A3B MoE for real coding despite ~3× lower tok/s.
Rule of thumb from amarshall: sqrt(35×10)≈18.7 effective-dense for MoE — below the
dense 27B. Recorded in the model section above so it is not re-litigated.

### 6. QAT GGUF awareness in update.sh (FIXED)

kpw94 flags unsloth's QAT line (Gemma 4) as holding bfloat16-level quality at Q4
memory. Thread only names Gemma, but `update.sh --check` now prints a hint if
`unsloth/Qwen3.6-27B-*-qat-GGUF` exists on HuggingFace, so the operator knows
to evaluate it.

### 7. top-n sigma sampler (DOCUMENTED, not applied)

Der_Einzige's contrarian claim: set llama.cpp's `--sampling-top-n-sigma 1`,
temperature can be anything; "long context generation is a sampling problem."
0xbadcafebee independently agrees loop-elimination is mostly sampler tuning.
Recorded in the rejected/deferred section above. Zero cost to A/B test via
`LLAMA_EXTRA_FLAGS`; not applied by default because Qwen publishes its own
presets and this is not among them.

### Context worth knowing (not changes, confirmed alignment)

- **petsitter (kristopolous)** is literally this forge: a middleman validator
  between harness and inference engine with stackable "tricks." Validates the
  architecture; forge could grow a whitespace-normalization trick.
- **Harness system-prompt mutation kills prefix caching.** LoganDark notes
  OpenCode does this; Claude Code also injects a per-turn system-reminder, so
  no harness path gets prefix caching regardless of engine settings. Reinforces
  preserve_thinking as the correct approach over hoping for prefix hits.
- **64K is right at the thread's pain floor.** Quality/speed degrade past ~100K
  even on 256K windows (bluejay2387); yieldcrv "can't operate in 65,000 windows
  any more." Mitigations people converged on — `/new` early, decompose into
  atomic TODOs, name specific files — should go in the README's priming section.
- **Frontier-plans/local-implements** (willisrocks, bijowo1676, garethsprice,
  mgsram) is the dominant real-world hybrid pattern.

## GitHub research (2026-08-01)

Seven public repos were reviewed for Qwen3.6 + llama.cpp configurations beyond the
three already consulted for the initial settings review. The findings below were
checked against `common/arg.cpp` at b10200 before adoption.

### Repos consulted

| Repo | Stars | Relevance |
| --- | --- | --- |
| `Danmoreng/local-qwen3-coder-env` | 92 | Optimised 16GB/24GB launchers, `LLAMA_SET_ROWS=1`, `--fit-target` per VRAM budget |
| `rndhouse/mixmod` | 43 | GPT-5.5→Qwen3.6-27B supervisor pipeline, `-kvu`, `--spec-draft-n-max 6` |
| `day50-dev/petsitter` | 37 | Middleware proxy with stackable tricks — validates forge's architecture |
| `pierotofy/LocalCodingLLM` | 27 | `--cache-prompt` + `--slot-save-path`, `--fit-target 2048`, OpenCode config |
| `rcarmo/llama-cpp` | — | Qwen cache sweep benchmarks, `--spec-draft-threads`, `--no-cache-idle-slots` |
| `loops-and-spells/pi-setup` | — | Slot save-on-exit/restore-on-start wrapper pattern |
| `sasasin/dotfiles` | 6 | Most detailed single-user config: `--cache-reuse 128`, `--slot-prompt-similarity 0.20`, `--ctx-checkpoints 24`, `--checkpoint-min-step 256` |

### Applied

#### LLAMA_SET_ROWS=1

Environment variable that enables a ggml fast path for `ggml_cpy()`. Unsloth
documents it as "makes llama.cpp a little bit faster! Use it!" Zero cost — set in
both backend services in `docker-compose.yml`.

#### -kvu / --kv-unified

Uses a single unified KV buffer shared across all sequences. Enabled by default when
slots are auto, but the mixmod scripts explicitly set it. With `-np 1` (one slot),
the unified buffer is simpler and more memory-efficient. Added to both backends.

#### --cache-prompt + --slot-save-path

**The single biggest performance finding.** `--cache-prompt` enables persistent KV
cache to disk so warm restarts skip re-prefill entirely. `--slot-save-path` is where
the save files land. Used by pierotofy, sasasin, rcarmo, and pi-setup.

Combined with `--cache-reuse 64` and `--slot-prompt-similarity 0.20`: the engine
compares incoming prompts against cached entries and reuses matching KV segments
instead of recomputing. The similarity threshold is tuned per sasasin's config.

Slot files are stored in a Docker named volume (`qwen36-slot-cache`) so they survive
container rebuilds but don't pollute the model directory.

Caveat: `--cache-prompt` uses the `--cache-ram` budget (default 8192 MiB). At 64K
context with f16 K/q8 V, a full slot is ~4 GiB. 8 GiB holds one full slot plus
checkpoint overhead. If you see OOM, lower `CACHE_RAM` or `CTX_CHECKPOINTS`.

#### --ctx-checkpoints + --checkpoint-min-step

KV cache checkpointing: the engine saves snapshots so it can rewind without
recomputing from scratch. Critical for agentic loops where the harness resends the
same prefix with a different suffix.

Upstream defaults: 32 checkpoints, 8192 token minimum spacing. The sasasin config
uses 24 checkpoints with 256 token minimum — far more aggressive, tuned for
agentic workloads. This stack uses 16 checkpoints at 256-token spacing as a
conservative starting point.

Trade-off: each checkpoint costs VRAM proportional to the KV cache size. 16
checkpoints of a ~4 GiB slot (64K context, f16 K) is impractically large, but
checkpoints use copy-on-write deltas rather than full copies, so real cost is
far lower.

#### --reasoning-budget-message

sasasin uses: `"Reasoning budget reached. Stop thinking and provide the final
answer now."` This is cleaner than the engine default — it explicitly tells the
model to stop thinking and deliver output. Added to both backends.

#### MTP tuning: --spec-draft-n-min + --spec-draft-p-min

- `--spec-draft-n-min 0` (auto): lets the engine fall back to no drafting when
  acceptance is low, rather than wasting compute.
- `--spec-draft-p-min 0.75`: minimum per-token acceptance probability. Higher
  values draft less aggressively. Qwen's public presets use 0.75.

The mixmod repo runs `--spec-draft-n-max 6` on Q4_K_M (a smaller quant than our
default UD-Q4_K_XL). Kept at 2 here but worth raising on a smaller quant.

### Documented (not applied)

#### Slot save/restore wrapper pattern

The pi-setup repo (`loops-and-spells/pi-setup`) wraps llama-server with a trap
handler that saves all active slots on exit and restores them on startup via the
`/slots` API. This means a container restart resumes conversations instantly with
no re-prefill at all.

```
# On exit: POST /slots?action=save&id_slot=0 {"filename":"slot_0.session"}
# On start: POST /slots?action=restore&id_slot=0 {"filename":"slot_0.session"}
```

This is not baked into the compose file (it needs a wrapper script with trap
handling), but is documented here as a pattern worth adding to `up.sh` / `down.sh`.

#### --ngram-map-k speculative decoding

Danmoreng's 27B-optimised launcher uses `--spec-type ngram-map-k` instead of
`draft-mtp`. This is n-gram based speculative decoding that does not require an
MTP model — it works with any GGUF. Useful as a fallback when MTP is not available
(e.g., certain ik_llama.cpp recipes). Not applied by default because MTP is faster
when available.

#### OpenCode context limits

pierotofy's OpenCode config sets explicit context limits per model:
```json
"limit": { "context": 65536, "input": 47014, "output": 18432 }
```
This prevents out-of-context errors by capping the input before the engine sees it.
Not a forge concern (the proxy manages its own budget), but worth knowing for users
who run OpenCode directly against llama-server.

#### --no-mmap for mainline (REVERSED 2026-08-01)

The mixmod scripts use `--no-mmap` for Qwen3.6 (already in the ik profile). Adding
it to the mainline profile would prevent the OS from double-buffering the GGUF in
the page cache.

**Reversal:** Measured 2026-08-01. `--no-mmap` cuts generation speed by **20×** on
a single-file GGUF in a Docker volume (41 → 2 tok/s on tg128). Prompt processing
drops 4.6× (32 → 7 tok/s). The ik profile needs it for its 852-shard recipe
(because mmap'ing 852 separate files blows out the kernel's VMA tracking), but a
single-file unsloth GGUF should always run with mmap. The mainline profile has
never carried `--no-mmap`. The eval speed numbers in the README scorecard are
from a mmap-enabled run (117 tok/s pp, 29 tok/s tg).

#### petsitter as architectural validation

kristopolous's petsitter is a Python proxy that sits between harness and inference
engine with stackable "tricks" (system prompt injection, pre-hook message transform,
post-hook validation/retry/transform). Its existence validates forge's architecture
from the opposite direction — petsitter is a community-built version of the same
concept. The `tool_call.py` trick (inject JSON-RPC instructions for models without
native tool support, parse responses, convert to OpenAI format) is precisely what
forge's `prompt` capability mode does.

#### --fit-target per VRAM budget

pierotofy uses `--fit-target 2048` for 24 GB — 2 GiB of VRAM headroom. Danmoreng
uses `--fit-target 256` for 16 GB — 256 MiB headroom. The ik backend already uses
`--fit on` implicitly; adding an explicit `--fit-target` would give more predictable
VRAM behaviour. Not applied because the current stack uses explicit layer offload
(`-ngl 99`) rather than `--fit` auto-tuning.

## Deliberately not done
- **Streaming through the proxy.** forge buffers responses rather than streaming
  incrementally, so a backend-side error arrives as an event inside an already-open
  200 stream. This is a documented forge limitation, not something this repo can fix.
- **Multi-model routing.** One model, one GPU, one slot (`-np 1`) so the single user
  gets the whole context window.


## Reversal: ik_llama.cpp was adopted after all

This route was rejected in an earlier pass, on two objections that turned out to be
false. Both were checkable rather than arguable, and checking took minutes:

1. *"The fork will not have the architecture."* It does — `LLM_ARCH_QWEN35` (plus
   `LLM_ARCH_QWEN3NEXT`) is in `src/llama-arch.cpp`.
2. *"Its server will not do native tool calling, forcing forge into prompt-injection
   mode."* It does — `--jinja`, `--reasoning-format`, `--reasoning-budget` and
   `--chat-template-kwargs` are all in `common/common.cpp`, and the fork carries
   `chat.cpp` with PEG/auto tool-call parsers.

A third objection was simply out of date: the fork publishes **prebuilt Ubuntu CUDA
binaries** with the CUDA runtime bundled, so there is no from-source build. A 1.3 GB
download replaces a 30-60 minute compile.

Worth recording how the first check nearly went wrong. `gh search code` returned zero
hits for both `qwen3_5` and `jinja` in the fork — which looks like confirmation of the
rejection. It was an artifact: **GitHub code search does not index forks.** The control
(fetching a file known to exist) failed too, showing the method was broken rather than
the feature absent. A negative result is worth nothing until the control passes.

### What the ik route actually buys

The recipe ladder for this model, all GPU-resident:

| bpw | Size | Perplexity |
| --- | --- | --- |
| 3.4009 | 10 GB | 7.0303 |
| 4.2512 | 13 GB | 6.9155 |
| **5.1014** | **15 GB** | **6.9014** |
| 6.8018 | 21 GB | 6.9001 |

Perplexity is flat above 15 GB — the 21 GB recipe buys 0.0013 for 6 GB. The 15 GB rung
is chosen because it is *both* smaller than the 17.9 GB unsloth 4-bit file *and* higher
precision (5.1 bpw), which is what frees VRAM for context rather than spending it on
weights.

### Costs accepted

- **852 shards instead of one file.** Needs `ulimit -n` raised; the default 1024 fails
  mid-load as "too many open files" with nothing naming shards as the cause.
- **The model is engine-locked.** `iq4_ks`/`iq5_ks`/`iq6_k` do not exist in mainline, so
  these weights only ever run under ik_llama. The mainline profile is kept for exactly
  this reason.
- **`avx2` build, deliberately.** This host is a Ryzen 9 3900X with no AVX512; an
  avx512 archive would SIGILL at start.
