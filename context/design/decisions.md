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

**forge from PyPI, not from a git checkout.** `forge-guardrails==${FORGE_VERSION}`
in a `pip install` means updating is a version bump in `.env` and a rebuild, with
no submodule to keep in sync. (The 0.8.2 -> 0.9.0 bump on 2026-08-15 cost more
than a rebuild, but only because 0.9 changed the Proxy contract — see that
entry.)

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

`--budget-tokens ${CTX_SIZE}` pins forge's reported budget to the same number
llama-server booted with, so forge never probes for it and the two can never
disagree.

*Superseded 2026-08-15:* this used to read `--budget-mode manual --budget-tokens
${CTX_SIZE}`. forge 0.9.0 rejects `budget_mode` for unmanaged backends outright
— "error: unmanaged backends do not accept budget_mode", exit 2 — and its proxy
is now unconditionally no-compaction, so `--budget-tokens` is a reporting
denominator and nothing else. See the 2026-08-15 entry.

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

Slot files are stored in a Docker named volume (`qwen38-slot-cache`) so they survive
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
  `qwen3.8-27b` is absent. So headroom sizes its compression against twice this
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

### headroom, measured at the wire: it forwards tool payloads unchanged

Chasing the 0% to the bottom. An echo upstream (a 30-line HTTP server standing
in for forge, so no inference is involved) recorded exactly what headroom sends:

| arm | body bytes | tool content |
| --- | --- | --- |
| bypassed | 37750 | 36546 chars |
| compressed | **37750** | **36546 chars** |

Byte-identical, with `--mode token`, `HEADROOM_RECOVERY=ccr`, `--no-cache`, the
Kompress model installed, and the tool result as the **trailing** message (the
real agent shape). The response header still advertises
`x-headroom-transforms: router:search:0.77`.

So headroom computes a 23% compression, reports it, and forwards the original
bytes. Confirmed three independent ways: llama's `usage.prompt_tokens` in the
A/B, the same via a direct probe, and now the wire itself.

The capability is real and reachable — `POST /v1/compress` with the same messages
returns **9183 -> 7086 tokens, 2097 saved**, tool content 36546 -> 28160 chars.
It is only the proxy request path that declines to apply it. The leading
candidate is the reversibility gate (`enforce_reversibility = role == "tool"` in
the content router), which requires a redeemable CCR marker before tool output
may be rewritten — but that is a hypothesis, not something measured, and two
earlier confident explanations were already wrong:

- **"DEFAULT_EXCLUDE_TOOLS blocks it."** Wrong. Excluded tools are protected only
  from *lossy* compression, and `/v1/compress` compresses `read_logs` and
  `fetch_logs` identically.
- **"The frozen prefix blocks it."** Wrong, or at least insufficient.
  `_strict_previous_turn_frozen_count` makes a trailing `tool` message mutable,
  and the trailing-tool-result shape is still forwarded unchanged.

### What was genuinely fixed, and what it cost

The `[ml]` extra was missing and that was a real defect: without Kompress,
`/debug/warmup` reports `kompress {"status": null, "deferred"}` and the first
fall-through text payload does not degrade — it **blocks**, leaving a request
that llama had already answered unreturned until the client gives up. Fixed by
installing `[ml]` with CPU-only torch and baking
`chopratejas/kompress-v2-base` into the image (`HF_HUB_OFFLINE=1` set *after*
the download, so a cache miss fails fast instead of hanging).

The cost was not free: the image went 1.28 GB -> 4.86 GB, and loading torch in
the headroom container on a 22 GB VM already streaming a 17.9 GB model
**OOM-killed llama** (`Exited (137)`), costing a 40-minute cold reload.

### A separate stack bug found on the way

With the tool result trailing and tools declared — every real agent turn —
llama answers correctly when called **directly** (68s, "The FATAL line is..."),
but through **forge** the model returns empty content and calls the same tool
again (`content='' tool_calls=True`). forge then spends its retry budget on it,
and the client times out even though llama returned 200 in 45s. Reproduced at
5K and 22K token payloads. This is unrelated to headroom and is why the real
agent shape could not be measured end to end.

### headroom removed (2026-08-12, operator decision)

Deleted: `Dockerfile.headroom`, `scripts/headroom.sh`,
`scripts/headroom-entrypoint.sh`, `scripts/ab_headroom.py`,
`scripts/ab-headroom.sh`, the compose service and its `ab-headroom` one-shot,
the `headroom-state` volume, the `HEADROOM_*` keys, the compose-profile
injection in `lib.sh`, the smoke test's third hop, and the `update.sh` version
tracking. `ab_think_lang.py` was unwound back to its own shape, keeping only
`AB_TASK_MAX_TOKENS` — that one was a real bug fix (a 3072 cap under a 4096
reasoning budget scored working code as "no code") and stands on its own.

The reason is in the three entries above, and it is not that headroom is a bad
tool. It is that on this stack it moved **zero bytes**, measured four ways:
llama's `usage.prompt_tokens` across two A/B runs, a direct probe, and finally
an echo upstream that recorded byte-identical request bodies (37750 bytes,
36546 chars of tool content) with compression on and off — while the response
header advertised `x-headroom-transforms: router:search:0.77`. Its own
`/v1/compress` endpoint compresses the same messages by 23%, so the capability
is real; the proxy request path simply never applied it.

Against zero benefit it cost: a 4.86 GB image (1.28 GB before the `[ml]` extra
became mandatory), an extra network hop, ~700 MB of resident memory, one
**OOM-killed llama** and the 40-minute cold reload that followed, plus a
semantic cache that silently served stale responses and invalidated a whole A/B
run before it was noticed.

What is kept, deliberately: `results/headroom-ab-lossless.json` and
`results/headroom-ab-ccr.json`. Deleting the evidence for a decision leaves the
decision looking arbitrary to whoever reads this next.

The `-n` generation cap in `LLAMA_EXTRA_FLAGS` also stays. It was added because
headroom renames `max_tokens` to `max_completion_tokens` and llama.cpp reads
only the former — but it is the right backstop regardless of what is upstream,
since any client that sends the newer key would otherwise get no cap at all.

### forge requires a tool call whenever tools are present (2026-08-12)

The bug found while probing headroom, now fixed. forge's proxy path branches on
whether the request carries tools:

```python
if not tool_specs:            # no tools -> forward straight through
    ...
validator = ResponseValidator(tool_names, ...)   # tools -> a bare text reply FAILS
```

With tools declared, a plain text answer is a validation failure. forge appends
a nudge — *"Your previous response was not a valid tool call"* — and retries up
to `--max-retries` before giving up and passing the text through anyway.

Captured against an echo backend standing in for llama, so there is no ambiguity
about what forge sent:

```
[3] assistant  'The FATAL line is worker-3, code 7741.'      <- correct answer
[4] user       'Your previous response was not a valid tool call...'
[5] assistant  'The FATAL line is worker-3, code 7741.'      <- correct again
[6] user       'Your previous response was not a valid tool call...'
[7] assistant  'The FATAL line is worker-3, code 7741.'
[8] user       'Your previous response was not a valid tool call...'
```

llama's own log shows the cost: the same request re-prefilled at 5436 -> 5495 ->
5565 tokens, growing by the nudge each round.

**This fires on most turns of a real agent loop.** After a tool result comes
back, answering in text IS the correct move — forge treats the normal case as an
error.

`FORGE_EXTRA_FLAGS=--inject-respond-tool` fixes it: the model gets a
`respond(message="...")` tool, so an answer is a tool call and the guardrails
still apply; forge strips the respond call on the way out and the client sees
ordinary text. Measured on the trailing-tool-result shape — **without it the
request timed out at 398s having never returned; with it the correct answer came
back with `tool_calls` empty.** The smoke test still passes 11/11, so genuine
tool calls (`get_weather`) are unaffected.

The old note here said this flag was a crutch for ~8B models and that "a 27B
does not need" it. That was wrong, and wrong in a way that mattered: the
requirement is structural in forge, not a property of the model.

### CACHE_RAM was 8 GiB of HOST memory (2026-08-13)

Prefill collapsed to **2.83 tok/s** (from ~2000) with generation still healthy
at 43.9 — the same signature as the KV-quant bug, from a completely different
cause, which is why both are recorded.

`CACHE_RAM=8192` is a host-RAM budget, and it accounted for the llama
container's entire 9.02 GiB RSS. On a 22 GiB VM shared with the other
containers and a dozen agent sessions that left **394 MiB free with 5.5 GiB in
swap**, and prefill degrades under that pressure. Lowered to 2048: host usage
16.8 -> 8.2 GiB, available 5.2 -> 13.8 GiB.

Worth stating plainly because it cost time twice tonight: **prefill collapsing
while decode stays fine has at least two distinct causes on this stack** — a
quantized V cache (fixed by removing it) and host memory pressure. The second
was nearly misdiagnosed as a regression of the first.

`/free` was run and found nothing to reclaim: no abandoned sessions (all ten
pts devices had been written within the threshold) and no runaway process. The
pressure was our own configuration, not stray sessions.

### The forge fix, corrected: --max-retries 0, not --inject-respond-tool

`--inject-respond-tool` (committed in ae93ce0) did fix the correctness bug, but
it was the wrong fix and the eval caught it. Making the model answer via
`respond(message="...")` means every answer is a JSON tool call it has to
generate and forge has to unwrap. Three configs, same two request shapes,
measured 2026-08-13 on a healthy stack:

| config | tool turn | answer turn |
| --- | --- | --- |
| `--max-retries 3`, no respond tool | 3.6s | 6.7s — **WRONG** (returned another tool call) |
| `--max-retries 3` + respond tool | 1.3s | 5.1s — correct |
| **`--max-retries 0`** | 1.7s | **0.8s — correct** |

`--max-retries 0` is strictly better: forge makes one attempt, raises
`ToolCallError`, and passes the text through unchanged. Rescue parsing still
runs, so a malformed tool call is still recovered — only the nudge-and-retry
loop is gone, and pi has its own agentic loop for anything needing another turn.

The process failure is worth recording too: ae93ce0 shipped on a *functional*
test (answer vs. no answer) with no latency measurement. The three-way
comparison above should have run before that commit, not after the scorecard
regressed.

### The speed suite cannot see a prefill regression

Three eval runs tonight, and the metric that should have screamed about a 65x
prefill collapse barely moved:

| run | overall | speed | prompt_processing detail |
| --- | --- | --- | --- |
| KV-quant bug, 64K ctx | 0.835 (26/26) | 0.468 | 117 tok/s (521 tokens in 4.4s) |
| KV fixed + respond tool | 0.843 (24/26) | 0.420 | 75 tok/s (521 tokens in 6.9s) |
| KV fixed + max-retries 0 | 0.833 (23/26) | 0.500 | 144 tok/s (521 tokens in 3.6s) |

Overall is flat across all three — 0.833 to 0.843 is noise at temperature 0.6.
**The suite scored 0.47 both before and after a fix that made prefill ~65x
faster**, because `speed/prompt_processing_tps` sends a **521-token** prompt and
derives tok/s from end-to-end wall clock through forge. At that size the number
is dominated by fixed per-request overhead, and the KV-quant collapse only
appeared above a few thousand tokens. Measured directly against llama the same
evening: **2246-2331 tok/s prefill, 44-46 tok/s generation** — figures the suite
cannot produce and does not resemble.

So the committed scorecard was not merely stale, it was structurally unable to
detect the worst bug in this stack's history. A prompt-processing test worth the
name needs a prompt of at least a few thousand tokens and should read llama's
own `timings.prompt_per_second` rather than dividing by wall clock. Not fixed
here — recorded so the next person does not trust that row.

`edits/mixed_tabs` also flipped to 0.00 this run after scoring 0.50 and 1.00 in
the two before it. Single-sample tests at temperature 0.6 move around; the
suite has no repeat mechanism, so individual rows should not be read as
regressions.

## 2026-08-13 — controlling the stack from pi, and what probing it cost

Goal: drive forge and llama-server from inside pi instead of a second terminal.
Shipped as `.pi/extensions/stack.ts` — a `/stack` command plus a read-only
`stack_status` tool. Everything below was probed against the running build
(llama-server b10200, forge 0.8.2). Three of the probes contradicted what the
previous session had recorded, and the corrections are the valuable part.

### The handoff's forge route table was wrong

It listed forge's surface as `GET /forge/health`, `GET /forge/usage`,
`POST /v1/messages`, and flagged `/forge/usage` as something we should start
using. Both `/forge/*` routes **404 on our build**. They belong to forge 0.9.0;
the table had been read out of the HEAD clone in `/tmp/research/forge` and
written down as if it were live. There is no usage endpoint to adopt.

forge 0.8.2's actual surface, from the installed package and confirmed by
probe: `/health`, `/v1/models`, `/v1/messages`, `/v1/chat/completions`,
`/chat/completions`. No admin or config API — it is CLI-flag driven only.

### `POST /props` is 501, so "configure llama at runtime" does not exist

Confirmed again. Context size, sampling, reasoning budget and MTP are startup
flags. `/stack set` therefore edits `.env` and reports exactly what must be
recreated. The key→service mapping is parsed out of `docker-compose.yml` at
runtime rather than hardcoded, so it cannot drift when the compose file grows a
knob, and keys that only `pi-local.sh` reads are called out separately — those
need pi restarted, not a 20-minute model reload.

### `/props.n_ctx` is null; the real value is elsewhere

Reading the obvious field would have reported "unknown context" forever. The
authoritative values are `default_generation_settings.n_ctx` and each slot's
`n_ctx`. A field existing is not a field being populated.

### slot-cache.sh has been a silent no-op

It sends `POST /slots?action=save&id_slot=N`. That form **404s on b10200**; the
route is `POST /slots/{id}?action=...`. Two layers hid it: `curl -f` swallows
the body and `|| true` swallows the exit status. The previous session cited this
script as proof the syntax worked — it proved only that the script never checks.
Fixed to use the correct route and to report failures. Nothing in the repo calls
it, which is the only reason this cost nothing in production.

### Saving a slot is expensive, and aborting one wedges the server

Measured, at PARALLEL_SLOTS=1 with a 32k context: a single slot save wrote
**315 MB in 180 s and had not finished**. Aborting it mid-write **wedged
llama's task queue**: `/slots`, `/metrics`, `/lora-adapters` and all inference
hung from then on, while `/props` and `/models` — which bypass the queue — kept
answering 200. `docker restart` then failed with the process a zombie; the
container had to be force-killed and recreated, costing a cold load.

This has two consequences worth keeping:

1. **`save_slots` must never be an EXIT trap**, which is exactly what
   slot-cache.sh's header suggested. Container shutdown SIGTERMs and then
   SIGKILLs on a timeout — the abort that wedges the server — on every
   `docker compose down`.
2. **A health check that only hits `/props` or `/health` cannot see this.**
   `/stack` now flags the signature explicitly: `/props` answering while
   `/slots` and `/metrics` time out means the queue is wedged and inference is
   down, and it names the recovery. `/stack slots` sends no client-side timeout,
   because interrupting is the failure mode, and re-probes the queue afterwards.

### Observation is a tool; mutation is a command

`stack_status` is registered with `registerTool` so the model can check
throughput and KV usage before blaming itself for slow output. Every mutating
path is `registerCommand`, which pi exposes only to the user. The model should
be able to see that prefill collapsed; it should not be able to restart llama
mid-task.

### Router mode, still deferred

`/models/load` and `/models/unload` answer 200 even now, and pi's built-in
`/llama` UI would give model swapping and Hugging Face search — but only when
llama-server starts **without** `-m`. That changes what happens at boot (nothing
loaded, so forge's first request fails until a model is), which is a change to
`up.sh` and the smoke test. Left alone deliberately while two models are being
evaluated on this stack.

## 2026-08-13 — Fable-Fusion tested and rejected, and two holes it exposed

`DavidAU/Qwen3.6-27B-Fable-Fusion-711-Uncensored-Heretic-NM-DAU-NEO-MAX-MTP-GGUF`
→ `…-IQ4_XS.gguf`, 17,033,682,400 bytes (byte-exact against the `x-linked-size`
header). Tested against the committed 0.913 / 27-27 baseline and **not adopted**.
The stack is back on `unsloth/Qwen3.6-27B-MTP-GGUF`.

### It loads, and the ablation did not break tool calling

Cold load 9 minutes — faster than the incumbent's 20, because the file is
smaller and nothing was competing for I/O. MTP/speculative active, n_ctx 32768,
IQ4_XS 4.25 bpw, tool-call caps advertised, chat template 7764 chars (vs 8057).

Smoke: **11/11, including `get_weather({'city': 'Paris'})`**. That was the real
gate — nothing in the model card said the abliteration preserved tool calling,
and it did.

### The eval cannot tell the two models apart

Overall 0.913, 27/27 — and **all 27 individual test scores identical to the
baseline**, including every partial (0.6, 0.75, 0.5, 0.7). Not a stuck harness:
the responses genuinely differed (`'NeutronStar'` vs `'The project name is
NeutronStar.'`; one answer 1527 → 214 chars). The rubrics are simply too coarse
to separate two models of this calibre.

Treat that as a statement about the eval, not a finding about the models. It is
the second time this suite has been shown blind to something that mattered — the
first was the 65x prefill regression it scored 0.47 before and after.

### Speed: measured properly, Fable-Fusion is slower

The eval's speed suite said Fable was *faster* (decode 69.2 → 81.0 tok/s). It is
one sample per model, and MTP draft acceptance is strongly content-dependent, so
that row cannot carry the decision. Five runs of an identical probe (3000-token
prompt, 256 generated, llama's own `timings`, per-run nonce):

| | prefill median | decode median | decode range |
| --- | --- | --- | --- |
| unsloth UD-Q4_K_XL | 915 tok/s | **51.2 tok/s** | 47.5 – 52.3 |
| Fable-Fusion IQ4_XS | 926 tok/s | **45.6 tok/s** | 45.3 – 49.5 |

Decode is ~11% slower with barely-overlapping ranges; prefill is a wash. (Both
prefill medians sit near 900 while the eval reports ~1700 on a 4030-token
prompt — prefill throughput climbs with prompt size, so the two are not
comparable. Only compare within a method.)

**Verdict:** no measured advantage, a real decode cost, and its one
distinguishing property — the decensoring — is not measured by anything in this
repo. Rejected. The 0.4 GB smaller file does not buy that back.

### Hole 1: eval provenance could not identify the weights

`config` recorded `MODEL_ALIAS`, which is deliberately held constant when
swapping GGUFs — so the two runs were indistinguishable in `history.jsonl` and
only a manually saved copy made the comparison possible. `eval.py` now records
`gguf`, read from llama's `/props` `model_path` rather than from `.env`, because
`.env` can already name a model the running container has not loaded.

### Hole 2: the tools image bakes the Python, and nothing rebuilt it

`Dockerfile.forge:46` COPYs `eval.py`, `smoke_test.py`, `eval_harness.py`,
`ab_think_lang.py` and `download_model.py` into the image; no service
bind-mounts `scripts/` over `/work/scripts`. `run-eval.sh` and `smoke-test.sh`
called `compose run` with no build, so **an edited suite silently scored with
the code from the last image build**. Found by editing `eval.py` and watching
`grep -c` return 0 inside the container.

Both runners now pass `--build`. A fully cached build is ~3 s against an eval
that takes minutes, and a committed score measured by unknown code is worth
nothing.

### Next candidate unchanged

`bottlecapai/ThinkingCap-Qwen3.6-27B-GGUF` remains the better prospect: 15.7 GB,
claims 50% fewer thinking tokens at equal accuracy with multi-seed CIs. Note in
advance that **this eval will probably not detect that either** — it runs with
`EVAL_THINKING=off` and scores no token-cost metric. Judging it needs the
thinking-token measurement the A/B harness already does, not this suite.

## 2026-08-13 — corrections found in a repo audit

### mmap: the 2026-08-01 entry above is superseded

"#### --no-mmap (REVERSED 2026-08-01)" concludes **"Do not use `--no-mmap` with
a single-file GGUF"**, measured at 20x slower generation in a *Docker volume*.
The stack has since run `--load-mode none`, which disables mmap, and that entry
was never updated — so the log argued against the flag the compose file uses.

Both are right about their own case, and the difference is where the GGUF lives:

- In a **Docker volume** (the 2026-08-01 measurement), mmap is much faster.
- On the **9p bind mount** this box actually uses (`MODELS_DIR=//d/llm-models`,
  a Docker Desktop Windows path), demand-paging the GGUF runs at roughly
  0.05 MB/s and the load never finishes. `--load-mode none` is mandatory here.

So the rule is not "mmap good" or "mmap bad", it is: **mmap is unusable across a
9p bind mount, and fine on a real volume.** Anyone moving `MODELS_DIR` onto a
volume should re-measure rather than inherit either conclusion.

### The eval's own README scorecard had been corrupted for weeks

`README.md` carried `how scoring wo<!-- eval-scorecard-start -->` — a sentence
truncated mid-word by a marker — and `<!-- eval-scorecard-end -->nd -->`. Present
since before 8c225e7. `gen-readme-scorecard.py` splices
`readme[:start] + section + readme[end+len(END):]`, which is correct only while
the markers are well formed: `find()` takes the first match and the tail is
copied verbatim, so damage survives every regeneration untouched. The generator
looked healthy while preserving the corruption. It now refuses unless there is
exactly one of each marker, start precedes end, and the text after the end
marker is not a marker fragment.

### .env comments must not assert the active mode

`.env` is rewritten by `scripts/mode.sh`, so a comment claiming a live state
goes stale on the next switch. The file shipped a block headed
"CURRENTLY SET FOR PROSE, NOT CODE" directly above `TEMPERATURE=0.6`. Comments
now describe the knob and point at `modes/*.env` for per-regime values; CI
rejects `^#.*currently set` and friends.

### forge corrupts a merge when message content is structured

`forge/clients/llamafile.py` merges two adjacent same-role messages with
`target["content"] + "\n\n" + m["content"]`, which assumes `str`. The OpenAI
schema also allows a **list** of content blocks, which pi sends, and the
expression then raises `TypeError: can only concatenate list (not "str") to
list` — returned to the client as an opaque 502.

Reproduced against the running proxy, with a control:

| request | result |
| --- | --- |
| 2x user, string content | 200 |
| 2x user, **list** content | **502** `can only concatenate list …` |
| 1x user, list content | 200 |

Present in **0.8.2 and 0.9.0**, so upgrading is not the fix. It is reached
whenever two same-role messages end up adjacent — most easily by asking
something while llama is still loading (503), then retyping. In other words the
first thing anyone does after a restart.

Patched at image build time by `patches/forge_merge_consecutive.py`: the
`str + str` path stays byte-identical, and structured content is merged as
blocks so image parts are not silently dropped. The patcher verifies the exact
upstream source text and exits non-zero if it has changed, so a forge upgrade
fails the build instead of quietly shipping unpatched.

## Still open (carried forward from HANDOFF.md, which is now deleted)

Genuinely unresolved, each with the thing that would settle it:

- **`THINK_LANG=zh` has never been measured on this hardware.** It is on in
  `coding` mode on a community claim from an HN thread, not a local result.
  `./scripts/ab-think-lang.sh --repeat 3 --save` settles it; a non-zero exit
  means set it `off`.
- **`SPEC_DRAFT_N_MAX=2` was adopted from a public rig, not measured here — and
  the rig was running 3.6.** 3.8 has a different draft head; public 3.8 reports
  on a 4090 run 4-5 with 47%/28% acceptance at the 4th/5th drafted token, and
  the prose model's card puts llama.cpp's own default at 3. `bench.py` now
  reports `draft_n` / `draft_n_accepted`, so `./scripts/bench.sh --repeat 3` at
  a couple of values settles it.
- **`reasoning_effort` cannot be set per request on this build.** llama.cpp
  gained API-field forwarding in `7e4c0a9` (2026-08-14); the newest published
  CUDA server image is `server-cuda-b10423`, cut a day earlier. Until an image
  ships with it, `REASONING_EFFORT` is server-wide and pi's
  `supportsReasoningEffort` stays false. `./scripts/update.sh` is the way to
  move the pin, and it rolls back if the smoke test fails.
- **The prose model's MTP acceptance is unknown and may be worse.** Its draft
  head was trained against the unmodified weights and the main stack was then
  abliterated, so acceptance can fall — a decode-speed cost only, since every
  drafted token is still verified. `./scripts/bench.sh` in `prose` mode against
  the same run in `coding` mode is the comparison.
- **`/stack slots save|restore` is shipped but unexercised**, deliberately —
  running a save is what wedged llama's task queue once already.
- **rtk's allow-list was measured on this repo, which is shell, Python and
  TypeScript.** The entries that carry it here are `git status`, `find` and
  `pytest`; the Rust and JS entries (`cargo *`, `jest`, `vitest`, `tsc`) were
  verified to rewrite but their savings have never been measured on a real
  project of that shape. `diff <(cmd) <(./scripts/rtk.sh cmd)` in such a repo
  settles it, and would likely justify widening the list — `ls -la` at 69% is
  already a saving being left on the table because `ls -1` regresses.

## 2026-08-13 — an unattended loop, and which package to trust with it

Requirement: `/loop read @PLAN.md and implement` — keep iterating, survive
compaction, continue the same run. Adopted **`pi-loop-mode@2.5.4`**, pinned in
`.env` as `PI_LOOP_MODE_VERSION`, installed to pi's user settings.

### Why not pi-agent-loop, the package that prompted this

It works — `/loop` and `/loop-stop` register, and the source is clean. But it is
three files with no context handling at all, and its peer dependency names the
**old** pi package (`@mariozechner/pi-coding-agent`, versus our
`@earendil-works/…`). npm installs that peer alongside and pi resolves it, so it
loads; that was checked rather than assumed after the peer name suggested it
would not.

It is the wrong tool for the requirement all the same: nothing in it persists a
loop across compaction, which is the part that matters at `CTX_SIZE=32768`.

### What the catalog actually offers

`pi.dev/packages?name=loop` returns 140 matches; the top 50 by downloads are
mostly near-duplicates (goal loops, "ralph" loops, `/afk` loops). Sorting by
downloads is not the useful filter. The useful ones were:

- Does it target `@earendil-works/*` (our pi)?
- Does loop state survive compaction?
- Does completion depend on the model's own claim?

That last one matters disproportionately with a 27B: a small model asserting
"done" is not evidence.

### Why pi-loop-mode

- **Compaction survival.** State persists via `pi.appendEntry()` as session
  entries and is restored from `ctx.sessionManager.getBranch()`. On context
  pressure it builds a summary locally from loop state and touched files rather
  than issuing another model call — the right design here, since a
  summarization request against a saturated context is precisely what fails
  under `--no-context-shift`.
- **Built for weak models**: repetition/near-duplicate detection, a
  degenerate-output kill switch, an escalation ladder of recovery strategies.
- **Objective done-ness**: `--check "CMD"` trusts an exit code, not a claim.

### Verified, not assumed

Scratch project, a `PLAN.md` asking for `calc.py` + `test_calc.py`, run as
`/loop start read @PLAN.md and implement it --max 2` against Qwen3.6-27B through
forge. Result: both files written, `__pycache__` showing the tests were actually
executed, `IMPROVEMENTS.md` backlog created, loop log recording `done` then
`max_reached`. `python3 test_calc.py` exits 0 — the plan's own criterion.

### Security review, because these run with full system access

pi's own docs say to review before installing. Both candidates: **no**
install-time lifecycle scripts (`preinstall`/`postinstall`/`prepare`), no
network calls, no filesystem writes outside pi's API, no `eval`, no base64
decoding, no `process.env` reads. `pi-loop-mode`'s single `child_process` use is
`pi.exec("bash", ["-lc", state.checkCommand])` — the `--check` command the
operator supplies. Nothing persisted from the trial runs: `pi -e npm:<pkg>`
installs to a temp directory for that run only, and `pi list` was empty
afterwards.

Both were run before the second one was reviewed, which was the wrong order.
Review first — the pin exists so an upgrade is a deliberate act with a re-review
attached.

## 2026-08-13 — the loop stopped on someone else's success, so /loop is now a fork

`vendor/pi-loop-mode` is a fork of `pi-loop-mode@2.5.4`, loaded from this
checkout by `scripts/pi-local.sh`. The npm install it replaces is gone
(`pi uninstall npm:pi-loop-mode`); the launcher warns if one comes back, because
two copies register two `/loop` commands over one session's state.

### The failure

A real unattended run on the 32k model:

```
Error: "Backend returned 400"
[compaction] Compacted from 33,719 tokens
Error: Compaction failed: Already compacted
Error: Emergency context compaction failed: Already compacted.
Loop paused — context recovery required
```

The context overflowed, **the recovery worked**, and the loop stopped anyway,
waiting for a human to type `/compact` and `/loop resume` — the one thing an
unattended loop cannot ask for. The instinct to read this as "the context is
broken" is what makes it expensive: nothing was broken, and 33,719 tokens had
already been compacted away by the time the error was printed.

### The cause, read out of pi's source rather than inferred

pi runs its own overflow recovery in `_handlePostAgentRun()`, which sits
**between** the `agent_end` extension event and the end of the run:

```js
// core/agent-session.js
async _runAgentPrompt(messages) {
  await this.agent.prompt(messages);              // emits agent_end
  while (await this._handlePostAgentRun()) {      // _checkCompaction() -> auto-compaction (+1 retry)
    await this.agent.continue();
  }
  ... finally { await this._emitAgentSettled(); } // agent_settled
}
```

Upstream compacts from `agent_end`, so both compactions are in flight at once.
pi's lands first and appends a compaction entry, and `prepareCompaction()`
refuses a branch that ends in one:

```js
if (pathEntries[pathEntries.length - 1].type === "compaction") return undefined;  // -> "Already compacted"
```

Upstream's `onError` treats every compaction error as terminal, so the loser of
that race paused the run. pi's own auto-compaction path is already guarded
against the mirror case (`assistantIsFromBeforeCompaction`) — the missing guard
was only ever on the extension side.

### What the fork changes

Full list in `vendor/pi-loop-mode/FORK.md`. The shape of it:

- Compaction moves from `agent_end` to `agent_settled`, which is documented as
  "no retry, compaction, or queued continuation left to run" — there is nothing
  left to race there.
- `session_compact` adopts pi's recovery as the loop's own. When pi says it will
  re-run the turn itself, the loop does not send a second one — behind a
  watchdog that resumes anyway if that retry never arrives, since an unattended
  loop must not hang on another component's promise.
- `Already compacted` / `Nothing to compact` mean "no work to do", not "failed".
- The branch is read before a compaction is requested, so the loop never asks pi
  for something pi's own guard will refuse.
- The circuit breaker cools down (60s, 120s, 240s) and retries with a
  progressively tighter summary (24k -> 8k -> 3k chars) instead of stopping. A
  pause is still the last rung, for a context that genuinely cannot shrink.
- Overflow compactions are built locally. pi summarizes with the LLM, and after
  an overflow that is the same LLM that just refused this context — the request
  least likely to succeed exactly when it is needed. Threshold compactions still
  get pi's better model summary; they have room to spare.

### Fork rather than patch, and vendor rather than install

The changes are edits to the package's own source. As an npm install they would
be replaced by the next `pi update`, and a patch applied over an install would
go with it — silently, since a `/loop` that has quietly reverted still starts.
The extension needs no `node_modules`: its only non-relative import is an
`import type` of pi's types, erased before the file runs.

Upstream is AGPL-3.0-only; `LICENSE` is vendored unchanged and `FORK.md`
records the provenance and the delta.

### Verified, not assumed

`cd vendor/pi-loop-mode && npm test` — 23 tests driving the extension's real
handlers through the failure above: pi winning the race, pi promising a retry,
a branch that already ends in a compaction, a genuine summarization failure, the
full cooldown ladder, and a completed turn retiring it. Loading was checked
against controls, since "no output" is what both success and a silently unloaded
extension look like: a bad `-e` path errors loudly, and without the extension
`/loop status` is forwarded to the model, which answers by explaining it has no
such command.

## 2026-08-14 — Matrix in, and what a 27B model does with a reply tool

`vendor/prinny-channel` puts a pi session on Matrix: a message from an
allowlisted sender becomes a turn, and the answer goes back to the room. It is a
conversion of `prinny-channel`, which is a **Claude Code plugin** — an MCP
server the harness launches, plus two skills. `FORK.md` in that directory is the
full account; this records the decisions worth arguing about.

### The Matrix half was not touched; the Claude Code half does not exist in pi

Three things the plugin relied on have no counterpart here: a plugin system, a
channel protocol (`notifications/claude/channel`, which Claude Code renders as a
`<channel>` block), and a permission prompt for the channel to relay. So the
sidecar — login, crypto, pairing, allowlist, history, the outbox — was vendored
essentially as-is, with four small edits (state directory, the bootstrap's
checkout search, the now-unread MCP `instructions`, and user-visible wording),
and everything above it was rewritten.

Keeping the sidecar's MCP surface **exactly** as upstream, method names
included, is what keeps `server/src/server.ts` diffable against the upstream
repo. The extension is the MCP *client* now.

### The Matrix layer runs as a child process

Not a preference. `@prinny/bot` pulls in matrix-js-sdk and its Rust crypto WASM,
and loading it is ~15 seconds of **synchronous** work — in-process, that is pi's
TUI frozen at startup. The same library writes to stdout while it loads, and in
pi stdout and stderr *are* the TUI, so a stray line scribbles over the
interface. Out of process both become the child's file descriptors: stdout is a
pipe carrying JSON-RPC, stderr goes to `<state-dir>/channel.log`.

Same reasoning keeps the extension itself silent on the terminal. Everything it
has to say goes to that log, with only state changes promoted to
`ctx.ui.notify`.

### The MCP client is hand-written, and that was the cheaper option

`@modelcontextprotocol/sdk` is a dependency, and a dependency under `vendor/`
means a `node_modules` tree there — the thing the sidecar's own bootstrap exists
to avoid. pi resolves an extension's bare imports against its own module root,
which carries `typebox` and pi's packages but not the MCP SDK, so the SDK could
only be reached by deep-importing the staged runtime's copy by a path into
another package's build output that no semver range protects. MCP over stdio is
newline-delimited JSON-RPC; the subset used here is four methods of a stable
protocol. It is written out, and tested against a child process that can be told
to split messages mid-JSON, print prose onto the transport, go silent, or die.

### Answers are forwarded, not requested — this is the local-model decision

Upstream made the `reply` tool the only way out, and said so in capital letters
in the tool description. That holds at frontier scale. **At 27B it does not**:
the model writes a perfectly good answer into the transcript and never calls the
tool. The failure is silent in the worst way — the operator sees a complete
answer in the TUI, and the person on Matrix sees nothing at all, so the bug
presents as "your bot ignores me" rather than as anything in a log.

So the extension forwards the assistant's text itself (`forward=result` by
default; `all` sends each message as it completes; `off` restores upstream's
behaviour). `prinny_reply` stays for what forwarding cannot do — attachments,
quote-replies, a second message — and text sent both ways is deduplicated on
normalised content, because a model that both writes an answer *and* calls the
tool with it is the common case here, not an edge one.

Two constraints on what gets forwarded:

- **Only `type: "text"` content**, by allowlist. An assistant message mixes
  text, `thinking` and `toolCall` blocks. Excluding the latter two by name would
  forward whatever kind pi adds next — for a reasoning model, precisely the
  content least suited to a stranger's phone.
- **Never when more than one room is waiting.** The answer cannot be attributed
  to one of them, and guessing sends one person's conversation to another.

### Access management is code, not a skill

Upstream's `/prinny:access` was a Markdown skill instructing the model to read
`access.json`, mutate it carefully, and write it back. Reasonable for a frontier
model; a liability here. A dropped key or a re-serialised `pending` block is a
silently broken allowlist, and that allowlist is what stands between a publicly
addressable Matrix ID and this machine's shell. It is now `/prinny`, with
read-modify-write on every mutation and no pairing ever approved without its
code. The skills remain — rewritten to say which command to run.

### The permission gate fails closed, and is off by default

pi raises no approval prompts, so there is nothing to relay; the extension has
to be the thing that asks. Default `off`, because adding friction pi does not
otherwise have would be a surprise rather than a feature. When on, an
unreachable channel **blocks** — enabling it is a statement that these calls
should not happen unwatched, and "the approver was unreachable" is not "the
approver said yes".

### Settings live in their own file

`access.json` already has a writer: the sidecar rewrites it whenever the gate
mints or prunes a pairing, and its `readAccessFile()` rebuilds the object from a
fixed list of known keys. Anything it does not know about is dropped — so pi
settings kept there would vanish the first time a stranger messaged the bot,
which is the worst possible moment to lose the delivery configuration.

### Off by default in `.env`

`PRINNY_ENABLED=0`. This is the only component in the stack that logs into a
remote service and makes the session addressable from the internet. `0` leaves
the extension out of the session entirely rather than loading it dormant, so
there is nothing to misconfigure until it is asked for.

### Verified, not assumed

`cd vendor/prinny-channel && npm test` — 227 tests. Upstream's suite ported from
vitest onto `node:test` (via a matcher shim, so 900 lines of assertions were not
retyped) and run against the **compiled** sidecar, which is the artifact that
actually ships. The pi side is tested directly. And the extension is tested
inside a real `pi --mode json` process against a stand-in sidecar, because a
wrong notification method name fails as "messages never arrive" and as nothing
else.

Four things were checked rather than believed, each having been a plausible
assumption:

- `typebox`, `@earendil-works/pi-ai` and `@earendil-works/pi-tui` **do** resolve
  from an extension loaded by absolute path outside pi's tree. The docs say so;
  the vendoring depends on it, so it was run.
- `pi.sendUserMessage()` from a timer **does** inject a real user message and
  drive a turn — confirmed in the JSON event stream, not inferred from the type
  signature.
- Node does **not** rewrite a `.js` specifier to a `.ts` file, so the sidecar's
  sources cannot be imported directly by the tests. Checked with a control.
- `constructor(private readonly x: T)` is TypeScript that emits code, and Node's
  strip-only type stripping rejects it outright. pi's loader copes, so this
  would have run under pi and broken only under `node --test` — a split where
  the tests look like the broken thing.

### Two hazards worth carrying forward

- **One Matrix account per channel.** Two bots on one account duplicate every
  delivery and fight over the crypto store, ending with a bot that cannot
  decrypt its own rooms. Separate state directories are not enough; the
  homeserver cares about the account.
- **The sidecar is not auto-restarted on exit.** It retries the homeserver
  forever by itself, so an exit means something a restart loop cannot fix — bad
  credentials, a broken build, a killed process. `/prinny start` is the retry.

### Forwarding needed a rule about *when*, not just *what*

Found while writing the test for it, not before. Forwarding was keyed on "this
room has an unanswered message", which is set the moment the message arrives —
and a Matrix message can arrive while pi is mid-turn on something the operator
typed in the terminal. That turn's answer, about the operator's own private
work, would then be forwarded to whoever had just messaged. Nothing on this side
would show it happening.

Eligibility is now tied to evidence: the room becomes answerable only when pi
emits its `<channel>` block as a user message, which is pi saying it has read
it. The match reads **only the opening tag**, anchored to the start — the body
is a stranger's text, and a plain substring search over the whole message let
someone write `message_id="$somebody-elses"` into a Matrix message and redirect
another room's answer to themselves. Both spoofing attempts are in
`tests/forwarding.test.ts`; the second one failed on first run, which is why the
match is anchored.

---

## 2026-08-15 — Qwen3.8-27B, and deleting the eval harness

Qwen3.8-27B released roughly ten hours before this entry. The stack moved to it
the same day. Two things happened at once and it is worth keeping them apart:
the model swap, which was small, and the removal of the scored eval harness,
which was a deliberate deletion rather than a casualty of the swap.

### The migration was cheap because nothing structural changed

Read out of the GGUF header before anything was downloaded, by HTTP range
request against the file on the Hub rather than by trusting a model card:

```
general.architecture        = qwen35        <- identical to 3.5 / 3.6
qwen35.block_count          = 65            <- 64 layers + 1 MTP block
qwen35.nextn_predict_layers = 1
blk.64.nextn.{eh_proj,enorm,hnorm,shared_head_norm}
qwen35.context_length       = 262144
qwen35.full_attention_interval = 4
general.sampling.{temp,top_k,top_p} = 1.0, 20, 0.95
```

Consequences, in order of how much work each saved:

- **The pinned llama.cpp build loads it unchanged.** The architecture string is
  still `qwen35`, so `server-cuda-b10200` needs no bump for the model itself.
- **MTP ships in the mainline quant.** On 3.6 this stack pulled
  `unsloth/Qwen3.6-27B-MTP-GGUF`, a separate repo. There is no
  `Qwen3.8-27B-MTP-GGUF` and there does not need to be — `block_count=65` and
  the `blk.64.nextn.*` tensors are in `unsloth/Qwen3.8-27B-GGUF` itself.
- **VRAM planning carried over untouched.** `UD-Q4_K_XL` is 17.92 GB against
  3.6's 17.91 GB, and the hybrid attention layout is unchanged (16 full-attention
  layers of 64, 4 KV heads, 256-wide K/V), so the quant table in `README.md` and
  `CTX_SIZE=32768` both still hold without re-deriving them.

### Three things did change

**Temperature.** 3.6 published two thinking presets — 1.0 general, 0.6 "precise
coding" — and `coding` mode ran the 0.6. The 3.8 card publishes one, and it is
1.0; the GGUF stamps `general.sampling.temp=1.0` as well. Both modes are now
1.0. This is why the old scorecard could not simply be carried forward: it
described a temperature the stack no longer runs.

**`reasoning_effort`, which is new and defaults badly for this box.** Values,
read out of the template embedded in the GGUF rather than from a write-up:
`xhigh` | `high` | `medium` | `low`, with `high` silently rewritten to `xhigh`,
`medium` the only level that injects nothing into the system prompt, and
anything else — including the `none` that circulates in release-day summaries —
hitting `raise_exception()` and failing the request. Upstream's default is
`xhigh`, which prepends a "think carefully, validate key assumptions, consider
plausible alternatives" instruction, and the release-day reports are 20-90
minute answers and 22-36k thinking tokens for one SVG. Against
`REASONING_BUDGET=4096` that is not slowness, it is a truncation on every turn.
`REASONING_EFFORT=medium` is the stack default, passed via
`--chat-template-kwargs`.

**The prose model had to be replaced outright.** There is no 3.8 Fable-Fusion.
DavidAU had published one 3.8 model at migration time, no GGUF, zero downloads,
so the entire Fable-Fusion card — `temp <= 1` on MTP quants, the rep-pen ban,
the `smoothing_factor` request that DRY was substituted for — describes nothing
on disk any more and was removed rather than transplanted.
`JonathanColetti/Qwen3.8-27B-Uncensored-GGUF` replaces it, chosen on published
measurements: Heretic at bf16, 98/100 -> 12/100 refusals at KL 0.1191, mean
0-shot capability delta -0.5 across MMLU/ARC-C/HellaSwag/Winogrande. Its MTP
head is grafted back from base after abliteration and verified per file, which
matters more than it sounds: abliteration re-saves through transformers, which
drops the MTP block while `config.json` still advertises it, so most decensored
3.8 GGUFs are 64 blocks and cannot speculate at all. Confirmed here from the
header before selection — 65 blocks, 866 tensors, `blk.64.nextn.*` present.

### A checked assumption that turned out fine, recorded because the check was cheap

The community fixed-template repo (`froggeric/Qwen-Fixed-Chat-Templates` v22)
warns that the official 3.8 template throws a fatal exception on
`enable_thinking=false` and on JSON-string tool arguments. Both would matter
here. Neither applies: the template embedded in the **unsloth** GGUF is already
patched ("Unsloth fixes - developer role, merged system messages, tool calling")
and emits the empty `<think></think>` prefill for `enable_thinking=false`
exactly as 3.6 did. The stock template stays; no vendored jinja file was added.

Both claims were tested rather than read: the template was extracted from the
GGUF and rendered in a throwaway container against every input that matters.

```
reasoning_effort=xhigh   -> "Reasoning effort is set to xhigh. Please think carefully..."
reasoning_effort=high    -> identical xhigh steering (silently rewritten)
reasoning_effort=medium  -> no steering sentence at all
reasoning_effort=low     -> "Reasoning effort is set to low. Keep your thinking brief..."
reasoning_effort=none    -> RAISED "Unexpected reasoning effort none."
reasoning_effort=""      -> RAISED (so never leave the .env key empty)
no kwarg at all          -> xhigh steering
enable_thinking=False    -> "<|im_start|>assistant\n<think>\n\n</think>\n\n", no raise
tool_call.arguments as a JSON string -> RAISED
tool_call.arguments as an object     -> renders fine
```

That last pair is the one that would have broken the agent loop, since an
OpenAI-wire client sends `arguments` as a string. It does not, and the reason is
in llama.cpp rather than in the template: `common/chat.cpp` at b10200 checks
`tmpl.original_caps().supports_object_arguments` and, when the template wants
objects, runs `workaround::func_args_not_string()` over the messages —
`json::parse` on every string `arguments` — *before* rendering. Read in the
pinned build's source, not inferred from behaviour. Re-check it if tool calls
start failing after a llama.cpp bump; that is the code that would have moved.

### Why the eval harness was deleted rather than re-run

`eval.py`, `eval_harness.py`, `run-eval.sh`, `gen-readme-scorecard.py`,
`results/`, the eval badges, `eval-methodology.md` and the Harbor adapter are
gone. The migration is what forced the decision — every number in the scorecard
was measured on a different model at a different temperature with thinking off,
so the choice was to re-run it or to stop keeping it — but the reasons are
older than the migration:

- **It scored the path nobody runs.** `EVAL_THINKING=off` was the committed
  default, so every published number described the model with reasoning
  disabled, while a real pi session runs with thinking on under
  `REASONING_BUDGET`. The scorecard in the README was not a measurement of this
  stack.
- **Individual rows were noise.** `edits/mixed_tabs` scored 1.00, 0.50 and 0.00
  across three runs of the same build. A number that moves that much between
  identical runs cannot support the conclusions a README badge invites.
- **A single aggregate score invites exactly the comparison it cannot support.**
  0.913 against what? Not against another model on the same harness, not against
  a public benchmark. It measured this harness against itself.

What survives is what answers a question someone actually asks: does it work
(`smoke-test.sh`), how fast is it (`bench.sh`), and is `THINK_LANG` earning its
place (`ab-think-lang.sh`). CI now fails if `eval.py` reappears, in the same
guard that keeps Claude Code support from creeping back.

### bench.sh had to be fixed on the way out

Deleting the eval suite promoted `bench.sh` to the only throughput measurement
in the repo — and it was the broken kind. It divided token counts by end-to-end
wall clock through the proxy, and sent a fixed prompt that `--cache-prompt`
serves out of the prefix cache on every run after the first. That is the same
mistake the 2026-08-12 entry above records paying for: the version it replaced
scored 0.47 before and after a fix that made prefill ~65x faster.

`bench.py` now runs inside the compose network like the smoke test, reads
`timings.prompt_per_second` / `timings.predicted_per_second` from llama directly
(forge strips that block), puts a unique nonce at the **front** of every prompt
where a prefix cache will actually see it, and prints any run with a non-zero
`timings.cache_n` as `CACHED (excluded)` instead of counting it. It also reports
`draft_n` / `draft_n_accepted`, which is what `SPEC_DRAFT_N_MAX` should be tuned
against — the committed `2` is a 3.6 number for a draft head 3.8 does not have.

### The same day: forge 0.8.2 -> 0.9.0, pi 0.84.1 -> 0.84.2, llama.cpp left alone

Three components, three different answers, and the interesting part is why they
differ.

**forge 0.9.0 — taken, and it was not a version bump.** The changelog's breaking
changes land squarely on the Proxy, which is the only part of forge this stack
uses. Verified against a running 0.9.0 in a throwaway container before touching
the compose file, because the migration doc and the actual argument parser are
two different sources:

```
$ python -m forge.proxy --backend-url ... --backend-capability native \
      --budget-mode manual --budget-tokens 32768 ...
__main__.py: error: unmanaged backends do not accept budget_mode
```

An externally managed backend — anything reached with `--backend-url`, which is
this stack — is "unmanaged", and 0.9 rejects `budget_mode` for unmanaged
backends outright. The proxy would not have started at all. `--budget-mode
manual` is gone from `docker-compose.yml`; `--budget-tokens ${CTX_SIZE}` stays
and is now a reporting denominator only.

Losing forge-side budget management costs nothing here. pi does its own context
management, `PI_MAX_TOKENS` (8192) sits well under `CTX_SIZE` (32768), and
`--no-context-shift` means an overflow fails loudly rather than silently sliding
the window. forge was never the thing keeping the conversation inside the
window.

The second break is quieter and would have looked like a broken stack:

```
/forge/health -> 200 {"status":"ok"}     (with the backend unreachable)
/health       -> 502 {"error": ...}      (forwarded backend readiness)
/v1/models    -> 502                     (forwarded, no synthesized catalog)
/forge/usage  -> 204
```

`/health` is now the *backend's* readiness. Probing it as a container
healthcheck would have marked forge unhealthy for the entire ~24 minute cold
load of a model that was loading perfectly normally — a self-inflicted
"forge is down" every single restart. The compose healthcheck, `smoke_test.py`
and the `/stack` probe all moved to `/forge/health`. Note the consequence for
reading `/stack`: a red forge line now means forge itself is gone, where before
it could also mean the model was still loading.

`patches/forge_merge_consecutive.py` still applies cleanly at 0.9.0 — the
structured-content merge bug is unfixed upstream, and the patch fails the image
build loudly if that source line ever moves. Confirmed by building the image at
`FORGE_VERSION=0.9.0` before committing to the bump.

**pi 0.84.1 -> 0.84.2 — taken, and it is uneventful.** Nothing in the release
touches local OpenAI-compatible providers, llama.cpp, or reasoning control. Its
only Qwen3.8 content is cloud: the Qwen Token Plan model list swapped
`qwen3.8-max-preview` for `qwen3.8-max`. `PI_AUTO_UPDATE=1` would have picked it
up within 24h regardless.

Also checked and deliberately unchanged: `pi-loop-mode` upstream is still 2.5.4,
so the vendored fork's base has not moved; `mcp2cli` is still 3.3.1 and still
declares an unbounded `mcp>=1.0` while the MCP SDK is now 2.0.0 — so
`MCP_SDK_VERSION=1.29.0` remains load-bearing exactly as documented, and the CI
guard that enforces `1.*` still earns its place.

**llama.cpp — NOT bumped, on purpose.** `b10200` stays pinned. The reasoning:

- Nothing between `b10200` and the newest published CUDA image is
  Qwen3.8-specific. `git compare b10200...b10423` touches no `src/models/qwen35*`
  file at all; the qwen35 commits that matter (`use post-norm hidden state for
  MTP`, the delta-net graph dedups) all predate the pin. The architecture string
  is still `qwen35`, so 3.8 is not a new model to this engine.
- The one commit worth having, `7e4c0a9` "chat: pass reasoning_effort to
  template" (2026-08-14), **is not in any published CUDA image**. Probed the
  ghcr manifests directly: `server-cuda-b10423` (cut 2026-08-13T18:40Z) exists,
  and every tag from `b10424` to `b10437` returns 404. Bumping buys nothing on
  the one axis where 3.8 changed.
- A model swap and a forge major in the same change is already enough. Adding an
  engine bump means a failure cannot be attributed to any of the three.

`./scripts/update.sh` is the way to move it once this is verified — it bumps,
rebuilds, smoke-tests, and restores the previous pins if the smoke test fails.

Two things that bench.py depends on were checked in the pinned build's source
rather than assumed: `tools/server/server-task.cpp` emits `cache_n` and
`predicted_per_second` unconditionally and `draft_n` / `draft_n_accepted`
whenever `draft_n > 0`, and `to_json_oaicompat_chat()` attaches the whole
`timings` block to non-streaming `/v1/chat/completions` responses. So the
nonce-and-timings benchmark works on b10200 as written.

## 2026-08-16 — rtk, and three findings that did not survive contact with the binary

[rtk](https://github.com/rtk-ai/rtk) filters a command's output before the client
reads it. Adopted at `0.45.0`, pinned, behind `RTK_ENABLED` (on), with the pi
extension vendored at `vendor/rtk-pi` and the binary managed by
`scripts/rtk.sh`.

The arithmetic is the same one that produced MCP-as-a-CLI: on a 32K window, bash
output is not billed, it is **rented**. Every byte of pytest chatter is a byte
that is not the file the model was asked to read. rtk's own README hedges that
its savings dilute into input tokens and then into a bill — a caveat that does
not apply here, where the bill is electricity and the window is the constraint.

### The measurements, which is the only part that decided anything

Measured in this repo, 2026-08-16, rtk 0.45.0, real command vs `rtk <command>`:

| command | raw | filtered | saved | allow-listed |
| --- | --- | --- | --- | --- |
| `git status` | 275 B | 49 B | 82% | yes |
| `pytest -q` (43 tests, 3 failing) | 1312 B | 476 B | 64% | yes |
| `find vendor -name '*.ts'` | 1718 B | 773 B | 55% | yes |
| `ls -la` | 1125 B | 348 B | 69% | no |
| `git diff HEAD~1` | 2384 B | 2213 B | 7% | yes |
| `git log --oneline -20` | 1570 B | 1570 B | 0% | yes |
| `grep -rn env_get scripts` | 3286 B | 3286 B | 0% | no |
| `cat README.md` | 67652 B | 67652 B | 0% | no |
| `ls -1` | 123 B | 242 B | **-97%** | no |

The headline "up to 90%" is real and narrow. `git status`, `find` and the test
runners carry it; several advertised filters do nothing on a repo shaped like
this one, and one makes the output bigger.

### Three findings from the research pass that measurement overturned

Recorded because all three were written down confidently first, and each would
have produced a worse design if it had gone unchecked. This is the
"instrument before you build" rule paying for itself in a single afternoon.

- **"`rtk ls -1` miscounts — 19 entries in a directory holding 13."** WRONG. It
  agrees with `ls -1A` minus `.git`, and appends sizes. The 19-vs-13 was dotfiles.
  Upstream #3527 does not reproduce on 0.45.0. This had been the headline
  justification for the whole allow-list design.
- **"`cat` is rewritten to a lossy `rtk read` and will break the edit tool."**
  WRONG on the lossy half. `cat f` does become `rtk read f`, but the output was
  byte-identical at every size tried, up to 180 KB / 15,000 lines. `cat` is still
  denied — it saves 0%, so denying costs nothing, and rtk's README advertises
  "signatures and structure over full bodies", which makes today's losslessness
  undocumented rather than guaranteed.
- **"rtk writes its advisory banner to stdout, so upstream's extension splices
  `[rtk] /!\ No hook installed` into the command."** WRONG, and this one was
  self-inflicted: the first probe used `2>&1`. Re-run with the streams separated
  and the rate-limit stamp (`~/.local/share/rtk/.hook_warn_last`) deleted first,
  the advisory is on **stderr** every time. There is no upstream bug and none was
  filed. `extractRewrite()` still validates what comes back, now documented as
  defence in depth rather than as a fix.

What *did* survive: rtk's filters are mostly faithful. `find` returned the same
38-file set, `grep -rl` the same paths. The allow-list is narrow because most
filters **save nothing here**, not because most of them lie.

### The two real defects, and why the default is inverted

Upstream's pi extension hands every bash command to `rtk rewrite` and applies
whatever comes back. `vendor/rtk-pi` filters 23 commands and passes the rest
through, because some rewrites substitute a *different command*:

- `npm run lint` -> `rtk lint`. The indirection is discarded, so whatever the
  package's lint script actually is — flags, target, `--max-warnings 0` — is
  replaced by a bare eslint. Upstream #3543.
- `uv run pytest` -> `uv run rtk pytest`, resolving a pytest outside the venv.
  Upstream #3565.

Both are silent, and a 27B model at `REASONING_EFFORT=medium` cannot smell
either. Anything carrying a pipe, redirect, compound operator or a `VAR=`/`sudo`/
`uv`/`npx` prefix is refused outright rather than tracked case by case — a pipe
means a parser downstream, where shorter is simply wrong.

Also found: `npm test` and `cargo nextest` (bare or `run`) are in rtk's coverage
table with **no filter behind them** on 0.45.0, and bare `ruff` likewise — only
`ruff check`/`ruff format` match. All three were on the allow-list until
`--check` said otherwise. `cargo nextest` is upstream #2046.

### Fork rather than `rtk init --agent pi`, and vendor rather than install

`rtk init --agent pi` writes `.pi/extensions/rtk.ts` into whichever project pi
was started in — which is *your* project, not this checkout. Every other
extension here is loaded by absolute path for exactly that reason. The same
argument as `pi-loop-mode` and `prinny-channel`: the changes are edits to the
package's own logic, so an install would be replaced by the next update.

The gate lives in `src/gate.ts` with no pi import, so it is testable with bare
node; `extensions/index.ts` is the pi coupling and holds no decisions.

### The `--check` gate is the successor to the measurements above

Every number in this entry decays the moment upstream ships a filter change, and
rtk shipped 45 minor versions in seven months. `./scripts/rtk.sh --check`
re-runs them against the installed binary: every allow-listed command still
rewrites, `rtk read` is still byte-identical to `cat`, `rtk find` still returns
the same file set, and — the one that matters most — **a pytest collection error
still exits non-zero and still names what failed**. Upstream #2317 reports
filters masking hard failures behind benign summaries; it does not reproduce on
0.45.0, and pytest is only allow-listed because of that. A masked failure means
the model reports a green run and moves on, which is worse than no filtering.

`scripts/update.sh` runs `--check` in the same pass that smoke-tests the stack
and records the answer in `versions.lock` as `rtk_filters`. It is deliberately
**not** a rollback trigger: rtk failing means output stops being compressed, not
that the model or the proxy regressed.

### Verified, not assumed

- End to end in a real pi 0.84.2 session against the loaded model: the agent ran
  `git status` through the bash tool and it arrived as `rtk git status` — 42
  tokens saved on the call, 64.8% across the session.
- Missing binary, `RTK_ENABLED=0`, and a mismatched pin were each exercised
  rather than reasoned about. Without the binary the extension warns once and
  filters nothing, which is why the flag is safe to leave on in a fresh clone.
- The launcher costs **120 ms** for the rtk block. `pi-local.sh` takes ~50 s to
  reach launch either way; that is `pi list` and node startup, and predates this.
- `RTK_TELEMETRY_DISABLED=1` is exported by `pi-local.sh`, not only by
  `scripts/rtk.sh` — neither path that matters in a session goes through that
  script. The extension shells out to `rtk rewrite` itself, and the rewritten
  command runs in pi's bash tool; both inherit the launcher's environment.
  rtk's telemetry is opt-in and off by default upstream, so this makes it off
  because the checkout says so rather than because a default happens to agree.

## 2026-08-16 — the /loop context ceiling: hand off instead of compacting

The context-recovery fork (`vendor/pi-loop-mode/FORK.md`) fixed a loop that died
on an overflow. What it did not fix — because nobody had measured it — is a loop
that never overflows and gets nothing done anyway.

### The measurement, which is the only part that decided anything

Eight real sessions under `~/.pi/agent/sessions`, Qwen3.6/3.8 on a 32,768-token
window, plus pi 0.84.2's own `dist/core/compaction/compaction.js` driven directly
with synthetic entries. The largest session is 24 compactions long and contains
**zero** errors.

| turns | ctxTokens | %win | `shouldCompact` | `prepareCompaction` | kept after |
| --- | --- | --- | --- | --- | --- |
| 16 | 16000 | 49% | false | undefined (no-op) | - |
| 20 | 20000 | 61% | **true** | **undefined (no-op)** | - |
| 24 | 24000 | 73% | true | OK | 20000 |
| 32 | 32000 | 98% | true | OK | 20000 |

Three defects, all in the defaults rather than in the code:

1. `shouldCompact()` turns true at `contextWindow - reserveTokens` = 50% of this
   window, but `prepareCompaction()` returns `undefined` while the whole context
   is smaller than `keepRecentTokens` (20,000). From 50% to ~66% pi decides to
   compact **every turn and silently does nothing** — it returns before
   `compaction_start` is emitted, so there is no log, no error, no UI.
2. Every compaction keeps `keepRecentTokens` = 61% of this window. The floor
   after a compaction is higher than the level the model stops working at.
3. `reserveTokens` doubles as the summarizer's `maxTokens`
   (`min(0.8 * reserve, model.maxTokens)` = 8,192 here), and each summary is
   merged into the previous one. Observed growth in one session: 1,666 → 3,183 →
   5,891 → 9,411 → 11,054 chars. By the fourth compaction the session sat at
   94–96% full permanently and compaction freed nothing at all.

And the reason "94% full" is fatal rather than merely wasteful:

| context | empty assistant turns | turns with output |
| --- | --- | --- |
| below 87% of the window | 3 | 193 |
| at or above 87% | 33 | 30 |

An empty turn is `content: []`, `stopReason: "stop"`, one output token — a clean
success as far as pi is concerned, and a burnt iteration as far as the loop is
concerned. Above the cliff it is a coin flip; below it, 1.5%.

### The finding that changed the design

The loop's own guards make it worse. Entries 118–138 of that session: three empty
turns → `"no tool usage for 3 turns (narration only)"` → an 800-character *"You
are repeating yourself"* injection → two more empty turns → a 600-character
*"produce a tangible artifact"* injection → compaction → immediately a turn with
tool calls and 884 tokens of output.

The model was not fixated. It had no room. Every rung of the stuck ladder works
by adding prompt text, so the ladder was force-feeding the cause. A guard whose
remedy is the disease is worse than no guard, because it looks like it is
working.

### What was built

Ordered by leverage, not by novelty:

- **`pi-local.sh` sizes compaction from `CTX_SIZE`** into pi's global settings:
  `reserveTokens = min(16384, CTX//2)`, `keepRecentTokens = max(2000, min(20000,
  CTX*0.2))`. Free, no code, and on its own it removes the silent no-op window
  and drops the post-compaction floor from 20,000 tokens to 7,000. Global rather
  than `.pi/settings.json` because `/loop` runs in whatever project it is pointed
  at, and project settings are trust-gated.
- **Handoff instead of compaction on windows ≤ 64k** (`buildHandoffCompaction`,
  `findHandoffCutEntryId`): a summary bounded at 4,000 chars that is the same
  size on iteration 400 as on iteration 4, cut at the start of the last turn
  rather than at pi's 20,000-token tail, built with no model call. The two
  settings above cannot both be had from pi alone — `reserveTokens` controls the
  trigger *and* the summary size, so an early trigger forces a large summary.
- **An empty turn at ≥80% is context pressure, not stuck-ness** — one new clause
  in `isContextPressure()`, which routes it into the recovery machinery that was
  already there and already tested.
- **The stuck ladder skips its prompt rungs above 80%** and compacts directly.
- **The model is shown its own budget above 60%** via the `context` event, which
  pi clones (`structuredClone`) so it never touches the session. Appended last so
  llama.cpp's prefix cache is untouched: ~40 tokens/turn. Aimed below the cliff
  on purpose — a warning at 90% arrives where the model most often says nothing.

### Verified, not assumed

- The compaction numbers come from driving pi's real `prepareCompaction()` /
  `shouldCompact()`, not from reading them. The before/after table above is that
  probe's output.
- The empty-turn cliff is a count over 259 real assistant turns, with the control
  (turns *below* the threshold) counted in the same pass.
- `emitContext()` was read before relying on it: it does
  `structuredClone(messages)`, so a `context` handler cannot leak into history.
- `buildContextEntries()` was read before choosing a cut point: context is
  `[compaction summary] + entries from firstKeptEntryId onward`, and the id is
  extension-supplied and unvalidated. The handoff still only ever passes an id
  that exists in the branch — the "unmatched id keeps nothing" behaviour is real
  but is an implementation detail, and nothing here depends on it.
- `findHandoffCutEntryId()` was run against the real branches pi compacted at
  entries 48/102/109/135/143/150 of that session, not only against fixtures.
  Counting context-visible content only, pi kept 68,778–123,083 chars where the
  handoff keeps **374–6,133**. The 374-char case is the oversized-final-turn
  fallback firing on real data, which is what it exists for.
- The extension was loaded through **jiti**, the transpiler pi's own
  `core/extensions/loader.js` uses — not just through Node's `--experimental-
  strip-types` that the tests run under. It registers one `/loop` command and
  13 handlers, `context` among them exactly once.
- 39 tests pass (`cd vendor/pi-loop-mode && npm test`), including the empty turn
  at 92% versus the same turn at 30%, and the stuck verdict on a saturated
  context versus one with room to spare.
- **Not** verified: a live end-to-end `/loop` run against the model. The stack is
  up and llama-server answers (5.6 s for a 171-token task in its own log), but pi
  itself would not reach a first token inside 180 s in this container, and even
  `pi --help` hangs here. That is a pre-existing environment problem, unrelated
  to this change, and it is the one claim not backed by a measurement.

## 2026-08-16 — one slow session, taken apart: five real defects and a swapping box

A user pasted a `/loop`-less pi session that fetched Google News and asked what
could be optimised. The session looked mildly annoying — two `Error: terminated`,
two browser timeouts, then a curl fallback that worked. Every part of it turned
out to be a different defect, and none of them was the one the transcript
appeared to show.

### The browser was not slow; Chrome was dead

Reproduced first: `browser.sh navigate` hung past a 120 s kill. Then the control
that isolates it —

```
zendriver MCP  tools/list        -> 200 OK, instant
Chrome         /json/version     -> no answer in 20 s
```

— and the server log showing `ListToolsRequest -> 200 OK` followed by
`CallToolRequest` with no response line, ever. Chrome had been up since 07:56 and
the session was 08:13, so this was not cold-start latency. `browser.sh status`
had been reporting `Browser: Running  Open tabs: 1` the whole time, because it
asks zendriver, which answers from cache.

**A health check that cannot fail is not a health check.** The supervisor was
watching the half that had not broken. Fixes: `browser.sh health` probes Chrome's
CDP endpoint directly (ancestry-matched, so it cannot report another session's
browser as ours), `status` gained the same probe and a third exit code, and the
supervisor now restarts the server on two consecutive failed probes — without
calling `stop_browser` first, since that is a call into the process whose browser
is the thing not responding.

Verified by SIGSTOPping Chrome: `health` flips to `wedged`/exit 2, `status`
prints the fix, SIGCONT flips both back.

### The timeout message taught the model nothing

What it actually got, twice, 60 s apart:

```
Failed to call tool: Request timed out

Expected parameters:
  url (string) *required* - Absolute URL to load, including the scheme.
```

A parameter dump, for a failure that has nothing to do with parameters — so it
sent the identical call again. Two minutes and ~500 tokens for a page that was
never going to load. `.pi/extensions/browser-guard.ts` rewrites that result from
a live probe, naming which failure it is and telling the model to use `bash`
instead of retrying. `mcp/adapter.json` also sets `requestTimeoutMs: 30000`
(unset, the SDK default is 60 s), and `browser.sh up` now opens Chrome up front,
because a cold launch measured **74 s** — longer than a single call is allowed to
wait, so the first call failed while nothing was wrong.

### `Error: terminated` was a 300-second idle timeout, and the box was swapping

Exact, from the session file against forge's log:

```
08:17:38.596  user message        forge: POST /v1/chat/completions
08:22:39.887  error: terminated   (301 s)
08:27:42.447  error: terminated   (301 s)
08:29:01.078  first real answer
```

`DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300_000` in pi's `core/http-dispatcher.js`.
Prefill emits nothing while it runs, and llama's own log for that session says
`prompt eval time = 65218 ms / 1276 tokens` — **19.57 tok/s**, against the 1,175
tok/s this README quotes. The README already names the cause: `CACHE_RAM` was
once 8192 and "collapsed prefill to 2.83 tok/s once the host started swapping".
Confirmed live: 4.2 GiB of swap in use, load average 44, and PSI
`full avg10=59` — for 59% of the last ten seconds *every* task was stalled on
memory.

`pi-local.sh` now sets `httpIdleTimeoutMs` sized off `CTX_SIZE` at the degraded
prefill floor, clamped to [5 min, 15 min]. **That is a seatbelt, not a fix**, and
it is written down as one.

`/free` found nothing to reclaim, which is itself the finding: all 13 claude
sessions were live (idle 6–228 s), and all nine extra zendriver bridges had live
claude parents, so the PGID rule kept every one. The box is not leaking; it is
oversubscribed. Reclaimed: one 78 MB Chrome profile.

### forge was eating llama's prompt-cache counter

Matched control pair, identical request:

```
llama :8080  ->  "prompt_tokens_details": {"cached_tokens": 7}
forge :8081  ->  (absent)
```

`forge/proxy/convert.py` rebuilds the usage dict with three keys in four places,
and `clients/llamafile.py::_record_usage()` never reads `cached_tokens` even
though `TokenUsage.cache_read_input_tokens` exists for it. pi reads exactly that
field (`pi-ai/dist/api/openai-completions.js` maps it to `cacheRead`), so every
session on this stack reported `cacheRead: 0` and the footer's cache-hit
indicator could never appear — while llama's own log showed prefix reuse at
`f_sim_best 0.988`. The feature worked the whole time and nothing downstream
could see it. `patches/forge_cached_tokens.py` fixes both halves at build time,
verify-or-fail like the existing patch; the same control pair now agrees.

### The tool surface, measured instead of estimated

Captured by pointing pi at a stand-in provider that logs the request body:

| component | ~tokens |
| --- | --- |
| tool schemas (13 tools) | 3,157 |
| pi base + append-system-prompt | 890 |
| `<available_skills>` block | 823 |
| user message | 8 |
| **whole first request** | **4,963** |

and the tools, largest first: `mcp` 719, **`prinny_*` 1,470 across six**,
`mcpScript` 309, `edit` 309, `read` 182, `bash` 145, `write` 118,
`stack_status` 99. The six Matrix tools cost more than pi's own bash, read, edit
and write combined, on every turn, in every session — including sessions with no
Matrix credentials, where the sidecar already refuses to start for exactly that
reason. `registerTools()` is now behind the same `isConfigured()` gate.

This corrects an estimate made earlier the same day from reading pi's source
(~2,000 tokens for the built-ins). The built-ins are 754. Counting template
literals in a tool's module counts its rendering code too.

### Verified, not assumed

- Every number above is a measurement: the CDP probe against a real wedged
  Chrome, the 301 s from session timestamps against forge's log, the prefill
  rate from llama's own timing lines, the tool budget from the bytes pi put on
  the wire, and the forge usage fix from the same control pair that found it.
- The browser guard was loaded through **jiti**, pi's own extension transpiler,
  and driven with the exact `tool_result` shape from the failing session. It
  rewrites the transport failure and leaves successes, real tool errors and
  non-browser tools untouched.
- `tests/tool-budget.test.ts` asserts the tool surface against the wire, with a
  control (pi's own `bash` present in both runs) so an empty capture cannot pass
  as a pass. 231 prinny tests, 24 browser_cli checks.
- **Correction to an earlier note in this file:** "pi will not reach a first
  token inside 180 s in this container, and even `pi --help` hangs" was written
  during the same memory storm. `pi --help` returns in under a second once the
  box is not thrashing. It was never a pi defect.

## 2026-08-16 — the MTP draft is p-min-bound, and the engine ships a free drafter we do not use

`versions.lock` recorded decode at **39.6 tok/s** with **86.2%** MTP acceptance
and the note "2 is the 3.6 inherited value and 86.2% acceptance suggests it is
too low for 3.8; sweep in progress". That framing was wrong, and the reason is
visible in the engine source rather than in any benchmark.

Everything below was read from `ggml-org/llama.cpp` at the exact commit this
stack pins — `server-cuda-b10200` = `5f55650a7`, authored **2026-07-30** — not
from documentation, a fork's README, or memory.

### 1. p-min is tested before n-max, so n-max was never the binding knob

`common/speculative.cpp:1520-1670`, the qwen35 branch of the MTP draft loop:

```cpp
while (n_drafting > 0) {
    int ret = llama_decode(ctx_dft, batch);        // a full MTP forward pass
    common_sampler_sample(smpl, ctx_dft, i_last[seq_id], true);
    const auto * cur_p = common_sampler_get_candidates(smpl, true);
    if (cur_p->data[0].p < params.p_min) { drafting = false; continue; }   // first
    result.push_back(id);
    if (params.n_max <= (int) result.size()) { drafting = false; continue; } // second
}
```

With `SPEC_DRAFT_P_MIN=0.75` the second draft token survives only when the MTP
head's top-1 probability clears 0.75, so the draft is frequently cut at length 1
and `n_max` is never consulted. **High acceptance beside a low decode rate is
the signature of that state**: acceptance is bought by refusing to draft, not
earned by drafting well. Sweeping `n_max` under a tight `p_min` measures a knob
that is not binding, which is why the inherited 2/3/4 numbers looked flat.

The diagnostic that separates the two, now computed by `spec-sweep.sh`:

    draft_per_cycle = draft_n / (predicted_n - draft_accepted)

One verify cycle emits one target-sampled token plus its accepted drafts, so the
denominator is the cycle count. Near 1.0 at `n_max=2` means p-min is truncating;
near `n_max` means n-max is binding.

### 2. Per-request speculative tuning does not exist here, so every config costs a reload

`tools/server/server-schema.cpp:196` defines `speculative.n_max`,
`speculative.p_min` and `speculative.type` as request fields — inside `#if 0`:

```cpp
// TODO: to keep things simple, we disable speculative parameter adjustments for now
#if 0
    add((new field_num("speculative.n_max", ...
#endif
```

A restart-free sweep was designed off the grep hit and abandoned on reading the
five lines above it. They are launch flags only, so each config is a container
recreate — the ~27 min cold load in `versions.lock`. `spec-sweep.sh` is
resumable for exactly this reason.

### 3. `ngram-simple` is free, drafts up to 48 tokens, and is not in `SPEC_TYPE`

`--spec-type` is a comma-separated list (`common/arg.cpp:4048`) over 11 types,
five of them n-gram. Priority is hard-coded in `common_speculative_init`
(`common/speculative.cpp:2404-2437`) under the comment *"this list here defines
the priority of the speculators"*: **every n-gram impl is pushed ahead of every
draft-model impl**, `ngram-simple` first of all. Arbitration in
`common_speculative_draft()` is a first-non-empty cascade — `dp.drafting` is
cleared as soon as an impl returns tokens — so an n-gram hit skips the MTP
forward pass entirely.

| | cost per draft | tokens per draft |
| --- | --- | --- |
| `draft-mtp` | one `llama_decode` **per token** | `SPEC_DRAFT_N_MAX` (2) |
| `ngram-simple` | none — a lookup over the live context | `size_m` = **48** |

Defaults are `size_n=12`, `size_m=48`, `min_hits=1` (`common/common.h:358-362`).

The 48 is **not** clipped by `--spec-draft-n-max`. That was checked rather than
assumed, because the cascade does `result.resize(dp.n_max)` and would have gutted
it: `dp.n_max` is `slot.get_n_draft_max()` = `n_ctx - prompt.n_tokens() - 2`
(`tools/server/server-context.cpp:470,3009`), a remaining-context budget with no
relation to the draft-length flag.

For a coding agent this is the largest speedup on the table and it costs no
VRAM. pi regenerates verbatim spans constantly — a file rewritten with one line
changed — and that is precisely what a context-built n-gram table predicts.

### 4. Three hypotheses that did not survive the source

- **"`n_max` is silently clamped to 1 for a single-head model."** The clamp
  `params.n_max = min(n_max, n_mtp_layers)` (`speculative.cpp:1346`) is guarded
  by `if (chain_heads)`, and `chain_heads = n_mtp_layers > 1 && !is_mem_shared`.
  Line 1264 documents `qwen35` as "a single trained MTP head", so `chain_heads`
  is false and no clamp runs. `n_max=2` is honoured.
- **"Upstream feeds stale hidden states to the MTP head."** Claimed by the
  `Indras-Mirror/llama.cpp-turboq-mtp` fork and fixed there in May. Upstream's
  `accept()` (`speculative.cpp:1671`) copies
  `verify_h[min(n_accepted, n_rows-1)]` into `pending_h`, indexing by acceptance
  count correctly. Not present in b10200.
- **"That fork is actively ahead of us."** Its `pushed_at` reads today, but
  `master`'s last commit is **2026-05-16** — the day upstream merged MTP
  (PR #22673) — and its headline "upstream 71.5 vs ours 82-93 tok/s" was
  measured against day-one upstream code, ten weeks before the build we pin.
  The comparison does not transfer. Its `feature/dsv4-tbq4-native` branch
  (2026-08-16) does carry a genuine Qwen3.8 / qwen35 / RTX 4090 result at 262K
  context, but it rides on fused TBQ4 flash-attention CUDA kernels, i.e.
  maintaining a fork whose master is ten weeks behind our pinned image. Not
  taken; revisit only after the free levers are exhausted.

### What was built

- **`scripts/spec-sweep.sh`** — sweeps `SPEC_TYPE` × `SPEC_DRAFT_N_MAX` ×
  `SPEC_DRAFT_P_MIN`, one llama recreate per config, reporting decode,
  acceptance and `draft/cycle`. Backs up `.env` whole and restores it on every
  exit path including Ctrl-C, because a sweep value left behind would silently
  change what the next `up.sh` starts. `--resume` skips configs already on disk.
- **`scripts/bench_repeat.py`** — the workload `bench.py` structurally cannot
  measure. `bench.py` nonce-randomises every prompt to defeat the prefix cache,
  which also defeats `ngram-simple`, whose whole value is repeated spans. A flat
  ngram row there means "this workload had no repetition", not "the drafter is
  useless", and reading it the second way would retire the cheapest speedup we
  have.

### The control, which is the point of the second script

A repetition benchmark that reports only tok/s can be fooled by the model
ignoring the instruction: output is not repetitive, the drafter cannot fire, the
row is flat — and the flatness is caused by the prompt. So every row reports
**echo**, the share of generated 12-token windows (matching `ngram-simple`'s
`size_n`) that also occur in the prompt, computed with the model's own tokenizer
via `/tokenize` and falling back to whitespace only while saying so. Rows below
`--min-echo` are marked `UNREPEATED` and excluded, exactly as `bench.py` excludes
`CACHED` rows — a broken measurement, not a slow one.

The metric was checked against a control before being trusted: **97.4%** for a
faithful rewrite, **0%** for equal-length novel prose, **18.8%** for a
half-and-half mix. Without that, the exclusion rule would be decoration.

### Verified, not assumed

- Every line, file and number cited above was read at `5f55650a7`, the commit
  behind `server-cuda-b10200`, resolved via the git ref API rather than assumed
  from the tag name. The b10200 release tag itself 404s; the ref does not.
- `-ctkd` / `-ctvd` (`--spec-draft-type-k` / `--spec-draft-type-v`) were
  confirmed present in **this** build at `common/arg.cpp:3920,3933`. The MTP
  draft context holds its own KV cache, so the `.env` note that quantised V
  moves prefill off the GPU governs `-ctk`/`-ctv` only and does not apply to it.
- `spec-sweep.sh` was exercised on `--help`, `--dry-run`, `--only` and its
  failure path, `--workload` validation, and `--report` against fixtures for
  both workloads with the arithmetic hand-checked and an `UNREPEATED` row
  confirmed excluded. `env_set` was tested writing the comma-containing value
  `ngram-simple,draft-mtp` against a throwaway `.env`, with the full-file
  restore verified.
- The live `run_config` path is deliberately unexercised: it recreates llama at
  ~27 min per config. **No sweep has been run yet, so no decode number in this
  section supersedes `versions.lock`.**
- One bug found and fixed while testing: `die` inside `select_configs` runs in a
  process substitution, so a bad `--only` printed the error and continued with
  an empty list. The length check now lives in the caller.

## 2026-08-16 (results) — the sweep ran, and the free-drafter recommendation was wrong

The section above predicted, from source, that `ngram-simple` would be the
largest speedup available. Both sweeps then ran on this box against
Qwen3.8-27B-UD-Q4_K_XL at `CTX_SIZE=32768`. The p-min prediction held. The
`ngram-simple` recommendation did not survive its own control.

### Novel text (`--workload synthetic`, nonce-randomised, zero repetition)

| config | spec-type | n-max | p-min | decode | accept | draft/cycle |
| --- | --- | --- | --- | --- | --- | --- |
| baseline | draft-mtp | 2 | 0.75 | 55.1 | 89.8% | 1.30 |
| pmin-050 | draft-mtp | 2 | 0.50 | 59.5 | 74.2% | 1.70 |
| pmin-040 | draft-mtp | 2 | 0.40 | 63.6 | 67.9% | 1.84 |
| pmin-040-n4 | draft-mtp | 4 | 0.40 | **67.9** | 54.5% | 3.48 |
| ngram-baseline | ngram-simple,draft-mtp | 2 | 0.75 | **41.1** | 76.3% | 1.45 |

### Repetitive text (`--workload repeat`, echo 98.8% on every row)

| config | spec-type | n-max | p-min | decode | accept | draft/cycle |
| --- | --- | --- | --- | --- | --- | --- |
| baseline | draft-mtp | 2 | 0.75 | 74.7 | 98.7% | 1.95 |
| pmin-050 | draft-mtp | 2 | 0.50 | 73.4 | 97.9% | 1.99 |
| pmin-040 | draft-mtp | 2 | 0.40 | 85.1 | 98.0% | 2.00 |
| pmin-040-n4 | draft-mtp | 4 | 0.40 | 118.1 | 95.0% | 3.98 |
| ngram-baseline | ngram-simple,draft-mtp | 2 | 0.75 | 152.5 | 64.5% | 20.60 |
| ngram-pmin-040-n4 | ngram-simple,draft-mtp | 4 | 0.40 | **164.4** | 63.7% | 28.38 |

### What held

**p-min was binding, n-max was not.** At the inherited `p-min=0.75` the draft
was cut to a single token on ~70% of cycles (draft/cycle 1.30 against a ceiling
of 2), so the earlier "2 fastest, 3 no better, 4 collapses" finding was
measuring a knob held shut by a different one. Loosening p-min to 0.40 lifts
draft/cycle to 1.84 and decode +15%; only then does raising n-max pay, and it
pays twice as much again. draft/cycle pins against the ceiling at every n-max
tried, including 4, so **6 and 8 are untested and probably still on the table**.

### What did not

**`ngram-simple` costs 25% on novel text: 55.1 → 41.1 tok/s.** The priority
cascade documented above as the reason it works is also why it hurts. It runs
ahead of `draft-mtp` and arbitration is first-non-empty, so any span the n-gram
table produces preempts the MTP draft — including a bad guess. The counters show
exactly that: draft/cycle rises 1.30 → 1.45 (it fires) while acceptance falls
89.8% → 76.3% (the drafts are wrong). Cheap bad drafts displacing good expensive
ones is a net loss.

So the honest summary is **2.04× on repetitive traffic, 0.75× on novel**, and
real agent traffic is a mix. `SPEC_TYPE` is therefore left at `draft-mtp`.

The untried lever is `--spec-ngram-simple-min-hits`, which defaults to **1**
(`common/common.h:361`) — a span is drafted after being seen once. Raising it to
2-3 should suppress the garbage on novel text while keeping the rewrite win. The
flag is not plumbed through `docker-compose.yml`.

### What the control was worth

`bench_repeat.py`'s echo metric held at **98.8% on all six repeat rows**, which
is what makes those decode differences attributable to the config rather than to
a workload that drifted. And the synthetic grid is the only reason the
`ngram-simple` regression was found at all: measured on the repeat workload
alone, the recommendation would have shipped as a 2× win and quietly cost 25% on
every non-repetitive generation.

### Environment, not configuration

One config (`synthetic/ngram-pmin-040-n4`) failed and is missing from the first
table. Cause was not the sweep:

    E llama_model_load: error loading model: read error: Cannot allocate memory
    E srv  llama_server: exiting due to model loading error

The box was at **1.1 GiB free** with 7.8 GiB in page cache; with mmap off and
`MODELS_DIR` on the 9p mount the load must pull 17.9 GB through host RAM.
Dropping the Docker VM page cache took free memory to 6.3 GiB and the next load
succeeded. The sweep handled it correctly — warned, dumped llama's tail, skipped
the config, kept `.env` clean — but `--wait-timeout 3000` meant it sat waiting on
an already-exited container instead of failing fast. Worth fixing.

Also worth recording: the ~27 min cold load in `versions.lock` is genuinely
cold. Once the GGUF is in page cache a recreate is **5-8 minutes**, which makes
further sweeping far cheaper than the first one priced it.

### Not adopted

`.env` still reads `SPEC_TYPE=draft-mtp`, `SPEC_DRAFT_N_MAX=2`,
`SPEC_DRAFT_P_MIN=0.75`. A benchmark should not silently rewrite the config it
measured; the numbers are recorded here and in `context/bench/spec-sweep/` so
the change can be made deliberately.

## 2026-08-17 — the ngram regression was an n-max artifact, not a property

The entry above reported `ngram-simple` as 2.04x on repetitive text and **0.75x
on novel**, and concluded it could not be enabled unconditionally. One config
was missing from that grid — `synthetic/ngram-pmin-040-n4`, lost to the ENOMEM
described above. It has now run, and it overturns the conclusion.

| config | spec-type | n-max | p-min | novel | repetitive |
| --- | --- | --- | --- | --- | --- |
| current | draft-mtp | 2 | 0.75 | 55.1 | 74.7 |
| tuned MTP | draft-mtp | 4 | 0.40 | 67.9 | 118.1 |
| ngram, untuned | ngram-simple,draft-mtp | 2 | 0.75 | **41.1** | 152.5 |
| **ngram, tuned** | ngram-simple,draft-mtp | 4 | 0.40 | **67.8** | **164.4** |

**The 25% novel-text loss exists only at n-max 2.** At n-max 4 it is gone:
67.8 against 67.9 for MTP alone, identical within noise, while repetitive text
keeps the full 164.4.

The mechanism follows from the cascade. `ngram-simple` preempts the MTP draft
whenever it produces anything, so it substitutes its guess for MTP's. At n-max 2
the displaced MTP draft is short and cheap, and a bad n-gram guess is pure loss.
At n-max 4 the draft budget is wide enough that the spans which land pay for the
ones that do not — draft/cycle rises 3.48 → 3.79 while acceptance falls 54.5% →
51.8%: more drafted, proportionally fewer kept, net wash on novel text and a
large win on repetitive.

So `ngram-simple,draft-mtp` at **n-max 4 / p-min 0.40** is a strict improvement
over the current config on both workloads — **1.23x novel, 2.20x repetitive** —
where at n-max 2 it was a real trade-off. **Enabling ngram-simple without also
raising n-max is the trap**, and the previous entry's flat "do not enable blind"
advice was drawn from exactly that incomplete grid.

This is also the second time in this investigation that a conclusion drawn from
a partial grid was wrong in the confident direction: first `n-max` looked
settled while `p-min` was the binding knob, then `ngram-simple` looked harmful
while the harm was an `n-max` interaction. Both were caught only by filling in
the cell nobody had measured.

`--spec-ngram-simple-min-hits` remains untested. It was proposed as the fix for
a regression that turns out to be an n-max artifact, so it is no longer urgent,
but it may add headroom. It is now plumbed as `SPEC_NGRAM_MIN_HITS` (with
`SPEC_NGRAM_SIZE_N` / `_SIZE_M`) in `docker-compose.yml`, default empty so
llama.cpp's own defaults apply and the flags are omitted entirely when unset.

### Still not adopted

`.env` remains `draft-mtp` / n-max 2 / p-min 0.75. The numbers now argue clearly
for `ngram-simple,draft-mtp` / n-max 4 / p-min 0.40, but that is a config change
for a human to make deliberately, not something a benchmark should do to itself.

## 2026-08-17 — adopted: `ngram-simple,draft-mtp` at n-max 4 / p-min 0.40

`.env` now carries the measured optimum instead of the inherited 3.6 values.
Verified on the live stack after the change, not inferred from the sweep:

| check | result |
| --- | --- |
| smoke test | **11/11**, including a real tool call through forge (`get_weather({'city':'Paris'})`, args parsed as JSON) |
| live argv | `--spec-type ngram-simple,draft-mtp --spec-draft-n-max 4 --spec-draft-p-min 0.40` |
| repetition bench | **191.0 tok/s**, echo 99%, draft/cycle 26.8, acceptance 63.6% |
| synthetic bench | 53.5 tok/s, prefill 1375, acceptance 48.1% |
| VRAM | **21998 / 24564 MiB** |

**Output is unchanged.** Speculative decoding verifies every draft against the
target model, so this buys decode speed and alters nothing the model says. That
is why it was adopted on benchmark evidence alone; a sampler change would not
have been.

### Two costs that are not in the headline

**VRAM is up 529 MiB** (21469 → 21998). `n_outputs_per_seq` is
`1 + common_speculative_n_max()` (`tools/server/server-context.cpp:50`) and
`common_speculative_n_max` returns `size_m` = **48** for ngram-simple
(`common/speculative.cpp:2251`), so the server sizes output buffers for 49 rather
than 3. ~2.5 GiB of headroom remains at `CTX_SIZE=32768`; a future context bump
will hit the ceiling sooner than it used to.

**The synthetic number regressed against the sweep** — 53.5 tok/s now versus
67.8 for the same config during the sweep. This is contention, not the config:
13 other claude sessions were live, and one of the three runs saw prefill
collapse to 124.6 tok/s against a 1375 best. The repetition bench went the other
way (191.0 now versus 164.4 in the sweep). **Single decode numbers on this box
are contention-sensitive; only compare configs measured within one sweep run.**
That is recorded in `versions.lock` as `spec_variance_note` so the next person
does not read the 53.5 as a regression caused by the change.

### What is still open

- **n-max 6/8 untested.** draft/cycle pins against the ceiling at every n-max
  tried, 3.79 at n-max 4, so the constraint has not been reached.
- **`--spec-ngram-simple-min-hits` untested.** Plumbed as `SPEC_NGRAM_MIN_HITS`
  (default empty). Proposed as a fix for a regression that turned out to be an
  n-max artifact, so no longer urgent, but it may add headroom.
- **Memory, not configuration, is the limiting factor on further sweeping.** Two
  configs died with `read error: Cannot allocate memory` because the load pulls
  17.9 GB through host RAM with mmap off. It needs ~10 GiB free; a page-cache
  drop plus quiet sessions gets there.

## 2026-08-17 — HN "Qwen 3.8 27B overthinks" thread + Simon Willison's post, checked against this stack

Source: <https://simonwillison.net/2026/Aug/16/qwen-38-27b/> and its HN thread.
Everything below was re-measured here rather than adopted on the thread's word;
two of the thread's headline claims do not survive that.

### Already fixed here before the thread ran

`xlayn` and `Gracana` describe the template keeping `<think>` only for the last
message, so a harness that replays reasoning every turn desynchronises from
llama.cpp's cache and re-prefills the whole conversation. That is
`FORGE_REASONING_REPLAY=full` plus `--chat-template-kwargs
'{"preserve_thinking": true}'`, adopted here from an earlier HN thread and
already recorded above. `bitexploder`'s 2K-thinking-token cutoff proxy is
`REASONING_BUDGET` + `REASONING_BUDGET_MESSAGE`. Simon's MTP recipe
(`--spec-type draft-mtp`, "~72% improvement") is the thing this repo spent the
last two days going well past.

### New capability: reasoning effort is per-REQUEST, and forge forwards it

`tools/server/server-common.cpp:1073-1077` merges a request's
`chat_template_kwargs` **over** the server's `--chat-template-kwargs`, so a
caller sets its own effort per turn with no restart:

    {"chat_template_kwargs": {"reasoning_effort": "low"}}

Verified end to end: content length through forge tracked llama within 1% on
identical prompts (5464 vs 5530, 8189 vs 8150 chars), and wall times matched.
**forge passes both fields through untouched.** This makes the long-standing
`.env` wish — "drop to low for tool-loop turns where the thinking is pure
overhead" — a client-side change rather than a server setting.

### Correction: `reasoning_effort: "none"` works via the API

`.env` said `none` "hits raise_exception() and the request fails". True for
`--chat-template-kwargs`, which hands the value to the template. False for the
OpenAI-style top-level field, which llama.cpp intercepts first
(`server-common.cpp:1089-1094`):

    if (reasoning_effort == "none") { inputs.enable_thinking = false; }
    // other reasoning_effort values are model-specific and not yet handled

Measured: 0 reasoning chars against 97 on the same prompt. This settles the
disagreement in the thread — `xscott` (it works) is right about the API field,
`xlayn` (no effect, only three values) is right about the kwargs path. Only
`none` is special-cased; `low`/`medium`/`xhigh` must go through
`chat_template_kwargs`.

### Measured: xhigh does not merely run slow, it can return NOTHING

One HTML-tool prompt, same token cap, this box:

| effort | reasoning chars | content chars | wall |
| --- | --- | --- | --- |
| xhigh | 12,582 | **0** | 75.0s |
| low | 4,459 | 5,530 | 38.4s |
| none | 0 | 8,150 | 41.1s |

At xhigh the entire budget went to thinking and the content field came back
empty — a failed turn, not a slow one. That is the sharp form of what Simon
reports as 22,276 reasoning tokens over 21 minutes, and it is why
`REASONING_BUDGET` exists here.

### The thread's main advice is backwards on this stack

Simon: "Run Qwen 3.8 27B on low or even no reasoning levels at first." `dofm`:
medium loops, low does not. Measured here at a 6000-token cap, two runs each:

| effort | reasoning chars | content chars |
| --- | --- | --- |
| medium | 3,404 / 1,476 | **16,353 / 17,912** |
| low | 6,409 / 5,573 | 13,662 / 13,933 |

**`low` reasons more than twice as much as `medium` and delivers less answer.**
The mechanism is already documented in `.env`: `medium` is the only level that
injects nothing into the system prompt, while `low` prepends a steering
sentence — and the model reasons about the steering. `REASONING_EFFORT=medium`
therefore stays, now on measurement rather than inheritance.

Caveat: one prompt, two runs per level, both hitting the cap. Directionally
clear, not a precise figure.

### Worth evaluating, not yet done

`hedgehog` recommends **`froggeric/Qwen-Fixed-Chat-Templates`** on HF (covers
3.5/3.6/3.8 in one drop-in file). Its claims that matter here, none verified:

- flattens the template AST to remove an "80% inference throughput drop" on C++
  engines, and strips Python-only Jinja that `minijinja` — which is what
  llama.cpp uses — cannot run;
- handles tool-call args arriving as either Python dicts or JSON strings,
  "fixing crashes from standard OpenAI proxies", which is exactly what forge is;
- fixes "empty think poisoning", blank `<think></think>` aborting a turn early;
- adds `none`/`minimal`/`max` aliases and inline `<|think_low|>` tags.

The throughput claim is the one to test first and the easiest to fool oneself
about: measure with `./scripts/spec-sweep.sh --report` on both templates, same
config, rather than trusting a model card. Swapping the embedded chat template
is a real change with real blast radius — tool calling is downstream of it —
so it wants the smoke test plus both bench workloads before adoption.

## 2026-08-17 (correction) — "which effort?" was measured with the wrong metric

The entry above compared reasoning tokens against **content length** and
concluded `medium` gave the "best answer per token", treating `low`'s shorter
output as worse. That is the wrong metric, and it was pointed out rather than
caught here.

The complaint about Qwen 3.8 at xhigh is not that answers are short. It is that
they are **over-engineered**. Under that framing more content can mean *worse*,
so a length comparison cannot see the thing in dispute — and the conclusion drawn
from it was unsupported even though the token counts behind it were real.

Re-measured with `scripts/bench_quality.py`: 5 coding tasks, 5 hidden edge-case
assertions each, the model's code extracted and **executed**. LOC of the accepted
solution stands in for over-engineering.

| effort | pass% | LOC | reason chars | wall |
| --- | --- | --- | --- | --- |
| none | 84.0 | **164** | 0 | 23.3s |
| low | 96.0 | **63** | 9,007 | 48.3s |
| medium | **100.0** | 71 | 13,876 | 59.9s |
| xhigh | **100.0** | 99 | 41,489 | 244.4s |

**The advice to run on low is right on its own terms.** `low` writes the leanest
correct code of any level. `xhigh` ties `medium` on correctness while writing 40%
more code — 39 lines for `roman_to_int` where `low` used 13 — and costs 4x the
wall clock. It buys nothing here, which is the strongest case yet for ignoring
the shipped default.

`none` is worst on both axes simultaneously: fewest passes *and* the most
sprawling code (164 LOC). Without a planning phase it rambles, which is the
opposite of the intuition that less thinking yields tighter output.

**`medium` still stands as this stack's default**, now for a defensible reason:
it is the only level at 100%, and a coding agent's failure mode is a wrong
function rather than a verbose one. `low` is a legitimate alternative if
terseness is worth 4 points of pass rate.

### A second thing the correction exposed

The earlier claim that "`low` reasons twice as much as `medium`" **does not
generalise**. On the one HTML/UI prompt it did (6,409 vs 3,404 chars); across
these five coding tasks it reasons *less* (9,007 vs 13,876). Effort level is not
a monotonic dial on thinking volume — it interacts with the prompt. That was
stated far too broadly on the strength of a single prompt, in a section that had
already flagged "one prompt, two runs" as a caveat and then reasoned as though it
had not.

### Method note

`bench_quality.py` executes model-written code, so it runs only in the throwaway
bench container. Its pass rates are meaningless without the control: reference
implementations for all five tasks were verified at **5/5** before any model
output was scored, because a buggy assertion is otherwise indistinguishable from
a model failure — in the direction that flatters the harness. Adding a task means
adding its reference implementation and re-running that check first.
