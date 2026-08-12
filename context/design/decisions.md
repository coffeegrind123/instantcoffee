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
completion, and an **OpenAI-format tool call** — the path pi takes. When headroom
is enabled it repeats the tool call one hop further out. `update.sh` runs it after
every update and rolls back the pins if it fails.

> Superseded 2026-08-12. It also checked an **Anthropic-format tool call**,
> which was the path Claude Code took. That check went with Claude Code support
> — see "pi only, and headroom" at the end of this file.

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

- `.env`: `LLAMA_EXTRA_FLAGS=-ctk f16 -ctv q8_0 -b 4096 -ub 2048`
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
Not applied by default because MTP is faster when available.

#### OpenCode context limits

pierotofy's OpenCode config sets explicit context limits per model:
```json
"limit": { "context": 65536, "input": 47014, "output": 18432 }
```
This prevents out-of-context errors by capping the input before the engine sees it.
Not a forge concern (the proxy manages its own budget), but worth knowing for users
who run OpenCode directly against llama-server.

#### --no-mmap (REVERSED 2026-08-01)

The former ik_llama.cpp profile required `--no-mmap` for its 852-shard recipe
(because mmap'ing 852 separate files blows out the kernel's VMA tracking). The
mixmod scripts also used it. **Do not use `--no-mmap` with a single-file GGUF.**

Measured 2026-08-01: `--no-mmap` cuts generation speed by **20×** on a single-file
GGUF in a Docker volume (41 → 2 tok/s). Prompt processing drops 4.6× (32 → 7 tok/s).
The compose file has never carried this flag — it was only in the ik profile. The
eval speed numbers in the README scorecard are from a mmap-enabled run (117 tok/s
pp, 29 tok/s tg).

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
uses `--fit-target 256` for 16 GB — 256 MiB headroom. Not applied because
the current stack uses explicit layer offload (`-ngl 99`) rather than
`--fit` auto-tuning.

## Deliberately not done
- **Streaming through the proxy.** forge buffers responses rather than streaming
  incrementally, so a backend-side error arrives as an event inside an already-open
  200 stream. This is a documented forge limitation, not something this repo can fix.
- **Multi-model routing.** One model, one GPU, one slot (`-np 1`) so the single user
  gets the whole context window.


## Reversal: ik_llama.cpp was removed (2026-07-31 adopted → 2026-08-01 removed)

The ik profile was adopted because its recipe-built weights offered slightly better
perplexity (6.9014 vs ~6.91) and 1.4 GB more VRAM headroom at 64K. It was removed
because the complexity-to-benefit ratio was no longer worth it:

- **`--no-mmap` was mandatory** (852 shards can't be mmap'd at once — VMA tracking
  explodes), which costs **20× generation speed** on a single-file GGUF.
- **No MTP speculative decoding** — ik fork doesn't carry the MTP patches.
- **Engine-locked** — `iq4_ks`/`iq5_ks`/`iq6_k` quants only run under ik_llama.
- **Extra maintenance load:** 1.3 GB Docker image, separate download path, extra
  env vars, a profile-switching compose setup, and every flag check had to be
  duplicated against the fork's `common/arg.cpp`.
- **Both fit on a 4090 at 64K.** The perplexity difference (~0.01) is invisible in
  real coding tasks. Upstream llama.cpp has closed whatever quality gap existed at
  the time of adoption.

The upstream llama.cpp + unsloth GGUF is now the only path. It is simpler, faster
(with mmap + MTP), and produces identical eval scores to what the recipe would
deliver.

## HN thread findings (2026-08-11)

The "Muse Glimmer: 30B-parameter model optimized for always-on local agent
workflows" thread (2026-08-11, 978 points, 553 comments) was read in full and
cross-checked against this stack. It is a Meta-release thread, but Qwen3.6-27B is
the model everyone in it benchmarks against, so a lot of it is about the model
this repo actually serves.

Three changes landed. Several more were checked and deliberately not made; those
are recorded here too so they are not re-litigated on the next read.

### 1. THINK_LANG — reason in Mandarin, answer in English (ADDED, then ENABLED)

dannyw: *"Qwen thinking is really good in Mandarin; and probably natively trained
the most there. Try a system prompt requiring it to think in Mandarin, while
still delivering the response in the user's language."*

kadoban asked the obvious follow-up — *"Is the quality of the thinking better or
is it just shorter since Mandarin is more compact?"* — and **nobody answered it**.
No measurement was posted anywhere in the thread.

It was therefore built as a measurable option defaulting to off, and then
**switched on the same day by operator decision, ahead of the measurement**
(`THINK_LANG=zh`). That ordering is recorded deliberately: this is the one
setting in this repo currently resting on a community claim rather than on a
number produced on this hardware. `scripts/ab-think-lang.sh` exists to close
that gap, and a non-zero exit from it is an instruction to set `THINK_LANG=off`,
not an open question. Everything else in this file was verified before adoption.

What makes it specifically attractive on *this* stack, beyond the general claim:
the pi provider entry declares `reasoning: false`, so **the user never sees the
thinking block at all**. Reasoning in another language therefore has no
readability cost here that it would have on a stack that renders the trace. The
whole trade is token cost versus answer quality.

Where it had to go, and why it is client-side — verified 2026-08-11, not assumed:

- **llama-server cannot do it.** `-sys` / `--system-prompt` exist in
  `common/arg.cpp` at b10200, but registered
  `.set_examples({LLAMA_EXAMPLE_COMPLETION, LLAMA_EXAMPLE_CLI, LLAMA_EXAMPLE_DIFFUSION, LLAMA_EXAMPLE_MTMD})`.
  `LLAMA_EXAMPLE_SERVER` is absent, and `tools/server/server.cpp` never reads
  `params.system_prompt`. Passing `-sys` to llama-server is an argument error.
- **forge cannot do it either.** `forge-proxy --help` at 0.8.2 exposes no
  system-prompt or injection option; its only prompt surgery is
  `--backend-capability prompt` and `--inject-respond-tool`.

So `prompts/think-zh.md` is appended by the launcher, through
`pi --append-system-prompt` — confirmed present on the installed binary, which
documents it as taking "text or file contents" and as repeatable.

The fragment is written against the failure mode, not the feature: a model that
reasons in Chinese and then writes a Chinese character into an `old_string`, a
file path, or an identifier has produced a patch that does not apply. It pins
prose, code, quoted text and **tool-call arguments** to English explicitly, and
tells the model to keep literals verbatim inside the reasoning rather than
translating them.

### 2. The A/B harness that decides it (ADDED)

`scripts/ab_think_lang.py` runs the same six objectively-scored tasks with and
without the fragment, **with thinking enabled in both arms**, and reports:

| axis | why |
| --- | --- |
| mean score | the "better thinking?" half of kadoban's question |
| reasoning chars, completion tokens, wall seconds | the "just shorter?" half |
| CJK characters in visible output | prose leakage — wrong, but cosmetic |
| CJK characters in **tool-call arguments** | a call that cannot succeed |

The last row is the go/no-go: a leak there exits non-zero and the verdict says
not to adopt, no matter how good the score looks. `--repeat` (default 3) runs the
set multiple times per arm because sampling at `TEMPERATURE=0.6` is stochastic,
and `--min-delta` (default 0.05) is the band inside which a score difference is
declared noise rather than a result.

Scorers are exact only — integers, code executed against assertions, byte-exact
strings. No LLM judge, because a judge adds its own variance to a measurement
whose entire purpose is separating a real effect from noise.

`scripts/test_cjk_detector.py` covers the detector without a GPU (runs in CI). It
tests both directions: 12 strings that must flag, including fullwidth punctuation
and the ideographic space, and 10 that must not, including accented Latin,
Cyrillic, Greek, emoji and box-drawing characters. A leak detector that also
flags `café` would reject a working config.

### 3. eval.py could not measure any of this (FIXED)

Wiring the above surfaced a pre-existing blind spot. `scripts/eval.py` has always
sent `chat_template_kwargs={"enable_thinking": false}` on every request. So
**every committed number in `results/` and in the README scorecard describes the
no-thinking path**, while a real session against this stack runs with thinking on
under `REASONING_BUDGET=4096`. Nothing in the repo said so.

That matters more given what this thread says about Qwen's thinking specifically
— naasking: *"Qwen finds the answer relatively quickly but then second guesses
itself multiple times for another 20,000+ tokens"*; petu: *"Qwen3.6 is very token
inefficient with its thinking. Quantized versions often get into loops"*;
seanmcdirmid: *"I find my results are better without thinking because of
overthinking."* Those are claims about the exact path the eval was not testing.

- `EVAL_THINKING` (default `off`) now controls it. The default is unchanged on
  purpose: flipping it would silently break comparability with every row in
  `results/history.jsonl`.
- `EVAL_SYSTEM_PROMPT_FILE` lets the eval score the stack as `THINK_LANG=zh`
  would actually run it.
- Both are stamped into `results/latest.json` under `config`, so a run can never
  be mistaken for the other kind after the fact.

### 4. GGUF drift check (ADDED, report-only)

Aurornis: *"The quantized releases often change in the weeks following release as
new improvements are discovered, so either use a tool that checks HuggingFace for
new versions or manually check back."*

Nothing here would have noticed. `GGUF_FILE` pins a **filename**, and unsloth
reuses the filename when it uploads better bytes. `update.sh` now compares the
Hub's LFS `sha256` for the pinned file against `model_file_sha256` in
`versions.lock` and warns on a mismatch.

It is **report-only and never refetches**. The local copy is ~18 GB,
`download_model.py` already returns early when the file exists, and swapping a
working quant mid-update is a human's decision. The warning prints the exact
command to take the new one; nothing runs it for you.

This replaced a QAT-hint block that could never fire — it shelled out to
`huggingface-cli api list-models`, which is not a subcommand of that CLI, so the
branch always fell through to a hardcoded string. Dead code that looked like a
check.

Verified live 2026-08-11 against the real Hub API, in both directions: a
deliberately wrong sha in `versions.lock` produces the drift warning, and the
real sha (`4085665ee36d…`) reports a match.

### Corroborated — already true here, recorded so it is not re-litigated

- **Capping the thinking budget.** bitexploder runs a custom proxy for
  Qwen3.6-35B-A3B that injects *"Time to wrap it up bud! Get to work"* into the
  thinking stream at 2K tokens: *"In my experience it is almost never
  productively thinking past that point, just spinning in circles."* cyanydeez
  names the mechanism this stack already uses: *"Llamacpp provides reasoning
  budget and message. You can use the message to redirect it."* That is exactly
  `REASONING_BUDGET=4096` plus `REASONING_BUDGET_MESSAGE`. No change — but see
  the rejection below on the specific number.
- **Replaying the thinking.** bitexploder: *"I also reinject all of the
  thinking."* Already `FORGE_REASONING_REPLAY=full` since 2026-07-31.
- **pi as the harness.** bitexploder: *"use an extremely simple harness. Pi is
  good. Pi's default tools almost exactly match what Qwen says they tested the
  model with (likely meaning that tool set is also what they trained it with).
  So, in my experience bigger harnesses don't have a noticeable improvement on
  tasks."* seanmcdirmid independently: *"Goose was the only harness that didn't
  bloat context too much with system prompts (like openclaw)."* skohan runs
  Qwen3.6-27B Q4 with pi on 32 GB VRAM. This is direct support for
  `scripts/pi-local.sh` and for its `-nc` flag.
- **Loops on quantized Qwen** (petu) support both the repeat detector and the
  f16-K decision from the previous thread.

### Considered and rejected

- **Serving Muse Glimmer 30B instead.** Apache 2.0, dense 30B, official ~17 GB
  4-bit quant, 131K context, and by several accounts a much terser reasoner
  (andy99: *"No unessential parts of speech… its effective tok/s is way higher
  because it doesn't waste them"*). It also beats Qwen on tool calling, which is
  one of this stack's weaker suites. But khimaros posts the number that matters
  for agentic coding: **Terminal Bench 51.7 vs Qwen3.6-27B's 60.7**. This repo
  serves one model on one GPU with one slot; trading nine points of the closest
  available proxy for agentic coding to gain terseness is not a trade worth
  making here. Watch item, not a change.
- **Dropping `REASONING_BUDGET` to 2048** on bitexploder's figure. That number is
  from **35B-A3B**, a different model with a different reasoning profile, and it
  was tuned for a hand-built proxy. Now that `EVAL_THINKING=on` exists, this is
  measurable on 27B rather than adoptable by assertion. Left at 4096 until
  measured.
- **Disabling thinking entirely** (seanmcdirmid, and *"many harnesses disable
  thinking on Qwen anyways because it interferes with tool calling"*). Same
  reasoning: `REASONING_BUDGET=0` is one edit and now a measurable arm. Not
  adopted on an assertion.
- **The `Qwen3.6-27B-Fable-Fus-711-UnHeretic-NM-DAU-NEO-MAX-NEO` finetune.**
  BoredomIsFun claims it matches vanilla Qwen at coding while writing far better
  prose. SwellJoe, who actually ran it: *"it wrote security bugs into the code…
  it exhibited looping behavior in some configurations in llama.cpp,
  configurations I regularly use with the regular 27B, and it failed to write
  unit tests without being prompted."* The negative report is concrete and names
  the failure modes; the positive one is a vibe. Security bugs and llama.cpp
  looping are both disqualifying for a coding stack.
- **Qwen3.8** — *"releases this week"* per scrlk, unreleased as of this thread.
  When it lands it is a `MODEL_REPO` / `GGUF_FILE` change plus a re-run of the
  eval, nothing structural. Same for the `ThinkingCap` and `Bonsai` Qwen3.6-27B
  post-trains that dofm and andy99 mention; ThinkingCap in particular targets
  terser reasoning, which is the same goal as THINK_LANG by a different route.

### Not applicable to this stack

- **YaRN/rope context extension.** 0xc133 extends Muse Glimmer to 256K with
  `--rope-scaling yarn --rope-scale 2 --yarn-orig-ctx 131072`. Irrelevant here:
  Qwen3.6-27B's native context is already 262,144, and this stack caps at 65,536
  because of **VRAM**, not because of the model. There is nothing to extend —
  the constraint is the 24 GiB card.
- **`--spec-type draft-dflash`** (rao-v, cmrdporcupine) is Muse's speculative
  head. This stack uses `draft-mtp`, which is Qwen's.
- **llama-server router mode / llama-swap** (rancor, computershit). One model,
  one slot, by design.
- **`--no-mmproj`** (jakswa, to reclaim VRAM). `MMPROJ_FILE` is empty here, so no
  projector is ever loaded.
- **Ollama** (cube00's *"Friends Don't Let Friends Use Ollama"*). Already
  llama-server; see "The backends".

### Observed while testing, not acted on

`update.sh --check` run on 2026-08-11 reports **llama.cpp `server-cuda-b10335`**
(pinned: `b10200`) and **forge-guardrails 0.9.0** (pinned: `0.8.2`) available.
Both are deliberately left alone: applying them requires the GPU host, since the
update only counts as verified once the smoke test passes on real hardware.

---

## 2026-08-12 — pi only, and headroom

Two changes, one theme: everything in the path should be something this stack is
actually measured on.

### Claude Code removed

Deleted: `scripts/claude-local.sh`, `scripts/claude-code-env.sh`, the
`forge-claude` Harbor agent subclass and its installer, the Anthropic-format
smoke-test check, the `CLAUDE_*` keys in `.env`, and `configs/opencode-provider.json`
(a third client nothing here targets either).

Why, beyond "pick one client": Claude Code's cost on a 64K local window is
structural rather than incidental. Its system prompt plus tool schemas spend a
five-figure token count before the first user message, and the single biggest
thing `claude-local.sh` did was disable every MCP server to claw that back. pi's
overhead is a fraction of it. Keeping both meant two launchers, two wire
formats, two smoke-test paths and two sets of `.env` keys, all so the worse fit
could stay supported.

What was **not** removed: forge still serves `/v1/messages`. The route is pure
Python conversion in `forge/proxy/convert_anthropic.py` and costs nothing to
leave in place. An Anthropic-shaped client would still work; it is simply not
what anything here is tuned, measured or documented for.

`Dockerfile.forge` dropped the `[anthropic]` extra. Verified against the 0.8.2
wheel rather than assumed: the only `import anthropic` in the package is inside
`forge/clients/anthropic.py`, which `forge/proxy/proxy.py` imports lazily,
function-locally, in the branch that handles an Anthropic-shaped *backend*.
Our backend is llama.cpp on the OpenAI wire, so it never runs, and
`forge/clients/__init__.py` does not import it eagerly.

### pi has no MCP — on purpose

pi's own README, line 495: *"**No MCP.** Build CLI tools with READMEs, or build
an extension that adds MCP support."* Confirmed against the installed binary:
`pi --help` has no MCP flag anywhere.

That is worth stating plainly rather than treating as a gap, because it is the
same win `claude-local.sh` was manufacturing with `--strict-mcp-config`. The
cost is real — no MCP servers, no sub-agents, no plugin ecosystem — and the
return is nearly the whole 64K window for the session itself.

New `.env` keys, all previously hardcoded in the launcher: `PI_MAX_TOKENS`,
`PI_CONTEXT_FILES` (whether `-nc` is passed), `PI_EXTRA_ARGS` (alias replay —
bash does not expand aliases inside scripts, the same trap `CLAUDE_EXTRA_ARGS`
existed for).

### headroom, behind a profile, off by default

[headroom](https://github.com/headroomlabs-ai/headroom) compresses tool output,
logs and JSON before they reach the model. It is wired in **in front of forge**:

    pi -> headroom :8787 -> forge :8081 -> llama :8080

In front, not behind, for two reasons. forge's retry-with-nudge loop would
otherwise re-enter compression on every attempt and hand llama.cpp different
bytes each time, discarding the prefix-KV reuse that `--cache-reuse` and
`--slot-prompt-similarity` exist for. And forge's `--budget-tokens` accounting
is only meaningful if it sees the request that is actually sent.

It is off by default and stays off until `./scripts/ab-headroom.sh` says
otherwise. headroom's published accuracy numbers (GSM8K unchanged, BFCL 97%)
were established on frontier hosted models; this is a 4-bit 27B whose own tools
suite scores 0.73, and the failure mode of over-compression is not an error, it
is a confident answer drawn from a view of the data that no longer contains the
answer.

Findings that shaped the wiring, all read out of the source rather than assumed:

- **Unknown models default to a 128K context window.**
  `crates/headroom-proxy/src/compression/model_limits.rs` falls back to 128K
  with a one-time warning for any model id absent from LiteLLM's table.
  `qwen3.6-27b` is absent. So headroom sizes its compression against twice this
  stack's real window. `HEADROOM_TARGET_RATIO` is therefore the lever that
  matters, and forge's `--budget-tokens ${CTX_SIZE}` stays the backstop.
- **`max_tokens` is renamed and then silently ignored.**
  `_normalize_openai_max_tokens` in `headroom/proxy/handlers/openai.py` pops
  `max_tokens` and sets `max_completion_tokens` — a correct compatibility shim
  for GPT-5/o-series, which reject the legacy key. llama.cpp does not read it:
  `tools/server/server-common.cpp` maps `max_tokens` onto `n_predict` and copies
  unrecognised keys through untouched (only `best_of` and `suffix` throw). The
  cap would therefore vanish. Fixed at the server, not by hoping: `-n 16384` in
  `LLAMA_EXTRA_FLAGS`, which `server-context.cpp` consults as
  `global_params.n_predict` whenever a task arrives without one. Keep it equal
  to `PI_MAX_TOKENS`.
- **CCR does not require MCP.** headroom ships an MCP server, which pi cannot
  use. It does not matter: `CCRToolInjector` puts `headroom_retrieve` into the
  request's own tool array and `CCRResponseHandler` answers the call, so
  reversibility is available over the plain proxy path. The MCP server is a
  second, optional surface.
- **`--lossless` is the right default here.** It applies format-native
  compaction with a marker-free SmartCrusher and suppresses both the CCR markers
  and the injected tool. Nothing the model sees becomes unrecoverable, and no
  extra tool schema competes with the real ones — which matters at 0.73 on
  tools. `HEADROOM_RECOVERY` exposes `lossless` / `ccr` / `lossy`; the
  translation happens in `scripts/headroom-entrypoint.sh` and fails loudly on an
  unknown value, because compose has no conditionals and two contradicting
  booleans is a worse interface than one validated enum.
- **Built without `[ml]`.** That extra pulls `torch>=2.12` for the Kompress
  prose model. The GPU is fully committed to the 27B in the next container, so
  it would be gigabytes for a compressor with nowhere to run. The compression
  that pays for itself in an agent loop — JSON, logs, build output — is
  SmartCrusher and format-native compaction, neither of which needs torch.
- **Subscription tracking off.** `headroom/proxy/auth_policy.py` classifies
  clients by user-agent prefix and arms a tracker that polls
  `https://api.anthropic.com/api/oauth/usage`. Pointless outbound traffic from a
  stack whose premise is that nothing leaves the machine.
- **Pinned via PyPI, not GHCR.** headroom publishes images only under
  `sha-<commit>` tags — the last 100 tags contain no semver at all — so the
  pinnable artifact is the PyPI release and `Dockerfile.headroom` builds from
  it, exactly as `Dockerfile.forge` does for forge.

### The A/B harness

`scripts/ab_headroom.py` runs **both arms through headroom** so the path is
identical, and bypasses compression in the control arm with
`x-headroom-bypass: true` — documented in
`headroom/proxy/compression_decision.py` as the user's "do not touch my bytes"
contract. The only difference between arms is whether compression ran.

It reuses the six objectively-scored tasks from `ab_think_lang.py` (one copy, so
the two A/Bs stay comparable) and adds three **recall** tasks: a 220-row JSON
tool result, a 600-line log and a long file read, each with one fact that has to
survive. They are delivered as `tool` messages because headroom skips user
messages by default — a payload pasted into the prompt would measure nothing.

Recall is scored separately and more harshly than the mean, because losing a
needle is the specific thing compression costs and it would otherwise average
away against six tasks that were never compressible. Two guards keep a
non-result from reading as a pass: no `x-headroom-tokens-*` accounting on the
compressed arm returns INCONCLUSIVE (nothing proves compression ran), and a
control arm scoring under 0.2 on recall returns INCONCLUSIVE too (the tasks are
failing before compression is a factor — most likely `AB_RECALL_MAX_TOKENS`
against `REASONING_BUDGET`, since thinking tokens are completion tokens).

`eval.py` still talks straight to `forge:8081` and always will. The committed
scorecard is a number about the model; compression is a separate number and
should stay one.

### Not yet measured

Nothing here has been run against the GPU host — the stack was down while this
was written (`:8080` and `:8081` both silent). Every claim above is from source
or from `--help` on an installed binary. The headroom numbers do not exist yet;
`./scripts/ab-headroom.sh` is how they get made.

### Verified on the built image (2026-08-12)

The GPU host was unavailable, but the headroom container itself was built and
run here, so these are observations rather than readings:

- `Dockerfile.headroom` builds on `python:3.13-slim` with
  `headroom-ai[proxy,code]==0.34.0`. No torch in the resolved set, as intended.
  Startup banner reports `Code-Aware: ENABLED (AST-based)`, so the `[code]`
  extra is doing its job.
- `headroom proxy --help` on 0.34.0 carries every flag this repo passes:
  `--lossless`, `--no-ccr`, `--openai-api-url`, `--provider-name`,
  `--no-subscription-tracking`, `--target-ratio`.
- `scripts/headroom-entrypoint.sh` exits 2 on an invalid `HEADROOM_RECOVERY`
  and prints `recovery=lossless target_ratio=auto` on a good one. The proxy
  reaches `/health` 200 with an unreachable upstream, which is what
  `HEADROOM_SKIP_UPSTREAM_CHECK=1` is for.
- Routing table at startup confirms `/v1/chat/completions` and `/v1/messages`
  both pointing at the configured upstream rather than at any hosted API.
- **Endpoint access from a non-loopback source** (which is what a browser on the
  host is, since it arrives via the Docker gateway): `/dashboard`, `/stats`,
  `/stats-history` and `/metrics` all answer 200. `/settings` answers 404 and
  **stays** 404 with `HEADROOM_PROXY_TRUSTED_DASHBOARD_CLIENT_CIDRS` set to the
  bridge range — so that variable is deliberately not set in compose. The first
  draft set it with a confident comment about why it was needed; testing it is
  what turned that into a wrong guess instead of a shipped one.

---

## 2026-08-12 — MCP as a CLI, not as MCP

pi has no MCP and this stack does not want it, but "no MCP servers at all" is a
real capability loss. `mcp2cli` closes it without reopening the context-window
problem: it turns any MCP server (stdio, HTTP or SSE) into a CLI at runtime,
so a tool's schema is only paid for at the moment the model asks for that tool.

### Why mcp2cli and not mcpo

The obvious alternative was **open-webui/mcpo** (4.3k★), which fronts an MCP
server with a REST + OpenAPI service. Rejected on two grounds. It is a
long-running HTTP service per server — more compose surface for something the
model still has to discover by reading an OpenAPI document, which is the same
schema cost in a different envelope. And a compose service cannot help pi
anyway: pi runs on the host, and what it needs is a *command*, not a port.

mcp2cli is also the option that agrees with pi's own position. pi's README says
to build CLI tools with READMEs rather than wire up MCP; a CLI plus a skill is
exactly that shape.

### Shape

- `mcp/servers.json` — committed registry, `stdio` or `url` per entry. The
  indirection exists so the model types `./scripts/mcp.sh linear --search issue`
  rather than a 60-character transport string it has to get right, and so
  credentials stay as `env:VAR` / `file:/path` references. CI rejects a literal
  secret in an `auth_header`.
- `scripts/mcp.sh` — resolves a name to mcp2cli transport flags, installs the
  pinned mcp2cli on first use, and passes everything else through verbatim.
- `skills/mcp-tools/SKILL.md` — an Agent Skills package. pi keeps only a skill's
  name and description in the system prompt (~60 tokens) and loads the body when
  a task matches, which is the same progressive-disclosure property that makes
  this worth doing at all. The skill teaches the cheap-to-expensive loop
  (`--search` → `--list --compact` → `<tool> --help` → call) and explicitly
  forbids dumping a server's full schema.
- Loaded via `pi --skill <abs path>`, which is additive and takes an absolute
  path — so the skill travels with the repo, nothing is written into `~/.pi`,
  and it still applies when pi is started in another project's directory.

### Measured, and it changed the design

- **A plain `uv tool install mcp2cli` is broken today.** The MCP Python SDK
  released **2.0.0**, renaming `Tool.inputSchema` to `input_schema`; mcp2cli
  3.3.1 still reads the camelCase name, so the fresh install resolves 2.0.0 and
  every MCP call dies with `AttributeError: 'Tool' object has no attribute
  'inputSchema'` before reaching the server. Reproduced against the reference
  server, then fixed by installing with `--with mcp==1.29.0` and reproduced
  working. `MCP_SDK_VERSION` carries the pin and CI fails if it moves to 2.x.
  Had this not been run before writing the docs, the repo would have shipped a
  skill instructing the model to use a command that cannot work.
- **Sessions do not work here.** `--session-start` returns "session daemon did
  not start in time", and a call through `--session` returns nothing. So each
  invocation spawns the server (~5s for an `npx` one); the skill says to batch
  questions rather than reach for sessions.
- **stdout/stderr are cleanly separated.** `Starting default (STDIO) server...`
  goes to stderr and `--json` puts the full MCP envelope on stdout, so
  `2>/dev/null` gives parseable output. Documented in the skill because the
  model will otherwise assume the banner is part of the payload.
- **Verified end to end** against `@modelcontextprotocol/server-everything`:
  `--list --compact` returns 13 tool names on one line, `--search sum` finds
  `get-sum` with its description, `get-sum --help` renders `--a`/`--b` from the
  input schema, and `get-sum --a 20 --b 22` returns 42.

### What was NOT verified

pi's own skill loading. `pi --skill <dir> --list-models` starts cleanly with the
skill path, but a control run with a deliberately malformed skill also started
cleanly — so that test proves nothing about validation, and it is recorded as
proving nothing. The frontmatter is instead checked against the Agent Skills
spec in CI (name pattern, description length, non-trivial body). Whether the
27B actually *reaches for* the skill mid-task is unmeasured, and is the next
thing to look at once the GPU host is up.

### Both switched on by default (2026-08-12, operator decision)

`HEADROOM_ENABLED=1` and `MCP2CLI_ENABLED=1` are the shipped defaults.

For MCP-as-a-CLI this needs no defence: the standing cost is the skill's name
and description, and nothing else happens until the model chooses to call a
server.

headroom is the one worth being precise about, because it was built with an
"off until measured" gate and that gate is now removed. The consequence, stated
plainly rather than buried: **`eval.py` talks straight to `forge:8081` and always
will, so every number in `results/` describes the model with no compressor in
the path, while a real session now runs through one.** The two are no longer the
same configuration. `scripts/ab-headroom.sh` is the instrument that closes the
gap, it still exists, and nothing gates on it.

Turning it on also had to make it actually work: headroom sat behind a compose
profile, so `up.sh` would not have started it and `pi-local.sh` would have died
on a health check. Rather than sprinkle `--profile headroom` through six
scripts, `compose()` in `scripts/lib.sh` adds the profile when
`HEADROOM_ENABLED=1`. That keeps the key meaning one thing — in the path and
running, or neither — for up, down, logs, ps and the smoke test alike.

### Measured on the GPU host, 2026-08-12: the cold-load budget was wrong

First real bring-up of the pi-only stack. `setup.sh --skip-model` built both
images, pulled llama.cpp, started all three containers, and then failed its
smoke test with `llama-server reachable — timed out after 900s`, while
llama-server itself was answering `503 {"error":"Loading model"}` — that is, a
server working exactly as intended, reported as unreachable.

Two numbers settled it, both measured rather than assumed:

- **The mount does 10–12 MB/s.** `dd` from a throwaway alpine container against
  `//d/llm-models`, 200 MiB at an offset, twice: 9.4 MB/s while the stack was
  under memory pressure, 12.2 MB/s after it was relieved. At 17.9 GB that is a
  **~24 minute cold load**. The old 900s smoke-test wait and 600s
  `start_period` were both under it, so the first start could never pass.
  Corrected to 2700s (`SMOKE_LOAD_TIMEOUT`) and 2400s.
- **A stalled load and a slow load look identical from the outside.** The first
  attempt was not merely slow: CPU sat at 213% with VRAM flat at 2720 MiB across
  three samples a minute apart, which is thrashing, not progress. The cause was
  memory pressure — a runaway `ugrep` at 5.8 GB RSS and still growing, plus nine
  idle agent sessions, leaving 1.8 GB free of 22 GB. The model is mmap'd, so its
  pages were being evicted as fast as they faulted in. Killing the one runaway
  took available memory from 8.6 GB to 13.4 GB.

The distinguishing signal is VRAM: with `-ngl 999` a healthy load climbs, a
thrashing one does not. `docker stats` BlockIO is useless here — a bind mount
from the Windows side does not go through the container's block device, so that
counter stays near zero either way. Both are now in the README's troubleshooting
section, because "first start takes 25 minutes" and "the load is wedged" want
opposite responses and the obvious instruments do not tell them apart.

### The KV cache quantization was costing 65x (2026-08-12, measured)

The first real workload on the GPU host exposed something the repo had been
asserting confidently and wrongly since it was written.

`.env` carried `-ctk f16 -ctv q8_0` with this justification: *"This model's
256-wide heads are in the CUDA flash-attention head-size table for both decode
and prefill kernels regardless of cache quant."* That claim is false on
`b10200`. With a quantized V cache, **prefill leaves the GPU**:

| KV cache | prompt processing | 12K-token request |
| --- | --- | --- |
| `-ctk f16 -ctv q8_0` | 26–140 tok/s, falling with length | never finished in 600s |
| f16 / f16 | **1806–2040 tok/s** | **6.9 s**, correct answer |

The signature was a doubling per chunk — 16s, 43s, 86s, 172s for successive
2048-token blocks — with `nvidia-smi` reporting 0% GPU utilisation while the
process sat in state `R`. Decode was unaffected throughout (61–73 tok/s), which
is why the problem hid: short smoke-test prompts and short chat turns look fine,
and only a real tool-output-sized prompt exposes it.

It cannot be worked around by disabling flash attention: llama.cpp refuses to
start with `V cache quantization requires flash_attn`. So on this build the
choice is f16/f16 or nothing.

Consequences, all now in `.env` and `README.md`:

- **`CTX_SIZE` 65536 → 32768.** f16/f16 is ~132 KiB/token against ~98 KiB with a
  quantized V, and f16/f16 at 64K does not fit a 24 GiB card. Measured at 32K:
  21566 MiB of 24564 MiB, ~3 GiB spare. A 32K window that answers in seconds
  beats a 64K window that times out.
- **`-b 4096 -ub 2048` removed.** Adopted from "two independent public Qwen3.6
  configs" on the theory that the default `-ub 512` leaves the GPU idle. It cost
  ~850 MiB of VRAM and changed nothing once prefill was actually on the GPU.
- **`PI_MAX_TOKENS` 16384 → 8192**, and the `-n` backstop with it, since half of
  a 32K window is no longer a sane single-reply cap.
- **`SPEC_TYPE=draft-mtp` kept.** Tested with it off: prefill was identical, so
  MTP was not implicated. It stays for the decode win (draft acceptance 1.00,
  mean length 3.0 in the logs).

Two smaller findings from the same session:

- **`CACHE_REUSE` does nothing on this model.** llama-server logs
  `cache_reuse is not supported by this context, it will be disabled` at every
  start — the hybrid Gated DeltaNet layers carry recurrent state that cannot be
  partially reused. The key is left in place, now labelled, so it is not
  mistaken for an optimisation that is running.
- **The committed `speed 0.47` eval score was measuring this bug**, not the
  model. Every scorecard in `results/` predates the fix.

The general lesson is the one this file already argues for elsewhere and did not
follow here: the KV-quant line was adopted from a community thread with a
confident technical rationale attached, and never measured on this hardware. It
was wrong in the most expensive possible way — silently, and only under real
load.

### headroom measured: it saves nothing here, and the reason is structural

Two A/B runs on the GPU host, `lossless` and `ccr`, `--repeat 1`, cache disabled
for the run. Identical verdicts:

```
prompt tokens 4599 -> 4599 (+0.0%)
score         0.889 -> 0.889   (ccr run: 0.778 -> 0.778)
recall        1.000 -> 1.000
NO CHANGE — under 5% of prompt tokens saved on this workload.
```

The ground truth is `usage.prompt_tokens` reported by llama.cpp, not headroom's
own accounting: the recall tasks sent **11940 / 22196 / 6532** tokens in *both*
arms, to the token. Nothing reached the model any smaller. Quality and recall
were untouched (1.000 in both arms, all three needles found), so compression is
inert here rather than harmful.

`ccr` did fire two transforms (`router:text:0.88`, `router:text:0.91`) and its
CCR store held **139 original tokens against 101 compressed** — it is nibbling
at fragments, not the 22K-token log it was pointed at.

**The likely cause is structural.** `DEFAULT_EXCLUDE_TOOLS` in
`headroom/config.py` excludes tool results by name:

    Read, Glob, Grep, Write, Edit, WebSearch, WebFetch, headroom_retrieve
    read, glob, grep, write, ...        (lowercase variants)

pi's built-in tools are `read`, `bash`, `edit`, `write`. **The tool outputs
worth compressing in a real pi session are on headroom's exclusion list by
name**, and the exclusion exists for a good reason upstream (recompressing CCR
content writes a marker the agent can never redeem, #1077). This is a genuine
mismatch between what headroom is tuned for and what this stack generates, not
a knob left at the wrong value.

`HEADROOM_ENABLED` stays 1 per operator decision. It is on, it is measured, and
what it currently buys is recorded here as 0%. The next thing to test is
`--protect-tool-results` / an `exclude_tools` override through
`HEADROOM_EXTRA_FLAGS`, which is the documented lever for changing that set.

### Two harness bugs the first runs exposed

- **headroom's semantic cache invalidated the entire first A/B.** The bypass arm
  populated it, the compressed arm served hits, every task returned in 0.0s with
  identical scores, and compression never executed. A cached response also
  carries no `x-headroom-tokens-*` headers, which is what the INCONCLUSIVE guard
  keys on — so the guard caught it and refused to report a pass. That guard
  earned its place on its first outing. `ab-headroom.sh` now restarts headroom
  with `--no-cache` for the duration and restores it from an EXIT trap.
- **`codegen` scored 0.00 "no code" as a pure artefact.** `REASONING_BUDGET=4096`
  exceeded the task's 3072 `max_tokens`, so the model could spend its whole
  allowance thinking and emit no answer. Raised to `AB_TASK_MAX_TOKENS=6144` and
  it scores 1.00. The same flaw was in the think-lang A/B. `bugfix` still fails
  at 6144, in both arms, so that one is the model.
