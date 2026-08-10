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
forge does not synthesize signed Anthropic thinking blocks on the way back, and
`MAX_THINKING_TOKENS=0` stops the client asking for them, so **the user never sees
the thinking block at all**. Reasoning in another language therefore has no
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

So `prompts/think-zh.md` is appended by the launchers, through
`claude --append-system-prompt` and `pi --append-system-prompt` — both confirmed
present on the installed binaries. `claude --help` does not document repeating
the flag, so `claude-local.sh` joins the user's own prompt file and the fragment
into one argument rather than passing it twice and hoping.

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
no-thinking path**, while a real Claude Code session against this stack runs with
thinking on under `REASONING_BUDGET=4096`. Nothing in the repo said so.

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
